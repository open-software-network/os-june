//! Click-through visual cursor for June's virtual Computer use position.
//!
//! The signed helper continues to own Accessibility and input delivery. It
//! reports pointer positions in the latest window screenshot's pixel space;
//! this module converts them to Quartz screen points, flips them into AppKit's
//! coordinate space, and moves a tiny non-activating panel. Every state change
//! is bound to the Computer use epoch so a late helper notification cannot
//! make the cursor reappear after Stop.

use serde_json::Value;
use std::sync::Mutex;
#[cfg(target_os = "macos")]
use std::sync::OnceLock;
use tauri::{AppHandle, Manager};

pub(crate) const DRIVER_POINTER_NOTIFICATION_METHOD: &str = "june/pointer";

const CURSOR_WIDTH: f64 = 20.0;
const CURSOR_HEIGHT: f64 = 24.0;
const CURSOR_HOTSPOT_X: f64 = 2.0;
const CURSOR_HOTSPOT_FROM_TOP: f64 = 2.0;
const MAX_DRAG_DURATION_MS: u64 = 5_000;
const DRAG_FRAME_INTERVAL_MS: u64 = 16;

#[cfg(target_os = "macos")]
static CURSOR_PANEL: OnceLock<usize> = OnceLock::new();

#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct ScreenPoint {
    pub x: f64,
    pub y: f64,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct ScreenRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, Copy, PartialEq)]
struct ScreenshotSize {
    width: f64,
    height: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) enum PointerMotion {
    Point(ScreenPoint),
    Drag {
        from: ScreenPoint,
        to: ScreenPoint,
        duration_ms: u64,
    },
}

#[derive(Debug, Clone)]
struct CursorSnapshot {
    revision: u64,
    motion: Option<PointerMotion>,
}

#[derive(Debug, Default)]
struct CursorLifecycle {
    visible_epoch: Option<u64>,
    last_point: Option<ScreenPoint>,
    native_revision: Option<u64>,
    revision: u64,
}

impl CursorLifecycle {
    fn show(&mut self, expected_epoch: u64, current_epoch: u64) -> Option<CursorSnapshot> {
        if expected_epoch != current_epoch {
            return None;
        }
        if self.visible_epoch == Some(expected_epoch) {
            return None;
        }
        self.visible_epoch = Some(expected_epoch);
        self.revision = self.revision.saturating_add(1);
        Some(CursorSnapshot {
            revision: self.revision,
            motion: self.last_point.map(PointerMotion::Point),
        })
    }

    fn apply_motion(
        &mut self,
        expected_epoch: u64,
        current_epoch: u64,
        motion: PointerMotion,
    ) -> Option<CursorSnapshot> {
        if expected_epoch != current_epoch || self.visible_epoch != Some(expected_epoch) {
            return None;
        }
        self.last_point = Some(match motion {
            PointerMotion::Point(point) => point,
            PointerMotion::Drag { to, .. } => to,
        });
        self.revision = self.revision.saturating_add(1);
        Some(CursorSnapshot {
            revision: self.revision,
            motion: Some(motion),
        })
    }

    fn hide(&mut self) -> u64 {
        self.visible_epoch = None;
        self.last_point = None;
        self.revision = self.revision.saturating_add(1);
        self.revision
    }

    fn record_native_show(&mut self, revision: u64) {
        self.native_revision = Some(
            self.native_revision
                .map_or(revision, |current| current.max(revision)),
        );
    }

    fn claim_native_hide(&mut self, hide_revision: u64) -> bool {
        if self
            .native_revision
            .is_some_and(|native_revision| native_revision > hide_revision)
        {
            return false;
        }
        self.native_revision = None;
        true
    }

    fn accepts(&self, expected_epoch: u64, current_epoch: u64, revision: u64) -> bool {
        expected_epoch == current_epoch
            && self.visible_epoch == Some(expected_epoch)
            && self.revision == revision
    }
}

#[derive(Default)]
pub(crate) struct ComputerUseCursorState {
    lifecycle: Mutex<CursorLifecycle>,
}

impl ComputerUseCursorState {
    fn show(&self, expected_epoch: u64, current_epoch: u64) -> Option<CursorSnapshot> {
        self.lifecycle
            .lock()
            .ok()?
            .show(expected_epoch, current_epoch)
    }

    fn apply_motion(
        &self,
        expected_epoch: u64,
        current_epoch: u64,
        motion: PointerMotion,
    ) -> Option<CursorSnapshot> {
        self.lifecycle
            .lock()
            .ok()?
            .apply_motion(expected_epoch, current_epoch, motion)
    }

    fn hide(&self) -> Option<u64> {
        Some(self.lifecycle.lock().ok()?.hide())
    }

    fn record_native_show(&self, revision: u64) {
        if let Ok(mut lifecycle) = self.lifecycle.lock() {
            lifecycle.record_native_show(revision);
        }
    }

    fn claim_native_hide(&self, hide_revision: u64) -> bool {
        self.lifecycle.lock().map_or(true, |mut lifecycle| {
            lifecycle.claim_native_hide(hide_revision)
        })
    }

    pub(crate) fn accepts(&self, expected_epoch: u64, current_epoch: u64, revision: u64) -> bool {
        self.lifecycle
            .lock()
            .is_ok_and(|lifecycle| lifecycle.accepts(expected_epoch, current_epoch, revision))
    }
}

pub(crate) fn show(app: &AppHandle, expected_epoch: u64) {
    let state = app.state::<crate::computer_use::ComputerUseState>();
    let Some(snapshot) = state.cursor().show(expected_epoch, state.current_epoch()) else {
        return;
    };
    schedule_snapshot(app, expected_epoch, snapshot);
}

pub(crate) fn apply_driver_notification(
    app: &AppHandle,
    expected_epoch: u64,
    notification: &Value,
    target_pid: i64,
    target_window_id: u64,
    target_bounds: ScreenRect,
) {
    let Some(motion) = pointer_motion(notification, target_pid, target_window_id, target_bounds)
    else {
        return;
    };
    let state = app.state::<crate::computer_use::ComputerUseState>();
    let Some(snapshot) = state
        .cursor()
        .apply_motion(expected_epoch, state.current_epoch(), motion)
    else {
        return;
    };
    schedule_snapshot(app, expected_epoch, snapshot);
}

pub(crate) fn hide(app: &AppHandle) {
    let hide_revision = app
        .state::<crate::computer_use::ComputerUseState>()
        .cursor()
        .hide();
    let app_for_main = app.clone();
    let _ = app.run_on_main_thread(move || {
        let state = app_for_main.state::<crate::computer_use::ComputerUseState>();
        let should_hide = hide_revision
            .map(|revision| state.cursor().claim_native_hide(revision))
            .unwrap_or(true);
        if should_hide {
            hide_native_panel();
        }
    });
}

fn schedule_snapshot(app: &AppHandle, expected_epoch: u64, snapshot: CursorSnapshot) {
    match snapshot.motion {
        Some(PointerMotion::Drag {
            from,
            to,
            duration_ms,
        }) => schedule_drag(
            app,
            expected_epoch,
            snapshot.revision,
            from,
            to,
            duration_ms,
        ),
        Some(PointerMotion::Point(point)) => {
            schedule_point(app, expected_epoch, snapshot.revision, point);
        }
        None => {}
    }
}

fn schedule_drag(
    app: &AppHandle,
    expected_epoch: u64,
    revision: u64,
    from: ScreenPoint,
    to: ScreenPoint,
    duration_ms: u64,
) {
    schedule_point(app, expected_epoch, revision, from);
    if duration_ms == 0 {
        schedule_point(app, expected_epoch, revision, to);
        return;
    }

    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let steps = duration_ms.div_ceil(DRAG_FRAME_INTERVAL_MS);
        let mut elapsed_ms = 0;
        for step in 1..=steps {
            let next_elapsed_ms = duration_ms * step / steps;
            tokio::time::sleep(std::time::Duration::from_millis(
                next_elapsed_ms - elapsed_ms,
            ))
            .await;
            elapsed_ms = next_elapsed_ms;
            schedule_point(
                &app,
                expected_epoch,
                revision,
                interpolate(from, to, step as f64 / steps as f64),
            );
        }
    });
}

fn schedule_point(app: &AppHandle, expected_epoch: u64, revision: u64, point: ScreenPoint) {
    let app_for_main = app.clone();
    let _ = app.run_on_main_thread(move || {
        let state = app_for_main.state::<crate::computer_use::ComputerUseState>();
        if !state
            .cursor()
            .accepts(expected_epoch, state.current_epoch(), revision)
        {
            return;
        }
        show_native_panel(point);
        state.cursor().record_native_show(revision);
    });
}

fn interpolate(from: ScreenPoint, to: ScreenPoint, progress: f64) -> ScreenPoint {
    ScreenPoint {
        x: from.x + (to.x - from.x) * progress,
        y: from.y + (to.y - from.y) * progress,
    }
}

fn pointer_motion(
    notification: &Value,
    target_pid: i64,
    target_window_id: u64,
    target_bounds: ScreenRect,
) -> Option<PointerMotion> {
    if notification.get("method")?.as_str()? != DRIVER_POINTER_NOTIFICATION_METHOD {
        return None;
    }
    let params = notification.get("params")?;
    if params.get("pid")?.as_i64()? != target_pid {
        return None;
    }
    if params.get("window_id")?.as_u64()? != target_window_id {
        return None;
    }
    let screenshot = ScreenshotSize {
        width: finite_positive(params.get("screenshot_width")?)?,
        height: finite_positive(params.get("screenshot_height")?)?,
    };
    match params.get("kind")?.as_str()? {
        "point" => Some(PointerMotion::Point(screenshot_to_quartz(
            target_bounds,
            screenshot,
            local_point(params, "x", "y")?,
        )?)),
        "drag" => {
            let duration_ms = params
                .get("duration_ms")?
                .as_u64()?
                .min(MAX_DRAG_DURATION_MS);
            Some(PointerMotion::Drag {
                from: screenshot_to_quartz(
                    target_bounds,
                    screenshot,
                    local_point(params, "from_x", "from_y")?,
                )?,
                to: screenshot_to_quartz(
                    target_bounds,
                    screenshot,
                    local_point(params, "to_x", "to_y")?,
                )?,
                duration_ms,
            })
        }
        _ => None,
    }
}

fn local_point(value: &Value, x_key: &str, y_key: &str) -> Option<ScreenPoint> {
    Some(ScreenPoint {
        x: finite_number(value.get(x_key)?)?,
        y: finite_number(value.get(y_key)?)?,
    })
}

fn finite_number(value: &Value) -> Option<f64> {
    value.as_f64().filter(|value| value.is_finite())
}

fn finite_positive(value: &Value) -> Option<f64> {
    finite_number(value).filter(|value| *value > 0.0)
}

fn screenshot_to_quartz(
    bounds: ScreenRect,
    screenshot: ScreenshotSize,
    local: ScreenPoint,
) -> Option<ScreenPoint> {
    if ![
        bounds.x,
        bounds.y,
        bounds.width,
        bounds.height,
        screenshot.width,
        screenshot.height,
        local.x,
        local.y,
    ]
    .into_iter()
    .all(f64::is_finite)
        || bounds.width <= 0.0
        || bounds.height <= 0.0
        || screenshot.width <= 0.0
        || screenshot.height <= 0.0
        || !(0.0..=screenshot.width).contains(&local.x)
        || !(0.0..=screenshot.height).contains(&local.y)
    {
        return None;
    }
    Some(ScreenPoint {
        x: bounds.x + local.x * bounds.width / screenshot.width,
        y: bounds.y + local.y * bounds.height / screenshot.height,
    })
}

fn quartz_to_appkit(point: ScreenPoint, primary_screen_max_y: f64) -> Option<ScreenPoint> {
    if !point.x.is_finite() || !point.y.is_finite() || !primary_screen_max_y.is_finite() {
        return None;
    }
    Some(ScreenPoint {
        x: point.x,
        y: primary_screen_max_y - point.y,
    })
}

#[cfg(target_os = "macos")]
fn show_native_panel(point: ScreenPoint) {
    use objc2::{msg_send, MainThreadMarker};
    use objc2_foundation::NSPoint;

    let Some(_mtm) = MainThreadMarker::new() else {
        return;
    };
    let Some(panel) = cursor_panel() else {
        return;
    };
    let Some(primary_screen_max_y) = primary_screen_max_y() else {
        return;
    };

    unsafe {
        let Some(point) = quartz_to_appkit(point, primary_screen_max_y) else {
            return;
        };
        let _: () = msg_send![panel, setFrameOrigin: panel_origin(point)];
        let _: () = msg_send![panel, orderFrontRegardless];
    }

    fn panel_origin(point: ScreenPoint) -> NSPoint {
        NSPoint::new(
            point.x - CURSOR_HOTSPOT_X,
            point.y - CURSOR_HEIGHT + CURSOR_HOTSPOT_FROM_TOP,
        )
    }
}

#[cfg(not(target_os = "macos"))]
fn show_native_panel(_point: ScreenPoint) {}

#[cfg(target_os = "macos")]
fn hide_native_panel() {
    use objc2::{msg_send, MainThreadMarker};

    let Some(_mtm) = MainThreadMarker::new() else {
        return;
    };
    let Some(panel) = existing_cursor_panel() else {
        return;
    };
    unsafe {
        let _: () = msg_send![panel, orderOut: std::ptr::null_mut::<objc2::runtime::AnyObject>()];
    }
}

#[cfg(not(target_os = "macos"))]
fn hide_native_panel() {}

#[cfg(target_os = "macos")]
fn primary_screen_max_y() -> Option<f64> {
    use objc2::{msg_send, runtime::AnyObject};
    use objc2_foundation::NSRect;

    let screen_class = objc2::runtime::AnyClass::get(c"NSScreen")?;
    unsafe {
        let screens: *mut AnyObject = msg_send![screen_class, screens];
        let primary: *mut AnyObject = msg_send![screens, firstObject];
        if primary.is_null() {
            return None;
        }
        let frame: NSRect = msg_send![primary, frame];
        Some(frame.origin.y + frame.size.height)
    }
}

#[cfg(target_os = "macos")]
fn existing_cursor_panel() -> Option<*mut objc2::runtime::AnyObject> {
    CURSOR_PANEL
        .get()
        .copied()
        .filter(|pointer| *pointer != 0)
        .map(|pointer| pointer as *mut objc2::runtime::AnyObject)
}

#[cfg(target_os = "macos")]
fn cursor_panel() -> Option<*mut objc2::runtime::AnyObject> {
    use objc2::{msg_send, runtime::AnyObject};
    use objc2_foundation::{NSPoint, NSRect, NSSize};
    let pointer = *CURSOR_PANEL.get_or_init(|| unsafe {
        let Some(panel_class) = objc2::runtime::AnyClass::get(c"NSPanel") else {
            return 0;
        };
        let allocated: *mut AnyObject = msg_send![panel_class, alloc];
        let frame = NSRect::new(
            NSPoint::new(-200.0, -200.0),
            NSSize::new(CURSOR_WIDTH, CURSOR_HEIGHT),
        );
        let panel: *mut AnyObject = msg_send![allocated,
            initWithContentRect: frame,
            styleMask: (1u64 << 7),
            backing: 2u64,
            defer: false
        ];
        if panel.is_null() {
            return 0;
        }

        let _: () = msg_send![panel, setOpaque: false];
        if let Some(color_class) = objc2::runtime::AnyClass::get(c"NSColor") {
            let clear: *mut AnyObject = msg_send![color_class, clearColor];
            let _: () = msg_send![panel, setBackgroundColor: clear];
        }
        let _: () = msg_send![panel, setHasShadow: false];
        let _: () = msg_send![panel, setIgnoresMouseEvents: true];
        let _: () = msg_send![panel, setAcceptsMouseMovedEvents: false];
        let _: () = msg_send![panel, setBecomesKeyOnlyIfNeeded: true];
        let _: () = msg_send![panel, setLevel: 25i64];
        let _: () = msg_send![panel, setCollectionBehavior: (1u64 | (1 << 4) | (1 << 8))];
        let _: () = msg_send![panel, setReleasedWhenClosed: false];
        let _: () = msg_send![panel, setHidesOnDeactivate: false];

        if let (Some(image_view_class), Some(cursor_class)) = (
            objc2::runtime::AnyClass::get(c"NSImageView"),
            objc2::runtime::AnyClass::get(c"NSCursor"),
        ) {
            let allocated_view: *mut AnyObject = msg_send![image_view_class, alloc];
            let view: *mut AnyObject = msg_send![allocated_view, initWithFrame: NSRect::new(
                NSPoint::new(0.0, 0.0),
                NSSize::new(CURSOR_WIDTH, CURSOR_HEIGHT),
            )];
            let cursor: *mut AnyObject = msg_send![cursor_class, arrowCursor];
            let image: *mut AnyObject = msg_send![cursor, image];
            let _: () = msg_send![view, setImage: image];
            // NSImageScaleProportionallyUpOrDown = 3.
            let _: () = msg_send![view, setImageScaling: 3u64];
            let _: () = msg_send![view, setAlphaValue: 0.68_f64];
            let _: () = msg_send![panel, setContentView: view];
        }

        panel as usize
    });
    (pointer != 0).then_some(pointer as *mut AnyObject)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn screenshot_coordinates_scale_into_quartz_screen_points() {
        let point = screenshot_to_quartz(
            ScreenRect {
                x: -1_280.0,
                y: 80.0,
                width: 1_000.0,
                height: 600.0,
            },
            ScreenshotSize {
                width: 2_000.0,
                height: 1_200.0,
            },
            ScreenPoint {
                x: 1_000.0,
                y: 300.0,
            },
        )
        .expect("valid point");
        assert_eq!(
            point,
            ScreenPoint {
                x: -780.0,
                y: 230.0
            }
        );
    }

    #[test]
    fn quartz_to_appkit_preserves_negative_x_and_flips_y() {
        assert_eq!(
            quartz_to_appkit(
                ScreenPoint {
                    x: -400.0,
                    y: -120.0,
                },
                1_080.0,
            ),
            Some(ScreenPoint {
                x: -400.0,
                y: 1_200.0,
            })
        );
    }

    #[test]
    fn drag_interpolation_reaches_the_expected_midpoint_and_endpoint() {
        let from = ScreenPoint { x: -20.0, y: 10.0 };
        let to = ScreenPoint { x: 80.0, y: 50.0 };
        assert_eq!(interpolate(from, to, 0.5), ScreenPoint { x: 30.0, y: 30.0 });
        assert_eq!(interpolate(from, to, 1.0), to);
    }

    #[test]
    fn helper_notification_normalizes_click_and_drag_positions() {
        let bounds = ScreenRect {
            x: 100.0,
            y: 200.0,
            width: 800.0,
            height: 600.0,
        };
        let point = pointer_motion(
            &json!({
                "method": DRIVER_POINTER_NOTIFICATION_METHOD,
                "params": {
                    "kind": "point",
                    "pid": 42,
                    "window_id": 9,
                    "x": 400.0,
                    "y": 300.0,
                    "screenshot_width": 1600.0,
                    "screenshot_height": 1200.0,
                }
            }),
            42,
            9,
            bounds,
        );
        assert_eq!(
            point,
            Some(PointerMotion::Point(ScreenPoint { x: 300.0, y: 350.0 }))
        );

        let drag = pointer_motion(
            &json!({
                "method": DRIVER_POINTER_NOTIFICATION_METHOD,
                "params": {
                    "kind": "drag",
                    "pid": 42,
                    "window_id": 9,
                    "from_x": 0.0,
                    "from_y": 0.0,
                    "to_x": 1600.0,
                    "to_y": 1200.0,
                    "screenshot_width": 1600.0,
                    "screenshot_height": 1200.0,
                    "duration_ms": 500,
                }
            }),
            42,
            9,
            bounds,
        );
        assert_eq!(
            drag,
            Some(PointerMotion::Drag {
                from: ScreenPoint { x: 100.0, y: 200.0 },
                to: ScreenPoint { x: 900.0, y: 800.0 },
                duration_ms: 500,
            })
        );

        assert!(pointer_motion(
            &json!({
                "method": DRIVER_POINTER_NOTIFICATION_METHOD,
                "params": {
                    "kind": "point",
                    "pid": 99,
                    "window_id": 9,
                    "x": 400.0,
                    "y": 300.0,
                    "screenshot_width": 1600.0,
                    "screenshot_height": 1200.0,
                }
            }),
            42,
            9,
            bounds,
        )
        .is_none());

        assert!(screenshot_to_quartz(
            bounds,
            ScreenshotSize {
                width: 1600.0,
                height: 1200.0,
            },
            ScreenPoint {
                x: 1601.0,
                y: 300.0,
            },
        )
        .is_none());
    }

    #[test]
    fn stale_epochs_cannot_show_move_or_resurrect_the_cursor() {
        let mut lifecycle = CursorLifecycle::default();
        assert!(lifecycle.show(4, 5).is_none());
        let shown = lifecycle.show(5, 5).expect("current epoch shows");
        assert_eq!(shown.motion, None);
        assert!(lifecycle.accepts(5, 5, shown.revision));
        let moved = lifecycle
            .apply_motion(5, 5, PointerMotion::Point(ScreenPoint { x: 3.0, y: 4.0 }))
            .expect("current epoch moves");
        assert!(!lifecycle.accepts(5, 5, shown.revision));
        assert!(lifecycle.accepts(5, 5, moved.revision));
        lifecycle.hide();
        assert!(lifecycle.last_point.is_none());
        assert!(lifecycle
            .apply_motion(5, 6, PointerMotion::Point(ScreenPoint { x: 1.0, y: 2.0 }),)
            .is_none());
        assert!(lifecycle.visible_epoch.is_none());
        assert!(!lifecycle.accepts(5, 6, shown.revision));
    }

    #[test]
    fn queued_hide_still_claims_a_panel_when_a_new_epoch_only_arms() {
        let mut lifecycle = CursorLifecycle::default();
        lifecycle.show(5, 5).expect("first epoch arms");
        let first_motion = lifecycle
            .apply_motion(5, 5, PointerMotion::Point(ScreenPoint { x: 3.0, y: 4.0 }))
            .expect("first epoch moves");
        lifecycle.record_native_show(first_motion.revision);

        let hide_revision = lifecycle.hide();
        let next = lifecycle.show(6, 6).expect("next epoch arms");

        assert_eq!(next.motion, None);
        assert!(lifecycle.claim_native_hide(hide_revision));
        assert!(lifecycle.native_revision.is_none());
    }

    #[test]
    fn queued_hide_skips_a_panel_rendered_by_a_newer_epoch() {
        let mut lifecycle = CursorLifecycle::default();
        lifecycle.show(5, 5).expect("first epoch arms");
        let first_motion = lifecycle
            .apply_motion(5, 5, PointerMotion::Point(ScreenPoint { x: 3.0, y: 4.0 }))
            .expect("first epoch moves");
        lifecycle.record_native_show(first_motion.revision);

        let hide_revision = lifecycle.hide();
        lifecycle.show(6, 6).expect("next epoch arms");
        let next_motion = lifecycle
            .apply_motion(6, 6, PointerMotion::Point(ScreenPoint { x: 7.0, y: 8.0 }))
            .expect("next epoch moves");
        lifecycle.record_native_show(next_motion.revision);

        assert!(!lifecycle.claim_native_hide(hide_revision));
        assert_eq!(lifecycle.native_revision, Some(next_motion.revision));
    }
}
