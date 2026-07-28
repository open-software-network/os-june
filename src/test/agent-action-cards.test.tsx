import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ApprovalPart } from "../components/agent/chat-turns/AgentActionCards";

describe("agent action cards", () => {
  it("keeps the acting Google account visible on a pending mutation approval", () => {
    render(
      <ApprovalPart
        part={{
          type: "approval",
          id: "approval-1",
          command: 'send_email {"accountId":"work@example.com"}',
          description: "Send the drafted reply.",
          accountEmail: "work@example.com",
          allowPermanent: false,
          status: "pending",
        }}
        onApproval={vi.fn()}
      />,
    );

    expect(screen.getByText("work@example.com")).toBeVisible();
    expect(screen.getByText("Approval required")).toBeVisible();
  });
});
