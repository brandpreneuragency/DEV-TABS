use super::{
    geometry::{placement, Rect},
    logic::Intent,
};
use std::{
    sync::Mutex,
    time::{Duration, Instant},
};
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};

pub const LABEL: &str = "accounts-tray";
#[derive(Default)]
pub(super) struct Popup(Mutex<Data>);
struct Data {
    intent: Intent,
    icon: Rect,
    width: f64,
    height: f64,
    foreground: usize,
}
impl Default for Data {
    fn default() -> Self {
        Self {
            intent: Intent::default(),
            icon: Rect::default(),
            width: 640.0,
            height: 360.0,
            foreground: 0,
        }
    }
}
// These two User32 APIs live behind an unselected windows-sys feature. Bind the
// cached SDK signatures directly instead of widening the dependency features.
#[cfg(windows)]
#[link(name = "user32")]
extern "system" {
    fn GetDoubleClickTime() -> u32;
    fn GetAsyncKeyState(key: i32) -> i16;
}
fn interval() -> Duration {
    #[cfg(windows)]
    {
        Duration::from_millis(unsafe { GetDoubleClickTime() }.max(1) as u64)
    }
    #[cfg(not(windows))]
    {
        Duration::from_millis(500)
    }
}
fn cursor() -> Option<(f64, f64)> {
    #[cfg(windows)]
    {
        let mut p = windows_sys::Win32::Foundation::POINT { x: 0, y: 0 };
        if unsafe { windows_sys::Win32::UI::WindowsAndMessaging::GetCursorPos(&mut p) } != 0 {
            return Some((p.x as f64, p.y as f64));
        }
    }
    None
}
fn foreground() -> usize {
    #[cfg(windows)]
    {
        unsafe { windows_sys::Win32::UI::WindowsAndMessaging::GetForegroundWindow() as usize }
    }
    #[cfg(not(windows))]
    {
        0
    }
}
fn mouse_down() -> bool {
    #[cfg(windows)]
    {
        unsafe { GetAsyncKeyState(1) < 0 || GetAsyncKeyState(2) < 0 || GetAsyncKeyState(4) < 0 }
    }
    #[cfg(not(windows))]
    {
        false
    }
}
fn left_pressed() -> bool {
    #[cfg(windows)]
    {
        unsafe { GetAsyncKeyState(1) < 0 }
    }
    #[cfg(not(windows))]
    {
        false
    }
}
pub(super) fn hide(app: &tauri::AppHandle) {
    app.state::<Popup>().0.lock().unwrap().intent.cancel();
    if let Some(w) = app.get_webview_window(LABEL) {
        let _ = w.hide();
    }
}
pub(super) fn double_click(app: &tauri::AppHandle) {
    app.state::<Popup>().0.lock().unwrap().intent.double_click();
    if let Some(w) = app.get_webview_window(LABEL) {
        let _ = w.hide();
    }
}
pub(super) fn left_down(app: &tauri::AppHandle) {
    app.state::<Popup>().0.lock().unwrap().intent.left_down();
}
pub(super) fn left_up(app: &tauri::AppHandle, rect: tauri::Rect) {
    // Windows tray rectangles are physical (tray-icon's Windows backend).
    let p = rect.position.to_physical::<f64>(1.0);
    let s = rect.size.to_physical::<f64>(1.0);
    let token = {
        let state = app.state::<Popup>();
        let mut d = state.0.lock().unwrap();
        d.icon = Rect {
            x: p.x,
            y: p.y,
            width: s.width,
            height: s.height,
        };
        d.foreground = foreground();
        d.intent.left_up()
    };
    let Some(token) = token else {
        if let Some(w) = app.get_webview_window(LABEL) {
            let _ = w.hide();
        }
        return;
    };
    let app = app.clone();
    let deadline = Instant::now() + interval();
    // One worker per click intent. It exits on cancellation, show or load timeout.
    // Polling also cancels an outside click while the hidden webview is loading,
    // where Focused(false) alone cannot report a loss of focus it never held.
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(15));
        let (tx, rx) = std::sync::mpsc::channel();
        let handle = app.clone();
        if app
            .run_on_main_thread(move || {
                let now = Instant::now();
                let result = tick(&handle, token, now >= deadline);
                let result = if result && now > deadline + Duration::from_secs(30) {
                    hide(&handle);
                    false
                } else {
                    result
                };
                let _ = tx.send(result);
            })
            .is_err()
        {
            break;
        }
        if !matches!(rx.recv(), Ok(true)) {
            break;
        }
    });
}
fn tick(app: &tauri::AppHandle, token: u64, elapsed: bool) -> bool {
    let (active, outside) = {
        let state = app.state::<Popup>();
        let d = state.0.lock().unwrap();
        (
            d.intent.generation == token
                && (d.intent.pending || d.intent.requested)
                && !d.intent.visible,
            foreground() != d.foreground
                || (mouse_down() && cursor().is_some_and(|(x, y)| !d.icon.contains(x, y))),
        )
    };
    if !active {
        return false;
    }
    if outside {
        hide(app);
        return false;
    }
    let start = elapsed && app.state::<Popup>().0.lock().unwrap().intent.elapsed(token);
    if start {
        let result = app
            .get_webview_window(LABEL)
            .ok_or_else(|| "Accounts tray window is unavailable".to_string())
            .and_then(|w| present(app, &w));
        if let Err(e) = result {
            eprintln!("[TABS] accounts tray could not open: {e}");
            hide(app);
            return false;
        }
    }
    true
}
/// Create only during setup, never inside a synchronous tray/event-loop callback.
pub(super) fn initialize(app: &tauri::AppHandle) -> Result<WebviewWindow, String> {
    if let Some(w) = app.get_webview_window(LABEL) {
        return Ok(w);
    }
    let w = WebviewWindowBuilder::new(
        app,
        LABEL,
        WebviewUrl::App("index.html?tray=accounts".into()),
    )
    .title("TABS Accounts")
    .inner_size(640.0, 360.0)
    .visible(false)
    .focused(false)
    .decorations(false)
    .resizable(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .shadow(false)
    .build()
    .map_err(|e| e.to_string())?;
    let app = app.clone();
    w.on_window_event(move |event| match event {
        WindowEvent::Focused(false) => {
            let on_tray = {
                let state = app.state::<Popup>();
                let d = state.0.lock().unwrap();
                d.intent.visible
                    && left_pressed()
                    && cursor().is_some_and(|(x, y)| d.icon.contains(x, y))
            };
            if on_tray {
                app.state::<Popup>()
                    .0
                    .lock()
                    .unwrap()
                    .intent
                    .closed_on_tray();
            } else {
                app.state::<Popup>().0.lock().unwrap().intent.cancel();
            }
            if let Some(w) = app.get_webview_window(LABEL) {
                let _ = w.hide();
            }
        }
        WindowEvent::CloseRequested { api, .. } => {
            api.prevent_close();
            hide(&app);
        }
        WindowEvent::Destroyed => {
            let state = app.state::<Popup>();
            let mut d = state.0.lock().unwrap();
            d.intent.cancel();
            d.intent.ready = false;
        }
        _ => {}
    });
    Ok(w)
}
fn present(app: &tauri::AppHandle, w: &WebviewWindow) -> Result<(), String> {
    let (icon, width, height, show, visible) = {
        let state = app.state::<Popup>();
        let d = state.0.lock().unwrap();
        (
            d.icon,
            d.width,
            d.height,
            d.intent.should_show(),
            d.intent.visible,
        )
    };
    if !show && !visible {
        return Ok(());
    }
    // Recheck immediately before a ready-triggered show, not only on timer ticks.
    if show {
        let initial_foreground = app.state::<Popup>().0.lock().unwrap().foreground;
        if foreground() != initial_foreground
            || (mouse_down() && cursor().is_some_and(|(x, y)| !icon.contains(x, y)))
        {
            hide(app);
            return Ok(());
        }
    }
    let monitor = app
        .monitor_from_point(icon.x + icon.width / 2.0, icon.y + icon.height / 2.0)
        .map_err(|e| e.to_string())?
        .ok_or("Tray monitor is unavailable")?;
    let area = monitor.work_area();
    let r = placement(
        icon,
        Rect {
            x: area.position.x as f64,
            y: area.position.y as f64,
            width: area.size.width as f64,
            height: area.size.height as f64,
        },
        monitor.scale_factor(),
        width,
        height,
    );
    // Position first so Windows selects the target monitor's DPI before sizing.
    w.set_position(tauri::PhysicalPosition::new(r.x as i32, r.y as i32))
        .map_err(|e| e.to_string())?;
    w.set_size(tauri::PhysicalSize::new(r.width as u32, r.height as u32))
        .map_err(|e| e.to_string())?;
    if show {
        w.show().map_err(|e| e.to_string())?;
        app.state::<Popup>().0.lock().unwrap().intent.visible = true;
        if let Err(e) = w.set_focus().and_then(|_| {
            w.emit_to(
                tauri::EventTarget::webview_window(LABEL),
                "tabs://accounts-tray-opened",
                (),
            )
        }) {
            hide(app);
            return Err(e.to_string());
        }
    }
    Ok(())
}
fn authorize(label: &str) -> Result<(), String> {
    if label == LABEL {
        Ok(())
    } else {
        Err("Accounts tray commands require the accounts-tray window".into())
    }
}
async fn on_ui(
    app: tauri::AppHandle,
    action: impl FnOnce(&tauri::AppHandle) -> Result<(), String> + Send + 'static,
) -> Result<(), String> {
    let (tx, rx) = std::sync::mpsc::channel();
    let handle = app.clone();
    app.run_on_main_thread(move || {
        let _ = tx.send(action(&handle));
    })
    .map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        rx.recv().map_err(|_| "Tray UI stopped".to_string())?
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn tray_popup_ready(
    window: WebviewWindow,
    width: f64,
    height: f64,
) -> Result<(), String> {
    authorize(window.label())?;
    if !width.is_finite() || !height.is_finite() || width <= 0.0 || height <= 0.0 {
        return Err("Popup dimensions must be finite and positive".into());
    }
    on_ui(window.app_handle().clone(), move |app| {
        {
            let state = app.state::<Popup>();
            let mut d = state.0.lock().unwrap();
            d.width = width.min(640.0);
            d.height = height;
            d.intent.ready = true;
        }
        present(app, &window)
    })
    .await
}
#[tauri::command]
pub async fn tray_popup_hide(window: WebviewWindow) -> Result<(), String> {
    authorize(window.label())?;
    on_ui(window.app_handle().clone(), |app| {
        hide(app);
        Ok(())
    })
    .await
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_popup_can_invoke_commands() {
        assert!(authorize(LABEL).is_ok());
        for label in ["main", "", "accounts-tray-other"] {
            assert!(authorize(label).is_err());
        }
    }
}
