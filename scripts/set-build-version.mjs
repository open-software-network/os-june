import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";
import { bumpVersionContents } from "./bump-version.mjs";

// Build versions for on-demand RC artifacts. Unlike bump-version.mjs (which
// gates main's version: valid X.Y.Z, strictly increasing), this stamps an
// ephemeral artifact version that is NOT committed to main and is allowed to
// sort *below* the current version — `0.0.25-rc.1 < 0.0.25` is the whole point,
// so the updater orders rc.1 < rc.2 < ... < 0.0.25. Only `-rc.N` prereleases
// are accepted (no leading zero on N), matching the published manifest scheme.
const BUILD_VERSION_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-rc\.(0|[1-9]\d*))?$/;

export function isBuildVersion(version) {
  return typeof version === "string" && BUILD_VERSION_RE.test(version);
}

export function setBuildVersionContents(files, version) {
  if (!isBuildVersion(version)) {
    throw new Error(
      `Build version "${version}" must be X.Y.Z or X.Y.Z-rc.N (no leading zeros).`,
    );
  }
  // bumpVersionContents only does the file string-replace — the X.Y.Z-only
  // validation and monotonic check live in bump-version.mjs's main(), which we
  // deliberately bypass here.
  return bumpVersionContents(files, version);
}

async function main() {
  const version = process.argv[2];
  if (!version) {
    throw new Error("Usage: node scripts/set-build-version.mjs <X.Y.Z[-rc.N]>");
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
  const next = setBuildVersionContents(files, version);
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
