fn main() {
    println!("cargo:rerun-if-changed=tauri.conf.json");
    println!("cargo:rerun-if-changed=Entitlements.plist");
    println!("cargo:rerun-if-changed=icons/icon.icns");
    println!("cargo:rerun-if-changed=icons/icon.png");
    println!("cargo:rerun-if-changed=icons/32x32.png");
    println!("cargo:rerun-if-changed=icons/128x128.png");
    println!("cargo:rerun-if-changed=icons/128x128@2x.png");
    println!("cargo:rerun-if-env-changed=OS_ACCOUNTS_URL");
    println!("cargo:rerun-if-env-changed=OS_ACCOUNTS_API_URL");
    println!("cargo:rerun-if-env-changed=OS_ACCOUNTS_CLIENT_ID");
    println!("cargo:rerun-if-env-changed=SCRIBE_API_URL");
    clean_legacy_helper_bundles();
    build_system_audio_helper();
    build_dictation_helper();
    tauri_build::build();
}

/// Remove pre-rename ("OS Scribe") helper bundles from `.tauri-helper` so
/// stale copies don't linger next to the renamed June bundles.
fn clean_legacy_helper_bundles() {
    if std::env::var("CARGO_CFG_TARGET_OS").ok().as_deref() != Some("macos") {
        return;
    }
    let manifest_dir = std::path::PathBuf::from(
        std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR should be set"),
    );
    let Some(helper_dir) = manifest_dir
        .parent()
        .map(|repo_dir| repo_dir.join(".tauri-helper"))
    else {
        return;
    };
    for legacy in ["OS Scribe.app", "OS Scribe Dictation Helper.app"] {
        let _ = std::fs::remove_dir_all(helper_dir.join(legacy));
    }
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
    let app_dir = helper_dir.join("June.app");
    let contents_dir = app_dir.join("Contents");
    let macos_dir = contents_dir.join("MacOS");
    std::fs::create_dir_all(&macos_dir).expect("system audio helper app dir should be created");
    let executable = macos_dir.join("june-system-audio-recorder");

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
        let mut command = std::process::Command::new("swiftc");
        configure_swift_command(&mut command, &manifest_dir, "14.2");
        let status = command
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
  <string>June</string>
  <key>CFBundleExecutable</key>
  <string>june-system-audio-recorder</string>
  <key>CFBundleIdentifier</key>
  <string>co.opensoftware.scribe.audio-capture</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>June</string>
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
  <string>June records system audio locally so generated notes can include meeting or media audio from your Mac.</string>
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

    if should_sign || has_signing_identity() {
        sign_helper_app(&manifest_dir, &app_dir);
    }
}

fn build_dictation_helper() {
    if std::env::var("CARGO_CFG_TARGET_OS").ok().as_deref() != Some("macos") {
        return;
    }
    let manifest_dir = std::path::PathBuf::from(
        std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR should be set"),
    );
    let source = manifest_dir
        .join("native")
        .join("mac-dictation-helper")
        .join("main.swift");
    if !source.exists() {
        return;
    }
    println!("cargo:rerun-if-changed={}", source.display());

    let helper_dir = manifest_dir
        .parent()
        .expect("src-tauri should have a repository parent")
        .join(".tauri-helper");
    let app_dir = helper_dir.join("June Dictation Helper.app");
    let contents_dir = app_dir.join("Contents");
    let macos_dir = contents_dir.join("MacOS");
    let resources_dir = contents_dir.join("Resources");
    std::fs::create_dir_all(&macos_dir).expect("dictation helper app dir should be created");
    std::fs::create_dir_all(&resources_dir)
        .expect("dictation helper resources dir should be created");
    let executable = macos_dir.join("june-dictation-helper");

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
        let mut command = std::process::Command::new("swiftc");
        configure_swift_command(&mut command, &manifest_dir, "14.0");
        let status = command
            .arg("-framework")
            .arg("Foundation")
            .arg("-framework")
            .arg("AppKit")
            .arg("-framework")
            .arg("AVFoundation")
            .arg("-framework")
            .arg("Carbon")
            .arg("-framework")
            .arg("CoreMedia")
            .arg("-framework")
            .arg("CoreGraphics")
            .arg(&source)
            .arg("-o")
            .arg(&executable)
            .status();
        if !matches!(status, Ok(status) if status.success()) {
            println!("cargo:warning=dictation helper could not be built; dictation will report unavailable");
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
  <string>June Dictation Helper</string>
  <key>CFBundleExecutable</key>
  <string>june-dictation-helper</string>
  <key>CFBundleIdentifier</key>
  <string>co.opensoftware.scribe.dictation-helper</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>June Dictation Helper</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>0.1.0</string>
  <key>CFBundleVersion</key>
  <string>1</string>
  <key>LSUIElement</key>
  <true/>
  <key>LSMinimumSystemVersion</key>
  <string>13.0</string>
  <key>NSMicrophoneUsageDescription</key>
  <string>June needs microphone access to turn your speech into text.</string>
</dict>
</plist>
"#;
    let plist_current =
        std::fs::read_to_string(&plist).is_ok_and(|current| current == plist_contents);
    if !plist_current {
        std::fs::write(plist, plist_contents)
            .expect("dictation helper Info.plist should be written");
        should_sign = true;
    }

    let public_sounds_dir = manifest_dir
        .parent()
        .expect("src-tauri should have a repository parent")
        .join("public")
        .join("sounds");
    for sound in ["record-start.mp3", "record-end.mp3"] {
        let source = public_sounds_dir.join(sound);
        println!("cargo:rerun-if-changed={}", source.display());
        let destination = resources_dir.join(sound);
        let source_bytes = std::fs::read(&source).unwrap_or_else(|error| {
            panic!(
                "dictation sound {} should be readable: {error}",
                source.display()
            )
        });
        let destination_current =
            std::fs::read(&destination).is_ok_and(|current| current == source_bytes);
        if !destination_current {
            std::fs::write(&destination, source_bytes).unwrap_or_else(|error| {
                panic!(
                    "dictation sound {} should be copied to helper resources: {error}",
                    destination.display()
                )
            });
            should_sign = true;
        }
    }

    if should_sign || has_signing_identity() {
        sign_helper_app(&manifest_dir, &app_dir);
    }
}

fn has_signing_identity() -> bool {
    std::env::var("APPLE_SIGNING_IDENTITY")
        .ok()
        .is_some_and(|value| !value.trim().is_empty())
}

fn sign_helper_app(manifest_dir: &std::path::Path, app_dir: &std::path::Path) {
    let identity = std::env::var("APPLE_SIGNING_IDENTITY")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "-".to_string());
    let entitlements = manifest_dir.join("Entitlements.plist");
    let mut command = std::process::Command::new("codesign");
    command
        .arg("--force")
        .arg("--deep")
        .arg("--entitlements")
        .arg(entitlements)
        .arg("--sign")
        .arg(&identity);
    if identity != "-" {
        command.arg("--timestamp").arg("--options").arg("runtime");
    }
    let status = command.arg(app_dir).status();
    if !matches!(status, Ok(status) if status.success()) {
        println!(
            "cargo:warning=helper app could not be signed: {}",
            app_dir.display()
        );
    }
}

fn configure_swift_command(
    command: &mut std::process::Command,
    manifest_dir: &std::path::Path,
    macos_version: &str,
) {
    if let Some(target) = swift_target(macos_version) {
        command.arg("-target").arg(target);
    }
    let module_cache = manifest_dir.join("target").join("swift-module-cache");
    std::fs::create_dir_all(&module_cache).expect("swift module cache dir should be created");
    command.arg("-module-cache-path").arg(module_cache);
}

fn swift_target(macos_version: &str) -> Option<String> {
    match std::env::var("HOST").ok()?.as_str() {
        "aarch64-apple-darwin" => Some(format!("arm64-apple-macosx{macos_version}")),
        "x86_64-apple-darwin" => Some(format!("x86_64-apple-macosx{macos_version}")),
        _ => None,
    }
}
