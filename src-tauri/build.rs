fn main() {
    println!("cargo:rerun-if-changed=tauri.conf.json");
    println!("cargo:rerun-if-changed=icons/icon.icns");
    println!("cargo:rerun-if-changed=icons/icon.png");
    println!("cargo:rerun-if-changed=icons/32x32.png");
    println!("cargo:rerun-if-changed=icons/128x128.png");
    println!("cargo:rerun-if-changed=icons/128x128@2x.png");
    build_system_audio_helper();
    tauri_build::build();
}

fn build_system_audio_helper() {
    if std::env::var("CARGO_CFG_TARGET_OS").ok().as_deref() != Some("macos") {
        return;
    }
    let manifest_dir = std::path::PathBuf::from(
        std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR should be set"),
    );
    let source = manifest_dir
        .join("native")
        .join("mac-system-audio-recorder")
        .join("main.swift");
    if !source.exists() {
        return;
    }
    println!("cargo:rerun-if-changed={}", source.display());

    let helper_dir = manifest_dir
        .parent()
        .expect("src-tauri should have a repository parent")
        .join(".tauri-helper");
    let app_dir = helper_dir.join("OS Notetaker Audio Capture.app");
    let contents_dir = app_dir.join("Contents");
    let macos_dir = contents_dir.join("MacOS");
    std::fs::create_dir_all(&macos_dir).expect("system audio helper app dir should be created");
    let executable = macos_dir.join("os-notetaker-system-audio-recorder");

    let source_modified = std::fs::metadata(&source)
        .and_then(|metadata| metadata.modified())
        .ok();
    let executable_current = executable.exists()
        && source_modified
            .and_then(|source_modified| {
                std::fs::metadata(&executable)
                    .and_then(|metadata| metadata.modified())
                    .ok()
                    .map(|executable_modified| executable_modified >= source_modified)
            })
            .unwrap_or(false);
    let mut should_sign = false;
    if !executable_current {
        let status = std::process::Command::new("swiftc")
            .arg("-framework")
            .arg("Foundation")
            .arg("-framework")
            .arg("AppKit")
            .arg("-framework")
            .arg("AVFoundation")
            .arg("-framework")
            .arg("CoreAudio")
            .arg("-framework")
            .arg("AudioToolbox")
            .arg(&source)
            .arg("-o")
            .arg(&executable)
            .status();
        if !matches!(status, Ok(status) if status.success()) {
            println!("cargo:warning=system audio helper could not be built; dual-source mode will report unavailable");
            return;
        }
        should_sign = true;
    }

    let plist = contents_dir.join("Info.plist");
    let plist_contents = r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "https://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>en</string>
  <key>CFBundleDisplayName</key>
  <string>OS Notetaker Audio Capture</string>
  <key>CFBundleExecutable</key>
  <string>os-notetaker-system-audio-recorder</string>
  <key>CFBundleIdentifier</key>
  <string>network.opensoftware.os-notetaker.audio-capture</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>OS Notetaker Audio Capture</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>0.1.0</string>
  <key>CFBundleVersion</key>
  <string>1</string>
  <key>LSMinimumSystemVersion</key>
  <string>14.2</string>
  <key>LSUIElement</key>
  <true/>
  <key>NSAudioCaptureUsageDescription</key>
  <string>OS Notetaker records system audio locally so generated notes can include meeting or media audio from your Mac.</string>
</dict>
</plist>
"#;
    let plist_current =
        std::fs::read_to_string(&plist).is_ok_and(|current| current == plist_contents);
    if !plist_current {
        std::fs::write(plist, plist_contents)
            .expect("system audio helper Info.plist should be written");
        should_sign = true;
    }

    if should_sign {
        let _ = std::process::Command::new("codesign")
            .arg("--force")
            .arg("--deep")
            .arg("--sign")
            .arg("-")
            .arg(&app_dir)
            .status();
    }
}
