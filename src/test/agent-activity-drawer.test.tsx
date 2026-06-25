import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AgentActivityDrawer } from "../components/agent/AgentActivityDrawer";
import type { AgentActivityRecord } from "../lib/hermes-activity-store";

const NOW = Date.UTC(2026, 5, 24, 12, 0, 30);

function record(
  partial: Partial<AgentActivityRecord> &
    Pick<AgentActivityRecord, "sessionId">,
): AgentActivityRecord {
  return {
    id: partial.sessionId,
    mode: "sandboxed",
    phase: "running",
    pendingActionCount: 0,
    subagentCount: 0,
    subagents: [],
    lastEventAt: Date.UTC(2026, 5, 24, 12, 0, 0),
    ...partial,
    sessionId: partial.sessionId,
  };
}

function renderDrawer(
  props: Partial<Parameters<typeof AgentActivityDrawer>[0]> = {},
) {
  return render(
    <AgentActivityDrawer
      open
      records={[]}
      status="ready"
      now={NOW}
      titleForSession={() => undefined}
      onOpenSession={vi.fn()}
      onStopSession={vi.fn()}
      onSteerSession={vi.fn()}
      onClose={vi.fn()}
      {...props}
    />,
  );
}

describe("AgentActivityDrawer", () => {
  it("renders nothing when closed", () => {
    const { container } = renderDrawer({ open: false });
    expect(container).toBeEmptyDOMElement();
  });

  it("shows an empty state when open with no activity", () => {
    renderDrawer({ records: [] });
    expect(
      screen.getByRole("region", { name: "Agent activity" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/no agents are working/i)).toBeInTheDocument();
  });

  it("shows a loading state before the first snapshot", () => {
    renderDrawer({ status: "loading", records: [] });
    expect(screen.getByText(/loading activity/i)).toBeInTheDocument();
  });

  it("renders a running session row with its current tool", () => {
    renderDrawer({
      records: [
        record({
          sessionId: "s1",
          phase: "running",
          currentTool: "read_file",
        }),
      ],
      titleForSession: (id) => (id === "s1" ? "Refactor auth" : undefined),
    });
    const rows = screen.getAllByRole("listitem");
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(within(row).getByText("Refactor auth")).toBeInTheDocument();
    expect(within(row).getByText(/read_file/)).toBeInTheDocument();
    // Phase is conveyed in text, sentence case.
    expect(within(row).getByText(/running/i)).toBeInTheDocument();
  });

  it("shows a waiting session with its pending-action count", () => {
    renderDrawer({
      records: [
        record({ sessionId: "s1", phase: "waiting", pendingActionCount: 2 }),
      ],
    });
    const row = screen.getByRole("listitem");
    expect(within(row).getByText(/waiting/i)).toBeInTheDocument();
    expect(within(row).getByText(/2/)).toBeInTheDocument();
  });

  it("shows background subagent count", () => {
    renderDrawer({
      records: [
        record({ sessionId: "s1", phase: "background", subagentCount: 3 }),
      ],
    });
    const row = screen.getAllByRole("listitem")[0];
    expect(within(row).getByText(/background/i)).toBeInTheDocument();
    expect(within(row).getByText(/3/)).toBeInTheDocument();
  });

  it("renders a background-work sub-list of subagent rows under the parent (feature 12)", () => {
    renderDrawer({
      records: [
        record({
          sessionId: "s1",
          phase: "background",
          subagentCount: 2,
          subagents: [
            {
              subagentId: "sub-1",
              parentSessionId: "s1",
              phase: "tool",
              goal: "Research reconnect",
              currentTool: "grep",
              lastEventAt: new Date(
                Date.UTC(2026, 5, 24, 12, 0, 0),
              ).toISOString(),
            },
            {
              subagentId: "sub-2",
              handle: "bg-h-7",
              parentSessionId: "s1",
              phase: "complete",
              goal: "Index files",
              resultPreview: "Indexed 128 files",
              lastEventAt: new Date(
                Date.UTC(2026, 5, 24, 12, 0, 10),
              ).toISOString(),
            },
          ],
        }),
      ],
    });

    // The subagents render as their own list items, distinct from the parent.
    expect(screen.getByText("Research reconnect")).toBeInTheDocument();
    expect(screen.getByText("Index files")).toBeInTheDocument();
    // Per-subagent status + current tool + completion summary.
    expect(screen.getByText(/indexed 128 files/i)).toBeInTheDocument();
    const toolSub = screen.getByText("Research reconnect").closest("li");
    expect(toolSub).not.toBeNull();
    expect(
      within(toolSub as HTMLElement).getByText("grep"),
    ).toBeInTheDocument();
  });

  it("exposes the subagent id and handle on the row for the interrupt seam (feature 13)", () => {
    const { container } = renderDrawer({
      records: [
        record({
          sessionId: "s1",
          phase: "background",
          subagentCount: 1,
          subagents: [
            {
              subagentId: "sub-7",
              handle: "bg-h-7",
              parentSessionId: "s1",
              phase: "progress",
              goal: "Background task",
              lastEventAt: new Date(
                Date.UTC(2026, 5, 24, 12, 0, 0),
              ).toISOString(),
            },
          ],
        }),
      ],
    });

    // Feature 13 wires a stop button using a trustworthy id off the row.
    const subRow = container.querySelector(
      '[data-subagent-id="sub-7"]',
    ) as HTMLElement | null;
    expect(subRow).not.toBeNull();
    expect(subRow?.getAttribute("data-subagent-handle")).toBe("bg-h-7");
  });

  it("renders no background sub-list when there are no subagents", () => {
    renderDrawer({
      records: [record({ sessionId: "s1", phase: "running", subagents: [] })],
    });
    expect(
      screen.queryByRole("list", { name: /background work/i }),
    ).not.toBeInTheDocument();
  });

  it("shows an errored session", () => {
    renderDrawer({ records: [record({ sessionId: "s1", phase: "error" })] });
    const row = screen.getByRole("listitem");
    expect(within(row).getByText(/error/i)).toBeInTheDocument();
  });

  it("shows a completed session", () => {
    renderDrawer({ records: [record({ sessionId: "s1", phase: "complete" })] });
    const row = screen.getByRole("listitem");
    expect(within(row).getByText(/complete/i)).toBeInTheDocument();
  });

  it("shows the session mode (sandboxed vs unrestricted)", () => {
    renderDrawer({
      records: [
        record({ sessionId: "s1", mode: "sandboxed" }),
        record({ sessionId: "s2", mode: "unrestricted", lastEventAt: NOW }),
      ],
    });
    expect(screen.getByText(/sandboxed/i)).toBeInTheDocument();
    expect(screen.getByText(/unrestricted/i)).toBeInTheDocument();
  });

  it("renders model/provider when the host can resolve them", () => {
    renderDrawer({
      records: [record({ sessionId: "s1" })],
      modelForSession: () => ({ model: "claude-opus", provider: "anthropic" }),
    });
    expect(screen.getByText(/claude-opus/)).toBeInTheDocument();
  });

  it("calls onStopSession when the stop control is clicked for an active row", async () => {
    const onStopSession = vi.fn();
    renderDrawer({
      records: [record({ sessionId: "s1", phase: "running" })],
      titleForSession: () => "Refactor auth",
      onStopSession,
    });
    await userEvent.click(screen.getByRole("button", { name: /stop/i }));
    expect(onStopSession).toHaveBeenCalledWith("s1");
  });

  it("calls onOpenSession when the open control is clicked", async () => {
    const onOpenSession = vi.fn();
    renderDrawer({
      records: [record({ sessionId: "s1" })],
      titleForSession: () => "Refactor auth",
      onOpenSession,
    });
    await userEvent.click(
      screen.getByRole("button", { name: /open session/i }),
    );
    expect(onOpenSession).toHaveBeenCalledWith("s1");
  });

  it("calls onSteerSession when the steer control is clicked for an active row", async () => {
    const onSteerSession = vi.fn();
    renderDrawer({
      records: [record({ sessionId: "s1", phase: "running" })],
      titleForSession: () => "Refactor auth",
      onSteerSession,
    });
    await userEvent.click(screen.getByRole("button", { name: /steer/i }));
    expect(onSteerSession).toHaveBeenCalledWith("s1");
  });

  it("does NOT offer Steer for a session the host says is not steerable (still offers Stop)", () => {
    // A waiting session is "active" but not steerable (the composer's steer
    // input doesn't render for it), so Steer would be a dead end. Stop stays.
    renderDrawer({
      records: [record({ sessionId: "s1", phase: "waiting" })],
      titleForSession: () => "Blocked on me",
      canSteerSession: () => false,
    });
    expect(
      screen.queryByRole("button", { name: /steer/i }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /stop/i })).toBeInTheDocument();
  });

  it("offers Steer when the host reports the session is steerable", async () => {
    const onSteerSession = vi.fn();
    renderDrawer({
      records: [record({ sessionId: "s1", phase: "running" })],
      titleForSession: () => "Working session",
      canSteerSession: (id) => id === "s1",
      onSteerSession,
    });
    await userEvent.click(screen.getByRole("button", { name: /steer/i }));
    expect(onSteerSession).toHaveBeenCalledWith("s1");
  });

  it("does not offer stop or steer for a completed session", () => {
    renderDrawer({
      records: [record({ sessionId: "s1", phase: "complete" })],
      titleForSession: () => "Done session",
    });
    expect(
      screen.queryByRole("button", { name: /stop/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /steer/i }),
    ).not.toBeInTheDocument();
    // But you can still open a finished session to read it.
    expect(
      screen.getByRole("button", { name: /open session/i }),
    ).toBeInTheDocument();
  });

  it("falls back to the session id when no title is known", () => {
    renderDrawer({ records: [record({ sessionId: "sess-123" })] });
    expect(screen.getByText("sess-123")).toBeInTheDocument();
  });

  it("calls onClose from the close control", async () => {
    const onClose = vi.fn();
    renderDrawer({ onClose });
    await userEvent.click(screen.getByRole("button", { name: /close/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
