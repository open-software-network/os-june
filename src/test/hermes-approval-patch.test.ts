import { describe, expect, it } from "vitest";
import gatewayGotchas from "../../docs/hermes-gateway-gotchas.md?raw";
import pinNote from "../../docs/hermes-upstream-v2026.6.19.md?raw";
import upgradeChecklist from "../../docs/hermes-upgrade-checklist.md?raw";
import macBundler from "../../scripts/bundle-hermes-runtime.sh?raw";
import windowsBundler from "../../scripts/bundle-hermes-runtime-windows.ps1?raw";
import commands from "../../src-tauri/src/commands.rs?raw";
import patcher from "../../src-tauri/src/hermes/apply_june_patches.py?raw";
import bridge from "../../src-tauri/src/hermes_bridge.rs?raw";
import compatibilityMatrix from "../lib/hermes-control-plane/compatibility/matrix.ts?raw";
import routines from "../lib/hermes-routines.ts?raw";
import protocolSmoke from "../../scripts/hermes-approval-patch-smoke.py?raw";

describe("June Hermes compatibility patch", () => {
  it("seals upstream and patched hashes for every protocol file", () => {
    for (const path of [
      "agent/agent_init.py",
      "tools/approval.py",
      "tools/mcp_tool.py",
      "tui_gateway/server.py",
      "utils.py",
      "gateway/platforms/telegram.py",
    ]) {
      const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      expect(patcher.match(new RegExp(`"${escaped}": "[a-f0-9]{64}"`, "g"))).toHaveLength(2);
    }
    for (const path of ["cron/scheduler.py", "model_tools.py"]) {
      const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      expect(patcher.match(new RegExp(`"${escaped}": "[a-f0-9]{64}"`, "g"))).toHaveLength(1);
      expect(bridge).toContain(`"${path}",`);
    }
    expect(patcher).toContain('PATCH_SET = "june-approval-memory-v14"');
    for (const provenanceSource of [
      bridge,
      compatibilityMatrix,
      gatewayGotchas,
      pinNote,
      upgradeChecklist,
    ]) {
      expect(provenanceSource).toContain("june-approval-memory-v14");
    }
    expect(patcher).toContain("session, err = _sess_nowait(params, rid)");
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
      "def _retry_pending_message_complete_locked(\n    session: dict,\n    transport: Transport,\n    *,\n    snapshot_ack_token: object | None = None,",
    );
    expect(patcher).toContain("_AGENT_RUN_CONTINUATION_SNAPSHOT_ACK_BARRIER");
    expect(patcher).toContain("_LIVE_SNAPSHOT_ACK_TOKEN_RESULT");
    expect(patcher).toContain("def _handoff_live_session_transport(");
    expect(patcher).toContain("agent_run_continuation_snapshot_ack_transport=transport");
    expect(patcher).toContain("snapshot_ack_token=snapshot_ack_token");
    expect(patcher).toContain("_bind_prompt_transport_for_submit(session, request_transport)");
    expect(patcher).toContain("_ORDERED_SESSION_OWNERSHIP_HANDLERS");
    expect(patcher).toContain('if method == "prompt.submit":');
    expect(patcher).toContain("dispatched.result()");
    expect(patcher).toContain('or session.get("transport") is not request_transport');
    expect(patcher).toContain("if _transport_is_dead(resume_transport):");
    expect(patcher).toContain("with _session_resume_lock:");
    expect(patcher).toContain('if method in {"session.activate", "session.resume"}:');
    expect(patcher).toContain("if snapshot_ack_delivered and snapshot_ack_token is not None:");
    expect(patcher).toContain("_PENDING_MESSAGE_COMPLETE_PAYLOAD");
    expect(patcher).toContain("_clear_pending_message_complete(session)");
    expect(patcher).not.toContain("server pending-complete final cleanup");
    expect(patcher).toContain("assistant_texts[: len(previous_assistant_texts)]");
    expect(patcher).toContain("_deliver_message_complete(session, sid, payload)");
    expect(protocolSmoke).toContain("# Resume wins:");
    expect(protocolSmoke).toContain("# Emitter wins:");
    expect(protocolSmoke).toContain("# A closed transport reports False");
    expect(protocolSmoke).toContain("# A replacement can itself disappear before the retry");
    expect(protocolSmoke).toContain(
      "# An unchanged history with an identical final-response string",
    );
    expect(patcher).toContain('disabled_toolsets=agent_cfg.get("disabled_toolsets") or [],');
    expect(patcher).toContain('"disabled_toolsets": (cfg.get("agent") or {}).get');
    expect(patcher).toContain('user_disabled = agent_cfg.get("disabled_toolsets") or []');
    expect(patcher).toContain("tools_to_include.difference_update(resolved)");
    expect(protocolSmoke).toContain("verify_patch_state_machine");
    expect(protocolSmoke).toContain("verify_new_session_image_attach_is_immediate");
    expect(protocolSmoke).toContain("verify_tui_memory_deny_propagation");
    expect(protocolSmoke).toContain("verify_cross_process_config_writer");
    expect(protocolSmoke).toContain("verify_model_deny_wins");
    expect(protocolSmoke).toContain("tampered Hermes source passed sealed patch verification");
  });

  it("applies the same patch and protocol smoke to macOS and Windows bundles", () => {
    for (const bundler of [macBundler, windowsBundler]) {
      expect(bundler).toContain("apply_june_patches.py");
      expect(bundler).toContain("hermes-approval-patch-smoke.py");
      expect(bundler).toContain("--upstream-root");
      expect(bundler).toContain("PATCHSET");
      expect(bundler).toContain("--verify");
    }
  });

  it("pins managed installs to the patch set and verifies them before launch", () => {
    expect(bridge).toContain('const HERMES_RUNTIME_PATCH_SET: &str = "june-approval-memory-v14"');
    expect(bridge).not.toContain('const HERMES_RUNTIME_PATCH_SET: &str = "june-approval-v2"');
    expect(bridge).not.toContain(
      'const HERMES_RUNTIME_PATCH_SET: &str = "june-approval-memory-v2"',
    );
    expect(bridge).toContain('include_str!("hermes/apply_june_patches.py")');
    expect(bridge).toContain("verify_managed_hermes_runtime_patch(&managed_install_dir)?");
    for (const mapName of ["PATCHED_SHA256", "POLICY_SHA256"]) {
      const hashes = patcher
        .match(new RegExp(`${mapName}: Dict\\[str, str\\] = \\{([\\s\\S]*?)\\n\\}`))?.[1]
        ?.matchAll(/"([^"]+)": "([a-f0-9]{64})"/g);
      expect(hashes).toBeDefined();
      for (const [, path, hash] of hashes ?? []) {
        expect(bridge).toContain(`"${path}",`);
        expect(bridge).toContain(`"${hash}"`);
        expect(pinNote).toContain(`| \`${path}\``);
        expect(pinNote).toContain(`\`${hash}\``);
      }
    }
    expect(bridge).toContain("verify_hermes_runtime_source_hashes");
    expect(bridge).not.toContain('.arg("--verify")\n        .stdin(Stdio::null())');
    expect(bridge).toContain('.env("JUNE_HERMES_PATCH_SET", HERMES_RUNTIME_PATCH_SET)');
    expect(bridge).toContain('r#""patchSet":"{HERMES_RUNTIME_PATCH_SET}""#');
    expect(bridge).not.toContain("UserLocalFallback");
    expect(bridge).not.toContain("PathFallback");
    expect(bridge).not.toContain("user_local_hermes_command");
  });

  it("updates the shared denylist before relying on live runtime reapply", () => {
    const directUpdate = commands.indexOf("apply_memory_runtime_policy");
    const liveReapply = commands.indexOf("reapply_hermes_runtime", directUpdate);
    expect(directUpdate).toBeGreaterThan(-1);
    expect(liveReapply).toBeGreaterThan(directUpdate);
    expect(bridge).toContain("update_hermes_memory_policy_file");
    expect(bridge).toContain("HERMES_CONFIG_CORRUPT_BACKUP_PREFIX");
    expect(bridge).toContain("write_hermes_config_atomic");
    expect(bridge).toContain("MoveFileExW");
    expect(bridge).toContain("MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH");
    expect(bridge).toContain("apply_persisted_memory_policy_file");
    expect(bridge).toContain("hermes_request_may_write");
    expect(commands).toContain("if let Some(error) = direct_error");
    expect(commands).toContain("if let Some(error) = reapply_error");
  });

  it("retains the earlier cron and routine composition defenses", () => {
    expect(bridge).toContain("cron_platform_toolsets");
    expect(bridge).toContain('.filter(|toolset| memory_enabled || **toolset != "memory")');
    expect(routines).toContain("stripNativeMemoryIfDisabled");
    expect(routines).toContain("await stripNativeMemoryIfDisabled(UNRESTRICTED_ROUTINE_TOOLSETS)");
  });
});
