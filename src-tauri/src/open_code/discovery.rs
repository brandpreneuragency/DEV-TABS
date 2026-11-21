//! Discovery of the shared OpenCode V2 background service.
//!
//! The service registers itself at a documented state file. The owner approved
//! reading exactly `C:/Users/burak/.local/state/opencode/service.json` for the
//! automatic connection. Nothing else is read, and every accessor returns the
//! password only as [`ServiceSecret`].
//!
//! Reference: OpenCode V2 troubleshooting, "Service files", plus the official
//! `@opencode/client` discovery flow (`Service.discover` / `Service.headers`).

use std::path::{Path, PathBuf};

use serde_json::Value;

use super::types::{OpenCodeError, OpenCodeResult, ServiceInfo, ServiceSecret};

/// Owner-approved absolute registration path.
pub const APPROVED_REGISTRATION_PATH: &str = "C:/Users/burak/.local/state/opencode/service.json";

/// Fixed basic-auth user name used by the official client.
pub const AUTH_USER: &str = "opencode";

#[derive(Debug, Clone)]
pub struct Registration {
    /// Opaque service instance identifier. Used for identity only.
    pub id: Option<String>,
    /// Version the service declared when it registered.
    pub version: Option<String>,
    pub url: String,
    pub pid: Option<u32>,
    pub secret: Option<ServiceSecret>,
}

impl Registration {
    /// Stable identity key. A change means the service restarted or moved.
    pub fn identity(&self) -> String {
        format!(
            "{}|{}|{}|{}",
            self.id.as_deref().unwrap_or(""),
            self.version.as_deref().unwrap_or(""),
            self.url,
            self.pid.map(|pid| pid.to_string()).unwrap_or_default()
        )
    }
}

/// Resolve the registration file the same way the official client does.
pub fn registration_path() -> OpenCodeResult<PathBuf> {
    let state_home = std::env::var_os("XDG_STATE_HOME").map(PathBuf::from);
    let home = std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from);
    registration_path_from(state_home, home)
}

fn registration_path_from(
    state_home: Option<PathBuf>,
    home: Option<PathBuf>,
) -> OpenCodeResult<PathBuf> {
    let base = match state_home {
        Some(path) if !path.as_os_str().is_empty() => path,
        _ => {
            let home = home.ok_or_else(|| {
                OpenCodeError::unavailable("The user profile directory is not available")
            })?;
            home.join(".local").join("state")
        }
    };
    Ok(base.join("opencode").join("service.json"))
}

/// True when `path` is the owner-approved registration file.
///
/// The connection is limited to the approved file even if another state
/// directory exists through `XDG_STATE_HOME`.
pub fn is_approved_registration(path: &Path) -> bool {
    let approved = Path::new(APPROVED_REGISTRATION_PATH);
    normalize(path) == normalize(approved)
}

fn normalize(path: &Path) -> String {
    let mut text = path.to_string_lossy().replace('/', "\\");
    while text.ends_with('\\') && text.len() > 3 {
        text.pop();
    }
    text.to_ascii_lowercase()
}

/// Read and parse the registration file.
///
/// The file content is never echoed. Errors describe the failure only.
pub fn read_registration() -> OpenCodeResult<Registration> {
    let path = registration_path()?;
    if !is_approved_registration(&path) {
        return Err(OpenCodeError::unavailable(
            "OpenCode service registration is outside the approved location",
        ));
    }
    let raw = std::fs::read_to_string(&path).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            OpenCodeError::new("not_running", "OpenCode desktop service is not registered")
        } else {
            OpenCodeError::unavailable("OpenCode service registration could not be read")
        }
    })?;
    parse_registration(&raw)
}

/// Parse registration JSON. Exposed for tests; the caller supplies the text.
pub fn parse_registration(raw: &str) -> OpenCodeResult<Registration> {
    let value: Value = serde_json::from_str(raw).map_err(|_| {
        OpenCodeError::unavailable("OpenCode service registration is not valid JSON")
    })?;
    if !value.is_object() {
        return Err(OpenCodeError::unavailable(
            "OpenCode service registration is not an object",
        ));
    }
    let url = value
        .get("url")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|url| !url.is_empty())
        .ok_or_else(|| OpenCodeError::unavailable("OpenCode service has no endpoint URL"))?
        .to_string();
    let pid = value
        .get("pid")
        .and_then(Value::as_u64)
        .and_then(|pid| u32::try_from(pid).ok());
    let secret = value
        .get("password")
        .and_then(Value::as_str)
        .filter(|password| !password.is_empty())
        .map(|password| ServiceSecret::new(password.to_string()));
    Ok(Registration {
        id: value
            .get("id")
            .and_then(Value::as_str)
            .map(|id| id.to_string()),
        version: value
            .get("version")
            .and_then(Value::as_str)
            .map(|version| version.to_string()),
        url,
        pid,
        secret,
    })
}

/// Restrict the endpoint to a loopback HTTP origin.
///
/// A registration file cannot redirect the password to a remote host, and an
/// endpoint that embeds credentials in the URL is rejected.
pub fn ensure_loopback(endpoint: &reqwest::Url) -> OpenCodeResult<()> {
    if endpoint.scheme() != "http" {
        return Err(OpenCodeError::new(
            "incompatible",
            "OpenCode service endpoint must use loopback HTTP",
        ));
    }
    if !endpoint.username().is_empty() || endpoint.password().is_some() {
        return Err(OpenCodeError::new(
            "incompatible",
            "OpenCode service endpoint must not embed credentials",
        ));
    }
    if endpoint.path() != "/" || endpoint.query().is_some() || endpoint.fragment().is_some() {
        return Err(OpenCodeError::new(
            "incompatible",
            "OpenCode service endpoint must be a loopback origin",
        ));
    }
    let host = endpoint.host_str().ok_or_else(|| {
        OpenCodeError::new("incompatible", "OpenCode service endpoint has no host")
    })?;
    if is_loopback_host(host) {
        Ok(())
    } else {
        Err(OpenCodeError::new(
            "incompatible",
            "OpenCode service endpoint is not loopback",
        ))
    }
}

pub fn is_loopback_host(host: &str) -> bool {
    let host = host.trim_start_matches('[').trim_end_matches(']');
    matches!(host, "127.0.0.1" | "::1" | "localhost")
}

/// Compare the registration with the verified health payload.
pub fn verify_identity(registration: &Registration, info: &ServiceInfo) -> OpenCodeResult<()> {
    if let Some(pid) = registration.pid {
        if pid != info.pid {
            return Err(OpenCodeError::new(
                "incompatible",
                "OpenCode service process changed since registration",
            ));
        }
    }
    if let Some(version) = registration.version.as_deref() {
        if version != info.version {
            return Err(OpenCodeError::new(
                "versionMismatch",
                "OpenCode service version changed since registration",
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(text: &str) -> reqwest::Url {
        reqwest::Url::parse(text).expect("url")
    }

    #[test]
    fn loopback_hosts_are_accepted() {
        for candidate in [
            "http://127.0.0.1:49374",
            "http://[::1]:49374",
            "http://localhost:49374",
        ] {
            assert!(ensure_loopback(&url(candidate)).is_ok(), "{candidate}");
        }
    }

    #[test]
    fn remote_or_credentialed_endpoints_are_rejected() {
        for candidate in [
            "http://10.0.0.5:49374",
            "http://example.com:49374",
            "https://127.0.0.1:49374",
            "http://opencode:secret@127.0.0.1:49374",
        ] {
            assert!(ensure_loopback(&url(candidate)).is_err(), "{candidate}");
        }
        // A lookalike host must not pass the loopback check.
        assert!(!is_loopback_host("127.0.0.1.example.com"));
    }

    #[test]
    fn registration_parsing_keeps_the_secret_private() {
        let raw = r#"{"id":"svc_1","version":"2.0.23","url":"http://127.0.0.1:49374","pid":4104,"password":"pw-value"}"#;
        let registration = parse_registration(raw).expect("registration");
        assert_eq!(registration.version.as_deref(), Some("2.0.23"));
        assert_eq!(registration.pid, Some(4104));
        assert_eq!(
            registration.identity(),
            "svc_1|2.0.23|http://127.0.0.1:49374|4104"
        );
        let rendered = format!("{:?}", registration);
        assert!(!rendered.contains("pw-value"), "secret leaked in Debug");
    }

    #[test]
    fn registration_without_endpoint_is_rejected() {
        assert!(parse_registration("{}").is_err());
        assert!(parse_registration("not json").is_err());
    }

    #[test]
    fn identity_mismatch_is_reported() {
        let registration = Registration {
            id: None,
            version: Some("2.0.23".to_string()),
            url: "http://127.0.0.1:1".to_string(),
            pid: Some(10),
            secret: None,
        };
        let good = ServiceInfo {
            version: "2.0.23".to_string(),
            pid: 10,
        };
        assert!(verify_identity(&registration, &good).is_ok());
        let moved = ServiceInfo {
            version: "2.0.23".to_string(),
            pid: 11,
        };
        assert_eq!(
            verify_identity(&registration, &moved).unwrap_err().code,
            "incompatible"
        );
        let upgraded = ServiceInfo {
            version: "2.0.24".to_string(),
            pid: 10,
        };
        assert_eq!(
            verify_identity(&registration, &upgraded).unwrap_err().code,
            "versionMismatch"
        );
    }

    #[test]
    fn approved_path_is_matched_case_insensitively() {
        assert!(is_approved_registration(Path::new(
            "C:\\Users\\burak\\.local\\state\\opencode\\service.json"
        )));
        assert!(is_approved_registration(Path::new(
            "C:/Users/burak/.local/state/opencode/service.json"
        )));
        assert!(!is_approved_registration(Path::new(
            "C:\\Users\\burak\\.config\\opencode\\service.json"
        )));
    }

    #[test]
    fn state_home_resolution_matches_the_client() {
        let from_home =
            registration_path_from(None, Some(PathBuf::from("C:\\Users\\x"))).expect("path");
        assert!(from_home.ends_with("opencode\\service.json"));
        assert!(from_home.to_string_lossy().contains(".local\\state"));
        let from_state = registration_path_from(
            Some(PathBuf::from("D:\\state")),
            Some(PathBuf::from("C:\\Users\\x")),
        )
        .expect("path");
        assert!(from_state.to_string_lossy().starts_with("D:\\state"));
        assert!(registration_path_from(None, None).is_err());
    }
}
