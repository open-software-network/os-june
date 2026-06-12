use serde::Deserialize;
use serde_json::json;
use tauri::{
    AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, PhysicalSize, Size, WebviewWindow,
};

const AGENT_HUD_WINDOW_LABEL: &str = "agent-hud";
const MAIN_WINDOW_LABEL: &str = "main";
const AGENT_OPEN_EVENT: &str = "scribe:agent:open";
// Fired at the webview when the panel swallows a right- or ctrl-click so the
// in-DOM menu can open. Mirrored by the listener in src/agent-hud.ts.
const AGENT_HUD_CONTEXT_MENU_EVENT: &str = "scribe:agent-hud:context-menu";
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
    replying: Option<bool>,
    context_menu_open: Option<bool>,
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
    window.show().map_err(|error| error.to_string())
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
        request.replying.unwrap_or(false),
        request.context_menu_open.unwrap_or(false),
    );
    // The HUD is top-right anchored with a fixed native width, so resizing
    // only changes height and does not need an immediate reposition. If the
    // width becomes dynamic, reposition with the requested size here instead
    // of reading outer_size(), which can lag behind set_size() on macOS.
    window
        .set_size(Size::Logical(LogicalSize::new(width, height)))
        .map_err(|error| error.to_string())
}

/// Lets the HUD accept keystrokes for its inline reply field. The panel is
/// non-activating, so becoming key does not bring the app forward or steal
/// focus from whatever the user is working in.
#[tauri::command]
pub fn agent_hud_focus_reply(app: AppHandle) -> Result<(), String> {
    let Some(window) = app.get_webview_window(AGENT_HUD_WINDOW_LABEL) else {
        return Ok(());
    };
    #[cfg(target_os = "macos")]
    {
        let panel = window.clone();
        window
            .run_on_main_thread(move || make_agent_hud_key(&panel))
            .map_err(|error| error.to_string())
    }
    #[cfg(not(target_os = "macos"))]
    window.set_focus().map_err(|error| error.to_string())
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

/// Mirrors the CSS in agent-hud.css: 248px surface width plus transparent
/// gutter for the top-right offset and shadow. Keep the native width constant
/// so layout changes grow downward like a notification instead of resizing and
/// re-anchoring horizontally.
fn agent_hud_window_size(
    expanded: bool,
    card_count: u32,
    replying: bool,
    context_menu_open: bool,
) -> (f64, f64) {
    let height: f64 = if !expanded || card_count == 0 {
        AGENT_HUD_COLLAPSED_WINDOW_HEIGHT
    } else {
        let rows = f64::from(card_count.min(3));
        let surface_height = 36.0 + rows * 46.0 + 6.0;
        let reply_height = if replying { 32.0 } else { 0.0 };
        8.0 + surface_height + reply_height + 14.0
    };

    if context_menu_open {
        (AGENT_HUD_WINDOW_WIDTH, height.max(104.0))
    } else {
        (AGENT_HUD_WINDOW_WIDTH, height)
    }
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
        .set_shadow(false)
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
    const MARGIN_X: f64 = 16.0;
    const MARGIN_Y: f64 = 12.0;

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
/// answers NO to `canBecomeKeyWindow` by default, which silently drops
/// every keystroke aimed at the reply field. It also overrides `sendEvent:`
/// to intercept context-click events before WKWebView ever sees them; see
/// `send_event` below.
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

#[cfg(target_os = "macos")]
fn make_agent_hud_key(window: &WebviewWindow) {
    use objc2::msg_send;
    use objc2::runtime::AnyObject;

    let Ok(handle) = window.ns_window() else {
        return;
    };
    if handle.is_null() {
        return;
    }
    unsafe {
        let panel = handle as *mut AnyObject;
        let _: () = msg_send![panel, makeKeyWindow];
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn agent_hud_layout_keeps_width_stable_across_states() {
        assert_eq!(agent_hud_window_size(false, 0, false, false).0, 304.0);
        assert_eq!(agent_hud_window_size(true, 1, false, false).0, 304.0);
        assert_eq!(agent_hud_window_size(true, 3, true, false).0, 304.0);
        assert_eq!(agent_hud_window_size(false, 0, false, true).0, 304.0);
    }

    #[test]
    fn agent_hud_layout_grows_downward_for_expanded_content() {
        let collapsed = agent_hud_window_size(false, 0, false, false);
        let expanded = agent_hud_window_size(true, 1, false, false);
        let replying = agent_hud_window_size(true, 1, true, false);

        assert_eq!(collapsed.1, AGENT_HUD_COLLAPSED_WINDOW_HEIGHT);
        assert!(expanded.1 > collapsed.1);
        assert!(replying.1 > expanded.1);
    }
}
