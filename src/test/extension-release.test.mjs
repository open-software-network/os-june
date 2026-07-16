import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  checkExtensionRcReady,
  classifyStoreStatus,
  compareChromeVersions,
  promoteExtensionStable,
  submitExtensionRc,
} from "../../scripts/chrome-web-store.mjs";
import {
  chromeStoreVersionFromDesktopRc,
  extensionIdFromManifestKey,
  extensionPayloadFingerprint,
  validateExtensionMetadata,
  writeStableExtensionMetadata,
} from "../../scripts/extension-release.mjs";
import manifest from "../../extension/public/manifest.json";

const extensionId = "adckhkfngpnenaapncoipkalcfpjbgcn";
const sourceCommit = "a".repeat(40);
const fingerprint = `sha256:${"b".repeat(64)}`;

function status(state, version, { published = false } = {}) {
  const revision = {
    state,
    distributionChannels: [{ crxVersion: version, deployPercentage: 100 }],
  };
  return published
    ? { publishedItemRevisionStatus: revision }
    : { submittedItemRevisionStatus: revision };
}

async function releaseFixture({ state = "submission-required", required = true } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "june-extension-release-"));
  const packagePath = join(directory, "June-extension.zip");
  const packageBytes = Buffer.from("deterministic extension package");
  await writeFile(packagePath, packageBytes);
  const packageSha256 = `sha256:${createHash("sha256").update(packageBytes).digest("hex")}`;
  const metadataPath = join(directory, "extension-build.json");
  const metadata = {
    schemaVersion: 1,
    channel: "rc",
    desktop: { version: "1.2.3-rc.4", baseVersion: "1.2.3", sourceCommit },
    source: { fingerprint, method: "normalized-dist-v1" },
    extension: { id: extensionId, version: "2.2.3.4", versionName: "1.2.3" },
    store: { state },
    release: required
      ? {
          required: true,
          reason: "changed",
          supersedes: null,
          packageFile: "June-extension.zip",
          packageSha256,
        }
      : {
          required: false,
          reason: "unchanged",
          packageFile: null,
          packageSha256: null,
        },
  };
  await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
  return { directory, metadata, metadataPath, packagePath };
}

describe("Chrome extension release versioning", () => {
  it("maps the desktop RC to a monotonic four-part Chrome version", () => {
    expect(chromeStoreVersionFromDesktopRc("1.2.3-rc.4")).toEqual({
      baseVersion: "1.2.3",
      rcNumber: 4,
      storeVersion: "2.2.3.4",
    });
  });

  it("rejects versions Chrome cannot represent", () => {
    for (const version of [
      "1.2.3",
      "1.2.3-rc.0",
      "1.2.3-rc.04",
      "1.2.3-beta.1",
      "65535.0.0-rc.1",
      "1.2.3-rc.65536",
    ]) {
      expect(() => chromeStoreVersionFromDesktopRc(version)).toThrow();
    }
  });

  it("derives the pinned production ID from the checked-in public key", () => {
    expect(extensionIdFromManifestKey(manifest.key)).toBe(extensionId);
  });

  it("fingerprints package bytes while ignoring release-only manifest versions", async () => {
    const directory = await mkdtemp(join(tmpdir(), "june-extension-payload-"));
    const first = join(directory, "first");
    const second = join(directory, "second");
    await mkdir(first);
    await mkdir(second);
    await writeFile(join(first, "background.js"), "console.log('same');\n");
    await writeFile(join(second, "background.js"), "console.log('same');\n");
    await writeFile(
      join(first, "manifest.json"),
      `${JSON.stringify({ ...manifest, version: "1.0.0.1", version_name: "0.0.34" }, null, 2)}\n`,
    );
    await writeFile(
      join(second, "manifest.json"),
      `${JSON.stringify({ ...manifest, version: "1.0.0.2", version_name: "0.0.35" }, null, 2)}\n`,
    );
    expect(await extensionPayloadFingerprint(first)).toBe(
      await extensionPayloadFingerprint(second),
    );
    await writeFile(join(second, "background.js"), "console.log('changed');\n");
    expect(await extensionPayloadFingerprint(first)).not.toBe(
      await extensionPayloadFingerprint(second),
    );
  });
});

describe("extension release metadata", () => {
  it("requires a package hash whenever a store release is required", async () => {
    const { metadata } = await releaseFixture();
    expect(validateExtensionMetadata(metadata, { channel: "rc" })).toBe(metadata);
    expect(() =>
      validateExtensionMetadata(
        { ...metadata, release: { ...metadata.release, packageSha256: null } },
        { channel: "rc" },
      ),
    ).toThrow("package SHA-256");
  });

  it("records the exact RC correlation when writing stable metadata", async () => {
    const { directory, metadataPath } = await releaseFixture();
    const output = join(directory, "stable-extension-build.json");
    const stable = await writeStableExtensionMetadata({
      rcMetadataPath: metadataPath,
      desktopVersion: "1.2.3",
      sourceCommit,
      outputPath: output,
    });
    expect(stable.channel).toBe("stable");
    expect(stable.desktop.rcVersion).toBe("1.2.3-rc.4");
    expect(stable.store.state).toBe("published");
    expect(JSON.parse(await readFile(output, "utf8"))).toEqual(stable);
  });
});

describe("Chrome Web Store state gates", () => {
  it("orders Chrome's one-to-four numeric version components", () => {
    expect(compareChromeVersions("1.0.34.2", "1.0.34.1")).toBe(1);
    expect(compareChromeVersions("1.1", "1.0.65535.65535")).toBe(1);
    expect(compareChromeVersions("1.2.0", "1.2")).toBe(0);
  });

  it("recognizes only the expected package as staged", () => {
    expect(classifyStoreStatus(status("STAGED", "2.2.3.4"), "2.2.3.4")).toMatchObject({
      submittedExpected: true,
      submittedState: "STAGED",
    });
    expect(classifyStoreStatus(status("STAGED", "2.2.3.3"), "2.2.3.4")).toMatchObject({
      submittedExpected: false,
      submittedVersion: "2.2.3.3",
    });
  });

  it("makes pending Chrome review a hard stable preflight failure", async () => {
    const { metadataPath } = await releaseFixture();
    const client = { fetchStatus: vi.fn().mockResolvedValue(status("PENDING_REVIEW", "2.2.3.4")) };
    await expect(checkExtensionRcReady({ client, metadataPath })).rejects.toThrow(
      "Wait for Chrome review to reach STAGED",
    );
  });

  it("makes RC submission idempotent when the same package is already under review", async () => {
    const { metadataPath, packagePath } = await releaseFixture();
    const client = { fetchStatus: vi.fn().mockResolvedValue(status("PENDING_REVIEW", "2.2.3.4")) };
    await submitExtensionRc({ client, metadataPath, packagePath });
    expect(client.fetchStatus).toHaveBeenCalledOnce();
    expect(JSON.parse(await readFile(metadataPath, "utf8")).store.state).toBe("PENDING_REVIEW");
  });

  it("promotes only a staged package and verifies it becomes public", async () => {
    const { metadataPath } = await releaseFixture({ state: "STAGED" });
    const client = {
      fetchStatus: vi.fn().mockResolvedValue(status("STAGED", "2.2.3.4")),
      publish: vi.fn().mockResolvedValue({ state: "PUBLISHED" }),
      waitForRevision: vi
        .fn()
        .mockResolvedValue(status("PUBLISHED", "2.2.3.4", { published: true })),
    };
    await promoteExtensionStable({ client, metadataPath });
    expect(client.publish).toHaveBeenCalledWith("DEFAULT_PUBLISH");
    expect(client.waitForRevision).toHaveBeenCalledWith("2.2.3.4", new Set(["PUBLISHED"]));
  });
});
