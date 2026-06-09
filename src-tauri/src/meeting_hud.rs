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
//! The macOS panel plumbing (non-activating NSPanel, cursor-driven click
//! pass-through) mirrors `dictation.rs`; the two HUDs keep independent copies so
//! the dictation overlay stays untouched.

use crate::audio::capture;
use crate::domain::types::{RecordingState, RecordingStatusDto};
use serde::Deserialize;
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    thread,
    time::Duration,
};
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, State, WebviewWindow, WindowEvent,
};

const WINDOW_LABEL: &str = "meeting-hud";

/// While a recording is live we poll fast enough for a smooth waveform; idle we
/// back off so the thread costs nothing between meetings.
const ACTIVE_TICK: Duration = Duration::from_millis(40);
const IDLE_TICK: Duration = Duration::from_millis(220);

/// Drag position remembered between appearances in the same process. Like the
/// dictation HUD this is intentionally not persisted to disk — every launch
/// resets the pill to its default anchor so it can never get stranded on a
/// monitor that's no longer connected.
pub struct MeetingHudPosition {
    inner: Mutex<Option<(i32, i32)>>,
}

#[derive(Debug, Deserialize, Clone)]
pub struct MeetingHudRect {
    left: f64,
    right: f64,
    top: f64,
    bottom: f64,
}

pub struct MeetingHudState {
    /// Client-space pill rect pushed from the webview; the supervisor uses it to
    /// pass clicks through the transparent gutter to the app underneath.
    pill_bounds: Mutex<Option<MeetingHudRect>>,
    last_passthrough: AtomicBool,
    /// Freshest status, so a HUD webview that loads mid-recording can paint
    /// immediately instead of waiting for the next pump.
    latest_status: Mutex<Option<RecordingStatusDto>>,
}

pub fn setup(app: &mut tauri::App) {
    app.manage(MeetingHudPosition {
        inner: Mutex::new(None),
    });
    app.manage(MeetingHudState {
        pill_bounds: Mutex::new(None),
        last_passthrough: AtomicBool::new(true),
        latest_status: Mutex::new(None),
    });
    if let Err(error) = configure_window(app.handle()) {
        tracing::warn!(%error, "failed to configure meeting HUD");
    }
    spawn_supervisor(app.handle().clone());
}

#[tauri::command]
pub fn meeting_hud_set_pill_bounds(
    state: State<'_, MeetingHudState>,
    rect: Option<MeetingHudRect>,
) {
    if let Ok(mut guard) = state.pill_bounds.lock() {
        *guard = rect;
    }
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

fn spawn_supervisor(app: AppHandle) {
    thread::spawn(move || loop {
        let tick = supervise(&app);
        thread::sleep(tick);
    });
}

fn supervise(app: &AppHandle) -> Duration {
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
        force_passthrough(&hud, &state);
        if let Ok(mut guard) = state.latest_status.lock() {
            *guard = None;
        }
        return IDLE_TICK;
    };

    if let Ok(mut guard) = state.latest_status.lock() {
        *guard = Some(status.clone());
    }

    let should_show = main_window_dismissed(app);
    let visible = hud.is_visible().unwrap_or(false);
    if should_show && !visible {
        position_window(app, &hud);
        let _ = hud.show();
    } else if !should_show && visible {
        let _ = hud.hide();
    }

    if hud.is_visible().unwrap_or(false) {
        // emit_to keeps the 25Hz status stream off the main window's bus.
        let _ = app.emit_to(WINDOW_LABEL, "meeting-hud-status", &status);
        update_passthrough(&hud, &state);
    } else {
        force_passthrough(&hud, &state);
    }
    ACTIVE_TICK
}

fn force_passthrough(hud: &WebviewWindow, state: &MeetingHudState) {
    if !state.last_passthrough.swap(true, Ordering::Relaxed) {
        let _ = hud.set_ignore_cursor_events(true);
    }
}

/// Pass clicks through to the app underneath unless the cursor is over the pill.
fn update_passthrough(hud: &WebviewWindow, state: &MeetingHudState) {
    let pill = state.pill_bounds.lock().ok().and_then(|g| g.clone());
    let Some(pill) = pill else {
        // Don't know where the pill is yet — keep clicks flowing through.
        force_passthrough(hud, state);
        return;
    };
    let (Ok(position), Ok(scale_factor)) = (hud.outer_position(), hud.scale_factor()) else {
        return;
    };

    #[cfg(target_os = "macos")]
    let cursor = cursor_position_via_cg().map(|(x, y)| (x * scale_factor, y * scale_factor));
    #[cfg(not(target_os = "macos"))]
    let cursor = hud.cursor_position().ok().map(|p| (p.x, p.y));

    let Some((cx, cy)) = cursor else { return };
    let over_pill = rect_contains(&pill, position, scale_factor, cx, cy);
    let should_passthrough = !over_pill;
    if should_passthrough != state.last_passthrough.load(Ordering::Relaxed) {
        state
            .last_passthrough
            .store(should_passthrough, Ordering::Relaxed);
        let _ = hud.set_ignore_cursor_events(should_passthrough);
    }
}

fn rect_contains(
    rect: &MeetingHudRect,
    position: PhysicalPosition<i32>,
    scale_factor: f64,
    cx: f64,
    cy: f64,
) -> bool {
    let left = position.x as f64 + rect.left * scale_factor;
    let right = position.x as f64 + rect.right * scale_factor;
    let top = position.y as f64 + rect.top * scale_factor;
    let bottom = position.y as f64 + rect.bottom * scale_factor;
    cx >= left && cx <= right && cy >= top && cy <= bottom
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
        hud.set_shadow(false).map_err(|error| error.to_string())?;
        // Start in pass-through to match `last_passthrough = true`: until the
        // cursor is over the pill, the transparent gutter must not eat clicks
        // meant for the app underneath.
        let _ = hud.set_ignore_cursor_events(true);

        #[cfg(target_os = "macos")]
        make_nonactivating(&hud);

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
    // The window is padded with transparent space for the shadow; anchor the
    // *pill* near the bottom, accounting for the slack below it.
    const PILL_HEIGHT: i32 = 32;

    let monitor = hud
        .cursor_position()
        .ok()
        .and_then(|cursor| hud.monitor_from_point(cursor.x, cursor.y).ok().flatten())
        .or_else(|| hud.current_monitor().ok().flatten())
        .or_else(|| hud.primary_monitor().ok().flatten())?;

    let work_area = monitor.work_area();
    let work_bottom = work_area.position.y + work_area.size.height as i32;
    let work_center_x = work_area.position.x + work_area.size.width as i32 / 2;

    let pill_center_y = work_bottom - BOTTOM_MARGIN - PILL_HEIGHT / 2;
    let x = work_center_x - window_size.width as i32 / 2;
    let y = pill_center_y - window_size.height as i32 / 2;
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

/// Cursor position in logical points from the window server. Mirrors the
/// dictation HUD: `WebviewWindow::cursor_position()` only refreshes while the
/// window is key, and this HUD is a non-activating NSPanel.
#[cfg(target_os = "macos")]
fn cursor_position_via_cg() -> Option<(f64, f64)> {
    #[repr(C)]
    #[derive(Clone, Copy)]
    struct CGPoint {
        x: f64,
        y: f64,
    }

    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGEventCreate(source: *const std::ffi::c_void) -> *mut std::ffi::c_void;
        fn CGEventGetLocation(event: *const std::ffi::c_void) -> CGPoint;
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFRelease(cf: *const std::ffi::c_void);
    }

    unsafe {
        let event = CGEventCreate(std::ptr::null());
        if event.is_null() {
            return None;
        }
        let point = CGEventGetLocation(event);
        CFRelease(event);
        Some((point.x, point.y))
    }
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
