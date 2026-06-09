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
//! The window is sized exactly to the pill — no transparent gutter — so the
//! whole window is the click/drag target, depth comes from the native NSWindow
//! shadow, and the frosted surface is a real NSVisualEffectView behind the
//! webview (CSS `backdrop-filter` can't sample other apps' pixels).
//!
//! The pill is orientation-aware: parked in the left or right third of the
//! screen it flips to a vertical layout (dot above a short waveform); in the
//! middle third it lies horizontal. The supervisor watches the drag position
//! and applies the flip once the window settles, resizing around the pill's
//! center.

use crate::audio::capture;
use crate::domain::types::{RecordingState, RecordingStatusDto};
use std::{
    sync::Mutex,
    thread,
    time::Duration,
};
use tauri::{
    AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, PhysicalSize, State,
    WebviewWindow, WindowEvent,
};

const WINDOW_LABEL: &str = "meeting-hud";

/// While a recording is live we poll fast enough for a smooth waveform; idle we
/// back off so the thread costs nothing between meetings.
const ACTIVE_TICK: Duration = Duration::from_millis(40);
const IDLE_TICK: Duration = Duration::from_millis(220);

/// Logical pill sizes per orientation. Must agree with the layout math in
/// meeting-hud.css (dot 9 + gap 10 + bars, centered with 14px margins).
const HORIZONTAL_SIZE: LogicalSize<f64> = LogicalSize::new(76.0, 32.0);
const VERTICAL_SIZE: LogicalSize<f64> = LogicalSize::new(32.0, 64.0);

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
    fn as_str(self) -> &'static str {
        match self {
            Zone::Left => "left",
            Zone::Center => "center",
            Zone::Right => "right",
        }
    }

    fn size(self) -> LogicalSize<f64> {
        match self {
            Zone::Center => HORIZONTAL_SIZE,
            Zone::Left | Zone::Right => VERTICAL_SIZE,
        }
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

/// The webview fetches this once on load so a HUD that boots while parked in a
/// side zone starts vertical instead of waiting for the next flip.
#[tauri::command]
pub fn meeting_hud_current_zone(state: State<'_, MeetingHudState>) -> String {
    state
        .zone
        .lock()
        .map(|zone| zone.as_str().to_string())
        .unwrap_or_else(|_| "center".to_string())
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
}

fn spawn_supervisor(app: AppHandle) {
    thread::spawn(move || {
        let mut tracker = ZoneTracker {
            last_position: None,
            stable_ticks: 0,
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

/// Watch the drag position; once the window has held still for a few ticks,
/// flip orientation if it crossed into a different third. Waiting for the
/// settle keeps us from resizing in the middle of a native drag session.
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
    if tracker.stable_ticks == SETTLE_TICKS {
        apply_zone_now(hud, state);
    }
}

/// Recompute the zone and, if it changed, resize around the pill's center and
/// tell the webview to re-lay itself out.
fn apply_zone_now(hud: &WebviewWindow, state: &MeetingHudState) {
    let Some(zone) = zone_for(hud) else {
        return;
    };
    let previous = state
        .zone
        .lock()
        .map(|mut guard| std::mem::replace(&mut *guard, zone))
        .unwrap_or(Zone::Center);
    if previous == zone {
        return;
    }

    if previous.size() != zone.size() {
        resize_preserving_center(hud, zone.size());
    }
    let _ = hud.emit_to(WINDOW_LABEL, "meeting-hud-zone", zone.as_str());
}

fn resize_preserving_center(hud: &WebviewWindow, size: LogicalSize<f64>) {
    let (Ok(position), Ok(old_size), Ok(scale)) =
        (hud.outer_position(), hud.outer_size(), hud.scale_factor())
    else {
        return;
    };
    let new_size = PhysicalSize::new(
        (size.width * scale).round() as u32,
        (size.height * scale).round() as u32,
    );
    let x = position.x + (old_size.width as i32 - new_size.width as i32) / 2;
    let y = position.y + (old_size.height as i32 - new_size.height as i32) / 2;
    let _ = hud.set_size(new_size);
    let _ = hud.set_position(PhysicalPosition::new(x, y));
}

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
            // Real behind-window blur. The radius must match the pill's CSS
            // border-radius (--r-lg, 10px) so the frosted layer and the
            // painted border trace the same curve.
            use window_vibrancy::{apply_vibrancy, NSVisualEffectMaterial, NSVisualEffectState};
            if let Err(error) = apply_vibrancy(
                &hud,
                NSVisualEffectMaterial::HudWindow,
                Some(NSVisualEffectState::Active),
                Some(10.0),
            ) {
                tracing::warn!(%error, "failed to apply meeting HUD vibrancy");
            }
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

    let x = work_center_x - window_size.width as i32 / 2;
    let y = work_bottom - BOTTOM_MARGIN - window_size.height as i32;
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
