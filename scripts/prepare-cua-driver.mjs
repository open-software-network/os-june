#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pinPath = path.join(rootDir, "src-tauri", "cua-driver-pin.json");
const pin = JSON.parse(readFileSync(pinPath, "utf8"));
const sbomSource = path.join(rootDir, "src-tauri", "cua-driver-sbom.spdx.json");
const licenseSource = path.join(rootDir, "src-tauri", "cua-driver-LICENSE.md");

const tauriPlatform = process.env.TAURI_ENV_PLATFORM?.trim();
if (process.platform !== "darwin" || (tauriPlatform && tauriPlatform !== "darwin")) {
  console.error("Skipping Computer use helper preparation: Computer use is macOS-only.");
  process.exit(0);
}

const parsed = parseArguments(process.argv.slice(2));
const release = parsed.release;
const target = parsed.target || tauriTargetTriple();
const profile = release ? "release" : "debug";
const rustTargets =
  target === "universal-apple-darwin"
    ? ["aarch64-apple-darwin", "x86_64-apple-darwin"]
    : [target].filter(Boolean);
const architectures =
  rustTargets.length > 0
    ? rustTargets.map(architectureForTarget)
    : [process.arch === "x64" ? "x86_64" : "arm64"];
const sourceSha256 = helperSourceSha256();
const helperDir = path.join(rootDir, ".tauri-helper");
const bundleDir = path.join(helperDir, pin.bundleName);
const contentsDir = path.join(bundleDir, "Contents");
const executableDir = path.join(contentsDir, "MacOS");
const resourcesDir = path.join(contentsDir, "Resources");
const executable = path.join(executableDir, pin.executable);
const stampPath = path.join(resourcesDir, "june-cua-driver-pin.json");

if (preparedBundleMatches()) {
  console.error(
    `Reusing ${profile} Computer use helper for ${architectures.join("+")} from ${pin.sourceCommit}.`,
  );
  process.exit(0);
}

// Cargo runs this package's build.rs even when only the helper binary is
// requested. Remove a stale real bundle before that build so build.rs creates
// its non-packaging placeholder instead of rejecting the old source stamp.
// The newly compiled helper replaces the placeholder below.
rmSync(bundleDir, { recursive: true, force: true });

const developerDir = existsSync("/Applications/Xcode.app/Contents/Developer")
  ? "/Applications/Xcode.app/Contents/Developer"
  : process.env.DEVELOPER_DIR;
const buildTargets = rustTargets.length > 0 ? rustTargets : [undefined];
const builtExecutables = [];
for (const rustTarget of buildTargets) {
  const cargoArgs = [
    "build",
    "--manifest-path",
    path.join(rootDir, "src-tauri", "Cargo.toml"),
    "--bin",
    pin.executable,
    "--locked",
  ];
  if (release) cargoArgs.push("--release");
  if (rustTarget) cargoArgs.push("--target", rustTarget);
  run(process.env.CARGO || "cargo", cargoArgs, {
    cwd: rootDir,
    env: {
      ...process.env,
      MACOSX_DEPLOYMENT_TARGET: pin.minimumMacOSVersion,
      ...(developerDir ? { DEVELOPER_DIR: developerDir } : {}),
    },
  });
  builtExecutables.push(
    path.join(
      rootDir,
      "src-tauri",
      "target",
      ...(rustTarget ? [rustTarget] : []),
      profile,
      pin.executable,
    ),
  );
}

rmSync(bundleDir, { recursive: true, force: true });
mkdirSync(executableDir, { recursive: true });
mkdirSync(resourcesDir, { recursive: true });
if (builtExecutables.length === 1) {
  cpSync(builtExecutables[0], executable);
} else {
  run("/usr/bin/lipo", ["-create", ...builtExecutables, "-output", executable]);
}
run("/bin/chmod", ["755", executable]);

writeFileSync(
  path.join(contentsDir, "Info.plist"),
  `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key><string>en</string>
  <key>CFBundleDisplayName</key><string>June Computer Use Driver</string>
  <key>CFBundleExecutable</key><string>${pin.executable}</string>
  <key>CFBundleIdentifier</key><string>${pin.bundleIdentifier}</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleName</key><string>June Computer Use Driver</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${pin.version}</string>
  <key>CFBundleVersion</key><string>${pin.version}</string>
  <key>LSMinimumSystemVersion</key><string>${pin.minimumMacOSVersion}</string>
  <key>LSUIElement</key><true/>
  <key>NSAccessibilityUsageDescription</key><string>June uses Accessibility only to operate the app windows you ask it to control.</string>
  <key>NSScreenCaptureUsageDescription</key><string>June captures only the app windows you ask it to operate so June can understand and complete your task.</string>
</dict>
</plist>
`,
);
writeFileSync(
  stampPath,
  `${JSON.stringify(
    {
      ...pin,
      juneBuild: { profile, architectures: [...architectures].sort(), sourceSha256 },
    },
    null,
    2,
  )}\n`,
);
cpSync(sbomSource, path.join(resourcesDir, "june-cua-driver.spdx.json"));
cpSync(licenseSource, path.join(resourcesDir, "cua-driver-LICENSE.md"));
run("/usr/bin/codesign", [
  "--force",
  "--deep",
  "--sign",
  "-",
  "--identifier",
  pin.bundleIdentifier,
  bundleDir,
]);

const version = helperVersion(executable);
if (version.version !== pin.version || version.commit !== pin.sourceCommit) {
  throw new Error(
    `Built helper reports ${version.version || "no version"} ${version.commit || "no commit"}; expected ${pin.version} ${pin.sourceCommit}`,
  );
}
console.error(
  `Prepared authenticated Computer use helper from cua-driver ${pin.version} (${pin.sourceCommit}).`,
);

function helperVersion(file) {
  const result = spawnSync(file, ["--version"], { encoding: "utf8" });
  if (result.status !== 0) return {};
  const match = `${result.stdout}\n${result.stderr}`.match(
    /june-computer-use-driver\s+([^\s]+)\s+([0-9a-f]{40})/,
  );
  return { version: match?.[1], commit: match?.[2] };
}

function helperSourceSha256() {
  const hash = createHash("sha256");
  for (const relative of [
    "src-tauri/src/computer_use_driver.rs",
    "src-tauri/Cargo.toml",
    "src-tauri/Cargo.lock",
  ]) {
    hash.update(relative);
    hash.update("\0");
    hash.update(readFileSync(path.join(rootDir, relative)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function preparedBundleMatches() {
  if (!existsSync(executable) || !existsSync(stampPath)) return false;
  let stamp;
  try {
    stamp = JSON.parse(readFileSync(stampPath, "utf8"));
  } catch {
    return false;
  }
  const version = helperVersion(executable);
  const actualArchitectures = new Set(
    spawnSync("/usr/bin/lipo", ["-archs", executable], { encoding: "utf8" })
      .stdout?.trim()
      .split(/\s+/)
      .filter(Boolean) || [],
  );
  return (
    stamp.version === pin.version &&
    stamp.sourceCommit === pin.sourceCommit &&
    stamp.juneBuild?.profile === profile &&
    stamp.juneBuild?.sourceSha256 === sourceSha256 &&
    architectures.every((architecture) => actualArchitectures.has(architecture)) &&
    version.version === pin.version &&
    version.commit === pin.sourceCommit &&
    bundleSignatureMatches()
  );
}

function bundleSignatureMatches() {
  const verification = spawnSync(
    "/usr/bin/codesign",
    ["--verify", "--deep", "--strict", bundleDir],
    { encoding: "utf8" },
  );
  if (verification.status !== 0) return false;

  const details = spawnSync("/usr/bin/codesign", ["-dv", "--verbose=4", bundleDir], {
    encoding: "utf8",
  });
  return (
    details.status === 0 &&
    `${details.stdout || ""}\n${details.stderr || ""}`.includes(
      `Identifier=${pin.bundleIdentifier}`,
    )
  );
}

function architectureForTarget(rustTarget) {
  if (rustTarget === "aarch64-apple-darwin") return "arm64";
  if (rustTarget === "x86_64-apple-darwin") return "x86_64";
  throw new Error(`Unsupported Computer use helper target: ${rustTarget}`);
}

function tauriTargetTriple() {
  const target = process.env.TAURI_ENV_TARGET_TRIPLE?.trim();
  if (!target) return undefined;
  if (
    target === "universal-apple-darwin" ||
    target === "aarch64-apple-darwin" ||
    target === "x86_64-apple-darwin"
  ) {
    return target;
  }
  throw new Error(`Unsupported Computer use helper target from Tauri: ${target}`);
}

function parseArguments(values) {
  let release = false;
  let target;
  for (let index = 0; index < values.length; index += 1) {
    const argument = values[index];
    if (argument === "--release") {
      release = true;
      continue;
    }
    if (argument === "--target") {
      target = values[index + 1];
      if (!target || target.startsWith("--")) {
        throw new Error("--target requires a Rust target");
      }
      index += 1;
      continue;
    }
    if (argument.startsWith("--target=")) {
      target = argument.slice("--target=".length);
      if (!target) throw new Error("--target requires a Rust target");
      continue;
    }
    throw new Error(`Unknown Computer use helper preparation argument: ${argument}`);
  }
  return { release, target };
}

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, { ...options, stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`${command} exited with ${result.status ?? "no status"}`);
  }
}
