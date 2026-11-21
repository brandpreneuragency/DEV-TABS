//! Tauri commands for the native OpenCode V2 transport.
//!
//! Registration is owned by the parent integration:
//!
//! ```ignore
//! // lib.rs
//! mod open_code;
//! mod commands;
//!
//! .setup(|app| {
//!     let host = commands::open_code::create_host(app.handle())?;
//!     app.manage(host);
//!     Ok(())
//! })
//! .invoke_handler(tauri::generate_handler![
//!     commands::open_code::open_code_status,
//!     // ...
//! ])
//! ```
//!
//! Every command is main-window only. The host is shared through
//! `State<Arc<Host>>`; ownership is verified inside the host and never by the
//! caller.

use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};

use crate::open_code::events;
use crate::open_code::{
    AgentSummary, EventSink, FormSummary, Host, InboxAdmission, MessageView, ModelRefView,
    ModelSummary, OpenCodeError, OpenCodeEventKind, OpenCodeResult, PermissionSummary,
    RebindOutcome, SessionDetail, Status,
};

/// Event channel used by every transport event.
pub const EVENT_CHANNEL: &str = "open_code://event";

/// Build the host. The parent registers it with `app.manage(create_host(app)?)`.
///
/// The workspace lives in app-local data, not in a temporary directory, because
/// the directory is durable session metadata.
pub fn create_host(app: &AppHandle) -> OpenCodeResult<Arc<Host>> {
    let base = app.path().app_local_data_dir().map_err(|_| {
        OpenCodeError::new("internal", "TABS local data directory is not available")
    })?;
    let workspace = base.join("opencode").join("workspace");
    let handle = app.clone();
    let sink: EventSink = Box::new(move |event: OpenCodeEventKind| {
        let _ = handle.emit_to("main", EVENT_CHANNEL, event);
    });
    Ok(Arc::new(Host::new(workspace, sink)?))
}

fn require_main_window(window: &WebviewWindow) -> OpenCodeResult<()> {
    if window.label() == "main" {
        Ok(())
    } else {
        Err(OpenCodeError::new(
            "invalid_argument",
            "OpenCode is available only to the main TABS window",
        ))
    }
}

/// Suspension primitive for the reconnect loop. It uses the blocking pool so an
/// async worker is never stalled.
fn pause() -> events::Pause {
    Arc::new(|millis: u64| {
        Box::pin(async move {
            let handle = tauri::async_runtime::spawn_blocking(move || {
                std::thread::sleep(Duration::from_millis(millis));
            });
            let _ = handle.await;
        }) as Pin<Box<dyn std::future::Future<Output = ()> + Send>>
    })
}

#[tauri::command]
pub fn open_code_status(
    window: WebviewWindow,
    host: State<'_, Arc<Host>>,
) -> OpenCodeResult<Status> {
    require_main_window(&window)?;
    Ok(host.status())
}

#[tauri::command]
pub async fn open_code_discover(
    window: WebviewWindow,
    host: State<'_, Arc<Host>>,
) -> OpenCodeResult<Status> {
    require_main_window(&window)?;
    let host = Arc::clone(&host);
    host.discover().await
}

#[tauri::command]
pub async fn open_code_list_models(
    window: WebviewWindow,
    host: State<'_, Arc<Host>>,
) -> OpenCodeResult<Vec<ModelSummary>> {
    require_main_window(&window)?;
    let host = Arc::clone(&host);
    host.list_models().await
}

#[tauri::command]
pub async fn open_code_list_agents(
    window: WebviewWindow,
    host: State<'_, Arc<Host>>,
) -> OpenCodeResult<Vec<AgentSummary>> {
    require_main_window(&window)?;
    let host = Arc::clone(&host);
    host.list_agents().await
}

#[tauri::command]
pub async fn open_code_create_session(
    window: WebviewWindow,
    host: State<'_, Arc<Host>>,
    thread_id: String,
    title: Option<String>,
    model: Option<ModelRefView>,
    agent: Option<String>,
) -> OpenCodeResult<SessionDetail> {
    require_main_window(&window)?;
    let host = Arc::clone(&host);
    host.create_session(
        &thread_id,
        title.as_deref(),
        model.as_ref(),
        agent.as_deref(),
    )
    .await
}

#[tauri::command]
pub async fn open_code_rebind_sessions(
    window: WebviewWindow,
    host: State<'_, Arc<Host>>,
    session_ids: Vec<String>,
) -> OpenCodeResult<Vec<RebindOutcome>> {
    require_main_window(&window)?;
    let host = Arc::clone(&host);
    Ok(host.rebind_sessions(session_ids).await)
}

#[tauri::command]
pub async fn open_code_get_session(
    window: WebviewWindow,
    host: State<'_, Arc<Host>>,
    session_id: String,
) -> OpenCodeResult<SessionDetail> {
    require_main_window(&window)?;
    let host = Arc::clone(&host);
    host.get_session(&session_id).await
}

#[tauri::command]
pub async fn open_code_get_messages(
    window: WebviewWindow,
    host: State<'_, Arc<Host>>,
    session_id: String,
) -> OpenCodeResult<Vec<MessageView>> {
    require_main_window(&window)?;
    let host = Arc::clone(&host);
    host.get_messages(&session_id).await
}

#[tauri::command]
pub async fn open_code_prompt(
    window: WebviewWindow,
    host: State<'_, Arc<Host>>,
    session_id: String,
    admission_id: String,
    text: String,
) -> OpenCodeResult<InboxAdmission> {
    require_main_window(&window)?;
    let host = Arc::clone(&host);
    host.prompt(&session_id, &admission_id, &text).await
}

#[tauri::command]
pub async fn open_code_interrupt(
    window: WebviewWindow,
    host: State<'_, Arc<Host>>,
    session_id: String,
) -> OpenCodeResult<bool> {
    require_main_window(&window)?;
    let host = Arc::clone(&host);
    host.interrupt(&session_id).await
}

#[tauri::command]
pub async fn open_code_switch_model(
    window: WebviewWindow,
    host: State<'_, Arc<Host>>,
    session_id: String,
    model: ModelRefView,
) -> OpenCodeResult<()> {
    require_main_window(&window)?;
    let host = Arc::clone(&host);
    host.switch_model(&session_id, &model).await
}

#[tauri::command]
pub async fn open_code_switch_agent(
    window: WebviewWindow,
    host: State<'_, Arc<Host>>,
    session_id: String,
    agent: String,
) -> OpenCodeResult<()> {
    require_main_window(&window)?;
    let host = Arc::clone(&host);
    host.switch_agent(&session_id, &agent).await
}

#[tauri::command]
pub async fn open_code_list_forms(
    window: WebviewWindow,
    host: State<'_, Arc<Host>>,
    session_id: String,
) -> OpenCodeResult<Vec<FormSummary>> {
    require_main_window(&window)?;
    let host = Arc::clone(&host);
    host.list_forms(&session_id).await
}

#[tauri::command]
pub async fn open_code_reply_form(
    window: WebviewWindow,
    host: State<'_, Arc<Host>>,
    session_id: String,
    form_id: String,
    answer: serde_json::Value,
) -> OpenCodeResult<()> {
    require_main_window(&window)?;
    let host = Arc::clone(&host);
    host.reply_form(&session_id, &form_id, answer).await
}

#[tauri::command]
pub async fn open_code_list_permissions(
    window: WebviewWindow,
    host: State<'_, Arc<Host>>,
    session_id: String,
) -> OpenCodeResult<Vec<PermissionSummary>> {
    require_main_window(&window)?;
    let host = Arc::clone(&host);
    host.list_permissions(&session_id).await
}

#[tauri::command]
pub async fn open_code_reply_permission(
    window: WebviewWindow,
    host: State<'_, Arc<Host>>,
    session_id: String,
    request_id: String,
    decision: String,
    message: Option<String>,
) -> OpenCodeResult<()> {
    require_main_window(&window)?;
    let host = Arc::clone(&host);
    host.reply_permission(&session_id, &request_id, &decision, message.as_deref())
        .await
}

#[tauri::command]
pub async fn open_code_delete_session(
    window: WebviewWindow,
    host: State<'_, Arc<Host>>,
    session_id: String,
) -> OpenCodeResult<()> {
    require_main_window(&window)?;
    let host = Arc::clone(&host);
    host.delete_session(&session_id).await
}

/// Start the shared event subscription. Idempotent while a subscription exists.
#[tauri::command]
pub async fn open_code_subscribe(
    window: WebviewWindow,
    host: State<'_, Arc<Host>>,
) -> OpenCodeResult<Status> {
    require_main_window(&window)?;
    let host = Arc::clone(&host);
    if host.begin_stream() {
        let runner = Arc::clone(&host);
        tauri::async_runtime::spawn(async move {
            events::run(runner, pause()).await;
        });
    }
    Ok(host.status())
}

/// Stop the shared event subscription and return the settled status.
#[tauri::command]
pub fn open_code_unsubscribe(
    window: WebviewWindow,
    host: State<'_, Arc<Host>>,
) -> OpenCodeResult<Status> {
    require_main_window(&window)?;
    host.end_stream();
    Ok(host.status())
}

#[tauri::command]
pub async fn open_code_tool_start(
    window: WebviewWindow,
    host: State<'_, Arc<Host>>,
) -> OpenCodeResult<()> {
    require_main_window(&window)?;
    let handle = window.app_handle().clone();
    let sink: crate::tab_bridge::ToolSink = Arc::new(move |request| {
        let _ = handle.emit_to("main", "open_code://tool", request);
    });
    crate::tab_bridge::start(Arc::clone(&host), sink).await
}

#[tauri::command]
pub async fn open_code_tool_bind(
    window: WebviewWindow,
    host: State<'_, Arc<Host>>,
    session_id: String,
    admission_id: String,
    tools: Vec<crate::tab_bridge::ToolSpec>,
) -> OpenCodeResult<()> {
    require_main_window(&window)?;
    crate::tab_bridge::bind(Arc::clone(&host), session_id, admission_id, tools).await
}

#[tauri::command]
pub fn open_code_tool_complete(
    window: WebviewWindow,
    host: State<'_, Arc<Host>>,
    request_id: String,
    result: serde_json::Value,
) -> OpenCodeResult<()> {
    require_main_window(&window)?;
    let bridge = host
        .bridge
        .lock()
        .ok()
        .and_then(|slot| slot.clone())
        .ok_or_else(|| OpenCodeError::unavailable("TABS tool bridge is disconnected"))?;
    bridge.complete(&request_id, result)
}

#[tauri::command]
pub async fn open_code_tool_validate(
    window: WebviewWindow,
    host: State<'_, Arc<Host>>,
    request_id: String,
) -> OpenCodeResult<()> {
    require_main_window(&window)?;
    let bridge = host
        .bridge
        .lock()
        .ok()
        .and_then(|slot| slot.clone())
        .ok_or_else(|| OpenCodeError::unavailable("TABS tool bridge is disconnected"))?;
    bridge.validate(&host, &request_id).await
}

#[tauri::command]
pub fn open_code_tool_stop(
    window: WebviewWindow,
    host: State<'_, Arc<Host>>,
) -> OpenCodeResult<()> {
    require_main_window(&window)?;
    crate::tab_bridge::stop(&host);
    Ok(())
}
