import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AgentSessionsList } from "../components/agent/AgentSessionsList";
import type { HermesSessionInfo } from "../lib/tauri";

const hermesMocks = vi.hoisted(() => ({
  deleteHermesSession: vi.fn(),
}));

vi.mock("../lib/hermes-adapter", () => ({
  deleteHermesSession: hermesMocks.deleteHermesSession,
  sessionTimestamp: (session: HermesSessionInfo) =>
    session.last_active ?? session.started_at ?? "",
}));

const sessions: HermesSessionInfo[] = [
  {
    id: "idle-session",
    title: "Idle session",
    preview: "Done yesterday",
    last_active: "2026-06-04T13:00:00Z",
  },
  {
    id: "running-session",
    title: "Running session",
    preview: "Working from CLI",
    last_active: "2026-06-04T12:00:00Z",
  },
  {
    id: "waiting-session",
    title: "Waiting session",
    preview: "Needs permission",
    last_active: "2026-06-04T11:00:00Z",
  },
];

describe("AgentSessionsList", () => {
  it("surfaces active session status and sorts active work first", () => {
    render(
      <AgentSessionsList
        sessions={sessions}
        folders={[]}
        sessionFolderIds={{}}
        workingSessionIds={new Set(["running-session"])}
        waitingSessionIds={new Set(["waiting-session"])}
        onSelectSession={vi.fn()}
        onNewSession={vi.fn()}
        onOpenMoveDialog={vi.fn()}
        onRemoveFromProject={vi.fn()}
      />,
    );

    expect(screen.getByRole("status", { name: "Needs you" })).toHaveTextContent(
      "Needs you",
    );
    expect(screen.getByRole("status", { name: "Working" })).toHaveTextContent(
      "Working",
    );
    expect(screen.getByRole("status", { name: "Needs you" })).not.toHaveClass(
      "folder-note-time",
    );
    expect(screen.getByRole("status", { name: "Working" })).not.toHaveClass(
      "folder-note-time",
    );

    const list = screen.getByRole("list");
    expect(
      Array.from(list.querySelectorAll(".folder-note-title")).map((node) =>
        node.textContent?.trim(),
      ),
    ).toEqual(["Waiting session", "Running session", "Idle session"]);
  });
});
