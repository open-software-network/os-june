import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const buildScript = readFileSync("scripts/build-agent-runtime.mjs", "utf8");
const entitlements = readFileSync("src-tauri/AgentRuntimeEntitlements.plist", "utf8");

describe("agent runtime macOS signing", () => {
  it("grants only the executable-memory exceptions required by Node V8", () => {
    expect(entitlements).toContain("com.apple.security.cs.allow-jit");
    expect(entitlements).toContain("com.apple.security.cs.allow-unsigned-executable-memory");
    expect(entitlements).not.toContain("com.apple.security.cs.disable-executable-page-protection");
    expect(entitlements).not.toContain("com.apple.security.cs.disable-library-validation");
  });

  it("applies and verifies the runtime entitlements during hardened signing", () => {
    expect(buildScript).toContain('"--options",\n    "runtime",');
    expect(buildScript).toContain('"--entitlements",\n    macRuntimeEntitlements,');
    expect(buildScript).toContain("verifyMacRuntimeEntitlements(executable)");
  });
});
