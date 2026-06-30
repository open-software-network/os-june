import { act, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  PENDING_SKILL_WRITES_COMMAND,
  RESOLVE_PENDING_SKILL_WRITE_COMMAND,
  SkillReviewController,
  type PendingSkillWrite,
  type ReviewInvoke,
  type SkillReviewEngine,
  type SkillReviewState,
} from "../lib/hermes-admin";
import { SkillReviewView } from "../components/settings/SkillReviewSection";
import { makeAdminHarness } from "./fixtures/hermes-admin-harness";

/** A sample readable edit write. */
function editWrite(id: string): Record<string, unknown> {
  return {
    id,
    skill: "research",
    op: "edit",
    source: "background",
    gist: `Edit ${id}`,
    files: [
      { relativePath: "research/SKILL.md", diff: "@@\n-a\n+b\n", content: "b" },
    ],
    readable: true,
  };
}

/** Builds an engine from the fake-server harness plus a fake `invoke` that
 * serves the pending-writes list and records resolve calls. The config gate
 * routes through the harness's real admin client against the fake server. */
function makeReviewEngine(options: {
  writes: Record<string, unknown>[];
  config?: Record<string, unknown>;
  resolveImpl?: (id: string, approve: boolean) => Promise<unknown> | unknown;
}): { engine: SkillReviewEngine; invoke: ReturnType<typeof vi.fn> } {
  const harness = makeAdminHarness({ config: options.config ?? {} });
  let current = [...options.writes];
  const impl: ReviewInvoke = async (command, args) => {
    if (command === PENDING_SKILL_WRITES_COMMAND) {
      return current;
    }
    if (command === RESOLVE_PENDING_SKILL_WRITE_COMMAND) {
      const request = (args?.request ?? {}) as {
        id: string;
        approve: boolean;
      };
      if (options.resolveImpl) {
        await options.resolveImpl(request.id, request.approve);
      }
      // Drain the resolved write from the fake on-disk queue.
      current = current.filter((w) => w.id !== request.id);
      return { id: request.id, approved: request.approve, ok: true };
    }
    throw new Error(`unexpected command ${command}`);
  };
  const invoke = vi.fn(impl);
  const engine: SkillReviewEngine = {
    target: harness.target,
    client: harness.client,
    cache: harness.cache,
    lifecycle: harness.lifecycle,
    invoke: invoke as unknown as ReviewInvoke,
  };
  return { engine, invoke };
}

async function loaded(controller: SkillReviewController): Promise<void> {
  await controller.load();
}

describe("SkillReviewController", () => {
  it("loads the pending writes and the gate value", async () => {
    const { engine } = makeReviewEngine({
      writes: [editWrite("change-1"), editWrite("change-2")],
      config: { skills: { write_approval: true } },
    });
    const controller = new SkillReviewController(engine);
    await loaded(controller);

    const state = controller.getSnapshot();
    expect(state.status).toBe("ready");
    expect(state.writes.map((w) => w.id)).toEqual(["change-1", "change-2"]);
    expect(state.gateEnabled).toBe(true);
  });

  it("approves one write, routing it through the Rust resolve command and refreshing", async () => {
    const { engine, invoke } = makeReviewEngine({
      writes: [editWrite("change-1"), editWrite("change-2")],
    });
    const controller = new SkillReviewController(engine);
    await loaded(controller);

    await controller.resolve("change-1", true);

    const resolveCall = invoke.mock.calls.find(
      ([command]) => command === RESOLVE_PENDING_SKILL_WRITE_COMMAND,
    );
    expect(resolveCall?.[1]).toEqual({
      request: { id: "change-1", approve: true },
    });
    // The approved write is gone after the refresh.
    expect(controller.getSnapshot().writes.map((w) => w.id)).toEqual([
      "change-2",
    ]);
    // An approved write raises the shared "applies next session" notification.
    expect(
      controller
        .getSnapshot()
        .notifications.some((n) => n.mutation === "skill.toggle"),
    ).toBe(true);
  });

  it("rejects one write without raising an apply-timing notification", async () => {
    const { engine, invoke } = makeReviewEngine({
      writes: [editWrite("change-1")],
    });
    const controller = new SkillReviewController(engine);
    await loaded(controller);

    await controller.resolve("change-1", false);

    const resolveCall = invoke.mock.calls.find(
      ([command]) => command === RESOLVE_PENDING_SKILL_WRITE_COMMAND,
    );
    expect(resolveCall?.[1]).toEqual({
      request: { id: "change-1", approve: false },
    });
    expect(controller.getSnapshot().writes).toHaveLength(0);
    // A reject changes nothing durable, so no skill.toggle notification.
    expect(
      controller
        .getSnapshot()
        .notifications.some((n) => n.mutation === "skill.toggle"),
    ).toBe(false);
  });

  it("surfaces a safe error and keeps the row when a resolve fails", async () => {
    const { engine } = makeReviewEngine({
      writes: [editWrite("change-1")],
      resolveImpl: () => {
        throw new Error("hermes_pending_skill_unreadable");
      },
    });
    const controller = new SkillReviewController(engine);
    await loaded(controller);

    await controller.resolve("change-1", true);
    const state = controller.getSnapshot();
    expect(state.error).toBeTruthy();
    // The row is not optimistically dropped on failure.
    expect(state.writes.map((w) => w.id)).toEqual(["change-1"]);
  });

  it("approve-all skips unreadable writes", async () => {
    const unreadable = { id: "bad", skill: "x", readable: false, files: [] };
    const { engine, invoke } = makeReviewEngine({
      writes: [editWrite("good"), unreadable],
    });
    const controller = new SkillReviewController(engine);
    await loaded(controller);

    await controller.approveAll();

    const approvedIds = invoke.mock.calls
      .filter(([command]) => command === RESOLVE_PENDING_SKILL_WRITE_COMMAND)
      .map(([, args]) => (args?.request as { id: string }).id);
    expect(approvedIds).toEqual(["good"]);
    // The unreadable write stays for explicit rejection.
    expect(controller.getSnapshot().writes.map((w) => w.id)).toEqual(["bad"]);
  });

  it("toggles the write-approval gate via the config client and applies next session", async () => {
    const { engine } = makeReviewEngine({
      writes: [],
      config: { skills: { write_approval: false } },
    });
    const controller = new SkillReviewController(engine);
    await loaded(controller);
    expect(controller.getSnapshot().gateEnabled).toBe(false);

    await controller.setGate(true);

    const state = controller.getSnapshot();
    expect(state.gateEnabled).toBe(true);
    // The gate write is a config.set, surfaced through the shared cache as a
    // next-session notification.
    expect(state.notifications.some((n) => n.mutation === "config.set")).toBe(
      true,
    );
  });
});

// ---------------------------------------------------------------------------
// View rendering (stubbed state, no Tauri).
// ---------------------------------------------------------------------------

function baseState(
  overrides: Partial<SkillReviewState> = {},
): SkillReviewState {
  return {
    status: "ready",
    writes: [],
    gateEnabled: true,
    gatePending: false,
    mode: "sandboxed",
    profile: "default",
    pending: new Set<string>(),
    retryable: false,
    lifecycle: {
      state: "clean",
      label: "Up to date",
      detail: "No pending changes.",
      canRestart: false,
    },
    notifications: [],
    refresh: () => {},
    approve: () => {},
    reject: () => {},
    approveAll: () => {},
    rejectAll: () => {},
    setGate: () => {},
    dismissNotification: () => {},
    ...overrides,
  };
}

function viewWrite(
  overrides: Partial<PendingSkillWrite> = {},
): PendingSkillWrite {
  return {
    id: "change-1",
    skill: "research",
    op: "edit",
    source: "background",
    gist: "Tighten the checklist",
    files: [
      {
        relativePath: "research/SKILL.md",
        diff: "@@\n-old\n+new\n",
        content: "new",
      },
    ],
    readable: true,
    ...overrides,
  };
}

describe("SkillReviewView", () => {
  it("renders the gate copy and a pending write with approve/reject", () => {
    render(<SkillReviewView state={baseState({ writes: [viewWrite()] })} />);
    expect(
      screen.getByText(/do not land until you approve/i),
    ).toBeInTheDocument();
    expect(screen.getByText("Tighten the checklist")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Approve" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Reject" })).toBeEnabled();
  });

  it("disables approve for an unreadable write but allows reject", () => {
    render(
      <SkillReviewView
        state={baseState({
          writes: [viewWrite({ readable: false, op: "unknown" })],
        })}
      />,
    );
    expect(screen.getByRole("button", { name: "Approve" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Reject" })).toBeEnabled();
    expect(
      screen.getByText(/could not fully read this change/i),
    ).toBeInTheDocument();
  });

  it("disables approve for a redacted write and points the user to Hermes", () => {
    render(
      <SkillReviewView
        state={baseState({
          writes: [
            viewWrite({
              files: [
                {
                  relativePath: "research/SKILL.md",
                  content: "authorization: [redacted]",
                  redacted: true,
                },
              ],
            }),
          ],
        })}
      />,
    );
    expect(screen.getByRole("button", { name: "Approve" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Reject" })).toBeEnabled();
    expect(screen.getByText(/approve it in Hermes/i)).toBeInTheDocument();
  });

  it("expands the diff on demand", () => {
    render(<SkillReviewView state={baseState({ writes: [viewWrite()] })} />);
    const toggle = screen.getByRole("button", { name: "View diff" });
    act(() => {
      toggle.click();
    });
    expect(
      screen.getByLabelText(/Diff for research\/SKILL.md/),
    ).toBeInTheDocument();
  });

  it("wires approve to the state callback", () => {
    const approve = vi.fn();
    render(
      <SkillReviewView state={baseState({ writes: [viewWrite()], approve })} />,
    );
    act(() => {
      screen.getByRole("button", { name: "Approve" }).click();
    });
    expect(approve).toHaveBeenCalledWith("change-1");
  });

  it("shows the empty state when nothing is pending", () => {
    render(<SkillReviewView state={baseState({ writes: [] })} />);
    expect(screen.getByText("Nothing waiting for you")).toBeInTheDocument();
  });

  it("wires the gate toggle to setGate", () => {
    const setGate = vi.fn();
    render(
      <SkillReviewView state={baseState({ gateEnabled: false, setGate })} />,
    );
    act(() => {
      screen.getByRole("switch").click();
    });
    expect(setGate).toHaveBeenCalledWith(true);
  });
});

// Keep `waitFor` referenced for parity with the suite's async helpers.
void waitFor;
