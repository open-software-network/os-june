const SYSTEM_AUDIO_MIN_MACOS_VERSION_FILE: &str = "system-audio-min-macos-version.txt";
const DICTATION_HELPER_MIN_MACOS_VERSION: &str = "14.0";

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
    ensure_bundled_hermes_dir();
    tauri_build::build();
}

/// `tauri_build::build()` validates every `bundle.resources` source path at
/// compile time, so the `../.tauri-hermes/hermes` mapping must exist for ANY
/// cargo invocation (`cargo test`, rust-analyzer, dev builds) — not just for
/// `tauri build`. Release CI populates the real runtime via
/// scripts/bundle-hermes-runtime.sh before compiling; everywhere else this
/// placeholder keeps the build green and the app falls back to the managed
/// on-device install (`bundled_hermes_command` finds no launcher in it).
///
/// A populated bundle carries a PIN stamp (the hermes-agent commit it was
/// built from). When that stamp no longer matches the pin in
/// src/hermes_bridge.rs — a developer bumped the pin after bundling — the
/// stale bundle is evicted and replaced with the placeholder rather than
/// silently shipping outdated runtime code.
fn ensure_bundled_hermes_dir() {
    println!("cargo:rerun-if-changed=../.tauri-hermes/hermes/PIN");
    let manifest_dir = std::path::PathBuf::from(
        std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR should be set"),
    );
    let Some(hermes_dir) = manifest_dir
        .parent()
        .map(|repo_dir| repo_dir.join(".tauri-hermes").join("hermes"))
    else {
        return;
    };
    if hermes_dir.exists() {
        if !hermes_dir.join("bin").join("hermes").exists() {
            // Placeholder (or partial) dir: nothing to validate.
            return;
        }
        let stamped = std::fs::read_to_string(hermes_dir.join("PIN"))
            .map(|raw| raw.trim().to_string())
            .unwrap_or_default();
        let pinned = hermes_agent_pinned_commit(&manifest_dir);
        if !stamped.is_empty() && stamped == pinned {
            return;
        }
        println!(
            "cargo:warning=bundled Hermes runtime is stale (built from {stamped:?}, pin is \
             {pinned:?}); evicting it — rerun scripts/bundle-hermes-runtime.sh to bundle again"
        );
        if let Err(error) = std::fs::remove_dir_all(&hermes_dir) {
            println!(
                "cargo:warning=could not remove stale hermes bundle {}: {error}",
                hermes_dir.display()
            );
            return;
        }
    }
    if let Err(error) = std::fs::create_dir_all(&hermes_dir) {
        println!(
            "cargo:warning=could not create {}: {error}",
            hermes_dir.display()
        );
        return;
    }
    let note = "No bundled Hermes runtime in this build. The app installs the managed \
runtime on first launch instead. Release CI runs scripts/bundle-hermes-runtime.sh to \
ship the runtime inside the app.\n";
    if let Err(error) = std::fs::write(hermes_dir.join("PLACEHOLDER.md"), note) {
        println!("cargo:warning=could not write hermes placeholder: {error}");
    }
}

/// Reads HERMES_AGENT_INSTALL_COMMIT out of src/hermes_bridge.rs. A build
/// script cannot import crate constants, so this parses the declaration the
/// same way scripts/bundle-hermes-runtime.sh does — one source of truth.
fn hermes_agent_pinned_commit(manifest_dir: &std::path::Path) -> String {
    let source = std::fs::read_to_string(manifest_dir.join("src").join("hermes_bridge.rs"))
        .unwrap_or_default();
    source
        .lines()
        .find(|line| line.contains("const HERMES_AGENT_INSTALL_COMMIT"))
        .and_then(|line| {
            let start = line.find('"')? + 1;
            let end = line[start..].find('"')? + start;
            Some(line[start..end].to_string())
        })
        .unwrap_or_default()
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
    let system_audio_min_macos_version = read_system_audio_min_macos_version(&manifest_dir)
        .expect("system audio minimum macOS version should be configured");

    let helper_dir = manifest_dir
        .parent()
        .expect("src-tauri should have a repository parent")
        .join(".tauri-helper");
    let app_dir = helper_dir.join("June.app");
    let contents_dir = app_dir.join("Contents");
    let macos_dir = contents_dir.join("MacOS");
    std::fs::create_dir_all(&macos_dir).expect("system audio helper app dir should be created");
    let executable = macos_dir.join("june-system-audio-recorder");

    let executable_current = swift_helper_executable_current(&source, &executable);
    let mut should_sign = false;
    if !executable_current {
        let built = build_universal_swift_executable(
            "system audio helper",
            &manifest_dir,
            &source,
            &executable,
            &system_audio_min_macos_version,
            &[
                "Foundation",
                "AppKit",
                "AVFoundation",
                "CoreAudio",
                "AudioToolbox",
            ],
        );
        if !built {
            println!("cargo:warning=system audio helper could not be built; dual-source mode will report unavailable");
            return;
        }
        should_sign = true;
    }

    let plist = contents_dir.join("Info.plist");
    let plist_contents = format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
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
  <string>{system_audio_min_macos_version}</string>
  <key>LSUIElement</key>
  <true/>
  <key>NSAudioCaptureUsageDescription</key>
  <string>June records system audio locally so generated notes can include meeting or media audio from your Mac.</string>
</dict>
</plist>
"#
    );
    let plist_current =
        std::fs::read_to_string(&plist).is_ok_and(|current| current == plist_contents.as_str());
    if !plist_current {
        std::fs::write(plist, &plist_contents)
            .expect("system audio helper Info.plist should be written");
        should_sign = true;
    }

    if should_sign || has_signing_identity() {
        sign_helper_app(&manifest_dir, &app_dir);
    }
}

fn read_system_audio_min_macos_version(manifest_dir: &std::path::Path) -> Option<String> {
    let version_file = manifest_dir.join(SYSTEM_AUDIO_MIN_MACOS_VERSION_FILE);
    println!("cargo:rerun-if-changed={}", version_file.display());
    let version = std::fs::read_to_string(version_file).ok()?;
    let version = version.trim();
    if version.is_empty() {
        return None;
    }
    Some(version.to_string())
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

    let executable_current = swift_helper_executable_current(&source, &executable);
    let mut should_sign = false;
    if !executable_current {
        let built = build_universal_swift_executable(
            "dictation helper",
            &manifest_dir,
            &source,
            &executable,
            DICTATION_HELPER_MIN_MACOS_VERSION,
            &[
                "Foundation",
                "AppKit",
                "AVFoundation",
                "Carbon",
                "CoreMedia",
                "CoreGraphics",
            ],
        );
        if !built {
            println!("cargo:warning=dictation helper could not be built; dictation will report unavailable");
            return;
        }
        should_sign = true;
    }

    let plist = contents_dir.join("Info.plist");
    let plist_contents = format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
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
  <string>{DICTATION_HELPER_MIN_MACOS_VERSION}</string>
  <key>NSMicrophoneUsageDescription</key>
  <string>June needs microphone access to turn your speech into text.</string>
</dict>
</plist>
"#
    );
    let plist_current =
        std::fs::read_to_string(&plist).is_ok_and(|current| current == plist_contents.as_str());
    if !plist_current {
        std::fs::write(plist, &plist_contents)
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

fn swift_helper_executable_current(source: &std::path::Path, executable: &std::path::Path) -> bool {
    if !executable.exists() {
        return false;
    }

    let source_modified = std::fs::metadata(source)
        .and_then(|metadata| metadata.modified())
        .ok();
    let executable_fresh = source_modified
        .and_then(|source_modified| {
            std::fs::metadata(executable)
                .and_then(|metadata| metadata.modified())
                .ok()
                .map(|executable_modified| executable_modified >= source_modified)
        })
        .unwrap_or(false);
    executable_fresh && executable_has_arches(executable, &["arm64", "x86_64"])
}

fn executable_has_arches(executable: &std::path::Path, required_arches: &[&str]) -> bool {
    let output = std::process::Command::new("lipo")
        .arg("-archs")
        .arg(executable)
        .output();
    let Ok(output) = output else {
        return false;
    };
    if !output.status.success() {
        return false;
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    required_arches
        .iter()
        .all(|required| stdout.split_whitespace().any(|arch| arch == *required))
}

fn build_universal_swift_executable(
    helper_name: &str,
    manifest_dir: &std::path::Path,
    source: &std::path::Path,
    executable: &std::path::Path,
    macos_version: &str,
    frameworks: &[&str],
) -> bool {
    let Some(executable_name) = executable.file_name().and_then(|name| name.to_str()) else {
        println!("cargo:warning={helper_name} executable path has no file name");
        return false;
    };
    let slice_dir = manifest_dir
        .join("target")
        .join("swift-helper-slices")
        .join(format!("{executable_name}-{}", std::process::id()));
    if let Err(error) = std::fs::create_dir_all(&slice_dir) {
        println!("cargo:warning={helper_name} slice dir could not be created: {error}");
        return false;
    }

    let mut slices = Vec::new();
    for swift_arch in ["arm64", "x86_64"] {
        let slice = slice_dir.join(format!("{executable_name}-{swift_arch}"));
        let mut command = std::process::Command::new("swiftc");
        configure_swift_command(&mut command, manifest_dir, swift_arch, macos_version);
        for framework in frameworks {
            command.arg("-framework").arg(framework);
        }
        let status = command.arg(source).arg("-o").arg(&slice).status();
        if !matches!(status, Ok(status) if status.success()) {
            println!("cargo:warning={helper_name} {swift_arch} slice could not be built");
            let _ = std::fs::remove_dir_all(&slice_dir);
            return false;
        }
        slices.push(slice);
    }

    let universal = slice_dir.join(format!("{executable_name}-universal"));
    let mut lipo = std::process::Command::new("lipo");
    lipo.arg("-create").arg("-output").arg(&universal);
    for slice in &slices {
        lipo.arg(slice);
    }
    let status = lipo.status();
    if !matches!(status, Ok(status) if status.success()) {
        println!("cargo:warning={helper_name} universal binary could not be created");
        let _ = std::fs::remove_dir_all(&slice_dir);
        return false;
    }

    if let Ok(permissions) = std::fs::metadata(&slices[0]).map(|metadata| metadata.permissions()) {
        let _ = std::fs::set_permissions(&universal, permissions);
    }
    if let Err(error) = std::fs::rename(&universal, executable) {
        println!("cargo:warning={helper_name} universal binary could not be installed: {error}");
        let _ = std::fs::remove_dir_all(&slice_dir);
        return false;
    }
    let _ = std::fs::remove_dir_all(&slice_dir);
    true
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
    swift_arch: &str,
    macos_version: &str,
) {
    command
        .arg("-target")
        .arg(format!("{swift_arch}-apple-macosx{macos_version}"));
    let module_cache = manifest_dir.join("target").join("swift-module-cache");
    std::fs::create_dir_all(&module_cache).expect("swift module cache dir should be created");
    command.arg("-module-cache-path").arg(module_cache);
}
