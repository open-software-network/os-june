const SYSTEM_AUDIO_MIN_MACOS_VERSION_FILE: &str = "system-audio-min-macos-version.txt";
const DICTATION_HELPER_MIN_MACOS_VERSION: &str = "14.0";
const EXPECTED_MACOS_ARCHITECTURES: &str = "arm64 x86_64";

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
    println!("cargo:rerun-if-env-changed=GOOGLE_OAUTH_CLIENT_ID");
    println!("cargo:rerun-if-env-changed=GOOGLE_OAUTH_CLIENT_SECRET");
    println!("cargo:rerun-if-env-changed=JUNE_API_URL");
    if std::env::var("CARGO_CFG_TARGET_OS").ok().as_deref() == Some("macos") {
        println!("cargo:rustc-link-lib=framework=AVFoundation");
        link_swift_runtime();
    }
    clean_legacy_helper_bundles();
    build_system_audio_helper();
    build_dictation_helper();
    prepare_computer_use_driver();
    build_windows_dictation_helper();
    ensure_bundled_hermes_dir();
    ensure_bundled_extension_dir();
    ensure_nm_shim_placeholder();
    tauri_build::build();
}

/// Swift-backed dependencies emit their runtime search paths from dependency
/// build scripts, but those linker arguments do not reach this package's final
/// binaries. Resolve the active toolchain through `xcrun` so both full Xcode
/// and Command Line Tools layouts work without runner-specific paths.
fn link_swift_runtime() {
    println!("cargo:rerun-if-env-changed=DEVELOPER_DIR");
    println!("cargo:rerun-if-env-changed=TOOLCHAINS");
    println!("cargo:rustc-link-arg=-Wl,-rpath,/usr/lib/swift");

    let output = std::process::Command::new("xcrun")
        .args(["--find", "swiftc"])
        .output()
        .unwrap_or_else(|error| {
            panic!("failed to run `xcrun --find swiftc`; Swift runtime rpath is required: {error}")
        });
    assert!(
        output.status.success(),
        "`xcrun --find swiftc` failed; Swift runtime rpath is required: {}",
        String::from_utf8_lossy(&output.stderr).trim()
    );

    let swiftc = std::path::PathBuf::from(String::from_utf8_lossy(&output.stdout).trim());
    let toolchain_usr = swiftc
        .parent()
        .and_then(std::path::Path::parent)
        .unwrap_or_else(|| panic!("swiftc path has no toolchain root: {}", swiftc.display()));
    let mut linked_runtime = false;
    for relative in ["lib/swift-5.5/macosx", "lib/swift/macosx"] {
        let runtime = toolchain_usr.join(relative);
        if runtime.is_dir() {
            linked_runtime = true;
            println!("cargo:rustc-link-search=native={}", runtime.display());
            println!("cargo:rustc-link-arg=-Wl,-rpath,{}", runtime.display());
        }
    }
    assert!(
        linked_runtime,
        "active Swift toolchain has no supported macOS runtime directory: {}",
        toolchain_usr.display()
    );
}

/// `tauri_build::build()` validates resource source directories during every
/// Cargo invocation, while `extension/dist` is intentionally gitignored.
/// Ordinary tests and rust-analyzer only need the directory to exist. Tauri
/// packaging runs `pnpm extension:build` first and replaces its contents with
/// the fresh extension whose manifest retains the pinned development key.
fn ensure_bundled_extension_dir() {
    let manifest_dir = std::path::PathBuf::from(
        std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR should be set"),
    );
    let Some(extension_dir) = manifest_dir
        .parent()
        .map(|repo_dir| repo_dir.join("extension").join("dist"))
    else {
        return;
    };
    println!(
        "cargo:rerun-if-changed={}",
        manifest_dir
            .parent()
            .expect("src-tauri should have a repository parent")
            .join("extension")
            .join("public")
            .join("manifest.json")
            .display()
    );
    if let Err(error) = std::fs::create_dir_all(&extension_dir) {
        println!("cargo:warning=could not create extension resource directory: {error}");
    }
}

/// Keep the Tauri resource source present for ordinary `cargo test` and
/// rust-analyzer runs. Packaging entry points run
/// `scripts/prepare-cua-driver.mjs` first and replace this placeholder with the
/// authenticated narrow helper built from the locked upstream source commit.
/// A real bundle is re-signed here so its nested signature matches June's
/// build identity.
fn prepare_computer_use_driver() {
    if std::env::var("CARGO_CFG_TARGET_OS").ok().as_deref() != Some("macos") {
        return;
    }
    let manifest_dir = std::path::PathBuf::from(
        std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR should be set"),
    );
    println!(
        "cargo:rerun-if-changed={}",
        manifest_dir.join("cua-driver-pin.json").display()
    );
    for source in ["src/computer_use_driver.rs", "Cargo.toml", "Cargo.lock"] {
        println!(
            "cargo:rerun-if-changed={}",
            manifest_dir.join(source).display()
        );
    }
    let app_dir = manifest_dir
        .parent()
        .expect("src-tauri should have a repository parent")
        .join(".tauri-helper")
        .join("June Computer Use Driver.app");
    let executable = app_dir
        .join("Contents")
        .join("MacOS")
        .join("june-computer-use-driver");
    let stamp = app_dir
        .join("Contents")
        .join("Resources")
        .join("june-cua-driver-pin.json");
    println!("cargo:rerun-if-env-changed=APPLE_SIGNING_IDENTITY");
    println!("cargo:rerun-if-changed={}", executable.display());
    println!("cargo:rerun-if-changed={}", stamp.display());
    if !executable.exists() {
        let placeholder = app_dir
            .join("Contents")
            .join("Resources")
            .join("PLACEHOLDER.md");
        if let Some(parent) = placeholder.parent() {
            std::fs::create_dir_all(parent)
                .expect("computer use driver placeholder directory should be created");
        }
        std::fs::write(
            placeholder,
            "No cua-driver in this non-packaging build. Run pnpm computer-use:prepare on macOS.\n",
        )
        .expect("computer use driver placeholder should be written");
        return;
    }
    verify_computer_use_driver_source(
        &manifest_dir,
        &manifest_dir.join("cua-driver-pin.json"),
        &stamp,
        &executable,
    );
    sign_computer_use_driver(&app_dir);
}

fn verify_computer_use_driver_source(
    manifest_dir: &std::path::Path,
    pin_path: &std::path::Path,
    stamp_path: &std::path::Path,
    executable: &std::path::Path,
) {
    use sha2::{Digest, Sha256};

    let pin: serde_json::Value = serde_json::from_slice(
        &std::fs::read(pin_path).expect("computer use driver pin should be readable"),
    )
    .expect("computer use driver pin should be valid JSON");
    let expected_version = pin
        .get("version")
        .and_then(serde_json::Value::as_str)
        .expect("computer use driver pin should include version");
    let expected_commit = pin
        .get("sourceCommit")
        .and_then(serde_json::Value::as_str)
        .expect("computer use driver pin should include sourceCommit");
    let output = std::process::Command::new(executable)
        .arg("--version")
        .output()
        .expect("computer use driver version probe should run");
    assert!(
        output.status.success(),
        "computer use driver version probe failed"
    );
    let raw = format!(
        "{} {}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let fields: Vec<&str> = raw.split_whitespace().collect();
    assert_eq!(
        fields.as_slice(),
        [
            "june-computer-use-driver",
            expected_version,
            expected_commit
        ],
        "computer use helper does not match the pinned upstream source"
    );

    let stamp: serde_json::Value = serde_json::from_slice(
        &std::fs::read(stamp_path).expect("computer use driver stamp should be readable"),
    )
    .expect("computer use driver stamp should be valid JSON");
    let mut source_hash = Sha256::new();
    for (relative, source) in [
        (
            "src-tauri/src/computer_use_driver.rs",
            manifest_dir.join("src/computer_use_driver.rs"),
        ),
        ("src-tauri/Cargo.toml", manifest_dir.join("Cargo.toml")),
        ("src-tauri/Cargo.lock", manifest_dir.join("Cargo.lock")),
    ] {
        source_hash.update(relative.as_bytes());
        source_hash.update(b"\0");
        source_hash
            .update(std::fs::read(source).expect("computer use helper source should be readable"));
        source_hash.update(b"\0");
    }
    let expected_source_hash = format!("{:x}", source_hash.finalize());
    assert_eq!(
        stamp
            .pointer("/juneBuild/sourceSha256")
            .and_then(serde_json::Value::as_str),
        Some(expected_source_hash.as_str()),
        "computer use helper stamp does not match June's helper source"
    );
}

fn sign_computer_use_driver(app_dir: &std::path::Path) {
    let identity = std::env::var("APPLE_SIGNING_IDENTITY")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "-".to_string());
    if computer_use_signature_matches(app_dir, &identity) {
        return;
    }
    let mut command = std::process::Command::new("codesign");
    command
        .arg("--force")
        .arg("--deep")
        .arg("--sign")
        .arg(&identity);
    if identity != "-" {
        command.arg("--timestamp").arg("--options").arg("runtime");
    }
    let status = command.arg(app_dir).status();
    if !matches!(status, Ok(status) if status.success()) {
        panic!(
            "computer use driver could not be signed: {}",
            app_dir.display()
        );
    }
}

fn computer_use_signature_matches(app_dir: &std::path::Path, identity: &str) -> bool {
    let verified = std::process::Command::new("/usr/bin/codesign")
        .arg("--verify")
        .arg("--deep")
        .arg("--strict")
        .arg(app_dir)
        .status()
        .is_ok_and(|status| status.success());
    if !verified {
        return false;
    }
    let Ok(details) = std::process::Command::new("/usr/bin/codesign")
        .arg("-dv")
        .arg("--verbose=4")
        .arg(app_dir)
        .output()
    else {
        return false;
    };
    if !details.status.success() {
        return false;
    }
    let details = format!(
        "{}\n{}",
        String::from_utf8_lossy(&details.stdout),
        String::from_utf8_lossy(&details.stderr)
    );
    if identity == "-" {
        details.contains("Signature=adhoc")
    } else {
        details
            .lines()
            .any(|line| line.trim() == format!("Authority={identity}"))
    }
}

/// `tauri_build::build()` validates every `bundle.resources` source path at
/// compile time, but the native messaging shim is a sibling `[[bin]]` of this
/// crate — it does not exist yet while build.rs runs. This placeholder keeps
/// the mapping valid for every cargo invocation; `scripts/bundle-nm-shim.sh`
/// (the macOS `beforeBundleCommand`) replaces it with the real signed binary
/// after compilation and fails the bundle if it cannot.
fn ensure_nm_shim_placeholder() {
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
    let shim = helper_dir.join("june-nm-shim");
    if shim.exists() {
        return;
    }
    if let Err(error) = std::fs::create_dir_all(&helper_dir).and_then(|_| {
        std::fs::write(
            &shim,
            b"placeholder: replaced by scripts/bundle-nm-shim.sh\n",
        )
    }) {
        println!("cargo:warning=could not create nm shim placeholder: {error}");
    }
}

/// `tauri_build::build()` validates every `bundle.resources` source path at
/// compile time, so the `../.tauri-hermes/hermes` mapping must exist for ANY
/// cargo invocation (`cargo test`, rust-analyzer, dev builds) — not just for
/// `tauri build`. Release CI populates the real runtime via
/// scripts/bundle-hermes-runtime.sh or scripts/bundle-hermes-runtime-windows.ps1
/// before compiling; everywhere else this
/// placeholder keeps the build green and the app falls back to the managed
/// on-device install (`bundled_hermes_command` finds no launcher in it).
///
/// A populated bundle carries PIN and PATCHSET stamps (the hermes-agent commit
/// and June compatibility patch it was built from). The macOS bundle also
/// carries an ARCHITECTURES stamp. When a required stamp no longer matches,
/// the stale bundle is evicted and replaced with the placeholder rather than
/// silently shipping outdated or host-only runtime code.
fn ensure_bundled_hermes_dir() {
    println!("cargo:rerun-if-changed=../.tauri-hermes/hermes/PIN");
    println!("cargo:rerun-if-changed=../.tauri-hermes/hermes/PATCHSET");
    println!("cargo:rerun-if-changed=../.tauri-hermes/hermes/ARCHITECTURES");
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
        let mac_launcher = hermes_dir.join("bin").join("hermes");
        let windows_launcher = hermes_dir.join("bin").join("hermes.exe");
        if !mac_launcher.exists() && !windows_launcher.exists() {
            // Placeholder (or partial) dir: nothing to validate.
            return;
        }
        let stamped = std::fs::read_to_string(hermes_dir.join("PIN"))
            .map(|raw| raw.trim().to_string())
            .unwrap_or_default();
        let pinned = hermes_agent_pinned_commit(&manifest_dir);
        let stamped_patch_set = std::fs::read_to_string(hermes_dir.join("PATCHSET"))
            .map(|raw| raw.trim().to_string())
            .unwrap_or_default();
        let pinned_patch_set = hermes_runtime_patch_set(&manifest_dir);
        let stamped_architectures = std::fs::read_to_string(hermes_dir.join("ARCHITECTURES"))
            .map(|raw| raw.split_whitespace().collect::<Vec<_>>().join(" "))
            .unwrap_or_default();
        // Windows keeps its existing single-platform bundle. A populated
        // macOS bundle is reusable only when the architecture stamp proves it
        // uses the universal dual-runtime layout; this evicts old host-only
        // bundles even when their source and patch pins still match.
        let architecture_layout_current =
            !mac_launcher.exists() || stamped_architectures == EXPECTED_MACOS_ARCHITECTURES;
        if !stamped.is_empty()
            && stamped == pinned
            && !stamped_patch_set.is_empty()
            && stamped_patch_set == pinned_patch_set
            && architecture_layout_current
        {
            return;
        }
        println!(
            "cargo:warning=bundled Hermes runtime is stale (built from {stamped:?} with patch \
             {stamped_patch_set:?} for architectures {stamped_architectures:?}, expected \
             {pinned:?} with patch {pinned_patch_set:?} and macOS architectures \
             \"arm64 x86_64\"); evicting \
             it — rerun scripts/bundle-hermes-runtime.sh to bundle again"
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
runtime on first launch instead. Release CI runs the platform Hermes bundler to \
ship the runtime inside the app.\n";
    if let Err(error) = std::fs::write(hermes_dir.join("PLACEHOLDER.md"), note) {
        println!("cargo:warning=could not write hermes placeholder: {error}");
    }
}

/// Reads HERMES_AGENT_INSTALL_COMMIT out of src/hermes_bridge.rs. A build
/// script cannot import crate constants, so this parses the declaration the
/// same way scripts/bundle-hermes-runtime.sh does — one source of truth.
fn hermes_agent_pinned_commit(manifest_dir: &std::path::Path) -> String {
    hermes_bridge_constant(manifest_dir, "HERMES_AGENT_INSTALL_COMMIT")
}

fn hermes_runtime_patch_set(manifest_dir: &std::path::Path) -> String {
    hermes_bridge_constant(manifest_dir, "HERMES_RUNTIME_PATCH_SET")
}

fn hermes_bridge_constant(manifest_dir: &std::path::Path, name: &str) -> String {
    let source = std::fs::read_to_string(manifest_dir.join("src").join("hermes_bridge.rs"))
        .unwrap_or_default();
    source
        .lines()
        .find(|line| line.contains(&format!("const {name}")))
        .and_then(|line| {
            let start = line.find('"')? + 1;
            let end = line[start..].find('"')? + start;
            Some(line[start..end].to_string())
        })
        .unwrap_or_default()
}

/// Remove pre-rename ("June") helper bundles from `.tauri-helper` so
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
    for legacy in ["June.app", "June Dictation Helper.app"] {
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
  <string>co.opensoftware.june.audio-capture</string>
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

fn build_windows_dictation_helper() {
    if std::env::var("CARGO_CFG_TARGET_OS").ok().as_deref() != Some("windows") {
        return;
    }
    let manifest_dir = std::path::PathBuf::from(
        std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR should be set"),
    );
    let helper_manifest = manifest_dir
        .join("native")
        .join("windows-dictation-helper")
        .join("Cargo.toml");
    if !helper_manifest.exists() {
        panic!(
            "Windows dictation helper manifest is missing at {}",
            helper_manifest.display()
        );
    }
    println!("cargo:rerun-if-changed={}", helper_manifest.display());
    for source in [
        "main.rs",
        "protocol.rs",
        "hotkeys.rs",
        "audio.rs",
        "clipboard.rs",
        "focus.rs",
        "permissions.rs",
    ] {
        println!(
            "cargo:rerun-if-changed={}",
            manifest_dir
                .join("native")
                .join("windows-dictation-helper")
                .join("src")
                .join(source)
                .display()
        );
    }

    let target = std::env::var("TARGET").ok();
    let target_dir = manifest_dir.join("target").join("windows-dictation-helper");
    let mut command = std::process::Command::new("cargo");
    command
        .arg("build")
        .arg("--release")
        .arg("--locked")
        .arg("--manifest-path")
        .arg(&helper_manifest)
        .arg("--target-dir")
        .arg(&target_dir);
    if let Some(target) = target.as_deref() {
        command.arg("--target").arg(target);
    }
    let status = command.status().unwrap_or_else(|error| {
        panic!(
            "Windows dictation helper build command could not start for {}: {error}",
            helper_manifest.display()
        )
    });
    if !status.success() {
        panic!(
            "Windows dictation helper build failed for {} with status {status}",
            helper_manifest.display()
        );
    }

    let mut built = target_dir.join("release").join("june-dictation-helper.exe");
    if let Some(target) = target.as_deref() {
        built = target_dir
            .join(target)
            .join("release")
            .join("june-dictation-helper.exe");
    }
    let destination = manifest_dir
        .join("native")
        .join("bin")
        .join("june-dictation-helper.exe");
    if let Some(parent) = destination.parent() {
        std::fs::create_dir_all(parent)
            .expect("Windows dictation helper destination should be created");
    }
    let should_copy = match (std::fs::read(&built), std::fs::read(&destination)) {
        (Ok(built_contents), Ok(current_contents)) => built_contents != current_contents,
        (Ok(_), Err(_)) => true,
        (Err(error), _) => {
            panic!(
                "Windows dictation helper {} should be readable before copying to {}: {error}",
                built.display(),
                destination.display()
            )
        }
    };
    if should_copy {
        std::fs::copy(&built, &destination).unwrap_or_else(|error| {
            panic!(
                "Windows dictation helper {} should copy to {}: {error}",
                built.display(),
                destination.display()
            )
        });
    }
    sign_windows_helper_if_configured(&manifest_dir, &destination);
}

fn sign_windows_helper_if_configured(manifest_dir: &std::path::Path, helper: &std::path::Path) {
    if std::env::var("WINDOWS_CERTIFICATE_PASSWORD")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .is_none()
    {
        return;
    }
    let Some(repo_dir) = manifest_dir.parent() else {
        return;
    };
    let script = repo_dir.join("scripts").join("windows-sign.ps1");
    if !script.exists() {
        panic!(
            "Windows signing requested but {} is missing",
            script.display()
        );
    }
    let status = std::process::Command::new("powershell.exe")
        .arg("-NoLogo")
        .arg("-NoProfile")
        .arg("-ExecutionPolicy")
        .arg("Bypass")
        .arg("-File")
        .arg(&script)
        .arg(helper)
        .status()
        .unwrap_or_else(|error| {
            panic!(
                "Windows dictation helper signing command could not start for {}: {error}",
                helper.display()
            )
        });
    if !status.success() {
        panic!(
            "Windows dictation helper {} signing failed with status {status}",
            helper.display()
        );
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
    let icon_source = manifest_dir.join("icons").join("icon.icns");
    let icon_destination = resources_dir.join("June.icns");

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
                "SoundAnalysis",
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
  <string>co.opensoftware.june.dictation-helper</string>
  <key>CFBundleIconFile</key>
  <string>June.icns</string>
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

    let icon_bytes = std::fs::read(&icon_source).unwrap_or_else(|error| {
        panic!(
            "June app icon {} should be readable: {error}",
            icon_source.display()
        )
    });
    let icon_current = std::fs::read(&icon_destination).is_ok_and(|current| current == icon_bytes);
    if !icon_current {
        std::fs::write(&icon_destination, icon_bytes).unwrap_or_else(|error| {
            panic!(
                "June app icon should be copied to dictation helper resources at {}: {error}",
                icon_destination.display()
            )
        });
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
