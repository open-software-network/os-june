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
    expect(patcher).toContain('PATCH_SET = "june-approval-memory-v6"');
    for (const provenanceSource of [
      bridge,
      compatibilityMatrix,
      gatewayGotchas,
      pinNote,
      upgradeChecklist,
    ]) {
      expect(provenanceSource).toContain("june-approval-memory-v6");
    }
    expect(patcher).toContain("session, err = _sess_nowait(params, rid)");
    expect(patcher).toContain('upstream_request_id = getattr(context, "request_id", None)');
    expect(patcher).toContain("request_id=request_id");
    expect(patcher).toContain("_MAX_GATEWAY_APPROVALS_PER_SESSION = 32");
    expect(patcher).toContain("_MAX_GATEWAY_APPROVAL_ALIASES = 16");
    expect(patcher).toContain("_MAX_COMPLETED_GATEWAY_SESSIONS = 256");
    expect(patcher).toContain("tool_call_id = str(_approval_tool_call_id.get()");
    expect(patcher).toContain('if key := session.get("session_key")');
    expect(patcher).toContain('lambda data: _emit("approval.expire", sid, data)');
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
    expect(bridge).toContain('const HERMES_RUNTIME_PATCH_SET: &str = "june-approval-memory-v6"');
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
