#!/usr/bin/env node

import { existsSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const appPath = resolve(process.argv[2] ?? "");

if (!process.argv[2] || !existsSync(appPath)) {
  throw new Error("Usage: verify-macos-app-name.mjs <path-to-June.app>");
}

expectValue("app bundle path", basename(appPath), "June.app");

const infoPlist = join(appPath, "Contents", "Info.plist");
const localizedInfoPlist = join(appPath, "Contents", "Resources", "en.lproj", "InfoPlist.strings");

expectPlistValue(infoPlist, "CFBundleDisplayName", "June");
expectPlistValue(infoPlist, "CFBundleName", "Clovy");
expectPlistValue(infoPlist, "CFBundleIdentifier", "co.opensoftware.june");
expectPlistValue(infoPlist, "CFBundleExecutable", "os-june");
expectPlistValue(infoPlist, "LSHasLocalizedDisplayName", "true");
expectPlistValue(localizedInfoPlist, "CFBundleDisplayName", "Clovy");
expectPlistValue(localizedInfoPlist, "CFBundleName", "Clovy");

const displayedName = run("/usr/bin/swift", [
  "-e",
  "import Foundation; print(FileManager.default.displayName(atPath: CommandLine.arguments[1]))",
  appPath,
]);
expectValue("macOS display name", displayedName, "Clovy");

console.log(`Verified ${appPath} presents as Clovy.`);

function expectPlistValue(path, key, expected) {
  if (!existsSync(path)) {
    throw new Error(`Missing bundle metadata: ${path}`);
  }
  expectValue(
    `${path}:${key}`,
    run("/usr/bin/plutil", ["-extract", key, "raw", "-o", "-", path]),
    expected,
  );
}

function expectValue(label, actual, expected) {
  if (actual !== expected) {
    throw new Error(
      `Expected ${label} to be ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}.`,
    );
  }
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} failed with status ${result.status}: ${(result.stderr || result.stdout).trim()}`,
    );
  }
  return result.stdout.trim();
}
