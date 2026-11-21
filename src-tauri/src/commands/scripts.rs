//! Main native webview only; all filesystem/process work runs off the async executor.
use crate::scripts::{
    SavedScript, ScriptInput, ScriptOutput, ScriptRun, ScriptsHost, ScriptsSnapshot,
};
use std::sync::Arc;
use tauri::{State, WebviewWindow};

fn allowed_origin(url: &tauri::Url) -> bool {
    let native =
        (url.scheme() == "tauri" && url.host_str() == Some("localhost") && url.port().is_none())
            || (matches!(url.scheme(), "http" | "https")
                && url.host_str() == Some("tauri.localhost")
                && url.port().is_none());
    let debug = cfg!(debug_assertions)
        && url.scheme() == "http"
        && url.host_str() == Some("localhost")
        && url.port() == Some(1421);
    (native || debug) && url.username().is_empty() && url.password().is_none()
}
fn require_main(window: &WebviewWindow) -> Result<(), String> {
    if window.label() != "main"
        || !allowed_origin(
            &window
                .url()
                .map_err(|_| "Cannot verify Scripts caller origin")?,
        )
    {
        return Err("Scripts is available only to the local main TABS webview".into());
    }
    Ok(())
}
async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| format!("Scripts operation failed: {e}"))?
}
#[tauri::command]
pub async fn scripts_snapshot(
    window: WebviewWindow,
    host: State<'_, Arc<ScriptsHost>>,
) -> Result<ScriptsSnapshot, String> {
    require_main(&window)?;
    let h = host.inner().clone();
    blocking(move || h.snapshot()).await
}
#[tauri::command]
pub async fn scripts_save(
    window: WebviewWindow,
    host: State<'_, Arc<ScriptsHost>>,
    input: ScriptInput,
    id: Option<String>,
    expected_revision: Option<u64>,
) -> Result<SavedScript, String> {
    require_main(&window)?;
    let h = host.inner().clone();
    blocking(move || h.save(input, id, expected_revision)).await
}
#[tauri::command]
pub async fn scripts_duplicate(
    window: WebviewWindow,
    host: State<'_, Arc<ScriptsHost>>,
    id: String,
) -> Result<SavedScript, String> {
    require_main(&window)?;
    let h = host.inner().clone();
    blocking(move || h.duplicate(&id)).await
}
#[tauri::command]
pub async fn scripts_delete(
    window: WebviewWindow,
    host: State<'_, Arc<ScriptsHost>>,
    id: String,
    expected_revision: u64,
) -> Result<(), String> {
    require_main(&window)?;
    let h = host.inner().clone();
    blocking(move || h.delete(&id, expected_revision)).await
}
#[tauri::command]
pub async fn scripts_start(
    window: WebviewWindow,
    host: State<'_, Arc<ScriptsHost>>,
    id: String,
    expected_revision: u64,
    request_id: String,
    confirmed: bool,
) -> Result<ScriptRun, String> {
    require_main(&window)?;
    let h = host.inner().clone();
    blocking(move || h.start(&id, expected_revision, &request_id, confirmed)).await
}
#[tauri::command]
pub async fn scripts_cancel(
    window: WebviewWindow,
    host: State<'_, Arc<ScriptsHost>>,
    run_id: String,
) -> Result<ScriptRun, String> {
    require_main(&window)?;
    let h = host.inner().clone();
    blocking(move || h.cancel(&run_id)).await
}
#[tauri::command]
pub async fn scripts_output(
    window: WebviewWindow,
    host: State<'_, Arc<ScriptsHost>>,
    run_id: String,
) -> Result<ScriptOutput, String> {
    require_main(&window)?;
    let h = host.inner().clone();
    blocking(move || h.output(&run_id)).await
}
#[cfg(test)]
mod tests {
    #[test]
    fn scripts_origin_is_exact() {
        for url in [
            "tauri://localhost/index.html",
            "http://tauri.localhost/",
            "https://tauri.localhost/",
        ] {
            assert!(super::allowed_origin(&url.parse().unwrap()));
        }
        for url in [
            "https://example.com/",
            "http://localhost:1422/",
            "https://tauri.localhost.evil/",
            "http://tauri.localhost:8000/",
            "file:///C:/foo",
            "tauri://evil/",
            "http://user@tauri.localhost/",
        ] {
            assert!(!super::allowed_origin(&url.parse().unwrap()));
        }
    }
}
