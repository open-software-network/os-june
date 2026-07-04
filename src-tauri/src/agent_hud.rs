use serde::{Deserialize, Serialize};
use serde_json::json;
use std::sync::Mutex;
use tauri::{
    AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, Size, State, WebviewWindow,
};

const AGENT_HUD_WINDOW_LABEL: &str = "agent-hud";
const MAIN_WINDOW_LABEL: &str = "main";
const AGENT_OPEN_EVENT: &str = "june:agent:open";
// Fired at the webview when the panel swallows a right- or ctrl-click so the
// in-DOM menu can open. Mirrored by the listener in src/agent-hud.ts.
const AGENT_HUD_CONTEXT_MENU_EVENT: &str = "june:agent-hud:context-menu";
const AGENT_HUD_WINDOW_WIDTH: f64 = 304.0;
const AGENT_HUD_COLLAPSED_WINDOW_HEIGHT: f64 = 58.0;
// Notch dock geometry (logical points). The window spans the camera housing
// plus a wing on either side for the pill content; the bar extends a chin
// below the housing so the surface's rounded bottom corners read as the
// notch flowing out, not a rectangle taped over it. The webview mirrors the
// chin in NOTCH_CHIN_HEIGHT (src/agent-hud.ts) to size the bar in CSS.
const NOTCH_WING_WIDTH: f64 = 132.0;
const NOTCH_CHIN_HEIGHT: f64 = 10.0;
// Height floor while the context menu is open in notch mode, mirroring the
// 104px minimum of the top-right placement below the bar.
const NOTCH_MENU_MIN_DROP: f64 = 104.0;

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
    placement: Option<AgentHudPlacement>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AgentHudPlacement {
    #[default]
    TopRight,
    Notch,
}

/// The last placement the webview asked for. The preference itself lives in
/// the webview's localStorage (agent-hud-settings.ts); the native side only
/// remembers it so agent_hud_show can re-position without a layout request.
#[derive(Default)]
pub struct AgentHudState {
    placement: Mutex<AgentHudPlacement>,
}

/// Camera-housing metrics of the notched built-in display, in logical points
/// (the webview's CSS pixels). None on displays without a notch.
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentHudNotchInfo {
    notch_width: f64,
    notch_height: f64,
}

pub fn setup(app: &mut tauri::App) {
    #[cfg(target_os = "macos")]
    let _ = AGENT_HUD_APP.set(app.handle().clone());
    app.manage(AgentHudState::default());
    if let Err(error) = configure_agent_hud_window(app.handle()) {
        tracing::warn!(%error, "failed to configure agent HUD");
    }
}

#[tauri::command]
pub fn agent_hud_show(app: AppHandle, state: State<AgentHudState>) -> Result<(), String> {
    let Some(window) = app.get_webview_window(AGENT_HUD_WINDOW_LABEL) else {
        return Ok(());
    };
    let placement = current_placement(&state);
    position_agent_hud_window(&window, placement)?;
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
pub fn agent_hud_set_layout(
    app: AppHandle,
    state: State<AgentHudState>,
    request: AgentHudLayoutRequest,
) -> Result<(), String> {
    let Some(window) = app.get_webview_window(AGENT_HUD_WINDOW_LABEL) else {
        return Ok(());
    };
    let placement = if let Some(requested) = request.placement {
        if let Ok(mut placement) = state.placement.lock() {
            *placement = requested;
        }
        requested
    } else {
        current_placement(&state)
    };
    let (width, height) = agent_hud_layout_size(
        placement,
        notch_metrics(),
        request.expanded,
        request.card_count.unwrap_or(0),
        request.context_menu_open.unwrap_or(false),
    );
    window
        .set_size(Size::Logical(LogicalSize::new(width, height)))
        .map_err(|error| error.to_string())?;
    // Both placements keep a fixed width per screen and grow downward from a
    // pinned top edge, so resizing alone cannot move the anchor; still
    // reposition with the size just requested (not outer_size(), which can
    // lag behind set_size() on macOS) so a placement change lands in the
    // same call that resized for it.
    position_agent_hud_window_with_logical_size(&window, placement, (width, height))
}

fn current_placement(state: &State<AgentHudState>) -> AgentHudPlacement {
    state
        .placement
        .lock()
        .map(|placement| *placement)
        .unwrap_or_default()
}

/// Camera-housing metrics for the webview: it carves the notch span out of
/// the pill so no content sits under the bezel. None means no notched
/// display is attached and notch placement falls back to a floating pill.
#[tauri::command]
pub fn agent_hud_notch_info() -> Option<AgentHudNotchInfo> {
    notch_metrics()
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
fn agent_hud_window_size(expanded: bool, card_count: u32, context_menu_open: bool) -> (f64, f64) {
    let height: f64 = if !expanded || card_count == 0 {
        AGENT_HUD_COLLAPSED_WINDOW_HEIGHT
    } else {
        let rows = f64::from(card_count.min(3));
        let surface_height = 36.0 + rows * 46.0 + 6.0;
        8.0 + surface_height + 14.0
    };

    if context_menu_open {
        (AGENT_HUD_WINDOW_WIDTH, height.max(104.0))
    } else {
        (AGENT_HUD_WINDOW_WIDTH, height)
    }
}

fn agent_hud_layout_size(
    placement: AgentHudPlacement,
    notch: Option<AgentHudNotchInfo>,
    expanded: bool,
    card_count: u32,
    context_menu_open: bool,
) -> (f64, f64) {
    match (placement, notch) {
        (AgentHudPlacement::Notch, Some(notch)) => {
            agent_hud_notch_window_size(notch, expanded, card_count, context_menu_open)
        }
        // Notch placement without a notched display floats a top-center
        // pill of the regular geometry instead.
        _ => agent_hud_window_size(expanded, card_count, context_menu_open),
    }
}

/// Docked geometry: the window spans the camera housing plus a wing per side,
/// the collapsed bar is the housing height plus a rounded chin, and expansion
/// drops the session rows below the housing. Same row math as the top-right
/// placement so the two modes stay visually interchangeable.
fn agent_hud_notch_window_size(
    notch: AgentHudNotchInfo,
    expanded: bool,
    card_count: u32,
    context_menu_open: bool,
) -> (f64, f64) {
    let width = notch.notch_width + 2.0 * NOTCH_WING_WIDTH;
    let bar_height = notch.notch_height + NOTCH_CHIN_HEIGHT;
    // The +14 is the transparent gutter below the surface that the CSS
    // shadow paints into, matching the top-right geometry.
    let height = if !expanded || card_count == 0 {
        bar_height + 14.0
    } else {
        let rows = f64::from(card_count.min(3));
        bar_height + rows * 46.0 + 14.0
    };

    if context_menu_open {
        (width, height.max(bar_height + NOTCH_MENU_MIN_DROP))
    } else {
        (width, height)
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

    position_agent_hud_window(&window, AgentHudPlacement::default())
}

fn position_agent_hud_window(
    window: &WebviewWindow,
    placement: AgentHudPlacement,
) -> Result<(), String> {
    let size = window.outer_size().map_err(|error| error.to_string())?;
    let scale = window.scale_factor().map_err(|error| error.to_string())?;
    let logical = (
        f64::from(size.width) / scale,
        f64::from(size.height) / scale,
    );
    position_agent_hud_window_with_logical_size(window, placement, logical)
}

fn position_agent_hud_window_with_logical_size(
    window: &WebviewWindow,
    placement: AgentHudPlacement,
    logical_size: (f64, f64),
) -> Result<(), String> {
    if placement == AgentHudPlacement::Notch {
        #[cfg(target_os = "macos")]
        {
            if position_agent_hud_over_notch(window, logical_size) {
                set_agent_hud_docked(window, true);
                return Ok(());
            }
            // No notched display attached (external-only setup, older Mac):
            // float the pill at the top center instead so the preference
            // still means "center of my screen, out of the corner".
            set_agent_hud_docked(window, false);
        }
        return position_agent_hud_window_top_center(window, logical_size);
    }
    #[cfg(target_os = "macos")]
    set_agent_hud_docked(window, false);
    position_agent_hud_window_top_right(window, logical_size)
}

fn position_agent_hud_window_top_right(
    window: &WebviewWindow,
    logical_size: (f64, f64),
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
    let width = (logical_size.0 * scale).round() as i32;
    let margin_x = (MARGIN_X * scale).round() as i32;
    let margin_y = (MARGIN_Y * scale).round() as i32;
    let x = work_area.position.x + work_area.size.width as i32 - width - margin_x;
    let y = work_area.position.y + margin_y;
    window
        .set_position(PhysicalPosition::new(x, y))
        .map_err(|error| error.to_string())
}

/// The notch-placement fallback for notchless displays: centered under the
/// menu bar of the primary monitor, mirroring the dictation HUD's default
/// top-center spot.
fn position_agent_hud_window_top_center(
    window: &WebviewWindow,
    logical_size: (f64, f64),
) -> Result<(), String> {
    const MARGIN_Y: f64 = 12.0;

    let scale = window.scale_factor().map_err(|error| error.to_string())?;
    let monitor = window
        .primary_monitor()
        .ok()
        .flatten()
        .or_else(|| window.current_monitor().ok().flatten());
    let Some(monitor) = monitor else {
        return Ok(());
    };

    let work_area = monitor.work_area();
    let width = (logical_size.0 * scale).round() as i32;
    let margin_y = (MARGIN_Y * scale).round() as i32;
    let x = work_area.position.x + (work_area.size.width as i32 - width) / 2;
    let y = work_area.position.y + margin_y;
    window
        .set_position(PhysicalPosition::new(x, y))
        .map_err(|error| error.to_string())
}

/// Metrics of the notched display, if one is attached. Only the built-in
/// panel of notched MacBooks reports a top safe-area inset; external
/// displays never do, so this also answers "is there a notch to dock to".
fn notch_metrics() -> Option<AgentHudNotchInfo> {
    #[cfg(target_os = "macos")]
    {
        notched_screen().map(|(info, _)| info)
    }
    #[cfg(not(target_os = "macos"))]
    {
        None
    }
}

/// Finds the NSScreen with a camera housing and returns its notch metrics
/// (logical points) plus the screen's frame in Cocoa global coordinates.
/// safeAreaInsets/auxiliaryTopLeftArea exist from macOS 12; earlier systems
/// answer None via the respondsToSelector guard.
#[cfg(target_os = "macos")]
fn notched_screen() -> Option<(AgentHudNotchInfo, objc2_foundation::NSRect)> {
    use objc2::runtime::{AnyClass, AnyObject};
    use objc2::{msg_send, sel};
    use objc2_foundation::{NSEdgeInsets, NSRect};

    unsafe {
        let screen_class = AnyClass::get(c"NSScreen")?;
        let screens: *mut AnyObject = msg_send![screen_class, screens];
        if screens.is_null() {
            return None;
        }
        let count: usize = msg_send![screens, count];
        for index in 0..count {
            let screen: *mut AnyObject = msg_send![screens, objectAtIndex: index];
            if screen.is_null() {
                continue;
            }
            let responds: bool = msg_send![screen, respondsToSelector: sel!(safeAreaInsets)];
            if !responds {
                return None;
            }
            let insets: NSEdgeInsets = msg_send![screen, safeAreaInsets];
            if insets.top <= 0.0 {
                continue;
            }
            let frame: NSRect = msg_send![screen, frame];
            let left: NSRect = msg_send![screen, auxiliaryTopLeftArea];
            let right: NSRect = msg_send![screen, auxiliaryTopRightArea];
            let notch_width = (frame.size.width - left.size.width - right.size.width).max(0.0);
            if notch_width <= 0.0 {
                continue;
            }
            return Some((
                AgentHudNotchInfo {
                    notch_width,
                    notch_height: insets.top,
                },
                frame,
            ));
        }
        None
    }
}

/// Docks the window over the camera housing: horizontally centered on the
/// notched screen, flush with its top edge. Positions in Cocoa global points
/// via setFrameOrigin: so no Tauri/AppKit coordinate conversion is involved.
/// Returns false when no notched display is attached.
#[cfg(target_os = "macos")]
fn position_agent_hud_over_notch(window: &WebviewWindow, logical_size: (f64, f64)) -> bool {
    use objc2::msg_send;
    use objc2::runtime::AnyObject;
    use objc2_foundation::NSPoint;

    let Some((_, frame)) = notched_screen() else {
        return false;
    };
    let Ok(handle) = window.ns_window() else {
        return false;
    };
    if handle.is_null() {
        return false;
    }
    let x = frame.origin.x + (frame.size.width - logical_size.0) / 2.0;
    let y = frame.origin.y + frame.size.height - logical_size.1;
    unsafe {
        let win = handle as *mut AnyObject;
        let _: () = msg_send![win, setFrameOrigin: NSPoint::new(x, y)];
    }
    true
}

/// Raises the panel above the menu bar while docked in the notch (Tauri's
/// always-on-top floating level sits below it) and keeps it present over
/// full-screen apps, where the notch strip stays black anyway. Undocking
/// restores the floating level so the HUD behaves like the other overlays.
#[cfg(target_os = "macos")]
fn set_agent_hud_docked(window: &WebviewWindow, docked: bool) {
    use objc2::msg_send;
    use objc2::runtime::AnyObject;

    // AppKit window levels: NSFloatingWindowLevel = 3 (what Tauri's
    // set_always_on_top applies), NSStatusWindowLevel = 25 (above
    // NSMainMenuWindowLevel = 24, the menu bar / notch strip).
    const FLOATING_LEVEL: isize = 3;
    const STATUS_LEVEL: isize = 25;
    // NSWindowCollectionBehavior bits beyond canJoinAllSpaces (already set
    // via visibleOnAllWorkspaces): stationary keeps the bar parked during
    // Exposé, fullScreenAuxiliary lets it join full-screen spaces.
    const STATIONARY: usize = 1 << 4;
    const FULL_SCREEN_AUXILIARY: usize = 1 << 8;

    let Ok(handle) = window.ns_window() else {
        return;
    };
    if handle.is_null() {
        return;
    }
    unsafe {
        let win = handle as *mut AnyObject;
        let level: isize = if docked { STATUS_LEVEL } else { FLOATING_LEVEL };
        let _: () = msg_send![win, setLevel: level];
        let behavior: usize = msg_send![win, collectionBehavior];
        let behavior = if docked {
            behavior | STATIONARY | FULL_SCREEN_AUXILIARY
        } else {
            behavior & !(STATIONARY | FULL_SCREEN_AUXILIARY)
        };
        let _: () = msg_send![win, setCollectionBehavior: behavior];
    }
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
        assert_eq!(agent_hud_window_size(false, 0, false).0, 304.0);
        assert_eq!(agent_hud_window_size(true, 1, false).0, 304.0);
        assert_eq!(agent_hud_window_size(true, 3, false).0, 304.0);
        assert_eq!(agent_hud_window_size(false, 0, true).0, 304.0);
    }

    #[test]
    fn agent_hud_layout_grows_downward_for_expanded_content() {
        let collapsed = agent_hud_window_size(false, 0, false);
        let expanded = agent_hud_window_size(true, 1, false);
        let expanded_more = agent_hud_window_size(true, 3, false);

        assert_eq!(collapsed.1, AGENT_HUD_COLLAPSED_WINDOW_HEIGHT);
        assert!(expanded.1 > collapsed.1);
        assert!(expanded_more.1 > expanded.1);
    }

    // A 14" MacBook Pro-shaped notch at default scaling.
    fn notch_fixture() -> AgentHudNotchInfo {
        AgentHudNotchInfo {
            notch_width: 200.0,
            notch_height: 32.0,
        }
    }

    #[test]
    fn notch_layout_spans_the_housing_plus_wings_at_a_stable_width() {
        let notch = notch_fixture();
        let expected_width = 200.0 + 2.0 * NOTCH_WING_WIDTH;
        assert_eq!(
            agent_hud_notch_window_size(notch, false, 0, false).0,
            expected_width
        );
        assert_eq!(
            agent_hud_notch_window_size(notch, true, 3, false).0,
            expected_width
        );
        assert_eq!(
            agent_hud_notch_window_size(notch, false, 0, true).0,
            expected_width
        );
    }

    #[test]
    fn notch_layout_collapses_to_the_housing_height_plus_chin_and_grows_downward() {
        let notch = notch_fixture();
        let collapsed = agent_hud_notch_window_size(notch, false, 0, false);
        let expanded = agent_hud_notch_window_size(notch, true, 1, false);
        let expanded_more = agent_hud_notch_window_size(notch, true, 3, false);

        assert_eq!(collapsed.1, 32.0 + NOTCH_CHIN_HEIGHT + 14.0);
        assert!(expanded.1 > collapsed.1);
        assert!(expanded_more.1 > expanded.1);
    }

    #[test]
    fn notch_layout_keeps_room_for_the_context_menu() {
        let notch = notch_fixture();
        let with_menu = agent_hud_notch_window_size(notch, false, 0, true);
        assert_eq!(with_menu.1, 32.0 + NOTCH_CHIN_HEIGHT + NOTCH_MENU_MIN_DROP);
    }

    #[test]
    fn layout_size_falls_back_to_the_floating_geometry_without_a_notch() {
        assert_eq!(
            agent_hud_layout_size(AgentHudPlacement::Notch, None, false, 0, false),
            agent_hud_window_size(false, 0, false)
        );
        assert_eq!(
            agent_hud_layout_size(
                AgentHudPlacement::TopRight,
                Some(notch_fixture()),
                true,
                2,
                false
            ),
            agent_hud_window_size(true, 2, false)
        );
    }
}
