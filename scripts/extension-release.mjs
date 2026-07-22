import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

export const EXTENSION_RELEASE_SCHEMA_VERSION = 1;
export const EXTENSION_PACKAGE_NAME = "June-extension.zip";
export const EXTENSION_METADATA_NAME = "extension-build.json";
export const EXTENSION_FINGERPRINT_METHOD = "normalized-dist-v1";

const RC_VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-rc\.([1-9]\d*)$/;
const STABLE_VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const SHA_RE = /^[0-9a-f]{40}$/;
const EXTENSION_ID_RE = /^[a-p]{32}$/;
const SHA256_RE = /^sha256:[0-9a-f]{64}$/;
const MAX_CHROME_VERSION_COMPONENT = 65_535;
const FIXED_ZIP_DATE = new Date("1980-01-01T00:00:00.000Z");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function isChromeVersion(value) {
  if (typeof value !== "string") return false;
  const components = value.split(".");
  return (
    components.length >= 1 &&
    components.length <= 4 &&
    components.every(
      (component) =>
        /^(0|[1-9]\d*)$/.test(component) && Number(component) <= MAX_CHROME_VERSION_COMPONENT,
    )
  );
}

export function chromeStoreVersionFromDesktopRc(version) {
  const match = RC_VERSION_RE.exec(String(version));
  if (!match) {
    throw new Error(`Desktop RC version "${version}" must be X.Y.Z-rc.N (no leading zeros).`);
  }
  const desktopComponents = match.slice(1, 5).map(Number);
  // Automated store versions use a +1 major offset so the first automated
  // package is newer than the checked-in/manual bootstrap version 0.1.0.
  const storeComponents = [desktopComponents[0] + 1, ...desktopComponents.slice(1)];
  if (storeComponents.some((component) => component > MAX_CHROME_VERSION_COMPONENT)) {
    throw new Error(
      `Chrome Web Store version components must be at most ${MAX_CHROME_VERSION_COMPONENT}: ${storeComponents.join(".")}`,
    );
  }
  return {
    baseVersion: desktopComponents.slice(0, 3).join("."),
    rcNumber: desktopComponents[3],
    storeVersion: storeComponents.join("."),
  };
}

export function extensionIdFromManifestKey(key) {
  assert(typeof key === "string" && key.length > 0, "Extension manifest key is required.");
  let der;
  try {
    der = Buffer.from(key, "base64");
  } catch {
    throw new Error("Extension manifest key is not valid base64.");
  }
  assert(der.length > 0, "Extension manifest key is not valid base64.");
  const prefix = createHash("sha256").update(der).digest().subarray(0, 16);
  return [...prefix]
    .flatMap((byte) => [byte >> 4, byte & 0x0f])
    .map((nibble) => String.fromCharCode("a".charCodeAt(0) + nibble))
    .join("");
}

async function collectFiles(root, path) {
  const absolute = resolve(root, path);
  const info = await stat(absolute);
  if (info.isFile()) return [absolute];
  assert(info.isDirectory(), `Extension release input is not a file or directory: ${path}`);
  const entries = await readdir(absolute, { withFileTypes: true });
  const nested = await Promise.all(
    entries
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((entry) => collectFiles(root, join(path, entry.name))),
  );
  return nested.flat();
}

export async function extensionPayloadFingerprint(distDir) {
  const root = resolve(distDir);
  const files = (await collectFiles(root, ".")).sort();
  const hash = createHash("sha256");
  for (const path of files) {
    const name = relative(root, path).split("\\").join("/");
    let contents = await readFile(path);
    if (name === "manifest.json") {
      const manifest = JSON.parse(contents.toString("utf8"));
      manifest.version = "0";
      delete manifest.version_name;
      contents = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
    }
    hash.update(name);
    hash.update("\0");
    hash.update(contents);
    hash.update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}

export function validateExtensionMetadata(metadata, { channel } = {}) {
  assert(metadata && typeof metadata === "object", "Extension release metadata must be an object.");
  assert(
    metadata.schemaVersion === EXTENSION_RELEASE_SCHEMA_VERSION,
    `Unsupported extension release metadata schema: ${metadata.schemaVersion}`,
  );
  assert(metadata.channel === "rc" || metadata.channel === "stable", "Invalid extension channel.");
  if (channel) assert(metadata.channel === channel, `Expected ${channel} extension metadata.`);

  assert(metadata.desktop && typeof metadata.desktop === "object", "Desktop metadata is required.");
  assert(SHA_RE.test(metadata.desktop.sourceCommit), "Desktop sourceCommit must be a 40-char SHA.");
  if (metadata.channel === "rc") {
    const parsed = chromeStoreVersionFromDesktopRc(metadata.desktop.version);
    assert(
      parsed.baseVersion === metadata.desktop.baseVersion,
      "RC desktop baseVersion does not match its version.",
    );
  } else {
    assert(
      STABLE_VERSION_RE.test(metadata.desktop.version),
      "Stable desktop version must be X.Y.Z.",
    );
    assert(
      metadata.desktop.baseVersion === metadata.desktop.version,
      "Stable desktop baseVersion must equal its version.",
    );
    assert(
      RC_VERSION_RE.test(metadata.desktop.rcVersion),
      "Stable metadata must record the promoted RC version.",
    );
  }

  assert(SHA256_RE.test(metadata.source?.fingerprint), "Invalid extension source fingerprint.");
  assert(
    metadata.source.method === EXTENSION_FINGERPRINT_METHOD,
    "Invalid extension fingerprint method.",
  );
  assert(
    metadata.extension && typeof metadata.extension === "object",
    "Extension metadata is required.",
  );
  assert(EXTENSION_ID_RE.test(metadata.extension.id), "Invalid Chrome extension ID.");
  assert(isChromeVersion(metadata.extension.version), "Invalid Chrome extension version.");
  assert(typeof metadata.extension.versionName === "string", "Extension versionName is required.");
  assert(metadata.release && typeof metadata.release === "object", "Release metadata is required.");
  assert(typeof metadata.release.required === "boolean", "release.required must be boolean.");

  if (metadata.release.required) {
    assert(
      metadata.release.packageFile === EXTENSION_PACKAGE_NAME,
      `Required extension package must be named ${EXTENSION_PACKAGE_NAME}.`,
    );
    assert(SHA256_RE.test(metadata.release.packageSha256), "Invalid extension package SHA-256.");
  } else {
    assert(
      metadata.release.packageFile === null,
      "Unchanged extension must not name a package file.",
    );
    assert(
      metadata.release.packageSha256 === null,
      "Unchanged extension must not name a package hash.",
    );
  }
  return metadata;
}

export function assertRcCorrelation(metadata, desktopVersion, sourceCommit) {
  validateExtensionMetadata(metadata, { channel: "rc" });
  assert(
    metadata.desktop.version === desktopVersion,
    "Extension metadata desktop version mismatch.",
  );
  assert(
    metadata.desktop.sourceCommit === sourceCommit,
    "Extension metadata source commit mismatch.",
  );
  return metadata;
}

export async function verifyRcReleaseAssets({
  metadataPath,
  desktopVersion,
  sourceCommit,
  packagePath,
}) {
  const metadata = await readMetadata(metadataPath, { channel: "rc" });
  assertRcCorrelation(metadata, desktopVersion, sourceCommit);
  if (metadata.release.required) {
    assert(packagePath, "Extension RC metadata requires June-extension.zip.");
    assert(
      (await hashFile(packagePath)) === metadata.release.packageSha256,
      "Extension RC package hash does not match its metadata.",
    );
  } else {
    assert(!packagePath, "Unchanged extension RC metadata must not include a package.");
  }
  return metadata;
}

async function readMetadata(path, options) {
  if (!path) return undefined;
  const parsed = JSON.parse(await readFile(path, "utf8"));
  return validateExtensionMetadata(parsed, options);
}

async function hashFile(path) {
  return `sha256:${createHash("sha256")
    .update(await readFile(path))
    .digest("hex")}`;
}

async function normalizeTreeDates(path) {
  const entries = await readdir(path, { withFileTypes: true });
  for (const entry of entries) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) await normalizeTreeDates(child);
    else assert(entry.isFile(), `Extension build contains an unsupported entry: ${child}`);
    await utimes(child, FIXED_ZIP_DATE, FIXED_ZIP_DATE);
  }
  await utimes(path, FIXED_ZIP_DATE, FIXED_ZIP_DATE);
}

async function packageDist(distDir, packagePath) {
  await normalizeTreeDates(distDir);
  const files = (await collectFiles(distDir, "."))
    .map((path) => relative(distDir, path).split("\\").join("/"))
    .sort();
  assert(files.length > 0, "Extension dist directory is empty.");
  await rm(packagePath, { force: true });
  const result = spawnSync("zip", ["-X", "-q", packagePath, ...files], {
    cwd: distDir,
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`zip failed (${result.status}): ${result.stderr || result.stdout}`);
  }
}

async function writeGithubOutputs(outputs) {
  if (!process.env.GITHUB_OUTPUT) return;
  const lines = Object.entries(outputs).map(([key, value]) => `${key}=${value}`);
  await writeFile(process.env.GITHUB_OUTPUT, `${lines.join("\n")}\n`, { flag: "a" });
}

export async function prepareExtensionRelease({
  root = process.cwd(),
  desktopVersion,
  sourceCommit,
  outputDir,
  previousStableMetadataPath,
  previousRcMetadataPath,
  previousRcPackagePath,
  reusePreviousRc = false,
}) {
  assert(SHA_RE.test(sourceCommit), "sourceCommit must be a 40-char lowercase SHA.");
  const { baseVersion, storeVersion } = chromeStoreVersionFromDesktopRc(desktopVersion);
  const previousStable = await readMetadata(previousStableMetadataPath, { channel: "stable" });
  const previousRc = await readMetadata(previousRcMetadataPath, { channel: "rc" });
  const distDir = resolve(root, "extension/dist");
  const manifestPath = join(distDir, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const sourceFingerprint = await extensionPayloadFingerprint(distDir);
  const extensionId = extensionIdFromManifestKey(manifest.key);
  const resolvedOutputDir = resolve(outputDir);
  const metadataPath = join(resolvedOutputDir, EXTENSION_METADATA_NAME);
  const packagePath = join(resolvedOutputDir, EXTENSION_PACKAGE_NAME);
  await mkdir(resolvedOutputDir, { recursive: true });

  let reusableRcPackage = false;
  if (
    reusePreviousRc &&
    previousRc?.desktop.baseVersion === baseVersion &&
    previousRc.source.fingerprint === sourceFingerprint &&
    previousRc.release.required &&
    previousRcPackagePath
  ) {
    reusableRcPackage =
      (await hashFile(previousRcPackagePath)) === previousRc.release.packageSha256;
  }

  let metadata;
  if (previousStable?.source.fingerprint === sourceFingerprint) {
    metadata = {
      schemaVersion: EXTENSION_RELEASE_SCHEMA_VERSION,
      channel: "rc",
      desktop: { version: desktopVersion, baseVersion, sourceCommit },
      source: { fingerprint: sourceFingerprint, method: EXTENSION_FINGERPRINT_METHOD },
      extension: previousStable.extension,
      store: { state: "published" },
      release: {
        required: false,
        reason: "unchanged",
        supersedes: reusePreviousRc ? previousRc?.extension.version : null,
        packageFile: null,
        packageSha256: null,
      },
    };
  } else if (reusableRcPackage) {
    await copyFile(previousRcPackagePath, packagePath);
    metadata = {
      ...previousRc,
      desktop: { version: desktopVersion, baseVersion, sourceCommit },
      store: { state: previousRc.store?.state ?? "submitted" },
      release: { ...previousRc.release, reason: "reused-rc" },
    };
  } else {
    manifest.version = storeVersion;
    // The fourth numeric component tracks the RC iteration and the first uses
    // the automated-release offset. Users see the clean desktop version because
    // this exact reviewed package becomes stable.
    manifest.version_name = baseVersion;
    // The Chrome Web Store rejects uploads whose manifest contains `key`
    // ("key field is not allowed in manifest"). The key stays in the source
    // manifest to pin the load-unpacked ID; the store item carries its own.
    delete manifest.key;
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await packageDist(distDir, packagePath);
    const packageSha256 = await hashFile(packagePath);
    const supersedes =
      previousRc?.desktop.baseVersion === baseVersion && previousRc.release.required
        ? previousRc.extension.version
        : null;
    metadata = {
      schemaVersion: EXTENSION_RELEASE_SCHEMA_VERSION,
      channel: "rc",
      desktop: { version: desktopVersion, baseVersion, sourceCommit },
      source: { fingerprint: sourceFingerprint, method: EXTENSION_FINGERPRINT_METHOD },
      extension: { id: extensionId, version: storeVersion, versionName: baseVersion },
      store: { state: "submission-required" },
      release: {
        required: true,
        reason: "changed",
        supersedes,
        packageFile: EXTENSION_PACKAGE_NAME,
        packageSha256,
      },
    };
  }

  validateExtensionMetadata(metadata, { channel: "rc" });
  assert(
    metadata.extension.id === extensionId,
    `Extension package ID ${extensionId} does not match metadata ID ${metadata.extension.id}.`,
  );
  await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
  await writeGithubOutputs({
    release_required: metadata.release.required,
    release_reason: metadata.release.reason,
    extension_id: metadata.extension.id,
    store_version: metadata.extension.version,
    metadata_path: metadataPath,
    package_path: metadata.release.required ? packagePath : "",
  });
  return { metadata, metadataPath, packagePath };
}

export async function writeStableExtensionMetadata({
  rcMetadataPath,
  desktopVersion,
  sourceCommit,
  outputPath,
}) {
  assert(STABLE_VERSION_RE.test(desktopVersion), "Stable desktop version must be X.Y.Z.");
  assert(SHA_RE.test(sourceCommit), "sourceCommit must be a 40-char lowercase SHA.");
  const rc = await readMetadata(rcMetadataPath, { channel: "rc" });
  assert(
    rc.desktop.baseVersion === desktopVersion,
    "RC metadata targets a different stable version.",
  );
  assert(rc.desktop.sourceCommit === sourceCommit, "RC metadata source commit mismatch.");
  const stable = {
    ...rc,
    channel: "stable",
    desktop: {
      version: desktopVersion,
      baseVersion: desktopVersion,
      rcVersion: rc.desktop.version,
      sourceCommit,
    },
    store: { state: "published" },
    release: {
      ...rc.release,
      reason: rc.release.required ? "published" : "unchanged",
    },
  };
  validateExtensionMetadata(stable, { channel: "stable" });
  await writeFile(outputPath, `${JSON.stringify(stable, null, 2)}\n`);
  return stable;
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
  if (command === "validate-version") {
    console.log(chromeStoreVersionFromDesktopRc(options["desktop-version"]).storeVersion);
    return;
  }
  if (command === "prepare") {
    await prepareExtensionRelease({
      desktopVersion: options["desktop-version"],
      sourceCommit: options["source-commit"],
      outputDir: options["output-dir"],
      previousStableMetadataPath: options["previous-stable-metadata"],
      previousRcMetadataPath: options["previous-rc-metadata"],
      previousRcPackagePath: options["previous-rc-package"],
      reusePreviousRc: options["reuse-previous-rc"] === "true",
    });
    return;
  }
  if (command === "verify-rc") {
    await verifyRcReleaseAssets({
      metadataPath: options.metadata,
      desktopVersion: options["desktop-version"],
      sourceCommit: options["source-commit"],
      packagePath: options.package,
    });
    console.log("Extension RC metadata matches the desktop RC.");
    return;
  }
  if (command === "write-stable") {
    await writeStableExtensionMetadata({
      rcMetadataPath: options.metadata,
      desktopVersion: options["desktop-version"],
      sourceCommit: options["source-commit"],
      outputPath: options.output,
    });
    return;
  }
  throw new Error(
    "Usage: extension-release.mjs <validate-version|prepare|verify-rc|write-stable> [options]",
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
