import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";

const VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function parseSemver(version) {
  const match = VERSION_RE.exec(version);
  if (!match) return undefined;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

export function compareSemver(left, right) {
  const a = parseSemver(left);
  const b = parseSemver(right);
  if (!a || !b) throw new Error("Cannot compare invalid semver values.");
  for (const key of ["major", "minor", "patch"]) {
    if (a[key] > b[key]) return 1;
    if (a[key] < b[key]) return -1;
  }
  return 0;
}

export function validateRequestedVersion(currentVersion, requestedVersion) {
  if (!parseSemver(requestedVersion)) {
    return {
      ok: false,
      reason: `Requested version "${requestedVersion}" is not valid semver (expected X.Y.Z).`,
    };
  }
  if (!parseSemver(currentVersion)) {
    return {
      ok: false,
      reason: `Current version "${currentVersion}" is not valid semver.`,
    };
  }
  if (compareSemver(requestedVersion, currentVersion) <= 0) {
    return {
      ok: false,
      reason: `Requested version ${requestedVersion} must be greater than current version ${currentVersion}.`,
    };
  }
  return { ok: true };
}

export function bumpVersionContents(files, requestedVersion) {
  return {
    tauriConf: replaceJsonVersion(files.tauriConf, requestedVersion),
    cargoToml: replaceCargoPackageVersion(files.cargoToml, requestedVersion),
    packageJson: replaceJsonVersion(files.packageJson, requestedVersion),
  };
}

export function currentVersionFromTauriConf(contents) {
  return JSON.parse(contents).version;
}

export function currentVersionFromPackageJson(contents) {
  return JSON.parse(contents).version;
}

export function currentVersionFromCargoToml(contents) {
  const match = /^version\s*=\s*"([^"]+)"/m.exec(contents);
  if (!match) throw new Error("Could not find package version in Cargo.toml.");
  return match[1];
}

// The three version-bearing files must already agree before a bump — otherwise
// the "strictly greater than current" gate would trust whichever file we read
// and silently carry a pre-existing drift into the release.
export function readCurrentVersion(files) {
  const tauri = currentVersionFromTauriConf(files.tauriConf);
  const cargo = currentVersionFromCargoToml(files.cargoToml);
  const pkg = currentVersionFromPackageJson(files.packageJson);
  if (tauri !== cargo || tauri !== pkg) {
    return {
      ok: false,
      reason: `Version drift before bump (tauri.conf.json=${tauri}, Cargo.toml=${cargo}, package.json=${pkg}); reconcile the three files first.`,
    };
  }
  return { ok: true, version: tauri };
}

function replaceJsonVersion(contents, requestedVersion) {
  const parsed = JSON.parse(contents);
  parsed.version = requestedVersion;
  return `${JSON.stringify(parsed, null, 2)}\n`;
}

function replaceCargoPackageVersion(contents, requestedVersion) {
  const next = contents.replace(
    /^version\s*=\s*"[^"]+"/m,
    `version = "${requestedVersion}"`,
  );
  if (next === contents) {
    throw new Error("Could not find package version in Cargo.toml.");
  }
  return next;
}

async function main() {
  const requestedVersion = process.argv[2];
  if (!requestedVersion) {
    throw new Error("Usage: node scripts/bump-version.mjs <version>");
  }

  const root = process.cwd();
  const paths = {
    tauriConf: resolve(root, "src-tauri/tauri.conf.json"),
    cargoToml: resolve(root, "src-tauri/Cargo.toml"),
    packageJson: resolve(root, "package.json"),
  };
  const files = {
    tauriConf: await readFile(paths.tauriConf, "utf8"),
    cargoToml: await readFile(paths.cargoToml, "utf8"),
    packageJson: await readFile(paths.packageJson, "utf8"),
  };
  const current = readCurrentVersion(files);
  if (!current.ok) {
    throw new Error(current.reason);
  }
  const validation = validateRequestedVersion(current.version, requestedVersion);
  if (!validation.ok) {
    throw new Error(validation.reason);
  }
  const next = bumpVersionContents(files, requestedVersion);
  await writeFile(paths.tauriConf, next.tauriConf);
  await writeFile(paths.cargoToml, next.cargoToml);
  await writeFile(paths.packageJson, next.packageJson);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
