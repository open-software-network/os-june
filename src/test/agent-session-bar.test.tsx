import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AgentSessionBar } from "../components/agent/chat-turns/AgentSessionBar";

describe("AgentSessionBar", () => {
  it("keeps core session actions without legacy runtime controls", () => {
    render(
      <AgentSessionBar
        title="Plan the launch"
        onRename={vi.fn()}
        onShare={vi.fn()}
        onMoveToProject={vi.fn()}
        onDelete={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Session actions" }));

    expect(screen.getByRole("menuitem", { name: "Rename" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Share" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Add to project" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Delete session" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Usage" })).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Compact context" })).not.toBeInTheDocument();
    expect(screen.queryByText("Debug with runtime TUI")).not.toBeInTheDocument();
  });
});
