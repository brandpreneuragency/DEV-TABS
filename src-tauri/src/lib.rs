// TABS desktop shell.
//
// Phase 2 native features:
//   * Single-instance: a second launch focuses the existing window.
//   * Notification: tauri-plugin-notification (test command below).
//   * Global shortcut Ctrl+Shift+Space: focuses the main window from any app.
//   * Tray icon: Show TABS / Quit menu.
//   * File open: argv is scanned for an existing file path (Open With / double-
//     click). Path is stored as pending state and emitted as `tabs://open-file`
//     so the frontend can open it even if the listener attaches late.
#[cfg(not(any(feature = "clients-acceptance", feature = "tasks-acceptance")))]
use std::sync::Mutex;

#[cfg(not(any(feature = "clients-acceptance", feature = "tasks-acceptance")))]
use tauri::{Emitter, Manager, WindowEvent};
#[cfg(not(any(feature = "clients-acceptance", feature = "tasks-acceptance")))]
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

#[cfg(not(any(feature = "clients-acceptance", feature = "tasks-acceptance")))]
mod cli_providers;
#[cfg(not(any(feature = "clients-acceptance", feature = "tasks-acceptance")))]
mod codex;
#[cfg(not(any(feature = "clients-acceptance", feature = "tasks-acceptance")))]
mod commands;
#[cfg(not(any(feature = "clients-acceptance", feature = "tasks-acceptance")))]
mod open_code;
#[cfg(not(any(feature = "clients-acceptance", feature = "tasks-acceptance")))]
mod provider_accounts;
#[cfg(not(any(feature = "clients-acceptance", feature = "tasks-acceptance")))]
mod provider_connections;
#[cfg(not(any(feature = "clients-acceptance", feature = "tasks-acceptance")))]
mod scripts;
#[cfg(not(any(feature = "clients-acceptance", feature = "tasks-acceptance")))]
mod tab_bridge;
#[cfg(not(any(feature = "clients-acceptance", feature = "tasks-acceptance")))]
mod terminal;
#[cfg(not(any(feature = "clients-acceptance", feature = "tasks-acceptance")))]
mod tray;

#[cfg(feature = "tasks-acceptance")]
mod task_acceptance;
#[cfg(not(feature = "clients-acceptance"))]
mod task_authority;
#[cfg(all(feature = "tasks-acceptance", feature = "clients-acceptance"))]
compile_error!("Choose exactly one acceptance runtime");

#[cfg(feature = "clients-acceptance")]
mod acceptance;
#[cfg(feature = "clients-acceptance")]
mod gmail;

/// Path from OS "Open With" / file association that the frontend has not yet
/// consumed. Survives the race where setup emits before the webview listens.
#[cfg(not(any(feature = "clients-acceptance", feature = "tasks-acceptance")))]
struct PendingOpenFile(Mutex<Option<String>>);

/// Pick the first argv entry that looks like a real file to open.
/// Skips flags (`-…`) and the executable path itself.
#[cfg(not(any(feature = "clients-acceptance", feature = "tasks-acceptance")))]
fn extract_open_file_path(args: impl IntoIterator<Item = String>) -> Option<String> {
    for arg in args {
        let trimmed = arg.trim();
        if trimmed.is_empty() || trimmed.starts_with('-') {
            continue;
        }
        let p = std::path::Path::new(trimmed);
        // Windows "Open with" passes the absolute path; only accept existing files.
        if p.is_file() {
            return Some(trimmed.to_string());
        }
    }
    None
}

#[cfg(not(any(feature = "clients-acceptance", feature = "tasks-acceptance")))]
fn focus_main_window(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.set_focus();
    }
}

#[cfg(not(any(feature = "clients-acceptance", feature = "tasks-acceptance")))]
fn queue_open_file(app: &tauri::AppHandle, path: String) {
    if let Some(state) = app.try_state::<PendingOpenFile>() {
        if let Ok(mut guard) = state.0.lock() {
            *guard = Some(path.clone());
        }
    }
    let _ = app.emit("tabs://open-file", path);
}

// Convenience command to exercise the notification plugin from the webview
// devtools console:
//   await window.__TAURI__.core.invoke('test_notification')
#[tauri::command]
#[cfg(not(any(feature = "clients-acceptance", feature = "tasks-acceptance")))]
fn test_notification(app: tauri::AppHandle) -> Result<(), String> {
    use tauri_plugin_notification::NotificationExt;
    app.notification()
        .builder()
        .title("TABS")
        .body("Phase 2 notification test")
        .show()
        .map_err(|e| e.to_string())
}

/// Frontend calls this on mount to recover a cold-start Open With path that
/// may have been emitted before the event listener was registered.
#[tauri::command]
#[cfg(not(any(feature = "clients-acceptance", feature = "tasks-acceptance")))]
fn take_pending_open_file(state: tauri::State<'_, PendingOpenFile>) -> Option<String> {
    state.0.lock().ok().and_then(|mut g| g.take())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(feature = "tasks-acceptance")]
    task_acceptance::run();
    #[cfg(feature = "clients-acceptance")]
    {
        acceptance::run();
    }
    #[cfg(not(any(feature = "clients-acceptance", feature = "tasks-acceptance")))]
    run_production();
}

#[cfg(not(any(feature = "clients-acceptance", feature = "tasks-acceptance")))]
fn run_production() {
    let context = tauri::generate_context!();
    assert_eq!(
        context.config().identifier,
        "com.tabs.app",
        "Production build requires the production application identity"
    );
    // Single-instance is release-only. If it is also enabled in debug, an
    // already-running installed TABS (often hidden in the tray after close)
    // causes `npm run tauri:dev` to start and immediately exit — looking
    // like the dev command "keeps quitting".
    let builder = tauri::Builder::default();

    #[cfg(not(debug_assertions))]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
        // Second launch focuses the existing window instead of starting another.
        focus_main_window(app);
        // Forward Open With / double-click path from the second process.
        // argv[0] is the executable; remaining args may include the file path.
        if let Some(path) = extract_open_file_path(argv.into_iter().skip(1)) {
            queue_open_file(app, path);
        }
    }));

    builder
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(terminal::TerminalRegistry::new())
        .manage(PendingOpenFile(Mutex::new(None)))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state() == ShortcutState::Pressed
                        && shortcut.matches(Modifiers::CONTROL | Modifiers::SHIFT, Code::Space)
                    {
                        focus_main_window(app);
                    }
                })
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            task_authority::task_authority_rpc,
            task_authority::task_authority_backup,
            test_notification,
            take_pending_open_file,
            tray::tray_popup_ready,
            tray::tray_popup_hide,
            commands::secrets::legacy_ai_preference,
            commands::secrets::legacy_ai_cleanup,
            commands::terminal::terminal_create,
            commands::terminal::terminal_write,
            commands::terminal::terminal_resize,
            commands::terminal::terminal_kill,
            commands::terminal::terminal_list,
            commands::terminal::home_dir,
            commands::scripts::scripts_snapshot,
            commands::scripts::scripts_save,
            commands::scripts::scripts_duplicate,
            commands::scripts::scripts_delete,
            commands::scripts::scripts_start,
            commands::scripts::scripts_cancel,
            commands::scripts::scripts_output,
            provider_accounts::provider_accounts_list,
            provider_accounts::provider_accounts_refresh,
            provider_accounts::provider_accounts_connect_api_key,
            provider_accounts::provider_accounts_begin_login,
            provider_accounts::provider_accounts_poll_login,
            provider_accounts::provider_accounts_cancel_login,
            provider_accounts::provider_accounts_open_login,
            provider_accounts::provider_accounts_open_usage,
            provider_connections::provider_connections_refresh,
            commands::codex::codex_read_scoped_text_file,
            commands::codex::codex_list_scoped_documents,
            commands::codex::codex_scoped_document_hash,
            commands::codex::codex_create_scoped_document,
            commands::cli_providers::cli_provider_probe,
            commands::cli_providers::cli_provider_default_workspace,
            commands::open_code::open_code_status,
            commands::open_code::open_code_discover,
            commands::open_code::open_code_list_models,
            commands::open_code::open_code_list_agents,
            commands::open_code::open_code_create_session,
            commands::open_code::open_code_rebind_sessions,
            commands::open_code::open_code_get_session,
            commands::open_code::open_code_get_messages,
            commands::open_code::open_code_prompt,
            commands::open_code::open_code_interrupt,
            commands::open_code::open_code_switch_model,
            commands::open_code::open_code_switch_agent,
            commands::open_code::open_code_list_forms,
            commands::open_code::open_code_reply_form,
            commands::open_code::open_code_list_permissions,
            commands::open_code::open_code_reply_permission,
            commands::open_code::open_code_delete_session,
            commands::open_code::open_code_subscribe,
            commands::open_code::open_code_unsubscribe,
            commands::open_code::open_code_tool_start,
            commands::open_code::open_code_tool_bind,
            commands::open_code::open_code_tool_complete,
            commands::open_code::open_code_tool_validate,
            commands::open_code::open_code_tool_stop,
        ])
        .setup(|app| {
            app.manage(std::sync::Arc::new(scripts::ScriptsHost::new(
                app.path().app_local_data_dir()?.join("scripts"),
            )));
            app.manage(commands::open_code::create_host(app.handle())?);
            // Intercept the main window's close button: instead of quitting
            // the app, hide the window so the tray icon remains usable.
            // The user can quit from the tray's "Quit" menu item, or by
            // pressing Ctrl+Shift+Space (which will refocus the hidden
            // window if it's still running).
            if let Some(window) = app.get_webview_window("main") {
                let window_for_close = window.clone();
                window.on_window_event(move |event| {
                    if let WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        let _ = window_for_close.hide();
                    }
                });
            }

            // The main window is now created with `visible: true` in
            // tauri.conf.json so it shows up reliably on first launch.
            // We still call `show()` + `set_focus()` here as a belt-and-
            // braces guarantee: this runs after WebView2 is initialized
            // and the window is fully ready, so the show will actually
            // take effect (the old `visible: false` + immediate show()
            // had a race that left the window invisible on some machines).
            focus_main_window(app.handle());

            // Register Ctrl+Shift+Space as the "focus TABS" global hotkey.
            let shortcut = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::Space);
            if let Err(e) = app.global_shortcut().register(shortcut) {
                eprintln!("[TABS] Failed to register Ctrl+Shift+Space: {e}");
            }

            // Build the tray icon.
            tray::build(app.handle())?;

            // Cold-start Open With / file association: store + emit so the
            // frontend can open the file after it mounts (take_pending_open_file
            // covers the race if the event fires too early).
            if let Some(path) = extract_open_file_path(std::env::args().skip(1)) {
                queue_open_file(app.handle(), path);
            }

            Ok(())
        })
        .build(context)
        .expect("error while building tauri application")
        .run(|app, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                if let Some(host) = app.try_state::<std::sync::Arc<scripts::ScriptsHost>>() {
                    host.shutdown();
                }
                if let Some(host) = app.try_state::<std::sync::Arc<open_code::Host>>() {
                    host.shutdown();
                }
            }
        });
}
