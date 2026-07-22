import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanStagedComputerUseBundles,
  computerUseBundleIdentifier,
  resetComputerUseDevGrants,
} from "../../scripts/computer-use-dev.mjs";

const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Computer use development identity", () => {
  const baseIdentifier = "co.opensoftware.june.computer-use-driver";

  it("is stable within a worktree and isolated between worktrees", () => {
    const first = computerUseBundleIdentifier({
      baseIdentifier,
      profile: "debug",
      worktreeRoot: "/tmp/june-worktree-a",
    });
    const same = computerUseBundleIdentifier({
      baseIdentifier,
      profile: "debug",
      worktreeRoot: "/tmp/june-worktree-a",
    });
    const second = computerUseBundleIdentifier({
      baseIdentifier,
      profile: "debug",
      worktreeRoot: "/tmp/june-worktree-b",
    });

    expect(first).toBe(same);
    expect(first).not.toBe(second);
    expect(first).toMatch(/^co\.opensoftware\.june\.computer-use-driver\.dev\.w[0-9a-f]{12}$/);
  });

  it("keeps the production bundle identifier fixed", () => {
    expect(
      computerUseBundleIdentifier({
        baseIdentifier,
        profile: "release",
        worktreeRoot: "/tmp/any-worktree",
      }),
    ).toBe(baseIdentifier);
  });
});

describe("Computer use development restart", () => {
  it("removes only staged debug helper bundles", () => {
    const worktreeRoot = mkdtempSync(path.join(tmpdir(), "june-computer-use-dev-test-"));
    temporaryDirectories.push(worktreeRoot);
    const bundleName = "June Computer Use Driver.app";
    const directBundle = path.join(
      worktreeRoot,
      "src-tauri",
      "target",
      "debug",
      "native",
      "bin",
      bundleName,
    );
    const appBundle = path.join(
      worktreeRoot,
      "src-tauri",
      "target",
      "debug",
      "bundle",
      "macos",
      "June Dev.app",
      "Contents",
      "Resources",
      "native",
      "bin",
      bundleName,
    );
    const releaseBundle = path.join(
      worktreeRoot,
      "src-tauri",
      "target",
      "release",
      "native",
      "bin",
      bundleName,
    );
    for (const bundle of [directBundle, appBundle, releaseBundle]) {
      mkdirSync(bundle, { recursive: true });
      writeFileSync(path.join(bundle, "marker"), "test");
    }

    const removed = cleanStagedComputerUseBundles({ worktreeRoot, bundleName });

    expect(removed).toEqual(expect.arrayContaining([directBundle, appBundle]));
    expect(removed).not.toContain(releaseBundle);
    expect(() => writeFileSync(path.join(releaseBundle, "still-present"), "test")).not.toThrow();
  });

  it("registers the helper and resets each grant for its responsible app", () => {
    const run = vi.fn(() => ({ status: 0, stdout: "", stderr: "" }));
    const helperBundleIdentifier = "co.opensoftware.june.computer-use-driver.dev.w123456789abc";
    const appBundleIdentifier = "co.opensoftware.june.codex.jun278";
    const bundlePath = "/tmp/june-worktree/.tauri-helper/June Computer Use Driver.app";

    expect(
      resetComputerUseDevGrants({ bundlePath, helperBundleIdentifier, appBundleIdentifier }, run),
    ).toEqual(["Accessibility", "ScreenCapture"]);
    expect(run.mock.calls).toEqual([
      [
        "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister",
        ["-f", bundlePath],
        { encoding: "utf8" },
      ],
      [
        "/usr/bin/tccutil",
        ["reset", "Accessibility", helperBundleIdentifier],
        { encoding: "utf8" },
      ],
      ["/usr/bin/tccutil", ["reset", "ScreenCapture", appBundleIdentifier], { encoding: "utf8" }],
    ]);
  });
});
