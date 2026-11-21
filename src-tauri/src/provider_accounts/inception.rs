//! Monitoring only: model discovery validates a key, never identity, quota or inference.
use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use sha2::{Digest, Sha256};
use tauri::AppHandle;

use super::model::{AccountStatus, ProviderAccount};
use super::{now, provider_root, storage};

type Result<T> = std::result::Result<T, String>;
pub(super) const ACCOUNT_ID: &str = "inception-1";
const MODELS_URL: &str = "https://api.inceptionlabs.ai/v1/models";
const BILLING_URL: &str = "https://platform.inceptionlabs.ai/dashboard/billing";
const MAX_BODY: usize = 256 * 1024;
// Below Windows Credential Manager's 2560-byte UTF-16 password limit.
const MAX_KEY: usize = 1024;
const STORAGE: &str = "inceptionStorageUnavailable";
const CREDENTIALS: &str = "inceptionCredentialUnavailable";
const AUTH: &str = "inceptionAuthRequired";
const INVALID: &str = "inceptionInvalidKey";
const PROTOCOL: &str = "inceptionInvalidModels";
const NETWORK: &str = "inceptionNetworkUnavailable";
const RATE: &str = "inceptionRateLimited";
const HTTP: &str = "inceptionHttpFailure";

pub(super) fn is_account(id: &str) -> bool {
    id == ACCOUNT_ID
}

pub(super) fn usage_url(id: &str) -> Result<&'static str> {
    if !is_account(id) {
        return Err("inceptionUnknownAccount".into());
    }
    Ok(BILLING_URL)
}

fn initial() -> ProviderAccount {
    ProviderAccount {
        id: ACCOUNT_ID.into(),
        provider_id: "inception".into(),
        label: "Inception Labs 1".into(),
        identity: None,
        usage: None,
        status: AccountStatus::Disconnected,
        duplicate_of: None,
        last_attempt_at: None,
        last_success_at: None,
        error: None,
    }
}

fn validate_key(key: &str) -> Result<()> {
    if key.is_empty() || key.len() > MAX_KEY || !key.bytes().all(|b| b.is_ascii_graphic()) {
        return Err(INVALID.into());
    }
    Ok(())
}

fn safe_error(error: &str) -> &'static str {
    match error {
        STORAGE => STORAGE,
        CREDENTIALS => CREDENTIALS,
        AUTH => AUTH,
        INVALID => INVALID,
        PROTOCOL => PROTOCOL,
        NETWORK => NETWORK,
        RATE => RATE,
        HTTP => HTTP,
        _ => "inceptionCheckFailed",
    }
}

// The backend is injected in tests; no test constructs or reads an owner keyring entry.
trait Credentials: Send + Sync {
    fn read(&self) -> Result<Option<String>>;
    fn write(&self, key: &str) -> Result<()>;
    fn remove(&self) -> Result<()>;
}

struct NativeCredentials {
    entry: keyring::Entry,
}

fn credential_scope(root: &Path) -> Result<String> {
    storage::reject_link(root).map_err(|_| STORAGE)?;
    let canonical = root.canonicalize().map_err(|_| STORAGE)?;
    let path = canonical.to_str().ok_or(STORAGE)?;
    // Hash only the canonical app-data path, NEVER the credential or an identity.
    Ok(format!("{:x}", Sha256::digest(path.as_bytes())))
}

impl NativeCredentials {
    fn new(root: &Path) -> Result<Self> {
        #[cfg(not(windows))]
        return Err(CREDENTIALS.into());
        #[cfg(windows)]
        {
            let scope = credential_scope(root)?;
            let entry = keyring::Entry::new(
                "TABS.ProviderAccounts.Inception.v1",
                &format!("{scope}:{ACCOUNT_ID}"),
            )
            .map_err(|_| CREDENTIALS)?;
            Ok(Self { entry })
        }
    }
}

impl Credentials for NativeCredentials {
    fn read(&self) -> Result<Option<String>> {
        match self.entry.get_password() {
            Ok(key) => Ok(Some(key)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err(CREDENTIALS.into()),
        }
    }
    fn write(&self, key: &str) -> Result<()> {
        self.entry.set_password(key).map_err(|_| CREDENTIALS.into())
    }
    fn remove(&self) -> Result<()> {
        match self.entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err(CREDENTIALS.into()),
        }
    }
}

struct ModelsClient {
    client: reqwest::blocking::Client,
    url: String,
}

impl ModelsClient {
    fn build(url: &str, timeout: Duration) -> Result<Self> {
        let client = reqwest::blocking::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .no_proxy()
            .connect_timeout(Duration::from_secs(5).min(timeout))
            .timeout(timeout)
            .build()
            .map_err(|_| NETWORK)?;
        Ok(Self {
            client,
            url: url.into(),
        })
    }
    fn production() -> Result<Self> {
        Self::build(MODELS_URL, Duration::from_secs(15))
    }
    fn check(&self, key: &str) -> Result<()> {
        validate_key(key)?;
        let mut response = self
            .client
            .get(&self.url)
            .bearer_auth(key)
            .header(reqwest::header::ACCEPT, "application/json")
            .send()
            .map_err(|_| NETWORK)?;
        match response.status().as_u16() {
            200 => {}
            401 | 403 => return Err(AUTH.into()),
            429 => return Err(RATE.into()),
            _ => return Err(HTTP.into()),
        }
        if response
            .content_length()
            .is_some_and(|n| n > MAX_BODY as u64)
        {
            return Err(PROTOCOL.into());
        }
        let mut bytes = Vec::new();
        (&mut response)
            .take(MAX_BODY as u64 + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| NETWORK)?;
        parse_models(&bytes)
    }
}

fn parse_models(bytes: &[u8]) -> Result<()> {
    if bytes.len() > MAX_BODY {
        return Err(PROTOCOL.into());
    }
    let value: serde_json::Value = serde_json::from_slice(bytes).map_err(|_| PROTOCOL)?;
    let object = value.as_object().ok_or(PROTOCOL)?;
    if object.get("object").and_then(serde_json::Value::as_str) != Some("list") {
        return Err(PROTOCOL.into());
    }
    let models = object
        .get("data")
        .and_then(serde_json::Value::as_array)
        .ok_or(PROTOCOL)?;
    if models.len() > 2048 {
        return Err(PROTOCOL.into());
    }
    for model in models {
        let id = model
            .as_object()
            .and_then(|m| m.get("id"))
            .and_then(serde_json::Value::as_str)
            .ok_or(PROTOCOL)?;
        if id.is_empty() || id.len() > 256 || id.chars().any(char::is_control) {
            return Err(PROTOCOL.into());
        }
    }
    // Do not return model IDs: they are not an account principal or usage evidence.
    Ok(())
}

struct State {
    account: ProviderAccount,
    // If credential rollback itself fails, block all further use in this process.
    blocked: bool,
}
struct Store {
    root: PathBuf,
    credentials: Box<dyn Credentials>,
    http: ModelsClient,
    // Held across credential reads, HTTP and publication; late checks cannot race replacements.
    state: Mutex<State>,
}

impl Store {
    fn new(root: PathBuf, credentials: Box<dyn Credentials>, http: ModelsClient) -> Result<Self> {
        let mut account = storage::load_for(&root, &[initial()])
            .map_err(|_| STORAGE)?
            .remove(0);
        account.identity = None;
        account.usage = None;
        account.duplicate_of = None;
        account.label = initial().label;
        account.error = account.error.as_deref().map(safe_error).map(str::to_owned);
        // A persisted successful read is history, not proof this process validated its key.
        if matches!(
            account.status,
            AccountStatus::Connected | AccountStatus::Duplicate
        ) {
            account.status = AccountStatus::Configured;
        }
        Ok(Self {
            root,
            credentials,
            http,
            state: Mutex::new(State {
                account,
                blocked: false,
            }),
        })
    }
    fn preflight(&self, state: &State) -> Result<()> {
        if state.blocked {
            return Err(CREDENTIALS.into());
        }
        storage::load_for(&self.root, &[initial()]).map_err(|_| STORAGE)?;
        Ok(())
    }
    fn read_key(&self) -> Result<Option<String>> {
        self.credentials.read().map_err(|_| CREDENTIALS.into())
    }
    fn save(&self, state: &mut State, account: ProviderAccount) -> Result<ProviderAccount> {
        storage::save_for(&self.root, std::slice::from_ref(&account), &[initial()])
            .map_err(|_| STORAGE)?;
        state.account = account;
        Ok(state.account.clone())
    }
    fn list(&self) -> Result<ProviderAccount> {
        let state = self.state.lock().map_err(|_| STORAGE)?;
        self.preflight(&state)?;
        let mut account = state.account.clone();
        match self.read_key()? {
            None => {
                account.status = AccountStatus::Disconnected;
                account.error = None;
            }
            Some(key) => {
                validate_key(&key).map_err(|_| CREDENTIALS)?;
                if account.status == AccountStatus::Disconnected {
                    account.status = AccountStatus::Configured;
                }
            }
        }
        Ok(account)
    }
    fn refresh(&self) -> Result<ProviderAccount> {
        let mut state = self.state.lock().map_err(|_| STORAGE)?;
        self.preflight(&state)?;
        let mut account = state.account.clone();
        account.last_attempt_at = Some(now());
        let result = match self.read_key() {
            Ok(Some(key)) => self.http.check(&key),
            Ok(None) => Err(AUTH.into()),
            Err(error) => Err(error),
        };
        match result {
            Ok(()) => {
                account.status = AccountStatus::Connected;
                account.last_success_at = Some(now());
                account.error = None;
            }
            Err(error) => {
                account.status = if error == AUTH {
                    AccountStatus::AuthRequired
                } else {
                    AccountStatus::Error
                };
                account.error = Some(safe_error(&error).into());
            }
        }
        self.save(&mut state, account)
    }
    fn restore(&self, state: &mut State, old: Option<&str>) -> Result<()> {
        let result = match old {
            Some(key) => self.credentials.write(key),
            None => self.credentials.remove(),
        };
        if result.is_err() || self.read_key().ok().as_ref() != Some(&old.map(str::to_owned)) {
            state.blocked = true;
            return Err(CREDENTIALS.into());
        }
        Ok(())
    }
    fn connect(&self, id: &str, key: String) -> Result<ProviderAccount> {
        if !is_account(id) {
            return Err("inceptionUnknownAccount".into());
        }
        validate_key(&key)?;
        let mut state = self.state.lock().map_err(|_| STORAGE)?;
        self.preflight(&state)?;
        // Candidate failures never mutate an existing working key or its snapshot.
        self.http.check(&key)?;
        // Detect corruption introduced while the request was in flight before touching credentials.
        self.preflight(&state)?;
        let old = self.read_key()?;
        if self.credentials.write(&key).is_err()
            || !matches!(self.read_key(), Ok(Some(ref stored)) if stored == &key)
        {
            self.restore(&mut state, old.as_deref())?;
            return Err(CREDENTIALS.into());
        }
        let mut account = initial();
        account.last_attempt_at = Some(now());
        account.last_success_at = account.last_attempt_at;
        account.status = AccountStatus::Connected;
        match self.save(&mut state, account) {
            Ok(account) => Ok(account),
            Err(_) => {
                self.restore(&mut state, old.as_deref())?;
                Err(STORAGE.into())
            }
        }
    }
}

static STORES: OnceLock<Mutex<HashMap<PathBuf, Arc<Store>>>> = OnceLock::new();
fn store_for(app: &AppHandle) -> Result<Arc<Store>> {
    let root = provider_root(app, "inception").map_err(|_| STORAGE)?;
    let mut stores = STORES
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .map_err(|_| STORAGE)?;
    if let Some(store) = stores.get(&root) {
        return Ok(store.clone());
    }
    let credentials = Box::new(NativeCredentials::new(&root)?);
    let store = Arc::new(Store::new(
        root.clone(),
        credentials,
        ModelsClient::production()?,
    )?);
    stores.insert(root, store.clone());
    Ok(store)
}

pub(super) fn list(app: &AppHandle) -> ProviderAccount {
    match store_for(app).and_then(|s| s.list()) {
        Ok(account) => account,
        Err(error) => {
            let mut account = initial();
            account.status = AccountStatus::Error;
            account.error = Some(safe_error(&error).into());
            account
        }
    }
}
pub(super) fn refresh(app: &AppHandle) -> Result<Vec<ProviderAccount>> {
    Ok(vec![store_for(app)?.refresh()?])
}
pub(super) fn connect(
    app: &AppHandle,
    account_id: &str,
    api_key: String,
) -> Result<ProviderAccount> {
    if !is_account(account_id) {
        return Err("inceptionUnknownAccount".into());
    }
    store_for(app)?.connect(account_id, api_key)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};
    const KEY: &str = "synthetic-unusable-test-value";
    const MODELS: &str = r#"{"object":"list","data":[{"id":"fixture-model"}]}"#;

    #[derive(Default)]
    struct FakeCredentials {
        key: Mutex<Option<String>>,
        fail_write: AtomicBool,
        fail_read: AtomicBool,
        fail_read_after_write: AtomicBool,
        fail_restore: AtomicBool,
        corrupt_after_write: Mutex<Option<PathBuf>>,
    }
    impl Credentials for Arc<FakeCredentials> {
        fn read(&self) -> Result<Option<String>> {
            if self.fail_read.swap(false, Ordering::SeqCst) {
                return Err("sensitive backend read failure".into());
            }
            Ok(self.key.lock().unwrap().clone())
        }
        fn write(&self, key: &str) -> Result<()> {
            if self.fail_write.swap(false, Ordering::SeqCst)
                || (key == "synthetic-old" && self.fail_restore.load(Ordering::SeqCst))
            {
                return Err("secret-bearing backend failure".into());
            }
            *self.key.lock().unwrap() = Some(key.into());
            if self.fail_read_after_write.swap(false, Ordering::SeqCst) {
                self.fail_read.store(true, Ordering::SeqCst);
            }
            if let Some(path) = self.corrupt_after_write.lock().unwrap().take() {
                std::fs::write(path, b"preserve-corrupt-data").unwrap();
            }
            Ok(())
        }
        fn remove(&self) -> Result<()> {
            *self.key.lock().unwrap() = None;
            Ok(())
        }
    }
    fn temp() -> tempfile::TempDir {
        tempfile::Builder::new()
            .prefix("tabs-inception-test-")
            .tempdir_in(storage::test_temp_root())
            .unwrap()
    }
    fn server(status: u16, body: String) -> (ModelsClient, std::thread::JoinHandle<()>) {
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let url = format!("http://{}/v1/models", server.server_addr());
        let handle = std::thread::spawn(move || {
            let request = server
                .recv_timeout(Duration::from_secs(5))
                .unwrap()
                .unwrap();
            assert_eq!(request.method(), &tiny_http::Method::Get);
            assert_eq!(request.url(), "/v1/models");
            assert!(request
                .headers()
                .iter()
                .any(|h| h.field.equiv("Authorization")
                    && h.value.as_str().starts_with("Bearer synthetic-")));
            let _ =
                request.respond(tiny_http::Response::from_string(body).with_status_code(status));
        });
        (
            ModelsClient::build(&url, Duration::from_secs(2)).unwrap(),
            handle,
        )
    }
    fn fixture(
        status: u16,
        body: &str,
    ) -> (
        tempfile::TempDir,
        Arc<FakeCredentials>,
        Store,
        std::thread::JoinHandle<()>,
    ) {
        let root = temp();
        let credentials = Arc::new(FakeCredentials::default());
        let (http, handle) = server(status, body.into());
        let store = Store::new(root.path().into(), Box::new(credentials.clone()), http).unwrap();
        (root, credentials, store, handle)
    }
    #[test]
    fn exact_slot_and_unknown_fields_never_become_identity_or_usage() {
        assert_eq!(initial().label, "Inception Labs 1");
        for id in [
            "inception",
            "inception-01",
            "Inception-1",
            "../inception-1",
            "inception-1 ",
            "codex-1",
        ] {
            assert!(!is_account(id));
            assert!(usage_url(id).is_err());
        }
        assert_eq!(usage_url(ACCOUNT_ID).unwrap(), BILLING_URL);
        let (_dir, credentials, store, handle) = fixture(
            200,
            r#"{"object":"list","data":[{"id":"fixture","email":"not-account"}],"balance":100}"#,
        );
        let account = store.connect(ACCOUNT_ID, KEY.into()).unwrap();
        handle.join().unwrap();
        assert_eq!(account.status, AccountStatus::Connected);
        assert!(account.identity.is_none() && account.usage.is_none());
        assert!(account.last_success_at.is_some());
        let bytes = std::fs::read(store.root.join("accounts.json")).unwrap();
        assert!(!String::from_utf8(bytes).unwrap().contains(KEY));
        let reloaded = Store::new(
            store.root.clone(),
            Box::new(credentials),
            ModelsClient::production().unwrap(),
        )
        .unwrap();
        assert_eq!(reloaded.list().unwrap().status, AccountStatus::Configured);
    }
    #[test]
    fn parser_rejects_missing_or_wrong_schema_and_oversized_bodies() {
        for body in [
            "{}",
            "[]",
            r#"{"data":[]}"#,
            r#"{"object":"list"}"#,
            r#"{"object":"other","data":[]}"#,
            r#"{"object":"list","data":[{}]}"#,
            r#"{"object":"list","data":[{"id":1}]}"#,
            r#"{"object":"list","data":[{"id":""}]}"#,
            "not json",
        ] {
            assert_eq!(parse_models(body.as_bytes()).unwrap_err(), PROTOCOL);
        }
        assert!(parse_models(br#"{"object":"list","data":[]}"#).is_ok());
        assert_eq!(
            parse_models(&vec![b' '; MAX_BODY + 1]).unwrap_err(),
            PROTOCOL
        );
        let (http, handle) = server(200, " ".repeat(MAX_BODY + 1));
        assert_eq!(http.check(KEY).unwrap_err(), PROTOCOL);
        handle.join().unwrap();
    }
    #[test]
    fn bounded_ascii_keys_without_vendor_format_assumptions() {
        for key in ["", "a b", "a\nb", "a\tb", "é", "\0", "\u{7f}"] {
            assert!(validate_key(key).is_err());
        }
        assert!(validate_key("arbitrary-printable!~").is_ok());
        assert!(validate_key(&"x".repeat(MAX_KEY)).is_ok());
        assert!(validate_key(&"x".repeat(MAX_KEY + 1)).is_err());
    }
    #[test]
    fn invalid_replacements_preserve_working_state_and_credential() {
        for (status, expected) in [
            (401, AUTH),
            (403, AUTH),
            (429, RATE),
            (500, HTTP),
            (302, HTTP),
            (200, PROTOCOL),
        ] {
            let (_root, credentials, store, handle) = fixture(status, "sensitive-response-body");
            *credentials.key.lock().unwrap() = Some("synthetic-old".into());
            let mut prior = initial();
            prior.status = AccountStatus::Connected;
            prior.last_success_at = Some(123);
            store
                .save(&mut store.state.lock().unwrap(), prior.clone())
                .unwrap();
            assert_eq!(store.connect(ACCOUNT_ID, KEY.into()).unwrap_err(), expected);
            handle.join().unwrap();
            assert_eq!(
                credentials.read().unwrap().as_deref(),
                Some("synthetic-old")
            );
            assert_eq!(store.state.lock().unwrap().account, prior);
            assert_eq!(
                storage::load_for(&store.root, &[initial()]).unwrap(),
                vec![prior]
            );
        }
    }
    #[test]
    fn refresh_failure_is_stale_and_errors_are_fixed_codes() {
        for (status, expected, auth) in [
            (401, AUTH, true),
            (429, RATE, false),
            (503, HTTP, false),
            (200, PROTOCOL, false),
        ] {
            let (_dir, credentials, store, handle) = fixture(status, "sensitive-response-body");
            *credentials.key.lock().unwrap() = Some(KEY.into());
            store.state.lock().unwrap().account.last_success_at = Some(123);
            let account = store.refresh().unwrap();
            handle.join().unwrap();
            assert_eq!(account.last_success_at, Some(123));
            assert_eq!(account.error.as_deref(), Some(expected));
            assert_eq!(
                account.status,
                if auth {
                    AccountStatus::AuthRequired
                } else {
                    AccountStatus::Error
                }
            );
        }
        assert_eq!(
            safe_error("arbitrary secret/raw URL/backend exception"),
            "inceptionCheckFailed"
        );
    }
    #[test]
    fn missing_key_never_requests_http_and_refresh_requires_auth() {
        let root = temp();
        let store = Store::new(
            root.path().into(),
            Box::new(Arc::new(FakeCredentials::default())),
            ModelsClient::production().unwrap(),
        )
        .unwrap();
        assert_eq!(store.list().unwrap().status, AccountStatus::Disconnected);
        let account = store.refresh().unwrap();
        assert_eq!(account.status, AccountStatus::AuthRequired);
        assert_eq!(account.last_success_at, None);
        assert_eq!(
            store.connect("inception-01", KEY.into()).unwrap_err(),
            "inceptionUnknownAccount"
        );
        assert_eq!(
            store.connect(ACCOUNT_ID, "bad key".into()).unwrap_err(),
            INVALID
        );
    }
    #[test]
    fn credential_write_failure_and_snapshot_failure_restore_previous_key() {
        for corrupt in [false, true] {
            let (_dir, credentials, store, handle) = fixture(200, MODELS);
            *credentials.key.lock().unwrap() = Some("synthetic-old".into());
            let prior = store.state.lock().unwrap().account.clone();
            if corrupt {
                *credentials.corrupt_after_write.lock().unwrap() =
                    Some(store.root.join("accounts.json"));
            } else {
                credentials.fail_write.store(true, Ordering::SeqCst);
            }
            assert_eq!(
                store.connect(ACCOUNT_ID, KEY.into()).unwrap_err(),
                if corrupt { STORAGE } else { CREDENTIALS }
            );
            handle.join().unwrap();
            assert_eq!(
                credentials.read().unwrap().as_deref(),
                Some("synthetic-old")
            );
            assert_eq!(store.state.lock().unwrap().account, prior);
            if corrupt {
                assert_eq!(
                    std::fs::read(store.root.join("accounts.json")).unwrap(),
                    b"preserve-corrupt-data"
                );
                assert_eq!(store.list().unwrap_err(), STORAGE);
            }
        }
    }
    #[test]
    fn credential_readback_failure_rolls_back_and_failed_rollback_blocks_use() {
        for fail_restore in [false, true] {
            let (_dir, credentials, store, handle) = fixture(200, MODELS);
            *credentials.key.lock().unwrap() = Some("synthetic-old".into());
            credentials
                .fail_read_after_write
                .store(true, Ordering::SeqCst);
            credentials
                .fail_restore
                .store(fail_restore, Ordering::SeqCst);
            let prior = store.state.lock().unwrap().account.clone();
            assert_eq!(
                store.connect(ACCOUNT_ID, KEY.into()).unwrap_err(),
                CREDENTIALS
            );
            handle.join().unwrap();
            assert_eq!(store.state.lock().unwrap().account, prior);
            if fail_restore {
                assert!(store.state.lock().unwrap().blocked);
                assert_eq!(store.list().unwrap_err(), CREDENTIALS);
                assert_eq!(store.refresh().unwrap_err(), CREDENTIALS);
                assert_eq!(
                    store.connect(ACCOUNT_ID, KEY.into()).unwrap_err(),
                    CREDENTIALS
                );
            } else {
                assert_eq!(
                    credentials.read().unwrap().as_deref(),
                    Some("synthetic-old")
                );
            }
        }
    }
    #[test]
    fn network_and_timeout_failures_are_sanitized_and_preserve_last_success() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/v1/models", listener.local_addr().unwrap());
        drop(listener);
        let root = temp();
        let credentials = Arc::new(FakeCredentials::default());
        *credentials.key.lock().unwrap() = Some(KEY.into());
        let store = Store::new(
            root.path().into(),
            Box::new(credentials),
            ModelsClient::build(&url, Duration::from_millis(100)).unwrap(),
        )
        .unwrap();
        store.state.lock().unwrap().account.last_success_at = Some(123);
        let account = store.refresh().unwrap();
        assert_eq!(account.last_success_at, Some(123));
        assert_eq!(account.error.as_deref(), Some(NETWORK));
        assert_eq!(account.status, AccountStatus::Error);

        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let url = format!("http://{}/v1/models", server.server_addr());
        let handle = std::thread::spawn(move || {
            let request = server
                .recv_timeout(Duration::from_secs(2))
                .unwrap()
                .unwrap();
            std::thread::sleep(Duration::from_millis(250));
            let _ = request.respond(tiny_http::Response::from_string(MODELS));
        });
        assert_eq!(
            ModelsClient::build(&url, Duration::from_millis(100))
                .unwrap()
                .check(KEY)
                .unwrap_err(),
            NETWORK
        );
        handle.join().unwrap();
    }
    #[test]
    fn redirects_are_not_followed_and_unknown_length_bodies_are_bounded() {
        let target = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let redirect = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let url = format!("http://{}/v1/models", redirect.server_addr());
        let location = format!("http://{}/must-not-receive-key", target.server_addr());
        let handle = std::thread::spawn(move || {
            let request = redirect
                .recv_timeout(Duration::from_secs(2))
                .unwrap()
                .unwrap();
            request
                .respond(
                    tiny_http::Response::empty(302)
                        .with_header(tiny_http::Header::from_bytes("Location", location).unwrap()),
                )
                .unwrap();
        });
        assert_eq!(
            ModelsClient::build(&url, Duration::from_secs(1))
                .unwrap()
                .check(KEY)
                .unwrap_err(),
            HTTP
        );
        handle.join().unwrap();
        assert!(target
            .recv_timeout(Duration::from_millis(50))
            .unwrap()
            .is_none());

        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let url = format!("http://{}/v1/models", server.server_addr());
        let handle = std::thread::spawn(move || {
            let request = server
                .recv_timeout(Duration::from_secs(2))
                .unwrap()
                .unwrap();
            let body = std::io::Cursor::new(vec![b' '; MAX_BODY + 1]);
            let _ = request.respond(tiny_http::Response::new(
                tiny_http::StatusCode(200),
                vec![],
                body,
                None,
                None,
            ));
        });
        assert_eq!(
            ModelsClient::build(&url, Duration::from_secs(1))
                .unwrap()
                .check(KEY)
                .unwrap_err(),
            PROTOCOL
        );
        handle.join().unwrap();
    }
    #[test]
    fn refresh_and_replacement_are_serialized_through_publication() {
        let root = temp();
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let url = format!("http://{}/v1/models", server.server_addr());
        let credentials = Arc::new(FakeCredentials::default());
        *credentials.key.lock().unwrap() = Some("synthetic-old".into());
        let store = Arc::new(
            Store::new(
                root.path().into(),
                Box::new(credentials.clone()),
                ModelsClient::build(&url, Duration::from_secs(2)).unwrap(),
            )
            .unwrap(),
        );
        let refreshing = store.clone();
        let first = std::thread::spawn(move || refreshing.refresh().unwrap());
        let request = server
            .recv_timeout(Duration::from_secs(2))
            .unwrap()
            .unwrap();
        let replacing = store.clone();
        let (started_tx, started_rx) = std::sync::mpsc::channel();
        let second = std::thread::spawn(move || {
            started_tx.send(()).unwrap();
            replacing.connect(ACCOUNT_ID, KEY.into()).unwrap()
        });
        started_rx.recv().unwrap();
        assert!(server
            .recv_timeout(Duration::from_millis(50))
            .unwrap()
            .is_none());
        request
            .respond(tiny_http::Response::from_string(MODELS))
            .unwrap();
        let replacement = server
            .recv_timeout(Duration::from_secs(2))
            .unwrap()
            .unwrap();
        replacement
            .respond(tiny_http::Response::from_string(MODELS))
            .unwrap();
        first.join().unwrap();
        let current = second.join().unwrap();
        assert_eq!(credentials.read().unwrap().as_deref(), Some(KEY));
        assert_eq!(store.list().unwrap(), current);
        assert_eq!(
            storage::load_for(&store.root, &[initial()]).unwrap(),
            vec![current]
        );
    }
    #[test]
    fn corrupt_snapshot_is_not_repaired_and_scopes_are_canonical_appdata_specific() {
        let a = temp();
        let b = temp();
        assert_ne!(
            credential_scope(a.path()).unwrap(),
            credential_scope(b.path()).unwrap()
        );
        assert_eq!(
            credential_scope(a.path()).unwrap(),
            credential_scope(&a.path().join(".")).unwrap()
        );
        std::fs::write(a.path().join("accounts.json"), b"original-corrupt-evidence").unwrap();
        assert!(Store::new(
            a.path().into(),
            Box::new(Arc::new(FakeCredentials::default())),
            ModelsClient::production().unwrap()
        )
        .is_err());
        assert_eq!(
            std::fs::read(a.path().join("accounts.json")).unwrap(),
            b"original-corrupt-evidence"
        );
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "explicit synthetic Windows-keyring smoke; uses only new scratch-scoped entries and loopback HTTP"]
    fn native_keyring_connect_reopens_in_its_own_scope_and_cleans_up() {
        struct OwnedCredential(NativeCredentials);
        impl Drop for OwnedCredential {
            fn drop(&mut self) {
                let _ = self.0.remove();
            }
        }
        let root = temp();
        let other = temp();
        let native = NativeCredentials::new(root.path()).unwrap();
        // Never replace or delete an entry if this supposedly new scope already exists.
        assert!(native.read().unwrap().is_none());
        let owned = OwnedCredential(native);
        let (http, server) = server(200, MODELS.into());
        let store = Store::new(
            root.path().into(),
            Box::new(NativeCredentials::new(root.path()).unwrap()),
            http,
        )
        .unwrap();
        assert_eq!(
            store.connect(ACCOUNT_ID, KEY.into()).unwrap().status,
            AccountStatus::Connected
        );
        server.join().unwrap();
        let reopened = Store::new(
            root.path().into(),
            Box::new(NativeCredentials::new(root.path()).unwrap()),
            ModelsClient::production().unwrap(),
        )
        .unwrap();
        assert_eq!(reopened.list().unwrap().status, AccountStatus::Configured);
        assert!(NativeCredentials::new(other.path())
            .unwrap()
            .read()
            .unwrap()
            .is_none());
        owned.0.remove().unwrap();
        assert!(owned.0.read().unwrap().is_none());
    }
}
