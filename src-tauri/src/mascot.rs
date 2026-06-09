use serde::Deserialize;
use serde_json::json;
use tauri::{
    AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, PhysicalSize, Size, WebviewWindow,
};

const MASCOT_WINDOW_LABEL: &str = "mascot";
const MAIN_WINDOW_LABEL: &str = "main";
const AGENT_OPEN_EVENT: &str = "scribe:agent:open";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MascotLayoutRequest {
    expanded: bool,
    card_count: Option<u32>,
    replying: Option<bool>,
}

pub fn setup(app: &mut tauri::App) {
    if let Err(error) = configure_mascot_window(app.handle()) {
        tracing::warn!(%error, "failed to configure desktop mascot");
    }
}

#[tauri::command]
pub fn mascot_show(app: AppHandle) -> Result<(), String> {
    let Some(window) = app.get_webview_window(MASCOT_WINDOW_LABEL) else {
        return Ok(());
    };
    position_mascot_window(&window)?;
    window.show().map_err(|error| error.to_string())
}

#[tauri::command]
pub fn mascot_hide(app: AppHandle) -> Result<(), String> {
    let Some(window) = app.get_webview_window(MASCOT_WINDOW_LABEL) else {
        return Ok(());
    };
    window.hide().map_err(|error| error.to_string())
}

#[tauri::command]
pub fn mascot_set_layout(app: AppHandle, request: MascotLayoutRequest) -> Result<(), String> {
    let Some(window) = app.get_webview_window(MASCOT_WINDOW_LABEL) else {
        return Ok(());
    };
    let (width, height) = mascot_window_size(
        request.expanded,
        request.card_count.unwrap_or(0),
        request.replying.unwrap_or(false),
    );
    window
        .set_size(Size::Logical(LogicalSize::new(width, height)))
        .map_err(|error| error.to_string())?;
    // Position with the size we just requested: set_size applies
    // asynchronously on macOS, so outer_size() may still report the
    // previous frame here.
    let scale = window.scale_factor().map_err(|error| error.to_string())?;
    let size = LogicalSize::new(width, height).to_physical::<u32>(scale);
    position_mascot_window_with_size(&window, size)
}

#[tauri::command]
pub fn mascot_open_agent(app: AppHandle, session: Option<serde_json::Value>) -> Result<(), String> {
    show_main_window(&app);
    let payload = session
        .map(|session| json!({ "session": session }))
        .unwrap_or_else(|| json!({}));
    app.emit_to(MAIN_WINDOW_LABEL, AGENT_OPEN_EVENT, payload)
        .map_err(|error| error.to_string())
}

fn mascot_window_size(expanded: bool, card_count: u32, replying: bool) -> (f64, f64) {
    if !expanded || card_count == 0 {
        return (72.0, 72.0);
    }

    let base_height = match card_count.min(3) {
        0 | 1 => 106.0,
        2 => 158.0,
        _ => 210.0,
    };
    let reply_height = if replying { 36.0 } else { 0.0 };
    (328.0, base_height + reply_height)
}

fn configure_mascot_window(app: &AppHandle) -> Result<(), String> {
    let Some(window) = app.get_webview_window(MASCOT_WINDOW_LABEL) else {
        return Ok(());
    };

    window
        .set_always_on_top(true)
        .map_err(|error| error.to_string())?;
    window
        .set_visible_on_all_workspaces(true)
        .map_err(|error| error.to_string())?;
    window
        .set_focusable(true)
        .map_err(|error| error.to_string())?;
    window
        .set_skip_taskbar(true)
        .map_err(|error| error.to_string())?;
    window
        .set_shadow(false)
        .map_err(|error| error.to_string())?;

    #[cfg(target_os = "macos")]
    make_mascot_nonactivating(&window);

    position_mascot_window(&window)
}

fn position_mascot_window(window: &WebviewWindow) -> Result<(), String> {
    let size = window.outer_size().map_err(|error| error.to_string())?;
    position_mascot_window_with_size(window, size)
}

fn position_mascot_window_with_size(
    window: &WebviewWindow,
    size: PhysicalSize<u32>,
) -> Result<(), String> {
    const MARGIN_X: f64 = 18.0;
    const MARGIN_Y: f64 = 14.0;

    let scale = window.scale_factor().map_err(|error| error.to_string())?;
    // Pin the mascot to the primary monitor; picking the monitor from the
    // cursor made it hop between displays whenever a layout change fired
    // while the mouse was on another screen.
    let monitor = window
        .primary_monitor()
        .ok()
        .flatten()
        .or_else(|| window.current_monitor().ok().flatten());
    let Some(monitor) = monitor else {
        return Ok(());
    };

    let work_area = monitor.work_area();
    let margin_x = (MARGIN_X * scale).round() as i32;
    let margin_y = (MARGIN_Y * scale).round() as i32;
    let x = work_area.position.x + work_area.size.width as i32 - size.width as i32 - margin_x;
    let y = work_area.position.y + work_area.size.height as i32 - size.height as i32 - margin_y;
    window
        .set_position(PhysicalPosition::new(x, y))
        .map_err(|error| error.to_string())
}

fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

#[cfg(target_os = "macos")]
fn make_mascot_nonactivating(window: &WebviewWindow) {
    use objc2::msg_send;
    use objc2::runtime::{AnyClass, AnyObject};

    let Ok(handle) = window.ns_window() else {
        return;
    };
    if handle.is_null() {
        return;
    }
    let Some(panel_class) = AnyClass::get(c"NSPanel") else {
        return;
    };

    unsafe {
        let window = handle as *mut AnyObject;
        objc2::ffi::object_setClass(window, panel_class as *const _ as *const _);

        const NON_ACTIVATING: usize = 1 << 7;
        let current_mask: usize = msg_send![window, styleMask];
        let _: () = msg_send![window, setStyleMask: current_mask | NON_ACTIVATING];
        let _: () = msg_send![window, setAcceptsMouseMovedEvents: true];
        let _: () = msg_send![window, setBecomesKeyOnlyIfNeeded: true];
    }
}
