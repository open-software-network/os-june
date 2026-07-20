import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";

const TCC_SERVICES = ["Accessibility", "ScreenCapture"];
const LSREGISTER =
  "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";

export function computerUseBundleIdentifier({ baseIdentifier, profile, worktreeRoot }) {
  if (profile === "release") return baseIdentifier;
  if (profile !== "debug") {
    throw new Error(`Unsupported Computer use helper profile: ${profile}`);
  }
  return `${baseIdentifier}.dev.${computerUseWorktreeKey(worktreeRoot)}`;
}

export function computerUseWorktreeKey(worktreeRoot) {
  const normalized = path.resolve(worktreeRoot);
  const digest = createHash("sha256").update(normalized).digest("hex").slice(0, 12);
  return `w${digest}`;
}

export function cleanStagedComputerUseBundles({
  worktreeRoot,
  bundleName,
  targetDir = path.join(worktreeRoot, "src-tauri", "target"),
}) {
  const removed = [];
  for (const bundlePath of stagedComputerUseBundlePaths({ targetDir, bundleName })) {
    if (!existsSync(bundlePath)) continue;
    rmSync(bundlePath, { recursive: true, force: true });
    removed.push(bundlePath);
  }
  return removed;
}

export function stagedComputerUseBundlePaths({ targetDir, bundleName }) {
  const debugRoots = [path.join(targetDir, "debug")];
  for (const entry of directoryEntries(targetDir)) {
    if (entry.isDirectory() && entry.name.endsWith("-apple-darwin")) {
      debugRoots.push(path.join(targetDir, entry.name, "debug"));
    }
  }

  const candidates = [];
  for (const debugRoot of debugRoots) {
    candidates.push(path.join(debugRoot, "native", "bin", bundleName));
    const macosBundles = path.join(debugRoot, "bundle", "macos");
    for (const entry of directoryEntries(macosBundles)) {
      if (!entry.isDirectory() || !entry.name.endsWith(".app")) continue;
      candidates.push(
        path.join(macosBundles, entry.name, "Contents", "Resources", "native", "bin", bundleName),
      );
    }
  }
  return candidates;
}

export function resetComputerUseGrants(bundleIdentifier, run = spawnSync) {
  const resetServices = [];
  for (const service of TCC_SERVICES) {
    const result = run("/usr/bin/tccutil", ["reset", service, bundleIdentifier], {
      encoding: "utf8",
    });
    if (result.status !== 0) {
      const reason = `${result.stderr || result.stdout || ""}`.trim();
      throw new Error(
        `Could not reset ${service} for ${bundleIdentifier}${reason ? `: ${reason}` : ""}`,
      );
    }
    resetServices.push(service);
  }
  return resetServices;
}

export function resetComputerUseDevGrants({ bundlePath, bundleIdentifier }, run = spawnSync) {
  registerComputerUseBundle(bundlePath, run);
  return resetComputerUseGrants(bundleIdentifier, run);
}

export function registerComputerUseBundle(bundlePath, run = spawnSync) {
  const result = run(LSREGISTER, ["-f", bundlePath], { encoding: "utf8" });
  if (result.status !== 0) {
    const reason = `${result.stderr || result.stdout || ""}`.trim();
    throw new Error(`Could not register the Computer use helper${reason ? `: ${reason}` : ""}`);
  }
}

function directoryEntries(directory) {
  try {
    return readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}
