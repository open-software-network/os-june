//! Synthetic paste + paste-target tracking, run in the main June process.
//!
//! Part of moving Accessibility off the dictation helper: the synthetic Cmd+V
//! that inserts a transcript needs the Accessibility grant, so doing it here
//! (rather than in the helper) makes `June.app` the sole Accessibility subject.
//! [`remember_focus_target`] records the app that was frontmost when dictation
//! started so the paste lands there even if a June window grabbed focus.

#[cfg(target_os = "macos")]
mod imp {
    use objc2::rc::Retained;
    use objc2::runtime::ProtocolObject;
    use objc2_app_kit::{
        NSApplicationActivationOptions, NSPasteboard, NSPasteboardItem, NSPasteboardTypeString,
        NSPasteboardWriting, NSRunningApplication, NSWorkspace,
    };
    use objc2_foundation::{NSArray, NSData, NSString};
    use std::ffi::c_void;
    use std::sync::atomic::{AtomicI32, Ordering};
    use std::thread;
    use std::time::Duration;

    // --- CoreGraphics synthetic keystroke (Cmd+V) -------------------------
    type CGEventSourceRef = *mut c_void;
    type CGEventRef = *mut c_void;

    const KEY_V: u16 = 9; // kVK_ANSI_V
    const FLAG_COMMAND: u64 = 1 << 20; // kCGEventFlagMaskCommand
    const HID_SYSTEM_STATE: i32 = 1; // kCGEventSourceStateHIDSystemState
    const HID_EVENT_TAP: u32 = 0; // kCGHIDEventTap

    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGEventSourceCreate(state_id: i32) -> CGEventSourceRef;
        fn CGEventCreateKeyboardEvent(
            source: CGEventSourceRef,
            virtual_key: u16,
            key_down: bool,
        ) -> CGEventRef;
        fn CGEventSetFlags(event: CGEventRef, flags: u64);
        fn CGEventPost(tap: u32, event: CGEventRef);
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFRelease(cf: *const c_void);
    }

    /// PID of the app that was frontmost when dictation started. 0 = unset.
    static FOCUS_TARGET_PID: AtomicI32 = AtomicI32::new(0);

    /// Record the frontmost application as the paste target. Called when
    /// dictation starts (a shortcut press). At that point the user's target app
    /// is frontmost, not June. June itself is never recorded as the target.
    pub fn remember_focus_target() {
        let workspace = NSWorkspace::sharedWorkspace();
        let pid = workspace
            .frontmostApplication()
            .map(|app| app.processIdentifier())
            .unwrap_or(0);
        if pid > 0 && pid != std::process::id() as i32 {
            FOCUS_TARGET_PID.store(pid, Ordering::Relaxed);
        } else {
            clear_focus_target();
        }
    }

    pub fn clear_focus_target() {
        FOCUS_TARGET_PID.store(0, Ordering::Relaxed);
    }

    fn take_focus_target() -> i32 {
        FOCUS_TARGET_PID.swap(0, Ordering::Relaxed)
    }

    /// Bring the recorded target app back to the front before pasting, so a
    /// June window that grabbed focus mid-recording does not swallow Cmd+V.
    fn activate_focus_target(pid: i32) {
        if pid == 0 {
            return;
        }
        let Some(app) = NSRunningApplication::runningApplicationWithProcessIdentifier(pid) else {
            return;
        };
        if app.isTerminated() {
            return;
        }
        app.unhide();
        app.activateWithOptions(NSApplicationActivationOptions::ActivateAllWindows);
        thread::sleep(Duration::from_millis(120));
    }

    /// Post a synthetic Cmd+V to the frontmost app via the HID event tap.
    /// Mirrors the helper's `postPasteShortcut`. Requires the Accessibility
    /// grant, which is now held by this process.
    fn post_paste_shortcut() {
        // SAFETY: standard CoreGraphics event-posting sequence; every event we
        // create with a Create-rule function is released after posting.
        unsafe {
            let source = CGEventSourceCreate(HID_SYSTEM_STATE);
            let key_down = CGEventCreateKeyboardEvent(source, KEY_V, true);
            let key_up = CGEventCreateKeyboardEvent(source, KEY_V, false);
            if !key_down.is_null() {
                CGEventSetFlags(key_down, FLAG_COMMAND);
                CGEventPost(HID_EVENT_TAP, key_down);
                CFRelease(key_down);
            }
            if !key_up.is_null() {
                CGEventSetFlags(key_up, FLAG_COMMAND);
                CGEventPost(HID_EVENT_TAP, key_up);
                CFRelease(key_up);
            }
            if !source.is_null() {
                CFRelease(source);
            }
        }
    }

    /// The general pasteboard captured as plain bytes, preserving each item
    /// separately (a clipboard can hold several items, e.g. multiple copied
    /// files). Plain Rust data is `Send`, so the delayed restore can run on a
    /// background thread.
    type Snapshot = Vec<Vec<(String, Vec<u8>)>>;

    fn capture(pasteboard: &NSPasteboard) -> Snapshot {
        let mut items = Vec::new();
        if let Some(pasteboard_items) = pasteboard.pasteboardItems() {
            for item in pasteboard_items.iter() {
                let mut entries = Vec::new();
                for ty in item.types().iter() {
                    if let Some(data) = item.dataForType(&ty) {
                        entries.push((ty.to_string(), data.to_vec()));
                    }
                }
                if !entries.is_empty() {
                    items.push(entries);
                }
            }
        }
        items
    }

    fn restore(pasteboard: &NSPasteboard, items: &Snapshot) {
        pasteboard.clearContents();
        if items.is_empty() {
            return;
        }
        let restored: Vec<Retained<ProtocolObject<dyn NSPasteboardWriting>>> = items
            .iter()
            .filter_map(|entries| {
                if entries.is_empty() {
                    return None;
                }
                let item = NSPasteboardItem::new();
                for (ty, bytes) in entries {
                    let data = NSData::with_bytes(bytes);
                    let ty = NSString::from_str(ty);
                    item.setData_forType(&data, &ty);
                }
                Some(ProtocolObject::from_retained(item))
            })
            .collect();
        if restored.is_empty() {
            return;
        }
        let array = NSArray::from_retained_slice(&restored);
        pasteboard.writeObjects(&array);
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        struct PasteboardRestoreGuard {
            snapshot: Snapshot,
        }

        impl Drop for PasteboardRestoreGuard {
            fn drop(&mut self) {
                let pasteboard = NSPasteboard::generalPasteboard();
                restore(&pasteboard, &self.snapshot);
            }
        }

        #[test]
        fn restore_keeps_each_pasteboard_item_separate() {
            let pasteboard = NSPasteboard::generalPasteboard();
            let _guard = PasteboardRestoreGuard {
                snapshot: capture(&pasteboard),
            };

            pasteboard.clearContents();

            let first_type = NSString::from_str("public.utf8-plain-text");
            let second_type = NSString::from_str("public.html");
            let first = NSPasteboardItem::new();
            first.setData_forType(&NSData::with_bytes(b"one"), &first_type);
            let second = NSPasteboardItem::new();
            second.setData_forType(&NSData::with_bytes(b"two"), &second_type);
            let items: Vec<Retained<ProtocolObject<dyn NSPasteboardWriting>>> = vec![
                ProtocolObject::from_retained(first),
                ProtocolObject::from_retained(second),
            ];
            let objects = NSArray::from_retained_slice(&items);
            assert!(pasteboard.writeObjects(&objects));

            let snapshot = capture(&pasteboard);
            restore(&pasteboard, &snapshot);

            let restored = pasteboard
                .pasteboardItems()
                .expect("pasteboard items should restore");
            assert_eq!(restored.count(), 2);
            let first = restored.objectAtIndex(0);
            let second = restored.objectAtIndex(1);
            assert!(first.dataForType(&first_type).is_some());
            assert!(second.dataForType(&second_type).is_some());
            assert!(first.dataForType(&second_type).is_none());
            assert!(second.dataForType(&first_type).is_none());
        }
    }

    /// Place `text` on the clipboard, bring the recorded target app forward,
    /// paste with a synthetic Cmd+V, then restore the prior clipboard once the
    /// paste has landed (only if it has not changed since). Mirrors the
    /// helper's `PasteboardInserter.paste`.
    pub fn paste(text: &str) {
        let target_pid = take_focus_target();
        let pasteboard = NSPasteboard::generalPasteboard();
        let snapshot = capture(&pasteboard);

        pasteboard.clearContents();
        let ns_text = NSString::from_str(text);
        // NSPasteboardTypeString is an extern static (unsafe to read); the
        // pasteboard methods themselves are safe.
        let string_type = unsafe { NSPasteboardTypeString };
        let wrote = pasteboard.setString_forType(&ns_text, string_type);
        if !wrote {
            restore(&pasteboard, &snapshot);
            return;
        }

        activate_focus_target(target_pid);
        post_paste_shortcut();

        // Restore the user's clipboard once the paste has had time to land,
        // and only if our transcript is still what's on it (do not stomp on a
        // copy the user made in the meantime).
        let text_owned = text.to_string();
        thread::spawn(move || {
            thread::sleep(Duration::from_millis(700));
            let pasteboard = NSPasteboard::generalPasteboard();
            let string_type = unsafe { NSPasteboardTypeString };
            let current = pasteboard.stringForType(string_type);
            let still_ours = current
                .map(|value| value.to_string() == text_owned)
                .unwrap_or(false);
            if still_ours {
                restore(&pasteboard, &snapshot);
            }
        });
    }
}

/// Record the frontmost app as the paste target (call when dictation starts).
/// No-op off macOS.
pub fn remember_focus_target() {
    #[cfg(target_os = "macos")]
    {
        imp::remember_focus_target();
    }
}

/// Drop any remembered paste target, for example after a discarded recording.
/// No-op off macOS.
pub fn clear_focus_target() {
    #[cfg(target_os = "macos")]
    {
        imp::clear_focus_target();
    }
}

/// Paste `text` into the recorded target application. No-op off macOS.
pub fn paste(text: &str) {
    #[cfg(target_os = "macos")]
    {
        imp::paste(text);
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = text;
    }
}
