//! Provider-owned CLI authentication and observations, separate from Codex and chat.
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};

use tauri::AppHandle;

use super::external_cli::{self, LoginProcess};
use super::model::{apply_identity, mark_error, AccountStatus, ProviderAccount};
use super::{claude, grok, now, storage, LoginPoll, LoginStart, LoginStatus, Result};

#[derive(Clone, Copy)]
struct Provider {
    id: &'static str,
    account_id: &'static str,
    name: &'static str,
    directory: &'static str,
}

const PROVIDERS: [Provider; 3] = [
    Provider {
        id: "claude",
        account_id: "claude-1",
        name: "Claude 1",
        directory: "claude",
    },
    Provider {
        id: "grok",
        account_id: "grok-1",
        name: "Grok 1",
        directory: "grok",
    },
    Provider {
        id: "commandCode",
        account_id: "commandcode-1",
        name: "CommandCode 1",
        directory: "commandcode",
    },
];

impl Provider {
    fn initial(self) -> ProviderAccount {
        ProviderAccount {
            id: self.account_id.into(),
            provider_id: self.id.into(),
            label: self.name.into(),
            identity: None,
            status: AccountStatus::Disconnected,
            duplicate_of: None,
            last_attempt_at: None,
            last_success_at: None,
            error: None,
            usage: None,
        }
    }
}

pub(super) fn is_account(id: &str) -> bool {
    PROVIDERS.iter().any(|p| p.account_id == id)
}

fn provider(id: &str) -> Result<Provider> {
    PROVIDERS
        .iter()
        .find(|p| p.account_id == id)
        .copied()
        .ok_or_else(|| "Unknown provider account slot".into())
}

pub(super) fn usage_url(id: &str) -> Result<&'static str> {
    match provider(id)?.id {
        "claude" => Ok("https://claude.ai/settings/usage"),
        "commandCode" => Ok("https://commandcode.ai/usage"),
        _ => Err("This provider reports usage inside TABS".into()),
    }
}

fn safe_error(error: &str) -> &'static str {
    match error {
        "cliUnavailable" | "grok_cli_unavailable" => "cliUnavailable",
        "unsupportedAuth" => "unsupportedAuth",
        "unsupportedProtocol" | "grok_protocol_unsupported" | "grok_method_unsupported" => {
            "unsupportedProtocol"
        }
        "unsafeStorage" => "unsafeStorage",
        "loginExpired" => "loginExpired",
        _ => "checkFailed",
    }
}

struct Login {
    id: String,
    process: LoginProcess,
}
struct State {
    account: ProviderAccount,
    claude_poll: claude::Poll,
    login: Option<Login>,
    terminal: Option<(String, LoginPoll)>,
}
struct Store {
    root: PathBuf,
    provider: Provider,
    state: Mutex<State>,
}
static STORES: OnceLock<Mutex<HashMap<PathBuf, Arc<Store>>>> = OnceLock::new();

impl Store {
    fn new(root: PathBuf, provider: Provider) -> Result<Self> {
        let account = storage::load_for(&root, &[provider.initial()])?.remove(0);
        Ok(Self {
            root,
            provider,
            state: Mutex::new(State {
                account,
                claude_poll: claude::Poll::default(),
                login: None,
                terminal: None,
            }),
        })
    }
    fn home(&self) -> Result<PathBuf> {
        storage::directory(&self.root, self.provider.account_id).map_err(|_| "unsafeStorage".into())
    }
    fn list(&self) -> Result<ProviderAccount> {
        let _ = storage::load_for(&self.root, &[self.provider.initial()])?;
        Ok(self
            .state
            .lock()
            .map_err(|_| "Account state lock failed")?
            .account
            .clone())
    }
    fn save(&self, state: &mut State, account: ProviderAccount) -> Result<ProviderAccount> {
        storage::save_for(
            &self.root,
            std::slice::from_ref(&account),
            &[self.provider.initial()],
        )?;
        state.account = account;
        Ok(state.account.clone())
    }
    fn fail(&self, state: &mut State, error: &str) -> Result<ProviderAccount> {
        let mut account = state.account.clone();
        mark_error(&mut account, now(), safe_error(error));
        self.save(state, account)
    }
    fn observe(&self, state: &mut State) -> Result<ProviderAccount> {
        let home = self.home()?;
        let mut account = state.account.clone();
        account.last_attempt_at = Some(now());
        let observed: Result<()> = (|| {
            if self.provider.id == "claude" {
                claude::observe(&home, &mut account, &mut state.claude_poll);
            } else if self.provider.id == "grok" {
                let snapshot = grok::observe(&home)?;
                apply_identity(&mut account, snapshot.identity);
                if account.identity.is_none() {
                    account.status = AccountStatus::AuthRequired;
                    account.error = snapshot.usage_error;
                } else if let Some(error) = snapshot.usage_error {
                    mark_error(&mut account, now(), safe_error(&error));
                } else {
                    account.usage = snapshot.usage;
                    account.status = AccountStatus::Connected;
                    account.last_success_at = Some(now());
                    account.error = None;
                }
            } else {
                let status = external_cli::status(self.provider.id, &home)?;
                apply_identity(&mut account, status.identity);
                account.usage = None;
                account.status = if status.logged_in {
                    AccountStatus::Configured
                } else {
                    AccountStatus::AuthRequired
                };
                account.last_success_at = status.logged_in.then(now);
                account.error = None;
            }
            Ok(())
        })();
        if let Err(error) = observed {
            mark_error(&mut account, now(), safe_error(&error));
        }
        self.save(state, account)
    }
    fn refresh(&self) -> Result<ProviderAccount> {
        let mut state = self.state.lock().map_err(|_| "Account state lock failed")?;
        // Pending (even already-exited) login publication belongs exclusively to poll.
        if state.login.is_some() {
            return Ok(state.account.clone());
        }
        self.observe(&mut state)
    }
    fn begin(&self) -> Result<LoginStart> {
        let mut state = self.state.lock().map_err(|_| "Account state lock failed")?;
        if let Some(mut previous) = state.login.take() {
            previous.process.cancel()?;
        }
        state.terminal = None;
        state.claude_poll = claude::Poll::default();
        let mut account = state.account.clone();
        apply_identity(&mut account, None);
        account.status = AccountStatus::AuthRequired;
        account.last_attempt_at = Some(now());
        account.error = None;
        self.save(&mut state, account)?;
        let mut random = [0u8; 16];
        getrandom::getrandom(&mut random).map_err(|_| "Could not create login identifier")?;
        let id: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
        let process = match LoginProcess::start(self.provider.id, &self.home()?) {
            Ok(process) => process,
            Err(error) => {
                self.fail(&mut state, &error)?;
                return Err(safe_error(&error).into());
            }
        };
        state.login = Some(Login {
            id: id.clone(),
            process,
        });
        Ok(LoginStart {
            account_id: self.provider.account_id.into(),
            login_id: id,
            auth_url: String::new(),
            flow: Some("cli"),
        })
    }
    fn poll(&self, id: &str) -> Result<LoginPoll> {
        let mut state = self.state.lock().map_err(|_| "Account state lock failed")?;
        if let Some((completed, result)) = &state.terminal {
            if completed == id {
                return Ok(result.clone());
            }
        }
        let login = state
            .login
            .as_mut()
            .filter(|login| login.id == id)
            .ok_or("Login is no longer active for this slot")?;
        let outcome = login.process.poll();
        if matches!(outcome, Ok(None)) {
            return Ok(LoginPoll {
                status: LoginStatus::Pending,
                account: None,
                error: None,
            });
        }
        state.login.take(); // Drop owns/joins the terminated process tree before reading identity.
        let login_succeeded = matches!(outcome, Ok(Some(true)));
        let account = match outcome {
            Ok(Some(true)) => self.observe(&mut state)?,
            Ok(_) => self.fail(&mut state, "loginFailed")?,
            Err(error) => self.fail(&mut state, &error)?,
        };
        let completed = login_succeeded
            && (matches!(
                account.status,
                AccountStatus::Configured | AccountStatus::Connected
            ) || account.identity.is_some());
        let result = LoginPoll {
            status: if completed {
                LoginStatus::Completed
            } else {
                LoginStatus::Failed
            },
            error: account
                .error
                .clone()
                .or_else(|| (!completed).then(|| "loginFailed".into())),
            account: Some(account),
        };
        state.terminal = Some((id.into(), result.clone()));
        Ok(result)
    }
    fn cancel(&self, id: &str) -> Result<()> {
        let mut state = self.state.lock().map_err(|_| "Account state lock failed")?;
        if state
            .terminal
            .as_ref()
            .is_some_and(|(terminal, _)| terminal == id)
        {
            return Ok(());
        }
        if !state.login.as_ref().is_some_and(|login| login.id == id) {
            return Err("Login is no longer active for this slot".into());
        }
        let mut login = state.login.take().unwrap();
        let cancelled = login.process.cancel();
        drop(login);
        let mut account = state.account.clone();
        account.status = AccountStatus::AuthRequired;
        account.error = None;
        let account = self.save(&mut state, account)?;
        state.terminal = Some((
            id.into(),
            LoginPoll {
                status: LoginStatus::Failed,
                account: Some(account),
                error: Some("Login cancelled".into()),
            },
        ));
        cancelled
    }
}

fn store_for(app: &AppHandle, provider: Provider) -> Result<Arc<Store>> {
    let root = super::provider_root(app, provider.directory)?;
    let mut stores = STORES
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .map_err(|_| "Account registry lock failed")?;
    if let Some(store) = stores.get(&root) {
        return Ok(store.clone());
    }
    let store = Arc::new(Store::new(root.clone(), provider)?);
    stores.insert(root, store.clone());
    Ok(store)
}
fn unavailable(provider: Provider) -> ProviderAccount {
    let mut account = provider.initial();
    mark_error(&mut account, now(), "unsafeStorage");
    account
}

// One unavailable provider must not hide the existing Codex registry or other providers.
pub(super) fn list(app: &AppHandle) -> Vec<ProviderAccount> {
    PROVIDERS
        .iter()
        .map(|&provider| {
            store_for(app, provider)
                .and_then(|store| store.list())
                .unwrap_or_else(|_| unavailable(provider))
        })
        .collect()
}
pub(super) fn refresh(app: &AppHandle, id: Option<&str>) -> Result<Vec<ProviderAccount>> {
    let providers = match id {
        Some(id) => vec![provider(id)?],
        None => PROVIDERS.to_vec(),
    };
    Ok(providers
        .into_iter()
        .map(|provider| {
            store_for(app, provider)
                .and_then(|store| store.refresh())
                .unwrap_or_else(|_| unavailable(provider))
        })
        .collect())
}
pub(super) fn begin(app: &AppHandle, id: &str) -> Result<LoginStart> {
    store_for(app, provider(id)?)?.begin()
}
pub(super) fn poll(app: &AppHandle, id: &str, login_id: &str) -> Result<LoginPoll> {
    store_for(app, provider(id)?)?.poll(login_id)
}
pub(super) fn cancel(app: &AppHandle, id: &str, login_id: &str) -> Result<()> {
    store_for(app, provider(id)?)?.cancel(login_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture(provider: Provider) -> (tempfile::TempDir, Store) {
        let dir = tempfile::Builder::new()
            .prefix("tabs-external-store-")
            .tempdir_in(storage::test_temp_root())
            .unwrap();
        let store = Store::new(dir.path().canonicalize().unwrap(), provider).unwrap();
        (dir, store)
    }
    #[test]
    fn exact_provider_slots_and_usage_destinations() {
        for id in [
            "../grok-1",
            "grok-01",
            "claude-2",
            "commandCode-1",
            "codex-1",
        ] {
            assert!(!is_account(id));
            assert!(provider(id).is_err());
            assert!(usage_url(id).is_err());
        }
        assert_eq!(
            usage_url("claude-1").unwrap(),
            "https://claude.ai/settings/usage"
        );
        assert_eq!(
            usage_url("commandcode-1").unwrap(),
            "https://commandcode.ai/usage"
        );
        assert!(usage_url("grok-1").is_err());
    }
    #[test]
    fn claude_refresh_clears_legacy_identity_without_importing_other_logins() {
        let (_dir, store) = fixture(PROVIDERS[0]);
        let mut state = store.state.lock().unwrap();
        let mut legacy = state.account.clone();
        legacy.status = AccountStatus::Configured;
        legacy.identity = Some(super::super::model::Identity {
            key: String::new(),
            email: Some("fixture@example.invalid".into()),
            workspace_id: None,
            plan: None,
        });
        store.save(&mut state, legacy).unwrap();
        drop(state);
        let account = store.refresh().unwrap();
        assert_eq!(account.status, AccountStatus::AuthRequired);
        assert!(account.identity.is_none() && account.usage.is_none());
        assert_eq!(account.error.as_deref(), Some("claudeAuthRequired"));
        assert_eq!(store.list().unwrap(), account);
    }
    #[test]
    fn stale_login_ids_never_mutate_snapshots_or_start_processes() {
        let (_dir, store) = fixture(PROVIDERS[0]);
        let before = store.list().unwrap();
        assert!(store.poll("stale").is_err());
        assert!(store.cancel("stale").is_err());
        assert_eq!(store.list().unwrap(), before);
    }
    #[test]
    fn provider_snapshots_cannot_replace_codex_or_another_provider() {
        let (dir, store) = fixture(PROVIDERS[0]);
        let claude = vec![store.list().unwrap()];
        storage::save_for(dir.path(), &claude, &[PROVIDERS[0].initial()]).unwrap();
        let original = std::fs::read(dir.path().join("accounts.json")).unwrap();
        assert!(storage::load(dir.path()).is_err());
        assert!(storage::save(dir.path(), &super::super::model::initial_accounts()).is_err());
        assert!(storage::save_for(
            dir.path(),
            &[PROVIDERS[1].initial()],
            &[PROVIDERS[1].initial()]
        )
        .is_err());
        assert_eq!(
            std::fs::read(dir.path().join("accounts.json")).unwrap(),
            original
        );
        assert_eq!(
            storage::load_for(dir.path(), &[PROVIDERS[0].initial()]).unwrap(),
            claude
        );
    }
    #[test]
    fn corrupt_snapshot_is_not_repaired_or_overwritten() {
        let (dir, store) = fixture(PROVIDERS[2]);
        let target = dir.path().join("accounts.json");
        std::fs::write(&target, b"broken-owner-data").unwrap();
        assert!(store.list().is_err());
        let mut state = store.state.lock().unwrap();
        assert!(store.fail(&mut state, "raw-sensitive-error").is_err());
        assert_eq!(std::fs::read(target).unwrap(), b"broken-owner-data");
        assert_eq!(safe_error("raw-sensitive-error"), "checkFailed");
        assert_eq!(safe_error("grok_method_unsupported"), "unsupportedProtocol");
        assert_eq!(safe_error("grok_cli_unavailable"), "cliUnavailable");
    }
}
