//! Shared native plumbing for the floating HUD panels (dictation + meeting).
//!
//! Both HUDs are frosted always-on-top pills whose surface is a real
//! NSVisualEffectView behind the webview (CSS `backdrop-filter` can't sample
//! other apps' pixels), and both can stand upright when parked in a side
//! third of the screen. The upright turn is a Core Animation transform on the
//! window's contentView — frost, tint, and DOM rotate as one unit, so nothing
//! can clip or drift out of sync mid-turn.

use tauri::WebviewWindow;

/// How long a quarter turn takes. The easing matches the app's `--ease-out`
/// token (cubic-bezier(0.22, 1, 0.36, 1)) so the HUDs move like the rest of
/// the UI even though the animation runs in Core Animation, not CSS. Any CSS
/// that mirrors the turn (bar counter-rotation, pill length) must use the
/// same 320ms.
pub const TURN_SECS: f64 = 0.32;

/// Which horizontal third of the monitor's work area a window's center sits
/// in. Side thirds stand the pill upright; the middle lies flat.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Zone {
    Left,
    Center,
    Right,
}

impl Zone {
    pub fn is_vertical(self) -> bool {
        matches!(self, Zone::Left | Zone::Right)
    }
}

pub fn zone_for(hud: &WebviewWindow) -> Option<Zone> {
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

/// Whether the left mouse button is currently held, via the window server's
/// combined session state — works regardless of which window has the cursor.
/// The orientation flip waits for release so it never moves the frame out
/// from under a drag's grab point.
#[cfg(target_os = "macos")]
pub fn left_mouse_button_down() -> bool {
    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        // CGEventSourceButtonState(kCGEventSourceStateCombinedSessionState = 0,
        //                          kCGMouseButtonLeft = 0)
        fn CGEventSourceButtonState(state_id: i32, button: u32) -> bool;
    }
    unsafe { CGEventSourceButtonState(0, 0) }
}

#[cfg(not(target_os = "macos"))]
pub fn left_mouse_button_down() -> bool {
    false
}

#[cfg(target_os = "macos")]
pub(crate) use macos::*;

#[cfg(target_os = "macos")]
mod macos {
    use objc2::msg_send;
    use objc2::runtime::{AnyClass, AnyObject};
    use objc2_foundation::{NSNumber, NSPoint, NSRect, NSSize, NSString};
    use tauri::WebviewWindow;

    use super::TURN_SECS;

    /// `NSViewWidthSizable | NSViewHeightSizable` — track the window exactly,
    /// the way `window_vibrancy` frost behaves.
    const AUTORESIZE_FILL: isize = 2 | 16;

    /// The NSWindow and its contentView as raw objects (either may be null).
    pub(crate) unsafe fn content_view(hud: &WebviewWindow) -> (*mut AnyObject, *mut AnyObject) {
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

    /// The `--ease-out` token from tokens.css as a CAMediaTimingFunction.
    /// `functionWithControlPoints::::` has bare colons `msg_send!` can't
    /// spell, hence `send_message`.
    pub(crate) unsafe fn ease_out_timing() -> *mut AnyObject {
        use objc2::runtime::MessageReceiver;
        use objc2::sel;

        let Some(timing_class) = AnyClass::get(c"CAMediaTimingFunction") else {
            return std::ptr::null_mut();
        };
        (timing_class as *const AnyClass as *mut AnyObject).send_message(
            sel!(functionWithControlPoints::::),
            (0.22f32, 1.0f32, 0.36f32, 1.0f32),
        )
    }

    /// The frost NSVisualEffectView installed by `install_frost`, or null.
    pub(crate) unsafe fn frost_view(content: *mut AnyObject) -> *mut AnyObject {
        let Some(effect_class) = AnyClass::get(c"NSVisualEffectView") else {
            return std::ptr::null_mut();
        };
        let subviews: *mut AnyObject = msg_send![content, subviews];
        if subviews.is_null() {
            return std::ptr::null_mut();
        }
        let count: usize = msg_send![subviews, count];
        for index in 0..count {
            let view: *mut AnyObject = msg_send![subviews, objectAtIndex: index];
            let is_frost: bool = msg_send![view, isKindOfClass: effect_class];
            if is_frost {
                return view;
            }
        }
        std::ptr::null_mut()
    }

    /// Add an NSVisualEffectView behind the webview. `frame: Some(rect)` pins
    /// the frost to that rect (a pill inside a larger window); `None` fills
    /// the window and tracks its resizes, the way `window_vibrancy` does.
    /// Hand-rolled because that crate always fills the window.
    pub(crate) unsafe fn install_frost(hud: &WebviewWindow, frame: Option<NSRect>, radius: f64) {
        let (window, content) = content_view(hud);
        if window.is_null() || content.is_null() {
            return;
        }
        // The contentView hosts the orientation turn (`rotate_content`); give
        // it a layer up front so the first turn doesn't switch rendering
        // paths mid-use.
        let _: () = msg_send![content, setWantsLayer: true];

        let Some(effect_class) = AnyClass::get(c"NSVisualEffectView") else {
            return;
        };
        let bounds: NSRect = msg_send![content, bounds];
        let fills_window = frame.is_none();
        let frame = frame.unwrap_or(bounds);
        let frost: *mut AnyObject = msg_send![effect_class, alloc];
        let frost: *mut AnyObject = msg_send![frost, initWithFrame: frame];
        if frost.is_null() {
            return;
        }
        // HUDWindow material, behind-window blending, always active.
        let _: () = msg_send![frost, setMaterial: 13isize];
        let _: () = msg_send![frost, setBlendingMode: 0isize];
        let _: () = msg_send![frost, setState: 1isize];
        let _: () = msg_send![frost, setWantsLayer: true];
        let _: () = msg_send![
            frost,
            setAutoresizingMask: if fills_window { AUTORESIZE_FILL } else { 0isize }
        ];
        let layer: *mut AnyObject = msg_send![frost, layer];
        if !layer.is_null() {
            let _: () = msg_send![layer, setCornerRadius: radius];
            let _: () = msg_send![layer, setMasksToBounds: true];
        }
        // Below the webview (NSWindowBelow = -1) so the CSS tint paints over it.
        let _: () = msg_send![content, addSubview: frost, positioned: -1isize, relativeTo: std::ptr::null_mut::<AnyObject>()];
    }

    /// Resize the window about its visible center, synchronously, in logical
    /// points (the HUDs are borderless, so frame size == content size).
    ///
    /// Tauri's `set_size`/`set_position` queue the change on the main dispatch
    /// queue even when called *from* the main thread (tao's
    /// `set_content_size_async`), so code that pins the frost or rotates the
    /// contentView on the next line still sees the stale frame — and the late
    /// resize then stomps the in-flight layer transform. The upright turn
    /// needs the frame to be real before the rotation math runs, hence this
    /// direct `setFrame:display:`. Must run on the main thread.
    pub(crate) unsafe fn set_window_size_about_center_sync(
        hud: &WebviewWindow,
        width: f64,
        height: f64,
    ) {
        let (window, _) = content_view(hud);
        if window.is_null() {
            return;
        }
        let frame: NSRect = msg_send![window, frame];
        let new_frame = NSRect::new(
            NSPoint::new(
                frame.origin.x + (frame.size.width - width) / 2.0,
                frame.origin.y + (frame.size.height - height) / 2.0,
            ),
            NSSize::new(width, height),
        );
        let _: () = msg_send![window, setFrame: new_frame, display: true];
    }

    /// Re-frame the frost, optionally easing over the turn's duration and
    /// curve. `track_window` re-enables window-filling autoresizing (used
    /// when a HUD returns to its window-equals-pill mode).
    pub(crate) unsafe fn set_frost_frame(
        hud: &WebviewWindow,
        frame: NSRect,
        track_window: bool,
        animate: bool,
    ) {
        let (_, content) = content_view(hud);
        if content.is_null() {
            return;
        }
        let frost = frost_view(content);
        if frost.is_null() {
            return;
        }
        let _: () = msg_send![
            frost,
            setAutoresizingMask: if track_window { AUTORESIZE_FILL } else { 0isize }
        ];
        if animate {
            if let Some(context_class) = AnyClass::get(c"NSAnimationContext") {
                let _: () = msg_send![context_class, beginGrouping];
                let context: *mut AnyObject = msg_send![context_class, currentContext];
                if !context.is_null() {
                    let _: () = msg_send![context, setDuration: TURN_SECS];
                    let timing = ease_out_timing();
                    if !timing.is_null() {
                        let _: () = msg_send![context, setTimingFunction: timing];
                    }
                }
                let animator: *mut AnyObject = msg_send![frost, animator];
                if !animator.is_null() {
                    let _: () = msg_send![animator, setFrame: frame];
                }
                let _: () = msg_send![context_class, endGrouping];
                return;
            }
        }
        let _: () = msg_send![frost, setFrame: frame];
    }

    /// Turn the contentView's layer to `angle` radians about the window
    /// center. Because the frost view and the webview are both subviews, one
    /// transform carries the blur, tint, and DOM together — they can't desync
    /// or clip. CA's +z spins counterclockwise (y-up), so -π/2 swings the
    /// pill's left end to the top, like a CSS rotate(90deg).
    pub(crate) unsafe fn rotate_content(hud: &WebviewWindow, angle: f64, animate: bool) {
        let (window, content) = content_view(hud);
        if content.is_null() {
            return;
        }
        let layer: *mut AnyObject = msg_send![content, layer];
        if layer.is_null() {
            return;
        }

        // Rotate about the window's center. AppKit anchors view layers at
        // their corner, so re-center the anchor (re-asserted every turn —
        // layout passes can reset layer geometry).
        let frame: NSRect = msg_send![content, frame];
        let _: () = msg_send![layer, setAnchorPoint: NSPoint::new(0.5, 0.5)];
        let _: () = msg_send![layer, setPosition: NSPoint::new(
            frame.origin.x + frame.size.width / 2.0,
            frame.origin.y + frame.size.height / 2.0,
        )];

        let key = NSString::from_str("transform.rotation.z");
        let target = NSNumber::new_f64(angle);

        if animate {
            if let Some(animation_class) = AnyClass::get(c"CABasicAnimation") {
                let animation: *mut AnyObject =
                    msg_send![animation_class, animationWithKeyPath: &*key];
                if !animation.is_null() {
                    // Start from wherever the layer visibly is right now, so
                    // a turn reversed mid-flight doubles back smoothly.
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
                    let timing = ease_out_timing();
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

    /// Ask AppKit to recompute the window shadow from the rendered content —
    /// the shape changed when the pill turned.
    pub(crate) unsafe fn invalidate_shadow(hud: &WebviewWindow) {
        let (window, _) = content_view(hud);
        if !window.is_null() {
            let _: () = msg_send![window, invalidateShadow];
        }
    }
}
