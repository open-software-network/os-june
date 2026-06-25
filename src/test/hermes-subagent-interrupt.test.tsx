import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AgentActivityDrawer } from "../components/agent/AgentActivityDrawer";
import type { AgentActivityRecord } from "../lib/hermes-activity-store";
import type { BackgroundHermesActivity } from "../lib/hermes-control-plane";

/**
 * Feature 13 — subagent interrupt / stop control. Feature 12 ships the
 * per-subagent rows (with `data-subagent-id`/`data-subagent-handle` and a
 * reserved actions slot); this feature adds a stop button on ACTIVE subagent
 * rows that targets a trustworthy Hermes id, confirms when the subagent is
 * doing file/tool work, sets an optimistic "stopping" overlay, and reconciles
 * with the eventual `complete`/`error` event. A row with no trustworthy id is
 * read-only.
 */

const NOW = Date.UTC(2026, 5, 24, 12, 0, 30);
const AT = (s: number) =>
  new Date(Date.UTC(2026, 5, 24, 12, 0, s)).toISOString();

function record(
  partial: Partial<AgentActivityRecord> &
    Pick<AgentActivityRecord, "sessionId">,
): AgentActivityRecord {
  return {
    id: partial.sessionId,
    mode: "sandboxed",
    phase: "background",
    pendingActionCount: 0,
    subagentCount: 0,
    subagents: [],
    lastEventAt: Date.UTC(2026, 5, 24, 12, 0, 0),
    ...partial,
    sessionId: partial.sessionId,
  };
}

function subagent(
  partial: Partial<BackgroundHermesActivity> &
    Pick<BackgroundHermesActivity, "subagentId">,
): BackgroundHermesActivity {
  return {
    phase: "progress",
    lastEventAt: AT(0),
    ...partial,
    subagentId: partial.subagentId,
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

function subagentRow(container: HTMLElement, id: string): HTMLElement {
  const row = container.querySelector(`[data-subagent-id="${id}"]`);
  if (!row) throw new Error(`no subagent row for ${id}`);
  return row as HTMLElement;
}

describe("AgentActivityDrawer — subagent interrupt (feature 13)", () => {
  it("renders no stop button on a subagent row when no handler is wired", () => {
    const { container } = renderDrawer({
      records: [
        record({
          sessionId: "s1",
          subagentCount: 1,
          subagents: [subagent({ subagentId: "sub-1", phase: "progress" })],
        }),
      ],
    });
    const row = subagentRow(container, "sub-1");
    expect(within(row).queryByRole("button", { name: /stop/i })).toBeNull();
  });

  it("hides the stop button when the subagent has no trustworthy id/handle", () => {
    // The classifier falls back to the literal "subagent" sentinel when a
    // payload carries neither id nor handle. We must NOT target an interrupt at
    // an invented id, so the row stays read-only.
    const onStopSubagent = vi.fn();
    const { container } = renderDrawer({
      onStopSubagent,
      records: [
        record({
          sessionId: "s1",
          subagentCount: 1,
          subagents: [subagent({ subagentId: "subagent", phase: "progress" })],
        }),
      ],
    });
    const row = subagentRow(container, "subagent");
    expect(within(row).queryByRole("button", { name: /stop/i })).toBeNull();
  });

  it("hides the stop button once the subagent has reached a terminal phase", () => {
    const onStopSubagent = vi.fn();
    const { container } = renderDrawer({
      onStopSubagent,
      records: [
        record({
          sessionId: "s1",
          subagentCount: 1,
          subagents: [
            subagent({
              subagentId: "sub-done",
              phase: "complete",
              resultPreview: "Done",
            }),
          ],
        }),
      ],
    });
    const row = subagentRow(container, "sub-done");
    expect(within(row).queryByRole("button", { name: /stop/i })).toBeNull();
  });

  it("calls onStopSubagent with the session id and the subagent id when stopped (no confirm for non-tool work)", async () => {
    const onStopSubagent = vi.fn().mockResolvedValue(undefined);
    const { container } = renderDrawer({
      onStopSubagent,
      records: [
        record({
          sessionId: "s1",
          subagentCount: 1,
          subagents: [
            subagent({
              subagentId: "sub-7",
              phase: "thinking",
              goal: "Background task",
            }),
          ],
        }),
      ],
    });
    const row = subagentRow(container, "sub-7");
    await userEvent.click(within(row).getByRole("button", { name: /stop/i }));
    expect(onStopSubagent).toHaveBeenCalledTimes(1);
    expect(onStopSubagent).toHaveBeenCalledWith({
      sessionId: "s1",
      subagentId: "sub-7",
    });
  });

  it("prefers the handle as the interrupt target when present", async () => {
    const onStopSubagent = vi.fn().mockResolvedValue(undefined);
    const { container } = renderDrawer({
      onStopSubagent,
      records: [
        record({
          sessionId: "s1",
          subagentCount: 1,
          subagents: [
            subagent({
              subagentId: "sub-id",
              handle: "bg-handle",
              phase: "thinking",
            }),
          ],
        }),
      ],
    });
    const row = subagentRow(container, "sub-id");
    await userEvent.click(within(row).getByRole("button", { name: /stop/i }));
    expect(onStopSubagent).toHaveBeenCalledWith({
      sessionId: "s1",
      subagentId: "bg-handle",
    });
  });

  it("confirms before stopping a subagent doing file/tool work, and only fires on confirm", async () => {
    const onStopSubagent = vi.fn().mockResolvedValue(undefined);
    const { container } = renderDrawer({
      onStopSubagent,
      records: [
        record({
          sessionId: "s1",
          subagentCount: 1,
          subagents: [
            subagent({
              subagentId: "sub-tool",
              phase: "tool",
              currentTool: "write_file",
              goal: "Edit config",
            }),
          ],
        }),
      ],
    });
    const row = subagentRow(container, "sub-tool");
    await userEvent.click(within(row).getByRole("button", { name: /stop/i }));
    // The interrupt does not fire until the user confirms the destructive stop.
    expect(onStopSubagent).not.toHaveBeenCalled();
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(
      within(dialog).getByRole("button", { name: /stop/i }),
    );
    expect(onStopSubagent).toHaveBeenCalledWith({
      sessionId: "s1",
      subagentId: "sub-tool",
    });
  });

  it("does not stop when the confirmation for tool work is cancelled", async () => {
    const onStopSubagent = vi.fn().mockResolvedValue(undefined);
    const { container } = renderDrawer({
      onStopSubagent,
      records: [
        record({
          sessionId: "s1",
          subagentCount: 1,
          subagents: [
            subagent({
              subagentId: "sub-tool",
              phase: "tool",
              currentTool: "write_file",
            }),
          ],
        }),
      ],
    });
    const row = subagentRow(container, "sub-tool");
    await userEvent.click(within(row).getByRole("button", { name: /stop/i }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(
      within(dialog).getByRole("button", { name: /keep running/i }),
    );
    expect(onStopSubagent).not.toHaveBeenCalled();
  });

  it("optimistically shows 'Stopping' and hides the stop button after a stop is requested", async () => {
    const onStopSubagent = vi.fn().mockResolvedValue(undefined);
    const { container } = renderDrawer({
      onStopSubagent,
      records: [
        record({
          sessionId: "s1",
          subagentCount: 1,
          subagents: [
            subagent({
              subagentId: "sub-7",
              phase: "thinking",
              goal: "Background task",
            }),
          ],
        }),
      ],
    });
    const row = subagentRow(container, "sub-7");
    await userEvent.click(within(row).getByRole("button", { name: /stop/i }));
    // Optimistic local overlay: the row reads as stopping and offers no second stop.
    expect(within(row).getByText(/stopping/i)).toBeInTheDocument();
    expect(within(row).queryByRole("button", { name: /^stop/i })).toBeNull();
  });

  it("reconciles the optimistic 'stopping' overlay when the subagent later completes", async () => {
    const onStopSubagent = vi.fn().mockResolvedValue(undefined);
    const baseRecord = record({
      sessionId: "s1",
      subagentCount: 1,
      subagents: [
        subagent({
          subagentId: "sub-7",
          phase: "thinking",
          goal: "Background task",
        }),
      ],
    });
    const { container, rerender } = renderDrawer({
      onStopSubagent,
      records: [baseRecord],
    });
    await userEvent.click(
      within(subagentRow(container, "sub-7")).getByRole("button", {
        name: /stop/i,
      }),
    );
    expect(
      within(subagentRow(container, "sub-7")).getByText(/stopping/i),
    ).toBeInTheDocument();

    // A later complete event flows through the store -> new records prop.
    rerender(
      <AgentActivityDrawer
        open
        records={[
          record({
            sessionId: "s1",
            subagentCount: 1,
            subagents: [
              subagent({
                subagentId: "sub-7",
                phase: "complete",
                goal: "Background task",
                resultPreview: "Wrapped up",
              }),
            ],
          }),
        ]}
        status="ready"
        now={NOW}
        titleForSession={() => undefined}
        onOpenSession={vi.fn()}
        onStopSession={vi.fn()}
        onSteerSession={vi.fn()}
        onStopSubagent={onStopSubagent}
        onClose={vi.fn()}
      />,
    );

    const row = subagentRow(container, "sub-7");
    // The terminal phase wins: no lingering "stopping", the row reads complete.
    expect(within(row).queryByText(/stopping/i)).toBeNull();
    expect(within(row).getByText(/complete/i)).toBeInTheDocument();
  });

  it("marks the row complete (no noisy failure) when Hermes says the subagent already finished", async () => {
    // interruptSubagent rejects because the subagent already completed. The row
    // must settle as complete, never show an error.
    const onStopSubagent = vi
      .fn()
      .mockRejectedValue(new Error("subagent already complete"));
    const { container } = renderDrawer({
      onStopSubagent,
      records: [
        record({
          sessionId: "s1",
          subagentCount: 1,
          subagents: [
            subagent({
              subagentId: "sub-7",
              phase: "thinking",
              goal: "Background task",
            }),
          ],
        }),
      ],
    });
    const row = subagentRow(container, "sub-7");
    await userEvent.click(within(row).getByRole("button", { name: /stop/i }));
    // No error surface in the row; it reconciles quietly (the eventual store
    // event resolves the phase). The optimistic stopping overlay is cleared.
    expect(within(row).queryByText(/error/i)).toBeNull();
    expect(within(row).queryByText(/failed/i)).toBeNull();
  });
});
