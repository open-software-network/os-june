//! Floating meeting-recording HUD.
//!
//! A small always-on-top pill — sibling to the dictation HUD — that surfaces a
//! "still recording" signal (record dot + live waveform) whenever the main
//! window is closed or minimized mid-recording. It's a presence indicator, not
//! a control surface: clicking it reopens the app on the meeting being recorded
//! (see [`meeting_hud_reopen`]); all recording controls stay in-app.
//!
//! Unlike the dictation HUD (driven by helper-process events) the recording
//! lifecycle is owned by the React main window. This module is deliberately a
//! thin mirror: a background supervisor reads the live status straight from the
//! audio capture layer, drives the HUD's visibility against the main window's
//! state, and pumps status to the webview.
//!
//! The window is a fixed square that covers the pill in both orientations, so
//! it never resizes. The frosted surface is a real NSVisualEffectView sized to
//! the pill behind the webview (CSS `backdrop-filter` can't sample other apps'
//! pixels), and depth comes from the native NSWindow shadow.
//!
//! The pill is orientation-aware: parked in the left or right third of the
//! screen it stands upright (dot above the waveform); in the middle third it
//! lies horizontal. The supervisor watches the drag position and, once the
//! window settles, turns the *native contentView layer* a quarter turn — frost,
//! tint, dot, and waveform rotate as one unit under a single Core Animation
//! ease, so nothing can clip or drift out of sync mid-turn.

use crate::audio::capture;
use crate::domain::types::{RecordingState, RecordingStatusDto};
use std::{sync::Mutex, thread, time::Duration};
use tauri::{
    AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, PhysicalSize, State, WebviewWindow,
    WindowEvent,
};

#[cfg(target_os = "macos")]
use objc2::runtime::{AnyClass, AnyObject};

const WINDOW_LABEL: &str = "meeting-hud";

/// While a recording is live we poll fast enough for a smooth waveform; idle we
/// back off so the thread costs nothing between meetings.
const ACTIVE_TICK: Duration = Duration::from_millis(40);
const IDLE_TICK: Duration = Duration::from_millis(220);

/// Logical pill size — must agree with `.mhud` in meeting-hud.css.
const PILL_SIZE: LogicalSize<f64> = LogicalSize::new(76.0, 32.0);
/// The window is a fixed square the length of the pill (tauri.conf.json), so a
/// quarter turn always fits without resizing the native frame — the transparent
/// gutters above/below (or beside) the pill are part of the window.
const WINDOW_SIZE: LogicalSize<f64> = LogicalSize::new(76.0, 76.0);

/// How long the quarter turn takes. The easing matches the app's `--ease-out`
/// token (cubic-bezier(0.22, 1, 0.36, 1)) so the HUD moves like the rest of
/// the UI even though this animation runs in Core Animation, not CSS.
const TURN_SECS: f64 = 0.32;

/// How many supervisor ticks the window must hold still before an orientation
/// flip is applied — resizing mid-native-drag is what we're avoiding.
const SETTLE_TICKS: u32 = 4;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Zone {
    Left,
    Center,
    Right,
}

impl Zone {
    fn is_vertical(self) -> bool {
        matches!(self, Zone::Left | Zone::Right)
    }
}

pub struct MeetingHudPosition {
    /// Drag position remembered between appearances in the same process. Like
    /// the dictation HUD this is intentionally not persisted to disk — every
    /// launch resets the pill to its default anchor so it can never get
    /// stranded on a monitor that's no longer connected.
    inner: Mutex<Option<(i32, i32)>>,
}

pub struct MeetingHudState {
    /// Freshest status, so a HUD webview that loads mid-recording can paint
    /// immediately instead of waiting for the next pump.
    latest_status: Mutex<Option<RecordingStatusDto>>,
    /// Which screen third the pill currently occupies; the webview mirrors this
    /// as its layout orientation.
    zone: Mutex<Zone>,
}

pub fn setup(app: &mut tauri::App) {
    app.manage(MeetingHudPosition {
        inner: Mutex::new(None),
    });
    app.manage(MeetingHudState {
        latest_status: Mutex::new(None),
        zone: Mutex::new(Zone::Center),
    });
    if let Err(error) = configure_window(app.handle()) {
        tracing::warn!(%error, "failed to configure meeting HUD");
    }
    spawn_supervisor(app.handle().clone());
}

#[tauri::command]
pub fn meeting_hud_latest_status(state: State<'_, MeetingHudState>) -> Option<RecordingStatusDto> {
    state.latest_status.lock().ok().and_then(|g| g.clone())
}

/// Clicking the HUD reopens the app on the meeting being recorded. Activation is
/// done here in Rust because clicking a non-activating panel can't pull a
/// backgrounded app forward on its own; React then hears the emitted action and
/// navigates to the recording note.
#[tauri::command]
pub fn meeting_hud_reopen(app: AppHandle) {
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.show();
        let _ = main.unminimize();
        let _ = main.set_focus();
    }
    let _ = app.emit(
        "meeting-hud-action",
        serde_json::json!({ "action": "reopen" }),
    );
}

fn is_live(state: RecordingState) -> bool {
    matches!(
        state,
        RecordingState::Recording | RecordingState::Paused | RecordingState::Starting
    )
}

/// The HUD should take over whenever the main window can't show the in-app
/// recorder bar — i.e. it's been hidden (close button → hide) or minimized.
fn main_window_dismissed(app: &AppHandle) -> bool {
    let Some(main) = app.get_webview_window("main") else {
        return false;
    };
    let hidden = !main.is_visible().unwrap_or(true);
    let minimized = main.is_minimized().unwrap_or(false);
    hidden || minimized
}

/// Per-thread drag-settle tracker for the orientation flip.
struct ZoneTracker {
    last_position: Option<PhysicalPosition<i32>>,
    stable_ticks: u32,
    /// Settled while the button was still held — flip on release instead.
    pending_release: bool,
}

fn spawn_supervisor(app: AppHandle) {
    thread::spawn(move || {
        let mut tracker = ZoneTracker {
            last_position: None,
            stable_ticks: 0,
            pending_release: false,
        };
        loop {
            let tick = supervise(&app, &mut tracker);
            thread::sleep(tick);
        }
    });
}

fn supervise(app: &AppHandle, tracker: &mut ZoneTracker) -> Duration {
    let Some(hud) = app.get_webview_window(WINDOW_LABEL) else {
        return IDLE_TICK;
    };
    let Some(state) = app.try_state::<MeetingHudState>() else {
        return IDLE_TICK;
    };

    let status = capture::current_status();
    let live = status.filter(|status| is_live(status.state));

    let Some(status) = live else {
        // Nothing recording: make sure the pill is gone and forget the snapshot.
        if hud.is_visible().unwrap_or(false) {
            let _ = hud.hide();
        }
        if let Ok(mut guard) = state.latest_status.lock() {
            *guard = None;
        }
        tracker.last_position = None;
        return IDLE_TICK;
    };

    if let Ok(mut guard) = state.latest_status.lock() {
        *guard = Some(status.clone());
    }

    let should_show = main_window_dismissed(app);
    let visible = hud.is_visible().unwrap_or(false);
    if should_show && !visible {
        position_window(app, &hud);
        // Apply the zone for wherever the pill landed before it appears, so it
        // never flashes the wrong orientation.
        apply_zone_now(&hud, &state);
        let _ = hud.show();
    } else if !should_show && visible {
        let _ = hud.hide();
    }

    if hud.is_visible().unwrap_or(false) {
        // emit_to keeps the 25Hz status stream off the main window's bus.
        let _ = app.emit_to(WINDOW_LABEL, "meeting-hud-status", &status);
        track_zone(&hud, &state, tracker);
    }
    ACTIVE_TICK
}

/// Which third of the monitor's work area the pill center sits in.
fn zone_for(hud: &WebviewWindow) -> Option<Zone> {
    let position = hud.outer_position().ok()?;
    let size = hud.outer_size().ok()?;
    let center_x = position.x + size.width as i32 / 2;
    let center_y = position.y + size.height as i32 / 2;
    let monitor = hud
        .monitor_from_point(center_x as f64, center_y as f64)
        .ok()
        .flatten()
        .or_else(|| hud.current_monitor().ok().flatten())?;
    let work = monitor.work_area();
    let third = work.size.width as i32 / 3;
    let offset = center_x - work.position.x;
    Some(if offset < third {
        Zone::Left
    } else if offset > 2 * third {
        Zone::Right
    } else {
        Zone::Center
    })
}

/// Watch the drag position; once the window has held still for a few ticks
/// AND the mouse button is up, flip orientation if it crossed into a different
/// third. Both guards exist so we never resize mid-drag — the resize would
/// shift the pill out from under the cursor's grab point.
fn track_zone(hud: &WebviewWindow, state: &MeetingHudState, tracker: &mut ZoneTracker) {
    let Ok(position) = hud.outer_position() else {
        return;
    };
    if tracker.last_position == Some(position) {
        tracker.stable_ticks = tracker.stable_ticks.saturating_add(1);
    } else {
        tracker.last_position = Some(position);
        tracker.stable_ticks = 0;
        return;
    }
    if tracker.stable_ticks >= SETTLE_TICKS && !left_mouse_button_down() {
        // Apply once per rest: bump past the threshold so we don't re-run
        // zone math every tick while parked.
        if tracker.stable_ticks == SETTLE_TICKS || tracker.pending_release {
            tracker.pending_release = false;
            apply_zone_now(hud, state);
        }
    } else if tracker.stable_ticks >= SETTLE_TICKS {
        // Settled but still held — remember to flip on release.
        tracker.pending_release = true;
    }
}

/// Whether the left mouse button is currently held, via the window server's
/// combined session state — works regardless of which window has the cursor.
#[cfg(target_os = "macos")]
fn left_mouse_button_down() -> bool {
    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        // CGEventSourceButtonState(kCGEventSourceStateCombinedSessionState = 0,
        //                          kCGMouseButtonLeft = 0)
        fn CGEventSourceButtonState(state_id: i32, button: u32) -> bool;
    }
    unsafe { CGEventSourceButtonState(0, 0) }
}

#[cfg(not(target_os = "macos"))]
fn left_mouse_button_down() -> bool {
    false
}

/// Recompute the zone and, if it changed, turn the pill to the new orientation.
/// The whole turn is one Core Animation transform on the native contentView —
/// frost, tint, dot, and waveform rotate together, so nothing clips against the
/// frame or drifts out of sync (the window itself never resizes).
fn apply_zone_now(hud: &WebviewWindow, state: &MeetingHudState) {
    let Some(zone) = zone_for(hud) else {
        return;
    };
    let previous = state
        .zone
        .lock()
        .map(|mut guard| std::mem::replace(&mut *guard, zone))
        .unwrap_or(Zone::Center);
    if previous == zone || previous.is_vertical() == zone.is_vertical() {
        return;
    }
    let animate = hud.is_visible().unwrap_or(false);
    set_orientation(hud, zone.is_vertical(), animate);
}

/// Rotate the window's contentView (webview + frost) a quarter turn via Core
/// Animation. Runs the AppKit calls on the main thread; the native window
/// shadow is recomputed once the turn lands.
#[cfg(target_os = "macos")]
fn set_orientation(hud: &WebviewWindow, vertical: bool, animate: bool) {
    let window = hud.clone();
    let _ = hud.run_on_main_thread(move || unsafe {
        rotate_content(&window, vertical, animate);
    });
    if animate {
        // The shadow shape is derived from the rendered content; refresh it
        // after the turn settles, off-thread so the status pump never stalls.
        let window = hud.clone();
        thread::spawn(move || {
            thread::sleep(Duration::from_secs_f64(TURN_SECS + 0.06));
            let handle = window.clone();
            let _ = window.run_on_main_thread(move || unsafe {
                invalidate_shadow(&handle);
            });
        });
    }
}

#[cfg(not(target_os = "macos"))]
fn set_orientation(_hud: &WebviewWindow, _vertical: bool, _animate: bool) {}

fn configure_window(app: &AppHandle) -> Result<(), String> {
    if let Some(hud) = app.get_webview_window(WINDOW_LABEL) {
        hud.set_always_on_top(true)
            .map_err(|error| error.to_string())?;
        hud.set_visible_on_all_workspaces(true)
            .map_err(|error| error.to_string())?;
        hud.set_focusable(false)
            .map_err(|error| error.to_string())?;
        hud.set_skip_taskbar(true)
            .map_err(|error| error.to_string())?;
        // The window is exactly the pill, so depth comes from the native
        // window shadow instead of a CSS one painted into a gutter.
        hud.set_shadow(true).map_err(|error| error.to_string())?;

        #[cfg(target_os = "macos")]
        {
            make_nonactivating(&hud);
            // Real behind-window blur, sized to the pill (not the window — the
            // square window's gutters stay fully transparent). Done by hand
            // rather than via window_vibrancy, which always fills the window.
            unsafe { install_frost(&hud) };
        }

        let app_for_events = app.clone();
        hud.on_window_event(move |event| {
            if let WindowEvent::Moved(position) = event {
                if let Some(state) = app_for_events.try_state::<MeetingHudPosition>() {
                    if let Ok(mut guard) = state.inner.lock() {
                        *guard = Some((position.x, position.y));
                    }
                }
            }
        });
    }
    Ok(())
}

fn position_window(app: &AppHandle, hud: &WebviewWindow) {
    let Ok(window_size) = hud.outer_size() else {
        return;
    };

    if let Some(state) = app.try_state::<MeetingHudPosition>() {
        let saved = state.inner.lock().ok().and_then(|guard| *guard);
        if let Some((x, y)) = saved {
            if position_is_visible(hud, x, y, window_size) {
                let _ = hud.set_position(PhysicalPosition::new(x, y));
                return;
            }
        }
    }

    if let Some((x, y)) = default_position(hud, window_size) {
        let _ = hud.set_position(PhysicalPosition::new(x, y));
    }
}

fn default_position(hud: &WebviewWindow, window_size: PhysicalSize<u32>) -> Option<(i32, i32)> {
    const BOTTOM_MARGIN: i32 = 16;

    let monitor = hud
        .cursor_position()
        .ok()
        .and_then(|cursor| hud.monitor_from_point(cursor.x, cursor.y).ok().flatten())
        .or_else(|| hud.current_monitor().ok().flatten())
        .or_else(|| hud.primary_monitor().ok().flatten())?;

    let work_area = monitor.work_area();
    let work_bottom = work_area.position.y + work_area.size.height as i32;
    let work_center_x = work_area.position.x + work_area.size.width as i32 / 2;

    // The visible pill sits centered in the square window; discount the
    // transparent gutter below it so the margin is measured from the pill.
    let scale = hud.scale_factor().unwrap_or(1.0);
    let gutter = ((WINDOW_SIZE.height - PILL_SIZE.height) / 2.0 * scale).round() as i32;

    let x = work_center_x - window_size.width as i32 / 2;
    let y = work_bottom - BOTTOM_MARGIN - window_size.height as i32 + gutter;
    Some((x, y))
}

fn position_is_visible(
    hud: &WebviewWindow,
    x: i32,
    y: i32,
    window_size: PhysicalSize<u32>,
) -> bool {
    const MIN_OVERLAP_PX: i32 = 24;
    let Ok(monitors) = hud.available_monitors() else {
        return false;
    };
    let pill_w = window_size.width as i32;
    let pill_h = window_size.height as i32;
    monitors.iter().any(|monitor| {
        let work = monitor.work_area();
        let mx = work.position.x;
        let my = work.position.y;
        let mw = work.size.width as i32;
        let mh = work.size.height as i32;
        let overlap_x = (x + pill_w).min(mx + mw) - x.max(mx);
        let overlap_y = (y + pill_h).min(my + mh) - y.max(my);
        overlap_x >= MIN_OVERLAP_PX && overlap_y >= MIN_OVERLAP_PX
    })
}

/// The NSWindow's contentView as a raw object, or null.
#[cfg(target_os = "macos")]
unsafe fn content_view(hud: &WebviewWindow) -> (*mut AnyObject, *mut AnyObject) {
    use objc2::msg_send;

    let Ok(handle) = hud.ns_window() else {
        return (std::ptr::null_mut(), std::ptr::null_mut());
    };
    if handle.is_null() {
        return (std::ptr::null_mut(), std::ptr::null_mut());
    }
    let window = handle as *mut AnyObject;
    let content: *mut AnyObject = msg_send![window, contentView];
    (window, content)
}

/// macOS: add an NSVisualEffectView behind the webview, framed to the pill
/// rather than the window, so the square window's gutters stay fully
/// transparent. Hand-rolled instead of `window_vibrancy::apply_vibrancy`
/// because that always fills the window.
#[cfg(target_os = "macos")]
unsafe fn install_frost(hud: &WebviewWindow) {
    use objc2::msg_send;
    use objc2_foundation::{NSPoint, NSRect, NSSize};

    /// Must match the pill's CSS border-radius (--r-lg, 10px) so tint and
    /// frost trace the same curve.
    const FROST_RADIUS: f64 = 10.0;

    let (_, content) = content_view(hud);
    if content.is_null() {
        return;
    }
    // The contentView hosts the orientation turn (`rotate_content`); give it a
    // layer up front so the first turn doesn't switch rendering paths mid-use.
    let _: () = msg_send![content, setWantsLayer: true];

    let Some(effect_class) = AnyClass::get(c"NSVisualEffectView") else {
        return;
    };
    let frame = NSRect::new(
        NSPoint::new(
            (WINDOW_SIZE.width - PILL_SIZE.width) / 2.0,
            (WINDOW_SIZE.height - PILL_SIZE.height) / 2.0,
        ),
        NSSize::new(PILL_SIZE.width, PILL_SIZE.height),
    );
    let frost: *mut AnyObject = msg_send![effect_class, alloc];
    let frost: *mut AnyObject = msg_send![frost, initWithFrame: frame];
    if frost.is_null() {
        return;
    }
    // HUDWindow material, behind-window blending, always active — the same
    // look the dictation HUD gets from window_vibrancy.
    let _: () = msg_send![frost, setMaterial: 13isize];
    let _: () = msg_send![frost, setBlendingMode: 0isize];
    let _: () = msg_send![frost, setState: 1isize];
    let _: () = msg_send![frost, setWantsLayer: true];
    let layer: *mut AnyObject = msg_send![frost, layer];
    if !layer.is_null() {
        let _: () = msg_send![layer, setCornerRadius: FROST_RADIUS];
        let _: () = msg_send![layer, setMasksToBounds: true];
    }
    // Below the webview (NSWindowBelow = -1) so the CSS tint paints over it.
    let _: () = msg_send![content, addSubview: frost, positioned: -1isize, relativeTo: std::ptr::null_mut::<AnyObject>()];
}

/// Turn the contentView's layer between flat (0°) and upright (90°). Because
/// the frost view and the webview are both subviews, one transform carries the
/// blur, tint, dot, and waveform together — they can't desync or clip.
#[cfg(target_os = "macos")]
unsafe fn rotate_content(hud: &WebviewWindow, vertical: bool, animate: bool) {
    use objc2::msg_send;
    use objc2::runtime::MessageReceiver;
    use objc2::sel;
    use objc2_foundation::{NSNumber, NSPoint, NSRect, NSString};

    let (window, content) = content_view(hud);
    if content.is_null() {
        return;
    }
    let layer: *mut AnyObject = msg_send![content, layer];
    if layer.is_null() {
        return;
    }

    // Rotate about the window's center. AppKit anchors view layers at their
    // corner, so re-center the anchor (re-asserted every turn — layout passes
    // can reset layer geometry).
    let frame: NSRect = msg_send![content, frame];
    let _: () = msg_send![layer, setAnchorPoint: NSPoint::new(0.5, 0.5)];
    let _: () = msg_send![layer, setPosition: NSPoint::new(
        frame.origin.x + frame.size.width / 2.0,
        frame.origin.y + frame.size.height / 2.0,
    )];

    // CA's +z spins counterclockwise (y-up), so -90° swings the pill's left
    // end — the record dot — to the top, matching the old CSS rotate(90deg).
    let angle = if vertical {
        -std::f64::consts::FRAC_PI_2
    } else {
        0.0
    };
    let key = NSString::from_str("transform.rotation.z");
    let target = NSNumber::new_f64(angle);

    if animate {
        if let (Some(animation_class), Some(timing_class)) = (
            AnyClass::get(c"CABasicAnimation"),
            AnyClass::get(c"CAMediaTimingFunction"),
        ) {
            let animation: *mut AnyObject = msg_send![animation_class, animationWithKeyPath: &*key];
            if !animation.is_null() {
                // Start from wherever the layer visibly is right now, so a
                // turn reversed mid-flight doubles back smoothly.
                let presentation: *mut AnyObject = msg_send![layer, presentationLayer];
                let source = if presentation.is_null() {
                    layer
                } else {
                    presentation
                };
                let from: *mut AnyObject = msg_send![source, valueForKeyPath: &*key];
                let _: () = msg_send![animation, setFromValue: from];
                let _: () = msg_send![animation, setToValue: &*target];
                let _: () = msg_send![animation, setDuration: TURN_SECS];
                // --ease-out from tokens.css; `functionWithControlPoints::::`
                // has bare colons msg_send! can't spell, hence send_message.
                let timing: *mut AnyObject = (timing_class as *const AnyClass as *mut AnyObject)
                    .send_message(
                        sel!(functionWithControlPoints::::),
                        (0.22f32, 1.0f32, 0.36f32, 1.0f32),
                    );
                if !timing.is_null() {
                    let _: () = msg_send![animation, setTimingFunction: timing];
                }
                let _: () = msg_send![layer, addAnimation: animation, forKey: &*key];
            }
        }
    }

    // Commit the model value with implicit actions off — the explicit
    // animation above (when any) owns the visible motion.
    if let Some(transaction) = AnyClass::get(c"CATransaction") {
        let _: () = msg_send![transaction, begin];
        let _: () = msg_send![transaction, setDisableActions: true];
        let _: () = msg_send![layer, setValue: &*target, forKeyPath: &*key];
        let _: () = msg_send![transaction, commit];
    } else {
        let _: () = msg_send![layer, setValue: &*target, forKeyPath: &*key];
    }
    if !animate && !window.is_null() {
        let _: () = msg_send![window, invalidateShadow];
    }
}

/// Ask AppKit to recompute the window shadow from the rendered content — the
/// shape changed when the pill turned.
#[cfg(target_os = "macos")]
unsafe fn invalidate_shadow(hud: &WebviewWindow) {
    use objc2::msg_send;

    let (window, _) = content_view(hud);
    if !window.is_null() {
        let _: () = msg_send![window, invalidateShadow];
    }
}

/// macOS: reclass the HUD's NSWindow to a non-activating NSPanel so clicking the
/// pill or its buttons never steals focus from the meeting app underneath.
/// Mirrors `dictation.rs::make_hud_nonactivating`.
#[cfg(target_os = "macos")]
fn make_nonactivating(hud: &WebviewWindow) {
    use objc2::msg_send;

    let Ok(handle) = hud.ns_window() else {
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

        // NSWindowStyleMaskNonactivatingPanel = 1 << 7.
        const NON_ACTIVATING: usize = 1 << 7;
        let current_mask: usize = msg_send![window, styleMask];
        let _: () = msg_send![window, setStyleMask: current_mask | NON_ACTIVATING];

        let _: () = msg_send![window, setAcceptsMouseMovedEvents: true];
        let _: () = msg_send![window, setBecomesKeyOnlyIfNeeded: true];
    }
}
