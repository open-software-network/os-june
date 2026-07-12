import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { inspectDevAuth, readDevAuthPreflight } from "../../scripts/tauri-dev-preflight.mjs";

const tempDirs = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("Tauri dev auth preflight", () => {
  it("accepts matching local mode from both env files", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "june-dev-auth-"));
    tempDirs.push(rootDir);
    mkdirSync(join(rootDir, "june-api"));
    writeFileSync(join(rootDir, ".env"), "OS_JUNE_LOCAL_DEV=1\nOS_ACCOUNTS_CLIENT_ID=hidden\n");
    writeFileSync(join(rootDir, "june-api", ".env"), "JUNE__LOCAL_DEV__ENABLED=true\n");

    expect(readDevAuthPreflight(rootDir, {})).toBeUndefined();
  });

  it("prints allowlist guidance when both sides use real auth", () => {
    const guidance = inspectDevAuth({
      desktopEnv: { OS_JUNE_LOCAL_DEV: "0" },
      backendEnv: { JUNE__LOCAL_DEV__ENABLED: "false" },
    });

    expect(guidance).toContain("Allowlist this exact redirect URI");
    expect(guidance).toContain("OS_ACCOUNTS_CLIENT_ID");
  });

  it("rejects either local mode mismatch", () => {
    for (const [desktop, backend] of [
      ["1", "false"],
      ["0", "true"],
    ]) {
      expect(() =>
        inspectDevAuth({
          desktopEnv: { OS_JUNE_LOCAL_DEV: desktop },
          backendEnv: { JUNE__LOCAL_DEV__ENABLED: backend },
        }),
      ).toThrow("select different auth modes");
    }
  });

  it("uses the Rust default loopback port when none is configured", () => {
    const guidance = inspectDevAuth({});
    const zeroGuidance = inspectDevAuth({
      desktopEnv: { OS_ACCOUNTS_LOOPBACK_PORT: "0" },
    });

    expect(guidance).toContain("http://127.0.0.1:8765/callback");
    expect(zeroGuidance).toContain("http://127.0.0.1:8765/callback");
  });

  it("uses an explicit loopback port", () => {
    const guidance = inspectDevAuth({
      desktopEnv: { OS_ACCOUNTS_LOOPBACK_PORT: "4317" },
    });

    expect(guidance).toContain("http://127.0.0.1:4317/callback");
  });
});
