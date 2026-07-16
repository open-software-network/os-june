import { describe, expect, it } from "vitest";
import macBundler from "../../scripts/bundle-hermes-runtime.sh?raw";
import windowsBundler from "../../scripts/bundle-hermes-runtime-windows.ps1?raw";
import patcher from "../../src-tauri/src/hermes/apply_june_patches.py?raw";
import bridge from "../../src-tauri/src/hermes_bridge.rs?raw";

describe("June Hermes approval patch", () => {
  it("seals upstream and patched hashes for every protocol file", () => {
    for (const path of ["tools/approval.py", "tools/mcp_tool.py", "tui_gateway/server.py"]) {
      const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      expect(patcher.match(new RegExp(`"${escaped}": "[a-f0-9]{64}"`, "g"))).toHaveLength(2);
    }
    expect(patcher).toContain('PATCH_SET = "june-approval-v1"');
    expect(patcher).toContain('upstream_request_id = getattr(context, "request_id", None)');
    expect(patcher).toContain("request_id=request_id");
    expect(patcher).toContain("_MAX_GATEWAY_APPROVALS_PER_SESSION = 32");
    expect(patcher).toContain("_MAX_GATEWAY_APPROVAL_ALIASES = 16");
    expect(patcher).toContain("_MAX_COMPLETED_GATEWAY_SESSIONS = 256");
    expect(patcher).toContain("tool_call_id = str(_approval_tool_call_id.get()");
    expect(patcher).toContain('if key := session.get("session_key")');
    expect(patcher).toContain('lambda data: _emit("approval.expire", sid, data)');
  });

  it("applies the same patch and protocol smoke to macOS and Windows bundles", () => {
    for (const bundler of [macBundler, windowsBundler]) {
      expect(bundler).toContain("apply_june_patches.py");
      expect(bundler).toContain("hermes-approval-patch-smoke.py");
      expect(bundler).toContain("PATCHSET");
    }
  });

  it("pins managed installs to the patch set and verifies them before launch", () => {
    expect(bridge).toContain('const HERMES_RUNTIME_PATCH_SET: &str = "june-approval-v1"');
    expect(bridge).toContain('include_str!("hermes/apply_june_patches.py")');
    expect(bridge).toContain("verify_managed_hermes_runtime_patch(&managed_install_dir)?");
    const patchedHashes = patcher
      .match(/PATCHED_SHA256: Dict\[str, str\] = \{([\s\S]*?)\n\}/)?.[1]
      ?.matchAll(/"([^"]+)": "([a-f0-9]{64})"/g);
    expect(patchedHashes).toBeDefined();
    for (const [, path, hash] of patchedHashes ?? []) {
      expect(bridge).toContain(`"${path}",`);
      expect(bridge).toContain(`"${hash}"`);
    }
    expect(bridge).toContain("verify_hermes_runtime_source_hashes");
    expect(bridge).not.toContain('.arg("--verify")\n        .stdin(Stdio::null())');
    expect(bridge).toContain('.env("JUNE_HERMES_PATCH_SET", HERMES_RUNTIME_PATCH_SET)');
    expect(bridge).toContain('r#""patchSet":"{HERMES_RUNTIME_PATCH_SET}""#');
    expect(bridge).not.toContain("UserLocalFallback");
    expect(bridge).not.toContain("PathFallback");
    expect(bridge).not.toContain("user_local_hermes_command");
  });
});
