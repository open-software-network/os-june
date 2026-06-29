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
    use objc2_app_kit::{NSPasteboard, NSPasteboardType, NSPasteboardTypeString};
    use objc2_foundation::{NSArray, NSData, NSString};
    use std::ffi::c_void;
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

    /// Every (type, data) representation currently on the general pasteboard,
    /// captured as plain bytes so dictation can restore the user's clipboard
    /// without permanently clobbering it. Plain Rust data is `Send`, so the
    /// delayed restore can run on a background thread (as the helper did).
    fn capture(pasteboard: &NSPasteboard) -> Vec<(String, Vec<u8>)> {
        let mut entries = Vec::new();
        if let Some(types) = pasteboard.types() {
            for ty in types.iter() {
                if let Some(data) = pasteboard.dataForType(&ty) {
                    entries.push((ty.to_string(), data.to_vec()));
                }
            }
        }
        entries
    }

    fn restore(pasteboard: &NSPasteboard, entries: &[(String, Vec<u8>)]) {
        pasteboard.clearContents();
        if entries.is_empty() {
            return;
        }
        let ns_types: Vec<Retained<NSPasteboardType>> =
            entries.iter().map(|(ty, _)| NSString::from_str(ty)).collect();
        let types_array = NSArray::from_retained_slice(&ns_types);
        // SAFETY: re-declaring the captured types and writing back their data.
        unsafe {
            pasteboard.declareTypes_owner(&types_array, None);
            for ((_, bytes), ty) in entries.iter().zip(ns_types.iter()) {
                let data = NSData::with_bytes(bytes);
                pasteboard.setData_forType(Some(&data), ty);
            }
        }
    }

    /// Place `text` on the clipboard, paste it into the frontmost app with a
    /// synthetic Cmd+V, then restore the prior clipboard after the paste lands
    /// (only if it hasn't changed since). Mirrors the helper's
    /// `PasteboardInserter.paste`.
    pub fn paste(text: &str) {
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
