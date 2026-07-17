import { describe, expect, it } from "vitest";
import macBundler from "../../scripts/bundle-hermes-runtime.sh?raw";
import patchSmoke from "../../scripts/hermes-approval-patch-smoke.py?raw";
import windowsBundler from "../../scripts/bundle-hermes-runtime-windows.ps1?raw";
import patcher from "../../src-tauri/src/hermes/apply_june_patches.py?raw";
import bridge from "../../src-tauri/src/hermes_bridge.rs?raw";

describe("June Hermes approval patch", () => {
  it("seals upstream and patched hashes for every protocol file", () => {
    for (const path of ["tools/approval.py", "tools/mcp_tool.py", "tui_gateway/server.py"]) {
      const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      expect(patcher.match(new RegExp(`"${escaped}": "[a-f0-9]{64}"`, "g"))).toHaveLength(2);
    }
    expect(patcher).toContain('PATCH_SET = "june-approval-v2"');
    expect(patcher).toContain('upstream_request_id = getattr(context, "request_id", None)');
    expect(patcher).toContain("request_id=request_id");
    expect(patcher).toContain("_MAX_GATEWAY_APPROVALS_PER_SESSION = 32");
    expect(patcher).toContain("_MAX_GATEWAY_APPROVAL_ALIASES = 16");
    expect(patcher).toContain("_MAX_COMPLETED_GATEWAY_SESSIONS = 256");
    expect(patcher).toContain("class _GatewayNotify:");
    expect(patcher).toContain("def replace_gateway_notify(");
    expect(patcher).toContain("_gateway_notify_cbs.get(session_key) is not notify_cb");
    expect(patcher).toContain('entry.retired_reason = "transport_handoff"');
    expect(patcher).toContain('payload["retired_approval_request_ids"] = retired_request_ids');
    expect(patcher).toContain('if session.get("transport") is not transport:');
    expect(patcher).toContain("if _sessions.get(sid) is not session:");
    expect(patcher).toContain("tool_call_id = str(_approval_tool_call_id.get()");
    expect(patcher).toContain('if key := session.get("session_key")');
    expect(patcher).toContain('lambda data: _emit("approval.expire", sid, data)');
    expect(patcher).toContain('payload["pending_message_complete"] = pending_message_complete');
    expect(patcher).toContain(
      "def _deliver_message_complete(session: dict, sid: str, payload: dict)",
    );
    expect(patcher).toContain(
      "def _retry_pending_message_complete(\n    session: dict,\n    transport: Transport,\n    *,\n    wait_for_resume_response: bool = False,",
    );
    expect(patcher).toContain("_AUTONOMOUS_TURN_RESUME_BARRIER");
    expect(patcher).toContain("autonomous_turn_response_transport=resume_transport");
    expect(patcher).toContain("wait_for_resume_response=True");
    expect(patcher).toContain("_PENDING_MESSAGE_COMPLETE_PAYLOAD");
    expect(patcher).toContain("_clear_pending_message_complete(session)");
    expect(patcher).not.toContain("server pending-complete final cleanup");
    expect(patcher).toContain("assistant_texts[: len(previous_assistant_texts)]");
    expect(patcher).toContain("_deliver_message_complete(session, sid, payload)");
    expect(patchSmoke).toContain("# Resume wins:");
    expect(patchSmoke).toContain("# Emitter wins:");
    expect(patchSmoke).toContain("# A closed transport reports False");
    expect(patchSmoke).toContain("# A replacement can itself disappear before the retry");
    expect(patchSmoke).toContain("# An unchanged history with an identical final-response string");
  });

  it("applies the same patch and protocol smoke to macOS and Windows bundles", () => {
    for (const bundler of [macBundler, windowsBundler]) {
      expect(bundler).toContain("apply_june_patches.py");
      expect(bundler).toContain("hermes-approval-patch-smoke.py");
      expect(bundler).toContain("PATCHSET");
    }
  });

  it("pins managed installs to the patch set and verifies them before launch", () => {
    expect(bridge).toContain('const HERMES_RUNTIME_PATCH_SET: &str = "june-approval-v2"');
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
