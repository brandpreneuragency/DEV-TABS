//! Isolated Windows WebView acceptance. Never calls tabs_lib::run().
//! Start Vite separately, then compile/run this example with its dedicated config.
//! No task authority, accounts, updater, shell or generic filesystem IPC is registered.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[path = "../src/cli_providers/mod.rs"]
mod cli_providers;
#[path = "../src/codex/mod.rs"]
mod codex;
#[path = "../src/open_code/mod.rs"]
mod open_code;
#[path = "../src/commands/open_code.rs"]
mod open_code_commands;
#[path = "../src/commands/codex.rs"]
mod scoped_fs;
#[path = "../src/tab_bridge/mod.rs"]
mod tab_bridge;

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::{Manager, State, WebviewWindow, WebviewWindowBuilder};

const IDENTIFIER: &str = "com.tabs.opencode.acceptance";
const SCRATCH: &str = "C:/Users/burak/AppData/Local/Temp/opencode/tabs-opencode-acceptance";
const MAX_REPORT_BYTES: usize = 64 * 1024;

struct Acceptance {
    run_id: String,
    scratch: PathBuf,
    documents: PathBuf,
    profile: PathBuf,
    executable: PathBuf,
    executable_sha256: String,
    sequence: AtomicU64,
}

fn safe_path(path: &Path) -> Result<(), String> {
    for ancestor in path.ancestors() {
        let metadata =
            fs::symlink_metadata(ancestor).map_err(|_| "Acceptance path could not be checked")?;
        if metadata.file_type().is_symlink() {
            return Err("Linked acceptance path is not allowed".into());
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            if metadata.file_attributes() & 0x400 != 0 {
                return Err("Acceptance reparse point is not allowed".into());
            }
        }
    }
    Ok(())
}

fn main_window(window: &WebviewWindow) -> Result<(), String> {
    if window.label() != "main" {
        return Err("Acceptance is available only to its main window".into());
    }
    Ok(())
}

fn selected_model(
    model: Option<open_code::ModelRefView>,
) -> open_code::OpenCodeResult<open_code::ModelRefView> {
    let selected = open_code::ModelRefView {
        provider_id: "openai".into(),
        id: "gpt-6-luna".into(),
        variant: None,
    };
    if model.as_ref().is_some_and(|model| model != &selected) {
        return Err(open_code::OpenCodeError::new(
            "invalid_argument",
            "Acceptance permits only openai/gpt-6-luna",
        ));
    }
    Ok(selected)
}

async fn restrict_session(
    host: &open_code::Host,
    session_id: &str,
) -> open_code::OpenCodeResult<()> {
    host.get_session(session_id).await?;
    if !session_id
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
    {
        return Err(open_code::OpenCodeError::not_owned());
    }
    let service = host.ensure_connection().await?;
    // Verified installed V2 session.update contract. Deny native filesystem,
    // shell, network and delegation tools; TABS mutations still ask the user.
    service
        .request(
            host.http(),
            reqwest::Method::PATCH,
            &format!("api/session/{session_id}"),
            &[],
            Some(&json!({"permissions":[
                {"action":"*", "resource":"*", "effect":"deny"},
                {"action":"tabs_*", "resource":"*", "effect":"allow"},
                {"action":"tabs.mutate", "resource":"*", "effect":"ask"}
            ]})),
            std::time::Duration::from_secs(20),
        )
        .await?;
    Ok(())
}

#[tauri::command(rename = "open_code_create_session")]
async fn fixture_create_session(
    window: WebviewWindow,
    host: State<'_, Arc<open_code::Host>>,
    thread_id: String,
    title: Option<String>,
    model: Option<open_code::ModelRefView>,
    agent: Option<String>,
) -> open_code::OpenCodeResult<open_code::SessionDetail> {
    main_window(&window).map_err(|_| open_code::OpenCodeError::not_owned())?;
    let model = selected_model(model)?;
    let detail = host
        .create_session(&thread_id, title.as_deref(), Some(&model), agent.as_deref())
        .await?;
    restrict_session(&host, &detail.id).await?;
    Ok(detail)
}

#[tauri::command(rename = "open_code_switch_model")]
async fn fixture_switch_model(
    window: WebviewWindow,
    host: State<'_, Arc<open_code::Host>>,
    session_id: String,
    model: open_code::ModelRefView,
) -> open_code::OpenCodeResult<()> {
    main_window(&window).map_err(|_| open_code::OpenCodeError::not_owned())?;
    host.switch_model(&session_id, &selected_model(Some(model))?)
        .await
}

#[tauri::command(rename = "open_code_prompt")]
async fn fixture_prompt(
    window: WebviewWindow,
    host: State<'_, Arc<open_code::Host>>,
    session_id: String,
    admission_id: String,
    text: String,
) -> open_code::OpenCodeResult<open_code::InboxAdmission> {
    main_window(&window).map_err(|_| open_code::OpenCodeError::not_owned())?;
    restrict_session(&host, &session_id).await?;
    host.switch_model(&session_id, &selected_model(None)?)
        .await?;
    host.prompt(&session_id, &admission_id, &text).await
}

fn fixture_root(state: &Acceptance, root: &str) -> codex::HostResult<()> {
    safe_path(&state.documents)
        .map_err(|_| codex::HostError::new("invalid_argument", "Unsafe fixture directory"))?;
    let requested = Path::new(root)
        .canonicalize()
        .map_err(|_| codex::HostError::new("invalid_argument", "Fixture root is unavailable"))?;
    let documents = state
        .documents
        .canonicalize()
        .map_err(|_| codex::HostError::new("invalid_argument", "Fixture root is unavailable"))?;
    if requested != documents {
        return Err(codex::HostError::new(
            "invalid_argument",
            "Only the synthetic document root is allowed",
        ));
    }
    Ok(())
}

// Keep the real filesystem implementations, but never accept an owner-selected root.
#[tauri::command(rename = "codex_read_scoped_text_file")]
async fn fixture_read_scoped_text_file(
    window: WebviewWindow,
    state: State<'_, Acceptance>,
    workspace_root: String,
    path: String,
) -> codex::HostResult<String> {
    fixture_root(&state, &workspace_root)?;
    scoped_fs::codex_read_scoped_text_file(window, workspace_root, path).await
}

#[tauri::command(rename = "codex_list_scoped_documents")]
async fn fixture_list_scoped_documents(
    window: WebviewWindow,
    state: State<'_, Acceptance>,
    workspace_root: String,
) -> codex::HostResult<Vec<scoped_fs::ScopedDocument>> {
    fixture_root(&state, &workspace_root)?;
    scoped_fs::codex_list_scoped_documents(window, workspace_root).await
}

#[tauri::command(rename = "codex_scoped_document_hash")]
async fn fixture_scoped_document_hash(
    window: WebviewWindow,
    state: State<'_, Acceptance>,
    workspace_root: String,
    file_name: String,
) -> codex::HostResult<Option<String>> {
    fixture_root(&state, &workspace_root)?;
    scoped_fs::codex_scoped_document_hash(window, workspace_root, file_name).await
}

#[tauri::command(rename = "codex_create_scoped_document")]
async fn fixture_create_scoped_document(
    window: WebviewWindow,
    state: State<'_, Acceptance>,
    workspace_root: String,
    file_name: String,
    content_base64: String,
    expected_sha256: String,
) -> codex::HostResult<scoped_fs::ScopedDocumentWrite> {
    fixture_root(&state, &workspace_root)?;
    scoped_fs::codex_create_scoped_document(
        window,
        workspace_root,
        file_name,
        content_base64,
        expected_sha256,
    )
    .await
}

fn bounded_json(value: &Value, depth: usize) -> bool {
    if depth > 24 {
        return false;
    }
    match value {
        Value::Array(items) => items.iter().all(|item| bounded_json(item, depth + 1)),
        Value::Object(fields) => fields.values().all(|item| bounded_json(item, depth + 1)),
        _ => true,
    }
}

fn valid_report(report: &Value) -> bool {
    report.is_object() && bounded_json(report, 0) && report.to_string().len() <= MAX_REPORT_BYTES
}

#[tauri::command]
fn acceptance_report(
    window: WebviewWindow,
    state: State<'_, Acceptance>,
    report: Value,
) -> Result<String, String> {
    main_window(&window)?;
    if !valid_report(&report) {
        return Err("Acceptance report must be a bounded JSON object".into());
    }
    safe_path(&state.scratch)?;
    let sequence = state.sequence.fetch_add(1, Ordering::SeqCst);
    let path = state
        .scratch
        .join(format!("webview-report-{sequence:04}.json"));
    let envelope = json!({"schemaVersion":1, "identifier":IDENTIFIER,
        "runId":state.run_id, "pid":std::process::id(),
        "executable":state.executable, "executableSha256":state.executable_sha256,
        "webviewProfile":state.profile, "documentsPath":state.documents,
        "recordedAt":SystemTime::now().duration_since(UNIX_EPOCH).map_err(|_| "Clock unavailable")?.as_millis(),
        "source":"native-webview-ipc", "report":report});
    let bytes = serde_json::to_vec_pretty(&envelope).map_err(|_| "Report serialization failed")?;
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .map_err(|_| "Unique acceptance report could not be created")?;
    file.write_all(&bytes)
        .and_then(|_| file.sync_all())
        .map_err(|_| "Acceptance report write failed")?;
    Ok(path.to_string_lossy().into_owned())
}

#[cfg(test)]
mod acceptance_tests {
    use super::*;

    #[test]
    fn selected_model_never_falls_back_to_another_provider_or_model() {
        let model = selected_model(None).expect("approved model");
        assert_eq!(model.provider_id, "openai");
        assert_eq!(model.id, "gpt-6-luna");
        assert!(selected_model(Some(model.clone())).is_ok());
        assert!(selected_model(Some(open_code::ModelRefView {
            id: "different".into(),
            ..model
        }))
        .is_err());
    }

    #[test]
    fn reports_reject_non_objects_oversized_values_and_excessive_nesting() {
        assert!(valid_report(&json!({"stage":"synthetic-fixture"})));
        assert!(!valid_report(&json!([])));
        assert!(!valid_report(&json!({"text":"x".repeat(MAX_REPORT_BYTES)})));
        let mut nested = json!({});
        for _ in 0..26 {
            nested = json!({"nested":nested});
        }
        assert!(!valid_report(&nested));
    }

    #[test]
    fn scoped_filesystem_refuses_any_other_root() {
        let root = tempfile::tempdir().expect("synthetic fixture");
        let documents = root.path().join("documents");
        fs::create_dir(&documents).expect("documents");
        let state = Acceptance {
            run_id: "test".into(),
            scratch: root.path().into(),
            documents: documents.clone(),
            profile: root.path().join("profile"),
            executable: PathBuf::new(),
            executable_sha256: String::new(),
            sequence: AtomicU64::new(0),
        };
        assert!(fixture_root(&state, &documents.to_string_lossy()).is_ok());
        assert!(fixture_root(&state, &root.path().to_string_lossy()).is_err());
    }
}

#[tauri::command]
fn acceptance_quit(window: WebviewWindow, app: tauri::AppHandle) -> Result<(), String> {
    main_window(&window)?;
    app.exit(0);
    Ok(())
}

#[tauri::command]
async fn acceptance_form(
    window: WebviewWindow,
    host: State<'_, Arc<open_code::Host>>,
    session_id: String,
    form_id: Option<String>,
) -> open_code::OpenCodeResult<Value> {
    main_window(&window).map_err(|_| open_code::OpenCodeError::not_owned())?;
    host.get_session(&session_id).await?;
    let service = host.ensure_connection().await?;
    let path = format!("api/session/{session_id}/form");
    let (method, path, body) = if let Some(id) = form_id {
        if !id.starts_with("frm_") || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_') {
            return Err(open_code::OpenCodeError::not_owned());
        }
        (reqwest::Method::GET, format!("{path}/{id}"), None)
    } else {
        (
            reqwest::Method::POST,
            path,
            Some(json!({"title":"Synthetic question",
            "fields":[{"key":"confirm", "type":"boolean", "required":true, "default":false}]})),
        )
    };
    service
        .request(
            host.http(),
            method,
            &path,
            &[],
            body.as_ref(),
            std::time::Duration::from_secs(20),
        )
        .await
}

fn main() {
    assert!(
        cfg!(windows) && cfg!(debug_assertions),
        "Acceptance requires a Windows debug build"
    );
    let context = tauri::generate_context!("tauri.opencode-acceptance.conf.json");
    let config = context.config();
    assert_eq!(config.identifier, IDENTIFIER);
    assert!(!config.bundle.active);
    assert_eq!(config.app.windows.len(), 1);
    assert_eq!(config.app.windows[0].label, "main");
    assert!(!config.app.windows[0].create);
    assert!(config
        .bundle
        .file_associations
        .as_ref()
        .is_none_or(Vec::is_empty));
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            acceptance_report, acceptance_quit, acceptance_form,
            fixture_read_scoped_text_file, fixture_list_scoped_documents,
            fixture_scoped_document_hash, fixture_create_scoped_document,
            open_code_commands::open_code_status,
            open_code_commands::open_code_discover,
            open_code_commands::open_code_list_models,
            open_code_commands::open_code_list_agents,
            fixture_create_session,
            open_code_commands::open_code_rebind_sessions,
            open_code_commands::open_code_get_session,
            open_code_commands::open_code_get_messages,
            fixture_prompt,
            open_code_commands::open_code_interrupt,
            fixture_switch_model,
            open_code_commands::open_code_switch_agent,
            open_code_commands::open_code_delete_session,
            open_code_commands::open_code_list_forms,
            open_code_commands::open_code_reply_form,
            open_code_commands::open_code_list_permissions,
            open_code_commands::open_code_reply_permission,
            open_code_commands::open_code_subscribe,
            open_code_commands::open_code_unsubscribe,
            open_code_commands::open_code_tool_start,
            open_code_commands::open_code_tool_bind,
            open_code_commands::open_code_tool_validate,
            open_code_commands::open_code_tool_complete,
            open_code_commands::open_code_tool_stop,
        ])
        .setup(|app| {
            let local = app.path().app_local_data_dir()?;
            if local != app.path().local_data_dir()?.join(IDENTIFIER) {
                return Err("Acceptance app-local identity mismatch".into());
            }
            fs::create_dir_all(&local)?;
            safe_path(&local)?;
            let base = Path::new(SCRATCH);
            fs::create_dir_all(base)?;
            safe_path(base)?;
            let args: Vec<String> = std::env::args().skip(1).collect();
            let resume = args.len() == 2 && args[0] == "--resume-run";
            if !args.is_empty() && !resume { return Err("Unknown acceptance argument".into()); }
            let mut random = [0u8; 16];
            getrandom::getrandom(&mut random).map_err(|_| "Acceptance randomness unavailable")?;
            let run_id: String = if resume { args[1].clone() } else { random.iter().map(|byte| format!("{byte:02x}")).collect() };
            if run_id.len() != 32 || !run_id.bytes().all(|b| b.is_ascii_hexdigit()) { return Err("Invalid acceptance run ID".into()); }
            let scratch = base.join(&run_id);
            if !resume { fs::create_dir(&scratch)?; }
            safe_path(&scratch)?;
            let documents = scratch.join("documents");
            let profile = scratch.join("webview");
            if !resume { fs::create_dir(&documents)?; fs::create_dir(&profile)?; }
            safe_path(&documents)?; safe_path(&profile)?;
            safe_path(&scratch)?;
            let executable = std::env::current_exe()?;
            let executable_sha256 = format!("{:x}", Sha256::digest(fs::read(&executable)?));
            let data = json!({"runId":run_id, "scratchPath":scratch, "documentsPath":documents, "resume":resume,
                "webviewProfile":profile, "model":{"providerId":"openai", "id":"gpt-6-luna"}});
            let script = format!("Object.defineProperty(window, '__TABS_OPENCODE_ACCEPTANCE__', {{value:true}}); Object.defineProperty(window, '__TABS_OPENCODE_ACCEPTANCE_CONTEXT__', {{value:Object.freeze({data})}});");
            app.manage(Acceptance { run_id, scratch, documents, profile:profile.clone(),
                executable, executable_sha256, sequence:AtomicU64::new(if resume { 1000 } else { 0 }) });
            // Check every plugin ancestor before Host writes its embedded plugin.
            let plugins = local.join("opencode").join("workspace").join(".opencode").join("plugins");
            fs::create_dir_all(&plugins)?;
            safe_path(&plugins)?;
            let plugin = plugins.join("tabs.js");
            if plugin.exists() || fs::symlink_metadata(&plugin).is_ok() { safe_path(&plugin)?; }
            // Existing Host uses only this application's separate durable workspace.
            app.manage(open_code_commands::create_host(app.handle())?);
            WebviewWindowBuilder::from_config(app, &app.config().app.windows[0])?
                .data_directory(profile)
                .initialization_script(script)
                .on_navigation(|url| {
                    (url.scheme() == "http" && url.host_str() == Some("localhost") && url.port() == Some(1421))
                        || (matches!(url.scheme(), "http" | "https" | "tauri") && url.host_str() == Some("tauri.localhost"))
                })
                .build()?;
            Ok(())
        })
        .build(context).expect("Isolated OpenCode acceptance could not start")
        .run(|app, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                if let Some(host) = app.try_state::<Arc<open_code::Host>>() { host.shutdown(); }
            }
        });
}
