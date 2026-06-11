import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSessionsList } from "../components/agent/AgentSessionsList";
import { MoveSessionToProjectDialog } from "../components/folders/MoveSessionToProjectDialog";
import type { FolderDto, HermesSessionInfo } from "../lib/tauri";

const hermesMocks = vi.hoisted(() => ({
  deleteHermesSession: vi.fn(),
}));

vi.mock("../lib/hermes-adapter", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/hermes-adapter")>()),
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

const folders: FolderDto[] = [
  {
    id: "project-alpha",
    name: "Alpha",
    createdAt: "2026-06-04T10:00:00Z",
    updatedAt: "2026-06-04T10:00:00Z",
  },
  {
    id: "project-beta",
    name: "Beta",
    createdAt: "2026-06-04T10:00:00Z",
    updatedAt: "2026-06-04T10:00:00Z",
  },
];

describe("AgentSessionsList", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hermesMocks.deleteHermesSession.mockResolvedValue(undefined);
  });

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
        onOpenMoveSessions={vi.fn()}
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
    expect(list.querySelector(".agent-session-row")).toBeTruthy();
    expect(list.querySelector(".agent-session-row.all-notes-row")).toBeTruthy();
    expect(
      Array.from(list.querySelectorAll(".folder-note-title")).map((node) =>
        node.textContent?.trim(),
      ),
    ).toEqual(["Waiting session", "Running session", "Idle session"]);
  });

  it("selects agent sessions and moves them in list order", async () => {
    const user = userEvent.setup();
    const onOpenMoveSessions = vi.fn();
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
        onOpenMoveSessions={onOpenMoveSessions}
        onRemoveFromProject={vi.fn()}
      />,
    );

    await user.click(screen.getByLabelText("Select Waiting session"));
    await user.click(screen.getByLabelText("Select Running session"));

    expect(
      screen.getByRole("toolbar", { name: "Selection" }),
    ).toHaveTextContent("2 selected");

    await user.click(screen.getByRole("button", { name: "Move" }));

    expect(onOpenMoveSessions).toHaveBeenCalledWith([
      "waiting-session",
      "running-session",
    ]);
  });

  it("keeps the exiting bulk bar actions inert after selection clears", async () => {
    const user = userEvent.setup();
    const onOpenMoveSessions = vi.fn();
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
        onOpenMoveSessions={onOpenMoveSessions}
        onRemoveFromProject={vi.fn()}
      />,
    );

    await user.click(screen.getByLabelText("Select Waiting session"));
    await user.click(screen.getByRole("button", { name: "Deselect all" }));

    const bar = screen.getByRole("toolbar", { name: "Selection" });
    expect(bar).toHaveAttribute("data-exit", "fade");

    const moveButton = screen.getByRole("button", { name: "Move" });
    expect(moveButton).toBeDisabled();
    await user.click(moveButton);

    expect(onOpenMoveSessions).not.toHaveBeenCalled();
  });

  it("bulk deletes selected agent sessions", async () => {
    const user = userEvent.setup();
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
        onOpenMoveSessions={vi.fn()}
        onRemoveFromProject={vi.fn()}
      />,
    );

    await user.click(screen.getByLabelText("Select Waiting session"));
    await user.click(screen.getByLabelText("Select Running session"));
    await user.click(screen.getByRole("button", { name: "Delete" }));
    await user.click(screen.getByRole("button", { name: "Delete sessions" }));

    expect(hermesMocks.deleteHermesSession).toHaveBeenCalledTimes(2);
    expect(hermesMocks.deleteHermesSession).toHaveBeenNthCalledWith(
      1,
      "waiting-session",
    );
    expect(hermesMocks.deleteHermesSession).toHaveBeenNthCalledWith(
      2,
      "running-session",
    );
  });
});

describe("MoveSessionToProjectDialog", () => {
  it("moves every selected agent session to the picked project", async () => {
    const user = userEvent.setup();
    const onSetFolder = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();
    const onMoved = vi.fn();

    render(
      <MoveSessionToProjectDialog
        open
        onClose={onClose}
        sessions={[sessions[2], sessions[1]]}
        sessionFolderIds={{
          "waiting-session": ["project-alpha"],
          "running-session": ["project-alpha"],
        }}
        folders={folders}
        onSetFolder={onSetFolder}
        onMoved={onMoved}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "Move 2 sessions" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /Alpha/ })).toBeNull();

    await user.click(screen.getByRole("option", { name: /Beta/ }));
    await user.click(screen.getByRole("button", { name: "Move" }));

    expect(onSetFolder).toHaveBeenCalledTimes(2);
    expect(onSetFolder).toHaveBeenNthCalledWith(
      1,
      "waiting-session",
      "project-beta",
    );
    expect(onSetFolder).toHaveBeenNthCalledWith(
      2,
      "running-session",
      "project-beta",
    );
    expect(onMoved).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });
});
