import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import process from "node:process";
import { EXTENSION_PACKAGE_NAME, validateExtensionMetadata } from "./extension-release.mjs";

const API_ROOT = "https://chromewebstore.googleapis.com";
const ACTIVE_SUBMISSION_STATES = new Set(["PENDING_REVIEW", "STAGED"]);
const TERMINAL_FAILURE_STATES = new Set(["REJECTED", "CANCELLED"]);
const SHA256_RE = /^sha256:[0-9a-f]{64}$/;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function revisionVersion(revision) {
  const versions = new Set(
    (revision?.distributionChannels ?? [])
      .map((channel) => channel?.crxVersion)
      .filter((version) => typeof version === "string" && version.length > 0),
  );
  if (versions.size > 1) {
    throw new Error(
      `Chrome Web Store returned multiple versions for one revision: ${[...versions]}`,
    );
  }
  return [...versions][0];
}

export function compareChromeVersions(left, right) {
  const parse = (value) => String(value).split(".").map(Number);
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < 4; index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference > 0) return 1;
    if (difference < 0) return -1;
  }
  return 0;
}

export function classifyStoreStatus(status, expectedVersion) {
  assert(status && typeof status === "object", "Chrome Web Store status is missing.");
  const published = status.publishedItemRevisionStatus;
  const submitted = status.submittedItemRevisionStatus;
  return {
    takenDown: status.takenDown === true,
    warned: status.warned === true,
    publishedState: published?.state,
    publishedVersion: revisionVersion(published),
    publishedExpected:
      published?.state === "PUBLISHED" && revisionVersion(published) === expectedVersion,
    submittedState: submitted?.state,
    submittedVersion: revisionVersion(submitted),
    submittedExpected: revisionVersion(submitted) === expectedVersion,
  };
}

async function sha256(path) {
  return `sha256:${createHash("sha256")
    .update(await readFile(path))
    .digest("hex")}`;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export class ChromeWebStoreClient {
  constructor({ publisherId, extensionId, accessToken, fetchImpl = fetch, sleep = delay }) {
    assert(typeof publisherId === "string" && publisherId.length > 0, "Publisher ID is required.");
    assert(/^[a-p]{32}$/.test(extensionId), "A valid Chrome extension ID is required.");
    assert(typeof accessToken === "string" && accessToken.length > 0, "Access token is required.");
    this.publisherId = publisherId;
    this.extensionId = extensionId;
    this.accessToken = accessToken;
    this.fetch = fetchImpl;
    this.sleep = sleep;
  }

  resourceName() {
    return `publishers/${encodeURIComponent(this.publisherId)}/items/${this.extensionId}`;
  }

  async request(path, { method = "GET", body, contentType } = {}) {
    const headers = { Authorization: `Bearer ${this.accessToken}` };
    if (contentType) headers["Content-Type"] = contentType;
    const response = await this.fetch(`${API_ROOT}${path}`, { method, headers, body });
    const raw = await response.text();
    let payload;
    try {
      payload = raw ? JSON.parse(raw) : {};
    } catch {
      payload = { response: raw.slice(0, 1_000) };
    }
    if (!response.ok) {
      const detail = payload?.error?.message ?? payload?.response ?? response.statusText;
      throw new Error(`Chrome Web Store API ${method} failed (${response.status}): ${detail}`);
    }
    return payload;
  }

  fetchStatus() {
    return this.request(`/v2/${this.resourceName()}:fetchStatus`);
  }

  upload(packageBytes) {
    return this.request(`/upload/v2/${this.resourceName()}:upload`, {
      method: "POST",
      body: packageBytes,
      contentType: "application/zip",
    });
  }

  publish(publishType) {
    return this.request(`/v2/${this.resourceName()}:publish`, {
      method: "POST",
      body: JSON.stringify({
        publishType,
        deployInfos: [{ deployPercentage: 100 }],
        blockOnWarnings: true,
      }),
      contentType: "application/json",
    });
  }

  cancelSubmission() {
    return this.request(`/v2/${this.resourceName()}:cancelSubmission`, { method: "POST" });
  }

  async waitForUpload(initialState, { attempts = 30, intervalMs = 2_000 } = {}) {
    let state = initialState;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (state === "SUCCEEDED") return;
      if (state === "FAILED" || state === "NOT_FOUND") {
        throw new Error(`Chrome Web Store package upload failed with state ${state}.`);
      }
      if (state !== "IN_PROGRESS" && state !== "UPLOAD_IN_PROGRESS") {
        throw new Error(`Chrome Web Store returned unknown upload state ${state}.`);
      }
      await this.sleep(intervalMs);
      state = (await this.fetchStatus()).lastAsyncUploadState;
    }
    throw new Error("Chrome Web Store package upload did not finish within 60 seconds.");
  }

  async waitForRevision(expectedVersion, acceptableStates, { attempts = 15 } = {}) {
    let latest;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      latest = await this.fetchStatus();
      const classified = classifyStoreStatus(latest, expectedVersion);
      if (classified.publishedExpected && acceptableStates.has("PUBLISHED")) return latest;
      if (classified.submittedExpected && acceptableStates.has(classified.submittedState)) {
        return latest;
      }
      await this.sleep(2_000);
    }
    const state = classifyStoreStatus(latest, expectedVersion);
    throw new Error(
      `Chrome Web Store did not reach ${[...acceptableStates].join(" or ")} for ${expectedVersion}; ` +
        `published=${state.publishedVersion ?? "none"}/${state.publishedState ?? "none"}, ` +
        `submitted=${state.submittedVersion ?? "none"}/${state.submittedState ?? "none"}.`,
    );
  }
}

function assertSafeStoreStatus(classified) {
  if (classified.takenDown) {
    throw new Error("Chrome Web Store item is taken down; resolve the policy violation first.");
  }
  if (classified.warned) {
    throw new Error(
      "Chrome Web Store item has an active policy warning; resolve it before release.",
    );
  }
}

async function loadMetadata(path) {
  const metadata = JSON.parse(await readFile(path, "utf8"));
  validateExtensionMetadata(metadata, { channel: "rc" });
  return metadata;
}

async function saveStoreState(metadataPath, metadata, status) {
  const classified = classifyStoreStatus(status, metadata.extension.version);
  const state = classified.publishedExpected
    ? "PUBLISHED"
    : classified.submittedExpected
      ? classified.submittedState
      : "UNKNOWN";
  metadata.store = { state };
  await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
}

export async function submitExtensionRc({ client, metadataPath, packagePath }) {
  const metadata = await loadMetadata(metadataPath);
  assert(metadata.release.required, "Unchanged extension metadata must not be submitted.");
  assert(packagePath, `${EXTENSION_PACKAGE_NAME} is required for an extension submission.`);
  assert(SHA256_RE.test(metadata.release.packageSha256), "Extension package hash is invalid.");
  assert(
    (await sha256(packagePath)) === metadata.release.packageSha256,
    "Extension package hash does not match extension-build.json.",
  );

  let status = await client.fetchStatus();
  let classified = classifyStoreStatus(status, metadata.extension.version);
  assertSafeStoreStatus(classified);
  if (classified.publishedExpected || classified.submittedExpected) {
    if (
      classified.publishedExpected ||
      classified.submittedState === "PENDING_REVIEW" ||
      classified.submittedState === "STAGED"
    ) {
      await saveStoreState(metadataPath, metadata, status);
      return status;
    }
    if (TERMINAL_FAILURE_STATES.has(classified.submittedState)) {
      throw new Error(
        `Chrome Web Store submission ${metadata.extension.version} is ${classified.submittedState}; ` +
          "create a new desktop RC so the store version advances.",
      );
    }
  }

  if (
    classified.publishedVersion &&
    compareChromeVersions(metadata.extension.version, classified.publishedVersion) <= 0
  ) {
    throw new Error(
      `Extension version ${metadata.extension.version} must exceed the published Chrome Web Store ` +
        `version ${classified.publishedVersion}.`,
    );
  }

  if (ACTIVE_SUBMISSION_STATES.has(classified.submittedState)) {
    const allowed = metadata.release.supersedes;
    if (!allowed || classified.submittedVersion !== allowed) {
      throw new Error(
        `Chrome Web Store already has ${classified.submittedVersion ?? "an unknown version"} ` +
          `in ${classified.submittedState}; refusing to cancel an uncorrelated submission.`,
      );
    }
    await client.cancelSubmission();
    status = await client.waitForRevision(allowed, new Set(["CANCELLED"]));
    classified = classifyStoreStatus(status, metadata.extension.version);
    assertSafeStoreStatus(classified);
  }

  const upload = await client.upload(await readFile(packagePath));
  await client.waitForUpload(upload.uploadState);
  if (upload.crxVersion && upload.crxVersion !== metadata.extension.version) {
    throw new Error(
      `Chrome Web Store parsed version ${upload.crxVersion}, expected ${metadata.extension.version}.`,
    );
  }
  await client.publish("STAGED_PUBLISH");
  status = await client.waitForRevision(
    metadata.extension.version,
    new Set(["PENDING_REVIEW", "STAGED"]),
  );
  await saveStoreState(metadataPath, metadata, status);
  return status;
}

export async function checkExtensionRcReady({ client, metadataPath }) {
  const metadata = await loadMetadata(metadataPath);
  if (!metadata.release.required) return { metadata, status: undefined };
  const status = await client.fetchStatus();
  const classified = classifyStoreStatus(status, metadata.extension.version);
  assertSafeStoreStatus(classified);
  if (classified.publishedExpected) return { metadata, status };
  if (!classified.submittedExpected || classified.submittedState !== "STAGED") {
    throw new Error(
      `Extension ${metadata.extension.version} is not ready for stable promotion: ` +
        `${classified.submittedState ?? "no submission"}. Wait for Chrome review to reach STAGED.`,
    );
  }
  return { metadata, status };
}

export async function promoteExtensionStable({ client, metadataPath }) {
  const { metadata, status: initialStatus } = await checkExtensionRcReady({
    client,
    metadataPath,
  });
  if (!metadata.release.required) return undefined;
  const initial = classifyStoreStatus(initialStatus, metadata.extension.version);
  if (initial.publishedExpected) {
    await saveStoreState(metadataPath, metadata, initialStatus);
    return initialStatus;
  }
  await client.publish("DEFAULT_PUBLISH");
  const status = await client.waitForRevision(metadata.extension.version, new Set(["PUBLISHED"]));
  await saveStoreState(metadataPath, metadata, status);
  return status;
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
  const metadata = await loadMetadata(options.metadata);
  if (!metadata.release.required) {
    console.log("Extension build inputs are unchanged; no Chrome Web Store action is required.");
    return;
  }
  const client = new ChromeWebStoreClient({
    publisherId: process.env.CHROME_WEB_STORE_PUBLISHER_ID,
    extensionId: metadata.extension.id,
    accessToken: process.env.CHROME_WEB_STORE_ACCESS_TOKEN,
  });
  if (command === "submit") {
    await submitExtensionRc({
      client,
      metadataPath: options.metadata,
      packagePath: options.package,
    });
    console.log(`Extension ${metadata.extension.version} submitted for staged publication.`);
    return;
  }
  if (command === "check-staged") {
    await checkExtensionRcReady({ client, metadataPath: options.metadata });
    console.log(`Extension ${metadata.extension.version} is staged and ready to promote.`);
    return;
  }
  if (command === "promote") {
    await promoteExtensionStable({ client, metadataPath: options.metadata });
    console.log(`Extension ${metadata.extension.version} published to stable.`);
    return;
  }
  throw new Error("Usage: chrome-web-store.mjs <submit|check-staged|promote> --metadata <path>");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
