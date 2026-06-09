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
//! ease, so nothing can clip or drift out of sync mid-turn. The one exception:
//! the webview counter-rotates the bars (CSS, same duration/curve) so the
//! waveform itself still reads left-to-right when the pill stands upright.

use crate::audio::capture;
use crate::domain::types::{RecordingState, RecordingStatusDto};
use crate::hud_native::{self, zone_for, Zone, TURN_SECS};
use std::{sync::Mutex, thread, time::Duration};
use tauri::{
    AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, PhysicalSize, State, WebviewWindow,
    WindowEvent,
};

const WINDOW_LABEL: &str = "meeting-hud";

/// While a recording is live we poll fast enough for a smooth waveform; idle we
/// back off so the thread costs nothing between meetings.
const ACTIVE_TICK: Duration = Duration::from_millis(40);
const IDLE_TICK: Duration = Duration::from_millis(220);

/// Logical pill size — must agree with `.mhud` in meeting-hud.css.
const PILL_SIZE: LogicalSize<f64> = LogicalSize::new(76.0, 32.0);
/// Upright the pill carries less (4 bars instead of 7), so it runs shorter.
/// Must agree with `.mhud[data-orient="vertical"]` in meeting-hud.css.
#[cfg(target_os = "macos")]
const VERTICAL_PILL_LENGTH: f64 = 62.0;
/// The window is a fixed square the length of the pill (tauri.conf.json), so a
/// quarter turn always fits without resizing the native frame — the transparent
/// gutters above/below (or beside) the pill are part of the window.
const WINDOW_SIZE: LogicalSize<f64> = LogicalSize::new(76.0, 76.0);

/// How many supervisor ticks the window must hold still before an orientation
/// flip is applied — resizing mid-native-drag is what we're avoiding.
const SETTLE_TICKS: u32 = 4;

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
    if tracker.stable_ticks >= SETTLE_TICKS && !hud_native::left_mouse_button_down() {
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

/// Recompute the zone and, if it changed, turn the pill to the new orientation.
/// The whole turn is one Core Animation transform on the native contentView —
/// frost, tint, dot, and waveform rotate together, so nothing clips against the
/// frame or drifts out of sync (the window itself never resizes). The webview
/// hears `meeting-hud-zone` at the same moment and counter-rotates the bars so
/// the waveform keeps reading left-to-right (meeting-hud.css).
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
    let _ = hud.emit_to(
        WINDOW_LABEL,
        "meeting-hud-zone",
        serde_json::json!({ "vertical": zone.is_vertical(), "animate": animate }),
    );
    set_orientation(hud, zone.is_vertical(), animate);
}

/// Rotate the window's contentView (webview + frost) a quarter turn via Core
/// Animation. Runs the AppKit calls on the main thread; the native window
/// shadow is recomputed once the turn lands.
#[cfg(target_os = "macos")]
fn set_orientation(hud: &WebviewWindow, vertical: bool, animate: bool) {
    use objc2_foundation::{NSPoint, NSRect, NSSize};

    let window = hud.clone();
    let _ = hud.run_on_main_thread(move || unsafe {
        let angle = if vertical {
            // CA's +z spins counterclockwise (y-up); -90° swings the pill's
            // left end — the record dot — to the top.
            -std::f64::consts::FRAC_PI_2
        } else {
            0.0
        };
        hud_native::rotate_content(&window, angle, animate);
        // The upright pill runs shorter (fewer bars); keep the frost hugging
        // it. Same duration and curve as the turn, on the same CA clock.
        let length = if vertical {
            VERTICAL_PILL_LENGTH
        } else {
            PILL_SIZE.width
        };
        let frost_frame = NSRect::new(
            NSPoint::new(
                (WINDOW_SIZE.width - length) / 2.0,
                (WINDOW_SIZE.height - PILL_SIZE.height) / 2.0,
            ),
            NSSize::new(length, PILL_SIZE.height),
        );
        hud_native::set_frost_frame(&window, frost_frame, false, animate);
    });
    if animate {
        // The shadow shape is derived from the rendered content; refresh it
        // after the turn settles, off-thread so the status pump never stalls.
        let window = hud.clone();
        thread::spawn(move || {
            thread::sleep(Duration::from_secs_f64(TURN_SECS + 0.06));
            let handle = window.clone();
            let _ = window.run_on_main_thread(move || unsafe {
                hud_native::invalidate_shadow(&handle);
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
            use objc2_foundation::{NSPoint, NSRect, NSSize};

            make_nonactivating(&hud);
            // Real behind-window blur, sized to the pill (not the window — the
            // square window's gutters stay fully transparent). The 10px radius
            // must match the pill's CSS border-radius (--r-lg).
            let pill_rect = NSRect::new(
                NSPoint::new(
                    (WINDOW_SIZE.width - PILL_SIZE.width) / 2.0,
                    (WINDOW_SIZE.height - PILL_SIZE.height) / 2.0,
                ),
                NSSize::new(PILL_SIZE.width, PILL_SIZE.height),
            );
            unsafe { hud_native::install_frost(&hud, Some(pill_rect), 10.0) };
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

/// macOS: reclass the HUD's NSWindow to a non-activating NSPanel so clicking the
/// pill or its buttons never steals focus from the meeting app underneath.
/// Mirrors `dictation.rs::make_hud_nonactivating`.
#[cfg(target_os = "macos")]
fn make_nonactivating(hud: &WebviewWindow) {
    use objc2::msg_send;
    use objc2::runtime::{AnyClass, AnyObject};

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
