import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { ensureClovyApiEnv } from "../../scripts/clovy-api-env-compat.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");

async function read(relativePath) {
  return readFile(join(root, relativePath), "utf8");
}

function workflowTriggerPaths(source, trigger) {
  const start = source.indexOf(`  ${trigger}:\n`);
  expect(start).toBeGreaterThan(-1);
  const remainder = source.slice(start + trigger.length + 4);
  const nextTrigger = remainder.search(
    /\n(?: {2}(?:pull_request|push|workflow_dispatch):|[A-Za-z][\w-]*:)(?:\n|$)/,
  );
  const block = nextTrigger === -1 ? remainder : remainder.slice(0, nextTrigger);
  return [...block.matchAll(/^\s{6}- "([^"]+)"$/gm)].map((match) => match[1]);
}

function shareSessionBridge(source, sessionStorage) {
  const start = source.indexOf('  var STATE_KEY = "clovy_share_state";');
  const end = source.indexOf("  // ── PKCE sign-in", start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const context = { sessionStorage };
  runInNewContext(
    `${source.slice(start, end)}\n` +
      "globalThis.bridge = { saveState, loadState, saveToken, loadToken, removeToken };",
    context,
  );
  return context.bridge;
}

function memorySessionStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem(key) {
      return values.get(key) ?? null;
    },
    removeItem(key) {
      values.delete(key);
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
    values,
  };
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
  it("prefers canonical Clovy API env configuration", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "clovy-api-env-"));
    try {
      await mkdir(join(tempRoot, "clovy-api"));
      await mkdir(join(tempRoot, "june-api"));
      await writeFile(join(tempRoot, "clovy-api", ".env"), "SOURCE=canonical\n");
      await writeFile(join(tempRoot, "june-api", ".env"), "SOURCE=legacy\n");

      expect(ensureClovyApiEnv(tempRoot).source).toBe("canonical");
      expect(await readFile(join(tempRoot, "clovy-api", ".env"), "utf8")).toBe(
        "SOURCE=canonical\n",
      );
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("migrates a legacy-only Clovy API env without exposing its contents", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "clovy-api-env-"));
    try {
      await mkdir(join(tempRoot, "clovy-api"));
      await mkdir(join(tempRoot, "june-api"));
      const legacyConfig = "CLOVY__UPSTREAMS__VENICE__API_KEY=secret-value\n";
      await writeFile(join(tempRoot, "june-api", ".env"), legacyConfig);

      expect(ensureClovyApiEnv(tempRoot)).toEqual({
        source: "legacy",
        path: join(tempRoot, "clovy-api", ".env"),
      });
      expect(await readFile(join(tempRoot, "clovy-api", ".env"), "utf8")).toBe(legacyConfig);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("leaves Clovy API env configuration absent when neither file exists", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "clovy-api-env-"));
    try {
      await mkdir(join(tempRoot, "clovy-api"));
      await mkdir(join(tempRoot, "june-api"));

      expect(ensureClovyApiEnv(tempRoot).source).toBe("none");
      await expect(readFile(join(tempRoot, "clovy-api", ".env"), "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("uses the canonical root Clovy API env in Conductor with a legacy fallback", async () => {
    const conductor = await read(".conductor/settings.toml");
    const canonicalEnv = "$CONDUCTOR_ROOT_PATH/clovy-api/.env";
    const legacyEnv = "$CONDUCTOR_ROOT_PATH/june-api/.env";

    expect(conductor.indexOf(canonicalEnv)).toBeGreaterThan(-1);
    expect(conductor.indexOf(legacyEnv)).toBeGreaterThan(conductor.indexOf(canonicalEnv));
    expect(conductor).toContain(
      `if [ ! -f \\"$api_env\\" ] && [ -f \\"${legacyEnv}\\" ]; then api_env=\\"${legacyEnv}\\"; fi`,
    );
    expect(conductor).toContain('ln -sf \\"$api_env\\" clovy-api/.env');
  });

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
    const [
      tauri,
      macos,
      macosInfoPlist,
      macosLocalizedInfoPlist,
      windows,
      desktopCargo,
      bundleShim,
    ] = await Promise.all([
      read("src-tauri/tauri.conf.json").then(JSON.parse),
      read("src-tauri/tauri.macos.conf.json").then(JSON.parse),
      read("src-tauri/Info.plist"),
      read("src-tauri/resources/macos/en.lproj/InfoPlist.strings"),
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
    expect(macosInfoPlist).toContain("<key>CFBundleDisplayName</key>\n  <string>June</string>");
    expect(macosInfoPlist).toContain("<key>LSHasLocalizedDisplayName</key>\n  <true/>");
    expect(macosLocalizedInfoPlist).toContain('CFBundleDisplayName = "Clovy";');
    expect(macosLocalizedInfoPlist).toContain('CFBundleName = "Clovy";');
    expect(macos.bundle.resources["resources/macos/en.lproj/InfoPlist.strings"]).toBe(
      "en.lproj/InfoPlist.strings",
    );
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

  it("uses canonical Clovy names for private runtime and Windows helper concepts", async () => {
    const [
      helperProtocol,
      dictation,
      computerUse,
      computerUseDriver,
      computerUseCursor,
      computerUseSelfTest,
      systemWindows,
      managedBrowser,
      agentNotifications,
      shutdown,
      soundsDemo,
      releaseAge,
    ] = await Promise.all([
      read("src-tauri/native/windows-dictation-helper/src/protocol.rs"),
      read("src-tauri/src/dictation.rs"),
      read("src-tauri/src/computer_use.rs"),
      read("src-tauri/src/computer_use_driver.rs"),
      read("src-tauri/src/computer_use_cursor.rs"),
      read("scripts/computer-use-self-test.mjs"),
      read("src-tauri/src/audio/system_windows.rs"),
      read("src-tauri/src/browser/managed.rs"),
      read("src/lib/agent-notifications.ts"),
      read("src-tauri/src/shutdown.rs"),
      read("src/lib/clovy-sounds-demo.ts"),
      read("scripts/check-pnpm-release-age.py"),
    ]);

    expect(helperProtocol).toContain("pub clovy_process_id");
    expect(helperProtocol).toContain("pub clovy_window_handle");
    expect(helperProtocol).toContain('rename = "juneProcessId"');
    expect(helperProtocol).toContain('rename = "juneWindowHandle"');
    for (const field of [
      '"clovyProcessId"',
      '"clovyWindowHandle"',
      '"juneProcessId"',
      '"juneWindowHandle"',
    ]) {
      expect(dictation).toContain(field);
    }
    expect(computerUse).toContain('format!("clovy-cua-{}", random_id())');
    expect(computerUse).not.toContain('format!("june-cua-{}", random_id())');
    for (const source of [computerUse, computerUseDriver]) {
      expect(source).toContain("clovyComputerUseCapability");
      expect(source).toContain("juneComputerUseCapability");
    }
    expect(computerUseSelfTest).toContain("co.opensoftware.clovy.computer-use-self-test.${role}");
    expect(computerUseSelfTest).not.toContain(
      "co.opensoftware.june.computer-use-self-test.${role}",
    );
    expect(computerUseDriver).toContain("clovy-helper-child-reaper");
    expect(computerUseDriver).not.toContain("june-helper-child-reaper");
    for (const source of [computerUseDriver, computerUseCursor]) {
      expect(source).toContain('"clovy/pointer"');
      expect(source).not.toContain('"june/pointer"');
    }
    expect(systemWindows).toContain("clovy-windows-system-audio");
    expect(systemWindows).not.toContain("june-windows-system-audio");
    for (const suffix of ["Epoch", "Observer", "State"]) {
      expect(managedBrowser).toContain(`__clovySnapshot${suffix}`);
      expect(managedBrowser).not.toContain(`__juneSnapshot${suffix}`);
    }
    expect(managedBrowser).toContain("__clovyMutationVersion");
    expect(managedBrowser).not.toContain("__juneMutationVersion");
    expect(agentNotifications).toContain("__clovyAgentNotificationTimes");
    expect(agentNotifications).not.toContain("__juneAgentNotificationTimes");
    expect(shutdown).toContain('name("clovy-shutdown-supervisor".to_string())');
    expect(shutdown).toContain('name("clovy-child-reaper".to_string())');
    expect(shutdown).not.toContain('name("june-shutdown-');
    expect(shutdown).not.toContain('name("june-child-reaper"');
    expect(soundsDemo).toContain("__clovySounds");
    expect(soundsDemo).not.toContain("__juneSounds");
    expect(releaseAge).toContain("clovy-pnpm-release-age-check");
    expect(releaseAge).not.toContain("os-june-pnpm-release-age-check");
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
      shareViewer,
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
      read("clovy-api/crates/api/src/handlers/share_viewer_page.js"),
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
    for (const key of ["state", "token"]) {
      expect(shareViewer).toContain(`clovy_share_${key}`);
      expect(shareViewer).toContain(`june_share_${key}`);
    }
    expect(shareViewer).toContain("sessionStorage.setItem(LEGACY_STATE_KEY, serialized)");
    expect(shareViewer).toContain("sessionStorage.setItem(STATE_KEY, serialized)");
    expect(shareViewer).toContain("sessionStorage.setItem(LEGACY_TOKEN_KEY, token)");
    expect(shareViewer).toContain("sessionStorage.setItem(TOKEN_KEY, token)");
    expect(shareViewer).toContain("sessionStorage.removeItem(LEGACY_TOKEN_KEY)");
    expect(shareViewer).toContain("sessionStorage.removeItem(TOKEN_KEY)");
  });

  it("reconciles share-viewer state and tokens across deploy and rollback", async () => {
    const source = await read("clovy-api/crates/api/src/handlers/share_viewer_page.js");
    const legacyState = JSON.stringify({
      csrf: "callback-csrf",
      verifier: "verifier",
      returnPath: "/s/shr_1",
      fragment: "invite.key",
    });
    const storage = memorySessionStorage({
      clovy_share_state: JSON.stringify({ csrf: "stale-csrf" }),
      june_share_state: legacyState,
      june_share_token: "legacy-token",
    });
    const bridge = shareSessionBridge(source, storage);

    expect(JSON.stringify(bridge.loadState("callback-csrf"))).toBe(legacyState);
    expect(storage.values.get("clovy_share_state")).toBe(legacyState);
    expect(storage.values.get("june_share_state")).toBe(legacyState);
    expect(bridge.loadToken()).toBe("legacy-token");
    expect(storage.values.get("clovy_share_token")).toBe("legacy-token");
    expect(storage.values.get("june_share_token")).toBe("legacy-token");

    bridge.saveToken("clovy-token");
    expect(storage.values.get("clovy_share_token")).toBe("clovy-token");
    expect(storage.values.get("june_share_token")).toBe("clovy-token");
    bridge.removeToken();
    expect(storage.values.has("clovy_share_token")).toBe(false);
    expect(storage.values.has("june_share_token")).toBe(false);

    const canonicalOnlyStorage = memorySessionStorage({
      clovy_share_token: "deleted-by-rollback",
    });
    const canonicalOnlyBridge = shareSessionBridge(source, canonicalOnlyStorage);
    expect(canonicalOnlyBridge.loadToken()).toBe("");
    expect(canonicalOnlyStorage.values.has("clovy_share_token")).toBe(false);
    expect(canonicalOnlyStorage.values.has("june_share_token")).toBe(false);
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
      makefile,
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
      read("Makefile"),
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
    expect(beforeDev).toContain("ensureClovyApiEnv(rootDir)");
    expect(runApi).toContain("${CLOVY_API_PORT:-${JUNE_API_PORT:-8080}}");
    expect(runApi).toContain('node "$ROOT_DIR/scripts/clovy-api-env-compat.mjs"');
    expect(runApi.indexOf("clovy-api-env-compat.mjs")).toBeLessThan(
      runApi.indexOf("exec cargo run -p clovy-api-server -- serve"),
    );
    const ephemeralEnvBridge = ephemeralApi.indexOf("node scripts/clovy-api-env-compat.mjs");
    expect(ephemeralEnvBridge).toBeGreaterThan(-1);
    expect(ephemeralEnvBridge).toBeLessThan(
      ephemeralApi.indexOf('[[ -f "$API_ENV_FILE" ]] || die'),
    );
    expect(makefile).toMatch(
      /^dev-api:.*\n\tnode scripts\/clovy-api-env-compat\.mjs\n\tcd clovy-api/m,
    );
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

  it("passes legacy API URL fallbacks through distributable build steps", async () => {
    const workflows = await Promise.all(
      [
        [".github/workflows/staging-desktop-dmg.yml", "STAGING"],
        [".github/workflows/rc-desktop-dmg.yml", "PRODUCTION"],
        [".github/workflows/promote-desktop.yml", "PRODUCTION"],
        [".github/workflows/production-desktop-windows.yml", "PRODUCTION"],
      ].map(async ([path, environment]) => [await read(path), environment]),
    );

    for (const [workflow, environment] of workflows) {
      const fallback = `\${{ secrets.${environment}_CLOVY_API_URL || secrets.${environment}_JUNE_API_URL }}`;
      expect(workflow).toContain(`${environment}_CLOVY_API_URL: ${fallback}`);
      expect(workflow).toContain(`CLOVY_API_URL: ${fallback}`);
    }
  });

  it("builds historical desktop releases through the agent runtime identity bridge", async () => {
    const [macPromotion, windowsProduction] = await Promise.all([
      read(".github/workflows/promote-desktop.yml"),
      read(".github/workflows/production-desktop-windows.yml"),
    ]);

    for (const legacyVariable of ["JUNE_AGENT_RUNTIME_TARGET", "JUNE_AGENT_RUNTIME_PREBUILT"]) {
      expect(macPromotion).toContain(legacyVariable);
      expect(windowsProduction).toContain(legacyVariable);
    }
    for (const legacyVariable of ["JUNE_AGENT_RUNTIME_NODE_ARM64", "JUNE_AGENT_RUNTIME_NODE_X64"]) {
      expect(macPromotion).toContain(legacyVariable);
    }

    expect(macPromotion).toContain(".tauri-agent-runtime/clovy-agent-runtime");
    expect(macPromotion).toContain(".tauri-agent-runtime/june-agent-runtime");
    expect(macPromotion).toContain("Canonical and legacy agent runtime outputs differ.");
    expect(macPromotion).toContain("Canonical and legacy packaged agent runtimes differ.");
    expect(macPromotion).toContain('test "$(shasum -a 256 "$runtime"');
    expect(macPromotion).toContain('codesign --verify --strict --verbose=2 "$runtime"');
    expect(macPromotion).toContain(
      'node scripts/build-agent-runtime.mjs --smoke "$smoke_dir/clovy-agent-runtime" --smoke-arch arm64',
    );

    expect(windowsProduction).toContain(".tauri-agent-runtime/clovy-agent-runtime.exe");
    expect(windowsProduction).toContain(".tauri-agent-runtime/june-agent-runtime.exe");
    expect(windowsProduction).toContain("Canonical and legacy agent runtime outputs differ.");
    expect(windowsProduction).toContain("Get-AuthenticodeSignature -FilePath $runtime.FullName");
    expect(windowsProduction).toContain('Set-Content -LiteralPath "$($runtime.FullName).sha256"');
    expect(windowsProduction).toContain(
      "node scripts/build-agent-runtime.mjs --smoke $smokeRuntime",
    );
    expect(windowsProduction).toContain('$legacyRuntime = "native/bin/june-agent-runtime.exe"');
    expect(windowsProduction).toContain("function Test-ArchivePath([string]$path)");
    expect(windowsProduction).toContain('"(?m)(?:^|\\s)$escapedPath(?:\\s|$)"');
    expect(windowsProduction).toContain(
      "$hasCanonicalRuntime = Test-ArchivePath $canonicalRuntime",
    );
    expect(windowsProduction).toContain("$hasLegacyRuntime = Test-ArchivePath $legacyRuntime");
    expect(windowsProduction).not.toContain(
      "$listingText -match [regex]::Escape($canonicalRuntime)",
    );
    expect(windowsProduction).not.toContain("$listingText -match [regex]::Escape($legacyRuntime)");
    expect(windowsProduction).toContain(
      'foreach ($expected in @($packagedRuntime, "$packagedRuntime.sha256"',
    );
    expect(windowsProduction).toContain("if (!(Test-ArchivePath $expected))");
  });

  it("runs Clovy API checks when the canonical companion protocol changes", async () => {
    const [apiChecks, apiBuild] = await Promise.all([
      read(".github/workflows/clovy-api.yml"),
      read(".github/workflows/build-clovy-api.yml"),
    ]);
    const apiCheckPaths = [
      "clovy-api/**",
      "crates/clovy-companion-protocol/**",
      ".github/workflows/clovy-api.yml",
      ".github/actions/setup-rust/**",
    ];

    expect(workflowTriggerPaths(apiChecks, "pull_request")).toEqual(apiCheckPaths);
    expect(workflowTriggerPaths(apiChecks, "push")).toEqual(apiCheckPaths);
    expect(workflowTriggerPaths(apiBuild, "push")).toEqual([
      "clovy-api/**",
      "crates/clovy-companion-protocol/**",
      ".github/actions/phala-deploy/**",
      ".github/workflows/build-clovy-api.yml",
    ]);
  });

  it("preserves released API and C ABI contracts while publishing canonical aliases", async () => {
    const [
      desktopApi,
      canonicalHeader,
      canonicalCompatibilityHeader,
      oldPathCompatibilityHeader,
      cryptoSource,
      apiBuild,
      apiPromotion,
    ] = await Promise.all([
      read("src-tauri/src/clovy_api.rs"),
      read("crates/clovy-companion-crypto/include/clovy_companion_crypto.h"),
      read("crates/clovy-companion-crypto/include/june_companion_crypto.h"),
      read("crates/june-companion-crypto/include/june_companion_crypto.h"),
      read("crates/clovy-companion-crypto/src/lib.rs"),
      read(".github/workflows/build-clovy-api.yml"),
      read(".github/workflows/promote-clovy-api.yml"),
    ]);

    expect(desktopApi).toContain('"https://june-api.opensoftware.co"');
    expect(desktopApi).toContain('b"june-api-operation-id-v1\\0"');
    expect(desktopApi).toContain('format!("june-op-');
    expect(canonicalHeader).toContain("clovy_crypto_generate_identity");
    expect(canonicalCompatibilityHeader).toContain("june_crypto_generate_identity");
    expect(oldPathCompatibilityHeader).toContain("june_crypto_generate_identity");
    expect(oldPathCompatibilityHeader).toBe(canonicalCompatibilityHeader);
    expect(cryptoSource).toContain('pub unsafe extern "C" fn clovy_crypto_generate_identity');
    expect(cryptoSource).toContain('pub unsafe extern "C" fn june_crypto_generate_identity');
    for (const workflow of [apiBuild, apiPromotion]) {
      expect(workflow).toContain("/clovy-api");
      expect(workflow).toContain("/june-api");
    }
  });

  it("uses Clovy for newly written runtime state and private source concepts", async () => {
    const [
      sdkEngine,
      notifications,
      routines,
      computerUseDriver,
      meetingDetection,
      obsidian,
      desktopApi,
      apiMain,
      apiConfig,
      driverContract,
      noteDrag,
    ] = await Promise.all([
      read("agent-runtime/src/sdk-engine.ts"),
      read("src-tauri/src/notifications.rs"),
      read("src-tauri/src/routines.rs"),
      read("src-tauri/src/computer_use_driver.rs"),
      read("src-tauri/src/meeting_detection.rs"),
      read("src-tauri/src/obsidian.rs"),
      read("src-tauri/src/clovy_api.rs"),
      read("clovy-api/crates/app/src/main.rs"),
      read("clovy-api/crates/config/src/lib.rs"),
      read("src-tauri/cua-driver-contract.json").then(JSON.parse),
      read("src/lib/dnd.ts"),
    ]);

    expect(sdkEngine).toContain("clovyVersion: SERIALIZED_STATE_ENVELOPE_VERSION");
    expect(sdkEngine).toContain("juneVersion: SERIALIZED_STATE_ENVELOPE_VERSION");
    expect(notifications).toContain('const SESSION_ID_KEY: &str = "clovyAgentSessionId"');
    expect(notifications).toContain('const LEGACY_SESSION_ID_KEY: &str = "juneAgentSessionId"');
    expect(routines).toContain('format!("clovy_browser_routine_{}"');
    expect(routines).not.toContain('format!("june_browser_routine_{}"');
    expect(computerUseDriver).toContain("fn parent_is_clovy()");
    expect(computerUseDriver).toContain("fn process_is_clovy(");
    expect(computerUseDriver).not.toContain("fn parent_is_june()");
    expect(computerUseDriver).not.toContain("fn process_is_june(");
    expect(meetingDetection).toContain("clovy_capture_active: bool");
    expect(meetingDetection).not.toContain("os_june_capture_active: bool");
    expect(obsidian).toContain(".clovy-obsidian-write-probe-");
    expect(obsidian).not.toContain(".june-obsidian-write-probe-");
    expect(desktopApi).toContain("Clovy API returned an invalid response stream error");
    expect(desktopApi).toContain('user_agent(concat!("clovy/"');
    expect(desktopApi).not.toContain('user_agent(concat!("os-june/"');
    expect(apiMain).not.toContain('"june=info,clovy_api=info');
    expect(apiConfig).toContain("viewer@localdev.clovy");
    expect(apiConfig).not.toContain("viewer@localdev.june");
    expect(driverContract.clovyActions).toBeInstanceOf(Array);
    expect(driverContract).not.toHaveProperty("juneActions");
    expect(noteDrag).toContain('NOTE_DND_MIME = "application/x-clovy-note-id"');
    expect(noteDrag).toContain('LEGACY_NOTE_DND_MIME = "application/x-june-note-id"');
  });

  it("publishes the Obsidian skill under Clovy with a rollback-safe June alias", async () => {
    const [bundledSkill, skillIdentity, agentApi] = await Promise.all([
      read("src-tauri/resources/agent-skills/clovy-obsidian/SKILL.md"),
      read("src-tauri/src/agent_runtime/skill_identity.rs"),
      read("src-tauri/src/agent_runtime/api.rs"),
    ]);

    expect(bundledSkill).toMatch(/^name: clovy-obsidian$/m);
    expect(skillIdentity).toContain('pub const CLOVY_OBSIDIAN_SKILL_ID: &str = "clovy-obsidian"');
    expect(skillIdentity).toContain('pub const LEGACY_OBSIDIAN_SKILL_ID: &str = "june-obsidian"');
    expect(skillIdentity).toContain("write_skill_ids");
    expect(agentApi).toContain("When the clovy-obsidian skill is available");
    expect(agentApi).not.toContain("When the june-obsidian skill is available");
  });

  it("uses Clovy for ephemeral build and dictation artifacts", async () => {
    const [
      signedDmg,
      rcWorkflow,
      promotionWorkflow,
      tauri,
      macHelper,
      windowsHelper,
      dictation,
      computerUseFixture,
      computerUseDocs,
      reproducibleBuilds,
      index,
      onboardingPreview,
      styleguide,
    ] = await Promise.all([
      read("scripts/build-signed-dmg.sh"),
      read(".github/workflows/rc-desktop-dmg.yml"),
      read(".github/workflows/promote-desktop.yml"),
      read("src-tauri/tauri.conf.json").then(JSON.parse),
      read("src-tauri/native/mac-dictation-helper/main.swift"),
      read("src-tauri/native/windows-dictation-helper/src/audio.rs"),
      read("src-tauri/src/dictation.rs"),
      read("src-tauri/native/computer-use-fixture/main.swift"),
      read("docs/computer-use-support.md"),
      read("docs/reproducible-builds.md"),
      read("index.html"),
      read("onboarding-preview.html"),
      read("styleguide.html"),
    ]);

    for (const source of [signedDmg, rcWorkflow, promotionWorkflow]) {
      expect(source).toContain("clovy-signing.keychain-db");
      expect(source).not.toContain("os-june-signing.keychain-db");
    }
    expect(tauri.app.security.assetProtocol.scope).toEqual([
      "$TEMP/clovy-dictation-*.m4a",
      "$TEMP/clovy-dictation-*.wav",
      "$TEMP/os-june-dictation-*.m4a",
      "$TEMP/os-june-dictation-*.wav",
    ]);
    expect(macHelper).toContain('appendingPathComponent("clovy-dictation-');
    expect(windowsHelper).toContain('.prefix("clovy-dictation-")');
    expect(dictation).toContain('format!("clovy-dictation-{utterance_id}-normalized.wav")');
    expect(computerUseFixture).toContain('"clovy-cu-observer-window"');
    expect(computerUseFixture).not.toContain('"june-cu-observer-window"');
    expect(computerUseDocs).toContain("`target/**/Clovy JUN-278 Codex`");
    expect(reproducibleBuilds).toContain("the `clovy-api` binary");
    expect(index.indexOf('localStorage.getItem("os-clovy:theme")')).toBeLessThan(
      index.indexOf('localStorage.getItem("os-june:theme")'),
    );
    expect(onboardingPreview).toContain("clovy.replayOnboarding()");
    expect(onboardingPreview).toContain("window.__CLOVY_STUB__");
    expect(styleguide).toContain("else os-clovy:theme / system");
  });

  it("keeps legacy ephemeral CVM state recoverable and ignored", async () => {
    const [gitignore, ephemeralApi] = await Promise.all([
      read(".gitignore"),
      read("scripts/ephemeral-clovy-api.sh"),
    ]);

    expect(gitignore).toContain(".ephemeral-clovy-api.json*");
    expect(gitignore).toContain(".ephemeral-june-api.json*");
    expect(ephemeralApi).toContain('LEGACY_STATE_FILE=".ephemeral-june-api.json"');
    expect(ephemeralApi).toContain('ln "$LEGACY_STATE_FILE" "$STATE_FILE"');
    expect(ephemeralApi).toContain('rm -f "$LEGACY_STATE_FILE"');
    expect(ephemeralApi.indexOf("migrate_legacy_state_file\n\ncase")).toBeGreaterThan(-1);
    expect(ephemeralApi).toContain("until both recorded CVMs are torn down.");
    expect(ephemeralApi.match(/down_remaining_legacy_state/g)).toHaveLength(3);
  });
});
