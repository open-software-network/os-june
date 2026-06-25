import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { PendingActionTray } from "../components/agent/PendingActionTray";
import type { PendingActionRecord } from "../lib/hermes-pending-actions";

function record(
  partial: Partial<PendingActionRecord> & Pick<PendingActionRecord, "action">,
): PendingActionRecord {
  const sessionId = partial.sessionId ?? "s1";
  const requestId = partial.requestId ?? partial.action.requestId;
  const mode = partial.mode ?? "sandboxed";
  return {
    key: `${mode}:${sessionId}:${requestId}`,
    mode,
    sessionId,
    requestId,
    firstSeenAt: Date.UTC(2026, 5, 24, 12, 0, 0),
    lastSeenAt: Date.UTC(2026, 5, 24, 12, 0, 0),
    status: "open",
    ...partial,
    action: partial.action,
  };
}

const clarify = record({
  sessionId: "s1",
  mode: "sandboxed",
  action: { kind: "clarify", requestId: "r1", question: "Which file?" },
});
const approval = record({
  sessionId: "s2",
  mode: "unrestricted",
  action: {
    kind: "approval",
    requestId: "r2",
    toolName: "write_file",
    description: "Overwrite config.json",
  },
});

describe("PendingActionTray", () => {
  it("renders nothing when there are no open actions", () => {
    const { container } = render(
      <PendingActionTray
        records={[]}
        titleForSession={() => "x"}
        onOpenAction={vi.fn()}
        now={Date.UTC(2026, 5, 24, 12, 0, 0)}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("two actions in two sessions render two rows under a 'Needs you' heading", () => {
    render(
      <PendingActionTray
        records={[clarify, approval]}
        titleForSession={(id) => (id === "s1" ? "Refactor auth" : "Fix tests")}
        onOpenAction={vi.fn()}
        now={Date.UTC(2026, 5, 24, 12, 0, 30)}
      />,
    );
    // The surface is labeled "Needs you" (sentence case).
    expect(
      screen.getByRole("region", { name: "Needs you" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Needs you")).toBeInTheDocument();
    const rows = screen.getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    // Count badge reflects the number of open actions.
    expect(screen.getByText("2")).toBeInTheDocument();
  });

  it("shows the session title, falling back to the id when unknown", () => {
    render(
      <PendingActionTray
        records={[clarify, approval]}
        // s2 has no known title → the row must fall back to the id, not crash.
        titleForSession={(id) => (id === "s1" ? "Refactor auth" : undefined)}
        onOpenAction={vi.fn()}
        now={Date.UTC(2026, 5, 24, 12, 0, 30)}
      />,
    );
    expect(screen.getByText("Refactor auth")).toBeInTheDocument();
    // Fallback shows the session id somewhere in the row.
    expect(screen.getByText(/s2/)).toBeInTheDocument();
  });

  it("distinguishes sandboxed vs unrestricted mode per row", () => {
    render(
      <PendingActionTray
        records={[clarify, approval]}
        titleForSession={() => "session"}
        onOpenAction={vi.fn()}
        now={Date.UTC(2026, 5, 24, 12, 0, 30)}
      />,
    );
    expect(screen.getByText("Sandboxed")).toBeInTheDocument();
    expect(screen.getByText("Unrestricted")).toBeInTheDocument();
  });

  it("labels each action type and renders its description", () => {
    render(
      <PendingActionTray
        records={[clarify, approval]}
        titleForSession={() => "session"}
        onOpenAction={vi.fn()}
        now={Date.UTC(2026, 5, 24, 12, 0, 30)}
      />,
    );
    expect(screen.getByText("Needs clarification")).toBeInTheDocument();
    expect(screen.getByText("Approval needed")).toBeInTheDocument();
    expect(screen.getByText("Which file?")).toBeInTheDocument();
    expect(screen.getByText("Overwrite config.json")).toBeInTheDocument();
  });

  it("clicking a row's open button invokes onOpenAction with session + request", async () => {
    const user = userEvent.setup();
    const onOpenAction = vi.fn();
    render(
      <PendingActionTray
        records={[clarify]}
        titleForSession={() => "Refactor auth"}
        onOpenAction={onOpenAction}
        now={Date.UTC(2026, 5, 24, 12, 0, 30)}
      />,
    );
    await user.click(screen.getByRole("button", { name: /respond/i }));
    expect(onOpenAction).toHaveBeenCalledWith({
      sessionId: "s1",
      requestId: "r1",
    });
  });

  it("a secret row shows the requested key but never a value", () => {
    const secret = record({
      sessionId: "s3",
      action: {
        kind: "secret",
        requestId: "r9",
        keyName: "OPENAI_API_KEY",
        reason: "to call the API",
        redacted: true,
      },
    });
    render(
      <PendingActionTray
        records={[secret]}
        titleForSession={() => "Deploy"}
        onOpenAction={vi.fn()}
        now={Date.UTC(2026, 5, 24, 12, 0, 30)}
      />,
    );
    expect(screen.getByText("Secret requested")).toBeInTheDocument();
    expect(screen.getByText(/OPENAI_API_KEY/)).toBeInTheDocument();
    // No value affordance — the row never renders a secret value.
    const row = screen.getByRole("listitem");
    expect(within(row).queryByText(/sk-/)).not.toBeInTheDocument();
  });

  it("renders a stale action visibly but marks it distinct", () => {
    const stale = record({
      sessionId: "s4",
      status: "stale",
      action: { kind: "clarify", requestId: "r4", question: "Still there?" },
    });
    render(
      <PendingActionTray
        records={[stale]}
        titleForSession={() => "Reconnected"}
        onOpenAction={vi.fn()}
        now={Date.UTC(2026, 5, 24, 12, 0, 30)}
      />,
    );
    const row = screen.getByRole("listitem");
    // Visible …
    expect(within(row).getByText("Still there?")).toBeInTheDocument();
    // … but flagged distinct (data attribute the CSS dims) and surfaced to AT.
    expect(row).toHaveAttribute("data-stale", "true");
    expect(within(row).getByText(/unconfirmed/i)).toBeInTheDocument();
  });

  it("shows the age of each action from the provided clock", () => {
    render(
      <PendingActionTray
        records={[clarify]}
        titleForSession={() => "Refactor auth"}
        onOpenAction={vi.fn()}
        // 90s after firstSeen → "1m ago" (no typographic dash, plain copy).
        now={Date.UTC(2026, 5, 24, 12, 1, 30)}
      />,
    );
    expect(screen.getByText(/ago/)).toBeInTheDocument();
  });
});
