import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { devAppIdentityForBranch } from "../../scripts/dev-app-identity.mjs";
import { clovyMarkPalette } from "../../scripts/generate-icons.mjs";

const iconTemplate = readFileSync(
  resolve(process.cwd(), "src-tauri/icons/themed/_src/icon.template.svg"),
  "utf8",
);
const macosConfig = JSON.parse(
  readFileSync(resolve(process.cwd(), "src-tauri/tauri.macos.conf.json"), "utf8"),
);
const tauriConfig = JSON.parse(
  readFileSync(resolve(process.cwd(), "src-tauri/tauri.conf.json"), "utf8"),
);
const windowsConfig = JSON.parse(
  readFileSync(resolve(process.cwd(), "src-tauri/tauri.windows.conf.json"), "utf8"),
);
const macosInfoPlist = readFileSync(resolve(process.cwd(), "src-tauri/Info.plist"), "utf8");
const macosLocalizedInfoPlist = readFileSync(
  resolve(process.cwd(), "src-tauri/resources/macos/en.lproj/InfoPlist.strings"),
  "utf8",
);
const stableUpdaterEndpoint =
  "https://github.com/open-software-network/os-june-releases/releases/latest/download/latest.json";

describe("development app identity", () => {
  it("keeps the visible name stable on a Codex issue branch", () => {
    expect(devAppIdentityForBranch("codex/jun-278-computer-use")).toEqual({
      productName: "Clovy",
      identifier: "co.opensoftware.june.codex.jun278",
    });
  });

  it("normalizes the internal issue identity without exposing it in the name", () => {
    expect(devAppIdentityForBranch("codex/fix-JUN-00278-permissions")).toEqual({
      productName: "Clovy",
      identifier: "co.opensoftware.june.codex.jun00278",
    });
  });

  it("isolates Claude worktrees under the same visible name", () => {
    expect(devAppIdentityForBranch("claude/jun-278-computer-use")).toEqual({
      productName: "Clovy",
      identifier: "co.opensoftware.june.claude.jun278",
    });
  });

  it.each([
    "main",
    "codex/refactor-dev-launch",
    "jakub/jun-278-integration",
    "",
  ])("keeps the normal identity for %s", (branch) => {
    expect(devAppIdentityForBranch(branch)).toEqual({
      productName: "Clovy",
      identifier: "co.opensoftware.june",
    });
  });
});

describe("macOS release identity", () => {
  it("keeps the shipped app path while presenting the Clovy display name", () => {
    expect(macosConfig.productName).toBe("June");
    expect(macosConfig.bundle.macOS.bundleName).toBe("Clovy");
    expect(macosInfoPlist).toContain("<key>CFBundleDisplayName</key>\n  <string>June</string>");
    expect(macosInfoPlist).toContain("<key>LSHasLocalizedDisplayName</key>\n  <true/>");
    expect(macosLocalizedInfoPlist).toContain('CFBundleDisplayName = "Clovy";');
    expect(macosLocalizedInfoPlist).toContain('CFBundleName = "Clovy";');
    expect(macosConfig.bundle.resources["resources/macos/en.lproj/InfoPlist.strings"]).toBe(
      "en.lproj/InfoPlist.strings",
    );
  });
});

describe("production identity compatibility", () => {
  it("locks immutable identities and canonical migration aliases", () => {
    expect(tauriConfig.identifier).toBe("co.opensoftware.june");
    expect(tauriConfig.plugins["deep-link"].desktop.schemes).toEqual(["clovy", "osjune"]);
    expect(tauriConfig.plugins["deep-link"].mobile).toEqual([
      { scheme: ["clovy", "osjune"], appLink: false },
    ]);
    expect(tauriConfig.plugins.updater).toEqual({
      pubkey:
        "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDUwMDUxRDBGNzYyRDU0MTgKUldRWVZDMTJEeDBGVUZWQ3VsVWxCdmhFbk9McWFVWjBGTEZZZHN0NFZRQjFZaFZRVzF4Sm9NdnkK",
      endpoints: [stableUpdaterEndpoint],
    });
    expect(macosConfig.productName).toBe("June");
    expect(windowsConfig.productName).toBe("June");
    for (const platformConfig of [macosConfig, windowsConfig]) {
      expect(platformConfig.identifier).toBeUndefined();
      expect(platformConfig.plugins?.updater).toBeUndefined();
      expect(platformConfig.plugins?.["deep-link"]).toBeUndefined();
    }

    const sourceIdentities = {
      "src-tauri/src/updates.rs": [`const STABLE_ENDPOINT: &str = "${stableUpdaterEndpoint}";`],
      "src-tauri/src/os_accounts.rs": [
        'const KEYCHAIN_SERVICE: &str = "co.opensoftware.clovy.accounts";',
        'const DEV_KEYCHAIN_SERVICE: &str = "co.opensoftware.clovy-dev.accounts";',
        'const LEGACY_KEYCHAIN_SERVICE: &str = "co.opensoftware.june.accounts";',
        'const LEGACY_DEV_KEYCHAIN_SERVICE: &str = "co.opensoftware.june-dev.accounts";',
      ],
      "src-tauri/src/agent_runtime/secrets.rs": [
        'const KEYCHAIN_SERVICE: &str = "co.opensoftware.clovy.agent-secrets";',
        'const DEV_KEYCHAIN_SERVICE: &str = "co.opensoftware.clovy.dev.agent-secrets";',
        'const LEGACY_KEYCHAIN_SERVICE: &str = "co.opensoftware.june.agent-secrets";',
        'const LEGACY_DEV_KEYCHAIN_SERVICE: &str = "co.opensoftware.june.dev.agent-secrets";',
      ],
      "src-tauri/src/agent_mcp.rs": [
        'const KEYCHAIN_SERVICE: &str = "co.opensoftware.clovy.agent-mcp";',
        'const DEV_KEYCHAIN_SERVICE: &str = "co.opensoftware.clovy-dev.agent-mcp";',
        'const LEGACY_KEYCHAIN_SERVICE: &str = "co.opensoftware.june.agent-mcp";',
        'const LEGACY_DEV_KEYCHAIN_SERVICE: &str = "co.opensoftware.june-dev.agent-mcp";',
      ],
      "src-tauri/src/connectors/store.rs": [
        'const KEYCHAIN_SERVICE_PREFIX: &str = "co.opensoftware.clovy";',
        'const DEV_KEYCHAIN_SERVICE_PREFIX: &str = "co.opensoftware.clovy-dev";',
        'const LEGACY_KEYCHAIN_SERVICE_PREFIX: &str = "co.opensoftware.june";',
        'const LEGACY_DEV_KEYCHAIN_SERVICE_PREFIX: &str = "co.opensoftware.june-dev";',
      ],
      "src-tauri/src/connectors/notion.rs": [
        'const KEYCHAIN_SERVICE: &str = "co.opensoftware.clovy.notion-hosted-mcp";',
        'const DEV_KEYCHAIN_SERVICE: &str = "co.opensoftware.clovy-dev.notion-hosted-mcp";',
        'const LEGACY_KEYCHAIN_SERVICE: &str = "co.opensoftware.june.notion-hosted-mcp";',
        'const LEGACY_DEV_KEYCHAIN_SERVICE: &str = "co.opensoftware.june-dev.notion-hosted-mcp";',
      ],
      "src-tauri/src/companion/mod.rs": [
        'const KEYCHAIN_SERVICE: &str = "co.opensoftware.clovy.companion.desktop.identity";',
        'const LEGACY_KEYCHAIN_SERVICE: &str = "co.opensoftware.june.companion.desktop.identity";',
      ],
      "src-tauri/src/extension_host.rs": [
        'pub const NATIVE_HOST_NAME: &str = "co.opensoftware.clovy.extension";',
        'pub const LEGACY_NATIVE_HOST_NAME: &str = "co.opensoftware.june.extension";',
        'pub const EXTENSION_ID: &str = "jfpogffllplkfoooiaibjkojkngbdnik";',
      ],
      "extension/src/protocol.ts": [
        'export const NATIVE_HOST_NAME = "co.opensoftware.clovy.extension";',
        'export const LEGACY_NATIVE_HOST_NAME = "co.opensoftware.june.extension";',
      ],
    };

    for (const [path, identities] of Object.entries(sourceIdentities)) {
      const sourceLines = readFileSync(resolve(process.cwd(), path), "utf8")
        .split("\n")
        .map((line) => line.trim());
      for (const identity of identities) {
        expect(sourceLines.filter((line) => line === identity)).toHaveLength(1);
      }
    }
  });
});

describe("Clovy themed icon generation", () => {
  it("keeps the canonical lime material for Sage", () => {
    expect(clovyMarkPalette("sage", "#3f812f")).toEqual({
      top: "#F0FF92",
      high: "#E2FF6D",
      mid: "#D7FF54",
      bottom: "#B0FA65",
      strokeTop: "#F6FFC4",
      strokeBottom: "#54D55F",
    });
  });

  it("gives every other preset a distinct luminous Clovy material", () => {
    const palettes = [
      clovyMarkPalette("rose", "#a5655c"),
      clovyMarkPalette("clay", "#b5551f"),
      clovyMarkPalette("ocean", "#3d7b9a"),
      clovyMarkPalette("plum", "#965d84"),
    ];

    expect(new Set(palettes.map((palette) => palette.bottom)).size).toBe(4);
    for (const palette of palettes) {
      expect(Object.values(palette).every((color) => /^#[0-9a-f]{6}$/i.test(color))).toBe(true);
      expect(palette.bottom).not.toBe("#B0FA65");
    }
  });

  it("routes every mark material stop through the generator", () => {
    for (const placeholder of [
      "{{MARK_TOP}}",
      "{{MARK_HIGH}}",
      "{{MARK_MID}}",
      "{{MARK_BOTTOM}}",
      "{{MARK_STROKE_TOP}}",
      "{{MARK_STROKE_BOTTOM}}",
    ]) {
      expect(iconTemplate).toContain(placeholder);
    }
  });
});

describe("Vitest resource limits", () => {
  it("keeps every frontend test command in a bounded worker-thread pool", () => {
    const configs = [
      readFileSync(resolve("vite.config.ts"), "utf8"),
      readFileSync(resolve("extension/vite.config.ts"), "utf8"),
    ];

    for (const config of configs) {
      const testConfig = config.slice(config.indexOf("  test: {"));
      expect(testConfig).toContain('pool: "threads"');
      expect(testConfig).toContain("fileParallelism: false");
      expect(testConfig).toContain("maxWorkers: 1");
    }
  });
});
