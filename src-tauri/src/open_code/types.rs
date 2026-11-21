//! Typed transport DTOs for the local OpenCode V2 service.
//!
//! Everything that crosses the Tauri IPC boundary is defined here, is
//! `Serialize`, and is bounded. Raw server payloads are parsed into these
//! shapes so that unknown or oversized server data cannot reach the WebView.
//! Service credentials never appear in any type in this module except
//! [`ServiceSecret`], which is not `Serialize` and prints as redacted.

use std::fmt;

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Maximum characters kept from one free-text field.
pub const MAX_TEXT_CHARS: usize = 100_000;
/// Maximum characters kept from one tool input or output payload.
pub const MAX_INPUT_CHARS: usize = 8_000;
/// Maximum content parts kept per assistant message.
pub const MAX_PARTS: usize = 200;
/// Maximum messages returned by one authoritative transcript read.
pub const MAX_MESSAGES: usize = 500;
/// Maximum models returned by one discovery call.
pub const MAX_MODELS: usize = 400;
/// Maximum sessions verified by one rebind call.
pub const MAX_REBIND: usize = 50;
/// Maximum bytes read from one non-streaming response body.
pub const MAX_BODY_BYTES: usize = 4 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/// Command error. Mirrors the existing `HostError` shape used by other
/// native features so the frontend keeps one error convention.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenCodeError {
    pub code: &'static str,
    pub message: String,
}

impl OpenCodeError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    pub fn unavailable(message: impl Into<String>) -> Self {
        Self::new("unavailable", message)
    }

    pub fn unauthorized() -> Self {
        Self::new(
            "unauthorized",
            "The OpenCode service rejected this connection",
        )
    }

    pub fn not_owned() -> Self {
        Self::new("not_owned", "This OpenCode session is not owned by TABS")
    }
}

impl fmt::Display for OpenCodeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for OpenCodeError {}

pub type OpenCodeResult<T> = Result<T, OpenCodeError>;

// ---------------------------------------------------------------------------
// Service secret
// ---------------------------------------------------------------------------

/// The service password read from the approved registration file.
///
/// The value is held in memory only. It is not `Serialize`, not `Clone` to the
/// frontend, and its `Debug` output is redacted so an accidental log or panic
/// message cannot leak it.
#[derive(Clone, PartialEq, Eq)]
pub struct ServiceSecret(String);

impl ServiceSecret {
    pub fn new(value: String) -> Self {
        Self(value)
    }

    /// Used only to build the HTTP authorization header.
    pub(crate) fn expose(&self) -> &str {
        &self.0
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

impl fmt::Debug for ServiceSecret {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("ServiceSecret(<redacted>)")
    }
}

// ---------------------------------------------------------------------------
// Connection status
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ConnectionState {
    /// No registration file, no service, or the service is not reachable.
    Unavailable,
    /// The service answered but rejected the connection.
    Unauthorized,
    /// The registered service reports a different version than it declared.
    VersionMismatch,
    /// The service speaks an incompatible protocol.
    Incompatible,
    /// Discovery and verification succeeded.
    Connected,
    /// The event stream dropped or a request failed; reconnect is in progress.
    Degraded,
}

impl ConnectionState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Unavailable => "unavailable",
            Self::Unauthorized => "unauthorized",
            Self::VersionMismatch => "versionMismatch",
            Self::Incompatible => "incompatible",
            Self::Connected => "connected",
            Self::Degraded => "degraded",
        }
    }

    pub fn is_usable(self) -> bool {
        matches!(self, Self::Connected | Self::Degraded)
    }
}

/// Sanitized connection status. Contains no endpoint credential and no secret.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub state: ConnectionState,
    /// Increments only when the service identity changes.
    pub generation: u64,
    pub version: Option<String>,
    pub pid: Option<u32>,
    /// TABS-owned workspace directory used as the OpenCode location.
    pub workspace: String,
    /// True while a TABS event subscription is active.
    pub streaming: bool,
    /// Short, non-sensitive explanation for a non-connected state.
    pub detail: Option<String>,
}

/// Verified health payload from `GET /api/info`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServiceInfo {
    pub version: String,
    pub pid: u32,
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelRefView {
    pub id: String,
    pub provider_id: String,
    pub variant: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionDetail {
    pub id: String,
    pub project_id: String,
    pub title: Option<String>,
    pub agent: Option<String>,
    pub model: Option<ModelRefView>,
    pub outcome: Option<String>,
    pub directory: String,
    pub created: f64,
    pub updated: f64,
    /// TABS thread marker from durable session metadata.
    pub thread_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RebindOutcome {
    pub session_id: String,
    pub owned: bool,
    pub reason: Option<String>,
    pub session: Option<SessionDetail>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InboxAdmission {
    pub id: String,
    pub session_id: String,
    pub created: f64,
    pub delivery: Option<String>,
}

// ---------------------------------------------------------------------------
// Catalogs
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelSummary {
    pub id: String,
    pub provider_id: String,
    pub model_id: String,
    pub name: String,
    pub family: Option<String>,
    pub enabled: bool,
    pub tools: bool,
    pub context_limit: Option<i64>,
    pub output_limit: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSummary {
    pub id: String,
    pub name: String,
    pub mode: String,
    pub description: Option<String>,
    pub hidden: bool,
    pub model: Option<ModelRefView>,
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageError {
    pub kind: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolPart {
    pub id: String,
    pub name: String,
    pub status: String,
    pub input: Option<String>,
    pub output: Option<String>,
    pub error: Option<MessageError>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MessagePart {
    pub kind: String,
    pub text: Option<String>,
    pub tool: Option<ToolPart>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageView {
    pub id: String,
    pub session_id: String,
    /// `user`, `assistant`, `system`, `idle`, `synthetic`, `skill`, `shell`,
    /// `compaction`, `agent-switched`, `model-switched`, `location-switched`.
    pub kind: String,
    pub created: f64,
    pub completed: Option<f64>,
    pub agent: Option<String>,
    pub model: Option<ModelRefView>,
    pub finish: Option<String>,
    /// Flattened assistant text, or the user text, or the system text.
    pub text: Option<String>,
    pub parts: Vec<MessagePart>,
    pub error: Option<MessageError>,
    /// System notice identifier, for example `instructions`.
    pub notice: Option<String>,
}

// ---------------------------------------------------------------------------
// Forms and permissions
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FormOptionView {
    pub value: String,
    pub label: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FormFieldView {
    pub key: String,
    /// `string`, `number`, `integer`, `boolean`, `multiselect`, `external`.
    pub kind: String,
    pub title: Option<String>,
    pub description: Option<String>,
    pub required: bool,
    pub hidden: bool,
    pub options: Vec<FormOptionView>,
    /// Only set for an `external` field.
    pub url: Option<String>,
    /// Full bounded field definition, including defaults, conditions and limits.
    /// Frontend should use this schema when constructing FormField inputs.
    pub schema: Value,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FormSummary {
    pub id: String,
    pub session_id: String,
    pub title: String,
    /// Only pending forms are listed by the service.
    pub fields: Vec<FormFieldView>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionSummary {
    pub id: String,
    pub session_id: String,
    pub action: String,
    pub resources: Vec<String>,
    pub message: Option<String>,
}

// ---------------------------------------------------------------------------
// Streamed events
// ---------------------------------------------------------------------------

/// One bounded, owned-session event. Never carries foreign session content.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamEvent {
    pub session_id: String,
    /// Server event type, for example `session.text.delta`.
    pub kind: String,
    pub created: f64,
    pub assistant_message_id: Option<String>,
    /// Tool call or part identifier for part-scoped events.
    pub part_id: Option<String>,
    /// Durable sequence number when the server marks the event durable.
    pub seq: Option<i64>,
    pub delta: Option<String>,
    pub tool: Option<ToolPart>,
    pub error: Option<MessageError>,
    /// Status value for `session.status` (`idle`, `busy`, `retry`) or the
    /// interrupt reason for `session.execution.interrupted`.
    pub status: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "kind"
)]
pub enum OpenCodeEventKind {
    /// One event for a TABS-owned session.
    Stream { event: StreamEvent },
    /// Transport lifecycle change. Carries no session content.
    Lifecycle {
        state: ConnectionState,
        generation: u64,
        streaming: bool,
        detail: Option<String>,
    },
}

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

pub(crate) fn text(value: &Value) -> Option<String> {
    value.as_str().map(|value| value.to_string())
}

pub(crate) fn non_empty_text(value: &Value) -> Option<String> {
    value
        .as_str()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.to_string())
}

pub(crate) fn number(value: &Value) -> Option<f64> {
    value.as_f64()
}

pub(crate) fn integer(value: &Value) -> Option<i64> {
    value.as_i64()
}

/// Clamp one string to a character bound without splitting a code point.
pub(crate) fn clamp(value: &str, limit: usize) -> String {
    if value.chars().count() <= limit {
        return value.to_string();
    }
    let mut out = String::with_capacity(limit + 1);
    for character in value.chars().take(limit) {
        out.push(character);
    }
    out.push('\u{2026}');
    out
}

pub(crate) fn clamp_opt(value: Option<String>, limit: usize) -> Option<String> {
    value.map(|value| clamp(&value, limit))
}

pub(crate) fn json_text(value: &Value) -> Option<String> {
    if value.is_null() {
        return None;
    }
    let rendered = serde_json::to_string(value).ok()?;
    Some(clamp(&rendered, MAX_INPUT_CHARS))
}

pub(crate) fn model_ref(value: &Value) -> Option<ModelRefView> {
    let id = non_empty_text(value.get("id")?)?;
    let provider_id = non_empty_text(value.get("providerID")?)?;
    Some(ModelRefView {
        id,
        provider_id,
        variant: non_empty_text(value.get("variant").unwrap_or(&Value::Null)),
    })
}

pub(crate) fn error_view(value: &Value) -> Option<MessageError> {
    if !value.is_object() {
        return None;
    }
    let kind = non_empty_text(value.get("type").unwrap_or(&Value::Null))
        .or_else(|| non_empty_text(value.get("_tag").unwrap_or(&Value::Null)))
        .unwrap_or_else(|| "error".to_string());
    let message = non_empty_text(value.get("message").unwrap_or(&Value::Null))
        .unwrap_or_else(|| "The OpenCode service reported a failure".to_string());
    Some(MessageError {
        kind,
        message: clamp(&message, MAX_INPUT_CHARS),
    })
}

pub(crate) fn session_detail(value: &Value) -> Option<SessionDetail> {
    let id = non_empty_text(value.get("id")?)?;
    let project_id = non_empty_text(value.get("projectID")?)?;
    let directory = non_empty_text(value.get("location")?.get("directory")?)?;
    let time = value.get("time").cloned().unwrap_or(Value::Null);
    Some(SessionDetail {
        id,
        project_id,
        title: non_empty_text(value.get("title").unwrap_or(&Value::Null)),
        agent: non_empty_text(value.get("agent").unwrap_or(&Value::Null)),
        model: value.get("model").and_then(model_ref),
        outcome: non_empty_text(value.get("outcome").unwrap_or(&Value::Null)),
        directory,
        created: number(time.get("created").unwrap_or(&Value::Null)).unwrap_or(0.0),
        updated: number(time.get("updated").unwrap_or(&Value::Null)).unwrap_or(0.0),
        thread_id: non_empty_text(
            value
                .get("metadata")
                .and_then(|metadata| metadata.get("tabsThreadID"))
                .unwrap_or(&Value::Null),
        ),
    })
}

fn tool_part(value: &Value) -> Option<ToolPart> {
    let id = non_empty_text(value.get("id").unwrap_or(&Value::Null))?;
    let name = non_empty_text(value.get("name").unwrap_or(&Value::Null))
        .unwrap_or_else(|| "tool".to_string());
    let state = value.get("state").cloned().unwrap_or(Value::Null);
    let status = non_empty_text(state.get("status").unwrap_or(&Value::Null))
        .unwrap_or_else(|| "unknown".to_string());
    let input = state.get("input").and_then(json_text);
    let output = state.get("content").and_then(|content| {
        let parts = content.as_array()?;
        let joined = parts
            .iter()
            .filter_map(|part| {
                if part.get("type").and_then(Value::as_str) == Some("text") {
                    part.get("text").and_then(Value::as_str)
                } else {
                    None
                }
            })
            .collect::<Vec<_>>()
            .join("\n");
        if joined.is_empty() {
            None
        } else {
            Some(joined)
        }
    });
    Some(ToolPart {
        id,
        name,
        status,
        input,
        output: clamp_opt(output, MAX_INPUT_CHARS),
        error: state.get("error").and_then(error_view),
    })
}

fn parts_of(content: &Value) -> Vec<MessagePart> {
    let Some(items) = content.as_array() else {
        return Vec::new();
    };
    items
        .iter()
        .take(MAX_PARTS)
        .filter_map(|item| match item.get("type").and_then(Value::as_str) {
            Some("text") => Some(MessagePart {
                kind: "text".to_string(),
                text: clamp_opt(
                    text(item.get("text").unwrap_or(&Value::Null)),
                    MAX_TEXT_CHARS,
                ),
                tool: None,
            }),
            Some("reasoning") => Some(MessagePart {
                kind: "reasoning".to_string(),
                text: clamp_opt(
                    text(item.get("text").unwrap_or(&Value::Null)),
                    MAX_TEXT_CHARS,
                ),
                tool: None,
            }),
            Some("tool") => tool_part(item).map(|tool| MessagePart {
                kind: "tool".to_string(),
                text: None,
                tool: Some(tool),
            }),
            _ => None,
        })
        .collect()
}

/// Map one authoritative transcript item into a bounded view.
pub(crate) fn message_view(session_id: &str, value: &Value) -> Option<MessageView> {
    let id = non_empty_text(value.get("id")?)?;
    let kind = non_empty_text(value.get("type")?)?;
    let time = value.get("time").cloned().unwrap_or(Value::Null);
    let content = value.get("content").cloned().unwrap_or(Value::Null);
    let parts = parts_of(&content);
    let joined = parts
        .iter()
        .filter(|part| part.kind == "text")
        .filter_map(|part| part.text.as_deref())
        .collect::<Vec<_>>()
        .join("");
    let text_field = value
        .get("text")
        .and_then(Value::as_str)
        .map(|value| clamp(value, MAX_TEXT_CHARS));
    Some(MessageView {
        id,
        session_id: session_id.to_string(),
        kind,
        created: number(time.get("created").unwrap_or(&Value::Null)).unwrap_or(0.0),
        completed: number(time.get("completed").unwrap_or(&Value::Null)),
        agent: non_empty_text(value.get("agent").unwrap_or(&Value::Null)),
        model: value.get("model").and_then(model_ref),
        finish: non_empty_text(value.get("finish").unwrap_or(&Value::Null)),
        text: if joined.is_empty() {
            text_field
        } else {
            Some(clamp(&joined, MAX_TEXT_CHARS))
        },
        parts,
        error: value.get("error").and_then(error_view),
        notice: non_empty_text(
            value
                .get("metadata")
                .and_then(|metadata| metadata.get("notice"))
                .unwrap_or(&Value::Null),
        ),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn secret_debug_is_redacted() {
        let secret = ServiceSecret::new("super-secret-value".to_string());
        let rendered = format!("{secret:?}");
        assert!(rendered.contains("redacted"));
        assert!(!rendered.contains("super-secret-value"));
        assert!(!secret.is_empty());
    }

    #[test]
    fn clamp_respects_character_bound() {
        let value = "ab\u{1F600}cd";
        assert_eq!(clamp(value, 10), value);
        let bounded = clamp(value, 2);
        assert!(bounded.ends_with('\u{2026}'));
        assert_eq!(bounded.chars().count(), 3);
    }

    #[test]
    fn session_detail_reads_location_and_thread_marker() {
        let raw = json!({
            "id": "ses_1",
            "projectID": "proj",
            "title": "Thread",
            "agent": "build",
            "model": { "id": "m", "providerID": "p" },
            "time": { "created": 1.0, "updated": 2.0 },
            "location": { "directory": "C:\\ws" },
            "metadata": { "tabsThreadID": "t1", "other": "x" }
        });
        let detail = session_detail(&raw).expect("session");
        assert_eq!(detail.id, "ses_1");
        assert_eq!(detail.directory, "C:\\ws");
        assert_eq!(detail.thread_id.as_deref(), Some("t1"));
        assert_eq!(detail.model.expect("model").provider_id, "p");
    }

    #[test]
    fn assistant_message_flattens_text_and_tools() {
        let raw = json!({
            "id": "msg_1",
            "type": "assistant",
            "time": { "created": 5.0, "completed": 6.0 },
            "agent": "build",
            "model": { "id": "m", "providerID": "p" },
            "finish": "stop",
            "content": [
                { "type": "text", "text": "hello " },
                { "type": "text", "text": "world" },
                {
                    "type": "tool",
                    "id": "call_1",
                    "name": "read",
                    "state": {
                        "status": "completed",
                        "input": { "path": "a.md" },
                        "content": [{ "type": "text", "text": "body" }]
                    }
                }
            ]
        });
        let view = message_view("ses_1", &raw).expect("message");
        assert_eq!(view.text.as_deref(), Some("hello world"));
        assert_eq!(view.parts.len(), 3);
        let tool = view.parts[2].tool.clone().expect("tool part");
        assert_eq!(tool.name, "read");
        assert_eq!(tool.status, "completed");
        assert_eq!(tool.output.as_deref(), Some("body"));
        assert!(tool.input.expect("input").contains("a.md"));
    }

    #[test]
    fn aborted_assistant_message_keeps_aborted_error() {
        let raw = json!({
            "id": "msg_2",
            "type": "assistant",
            "time": { "created": 1.0 },
            "agent": "build",
            "model": { "id": "m", "providerID": "p" },
            "finish": "error",
            "error": { "type": "aborted", "message": "Step interrupted" },
            "content": []
        });
        let view = message_view("ses_1", &raw).expect("message");
        let error = view.error.expect("error");
        assert_eq!(error.kind, "aborted");
        assert_eq!(view.finish.as_deref(), Some("error"));
    }

    #[test]
    fn unknown_message_types_are_ignored() {
        assert!(message_view("ses_1", &json!({ "id": "msg_3" })).is_none());
    }
}
