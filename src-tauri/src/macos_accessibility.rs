//! Accessibility (TCC) trust for the main June process.
//!
//! Phase 1 of moving Accessibility off the dictation helper: by calling the
//! Accessibility API from the *main* app process, `June.app` — not
//! `June Dictation Helper.app` — is what macOS registers in
//! System Settings > Privacy & Security > Accessibility. The synthetic paste
//! and the global modifier-key monitor that actually consume the grant move
//! into this process too (see `macos_input`), so the helper no longer needs
//! Accessibility at all.

#[cfg(target_os = "macos")]
mod imp {
    use std::ffi::c_void;
    use std::os::raw::c_uchar;

    type CFTypeRef = *const c_void;
    type CFStringRef = *const c_void;
    type CFDictionaryRef = *const c_void;
    type CFAllocatorRef = *const c_void;
    type Boolean = c_uchar;

    // The dictionary callback structs are opaque to us; we only ever take their
    // address to hand to CFDictionaryCreate, so a zero-sized opaque is enough.
    #[repr(C)]
    struct CFDictionaryKeyCallBacks {
        _opaque: [u8; 0],
    }
    #[repr(C)]
    struct CFDictionaryValueCallBacks {
        _opaque: [u8; 0],
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        static kCFBooleanTrue: CFTypeRef;
        static kCFTypeDictionaryKeyCallBacks: CFDictionaryKeyCallBacks;
        static kCFTypeDictionaryValueCallBacks: CFDictionaryValueCallBacks;
        fn CFDictionaryCreate(
            allocator: CFAllocatorRef,
            keys: *const CFTypeRef,
            values: *const CFTypeRef,
            num_values: isize,
            key_callbacks: *const CFDictionaryKeyCallBacks,
            value_callbacks: *const CFDictionaryValueCallBacks,
        ) -> CFDictionaryRef;
        fn CFRelease(cf: CFTypeRef);
    }

    // AXIsProcessTrusted* live in the HIServices sub-framework, reachable
    // through the ApplicationServices umbrella framework.
    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        static kAXTrustedCheckOptionPrompt: CFStringRef;
        fn AXIsProcessTrusted() -> Boolean;
        fn AXIsProcessTrustedWithOptions(options: CFDictionaryRef) -> Boolean;
    }

    /// Whether this process is currently trusted for Accessibility. Silent — it
    /// never prompts and never adds the app to the list, so it is safe to poll
    /// for status display.
    pub fn is_trusted() -> bool {
        // SAFETY: AXIsProcessTrusted takes no arguments and returns a Boolean.
        unsafe { AXIsProcessTrusted() != 0 }
    }

    /// Prompt for Accessibility when not yet granted. The prompting variant is
    /// the one that registers *this process* (June.app) in the Accessibility
    /// list and surfaces the system "control this computer" dialog; the silent
    /// `is_trusted` never adds an entry. Returns the current trust state.
    pub fn prompt_and_check() -> bool {
        // SAFETY: we build a one-entry CFDictionary { kAXTrustedCheckOptionPrompt:
        // kCFBooleanTrue } with the standard CF type callbacks, pass it to
        // AXIsProcessTrustedWithOptions, then release the dictionary we created.
        unsafe {
            let keys: [CFTypeRef; 1] = [kAXTrustedCheckOptionPrompt as CFTypeRef];
            let values: [CFTypeRef; 1] = [kCFBooleanTrue];
            let options = CFDictionaryCreate(
                std::ptr::null(),
                keys.as_ptr(),
                values.as_ptr(),
                1,
                &kCFTypeDictionaryKeyCallBacks,
                &kCFTypeDictionaryValueCallBacks,
            );
            let trusted = AXIsProcessTrustedWithOptions(options) != 0;
            if !options.is_null() {
                CFRelease(options);
            }
            trusted
        }
    }
}

/// Whether the main process is trusted for Accessibility. Non-macOS always
/// reports trusted so callers can treat the permission as a no-op there.
pub fn is_trusted() -> bool {
    #[cfg(target_os = "macos")]
    {
        imp::is_trusted()
    }
    #[cfg(not(target_os = "macos"))]
    {
        true
    }
}

/// Prompt for Accessibility (registering June.app in the list) and return the
/// resulting trust state. A no-op that reports trusted off macOS.
pub fn prompt_and_check() -> bool {
    #[cfg(target_os = "macos")]
    {
        imp::prompt_and_check()
    }
    #[cfg(not(target_os = "macos"))]
    {
        true
    }
}
