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
  sessionTimestamp: (session: HermesSessionInfo) => session.last_active ?? session.started_at ?? "",
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
    memoryDisabled: false,
    createdAt: "2026-06-04T10:00:00Z",
    updatedAt: "2026-06-04T10:00:00Z",
  },
  {
    id: "project-beta",
    name: "Beta",
    memoryDisabled: false,
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
        onRenameSession={vi.fn()}
        onOpenMoveDialog={vi.fn()}
        onOpenMoveSessions={vi.fn()}
        onRemoveFromProject={vi.fn()}
      />,
    );

    expect(screen.getByRole("status", { name: "Needs you" })).toHaveTextContent("Needs you");
    expect(screen.getByRole("status", { name: "Working" })).toHaveTextContent("Working");
    expect(screen.getByRole("status", { name: "Needs you" })).not.toHaveClass("folder-note-time");
    expect(screen.getByRole("status", { name: "Working" })).not.toHaveClass("folder-note-time");

    const list = screen.getByRole("list");
    expect(list.querySelector(".agent-session-row")).toBeTruthy();
    expect(list.querySelector(".agent-session-row.all-notes-row")).toBeTruthy();
    expect(
      Array.from(list.querySelectorAll(".folder-note-title")).map((node) =>
        node.textContent?.trim(),
      ),
    ).toEqual(["Waiting session", "Running session", "Idle session"]);
  });

  it("moves completed sessions out of the active list into the Completed group", async () => {
    const user = userEvent.setup();
    render(
      <AgentSessionsList
        sessions={sessions}
        folders={[]}
        sessionFolderIds={{}}
        completedSessionIds={{ "idle-session": "2026-06-05T10:00:00Z" }}
        onSelectSession={vi.fn()}
        onNewSession={vi.fn()}
        onRenameSession={vi.fn()}
        onOpenMoveDialog={vi.fn()}
        onOpenMoveSessions={vi.fn()}
        onRemoveFromProject={vi.fn()}
      />,
    );

    const activeList = screen.getByRole("list");
    expect(activeList).not.toHaveTextContent("Idle session");

    await user.click(screen.getByRole("button", { name: /Completed/ }));

    const lists = screen.getAllByRole("list");
    expect(lists).toHaveLength(2);
    expect(lists[1]).toHaveTextContent("Idle session");
    expect(lists[0]).not.toHaveTextContent("Idle session");
  });

  it("does not expose selection for completed session rows", async () => {
    const user = userEvent.setup();
    render(
      <AgentSessionsList
        sessions={sessions}
        folders={[]}
        sessionFolderIds={{}}
        completedSessionIds={{ "idle-session": "2026-06-05T10:00:00Z" }}
        onSelectSession={vi.fn()}
        onNewSession={vi.fn()}
        onRenameSession={vi.fn()}
        onOpenMoveDialog={vi.fn()}
        onOpenMoveSessions={vi.fn()}
        onRemoveFromProject={vi.fn()}
      />,
    );

    // Active rows are selectable...
    expect(screen.getByLabelText("Select Running session")).toBeInTheDocument();
    // ...but a completed row exposes no selection checkbox, so it can never
    // enter the bulk selection.
    await user.click(screen.getByRole("button", { name: /Completed/ }));
    expect(screen.queryByLabelText("Select Idle session")).not.toBeInTheDocument();
  });

  it("marks active and completed sessions from their row menus", async () => {
    const user = userEvent.setup();
    const onToggleCompleted = vi.fn();
    render(
      <AgentSessionsList
        sessions={sessions}
        folders={[]}
        sessionFolderIds={{}}
        completedSessionIds={{ "idle-session": "2026-06-05T10:00:00Z" }}
        onToggleCompleted={onToggleCompleted}
        onSelectSession={vi.fn()}
        onNewSession={vi.fn()}
        onRenameSession={vi.fn()}
        onOpenMoveDialog={vi.fn()}
        onOpenMoveSessions={vi.fn()}
        onRemoveFromProject={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Actions for Running session" }));
    await user.click(screen.getByRole("menuitem", { name: "Mark as complete" }));
    expect(onToggleCompleted).toHaveBeenCalledWith("running-session", true);

    await user.click(screen.getByRole("button", { name: /Completed/ }));
    await user.click(screen.getByRole("button", { name: "Actions for Idle session" }));
    await user.click(screen.getByRole("menuitem", { name: "Mark as active" }));
    expect(onToggleCompleted).toHaveBeenCalledWith("idle-session", false);
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
        onRenameSession={vi.fn()}
        onOpenMoveDialog={vi.fn()}
        onOpenMoveSessions={onOpenMoveSessions}
        onRemoveFromProject={vi.fn()}
      />,
    );

    await user.click(screen.getByLabelText("Select Waiting session"));
    await user.click(screen.getByLabelText("Select Running session"));

    expect(screen.getByRole("toolbar", { name: "Selection" })).toHaveTextContent("2 selected");

    await user.click(screen.getByRole("button", { name: "Move" }));

    expect(onOpenMoveSessions).toHaveBeenCalledWith(["waiting-session", "running-session"]);
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
        onRenameSession={vi.fn()}
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
        onRenameSession={vi.fn()}
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
    expect(hermesMocks.deleteHermesSession).toHaveBeenNthCalledWith(1, "waiting-session");
    expect(hermesMocks.deleteHermesSession).toHaveBeenNthCalledWith(2, "running-session");
  });

  it("drops a session from the bulk selection when it is marked complete", async () => {
    const user = userEvent.setup();
    const props = {
      sessions,
      folders: [] as FolderDto[],
      sessionFolderIds: {},
      workingSessionIds: new Set(["running-session"]),
      waitingSessionIds: new Set(["waiting-session"]),
      onSelectSession: vi.fn(),
      onNewSession: vi.fn(),
      onRenameSession: vi.fn(),
      onOpenMoveDialog: vi.fn(),
      onOpenMoveSessions: vi.fn(),
      onRemoveFromProject: vi.fn(),
    };
    const { rerender } = render(<AgentSessionsList {...props} />);

    await user.click(screen.getByLabelText("Select Waiting session"));
    await user.click(screen.getByLabelText("Select Running session"));
    expect(screen.getByRole("toolbar", { name: "Selection" })).toHaveTextContent("2 selected");

    // Waiting session becomes complete: it must leave the selection so a bulk
    // delete can no longer wipe it along with the still-active selection.
    rerender(
      <AgentSessionsList
        {...props}
        completedSessionIds={{ "waiting-session": "2026-06-05T10:00:00Z" }}
      />,
    );
    expect(screen.getByRole("toolbar", { name: "Selection" })).toHaveTextContent("1 selected");

    await user.click(screen.getByRole("button", { name: "Delete" }));
    await user.click(screen.getByRole("button", { name: "Delete session" }));

    expect(hermesMocks.deleteHermesSession).toHaveBeenCalledTimes(1);
    expect(hermesMocks.deleteHermesSession).toHaveBeenCalledWith("running-session");
  });

  it("keeps the bulk selection when a search hides a selected session", async () => {
    const user = userEvent.setup();
    render(
      <AgentSessionsList
        sessions={sessions}
        folders={[]}
        sessionFolderIds={{}}
        onSelectSession={vi.fn()}
        onNewSession={vi.fn()}
        onRenameSession={vi.fn()}
        onOpenMoveDialog={vi.fn()}
        onOpenMoveSessions={vi.fn()}
        onRemoveFromProject={vi.fn()}
      />,
    );

    await user.click(screen.getByLabelText("Select Waiting session"));
    await user.click(screen.getByLabelText("Select Running session"));
    expect(screen.getByRole("toolbar", { name: "Selection" })).toHaveTextContent("2 selected");

    // A search that hides "Waiting session" must not drop it from the selection;
    // the query only affects what's visible, not what's selected.
    await user.type(screen.getByPlaceholderText("Search"), "Running");
    expect(screen.queryByText("Waiting session")).not.toBeInTheDocument();
    expect(screen.getByRole("toolbar", { name: "Selection" })).toHaveTextContent("2 selected");
  });

  it("renames a session row from the action menu", async () => {
    const user = userEvent.setup();
    const onRenameSession = vi.fn();
    render(
      <AgentSessionsList
        sessions={sessions}
        folders={[]}
        sessionFolderIds={{}}
        onSelectSession={vi.fn()}
        onNewSession={vi.fn()}
        onRenameSession={onRenameSession}
        onOpenMoveDialog={vi.fn()}
        onOpenMoveSessions={vi.fn()}
        onRemoveFromProject={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Actions for Idle session" }));
    await user.click(screen.getByRole("menuitem", { name: "Rename" }));
    expect(screen.getByRole("dialog", { name: "Rename session" })).toBeInTheDocument();
    const input = screen.getByRole("textbox", { name: "Session name" });

    await user.clear(input);
    await user.type(input, "Manual session name{Enter}");

    expect(onRenameSession).toHaveBeenCalledWith("idle-session", "Manual session name");
  });

  it("cancels row rename on Escape", async () => {
    const user = userEvent.setup();
    const onRenameSession = vi.fn();
    render(
      <AgentSessionsList
        sessions={sessions}
        folders={[]}
        sessionFolderIds={{}}
        onSelectSession={vi.fn()}
        onNewSession={vi.fn()}
        onRenameSession={onRenameSession}
        onOpenMoveDialog={vi.fn()}
        onOpenMoveSessions={vi.fn()}
        onRemoveFromProject={vi.fn()}
      />,
    );

    await user.click(screen.getByLabelText("Select Idle session"));
    await user.click(screen.getByRole("button", { name: "Actions for Idle session" }));
    await user.click(screen.getByRole("menuitem", { name: "Rename" }));
    await user.type(screen.getByRole("textbox", { name: "Session name" }), "{Escape}");

    expect(onRenameSession).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog", { name: "Rename session" })).not.toBeInTheDocument();
    expect(screen.getByRole("toolbar", { name: "Selection" })).toHaveTextContent("1 selected");
    expect(screen.getByText("Idle session")).toBeInTheDocument();
  });

  it("does not commit unchanged or empty row rename text", async () => {
    const user = userEvent.setup();
    const onRenameSession = vi.fn();
    const { rerender } = render(
      <AgentSessionsList
        sessions={sessions}
        folders={[]}
        sessionFolderIds={{}}
        onSelectSession={vi.fn()}
        onNewSession={vi.fn()}
        onRenameSession={onRenameSession}
        onOpenMoveDialog={vi.fn()}
        onOpenMoveSessions={vi.fn()}
        onRemoveFromProject={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Actions for Idle session" }));
    await user.click(screen.getByRole("menuitem", { name: "Rename" }));
    await user.type(screen.getByRole("textbox", { name: "Session name" }), "{Enter}");

    rerender(
      <AgentSessionsList
        sessions={sessions}
        folders={[]}
        sessionFolderIds={{}}
        onSelectSession={vi.fn()}
        onNewSession={vi.fn()}
        onRenameSession={onRenameSession}
        onOpenMoveDialog={vi.fn()}
        onOpenMoveSessions={vi.fn()}
        onRemoveFromProject={vi.fn()}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Actions for Idle session" }));
    await user.click(screen.getByRole("menuitem", { name: "Rename" }));
    await user.clear(screen.getByRole("textbox", { name: "Session name" }));
    expect(screen.getByRole("button", { name: "Rename" })).toBeDisabled();
    await user.type(screen.getByRole("textbox", { name: "Session name" }), "{Enter}");

    expect(onRenameSession).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Rename session" })).toBeInTheDocument();
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

    expect(screen.getByRole("heading", { name: "Move 2 sessions" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /Alpha/ })).toBeNull();

    await user.click(screen.getByRole("option", { name: /Beta/ }));
    await user.click(screen.getByRole("button", { name: "Move" }));

    expect(onSetFolder).toHaveBeenCalledTimes(2);
    expect(onSetFolder).toHaveBeenNthCalledWith(1, "waiting-session", "project-beta");
    expect(onSetFolder).toHaveBeenNthCalledWith(2, "running-session", "project-beta");
    expect(onMoved).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it("creates a project from the search query and files the session in it", async () => {
    const user = userEvent.setup();
    const created: FolderDto = {
      id: "project-new",
      name: "Roadmap",
      memoryDisabled: false,
      createdAt: "2026-06-04T10:00:00Z",
      updatedAt: "2026-06-04T10:00:00Z",
    };
    const onCreateFolder = vi.fn().mockResolvedValue(created);
    const onSetFolder = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();
    const onMoved = vi.fn();

    render(
      <MoveSessionToProjectDialog
        open
        onClose={onClose}
        sessions={[sessions[0]]}
        sessionFolderIds={{}}
        folders={[]}
        onSetFolder={onSetFolder}
        onCreateFolder={onCreateFolder}
        onMoved={onMoved}
      />,
    );

    expect(screen.getByText("No projects yet. Type a name to create one.")).toBeInTheDocument();

    await user.type(screen.getByPlaceholderText("Search or create project"), "Roadmap");
    await user.click(screen.getByRole("button", { name: "Create “Roadmap”" }));

    expect(onCreateFolder).toHaveBeenCalledWith("Roadmap");
    expect(onSetFolder).toHaveBeenCalledWith("idle-session", "project-new");
    expect(onMoved).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });
});
