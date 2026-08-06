import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");

async function read(relativePath) {
  return readFile(join(root, relativePath), "utf8");
}

describe("Clovy technical identity", () => {
  it("uses Clovy for canonical package, service, and helper names", async () => {
    const [packageJson, agentPackage, extensionPackage, desktopCargo, apiCargo, apiAppCargo] =
      await Promise.all([
        read("package.json").then(JSON.parse),
        read("agent-runtime/package.json").then(JSON.parse),
        read("extension/package.json").then(JSON.parse),
        read("src-tauri/Cargo.toml"),
        read("clovy-api/Cargo.toml"),
        read("clovy-api/crates/app/Cargo.toml"),
      ]);

    expect(packageJson.name).toBe("clovy");
    expect(agentPackage.name).toBe("@clovy/agent-runtime");
    expect(agentPackage.bin).toEqual({ "clovy-agent-runtime": "./dist/main.js" });
    expect(extensionPackage.name).toBe("clovy-extension");
    expect(desktopCargo).toMatch(/^name = "clovy"$/m);
    expect(desktopCargo).toMatch(/^name = "clovy_lib"$/m);
    expect(desktopCargo).toMatch(/^name = "clovy-nm-shim"$/m);
    expect(apiCargo).toContain('members = ["crates/*"]');
    expect(apiCargo).toContain('clovy-api = { path = "crates/api" }');
    expect(apiAppCargo).toMatch(/^name = "clovy-api-server"$/m);
    expect(apiAppCargo).toMatch(/^name = "clovy-api"$/m);
  });

  it("retains installed desktop and updater identities", async () => {
    const [tauri, macos, windows, desktopCargo] = await Promise.all([
      read("src-tauri/tauri.conf.json").then(JSON.parse),
      read("src-tauri/tauri.macos.conf.json").then(JSON.parse),
      read("src-tauri/tauri.windows.conf.json").then(JSON.parse),
      read("src-tauri/Cargo.toml"),
    ]);

    expect(tauri.productName).toBe("Clovy");
    expect(tauri.identifier).toBe("co.opensoftware.june");
    expect(tauri.plugins["deep-link"].desktop.schemes).toEqual(["clovy", "osjune"]);
    expect(tauri.plugins.updater.endpoints).toEqual([
      "https://github.com/open-software-network/os-june-releases/releases/latest/download/latest.json",
    ]);
    expect(macos.productName).toBe("June");
    expect(macos.bundle.macOS.bundleName).toBe("Clovy");
    expect(windows.productName).toBe("June");
    expect(desktopCargo).toMatch(/^default-run = "os-june"$/m);
    expect(desktopCargo).toMatch(/^name = "os-june"$/m);
  });

  it("keeps canonical-first bridges for credentials, browser storage, headers, and hosts", async () => {
    const [credentials, storage, desktopApi, backendApi, extensionHost, extensionProtocol] =
      await Promise.all([
        read("src-tauri/src/credential_compat.rs"),
        read("src/lib/storage-compat.ts"),
        read("src-tauri/src/clovy_api.rs"),
        read("clovy-api/crates/api/src/lib.rs"),
        read("src-tauri/src/extension_host.rs"),
        read("extension/src/protocol.ts"),
      ]);

    expect(credentials).toContain("canonical_service");
    expect(credentials).toContain("legacy_service");
    expect(storage).toContain('key.startsWith("clovy:")');
    expect(storage).toContain('`june:${key.slice("clovy:".length)}`');
    expect(storage).toContain('key.startsWith("os-clovy:")');
    expect(storage).toContain('`os-june:${key.slice("os-clovy:".length)}`');
    for (const source of [desktopApi, backendApi]) {
      expect(source).toContain("x-clovy-app-version");
      expect(source).toContain("x-june-app-version");
    }
    for (const source of [extensionHost, extensionProtocol]) {
      expect(source).toContain("co.opensoftware.clovy.extension");
      expect(source).toContain("co.opensoftware.june.extension");
    }
  });

  it("preserves released API and C ABI contracts while publishing canonical aliases", async () => {
    const [desktopApi, canonicalHeader, legacyHeader, cryptoSource, apiBuild, apiPromotion] =
      await Promise.all([
        read("src-tauri/src/clovy_api.rs"),
        read("crates/clovy-companion-crypto/include/clovy_companion_crypto.h"),
        read("crates/clovy-companion-crypto/include/june_companion_crypto.h"),
        read("crates/clovy-companion-crypto/src/lib.rs"),
        read(".github/workflows/build-clovy-api.yml"),
        read(".github/workflows/promote-clovy-api.yml"),
      ]);

    expect(desktopApi).toContain('"https://june-api.opensoftware.co"');
    expect(desktopApi).toContain('b"june-api-operation-id-v1\\0"');
    expect(desktopApi).toContain('format!("june-op-');
    expect(canonicalHeader).toContain("clovy_crypto_generate_identity");
    expect(legacyHeader).toContain("june_crypto_generate_identity");
    expect(cryptoSource).toContain('pub unsafe extern "C" fn clovy_crypto_generate_identity');
    expect(cryptoSource).toContain('pub unsafe extern "C" fn june_crypto_generate_identity');
    for (const workflow of [apiBuild, apiPromotion]) {
      expect(workflow).toContain("/clovy-api");
      expect(workflow).toContain("/june-api");
    }
  });
});
