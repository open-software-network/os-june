import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";

export const STABLE_PROVENANCE_SCHEMA_VERSION = 1;
export const STABLE_ASSET_NAMES = [
  "June_universal.dmg",
  "June_aarch64.dmg",
  "June_universal.app.tar.gz",
  "June_universal.app.tar.gz.sig",
  "latest.json",
];

const STABLE_VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const SHA_RE = /^[0-9a-f]{40}$/;
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function sha256(path) {
  return `sha256:${createHash("sha256")
    .update(await readFile(path))
    .digest("hex")}`;
}

function validateIdentity(version, sourceCommit) {
  assert(STABLE_VERSION_RE.test(version), "Stable provenance version must be X.Y.Z.");
  assert(SHA_RE.test(sourceCommit), "Stable provenance source commit must be a 40-char SHA.");
}

export async function writeStableReleaseProvenance({
  releaseDir,
  version,
  sourceCommit,
  outputPath,
}) {
  validateIdentity(version, sourceCommit);
  const assets = Object.fromEntries(
    await Promise.all(
      STABLE_ASSET_NAMES.map(async (name) => [name, await sha256(join(releaseDir, name))]),
    ),
  );
  const metadata = {
    schemaVersion: STABLE_PROVENANCE_SCHEMA_VERSION,
    version,
    commit: sourceCommit,
    assets,
  };
  await writeFile(outputPath, `${JSON.stringify(metadata, null, 2)}\n`);
  return metadata;
}

export async function verifyStableReleaseProvenance({
  releaseDir,
  version,
  sourceCommit,
  metadataPath = join(releaseDir, "stable-build.json"),
}) {
  validateIdentity(version, sourceCommit);
  const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
  assert(
    metadata.schemaVersion === STABLE_PROVENANCE_SCHEMA_VERSION,
    "Unsupported stable release provenance schema.",
  );
  assert(
    metadata.version === version && metadata.commit === sourceCommit,
    "Stable release provenance does not match the promoted version and source commit.",
  );
  assert(
    JSON.stringify(Object.keys(metadata.assets ?? {}).sort()) ===
      JSON.stringify([...STABLE_ASSET_NAMES].sort()),
    "Stable release provenance has an incomplete asset digest set.",
  );
  for (const name of STABLE_ASSET_NAMES) {
    assert(DIGEST_RE.test(metadata.assets[name]), `Stable release digest for ${name} is invalid.`);
    assert(
      (await sha256(join(releaseDir, name))) === metadata.assets[name],
      `Stable release asset ${name} does not match its provenance.`,
    );
  }
  return metadata;
}

function parseArgs(args) {
  const [command, ...rest] = args;
  const options = {};
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index];
    const value = rest[index + 1];
    assert(key?.startsWith("--") && value !== undefined, `Invalid argument: ${key ?? ""}`);
    options[key.slice(2)] = value;
  }
  return { command, options };
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  const common = {
    releaseDir: options.dir,
    version: options.version,
    sourceCommit: options["source-commit"],
  };
  if (command === "write") {
    await writeStableReleaseProvenance({ ...common, outputPath: options.output });
    return;
  }
  if (command === "verify") {
    await verifyStableReleaseProvenance({ ...common, metadataPath: options.metadata });
    return;
  }
  throw new Error(
    "Usage: stable-release-provenance.mjs <write|verify> --dir <path> --version <X.Y.Z> --source-commit <sha> [--output|--metadata <path>]",
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
