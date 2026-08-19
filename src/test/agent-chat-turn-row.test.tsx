import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AgentChatTurnRow } from "../components/agent/chat-turns/AgentChatTurnRow";
import type { AgentChatTurn } from "../lib/agent-chat-runtime";

describe("AgentChatTurnRow", () => {
  it("renders interleaved reasoning at its chronological direct-child position", () => {
    const turn: AgentChatTurn = {
      id: "interleaved-reasoning",
      role: "assistant",
      createdAt: "2026-08-07T21:00:04Z",
      status: "running",
      parts: [
        {
          type: "tool",
          id: "preview-call",
          name: "preview_file",
          text: "Previewed document.pdf",
          status: "complete",
        },
        {
          type: "reasoning",
          text: "I should ask before extracting the full document.",
          status: "complete",
        },
        {
          type: "approval",
          id: "approval-1",
          runId: "run-1",
          command: "run_shell pdftotext document.pdf -",
          description: "Clovy wants to extract text from the document.",
          allowPermanent: false,
          status: "pending",
        },
      ],
    };
    const { container } = render(
      <AgentChatTurnRow
        turn={turn}
        approvalSubmitting={{}}
        clarifySubmitting={{}}
        sudoSubmitting={{}}
        secretSubmitting={{}}
        thinkingOpen={() => false}
        onThinkingOpenChange={vi.fn()}
        onApproval={vi.fn()}
        onClarify={vi.fn()}
        onSudo={vi.fn()}
        onSecret={vi.fn()}
      />,
    );

    const body = container.querySelector(".agent-assistant-turn-body");
    expect(body).not.toBeNull();
    const childClasses = body ? [...body.children].slice(0, 3).map((child) => child.className) : [];
    expect(childClasses).toEqual([
      "agent-tool-stack",
      "agent-reasoning",
      "agent-approval-card agent-action-card",
    ]);
    expect(body?.querySelector(":scope > .agent-reasoning summary")?.textContent).toContain(
      "Thought",
    );
  });

  it("keeps interleaved tool and approval activity in chronological order", () => {
    const turn: AgentChatTurn = {
      id: "activity-cluster",
      role: "assistant",
      createdAt: "2026-08-07T21:00:04Z",
      status: "complete",
      parts: [
        {
          type: "tool",
          id: "preview-call",
          name: "preview_file",
          text: "Previewed document.pdf",
          status: "complete",
        },
        {
          type: "approval",
          id: "approval-1",
          runId: "run-1",
          command: "run_shell pdftotext document.pdf -",
          description: "Clovy wants to extract text from the document.",
          allowPermanent: false,
          choice: "once",
          status: "resolved",
        },
        {
          type: "tool",
          id: "shell-call",
          name: "run_shell",
          text: "Extracted 14 pages of text",
          status: "complete",
        },
      ],
    };
    const { container } = render(
      <AgentChatTurnRow
        turn={turn}
        approvalSubmitting={{}}
        clarifySubmitting={{}}
        sudoSubmitting={{}}
        secretSubmitting={{}}
        thinkingOpen={() => false}
        onThinkingOpenChange={vi.fn()}
        onApproval={vi.fn()}
        onClarify={vi.fn()}
        onSudo={vi.fn()}
        onSecret={vi.fn()}
        onBranch={vi.fn()}
      />,
    );

    const rows = [...container.querySelectorAll(".agent-tool-disclosure")];
    expect(rows.map((row) => row.querySelector(".agent-tool-name")?.textContent)).toEqual([
      "preview_file",
      "Approved once",
      "run_shell",
    ]);
    expect(container.querySelectorAll(".agent-turn-timestamp")).toHaveLength(1);
  });

  it("keeps disclosure state keyed to the first activity item as newer ids arrive", () => {
    const openKeys = new Set<string>();
    const onThinkingOpenChange = vi.fn((key: string, open: boolean) => {
      if (open) openKeys.add(key);
      else openKeys.delete(key);
    });
    const baseTurn: AgentChatTurn = {
      id: "tool-result-2",
      renderId: "reasoning-1",
      role: "assistant",
      createdAt: "2026-08-07T21:00:04Z",
      status: "complete",
      parts: [{ type: "reasoning", text: "Inspect the file", status: "complete" }],
    };
    const props = {
      approvalSubmitting: {},
      clarifySubmitting: {},
      sudoSubmitting: {},
      secretSubmitting: {},
      thinkingOpen: (key: string) => openKeys.has(key),
      onThinkingOpenChange,
      onApproval: vi.fn(),
      onClarify: vi.fn(),
      onSudo: vi.fn(),
      onSecret: vi.fn(),
    };
    const { container, rerender } = render(<AgentChatTurnRow {...props} turn={baseTurn} />);

    const disclosure = container.querySelector(".agent-reasoning") as HTMLDetailsElement | null;
    expect(disclosure).not.toBeNull();
    if (disclosure) {
      disclosure.open = true;
      fireEvent(disclosure, new Event("toggle"));
    }
    expect(onThinkingOpenChange).toHaveBeenLastCalledWith("turn:reasoning-1:thinking", true);

    rerender(
      <AgentChatTurnRow
        {...props}
        turn={{
          ...baseTurn,
          id: "message-1",
          parts: [
            ...baseTurn.parts,
            { type: "text", text: "The file is ready.", status: "complete" },
          ],
        }}
      />,
    );

    expect(container.querySelector(".agent-reasoning")?.hasAttribute("open")).toBe(true);
  });
});
