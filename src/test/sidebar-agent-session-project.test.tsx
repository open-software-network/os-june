import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AGENT_SESSIONS_CHANGED_EVENT } from "../components/agent/AgentWorkspace";
import { Sidebar } from "../components/sidebar/Sidebar";
import type { HermesSessionInfo, NoteListItemDto } from "../lib/tauri";

vi.mock("../lib/hermes-adapter", () => ({
  deleteHermesSession: vi.fn(),
  listHermesSessions: vi.fn().mockResolvedValue([]),
  sessionTimestamp: (session: { last_active?: string; started_at?: string }) =>
    session.last_active ?? session.started_at ?? "",
}));

vi.mock("../lib/tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/tauri")>()),
  listSessionProfiles: vi.fn(async () => []),
}));

const sessions: HermesSessionInfo[] = [
  {
    id: "session-filed",
    title: "Filed session",
    preview: "In a project",
    last_active: "2026-06-04T13:00:00Z",
  },
  {
    id: "session-loose",
    title: "Loose session",
    preview: "No project",
    last_active: "2026-06-04T12:00:00Z",
  },
];

const notes: NoteListItemDto[] = [];

function renderSidebar(overrides: Partial<Parameters<typeof Sidebar>[0]> = {}) {
  render(
    <Sidebar
      notes={notes}
      activeView="notes"
      onChangeView={vi.fn()}
      onSelectNote={vi.fn()}
      onDeleteNote={vi.fn()}
      onOpenMoveDialog={vi.fn()}
      onRemoveNoteFromFolder={vi.fn()}
      onNewAgentSession={vi.fn()}
      onRenameAgentSession={vi.fn()}
      onSelectAgentSession={vi.fn()}
      {...overrides}
    />,
  );

  act(() => {
    window.dispatchEvent(
      new CustomEvent(AGENT_SESSIONS_CHANGED_EVENT, {
        detail: {
          sessions,
          selectedSessionId: "session-filed",
          workingSessionIds: [],
        },
      }),
    );
  });
}

describe("Sidebar agent session project actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.removeItem("june:pinned-agent-session-ids");
  });

  it("offers Add to project for a session outside any project", async () => {
    const user = userEvent.setup();
    const onOpenSessionMoveDialog = vi.fn();
    renderSidebar({ sessionFolderIds: {}, onOpenSessionMoveDialog });

    await user.click(await screen.findByRole("button", { name: "Actions for Loose session" }));
    await user.click(screen.getByRole("menuitem", { name: "Add to project" }));

    expect(onOpenSessionMoveDialog).toHaveBeenCalledWith("session-loose");
    expect(screen.queryByRole("menuitem", { name: "Remove from project" })).not.toBeInTheDocument();
  });

  it("offers Change project and Remove from project for a filed session", async () => {
    const user = userEvent.setup();
    const onOpenSessionMoveDialog = vi.fn();
    const onRemoveSessionFromFolder = vi.fn();
    renderSidebar({
      sessionFolderIds: { "session-filed": ["folder-1"] },
      onOpenSessionMoveDialog,
      onRemoveSessionFromFolder,
    });

    await user.click(await screen.findByRole("button", { name: "Actions for Filed session" }));
    expect(screen.getByRole("menuitem", { name: "Change project" })).toBeInTheDocument();

    await user.click(screen.getByRole("menuitem", { name: "Remove from project" }));
    expect(onRemoveSessionFromFolder).toHaveBeenCalledWith("session-filed", "folder-1");
  });

  it("omits project items when the handlers are not wired", async () => {
    const user = userEvent.setup();
    renderSidebar();

    await user.click(await screen.findByRole("button", { name: "Actions for Loose session" }));
    expect(screen.getByRole("menuitem", { name: "Rename session" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Add to project" })).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Remove from project" })).not.toBeInTheDocument();
  });
});
