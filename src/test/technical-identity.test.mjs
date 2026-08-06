import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");

async function read(relativePath) {
  return readFile(join(root, relativePath), "utf8");
}

function expectCanonicalPreferredAliases(compose) {
  const environment = new Map();
  for (const line of compose.split("\n")) {
    const match = line.match(/^\s*- (CLOVY__[^=]+|JUNE__[^=]+)=(.*)$/);
    if (match) environment.set(match[1], match[2]);
  }

  for (const [canonical, value] of environment) {
    if (!canonical.startsWith("CLOVY__")) continue;
    const legacy = `JUNE__${canonical.slice("CLOVY__".length)}`;
    if (!environment.has(legacy)) continue;
    expect(environment.get(legacy)).toBe(value);
    if (value.startsWith("${")) {
      expect(value.startsWith(`\${${canonical}:-`)).toBe(true);
    }
  }
}

describe("Clovy technical identity", () => {
  it("uses Clovy for canonical package, service, and helper names", async () => {
    const [
      packageJson,
      agentPackage,
      extensionPackage,
      desktopCargo,
      windowsHelperCargo,
      apiCargo,
      apiAppCargo,
      legacyCryptoCargo,
      legacyProtocolCargo,
    ] = await Promise.all([
      read("package.json").then(JSON.parse),
      read("agent-runtime/package.json").then(JSON.parse),
      read("extension/package.json").then(JSON.parse),
      read("src-tauri/Cargo.toml"),
      read("src-tauri/native/windows-dictation-helper/Cargo.toml"),
      read("clovy-api/Cargo.toml"),
      read("clovy-api/crates/app/Cargo.toml"),
      read("crates/june-companion-crypto/Cargo.toml"),
      read("crates/june-companion-protocol/Cargo.toml"),
    ]);

    expect(packageJson.name).toBe("clovy");
    expect(agentPackage.name).toBe("@clovy/agent-runtime");
    expect(agentPackage.bin).toEqual({ "clovy-agent-runtime": "./dist/main.js" });
    expect(extensionPackage.name).toBe("clovy-extension");
    expect(desktopCargo).toMatch(/^name = "clovy"$/m);
    expect(desktopCargo).toMatch(/^name = "clovy_lib"$/m);
    expect(desktopCargo).toMatch(/^name = "clovy-nm-shim"$/m);
    expect(windowsHelperCargo).toMatch(/^name = "clovy-windows-dictation-helper"$/m);
    expect(windowsHelperCargo).toMatch(/^name = "june-dictation-helper"$/m);
    expect(apiCargo).toContain('members = ["crates/*"]');
    expect(apiCargo).toContain('clovy-api = { path = "crates/api" }');
    expect(apiAppCargo).toMatch(/^name = "clovy-api-server"$/m);
    expect(apiAppCargo).toMatch(/^name = "clovy-api"$/m);
    expect(legacyCryptoCargo).toContain('name = "june-companion-crypto"');
    expect(legacyCryptoCargo).toContain(
      'clovy-companion-crypto = { path = "../clovy-companion-crypto" }',
    );
    expect(legacyProtocolCargo).toContain('name = "june-companion-protocol"');
    expect(legacyProtocolCargo).toContain(
      'clovy-companion-protocol = { path = "../clovy-companion-protocol" }',
    );
  });

  it("retains installed desktop and updater identities", async () => {
    const [tauri, macos, windows, desktopCargo, bundleShim] = await Promise.all([
      read("src-tauri/tauri.conf.json").then(JSON.parse),
      read("src-tauri/tauri.macos.conf.json").then(JSON.parse),
      read("src-tauri/tauri.windows.conf.json").then(JSON.parse),
      read("src-tauri/Cargo.toml"),
      read("scripts/bundle-nm-shim.sh"),
    ]);

    expect(tauri.productName).toBe("Clovy");
    expect(tauri.identifier).toBe("co.opensoftware.june");
    expect(tauri.plugins["deep-link"].desktop.schemes).toEqual(["clovy", "osjune"]);
    expect(tauri.plugins.updater.endpoints).toEqual([
      "https://github.com/open-software-network/os-june-releases/releases/latest/download/latest.json",
    ]);
    expect(macos.productName).toBe("June");
    expect(macos.bundle.macOS.bundleName).toBe("Clovy");
    expect(macos.bundle.resources["../.tauri-helper/june-nm-shim"]).toBe("native/bin/june-nm-shim");
    expect(bundleShim).toContain('legacy_out=".tauri-helper/june-nm-shim"');
    expect(windows.productName).toBe("June");
    expect(desktopCargo).toMatch(/^default-run = "os-june"$/m);
    expect(desktopCargo).toMatch(/^name = "os-june"$/m);
  });

  it("uses Clovy for generated build metadata and local build coordination", async () => {
    const [prepareDriver, selfTest, desktopBuild, windowsBuild, windowsQualification, sbom] =
      await Promise.all([
        read("scripts/prepare-cua-driver.mjs"),
        read("scripts/computer-use-self-test.mjs"),
        read("src-tauri/build.rs"),
        read("scripts/build-windows.ps1"),
        read("scripts/qualify-windows-build.ps1"),
        read("src-tauri/cua-driver-sbom.spdx.json").then(JSON.parse),
      ]);

    for (const source of [prepareDriver, selfTest, desktopBuild]) {
      expect(source).toContain("clovy-cua-driver-pin.json");
      expect(source).not.toContain("june-cua-driver-pin.json");
    }
    for (const source of [prepareDriver, selfTest]) {
      expect(source).toContain("clovy-cua-driver.spdx.json");
      expect(source).toContain("clovyBuild");
      expect(source).not.toContain("juneBuild");
    }
    expect(windowsBuild).toContain("ClovyWindowsBuild");
    expect(windowsQualification).toContain("ClovyWindowsBuild");
    expect(windowsQualification).toContain("firstClovyEnvironmentRestored");
    expect(sbom.name).toBe("clovy-cua-driver-0.5.0");
  });

  it("keeps rollback-safe bridges for credentials, browser storage, headers, and hosts", async () => {
    const [
      credentials,
      storage,
      storageBootstrap,
      main,
      hud,
      agentHud,
      meetingHud,
      desktopApi,
      backendApi,
      extensionHost,
      extensionProtocol,
    ] = await Promise.all([
      read("src-tauri/src/credential_compat.rs"),
      read("src/lib/storage-compat.ts"),
      read("src/lib/storage-compat-bootstrap.ts"),
      read("src/main.tsx"),
      read("src/hud.ts"),
      read("src/agent-hud.ts"),
      read("src/meeting-hud.ts"),
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
    expect(storageBootstrap).toContain("installStorageCompatibilityBridge();");
    for (const entrypoint of [main, hud, agentHud, meetingHud]) {
      expect(entrypoint.startsWith('import "./lib/storage-compat-bootstrap";')).toBe(true);
    }
    for (const source of [desktopApi, backendApi]) {
      expect(source).toContain("x-clovy-app-version");
      expect(source).toContain("x-june-app-version");
    }
    for (const source of [extensionHost, extensionProtocol]) {
      expect(source).toContain("co.opensoftware.clovy.extension");
      expect(source).toContain("co.opensoftware.june.extension");
    }
  });

  it("keeps runtime, migration, dev-env, and deployment aliases reachable", async () => {
    const [
      runtimeProvider,
      runtimeHost,
      migration,
      tauriDev,
      beforeDev,
      runApi,
      ephemeralApi,
      production,
      staging,
      ephemeral,
      linkViewer,
      linkWorkflow,
    ] = await Promise.all([
      read("agent-runtime/src/rpc-model-provider.ts"),
      read("src-tauri/src/agent_runtime/host.rs"),
      read("src-tauri/src/agent_runtime/migration.rs"),
      read("scripts/tauri-dev.mjs"),
      read("scripts/tauri-before-dev.mjs"),
      read("scripts/run-clovy-api.sh"),
      read("scripts/ephemeral-clovy-api.sh"),
      read("clovy-api/deploy/docker-compose.production.yml"),
      read("clovy-api/deploy/docker-compose.staging.yml"),
      read("clovy-api/deploy/docker-compose.ephemeral.yml"),
      read("clovy-api/deploy/docker-compose.clovy-link.yml"),
      read(".github/workflows/deploy-clovy-link.yml"),
    ]);

    expect(runtimeProvider).toContain('"__clovy_model_chat_completions"');
    expect(runtimeHost).toContain('"__clovy_model_chat_completions"');
    expect(runtimeHost).toContain('"__june_model_chat_completions"');
    expect(migration).toContain('"hermes-to-june-agent-runtime-v2"');
    expect(tauriDev).toContain("process.env.CLOVY_API_PORT ?? process.env.JUNE_API_PORT");
    expect(beforeDev).toContain(
      'process.env.CLOVY_API_PORT ?? process.env.JUNE_API_PORT ?? "8080"',
    );
    expect(runApi).toContain("${CLOVY_API_PORT:-${JUNE_API_PORT:-8080}}");
    const canonicalEnvRead = ephemeralApi.indexOf('grep -E "^${canonical}=."');
    const legacyEnvRead = ephemeralApi.indexOf('grep -E "^${legacy}=."');
    expect(canonicalEnvRead).toBeGreaterThan(-1);
    expect(legacyEnvRead).toBeGreaterThan(canonicalEnvRead);
    expect(production).toMatch(/aliases:\s*\n\s*#.*\n\s*- june-api/);

    for (const compose of [production, staging]) {
      for (const key of [
        "OS_ACCOUNTS__API_URL",
        "OS_ACCOUNTS__APP_API_KEY",
        "UPSTREAMS__OPENAI__API_KEY",
        "UPSTREAMS__VENICE__API_KEY",
        "SHARE__DATABASE_URL",
        "SHARE__VIEWER_CLIENT_ID",
      ]) {
        expect(compose).toContain(`CLOVY__${key}`);
        expect(compose).toContain(`JUNE__${key}`);
      }
    }
    for (const key of [
      "LOCAL_DEV__ENABLED",
      "LOCAL_DEV__BEARER_TOKEN",
      "LOCAL_DEV__USER_ID",
      "UPSTREAMS__OPENAI__API_KEY",
      "UPSTREAMS__VENICE__API_KEY",
    ]) {
      expect(ephemeral).toContain(`CLOVY__${key}`);
      expect(ephemeral).toContain(`JUNE__${key}`);
    }
    for (const key of [
      "OS_ACCOUNTS__API_URL",
      "SHARE__VIEWER_ONLY",
      "SHARE__DATABASE_URL",
      "SHARE__VIEWER_CLIENT_ID",
    ]) {
      expect(linkViewer).toContain(`CLOVY__${key}`);
      expect(linkViewer).toContain(`JUNE__${key}`);
    }
    expect(linkViewer).toMatch(/^\s{2}clovy-link-viewer:$/m);
    expect(linkViewer).toContain("- june-link-viewer");
    for (const compose of [production, staging, ephemeral, linkViewer]) {
      expectCanonicalPreferredAliases(compose);
    }
    for (const [key, value] of [
      ["SHARE__VIEWER_ONLY", "true"],
      ["OS_ACCOUNTS__API_URL", "https://accounts-api.opensoftware.co"],
      ["OS_ACCOUNTS__ISS", "https://accounts.opensoftware.co"],
    ]) {
      expect(linkWorkflow).toContain(`-e CLOVY__${key}=${value}`);
      expect(linkWorkflow).toContain(`-e JUNE__${key}=${value}`);
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
