//! App notifications with click-through navigation.
//!
//! The notification plugin's desktop backend (`notify_rust` over
//! `mac-notification-sys`) installs its own throwaway delegate on the shared
//! `NSUserNotificationCenter` on every send and never reports clicks, so a
//! notification could only ever reopen the app generally (JUN-327). On macOS
//! this module owns the posting path instead: June installs one permanent
//! center delegate, posts agent/recording notifications itself with the
//! session id in `userInfo`, and on click focuses the main window and routes
//! the session id to the webview via the existing `june:agent:open` event.
//!
//! Clicks can arrive before the webview has listeners (app launched by the
//! click), so activation goes through a ready/pending handshake: the frontend
//! calls `agent_open_ready` once its listeners are registered and receives
//! any session id that was clicked while it could not listen.
//!
//! Outside macOS, and in unbundled dev runs where the notification center is
//! unavailable, sends fall back to the notification plugin: same visuals, no
//! click-through (the plugin cannot deliver clicks there anyway).

use serde::Deserialize;
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Manager};

const MAIN_WINDOW_LABEL: &str = "main";
#[cfg(target_os = "macos")]
const AGENT_OPEN_EVENT: &str = "june:agent:open";

// The center delegate is a static C callback with no captured state, so
// activations reach the app through this handle (same pattern as the agent
// HUD panel class).
static NOTIFICATION_APP: OnceLock<AppHandle> = OnceLock::new();

static AGENT_OPEN_QUEUE: Mutex<AgentOpenQueue> = Mutex::new(AgentOpenQueue::new());

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppNotificationRequest {
    title: String,
    body: String,
    #[serde(default)]
    sound: Option<String>,
    /// Per-session grouping, honored by the plugin fallback (the macOS
    /// native path has no NSUserNotification equivalent).
    #[serde(default)]
    group: Option<String>,
    /// Agent session to open when the user clicks the notification.
    #[serde(default)]
    session_id: Option<String>,
}

/// Decides whether a notification click can be delivered to the webview now
/// or must wait for the frontend's ready handshake. Clicking a notification
/// can launch the app, and the click then arrives before any listener exists;
/// dropping it would strand the user on the default view.
struct AgentOpenQueue {
    frontend_ready: bool,
    pending_session_id: Option<String>,
}

impl AgentOpenQueue {
    const fn new() -> Self {
        Self {
            frontend_ready: false,
            pending_session_id: None,
        }
    }

    /// Records a notification click. Returns the session id when the frontend
    /// can receive it immediately. The click stays queued either way: the
    /// ready flag can outlive the listeners it describes (webview reload
    /// tears them down without telling the native side), so an emitted event
    /// may land on no listener. The frontend drains the queue after handling
    /// an event, and the next `mark_ready` recovers anything that was lost.
    fn on_activation(&mut self, session_id: Option<String>) -> Option<String> {
        // Last click wins, generic clicks included: a click without a session
        // (recording notifications) must clear a stale queued agent open so
        // the next ready handshake cannot hijack it into an unrelated chat.
        self.pending_session_id = session_id.clone();
        let session_id = session_id?;
        self.frontend_ready.then_some(session_id)
    }

    /// Frontend listeners are registered; returns any click that arrived early.
    fn mark_ready(&mut self) -> Option<String> {
        self.frontend_ready = true;
        self.pending_session_id.take()
    }
}

pub fn setup(app: &tauri::App) {
    let _ = NOTIFICATION_APP.set(app.handle().clone());
    #[cfg(target_os = "macos")]
    macos::install_center_delegate();
}

/// Marks the webview ready for `june:agent:open` events and returns the
/// session id of a notification clicked before that (app launched by the
/// click), so the frontend can navigate to it on bootstrap.
#[tauri::command]
pub fn agent_open_ready() -> Option<String> {
    lock_queue().mark_ready()
}

/// Posts a notification. On macOS the native path attaches the session id so
/// a click deep-links into the chat; elsewhere (and when the native center is
/// unavailable) the plugin posts it without click-through.
#[tauri::command]
pub fn send_app_notification(
    app: AppHandle,
    request: AppNotificationRequest,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    if macos::deliver(&request) {
        return Ok(());
    }
    send_via_plugin(&app, &request)
}

fn send_via_plugin(app: &AppHandle, request: &AppNotificationRequest) -> Result<(), String> {
    use tauri_plugin_notification::NotificationExt;

    let mut builder = app
        .notification()
        .builder()
        .title(&request.title)
        .body(&request.body);
    if let Some(sound) = &request.sound {
        builder = builder.sound(sound);
    }
    if let Some(group) = &request.group {
        builder = builder.group(group);
    }
    builder.show().map_err(|error| error.to_string())
}

fn lock_queue() -> std::sync::MutexGuard<'static, AgentOpenQueue> {
    AGENT_OPEN_QUEUE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Runs on a notification click: focus the app, then route the session id to
/// the webview (or queue it until the frontend is ready). A notification
/// without a session id keeps the old behavior of just opening the app.
fn handle_notification_activation(session_id: Option<String>) {
    let Some(app) = NOTIFICATION_APP.get() else {
        return;
    };
    show_main_window(app);
    if let Some(session_id) = lock_queue().on_activation(session_id) {
        #[cfg(target_os = "macos")]
        {
            use tauri::Emitter;
            let _ = app.emit_to(
                MAIN_WINDOW_LABEL,
                AGENT_OPEN_EVENT,
                serde_json::json!({ "sessionId": session_id }),
            );
        }
        #[cfg(not(target_os = "macos"))]
        let _ = session_id;
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
mod macos {
    use super::{handle_notification_activation, AppNotificationRequest};
    use objc2::msg_send;
    use objc2::runtime::{AnyClass, AnyObject, Bool, ClassBuilder, Sel};
    use objc2::sel;
    use objc2_foundation::NSString;
    use std::sync::atomic::{AtomicBool, Ordering};

    /// `userInfo` key carrying the agent session on June's own notifications.
    const SESSION_ID_KEY: &str = "juneAgentSessionId";

    /// Set once the permanent delegate is installed; the native posting path
    /// is only trusted after that, so clicks are never silently dropped.
    static CENTER_DELEGATE_INSTALLED: AtomicBool = AtomicBool::new(false);

    /// `NSUserNotificationCenter defaultUserNotificationCenter`, which is nil
    /// for unbundled binaries (`tauri dev` runs the raw executable).
    unsafe fn default_center() -> Option<*mut AnyObject> {
        let class = AnyClass::get(c"NSUserNotificationCenter")?;
        let center: *mut AnyObject = unsafe { msg_send![class, defaultUserNotificationCenter] };
        if center.is_null() {
            None
        } else {
            Some(center)
        }
    }

    /// Whether the process runs from a real app bundle. Without a bundle
    /// identifier (`tauri dev` runs the raw executable) the center exists but
    /// silently drops deliveries; the plugin fallback fakes a bundle id there,
    /// so posting must stay on the plugin path to remain visible.
    unsafe fn bundled() -> bool {
        let Some(class) = AnyClass::get(c"NSBundle") else {
            return false;
        };
        unsafe {
            let bundle: *mut AnyObject = msg_send![class, mainBundle];
            if bundle.is_null() {
                return false;
            }
            let identifier: *mut AnyObject = msg_send![bundle, bundleIdentifier];
            !identifier.is_null()
        }
    }

    /// Installs June's permanent notification-center delegate. Called once at
    /// setup, before any notification can be posted or clicked.
    pub(super) fn install_center_delegate() {
        unsafe {
            if !bundled() {
                return;
            }
            let Some(center) = default_center() else {
                return;
            };
            let Some(class) = delegate_class() else {
                return;
            };
            // +1 from `new`, intentionally never released: the delegate must
            // outlive every notification, including clicks on notifications
            // from a previous run delivered right after relaunch.
            let delegate: *mut AnyObject = msg_send![class, new];
            if delegate.is_null() {
                return;
            }
            let _: () = msg_send![center, setDelegate: delegate];
            CENTER_DELEGATE_INSTALLED.store(true, Ordering::Release);
        }
    }

    /// Posts the notification natively with the session id in `userInfo`.
    /// Returns false when the native path is unavailable so the caller can
    /// fall back to the plugin.
    pub(super) fn deliver(request: &AppNotificationRequest) -> bool {
        if !CENTER_DELEGATE_INSTALLED.load(Ordering::Acquire) {
            return false;
        }
        unsafe {
            let Some(center) = default_center() else {
                return false;
            };
            let Some(class) = AnyClass::get(c"NSUserNotification") else {
                return false;
            };
            let notification: *mut AnyObject = msg_send![class, new];
            if notification.is_null() {
                return false;
            }
            let title = NSString::from_str(&request.title);
            let body = NSString::from_str(&request.body);
            let _: () = msg_send![notification, setTitle: &*title];
            let _: () = msg_send![notification, setInformativeText: &*body];
            if let Some(sound) = &request.sound {
                let sound = NSString::from_str(sound);
                let _: () = msg_send![notification, setSoundName: &*sound];
            }
            if let Some(session_id) = &request.session_id {
                if let Some(dictionary_class) = AnyClass::get(c"NSDictionary") {
                    let key = NSString::from_str(SESSION_ID_KEY);
                    let value = NSString::from_str(session_id);
                    let user_info: *mut AnyObject = msg_send![
                        dictionary_class,
                        dictionaryWithObject: &*value,
                        forKey: &*key,
                    ];
                    let _: () = msg_send![notification, setUserInfo: user_info];
                }
            }
            let _: () = msg_send![center, deliverNotification: notification];
            let _: () = msg_send![notification, release];
        }
        true
    }

    /// Reads June's session id out of a clicked notification's `userInfo`.
    unsafe fn notification_session_id(notification: *mut AnyObject) -> Option<String> {
        if notification.is_null() {
            return None;
        }
        unsafe {
            let user_info: *mut AnyObject = msg_send![notification, userInfo];
            if user_info.is_null() {
                return None;
            }
            let key = NSString::from_str(SESSION_ID_KEY);
            let value: *mut AnyObject = msg_send![user_info, objectForKey: &*key];
            if value.is_null() {
                return None;
            }
            // June only ever stores an NSString under this key; a foreign
            // object that does not respond to UTF8String is ignored.
            let responds: Bool = msg_send![value, respondsToSelector: sel!(UTF8String)];
            if !responds.as_bool() {
                return None;
            }
            let utf8: *const std::ffi::c_char = msg_send![value, UTF8String];
            if utf8.is_null() {
                return None;
            }
            Some(
                std::ffi::CStr::from_ptr(utf8)
                    .to_string_lossy()
                    .into_owned(),
            )
        }
    }

    extern "C-unwind" fn should_present(
        _this: &AnyObject,
        _sel: Sel,
        _center: *mut AnyObject,
        _notification: *mut AnyObject,
    ) -> Bool {
        // Present even while June is frontmost, matching the previous
        // plugin-backed behavior (its delegate also always presented).
        Bool::YES
    }

    extern "C-unwind" fn did_activate(
        _this: &AnyObject,
        _sel: Sel,
        _center: *mut AnyObject,
        notification: *mut AnyObject,
    ) {
        let session_id = unsafe { notification_session_id(notification) };
        handle_notification_activation(session_id);
    }

    fn delegate_class() -> Option<&'static AnyClass> {
        if let Some(class) = AnyClass::get(c"JuneNotificationCenterDelegate") {
            return Some(class);
        }
        let superclass = AnyClass::get(c"NSObject")?;
        let mut builder = ClassBuilder::new(c"JuneNotificationCenterDelegate", superclass)?;
        unsafe {
            builder.add_method(
                sel!(userNotificationCenter:shouldPresentNotification:),
                should_present as extern "C-unwind" fn(_, _, _, _) -> _,
            );
            builder.add_method(
                sel!(userNotificationCenter:didActivateNotification:),
                did_activate as extern "C-unwind" fn(_, _, _, _),
            );
        }
        Some(builder.register())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn activation_before_ready_is_queued_for_the_handshake() {
        let mut queue = AgentOpenQueue::new();
        assert_eq!(queue.on_activation(Some("session-1".to_string())), None);
        assert_eq!(queue.mark_ready(), Some("session-1".to_string()));
    }

    #[test]
    fn activation_after_ready_is_delivered_immediately() {
        let mut queue = AgentOpenQueue::new();
        assert_eq!(queue.mark_ready(), None);
        assert_eq!(
            queue.on_activation(Some("session-2".to_string())),
            Some("session-2".to_string())
        );
    }

    #[test]
    fn delivered_click_stays_queued_until_drained() {
        // The ready flag can be stale across a webview reload, so an emitted
        // click must remain recoverable by the next ready handshake.
        let mut queue = AgentOpenQueue::new();
        queue.mark_ready();
        assert_eq!(
            queue.on_activation(Some("session-2".to_string())),
            Some("session-2".to_string())
        );
        assert_eq!(queue.mark_ready(), Some("session-2".to_string()));
        assert_eq!(queue.mark_ready(), None);
    }

    #[test]
    fn later_click_replaces_a_queued_one() {
        let mut queue = AgentOpenQueue::new();
        assert_eq!(queue.on_activation(Some("session-old".to_string())), None);
        assert_eq!(queue.on_activation(Some("session-new".to_string())), None);
        assert_eq!(queue.mark_ready(), Some("session-new".to_string()));
    }

    #[test]
    fn clicks_without_a_session_are_ignored_by_the_queue() {
        let mut queue = AgentOpenQueue::new();
        assert_eq!(queue.on_activation(None), None);
        assert_eq!(queue.mark_ready(), None);
    }

    #[test]
    fn generic_click_clears_a_stale_queued_agent_open() {
        let mut queue = AgentOpenQueue::new();
        assert_eq!(queue.on_activation(Some("session-old".to_string())), None);
        assert_eq!(queue.on_activation(None), None);
        assert_eq!(queue.mark_ready(), None);
    }

    #[test]
    fn ready_handshake_drains_the_pending_click_once() {
        let mut queue = AgentOpenQueue::new();
        queue.on_activation(Some("session-3".to_string()));
        assert_eq!(queue.mark_ready(), Some("session-3".to_string()));
        assert_eq!(queue.mark_ready(), None);
    }

    #[test]
    fn notification_request_accepts_camel_case_session_id() {
        let request: AppNotificationRequest = serde_json::from_value(serde_json::json!({
            "title": "June finished",
            "body": "Make a PDF",
            "sound": "Ping",
            "group": "june-agent-session-4",
            "sessionId": "session-4"
        }))
        .expect("request should deserialize");
        assert_eq!(request.session_id.as_deref(), Some("session-4"));
        assert_eq!(request.sound.as_deref(), Some("Ping"));
        assert_eq!(request.group.as_deref(), Some("june-agent-session-4"));
    }
}
