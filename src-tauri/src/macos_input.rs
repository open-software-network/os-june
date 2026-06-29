//! Synthetic paste run in the main June process.
//!
//! Phase 1 of moving Accessibility off the dictation helper: the synthetic
//! Cmd+V that inserts a transcript needs the Accessibility grant, so doing it
//! here (rather than in the helper) is part of making `June.app` the sole
//! Accessibility subject. Focus tracking and the shortcut monitor move here too
//! in later steps; for now the helper still drives recording.

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
    use std::sync::Mutex;
    use std::thread;
    use std::time::Duration;

    #[derive(Clone)]
    struct PasteTarget {
        pid: i32,
    }

    static PASTE_TARGET: Mutex<Option<PasteTarget>> = Mutex::new(None);

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

    /// Post a synthetic Cmd+V to the frontmost app via the HID event tap —
    /// mirrors the helper's `postPasteShortcut`. Requires the Accessibility
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

    #[derive(Clone)]
    struct PasteboardSnapshot {
        items: Vec<PasteboardItemSnapshot>,
    }

    #[derive(Clone)]
    struct PasteboardItemSnapshot {
        entries: Vec<(String, Vec<u8>)>,
    }

    /// Every item and type representation currently on the general pasteboard,
    /// captured as plain bytes so dictation can restore the user's clipboard
    /// without flattening multi-item clips such as copied files.
    fn capture(pasteboard: &NSPasteboard) -> PasteboardSnapshot {
        let mut snapshot_items = Vec::new();
        if let Some(items) = pasteboard.pasteboardItems() {
            for item in items.iter() {
                let mut entries = Vec::new();
                for ty in item.types().iter() {
                    if let Some(data) = item.dataForType(&ty) {
                        entries.push((ty.to_string(), data.to_vec()));
                    }
                }
                if !entries.is_empty() {
                    snapshot_items.push(PasteboardItemSnapshot { entries });
                }
            }
        }
        PasteboardSnapshot {
            items: snapshot_items,
        }
    }

    fn restore(pasteboard: &NSPasteboard, snapshot: &PasteboardSnapshot) {
        pasteboard.clearContents();
        if snapshot.items.is_empty() {
            return;
        }

        let restored_items: Vec<Retained<ProtocolObject<dyn NSPasteboardWriting>>> = snapshot
            .items
            .iter()
            .filter_map(|item| {
                let restored = NSPasteboardItem::new();
                for (ty, bytes) in &item.entries {
                    let ty = NSString::from_str(ty);
                    let data = NSData::with_bytes(bytes);
                    restored.setData_forType(&data, &ty);
                }
                (!item.entries.is_empty()).then(|| ProtocolObject::from_retained(restored))
            })
            .collect();

        if restored_items.is_empty() {
            return;
        }

        let objects = NSArray::from_retained_slice(&restored_items);
        pasteboard.writeObjects(&objects);
    }

    fn current_frontmost_target() -> Option<PasteTarget> {
        let workspace = NSWorkspace::sharedWorkspace();
        let frontmost = workspace.frontmostApplication()?;
        let pid = frontmost.processIdentifier();
        (pid > 0).then_some(PasteTarget { pid })
    }

    fn activate_target(target: Option<PasteTarget>) {
        let Some(target) = target else {
            return;
        };
        let Some(app) = NSRunningApplication::runningApplicationWithProcessIdentifier(target.pid)
        else {
            return;
        };
        if app.isTerminated() {
            return;
        }
        app.unhide();
        app.activateWithOptions(NSApplicationActivationOptions::ActivateAllWindows);
    }

    pub fn remember_frontmost_app() {
        if let Ok(mut target) = PASTE_TARGET.lock() {
            *target = current_frontmost_target();
        }
    }

    pub fn clear_target() {
        if let Ok(mut target) = PASTE_TARGET.lock() {
            *target = None;
        }
    }

    fn take_target() -> Option<PasteTarget> {
        PASTE_TARGET
            .lock()
            .ok()
            .and_then(|mut target| target.take())
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        struct PasteboardRestoreGuard {
            snapshot: PasteboardSnapshot,
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

    /// Place `text` on the clipboard, paste it into the frontmost app with a
    /// synthetic Cmd+V, then restore the prior clipboard after the paste lands
    /// (only if it hasn't changed since). Mirrors the helper's
    /// `PasteboardInserter.paste`.
    pub fn paste(text: &str) {
        let target = take_target();
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

        activate_target(target);
        post_paste_shortcut();

        // Restore the user's clipboard once the paste has had time to land,
        // and only if our transcript is still what's on it (don't stomp on a
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

/// Remember the frontmost app so the next paste targets where dictation began.
pub fn remember_frontmost_app() {
    #[cfg(target_os = "macos")]
    {
        imp::remember_frontmost_app();
    }
}

/// Drop any remembered paste target, for example after a discarded recording.
pub fn clear_remembered_frontmost_app() {
    #[cfg(target_os = "macos")]
    {
        imp::clear_target();
    }
}

/// Paste `text` into the frontmost application. No-op off macOS.
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
