import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  AccessGrantsController,
  buildAllowedCommandRows,
  readCommandAllowlist,
  removeAllowedCommand,
  useAccessGrants,
  type AccessGrantsEngine,
  type AccessGrantsState,
} from "../lib/hermes-admin";
import type { AccessGrantRecord } from "../lib/access-grant-log";
import { AccessGrantsView } from "../components/settings/AccessGrantsSection";
import { hermesBridgeStatus } from "../lib/tauri";
import { makeAdminHarness } from "./fixtures/hermes-admin-harness";

vi.mock("../lib/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/tauri")>();
  return { ...actual, hermesBridgeStatus: vi.fn() };
});

const mockBridgeStatus = vi.mocked(hermesBridgeStatus);

/** A log record with sensible defaults a test can override. Every logged
 * grant is an "Always approve" answer. */
function grant(overrides: Partial<AccessGrantRecord> & { requestId: string }): AccessGrantRecord {
  return {
    id: `s1:${overrides.requestId}`,
    sessionId: "s1",
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
  it("is enriched by the newest matching grant record", () => {
    const rows = buildAllowedCommandRows(
      ["Recursive deletion (rm -rf)", "Sudo"],
      [
        grant({
          requestId: "new",
          command: "rm -rf build",
          patternKeys: ["Recursive deletion (rm -rf)"],
          grantedAt: 2_000,
        }),
        grant({
          requestId: "old",
          command: "rm -rf dist",
          patternKeys: ["Recursive deletion (rm -rf)"],
          grantedAt: 1_000,
        }),
      ],
    );
    expect(rows[0]).toMatchObject({
      pattern: "Recursive deletion (rm -rf)",
      grantedAt: 2_000,
      command: "rm -rf build",
    });
    // Granted outside June (or before the log existed): still listed, bare.
    expect(rows[1]).toMatchObject({ pattern: "Sudo", grantedAt: undefined });
  });

  it("correlates by description when pattern keys are absent", () => {
    const rows = buildAllowedCommandRows(
      ["Sudo"],
      [grant({ requestId: "r2", description: "Sudo", command: "sudo id" })],
    );
    expect(rows[0].command).toBe("sudo id");
  });
});

describe("access grants — list math", () => {
  it("removes a pattern without mutating and tolerates a double revoke", () => {
    const existing = ["a", "b"];
    expect(removeAllowedCommand(existing, "a")).toEqual(["b"]);
    expect(removeAllowedCommand(existing, "missing")).toEqual(["a", "b"]);
    expect(existing).toEqual(["a", "b"]);
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

describe("access grants — single-snapshot config update", () => {
  it("updateValue transforms the value from the same tree it persists", async () => {
    const { engine } = engineFor({ command_allowlist: ["A"], other: { keep: true } });
    let received: unknown;
    await engine.client.config.updateValue("command_allowlist", (value) => {
      received = value;
      return ["B"];
    });
    // The transform saw the live value, the write landed, siblings survived.
    expect(received).toEqual(["A"]);
    const after = await engine.client.config.get();
    expect(readCommandAllowlist(after.config)).toEqual(["B"]);
    expect((after.config as { other?: unknown }).other).toEqual({ keep: true });
  });
});

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
// Hook — the bridge-status load and its retry wiring.
// ---------------------------------------------------------------------------

describe("access grants — bridge status retry", () => {
  it("refresh retries a failed bridge-status load", async () => {
    mockBridgeStatus.mockRejectedValueOnce(new Error("bridge down"));
    mockBridgeStatus.mockResolvedValue({ running: false });

    const { result } = renderHook(() => useAccessGrants("sandboxed"));

    // The failed load renders as a retryable error.
    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(result.current.retryable).toBe(true);
    expect(result.current.error).toContain("bridge down");

    // The advertised retry actually re-runs the load (it is not the
    // engine-less no-op): the second attempt reaches the bridge and lands on
    // the honest "unavailable" state.
    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.status).toBe("unavailable"));
    expect(mockBridgeStatus).toHaveBeenCalledTimes(2);
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
  it("shows only the persistent grant groups and wires revoke", () => {
    const state = stubState({ patterns: ["Recursive deletion (rm -rf)"] });
    const onRevokeCliAccess = vi.fn();
    render(
      <AccessGrantsView
        state={state}
        allowedRows={buildAllowedCommandRows(state.patterns, [
          grant({
            requestId: "r0",
            command: "rm -rf build",
            patternKeys: ["Recursive deletion (rm -rf)"],
          }),
        ])}
        cliAccess={true}
        cliBusy={false}
        onRevokeCliAccess={onRevokeCliAccess}
      />,
    );

    expect(screen.getByRole("heading", { name: "Access grants" })).toBeTruthy();

    // Always allowed command row: pattern, triggering command, when, Revoke.
    const allowedRow = screen.getByText("Recursive deletion (rm -rf)").closest("li");
    expect(allowedRow).toBeTruthy();
    expect(within(allowedRow as HTMLElement).getByText("rm -rf build")).toBeTruthy();
    expect(within(allowedRow as HTMLElement).getByText(/Granted /)).toBeTruthy();
    fireEvent.click(within(allowedRow as HTMLElement).getByRole("button", { name: "Revoke" }));
    expect(state.revoke).toHaveBeenCalledWith("Recursive deletion (rm -rf)");

    // Agent CLI access row: a working revoke.
    const cliRow = screen.getByText("Coding CLI state folders").closest("li");
    fireEvent.click(within(cliRow as HTMLElement).getByRole("button", { name: "Revoke" }));
    expect(onRevokeCliAccess).toHaveBeenCalled();

    // Session-scoped surfaces are gone: the page shows persistent grants only.
    expect(screen.queryByText("Session approvals")).toBeNull();
    expect(screen.queryByText("Full access sessions")).toBeNull();
  });

  it("shows the CLI access group as not granted when the flag is off", () => {
    render(
      <AccessGrantsView
        state={stubState()}
        allowedRows={[]}
        cliAccess={false}
        cliBusy={false}
        onRevokeCliAccess={vi.fn()}
      />,
    );
    expect(screen.getByText("Not granted.")).toBeTruthy();
    expect(screen.queryByText("Coding CLI state folders")).toBeNull();
  });

  it("keeps the CLI group when the runtime is unavailable", () => {
    render(
      <AccessGrantsView
        state={stubState({ status: "unavailable" })}
        allowedRows={[]}
        cliAccess={true}
        cliBusy={false}
        onRevokeCliAccess={vi.fn()}
      />,
    );

    expect(screen.getByText(/runtime is not running/i)).toBeTruthy();
    // The local flag still renders without the runtime.
    expect(screen.getByText("Coding CLI state folders")).toBeTruthy();
  });

  it("offers Try again for a retryable load error", () => {
    const state = stubState({ status: "error", error: "boom", retryable: true });
    render(
      <AccessGrantsView
        state={state}
        allowedRows={[]}
        cliAccess={false}
        cliBusy={false}
        onRevokeCliAccess={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(state.refresh).toHaveBeenCalled();
  });
});
