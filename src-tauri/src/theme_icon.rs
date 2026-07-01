//! Per-accent dock icon. The frontend calls `set_dock_icon` whenever the
//! Appearance accent changes; on macOS we swap the live application icon
//! (dock + Cmd-Tab) to the matching themed PNG. The themed icons are embedded
//! in the binary so there are no runtime file paths to resolve. Keep the brand
//! ids in sync with BRAND_PRESETS in src/lib/brand.ts.

#[cfg(target_os = "macos")]
fn icon_bytes(brand: &str) -> &'static [u8] {
    match brand {
        "clay" => include_bytes!("../icons/themed/icon-clay.png"),
        "amber" => include_bytes!("../icons/themed/icon-amber.png"),
        "sage" => include_bytes!("../icons/themed/icon-sage.png"),
        "blue" => include_bytes!("../icons/themed/icon-blue.png"),
        "plum" => include_bytes!("../icons/themed/icon-plum.png"),
        // "rose" and anything unrecognized fall back to the default.
        _ => include_bytes!("../icons/themed/icon-rose.png"),
    }
}

/// Swap the live macOS application icon (dock + Cmd-Tab) to the themed icon for
/// `brand`. No-op on non-macOS platforms.
#[tauri::command]
pub fn set_dock_icon(app: tauri::AppHandle, brand: String) {
    #[cfg(target_os = "macos")]
    {
        use objc2::AllocAnyThread;
        use objc2::MainThreadMarker;
        use objc2_app_kit::{NSApplication, NSImage};
        use objc2_foundation::NSData;

        // setApplicationIconImage: must run on the main thread.
        let _ = app.run_on_main_thread(move || {
            let Some(mtm) = MainThreadMarker::new() else {
                return;
            };
            let data = NSData::with_bytes(icon_bytes(&brand));
            let Some(image) = NSImage::initWithData(NSImage::alloc(), &data) else {
                return;
            };
            let ns_app = NSApplication::sharedApplication(mtm);
            // Safety: standard AppKit call, invoked on the main thread via
            // run_on_main_thread + a valid MainThreadMarker.
            unsafe { ns_app.setApplicationIconImage(Some(&image)) };
        });
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, brand);
    }
}
