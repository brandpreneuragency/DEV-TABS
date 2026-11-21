//! HTTP transport for the local OpenCode V2 service.
//!
//! One async client is shared by every request and by the event stream.
//! Safety properties enforced here:
//!
//! * the endpoint must be loopback HTTP (checked in `discovery`),
//! * redirects are never followed, so the authorization header cannot be
//!   forwarded to another origin,
//! * the password is only used to build one request header and never appears
//!   in an error, a URL, or a log line,
//! * every response body is size-checked before it is parsed.

use std::time::Duration;

use base64::Engine;
use reqwest::{Client, Method, StatusCode, Url};
use serde_json::Value;

use super::discovery::{ensure_loopback, AUTH_USER};
use super::types::{OpenCodeError, OpenCodeResult, ServiceInfo, ServiceSecret, MAX_BODY_BYTES};

pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
/// Bounds a stalled read on every request, including the event stream, so a
/// blocking wait can never hang without a limit.
pub const READ_TIMEOUT: Duration = Duration::from_secs(45);
pub const INFO_TIMEOUT: Duration = Duration::from_secs(8);
pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);
pub const CONTEXT_TIMEOUT: Duration = Duration::from_secs(30);
pub const PROMPT_TIMEOUT: Duration = Duration::from_secs(30);

/// A verified connection to one service instance.
#[derive(Clone)]
pub struct ServiceSession {
    endpoint: Url,
    secret: Option<ServiceSecret>,
    /// Registration identity, used to detect a restarted or moved service.
    identity: String,
    declared_version: Option<String>,
}

impl std::fmt::Debug for ServiceSession {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ServiceSession")
            .field("endpoint", &self.endpoint.as_str())
            .field("identity", &self.identity)
            .finish_non_exhaustive()
    }
}

impl ServiceSession {
    pub fn new(
        endpoint: Url,
        secret: Option<ServiceSecret>,
        identity: String,
        declared_version: Option<String>,
    ) -> OpenCodeResult<Self> {
        ensure_loopback(&endpoint)?;
        Ok(Self {
            endpoint,
            secret,
            identity,
            declared_version,
        })
    }

    pub fn identity(&self) -> &str {
        &self.identity
    }

    pub fn declared_version(&self) -> Option<&str> {
        self.declared_version.as_deref()
    }

    fn authorization(&self) -> Option<reqwest::header::HeaderValue> {
        let secret = self.secret.as_ref()?;
        if secret.is_empty() {
            return None;
        }
        let encoded = base64::engine::general_purpose::STANDARD
            .encode(format!("{AUTH_USER}:{}", secret.expose()));
        let mut header =
            reqwest::header::HeaderValue::from_str(&format!("Basic {encoded}")).ok()?;
        header.set_sensitive(true);
        Some(header)
    }

    fn url(&self, path: &str, query: &[(&str, String)]) -> OpenCodeResult<Url> {
        let mut url = self
            .endpoint
            .join(path.trim_start_matches('/'))
            .map_err(|_| OpenCodeError::new("incompatible", "OpenCode endpoint path is invalid"))?;
        if !query.is_empty() {
            let mut pairs = url.query_pairs_mut();
            for (key, value) in query {
                pairs.append_pair(key, value);
            }
        }
        Ok(url)
    }

    /// Send one request and return the decoded JSON body.
    ///
    /// Non-2xx responses become typed errors. No response body is included in
    /// an authentication error.
    pub async fn request(
        &self,
        client: &Client,
        method: Method,
        path: &str,
        query: &[(&str, String)],
        body: Option<&Value>,
        timeout: Duration,
    ) -> OpenCodeResult<Value> {
        let url = self.url(path, query)?;
        let mut request = client
            .request(method, url)
            .timeout(timeout)
            .header(reqwest::header::ACCEPT, "application/json");
        if let Some(authorization) = self.authorization() {
            request = request.header(reqwest::header::AUTHORIZATION, authorization);
        }
        if let Some(body) = body {
            request = request.header(reqwest::header::CONTENT_TYPE, "application/json");
            request = request.body(serde_json::to_vec(body).map_err(|_| {
                OpenCodeError::new(
                    "invalid_argument",
                    "OpenCode request body is not serializable",
                )
            })?);
        }
        let mut response = request.send().await.map_err(transport_error)?;
        let status = response.status();
        if status == StatusCode::UNAUTHORIZED || status == StatusCode::FORBIDDEN {
            return Err(OpenCodeError::unauthorized());
        }
        if let Some(length) = response.content_length() {
            if length > MAX_BODY_BYTES as u64 {
                return Err(OpenCodeError::new(
                    "protocol",
                    "OpenCode service response is too large",
                ));
            }
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(transport_error)? {
            if bytes.len().saturating_add(chunk.len()) > MAX_BODY_BYTES {
                return Err(OpenCodeError::new(
                    "protocol",
                    "OpenCode service response is too large",
                ));
            }
            bytes.extend_from_slice(&chunk);
        }
        let value = if bytes.is_empty() {
            Value::Null
        } else {
            serde_json::from_slice(&bytes).map_err(|_| {
                OpenCodeError::new("protocol", "OpenCode service returned a malformed response")
            })?
        };
        if status.is_success() {
            Ok(value)
        } else {
            Err(status_error(status, &value))
        }
    }

    /// Build the long-lived event-stream request.
    ///
    /// No total timeout is set: the stream is expected to stay open. The shared
    /// client applies [`READ_TIMEOUT`] to each read, so a stalled stream cannot
    /// wait forever and the reader observes its stop token within one bound.
    pub fn stream_request(&self, client: &Client) -> OpenCodeResult<reqwest::RequestBuilder> {
        let url = self.url("api/event", &[])?;
        let mut request = client
            .get(url)
            .header(reqwest::header::ACCEPT, "text/event-stream")
            .header(reqwest::header::CACHE_CONTROL, "no-cache");
        if let Some(authorization) = self.authorization() {
            request = request.header(reqwest::header::AUTHORIZATION, authorization);
        }
        Ok(request)
    }

    /// Read the verified health payload.
    pub async fn info(&self, client: &Client) -> OpenCodeResult<ServiceInfo> {
        let value = self
            .request(client, Method::GET, "api/info", &[], None, INFO_TIMEOUT)
            .await?;
        let version = value
            .get("version")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|version| !version.is_empty())
            .ok_or_else(|| {
                OpenCodeError::new("incompatible", "OpenCode service does not report a version")
            })?;
        let pid = value
            .get("pid")
            .and_then(Value::as_u64)
            .and_then(|pid| u32::try_from(pid).ok())
            .ok_or_else(|| {
                OpenCodeError::new(
                    "incompatible",
                    "OpenCode service does not report a process id",
                )
            })?;
        Ok(ServiceInfo {
            version: version.to_string(),
            pid,
        })
    }
}

/// Build the shared HTTP client.
///
/// `redirect::Policy::none()` is deliberate: a redirect must never receive the
/// authorization header, and a local service never needs one.
pub fn client() -> OpenCodeResult<Client> {
    Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(CONNECT_TIMEOUT)
        .read_timeout(READ_TIMEOUT)
        .user_agent("TABS-OpenCode-Transport/1")
        .build()
        .map_err(|_| OpenCodeError::new("internal", "OpenCode HTTP client could not be created"))
}

/// The `data` envelope used by the V2 service for single objects.
pub fn data_of(value: &Value) -> Option<&Value> {
    value.get("data").or(Some(value))
}

fn transport_error(error: reqwest::Error) -> OpenCodeError {
    // `reqwest::Error` can include the request URL. It never includes request
    // headers, but it is still not echoed: only a classified message is used.
    if error.is_timeout() {
        OpenCodeError::new("transport", "OpenCode service did not answer in time")
    } else if error.is_connect() {
        OpenCodeError::new("not_running", "OpenCode service is not reachable")
    } else if error.is_decode() {
        OpenCodeError::new("protocol", "OpenCode service returned a malformed response")
    } else {
        OpenCodeError::new("transport", "OpenCode request failed")
    }
}

/// Map the documented error envelope to a stable code.
fn status_error(status: StatusCode, body: &Value) -> OpenCodeError {
    let tag = body.get("_tag").and_then(Value::as_str).unwrap_or_default();
    // RPC failures can echo bootstrap input, including the native bridge token.
    // Never expose arbitrary service messages to the renderer or logs.
    let fallback = |text: &'static str| text.to_string();
    match tag {
        "UnauthorizedError" => OpenCodeError::unauthorized(),
        "SessionNotFoundError" => OpenCodeError::new("not_found", fallback("Session not found")),
        "MessageNotFoundError" => OpenCodeError::new("not_found", fallback("Message not found")),
        "FormNotFoundError" => OpenCodeError::new("not_found", fallback("Form not found")),
        "PermissionNotFoundError" => {
            OpenCodeError::new("not_found", fallback("Permission request not found"))
        }
        "ConflictError" => OpenCodeError::new("conflict", fallback("OpenCode request conflicts")),
        "FormAlreadySettledError" => {
            OpenCodeError::new("conflict", fallback("Form has already been answered"))
        }
        "SessionBusyError" => OpenCodeError::new("busy", fallback("Session is busy")),
        "LocationNotFoundError" => {
            OpenCodeError::new("invalid_argument", fallback("Location not found"))
        }
        "FormInvalidAnswerError" => {
            OpenCodeError::new("invalid_argument", fallback("Form answer is not valid"))
        }
        _ if status == StatusCode::NOT_FOUND => {
            OpenCodeError::new("not_found", fallback("OpenCode resource not found"))
        }
        _ if status == StatusCode::CONFLICT => {
            OpenCodeError::new("conflict", fallback("OpenCode request conflicts"))
        }
        _ if status == StatusCode::SERVICE_UNAVAILABLE => {
            OpenCodeError::unavailable(fallback("OpenCode service is starting"))
        }
        _ if status.is_server_error() => {
            OpenCodeError::new("transport", fallback("OpenCode service failed the request"))
        }
        _ => OpenCodeError::new(
            "invalid_argument",
            fallback("OpenCode rejected the request"),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn authorization_header_uses_the_documented_user() {
        let session = ServiceSession::new(
            Url::parse("http://127.0.0.1:49374").expect("url"),
            Some(ServiceSecret::new("pw".to_string())),
            "identity".to_string(),
            None,
        )
        .expect("session");
        let header = session.authorization().expect("header");
        assert!(header.is_sensitive());
        assert!(!format!("{header:?}").contains("Basic"));
        let header = header.to_str().expect("header text");
        assert!(header.starts_with("Basic "));
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(header.trim_start_matches("Basic "))
            .expect("base64");
        assert_eq!(String::from_utf8(decoded).expect("utf8"), "opencode:pw");
        assert!(
            !format!("{session:?}").contains("pw\""),
            "secret leaked in Debug"
        );
    }

    #[test]
    fn missing_password_sends_no_authorization() {
        let session = ServiceSession::new(
            Url::parse("http://127.0.0.1:49374").expect("url"),
            None,
            "identity".to_string(),
            None,
        )
        .expect("session");
        assert!(session.authorization().is_none());
    }

    #[test]
    fn non_loopback_session_is_rejected_at_construction() {
        assert!(ServiceSession::new(
            Url::parse("http://example.com:49374").expect("url"),
            None,
            "identity".to_string(),
            None,
        )
        .is_err());
    }

    #[test]
    fn query_pairs_are_encoded_once() {
        let session = ServiceSession::new(
            Url::parse("http://127.0.0.1:49374/").expect("url"),
            None,
            "identity".to_string(),
            None,
        )
        .expect("session");
        let url = session
            .url(
                "/api/message",
                &[
                    ("sessionID", "ses 1".to_string()),
                    ("limit", "50".to_string()),
                ],
            )
            .expect("url");
        assert_eq!(url.path(), "/api/message");
        assert!(url.query().expect("query").contains("sessionID=ses+1"));
    }

    #[test]
    fn documented_errors_map_to_stable_codes() {
        let cases = [
            (
                "UnauthorizedError",
                StatusCode::UNAUTHORIZED,
                "unauthorized",
            ),
            ("SessionNotFoundError", StatusCode::NOT_FOUND, "not_found"),
            ("SessionBusyError", StatusCode::CONFLICT, "busy"),
            ("FormAlreadySettledError", StatusCode::CONFLICT, "conflict"),
            (
                "LocationNotFoundError",
                StatusCode::BAD_REQUEST,
                "invalid_argument",
            ),
            ("UnknownError", StatusCode::BAD_GATEWAY, "transport"),
            ("UnknownError", StatusCode::BAD_REQUEST, "invalid_argument"),
        ];
        for (tag, status, expected) in cases {
            let body = json!({ "_tag": tag, "message": "detail" });
            assert_eq!(status_error(status, &body).code, expected, "{tag}");
        }
    }

    #[test]
    fn auth_error_never_carries_the_server_message() {
        let body = json!({ "_tag": "UnauthorizedError", "message": "password pw is wrong" });
        let error = status_error(StatusCode::UNAUTHORIZED, &body);
        assert_eq!(error.message, OpenCodeError::unauthorized().message);
    }

    #[test]
    fn rpc_errors_never_echo_credentials_or_inputs_to_ipc() {
        for status in [
            StatusCode::BAD_REQUEST,
            StatusCode::CONFLICT,
            StatusCode::INTERNAL_SERVER_ERROR,
        ] {
            let error = status_error(
                status,
                &json!({"_tag":"InvalidRequestError", "message":"synthetic-private-token"}),
            );
            assert!(!error.message.contains("synthetic-private-token"));
        }
    }
}
