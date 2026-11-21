//! Isolated real WebView/IPC Scripts smoke. Never starts the production app,
//! task authority, accounts, updater, Hermes or Syncthing.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
#[path = "../src/scripts/mod.rs"]
mod scripts;
#[path = "../src/commands/scripts.rs"]
mod scripts_commands;

use serde_json::Value;
use std::{fs, io::Write, path::PathBuf, sync::Arc};
use tauri::{Manager, State, WebviewWindow, WebviewWindowBuilder};

struct Fixture {
    root: PathBuf,
    phase: String,
}

/// Exercise native hiding without relying on timers in a hidden WebView.
#[tauri::command]
async fn scripts_acceptance_hide_probe(
    window: WebviewWindow,
    host: State<'_, Arc<scripts::ScriptsHost>>,
    run_id: String,
) -> Result<scripts::ScriptOutput, String> {
    if window.label() != "main" || !host.output(&run_id)?.run.status.active() {
        return Err("An active fixture job and the main window are required".into());
    }
    window.hide().map_err(|e| e.to_string())?;
    let host = host.inner().clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(15);
        loop {
            let output = host.output(&run_id)?;
            if !output.run.status.active() {
                return Ok(output);
            }
            if std::time::Instant::now() >= deadline {
                return Err("Hidden-window job did not finish".to_string());
            }
            std::thread::sleep(std::time::Duration::from_millis(25));
        }
    })
    .await
    .map_err(|e| e.to_string());
    window.show().map_err(|e| e.to_string())?;
    result?
}

#[tauri::command]
fn scripts_acceptance_report(
    window: WebviewWindow,
    state: State<'_, Fixture>,
    report: Value,
) -> Result<(), String> {
    if window.label() != "main" {
        return Err("Main fixture window required".into());
    }
    let bytes = serde_json::to_vec_pretty(&report).map_err(|e| e.to_string())?;
    if bytes.len() > 65536 {
        return Err("Report too large".into());
    }
    let path = state.root.join(format!("report-{}.json", state.phase));
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|e| e.to_string())?;
    file.write_all(&bytes)
        .and_then(|_| file.sync_all())
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn scripts_acceptance_quit(
    window: WebviewWindow,
    app: tauri::AppHandle,
    success: bool,
) -> Result<(), String> {
    if window.label() != "main" {
        return Err("Main fixture window required".into());
    }
    app.exit(if success { 0 } else { 1 });
    Ok(())
}

fn main() {
    assert!(
        cfg!(windows) && cfg!(debug_assertions),
        "Windows debug acceptance only"
    );
    let context = tauri::generate_context!("tauri.scripts-acceptance.conf.json");
    assert_eq!(context.config().identifier, "com.tabs.scripts.acceptance");
    assert!(!context.config().bundle.active);
    assert!(!context.config().app.windows[0].create);
    let scratch = PathBuf::from(std::env::var_os("TMPDIR").expect("TMPDIR required"))
        .canonicalize()
        .unwrap();
    let root = PathBuf::from(
        std::env::var_os("TABS_SCRIPTS_ACCEPTANCE_ROOT").expect("Fixture root required"),
    )
    .canonicalize()
    .unwrap();
    assert!(
        root.starts_with(&scratch) && root != scratch,
        "Fixture must be under agent scratch"
    );
    assert!(root
        .file_name()
        .unwrap()
        .to_string_lossy()
        .starts_with("tabs-scripts-acceptance-"));
    for ancestor in root.ancestors() {
        let metadata = fs::symlink_metadata(ancestor).unwrap();
        assert!(!metadata.file_type().is_symlink());
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            assert_eq!(
                metadata.file_attributes() & 0x400,
                0,
                "Fixture reparse point rejected"
            );
        }
    }
    let phase = std::env::var("TABS_SCRIPTS_ACCEPTANCE_PHASE").unwrap_or_else(|_| "first".into());
    assert!(matches!(phase.as_str(), "first" | "reopen"));
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            scripts_acceptance_report,
            scripts_acceptance_quit,
            scripts_acceptance_hide_probe,
            scripts_commands::scripts_snapshot,
            scripts_commands::scripts_save,
            scripts_commands::scripts_duplicate,
            scripts_commands::scripts_delete,
            scripts_commands::scripts_start,
            scripts_commands::scripts_cancel,
            scripts_commands::scripts_output,
        ])
        .setup(move |app| {
            app.manage(Arc::new(scripts::ScriptsHost::new(root.join("store"))));
            let webview = root.join("webview");
            fs::create_dir_all(&webview)?;
            let initialization = format!(
                "Object.defineProperty(window,'__TABS_SCRIPTS_ACCEPTANCE__',{{value:{}}});",
                serde_json::json!({"phase":phase,"hold":std::env::var("TABS_SCRIPTS_ACCEPTANCE_HOLD").ok().as_deref() == Some("1")})
            );
            app.manage(Fixture {
                root: root.clone(),
                phase: phase.clone(),
            });
            WebviewWindowBuilder::from_config(app, &app.config().app.windows[0])?
                .data_directory(webview)
                .initialization_script(initialization)
                .on_navigation(|url| {
                    url.scheme() == "http"
                        && url.host_str() == Some("localhost")
                        && url.port() == Some(1421)
                })
                .build()?;
            Ok(())
        })
        .build(context)
        .expect("Scripts acceptance failed to start")
        .run(|app, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                if let Some(host) = app.try_state::<Arc<scripts::ScriptsHost>>() {
                    host.shutdown();
                }
            }
        });
}
