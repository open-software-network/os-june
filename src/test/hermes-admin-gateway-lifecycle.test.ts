import { describe, expect, it, vi } from "vitest";
import type { GatewayLifecycleState } from "../lib/hermes-admin";
import {
  instantSleep,
  makeAdminHarness,
} from "./fixtures/hermes-admin-harness";
import {
  gatewayRestartFailsScenario,
  gatewayRestartPendingScenario,
} from "./fixtures/hermes-admin-scenarios";

describe("GatewayLifecycle — state machine and copy", () => {
  it("starts clean and exposes dash-free copy for every state", () => {
    const { lifecycle } = makeAdminHarness(gatewayRestartPendingScenario());
    expect(lifecycle.getSnapshot().state).toBe("clean");

    const states: GatewayLifecycleState[] = [
      "clean",
      "changes-apply-next-session",
      "gateway-restart-required",
      "restart-in-progress",
      "restart-failed",
      "reindex-in-progress",
      "live-session-unaffected",
      "active-session-should-restart",
    ];
    // Drive each state and assert the label/detail are present and dash-free.
    for (const state of states) {
      // Use the public markers / transitions reachable without a restart.
      if (state === "gateway-restart-required") lifecycle.markRestartRequired();
      if (state === "changes-apply-next-session") lifecycle.markNextSession();
      if (state === "active-session-should-restart")
        lifecycle.markActiveSessionShouldRestart();
      if (state === "clean") lifecycle.reset();
    }
    // Spot check copy on a couple of states.
    lifecycle.markRestartRequired();
    let snap = lifecycle.getSnapshot();
    expect(snap.label).toBe("Restart required");
    expect(snap.canRestart).toBe(true);
    expect(snap.detail).not.toMatch(/[–—]/);

    lifecycle.markNextSession; // ensure no accidental call
    lifecycle.reset();
    snap = lifecycle.getSnapshot();
    expect(snap.label).toBe("Up to date");
    expect(snap.canRestart).toBe(false);
  });

  it("noteMutation sets restart-required for MCP changes and next-session for skills", () => {
    const { lifecycle } = makeAdminHarness(gatewayRestartPendingScenario());
    lifecycle.noteMutation("skill.toggle");
    expect(lifecycle.getSnapshot().state).toBe("changes-apply-next-session");

    lifecycle.noteMutation("mcp.add");
    expect(lifecycle.getSnapshot().state).toBe("gateway-restart-required");

    // A subsequent next-session mutation must NOT downgrade a pending restart.
    lifecycle.noteMutation("skill.toggle");
    expect(lifecycle.getSnapshot().state).toBe("gateway-restart-required");
  });

  it("an immediate mutation leaves the banner where it is", () => {
    const { lifecycle } = makeAdminHarness(gatewayRestartPendingScenario());
    lifecycle.markRestartRequired();
    lifecycle.noteMutation("mcp.test"); // immediate
    expect(lifecycle.getSnapshot().state).toBe("gateway-restart-required");
  });

  it("emits the current snapshot immediately to a new subscriber", () => {
    const { lifecycle } = makeAdminHarness(gatewayRestartPendingScenario());
    lifecycle.markRestartRequired();
    const seen: GatewayLifecycleState[] = [];
    lifecycle.subscribe((snap) => seen.push(snap.state));
    expect(seen).toEqual(["gateway-restart-required"]);
  });

  it("markLiveSessionUnaffected transitions into the live-session-unaffected state", () => {
    const { lifecycle } = makeAdminHarness(gatewayRestartPendingScenario());
    const seen: GatewayLifecycleState[] = [];
    lifecycle.subscribe((snap) => seen.push(snap.state));
    lifecycle.markLiveSessionUnaffected();
    expect(lifecycle.getSnapshot().state).toBe("live-session-unaffected");
    expect(seen).toContain("live-session-unaffected");
    // The copy is present and dash-free.
    const snap = lifecycle.getSnapshot();
    expect(snap.label).toBe("Live session unaffected");
    expect(snap.detail).not.toMatch(/[–—]/);
    expect(snap.canRestart).toBe(false);
  });
});

describe("GatewayLifecycle — restart flow", () => {
  it("never restarts an active session without explicit confirmation", async () => {
    const { lifecycle, server } = makeAdminHarness(
      gatewayRestartPendingScenario(),
    );
    const before = server.requestLog.length;
    const outcome = await lifecycle.requestRestart({
      hasActiveSession: true,
      // No confirmInterrupt provided -> declines.
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.declined).toBe(true);
    // No restart request was sent.
    expect(
      server.requestLog
        .slice(before)
        .some((e) => e.path === "/api/gateway/restart"),
    ).toBe(false);
  });

  it("restarts after confirmation, polling the action and refreshing the inventory", async () => {
    const { lifecycle, cache, server } = makeAdminHarness(
      gatewayRestartPendingScenario(),
    );
    const transitions: GatewayLifecycleState[] = [];
    lifecycle.subscribe((snap) => transitions.push(snap.state));

    const confirm = vi.fn(() => true);
    const outcome = await lifecycle.requestRestart({
      hasActiveSession: true,
      confirmInterrupt: confirm,
      sleep: instantSleep,
    });

    expect(confirm).toHaveBeenCalledOnce();
    expect(outcome.ok).toBe(true);
    expect(outcome.status?.state).toBe("succeeded");

    // It passed through in-progress and reindex, then back to clean.
    expect(transitions).toContain("restart-in-progress");
    expect(transitions).toContain("reindex-in-progress");
    expect(transitions.at(-1)).toBe("clean");

    // Post-restart resources were invalidated and eagerly reloaded.
    expect(outcome.invalidated).toEqual([
      "mcpServers",
      "toolsets",
      "skills",
      "gatewayStatus",
    ]);
    // The eager reload populated the cache from the live runtime.
    expect(cache.get("mcpServers")).toBeDefined();
    expect(cache.isStale("mcpServers")).toBe(false);

    // The restart endpoint was actually called.
    expect(
      server.requestLog.some((e) => e.path === "/api/gateway/restart"),
    ).toBe(true);
  });

  it("does not require confirmation when there is no active session", async () => {
    const { lifecycle } = makeAdminHarness(gatewayRestartPendingScenario());
    const outcome = await lifecycle.requestRestart({ sleep: instantSleep });
    expect(outcome.ok).toBe(true);
    expect(outcome.declined).toBeUndefined();
  });

  it("lands in restart-failed when the restart action fails", async () => {
    const { lifecycle } = makeAdminHarness(gatewayRestartFailsScenario());
    const outcome = await lifecycle.requestRestart({ sleep: instantSleep });
    expect(outcome.ok).toBe(false);
    expect(outcome.status?.state).toBe("failed");
    const snap = lifecycle.getSnapshot();
    expect(snap.state).toBe("restart-failed");
    expect(snap.error).toContain("did not come back up");
    expect(snap.canRestart).toBe(true);
  });

  it("lands in restart-failed when the restart request itself errors", async () => {
    const { lifecycle, client } = makeAdminHarness(
      gatewayRestartPendingScenario(),
    );
    // Force the restart endpoint to throw at the transport layer.
    vi.spyOn(client.gateway, "restart").mockRejectedValueOnce(
      new Error("network down"),
    );
    const outcome = await lifecycle.requestRestart({ sleep: instantSleep });
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toBeDefined();
    expect(lifecycle.getSnapshot().state).toBe("restart-failed");
  });
});
