import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import process from "node:process";
import { bumpVersionContents, readCurrentVersion } from "./bump-version.mjs";

// Build versions for on-demand RC artifacts. Unlike bump-version.mjs (which
// gates main's version: valid X.Y.Z, strictly increasing), this stamps an
// ephemeral artifact version that is NOT committed to main and is allowed to
// sort *below* the current version — `0.0.25-rc.1 < 0.0.25` is the whole point,
// so the updater orders rc.1 < rc.2 < ... < 0.0.25. Only `-rc.N` prereleases
// are accepted (no leading zero on N), matching the published manifest scheme.
const BUILD_VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-rc\.(0|[1-9]\d*))?$/;

export function isBuildVersion(version) {
  return typeof version === "string" && BUILD_VERSION_RE.test(version);
}

export function parseBuildVersion(version) {
  const match = BUILD_VERSION_RE.exec(String(version));
  if (!match) return undefined;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    // A clean release outranks every prerelease of the same base (semver:
    // 0.0.25 > 0.0.25-rc.9), so model "no -rc" as +Infinity; an -rc.N sorts by N.
    rc: match[5] === undefined ? Infinity : Number(match[5]),
  };
}

// Orders build versions the same way the updater does (rc.1 < rc.2 < ... < base).
// Returns -1/0/1. Unlike bump-version.mjs's compareSemver, this understands the
// `-rc.N` prerelease, so it can gate the rc channel against going backward.
export function compareBuildVersion(left, right) {
  const a = parseBuildVersion(left);
  const b = parseBuildVersion(right);
  if (!a || !b) {
    throw new Error(`Cannot compare invalid build versions: "${left}" vs "${right}".`);
  }
  for (const key of ["major", "minor", "patch", "rc"]) {
    if (a[key] > b[key]) return 1;
    if (a[key] < b[key]) return -1;
  }
  return 0;
}

export function setBuildVersionContents(files, version) {
  if (!isBuildVersion(version)) {
    throw new Error(`Build version "${version}" must be X.Y.Z or X.Y.Z-rc.N (no leading zeros).`);
  }
  const current = readCurrentVersion(files);
  if (!current.ok) {
    throw new Error(current.reason);
  }
  // bumpVersionContents only does the file string-replace — the X.Y.Z-only
  // validation and monotonic check live in bump-version.mjs's main(), which we
  // deliberately bypass here.
  return bumpVersionContents(files, version);
}

async function main() {
  const args = process.argv.slice(2);
  const check = args[0] === "--check";
  const version = check ? args[1] : args[0];
  if (!version || args.length !== (check ? 2 : 1) || (!check && version.startsWith("--"))) {
    throw new Error("Usage: node scripts/set-build-version.mjs [--check] <X.Y.Z[-rc.N]>");
  }
  if (!isBuildVersion(version)) {
    throw new Error(`Build version "${version}" must be X.Y.Z or X.Y.Z-rc.N (no leading zeros).`);
  }

  const root = process.cwd();
  const paths = {
    tauriConf: resolve(root, "src-tauri/tauri.conf.json"),
    cargoToml: resolve(root, "src-tauri/Cargo.toml"),
    cargoLock: resolve(root, "src-tauri/Cargo.lock"),
    packageJson: resolve(root, "package.json"),
  };
  const files = {
    tauriConf: await readFile(paths.tauriConf, "utf8"),
    cargoToml: await readFile(paths.cargoToml, "utf8"),
    cargoLock: await readFile(paths.cargoLock, "utf8"),
    packageJson: await readFile(paths.packageJson, "utf8"),
  };
  const current = readCurrentVersion(files);
  if (!current.ok) {
    throw new Error(current.reason);
  }
  if (check) {
    if (current.version !== version) {
      throw new Error(`Expected version ${version}, found agreed version ${current.version}.`);
    }
    return;
  }
  const next = setBuildVersionContents(files, version);
  await writeFile(paths.tauriConf, next.tauriConf);
  await writeFile(paths.cargoToml, next.cargoToml);
  await writeFile(paths.cargoLock, next.cargoLock);
  await writeFile(paths.packageJson, next.packageJson);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
