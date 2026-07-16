import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  checkExtensionRcReady,
  classifyStoreStatus,
  compareChromeVersions,
  previousRcCanBeReused,
  promoteExtensionStable,
  submitExtensionRc,
} from "../../scripts/chrome-web-store.mjs";
import {
  chromeStoreVersionFromDesktopRc,
  extensionIdFromManifestKey,
  extensionPayloadFingerprint,
  prepareExtensionRelease,
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

  it("rebuilds with the higher RC version when a reusable package is missing or mismatched", async () => {
    const root = await mkdtemp(join(tmpdir(), "june-extension-prepare-"));
    const dist = join(root, "extension", "dist");
    const output = join(root, "output");
    await mkdir(dist, { recursive: true });
    await writeFile(join(dist, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    await writeFile(join(dist, "background.js"), "console.log('release');\n");
    const previous = await releaseFixture();
    previous.metadata.source.fingerprint = await extensionPayloadFingerprint(dist);
    await writeFile(previous.metadataPath, `${JSON.stringify(previous.metadata, null, 2)}\n`);
    await writeFile(previous.packagePath, "mismatched package");

    const result = await prepareExtensionRelease({
      root,
      desktopVersion: "1.2.3-rc.5",
      sourceCommit,
      outputDir: output,
      previousRcMetadataPath: previous.metadataPath,
      previousRcPackagePath: previous.packagePath,
      reusePreviousRc: true,
    });

    expect(result.metadata.release.reason).toBe("changed");
    expect(result.metadata.release.supersedes).toBe("2.2.3.4");
    expect(result.metadata.extension.version).toBe("2.2.3.5");
  });

  it("carries an active correlated RC when the payload returns to stable bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "june-extension-revert-"));
    const dist = join(root, "extension", "dist");
    const output = join(root, "output");
    await mkdir(dist, { recursive: true });
    await writeFile(join(dist, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    await writeFile(join(dist, "background.js"), "console.log('stable');\n");
    const currentFingerprint = await extensionPayloadFingerprint(dist);
    const previous = await releaseFixture();
    previous.metadata.source.fingerprint = currentFingerprint;
    await writeFile(previous.metadataPath, `${JSON.stringify(previous.metadata, null, 2)}\n`);
    const stablePath = join(root, "stable-extension-build.json");
    await writeFile(
      stablePath,
      `${JSON.stringify(
        {
          ...previous.metadata,
          channel: "stable",
          desktop: {
            version: "1.2.2",
            baseVersion: "1.2.2",
            rcVersion: "1.2.2-rc.1",
            sourceCommit,
          },
          extension: { ...previous.metadata.extension, version: "2.2.2.1" },
          store: { state: "published" },
        },
        null,
        2,
      )}\n`,
    );

    const result = await prepareExtensionRelease({
      root,
      desktopVersion: "1.2.3-rc.5",
      sourceCommit,
      outputDir: output,
      previousStableMetadataPath: stablePath,
      previousRcMetadataPath: previous.metadataPath,
      previousRcPackagePath: previous.packagePath,
      reusePreviousRc: true,
    });

    expect(result.metadata.release.reason).toBe("unchanged");
    expect(result.metadata.release.supersedes).toBe("2.2.3.4");
    expect(result.metadata.extension.version).toBe("2.2.2.1");
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

  it("rejects a package published before desktop stable promotion", async () => {
    const { metadataPath } = await releaseFixture();
    const client = {
      fetchStatus: vi.fn().mockResolvedValue(status("PUBLISHED", "2.2.3.4", { published: true })),
    };
    await expect(checkExtensionRcReady({ client, metadataPath })).rejects.toThrow(
      "published before desktop stable promotion",
    );
  });

  it("makes RC submission idempotent when the same package is already under review", async () => {
    const { metadataPath, packagePath } = await releaseFixture();
    const client = { fetchStatus: vi.fn().mockResolvedValue(status("PENDING_REVIEW", "2.2.3.4")) };
    await submitExtensionRc({ client, metadataPath, packagePath });
    expect(client.fetchStatus).toHaveBeenCalledOnce();
    expect(JSON.parse(await readFile(metadataPath, "utf8")).store.state).toBe("PENDING_REVIEW");
  });

  it("reuses only the exact prior version while it is pending or staged", async () => {
    const { metadataPath } = await releaseFixture();
    const pendingClient = {
      fetchStatus: vi.fn().mockResolvedValue(status("PENDING_REVIEW", "2.2.3.4")),
    };
    await expect(previousRcCanBeReused({ client: pendingClient, metadataPath })).resolves.toBe(
      true,
    );

    const rejectedClient = {
      fetchStatus: vi.fn().mockResolvedValue(status("REJECTED", "2.2.3.4")),
    };
    await expect(previousRcCanBeReused({ client: rejectedClient, metadataPath })).resolves.toBe(
      false,
    );

    const unrelatedClient = {
      fetchStatus: vi.fn().mockResolvedValue(status("STAGED", "2.2.3.5")),
    };
    await expect(previousRcCanBeReused({ client: unrelatedClient, metadataPath })).resolves.toBe(
      false,
    );
  });

  it("rejects an RC package that was published before desktop promotion", async () => {
    const { metadataPath, packagePath } = await releaseFixture();
    const client = {
      fetchStatus: vi.fn().mockResolvedValue(status("PUBLISHED", "2.2.3.4", { published: true })),
    };
    await expect(submitExtensionRc({ client, metadataPath, packagePath })).rejects.toThrow(
      "published before desktop stable promotion",
    );
  });

  it("verifies unchanged bytes still match a clean published store state", async () => {
    const { metadataPath } = await releaseFixture({ required: false });
    const published = status("PUBLISHED", "2.2.3.4", { published: true });
    const client = { fetchStatus: vi.fn().mockResolvedValue(published) };
    await expect(
      submitExtensionRc({ client, metadataPath, packagePath: undefined }),
    ).resolves.toEqual(published);
  });

  it("blocks unchanged promotion while an uncorrelated submission is active", async () => {
    const { metadataPath } = await releaseFixture({ required: false });
    const client = {
      fetchStatus: vi.fn().mockResolvedValue({
        ...status("PUBLISHED", "2.2.3.4", { published: true }),
        ...status("PENDING_REVIEW", "2.2.3.5"),
      }),
    };
    await expect(checkExtensionRcReady({ client, metadataPath })).rejects.toThrow(
      "uncorrelated 2.2.3.5 submission",
    );
  });

  it("cancels only a correlated active RC when bytes revert to stable", async () => {
    const { metadata, metadataPath } = await releaseFixture({ required: false });
    metadata.release.supersedes = "2.2.3.5";
    await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
    const published = status("PUBLISHED", "2.2.3.4", { published: true });
    const active = {
      ...published,
      ...status("PENDING_REVIEW", "2.2.3.5"),
    };
    const client = {
      fetchStatus: vi.fn().mockResolvedValueOnce(active).mockResolvedValueOnce(published),
      cancelSubmission: vi.fn().mockResolvedValue({}),
      waitForRevision: vi.fn().mockResolvedValue(status("CANCELLED", "2.2.3.5")),
    };
    await expect(
      submitExtensionRc({ client, metadataPath, packagePath: undefined }),
    ).resolves.toEqual(published);
    expect(client.cancelSubmission).toHaveBeenCalledOnce();
    expect(client.waitForRevision).toHaveBeenCalledWith("2.2.3.5", new Set(["CANCELLED"]));
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

  it("makes a direct stable-publish job retry idempotent after publication", async () => {
    const { metadataPath } = await releaseFixture({ state: "PUBLISHED" });
    const published = status("PUBLISHED", "2.2.3.4", { published: true });
    const client = {
      fetchStatus: vi.fn().mockResolvedValue(published),
      publish: vi.fn(),
      waitForRevision: vi.fn(),
    };
    await expect(promoteExtensionStable({ client, metadataPath })).resolves.toEqual(published);
    expect(client.publish).not.toHaveBeenCalled();
    expect(client.waitForRevision).not.toHaveBeenCalled();
  });
});
