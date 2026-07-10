import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  AccessGrantsController,
  buildAllowedCommandRows,
  buildSessionGrantRows,
  grantDurationLabel,
  grantScopeLabel,
  readCommandAllowlist,
  removeAllowedCommand,
  shortSessionId,
  type AccessGrantsEngine,
  type AccessGrantsState,
} from "../lib/hermes-admin";
import type { AccessGrantRecord } from "../lib/access-grant-log";
import {
  forgetSessionMode,
  rememberSessionMode,
  subscribeSessionModes,
  unrestrictedSessionIds,
} from "../lib/agent-session-modes";
import { AccessGrantsView } from "../components/settings/AccessGrantsSection";
import { makeAdminHarness } from "./fixtures/hermes-admin-harness";

/** A log record with sensible defaults a test can override. */
function grant(overrides: Partial<AccessGrantRecord> & { requestId: string }): AccessGrantRecord {
  return {
    id: `s1:${overrides.requestId}`,
    sessionId: "s1",
    choice: "session",
    patternKeys: [],
    grantedAt: 1_000,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Pure view logic. No render, no network.
// ---------------------------------------------------------------------------

describe("access grants — config read", () => {
  it("reads the command_allowlist from the config tree", () => {
    expect(
      readCommandAllowlist({ command_allowlist: ["Recursive deletion (rm -rf)", "Sudo"] }),
    ).toEqual(["Recursive deletion (rm -rf)", "Sudo"]);
  });

  it("tolerates a missing key, a bare string, and non-string entries", () => {
    expect(readCommandAllowlist({})).toEqual([]);
    expect(readCommandAllowlist({ command_allowlist: "Sudo" })).toEqual(["Sudo"]);
    expect(readCommandAllowlist({ command_allowlist: ["ok", 42, "", null] })).toEqual(["ok"]);
  });
});

describe("access grants — allowed command rows", () => {
  it("is app-wide + ongoing and enriched by the newest matching 'always' grant", () => {
    const rows = buildAllowedCommandRows(
      ["Recursive deletion (rm -rf)", "Sudo"],
      [
        grant({
          requestId: "new",
          choice: "always",
          command: "rm -rf build",
          patternKeys: ["Recursive deletion (rm -rf)"],
          grantedAt: 2_000,
        }),
        grant({
          requestId: "old",
          choice: "always",
          command: "rm -rf dist",
          patternKeys: ["Recursive deletion (rm -rf)"],
          grantedAt: 1_000,
        }),
      ],
    );
    expect(rows[0]).toMatchObject({
      pattern: "Recursive deletion (rm -rf)",
      scope: "app-wide",
      duration: "ongoing",
      grantedAt: 2_000,
      command: "rm -rf build",
    });
    // Granted outside June (or before the log existed): still listed, bare.
    expect(rows[1]).toMatchObject({ pattern: "Sudo", grantedAt: undefined });
  });

  it("correlates by description when pattern keys are absent, and never by session grants", () => {
    const rows = buildAllowedCommandRows(
      ["Sudo"],
      [
        grant({ requestId: "r1", choice: "session", description: "Sudo", command: "sudo ls" }),
        grant({ requestId: "r2", choice: "always", description: "Sudo", command: "sudo id" }),
      ],
    );
    expect(rows[0].command).toBe("sudo id");
  });
});

describe("access grants — session grant rows", () => {
  it("maps once to one-time and session to ongoing, excluding always", () => {
    const rows = buildSessionGrantRows([
      grant({ requestId: "r1", choice: "once", command: "git push --force" }),
      grant({ requestId: "r2", choice: "session", description: "Sudo" }),
      grant({ requestId: "r3", choice: "always", description: "Curl piped to shell" }),
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      title: "git push --force",
      scope: "session",
      duration: "one-time",
    });
    expect(rows[1]).toMatchObject({ title: "Sudo", duration: "ongoing" });
  });
});

describe("access grants — labels and list math", () => {
  it("labels scope and duration in user language", () => {
    expect(grantScopeLabel("app-wide")).toBe("App-wide");
    expect(grantScopeLabel("session")).toBe("This session");
    expect(grantDurationLabel("one-time")).toBe("One time");
    expect(grantDurationLabel("ongoing")).toBe("Ongoing");
  });

  it("removes a pattern without mutating and tolerates a double revoke", () => {
    const existing = ["a", "b"];
    expect(removeAllowedCommand(existing, "a")).toEqual(["b"]);
    expect(removeAllowedCommand(existing, "missing")).toEqual(["a", "b"]);
    expect(existing).toEqual(["a", "b"]);
  });

  it("shortens long session ids for display", () => {
    expect(shortSessionId("short")).toBe("short");
    expect(shortSessionId("0123456789abcdef")).toBe("0123456789ab...");
  });
});

describe("access grants — session mode change notification", () => {
  it("notifies subscribers when a session mode is remembered or forgotten", () => {
    localStorage.clear();
    const seen: string[][] = [];
    const unsubscribe = subscribeSessionModes(() => {
      seen.push(unrestrictedSessionIds());
    });

    rememberSessionMode("sess-1", true);
    forgetSessionMode("sess-1");
    unsubscribe();
    rememberSessionMode("sess-2", true);

    expect(seen).toEqual([["sess-1"], []]);
    localStorage.clear();
  });
});

// ---------------------------------------------------------------------------
// Controller — config reads/writes through the fake Hermes server.
// ---------------------------------------------------------------------------

function engineFor(config: Record<string, unknown>): {
  engine: AccessGrantsEngine;
  harness: ReturnType<typeof makeAdminHarness>;
} {
  const harness = makeAdminHarness({ config });
  return { engine: harness, harness };
}

describe("access grants — controller", () => {
  it("loads the configured allowlist", async () => {
    const { engine } = engineFor({ command_allowlist: ["Sudo"] });
    const controller = new AccessGrantsController(engine);
    await controller.load();

    const snapshot = controller.getSnapshot();
    expect(snapshot.status).toBe("ready");
    expect(snapshot.patterns).toEqual(["Sudo"]);
    controller.dispose();
  });

  it("revokes a pattern, writes the pruned list, and records a next-session notice", async () => {
    const { engine } = engineFor({
      command_allowlist: ["Sudo", "Recursive deletion (rm -rf)"],
    });
    const controller = new AccessGrantsController(engine);
    await controller.load();

    await controller.revoke("Sudo");

    // The fake server actually persisted the pruned list.
    const after = await engine.client.config.get();
    expect(readCommandAllowlist(after.config)).toEqual(["Recursive deletion (rm -rf)"]);

    const snapshot = controller.getSnapshot();
    expect(snapshot.patterns).toEqual(["Recursive deletion (rm -rf)"]);
    expect(snapshot.lifecycle.state).toBe("changes-apply-next-session");
    expect(snapshot.notifications.at(-1)?.timing).toBe("next-session");
    controller.dispose();
  });

  it("prunes the freshly read allowlist, preserving a grant added after load", async () => {
    const { engine } = engineFor({ command_allowlist: ["Sudo", "Curl piped to shell"] });
    const controller = new AccessGrantsController(engine);
    await controller.load();

    // Another session persists a new "Always approve" after this page loaded.
    await engine.client.config.setValue("command_allowlist", [
      "Sudo",
      "Curl piped to shell",
      "Force push (git push --force)",
    ]);

    await controller.revoke("Sudo");

    // The revoke removed only its own pattern; the newer grant survived.
    const after = await engine.client.config.get();
    expect(readCommandAllowlist(after.config)).toEqual([
      "Curl piped to shell",
      "Force push (git push --force)",
    ]);
    controller.dispose();
  });

  it("a pattern already revoked elsewhere reloads without writing", async () => {
    const { engine } = engineFor({ command_allowlist: ["Sudo"] });
    const controller = new AccessGrantsController(engine);
    await controller.load();

    // Revoked from another window between load and click.
    await engine.client.config.setValue("command_allowlist", []);

    await controller.revoke("Sudo");

    const snapshot = controller.getSnapshot();
    expect(snapshot.patterns).toEqual([]);
    // No write of its own: the lifecycle stays clean.
    expect(snapshot.lifecycle.state).toBe("clean");
    controller.dispose();
  });

  it("a revoke of an unknown pattern writes nothing", async () => {
    const { engine } = engineFor({ command_allowlist: ["Sudo"] });
    const controller = new AccessGrantsController(engine);
    await controller.load();

    await controller.revoke("missing");

    const after = await engine.client.config.get();
    expect(readCommandAllowlist(after.config)).toEqual(["Sudo"]);
    expect(controller.getSnapshot().lifecycle.state).toBe("clean");
    controller.dispose();
  });
});

// ---------------------------------------------------------------------------
// Rendered view — labels and revoke wiring, driven with stubbed state.
// ---------------------------------------------------------------------------

function stubState(overrides: Partial<AccessGrantsState> = {}): AccessGrantsState {
  return {
    status: "ready",
    patterns: [],
    busy: false,
    retryable: false,
    lifecycle: { state: "clean", label: "Up to date", detail: "", canRestart: false },
    notifications: [],
    refresh: vi.fn(),
    revoke: vi.fn(),
    dismissNotification: vi.fn(),
    ...overrides,
  } as AccessGrantsState;
}

describe("access grants — rendered view", () => {
  it("shows every group with scope and duration pills and wires revoke", () => {
    const state = stubState({ patterns: ["Recursive deletion (rm -rf)"] });
    const onClearGrant = vi.fn();
    const onRevokeUnrestricted = vi.fn();
    render(
      <AccessGrantsView
        state={state}
        allowedRows={buildAllowedCommandRows(state.patterns, [
          grant({
            requestId: "r0",
            choice: "always",
            command: "rm -rf build",
            patternKeys: ["Recursive deletion (rm -rf)"],
          }),
        ])}
        grantRows={buildSessionGrantRows([
          grant({ requestId: "r1", choice: "once", command: "git push --force" }),
        ])}
        unrestrictedSessions={["sess-full-1"]}
        onClearGrant={onClearGrant}
        onClearAllGrants={vi.fn()}
        onRevokeUnrestricted={onRevokeUnrestricted}
      />,
    );

    expect(screen.getByRole("heading", { name: "Access grants" })).toBeTruthy();

    // Always allowed command row: pattern, App-wide + Ongoing pills, Revoke.
    const allowedRow = screen.getByText("Recursive deletion (rm -rf)").closest("li");
    expect(allowedRow).toBeTruthy();
    expect(within(allowedRow as HTMLElement).getByText("App-wide")).toBeTruthy();
    expect(within(allowedRow as HTMLElement).getByText("Ongoing")).toBeTruthy();
    fireEvent.click(within(allowedRow as HTMLElement).getByRole("button", { name: "Revoke" }));
    expect(state.revoke).toHaveBeenCalledWith("Recursive deletion (rm -rf)");

    // Session approval row: one-time pill and a Clear action.
    const grantRow = screen.getByText("git push --force").closest("li");
    expect(within(grantRow as HTMLElement).getByText("This session")).toBeTruthy();
    expect(within(grantRow as HTMLElement).getByText("One time")).toBeTruthy();
    fireEvent.click(within(grantRow as HTMLElement).getByRole("button", { name: "Clear" }));
    expect(onClearGrant).toHaveBeenCalledWith("s1:r1");

    // Full access session row revokes by session id.
    const sessionRow = screen.getByText("Session sess-full-1").closest("li");
    fireEvent.click(within(sessionRow as HTMLElement).getByRole("button", { name: "Revoke" }));
    expect(onRevokeUnrestricted).toHaveBeenCalledWith("sess-full-1");
  });

  it("keeps the local groups when the runtime is unavailable", () => {
    render(
      <AccessGrantsView
        state={stubState({ status: "unavailable" })}
        allowedRows={[]}
        grantRows={buildSessionGrantRows([grant({ requestId: "r1", choice: "session" })])}
        unrestrictedSessions={[]}
        onClearGrant={vi.fn()}
        onClearAllGrants={vi.fn()}
        onRevokeUnrestricted={vi.fn()}
      />,
    );

    expect(screen.getByText(/runtime is not running/i)).toBeTruthy();
    // The local record still renders without the runtime.
    expect(screen.getByText("Approved request")).toBeTruthy();
    expect(screen.getByText("No sessions have full access.")).toBeTruthy();
  });

  it("offers Clear all only when there are session approvals", () => {
    const onClearAllGrants = vi.fn();
    const { rerender } = render(
      <AccessGrantsView
        state={stubState()}
        allowedRows={[]}
        grantRows={[]}
        unrestrictedSessions={[]}
        onClearGrant={vi.fn()}
        onClearAllGrants={onClearAllGrants}
        onRevokeUnrestricted={vi.fn()}
      />,
    );
    expect(screen.queryByRole("button", { name: "Clear all" })).toBeNull();

    rerender(
      <AccessGrantsView
        state={stubState()}
        allowedRows={[]}
        grantRows={buildSessionGrantRows([grant({ requestId: "r1", choice: "once" })])}
        unrestrictedSessions={[]}
        onClearGrant={vi.fn()}
        onClearAllGrants={onClearAllGrants}
        onRevokeUnrestricted={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Clear all" }));
    expect(onClearAllGrants).toHaveBeenCalled();
  });
});
