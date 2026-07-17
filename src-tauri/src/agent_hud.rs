use serde::Deserialize;
use serde_json::json;
use tauri::{
    AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, PhysicalSize, Size, WebviewWindow,
};

const AGENT_HUD_WINDOW_LABEL: &str = "agent-hud";
const MAIN_WINDOW_LABEL: &str = "main";
const AGENT_OPEN_EVENT: &str = "june:agent:open";
// Fired at the webview when the panel swallows a right- or ctrl-click so the
// in-DOM menu can open. Mirrored by the listener in src/agent-hud.ts.
const AGENT_HUD_CONTEXT_MENU_EVENT: &str = "june:agent-hud:context-menu";
const AGENT_HUD_WINDOW_WIDTH: f64 = 304.0;
const AGENT_HUD_COLLAPSED_WINDOW_HEIGHT: f64 = 58.0;

// The custom NSPanel subclass overrides `sendEvent:`, a static C function with
// no captured state, so it reaches the app through this handle to emit the
// context-menu event back to the webview.
#[cfg(target_os = "macos")]
static AGENT_HUD_APP: std::sync::OnceLock<AppHandle> = std::sync::OnceLock::new();

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentHudLayoutRequest {
    expanded: bool,
    card_count: Option<u32>,
    context_menu_open: Option<bool>,
    width: Option<f64>,
    height: Option<f64>,
}

pub fn setup(app: &mut tauri::App) {
    #[cfg(target_os = "macos")]
    let _ = AGENT_HUD_APP.set(app.handle().clone());
    if let Err(error) = configure_agent_hud_window(app.handle()) {
        tracing::warn!(%error, "failed to configure agent HUD");
    }
}

#[tauri::command]
pub fn agent_hud_show(app: AppHandle) -> Result<(), String> {
    let Some(window) = app.get_webview_window(AGENT_HUD_WINDOW_LABEL) else {
        return Ok(());
    };
    position_agent_hud_window(&window)?;
    #[cfg(target_os = "macos")]
    {
        // The HUD is a passive status surface. Tauri's show() does
        // makeKeyAndOrderFront, which steals key focus from whatever the user is
        // typing in (the composer) on every agent event. Order it front WITHOUT
        // taking key — a click still promotes it to key (canBecomeKeyWindow=YES)
        // when the user actually interacts with it.
        order_agent_hud_front_without_key(&window);
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        window.show().map_err(|error| error.to_string())
    }
}

#[cfg(target_os = "macos")]
fn order_agent_hud_front_without_key(window: &WebviewWindow) {
    use objc2::msg_send;
    use objc2::runtime::AnyObject;

    let Ok(handle) = window.ns_window() else {
        return;
    };
    if handle.is_null() {
        return;
    }
    unsafe {
        let win = handle as *mut AnyObject;
        let nil: *mut AnyObject = std::ptr::null_mut();
        // orderFront: makes the panel visible and frontmost without making it
        // key (unlike makeKeyAndOrderFront:), so focus stays put.
        let _: () = msg_send![win, orderFront: nil];
    }
}

#[tauri::command]
pub fn agent_hud_hide(app: AppHandle) -> Result<(), String> {
    let Some(window) = app.get_webview_window(AGENT_HUD_WINDOW_LABEL) else {
        return Ok(());
    };
    window.hide().map_err(|error| error.to_string())
}

#[tauri::command]
pub fn agent_hud_set_layout(app: AppHandle, request: AgentHudLayoutRequest) -> Result<(), String> {
    let Some(window) = app.get_webview_window(AGENT_HUD_WINDOW_LABEL) else {
        return Ok(());
    };
    let (width, height) = agent_hud_window_size(
        request.expanded,
        request.card_count.unwrap_or(0),
        request.context_menu_open.unwrap_or(false),
        request.width,
        request.height,
    );
    let logical_size = LogicalSize::new(width, height);
    let scale = window.scale_factor().map_err(|error| error.to_string())?;
    let physical_size: PhysicalSize<u32> = logical_size.to_physical(scale);
    window
        .set_size(Size::Logical(logical_size))
        .map_err(|error| error.to_string())?;
    // Width now follows the rendered surface so the transparent part of the
    // native panel cannot cover nearby controls. Re-anchor from the requested
    // size instead of outer_size(), which can lag behind set_size() on macOS.
    position_agent_hud_window_with_size(&window, physical_size)
}

#[tauri::command]
pub fn agent_hud_open_agent(
    app: AppHandle,
    session: Option<serde_json::Value>,
) -> Result<(), String> {
    show_main_window(&app);
    let payload = session
        .map(|session| json!({ "session": session }))
        .unwrap_or_else(|| json!({}));
    app.emit_to(MAIN_WINDOW_LABEL, AGENT_OPEN_EVENT, payload)
        .map_err(|error| error.to_string())
}

/// The webview reports the rendered interactive bounds so the native panel can
/// match them exactly. The calculated dimensions are retained as a startup and
/// compatibility fallback while the page is loading.
fn agent_hud_window_size(
    expanded: bool,
    card_count: u32,
    context_menu_open: bool,
    requested_width: Option<f64>,
    requested_height: Option<f64>,
) -> (f64, f64) {
    let height: f64 = if !expanded || card_count == 0 {
        AGENT_HUD_COLLAPSED_WINDOW_HEIGHT
    } else {
        let rows = f64::from(card_count.min(3));
        let surface_height = 36.0 + rows * 46.0 + 6.0;
        8.0 + surface_height + 14.0
    };

    let fallback_height = if context_menu_open {
        height.max(104.0)
    } else {
        height
    };
    (
        valid_hud_dimension(requested_width).unwrap_or(AGENT_HUD_WINDOW_WIDTH),
        valid_hud_dimension(requested_height).unwrap_or(fallback_height),
    )
}

fn valid_hud_dimension(value: Option<f64>) -> Option<f64> {
    value.filter(|value| value.is_finite() && *value > 0.0 && *value <= 2048.0)
}

fn configure_agent_hud_window(app: &AppHandle) -> Result<(), String> {
    let Some(window) = app.get_webview_window(AGENT_HUD_WINDOW_LABEL) else {
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
        // A native shadow sits outside the hit-tested window bounds. CSS
        // shadow gutters would make transparent pixels intercept clicks.
        .set_shadow(true)
        .map_err(|error| error.to_string())?;

    #[cfg(target_os = "macos")]
    make_agent_hud_nonactivating(&window);

    position_agent_hud_window(&window)
}

fn position_agent_hud_window(window: &WebviewWindow) -> Result<(), String> {
    let size = window.outer_size().map_err(|error| error.to_string())?;
    position_agent_hud_window_with_size(window, size)
}

fn position_agent_hud_window_with_size(
    window: &WebviewWindow,
    size: PhysicalSize<u32>,
) -> Result<(), String> {
    // Keep the visible surface at its previous screen position. The old
    // oversized webview placed it 10px from the right and 8px from the top.
    const MARGIN_X: f64 = 26.0;
    const MARGIN_Y: f64 = 20.0;

    let scale = window.scale_factor().map_err(|error| error.to_string())?;
    // Pin the HUD to the primary monitor; picking the monitor from the
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
    let y = work_area.position.y + margin_y;
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
fn make_agent_hud_nonactivating(window: &WebviewWindow) {
    use objc2::msg_send;
    use objc2::runtime::AnyObject;

    let Ok(handle) = window.ns_window() else {
        return;
    };
    if handle.is_null() {
        return;
    }
    let Some(panel_class) = agent_hud_panel_class() else {
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

/// NSPanel subclass that can become the key window. A borderless panel
/// answers NO to `canBecomeKeyWindow` by default, so it never becomes key
/// and the webview receives no keyboard events — Escape wouldn't dismiss the
/// context menu and Enter/Space wouldn't toggle the pill. (Mouse clicks reach
/// a non-activating panel regardless of key status; this is purely about
/// keyboard delivery.) It also overrides `sendEvent:` to intercept
/// context-click events before WKWebView ever sees them; see `send_event`.
#[cfg(target_os = "macos")]
fn agent_hud_panel_class() -> Option<&'static objc2::runtime::AnyClass> {
    use objc2::msg_send;
    use objc2::runtime::{AnyClass, AnyObject, Bool, ClassBuilder, Sel};
    use objc2::sel;

    extern "C-unwind" fn can_become_key(_this: &AnyObject, _sel: Sel) -> Bool {
        Bool::YES
    }
    extern "C-unwind" fn can_become_main(_this: &AnyObject, _sel: Sel) -> Bool {
        Bool::NO
    }

    // NSEvent type/modifier constants (AppKit is not a dependency, so they are
    // spelled out here). A right-mouse-down, or the macOS ctrl-click
    // context-click convention, is swallowed: WKWebView never gets the chance
    // to raise its own native context menu, and the webview is told to open the
    // HUD's own menu instead. Everything else forwards to super untouched.
    const NS_EVENT_TYPE_LEFT_MOUSE_DOWN: i64 = 1;
    const NS_EVENT_TYPE_RIGHT_MOUSE_DOWN: i64 = 3;
    const NS_EVENT_MODIFIER_FLAG_CONTROL: u64 = 1 << 18;

    extern "C-unwind" fn send_event(this: &AnyObject, _sel: Sel, event: *mut AnyObject) {
        // Resolved once: this runs for every event the panel sees (mouse
        // moves, scrolls, keys), and the class registration is permanent.
        static SUPERCLASS: std::sync::OnceLock<&'static AnyClass> = std::sync::OnceLock::new();
        unsafe {
            if !event.is_null() {
                let event_type: i64 = msg_send![event, type];
                let modifiers: u64 = msg_send![event, modifierFlags];
                let is_context_click = event_type == NS_EVENT_TYPE_RIGHT_MOUSE_DOWN
                    || (event_type == NS_EVENT_TYPE_LEFT_MOUSE_DOWN
                        && modifiers & NS_EVENT_MODIFIER_FLAG_CONTROL != 0);
                if is_context_click {
                    if let Some(app) = AGENT_HUD_APP.get() {
                        let _ =
                            app.emit_to(AGENT_HUD_WINDOW_LABEL, AGENT_HUD_CONTEXT_MENU_EVENT, ());
                    }
                    // Do not forward to super: that is what keeps the native
                    // WKWebView context menu from ever appearing.
                    return;
                }
            }
            let superclass = *SUPERCLASS
                .get_or_init(|| AnyClass::get(c"NSPanel").expect("NSPanel class missing"));
            let _: () = msg_send![super(this, superclass), sendEvent: event];
        }
    }

    if let Some(class) = AnyClass::get(c"JuneAgentHudPanel") {
        return Some(class);
    }
    let superclass = AnyClass::get(c"NSPanel")?;
    let mut builder = ClassBuilder::new(c"JuneAgentHudPanel", superclass)?;
    unsafe {
        builder.add_method(
            sel!(canBecomeKeyWindow),
            can_become_key as extern "C-unwind" fn(_, _) -> _,
        );
        builder.add_method(
            sel!(canBecomeMainWindow),
            can_become_main as extern "C-unwind" fn(_, _) -> _,
        );
        builder.add_method(
            sel!(sendEvent:),
            send_event as extern "C-unwind" fn(_, _, _),
        );
    }
    Some(builder.register())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn agent_hud_layout_keeps_width_stable_across_states() {
        assert_eq!(agent_hud_window_size(false, 0, false, None, None).0, 304.0);
        assert_eq!(agent_hud_window_size(true, 1, false, None, None).0, 304.0);
        assert_eq!(agent_hud_window_size(true, 3, false, None, None).0, 304.0);
        assert_eq!(agent_hud_window_size(false, 0, true, None, None).0, 304.0);
    }

    #[test]
    fn agent_hud_layout_grows_downward_for_expanded_content() {
        let collapsed = agent_hud_window_size(false, 0, false, None, None);
        let expanded = agent_hud_window_size(true, 1, false, None, None);
        let expanded_more = agent_hud_window_size(true, 3, false, None, None);

        assert_eq!(collapsed.1, AGENT_HUD_COLLAPSED_WINDOW_HEIGHT);
        assert!(expanded.1 > collapsed.1);
        assert!(expanded_more.1 > expanded.1);
    }

    #[test]
    fn agent_hud_layout_uses_rendered_interactive_bounds() {
        assert_eq!(
            agent_hud_window_size(false, 0, false, Some(112.0), Some(32.0)),
            (112.0, 32.0)
        );
        assert_eq!(
            agent_hud_window_size(false, 0, false, Some(0.0), Some(f64::INFINITY)),
            (AGENT_HUD_WINDOW_WIDTH, AGENT_HUD_COLLAPSED_WINDOW_HEIGHT)
        );
    }
}
