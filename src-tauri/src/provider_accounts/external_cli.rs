//! Account-only vendor CLI boundary. Never use this launcher for chat/inference.
//! Status is local configuration evidence, not a live account or quota check.

use super::{model::Identity, storage};
use crate::{cli_providers::discovery, codex::CliOwnedJob};
use serde_json::Value;
use std::ffi::OsString;
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const LOGIN_TTL: Duration = Duration::from_secs(600);
const STATUS_TTL: Duration = Duration::from_secs(20);
const MAX_STATUS_BYTES: usize = 64 * 1024;

fn provider_allowed(provider: &str) -> Result<(), String> {
    match provider {
        "claude" | "grok" | "commandCode" => Ok(()),
        _ => Err("cliUnavailable".into()),
    }
}

fn native_file(path: PathBuf) -> Option<PathBuf> {
    if !path.extension()?.eq_ignore_ascii_case("exe") {
        return None;
    }
    path.canonicalize().ok().filter(|p| p.is_file())
}

fn claude_executable() -> Result<PathBuf, String> {
    let mut candidates = Vec::new();
    if let Some(profile) = std::env::var_os("USERPROFILE") {
        candidates.push(PathBuf::from(profile).join(".local/bin/claude.exe"));
    }
    if let Some(paths) = std::env::var_os("PATH") {
        candidates.extend(std::env::split_paths(&paths).map(|p| p.join("claude.exe")));
    }
    // Official installed npm 2.1.261 declares this native bin in package.json.
    // Its `auth login --help` confirms --claudeai. No JS/shim fallback.
    if let Some(app_data) = std::env::var_os("APPDATA") {
        candidates.push(
            PathBuf::from(app_data)
                .join("npm/node_modules/@anthropic-ai/claude-code/bin/claude.exe"),
        );
    }
    candidates
        .into_iter()
        .find_map(native_file)
        .ok_or_else(|| "cliUnavailable".into())
}

fn safe_directory(parent: &Path, name: &str) -> Result<PathBuf, String> {
    storage::directory(parent, name).map_err(|_| "unsafeStorage".into())
}

// Windows creates this compatibility alias during browser authentication. Accept
// only the exact compatibility alias to the ordinary sibling inside this home;
// never follow it, allow arbitrary cache links, or exempt the target from checks.
fn local_windows_cache_alias(home: &Path, path: &Path) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        let cache = home.join("AppData/Local/Microsoft/Windows/INetCache");
        if path != cache.join("Content.IE5") {
            return false;
        }
        let Ok(metadata) = std::fs::symlink_metadata(path) else {
            return false;
        };
        if metadata.file_attributes() & 0x400 == 0 {
            return false;
        }
        let target = cache.join("IE");
        let Ok(link) = std::fs::read_link(path) else {
            return false;
        };
        discovery::cli_path(&link)
            .replace('/', "\\")
            .eq_ignore_ascii_case(&discovery::cli_path(&target).replace('/', "\\"))
            && storage::reject_link(&target).is_ok()
            && target.is_dir()
    }
    #[cfg(not(windows))]
    {
        let _ = (home, path);
        false
    }
}

pub(super) fn check_home(home: &Path) -> Result<(), String> {
    if !home.is_absolute()
        || home
            .components()
            .any(|c| matches!(c, Component::ParentDir | Component::CurDir))
    {
        return Err("unsafeStorage".into());
    }
    for ancestor in home.ancestors() {
        storage::reject_link(ancestor).map_err(|_| "unsafeStorage")?;
    }
    if !home.is_dir() {
        return Err("unsafeStorage".into());
    }
    // Metadata only. A linked nested credential/config file must not escape.
    let mut pending = vec![(home.to_owned(), 0)];
    let mut count = 0;
    while let Some((directory, depth)) = pending.pop() {
        if depth > 32 {
            return Err("unsafeStorage".into());
        }
        for entry in std::fs::read_dir(directory).map_err(|_| "unsafeStorage")? {
            let path = entry.map_err(|_| "unsafeStorage")?.path();
            count += 1;
            if count > 10_000 {
                return Err("unsafeStorage".into());
            }
            if local_windows_cache_alias(home, &path) {
                continue;
            }
            storage::reject_link(&path).map_err(|_| "unsafeStorage")?;
            if std::fs::symlink_metadata(&path)
                .map_err(|_| "unsafeStorage")?
                .is_dir()
            {
                pending.push((path, depth + 1));
            }
        }
    }
    Ok(())
}

fn isolated_command(
    executable: &Path,
    arguments: &[OsString],
    home: &Path,
    inherited: impl IntoIterator<Item = (OsString, OsString)>,
) -> Result<Command, String> {
    check_home(home)?;
    let home = home.canonicalize().map_err(|_| "unsafeStorage")?;
    let app_data = safe_directory(&home, "AppData")?;
    let roaming = safe_directory(&app_data, "Roaming")?;
    let local = safe_directory(&app_data, "Local")?;
    let config = safe_directory(&home, ".config")?;
    let cache = safe_directory(&home, ".cache")?;
    let data = safe_directory(&home, ".data")?;
    let state = safe_directory(&home, ".state")?;
    let runtime = safe_directory(&home, ".runtime")?;
    let temp = safe_directory(&home, "tmp")?;
    let claude = safe_directory(&home, ".claude")?;
    let grok = safe_directory(&home, ".grok")?;
    let _ = safe_directory(&home, ".commandcode")?;
    let mut command = Command::new(executable);
    command.args(arguments).current_dir(&home).env_clear();
    // Allowlist, not a blacklist: no tokens, provider/profile, proxy, NODE_*,
    // user PATH or other application overrides survive.
    let mut system_root = None;
    for (key, value) in inherited {
        if key.eq_ignore_ascii_case("SystemRoot") {
            system_root = Some(PathBuf::from(&value));
            command.env("SystemRoot", value);
        } else if key.eq_ignore_ascii_case("WINDIR") {
            command.env("WINDIR", value);
        }
    }
    let mut paths = Vec::new();
    if let Some(root) = system_root {
        paths.push(root.join("System32"));
        paths.push(root);
    }
    if let Some(parent) = executable.parent() {
        paths.push(parent.to_owned());
    }
    command.env(
        "PATH",
        std::env::join_paths(paths).map_err(|_| "cliUnavailable")?,
    );
    for (key, path) in [
        ("HOME", &home),
        ("USERPROFILE", &home),
        ("APPDATA", &roaming),
        ("LOCALAPPDATA", &local),
        ("XDG_CONFIG_HOME", &config),
        ("XDG_CACHE_HOME", &cache),
        ("XDG_DATA_HOME", &data),
        ("XDG_STATE_HOME", &state),
        ("XDG_RUNTIME_DIR", &runtime),
        ("TEMP", &temp),
        ("TMP", &temp),
        ("TMPDIR", &temp),
        ("CLAUDE_CONFIG_DIR", &claude),
        ("GROK_HOME", &grok),
    ] {
        command.env(key, discovery::cli_path(path));
    }
    command
        .env("DISABLE_AUTOUPDATER", "1")
        .env("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "1");
    Ok(command)
}

/// The home is supplied only by the native account store, never the renderer.
/// Windows-only: this does not claim OS-keyring separation on other platforms.
pub(super) fn command(provider: &str, home: &Path) -> Result<Command, String> {
    provider_allowed(provider)?;
    if !cfg!(windows) {
        return Err("cliUnavailable".into());
    }
    if provider == "claude" {
        isolated_command(&claude_executable()?, &[], home, std::env::vars_os())
    } else {
        let launch = discovery::discover(provider).map_err(|_| "cliUnavailable")?;
        if !launch
            .executable
            .extension()
            .is_some_and(|e| e.eq_ignore_ascii_case("exe"))
        {
            return Err("cliUnavailable".into());
        }
        isolated_command(
            &launch.executable,
            &launch.arguments,
            home,
            std::env::vars_os(),
        )
    }
}

pub(super) struct LocalStatus {
    pub logged_in: bool,
    pub identity: Option<Identity>,
}

fn text(value: &Value, field: &str) -> Option<String> {
    let s = value.get(field)?.as_str()?;
    if s.is_empty() || s.len() > 256 || s.chars().any(char::is_control) {
        return None;
    }
    Some(s.to_owned())
}

fn parse_status(provider: &str, bytes: &[u8]) -> Result<LocalStatus, String> {
    if bytes.len() > MAX_STATUS_BYTES {
        return Err("statusFailed".into());
    }
    let value: Value = serde_json::from_slice(bytes).map_err(|_| "statusFailed")?;
    if !value.is_object() || value.get("error").is_some_and(|e| !e.is_null()) {
        return Err("statusFailed".into());
    }
    let field = match provider {
        "claude" => "loggedIn",
        "commandCode" => "authenticated",
        _ => return Err("statusFailed".into()),
    };
    let logged_in = value
        .get(field)
        .and_then(Value::as_bool)
        .ok_or("statusFailed")?;
    // Official installed source: Provider.COMMAND = "command-code". Missing is
    // normal before a provider preference is saved; explicit BYOK is rejected.
    if provider == "commandCode"
        && value
            .get("provider")
            .is_some_and(|p| p.as_str() != Some("command-code"))
    {
        return Err("unsupportedAuth".into());
    }
    if !logged_in {
        return Ok(LocalStatus {
            logged_in: false,
            identity: None,
        });
    }
    if provider == "claude" {
        if value.get("authMethod").and_then(Value::as_str) != Some("claude.ai")
            || value
                .get("apiProvider")
                .is_some_and(|p| p.as_str() != Some("firstParty"))
        {
            return Err("unsupportedAuth".into());
        }
        return Ok(LocalStatus {
            logged_in: true,
            identity: Some(Identity {
                // No supported stable principal ID: never hash/dedupe by email.
                key: String::new(),
                email: text(&value, "email"),
                workspace_id: text(&value, "orgId"),
                plan: text(&value, "subscriptionType"),
            }),
        });
    }
    // Command Code's `user` is a display name, not a confirmed email/principal;
    // status exposes no confirmed workspace/subscription fields.
    Ok(LocalStatus {
        logged_in: true,
        identity: None,
    })
}

fn capture_status(mut command: Command) -> Result<(bool, Vec<u8>), String> {
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW: status only.
    }
    let mut child = command.spawn().map_err(|_| "statusFailed")?;
    let job = match CliOwnedJob::assign(&child) {
        Ok(job) => job,
        Err(_) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err("statusFailed".into());
        }
    };
    let stdout = child.stdout.take().ok_or("statusFailed")?;
    let reader = std::thread::Builder::new()
        .name("account-status-output".into())
        .spawn(move || {
            let mut bytes = Vec::new();
            stdout
                .take(MAX_STATUS_BYTES as u64 + 1)
                .read_to_end(&mut bytes)
                .map(|_| bytes)
        });
    let reader = match reader {
        Ok(reader) => reader,
        Err(_) => {
            job.terminate();
            let _ = child.kill();
            let _ = child.wait();
            return Err("statusFailed".into());
        }
    };
    let deadline = Instant::now() + STATUS_TTL;
    let result = loop {
        match child.try_wait() {
            Ok(Some(exit)) if exit.code() == Some(0) || exit.code() == Some(1) => {
                break Ok(exit.success())
            }
            Ok(Some(_)) | Err(_) => break Err("statusFailed".to_owned()),
            Ok(None) if Instant::now() >= deadline => break Err("statusFailed".to_owned()),
            Ok(None) => std::thread::sleep(Duration::from_millis(25)),
        }
    };
    // Close descendant-held stdout before joining the bounded reader.
    job.terminate();
    let _ = child.kill();
    let _ = child.wait();
    drop(job);
    let bytes = reader
        .join()
        .map_err(|_| "statusFailed")?
        .map_err(|_| "statusFailed")?;
    if bytes.len() > MAX_STATUS_BYTES {
        return Err("statusFailed".into());
    }
    Ok((result?, bytes))
}

pub(super) fn status(provider: &str, home: &Path) -> Result<LocalStatus, String> {
    let args: &[&str] = match provider {
        "claude" => &["auth", "status", "--json"],
        "commandCode" => &["status", "--json", "--no-auto-update", "--skip-onboarding"],
        _ => return Err("statusFailed".into()),
    };
    let mut command = command(provider, home)?;
    command.args(args);
    let (success, bytes) = capture_status(command)?;
    let status = parse_status(provider, &bytes)?;
    if status.logged_in && !success {
        return Err("statusFailed".into());
    }
    Ok(status)
}

/// Rust inherits redirected handles even with CREATE_NEW_CONSOLE. Only when
/// inherited stdio is absent does Windows initialize real console I/O. Reject
/// redirected/debug hosts rather than silently start an unusable login. No
/// global SetStdHandle/AllocConsole, shell, helper exe or raw-output forwarding.
fn login_console(command: &mut Command) -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::os::windows::{io::AsRawHandle, process::CommandExt};
        let handles = [
            std::io::stdin().as_raw_handle(),
            std::io::stdout().as_raw_handle(),
            std::io::stderr().as_raw_handle(),
        ];
        if handles.iter().any(|h| !h.is_null() && *h as isize != -1) {
            return Err("loginFailed".into());
        }
        command.creation_flags(0x00000010); // CREATE_NEW_CONSOLE, never NO_WINDOW.
        command
            .stdin(Stdio::inherit())
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit());
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = command;
        Err("loginFailed".into())
    }
}

struct LoginState {
    child: Child,
    job: Option<CliOwnedJob>,
    completed: Option<bool>,
    expired: bool,
}
impl LoginState {
    fn stop(&mut self) {
        if let Some(job) = self.job.take() {
            job.terminate();
            let _ = self.child.kill();
            let _ = self.child.wait();
            drop(job);
        }
    }
    fn observe(&mut self, expired: bool) {
        if self.completed.is_some() {
            return;
        }
        match self.child.try_wait() {
            Ok(Some(exit)) => {
                self.completed = Some(exit.success());
                self.stop();
            }
            Ok(None) if !expired => {}
            _ => {
                self.expired = expired;
                self.completed = Some(false);
                self.stop();
            }
        }
    }
}
impl Drop for LoginState {
    fn drop(&mut self) {
        self.stop();
    }
}

pub(super) struct LoginProcess {
    state: Arc<Mutex<LoginState>>,
    deadline: Instant,
}
impl LoginProcess {
    pub(super) fn start(provider: &str, home: &Path) -> Result<Self, String> {
        let mut command = command(provider, home)?;
        command.args(match provider {
            "claude" => vec!["auth", "login", "--claudeai"],
            "grok" => vec!["--no-auto-update", "login", "--oauth"],
            "commandCode" => vec!["login", "--no-auto-update", "--skip-onboarding"],
            _ => return Err("cliUnavailable".into()),
        });
        login_console(&mut command)?;
        Self::spawn(command, LOGIN_TTL)
    }
    fn spawn(mut command: Command, ttl: Duration) -> Result<Self, String> {
        let mut child = command.spawn().map_err(|_| "loginFailed")?;
        let job = match CliOwnedJob::assign(&child) {
            Ok(job) => job,
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("loginFailed".into());
            }
        };
        let deadline = Instant::now() + ttl;
        let process = Self {
            deadline,
            state: Arc::new(Mutex::new(LoginState {
                child,
                job: Some(job),
                completed: None,
                expired: false,
            })),
        };
        let weak = Arc::downgrade(&process.state);
        // Weak reference cannot retain a dropped login. No UI poll is required
        // for unattended expiry. Dropping process on thread-start failure kills.
        std::thread::Builder::new()
            .name("account-login-expiry".into())
            .spawn(move || loop {
                let Some(state) = weak.upgrade() else {
                    break;
                };
                let mut state = state.lock().unwrap_or_else(|e| e.into_inner());
                state.observe(Instant::now() >= deadline);
                if state.completed.is_some() {
                    break;
                }
                drop(state);
                std::thread::sleep(Duration::from_millis(100));
            })
            .map_err(|_| "loginFailed")?;
        Ok(process)
    }
    pub(super) fn poll(&mut self) -> Result<Option<bool>, String> {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        state.observe(Instant::now() >= self.deadline);
        if state.expired {
            return Err("loginExpired".into());
        }
        Ok(state.completed)
    }
    pub(super) fn cancel(&mut self) -> Result<(), String> {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        state.completed = Some(false);
        state.stop();
        Ok(())
    }
}
impl Drop for LoginProcess {
    fn drop(&mut self) {
        let _ = self.cancel();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsStr;

    #[test]
    #[ignore = "explicit installed signed-out status only; uses new empty scratch homes"]
    fn installed_signedout_status_smoke() {
        for provider in ["claude", "commandCode"] {
            let dir = tempfile::Builder::new()
                .prefix("tabs-installed-status-")
                .tempdir_in(storage::test_temp_root())
                .unwrap();
            let result =
                status(provider, dir.path()).unwrap_or_else(|error| panic!("{provider}: {error}"));
            assert!(!result.logged_in, "empty home must not inherit an account");
            assert!(result.identity.is_none());
        }
    }

    #[test]
    fn claude_accepts_only_managed_auth_and_allowlisted_metadata() {
        let status = parse_status("claude", br#"{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","email":"test@example.invalid","orgId":"org-fixture","subscriptionType":"max","accessToken":"synthetic-secret","accountId":"not-a-supported-principal"}"#).unwrap();
        assert!(status.logged_in);
        let identity = status.identity.unwrap();
        assert!(identity.key.is_empty());
        assert_eq!(identity.email.as_deref(), Some("test@example.invalid"));
        assert_eq!(identity.workspace_id.as_deref(), Some("org-fixture"));
        assert_eq!(identity.plan.as_deref(), Some("max"));
        for method in [
            "api_key",
            "oauth_token",
            "api_key_helper",
            "third_party",
            "none",
        ] {
            let bytes =
                serde_json::to_vec(&serde_json::json!({"loggedIn":true,"authMethod":method}))
                    .unwrap();
            assert_eq!(
                parse_status("claude", &bytes).err().as_deref(),
                Some("unsupportedAuth")
            );
        }
        assert!(
            parse_status("claude", br#"{"loggedIn":false,"authMethod":"none"}"#)
                .unwrap()
                .identity
                .is_none()
        );
        assert!(
            parse_status("claude", br#"{"loggedIn":true,"authMethod":"claude.ai"}"#)
                .unwrap()
                .identity
                .unwrap()
                .email
                .is_none()
        );
    }

    #[test]
    fn commandcode_rejects_byok_and_does_not_invent_identity_or_plan() {
        for bytes in [br#"{"authenticated":true,"provider":"command-code","user":"Display Name","plan":"invented","apiKey":"synthetic-secret"}"#.as_slice(), br#"{"authenticated":true}"#] {
            let status = parse_status("commandCode", bytes).unwrap();
            assert!(status.logged_in);
            assert!(status.identity.is_none());
        }
        for provider in [
            "anthropic",
            "codex",
            "github-copilot",
            "commandCode",
            "unknown",
        ] {
            let bytes =
                serde_json::to_vec(&serde_json::json!({"authenticated":true,"provider":provider}))
                    .unwrap();
            assert_eq!(
                parse_status("commandCode", &bytes).err().as_deref(),
                Some("unsupportedAuth")
            );
        }
        assert_eq!(
            parse_status("commandCode", br#"{"authenticated":1}"#)
                .err()
                .as_deref(),
            Some("statusFailed")
        );
    }

    #[test]
    fn unknown_provider_rejected_before_discovery_or_home_mutation() {
        for provider in [
            "",
            "claude.exe",
            "../grok",
            "command-code",
            "openCode",
            "openai-codex",
        ] {
            assert_eq!(
                command(provider, Path::new("not-a-home")).err().as_deref(),
                Some("cliUnavailable")
            );
            assert_eq!(
                status(provider, Path::new("not-a-home")).err().as_deref(),
                Some("statusFailed")
            );
        }
    }

    #[test]
    fn private_home_allowlist_removes_provider_and_runtime_overrides() {
        let dir = tempfile::Builder::new()
            .prefix("tabs-cli-env-")
            .tempdir_in(storage::test_temp_root())
            .unwrap();
        let keys = [
            "SystemRoot",
            "WINDIR",
            "ANTHROPIC_API_KEY",
            "CLAUDE_CODE_OAUTH_TOKEN",
            "COMMAND_CODE_API_KEY",
            "GROK_API_KEY",
            "NODE_OPTIONS",
            "NODE_EXTRA_CA_CERTS",
            "HTTP_PROXY",
            "ALL_PROXY",
            "CLAUDE_CONFIG_DIR",
            "GROK_HOME",
            "HOME",
            "USERPROFILE",
            "APPDATA",
            "PATH",
            "AWS_PROFILE",
        ];
        let inherited = keys.iter().map(|k| {
            (
                OsString::from(k),
                OsString::from(if *k == "SystemRoot" || *k == "WINDIR" {
                    "C:/Windows"
                } else {
                    "synthetic-parent-override"
                }),
            )
        });
        let command = isolated_command(
            Path::new("C:/fixture/vendor.exe"),
            &[],
            dir.path(),
            inherited,
        )
        .unwrap();
        let env: std::collections::HashMap<_, _> = command
            .get_envs()
            .map(|(k, v)| (k.to_owned(), v.unwrap().to_owned()))
            .collect();
        for key in keys.iter().filter(|k| {
            ![
                "SystemRoot",
                "WINDIR",
                "HOME",
                "USERPROFILE",
                "APPDATA",
                "PATH",
                "CLAUDE_CONFIG_DIR",
                "GROK_HOME",
            ]
            .contains(k)
        }) {
            assert!(!env.contains_key(OsStr::new(key)), "inherited {key}");
        }
        let canonical = dir.path().canonicalize().unwrap();
        let ordinary = PathBuf::from(discovery::cli_path(&canonical));
        for key in [
            "HOME",
            "USERPROFILE",
            "APPDATA",
            "LOCALAPPDATA",
            "TEMP",
            "TMP",
            "XDG_CONFIG_HOME",
            "CLAUDE_CONFIG_DIR",
            "GROK_HOME",
        ] {
            assert!(Path::new(env.get(OsStr::new(key)).unwrap()).starts_with(&ordinary));
        }
        assert!(!env
            .get(OsStr::new("PATH"))
            .unwrap()
            .to_string_lossy()
            .contains("synthetic-parent"));
        assert_eq!(command.get_current_dir(), Some(canonical.as_path()));
    }

    #[test]
    fn oversize_nonobject_and_wrong_schema_rejected() {
        assert!(parse_status("claude", &vec![b' '; MAX_STATUS_BYTES + 1]).is_err());
        for bytes in [
            b"null".as_slice(),
            b"[]",
            b"{}",
            br#"{"authenticated":true}"#,
        ] {
            assert_eq!(
                parse_status("claude", bytes).err().as_deref(),
                Some("statusFailed")
            );
        }
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "explicit metadata-only home validation; no CLI or credential reads"]
    fn selected_home_metadata_validation() {
        let home = PathBuf::from(std::env::var_os("TABS_VALIDATE_HOME").unwrap());
        assert_eq!(check_home(&home), Ok(()));
    }

    #[cfg(windows)]
    #[test]
    fn windows_cache_alias_accepts_only_its_local_plain_directory() {
        let root = tempfile::Builder::new()
            .prefix("tabs-cache-alias-")
            .tempdir_in(storage::test_temp_root())
            .unwrap();
        let home = storage::directory(root.path(), "home").unwrap();
        let cache = home.join("AppData/Local/Microsoft/Windows/INetCache");
        std::fs::create_dir_all(&cache).unwrap();
        let target = storage::directory(&cache, "IE").unwrap();
        let alias = cache.join("Content.IE5");
        let outside = storage::directory(root.path(), "outside").unwrap();
        for (destination, accepted) in [(&target, true), (&outside, false)] {
            assert!(Command::new("cmd.exe")
                .args(["/C", "mklink", "/J"])
                .arg(&alias)
                .arg(destination)
                .output()
                .unwrap()
                .status
                .success());
            let result = check_home(&home);
            std::fs::remove_dir(&alias).unwrap();
            assert_eq!(result.is_ok(), accepted, "{result:?}");
        }
        // A correct alias cannot hide an escaping destination directory.
        std::fs::remove_dir(&target).unwrap();
        for linked in [&target, &alias] {
            let destination = if linked == &target { &outside } else { &target };
            assert!(Command::new("cmd.exe")
                .args(["/C", "mklink", "/J"])
                .arg(linked)
                .arg(destination)
                .output()
                .unwrap()
                .status
                .success());
        }
        let result = check_home(&home);
        std::fs::remove_dir(&alias).unwrap();
        std::fs::remove_dir(&target).unwrap();
        assert_eq!(result.err().as_deref(), Some("unsafeStorage"));
    }

    #[cfg(windows)]
    #[test]
    fn nested_junction_is_rejected_without_mutating_outside_home() {
        let root = tempfile::Builder::new()
            .prefix("tabs-cli-link-")
            .tempdir_in(storage::test_temp_root())
            .unwrap();
        let home = storage::directory(root.path(), "home").unwrap();
        let outside = storage::directory(root.path(), "outside").unwrap();
        std::fs::write(outside.join("owner-marker"), b"unchanged").unwrap();
        let linked = home.join(".claude");
        // Test-only junction creation; never part of the vendor launcher.
        assert!(Command::new("cmd.exe")
            .args(["/C", "mklink", "/J"])
            .arg(&linked)
            .arg(&outside)
            .output()
            .unwrap()
            .status
            .success());
        let result = isolated_command(
            Path::new("C:/fixture/vendor.exe"),
            &[],
            &home,
            std::iter::empty(),
        );
        std::fs::remove_dir(&linked).unwrap();
        assert_eq!(result.err().as_deref(), Some("unsafeStorage"));
        assert_eq!(
            std::fs::read(outside.join("owner-marker")).unwrap(),
            b"unchanged"
        );
        assert_eq!(std::fs::read_dir(&outside).unwrap().count(), 1);
        assert!(native_file(PathBuf::from("C:/fixture/claude.cmd")).is_none());
    }

    #[cfg(windows)]
    #[test]
    fn redirected_parent_is_rejected_instead_of_starting_unusable_console() {
        use std::os::windows::io::AsRawHandle;
        let redirected = [
            std::io::stdin().as_raw_handle(),
            std::io::stdout().as_raw_handle(),
            std::io::stderr().as_raw_handle(),
        ]
        .iter()
        .any(|h| !h.is_null() && *h as isize != -1);
        if redirected {
            assert_eq!(
                login_console(&mut Command::new("not-launched.exe"))
                    .err()
                    .as_deref(),
                Some("loginFailed")
            );
        }
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "requires explicitly supplied synthetic native fixture, never a vendor executable"]
    fn synthetic_native_lifecycle_and_status_boundary() {
        use std::os::windows::process::CommandExt;
        use windows_sys::Win32::Foundation::{CloseHandle, WAIT_OBJECT_0};
        use windows_sys::Win32::System::Threading::{OpenProcess, WaitForSingleObject};
        let fixture = PathBuf::from(
            std::env::var_os("TABS_EXTERNAL_CLI_FIXTURE").expect("synthetic fixture path"),
        );
        let dir = tempfile::Builder::new()
            .prefix("tabs-cli-lifecycle-")
            .tempdir_in(storage::test_temp_root())
            .unwrap();
        let start_tree = |ttl: Duration, name: &str| {
            let ready = dir.path().join(name);
            let mut command = Command::new(&fixture);
            command
                .arg("tree")
                .arg(&ready)
                .creation_flags(0x08000000)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null());
            let process = LoginProcess::spawn(command, ttl).unwrap();
            let deadline = Instant::now() + Duration::from_secs(5);
            while !ready.is_file() && Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(10));
            }
            let pid: u32 = std::fs::read_to_string(ready).unwrap().parse().unwrap();
            let handle = unsafe { OpenProcess(0x00100000, 0, pid) }; // SYNCHRONIZE only.
            assert!(!handle.is_null());
            (process, handle)
        };
        let (mut process, handle) = start_tree(Duration::from_secs(5), "cancel-ready");
        assert_eq!(process.poll().unwrap(), None);
        process.cancel().unwrap();
        process.cancel().unwrap();
        assert_eq!(process.poll().unwrap(), Some(false));
        assert_eq!(unsafe { WaitForSingleObject(handle, 3000) }, WAIT_OBJECT_0);
        unsafe { CloseHandle(handle) };
        let (process, handle) = start_tree(Duration::from_secs(5), "drop-ready");
        drop(process);
        assert_eq!(unsafe { WaitForSingleObject(handle, 3000) }, WAIT_OBJECT_0);
        unsafe { CloseHandle(handle) };
        let (mut process, handle) = start_tree(Duration::from_millis(800), "expire-ready");
        // Do not poll: this specifically proves unattended watchdog expiry.
        assert_eq!(unsafe { WaitForSingleObject(handle, 4000) }, WAIT_OBJECT_0);
        assert_eq!(process.poll().err().as_deref(), Some("loginExpired"));
        unsafe { CloseHandle(handle) };
        for (mode, expected) in [("ok", Some(true)), ("fail", Some(false))] {
            let mut command = Command::new(&fixture);
            command.arg(mode).creation_flags(0x08000000);
            let mut process = LoginProcess::spawn(command, Duration::from_secs(5)).unwrap();
            let deadline = Instant::now() + Duration::from_secs(5);
            let result = loop {
                let result = process.poll().unwrap();
                if result.is_some() || Instant::now() >= deadline {
                    break result;
                }
                std::thread::sleep(Duration::from_millis(10));
            };
            assert_eq!(result, expected);
        }
        let mut command = Command::new(&fixture);
        command.arg("status");
        let (success, bytes) = capture_status(command).unwrap();
        assert!(success);
        assert!(parse_status("claude", &bytes).unwrap().logged_in);
        let mut command = Command::new(&fixture);
        command.arg("oversize");
        assert_eq!(
            capture_status(command).err().as_deref(),
            Some("statusFailed")
        );
    }

    #[test]
    fn rejects_non_boolean_login_and_redacts_cli_errors() {
        for bytes in [
            br#"{"loggedIn":"true","accessToken":"synthetic-secret"}"#.as_slice(),
            br#"{"loggedIn":true,"authMethod":"claude.ai","error":"synthetic-secret"}"#,
            b"synthetic-secret: not JSON",
        ] {
            assert_eq!(
                parse_status("claude", bytes).err().as_deref(),
                Some("statusFailed")
            );
        }
    }
}
