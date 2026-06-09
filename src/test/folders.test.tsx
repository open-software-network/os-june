import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AGENT_DELETE_SESSION_EVENT,
  AGENT_NEW_SESSION_EVENT,
  AGENT_SESSIONS_CHANGED_EVENT,
} from "../components/agent/AgentWorkspace";
import { NotesList } from "../components/notes-list/NotesList";
import { Sidebar } from "../components/sidebar/Sidebar";
import type { NoteListItemDto } from "../lib/tauri";

const hermesMocks = vi.hoisted(() => ({
  deleteHermesSession: vi.fn(),
  listHermesSessions: vi.fn(),
}));

vi.mock("../lib/hermes-adapter", () => ({
  deleteHermesSession: hermesMocks.deleteHermesSession,
  listHermesSessions: hermesMocks.listHermesSessions,
  sessionTimestamp: (session: { last_active?: string; started_at?: string }) =>
    session.last_active ?? session.started_at ?? "",
}));

const now = "2026-05-19T10:00:00Z";

const notes: NoteListItemDto[] = [
  {
    id: "note-2",
    title: "Second",
    preview: "Second preview",
    processingStatus: "ready",
    folderIds: ["folder-1"],
    createdAt: "2026-05-19T11:00:00Z",
    updatedAt: "2026-05-19T11:00:00Z",
  },
  {
    id: "note-1",
    title: "",
    preview: "",
    processingStatus: "draft",
    folderIds: [],
    createdAt: now,
    updatedAt: now,
  },
];

describe("folders UI", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hermesMocks.listHermesSessions.mockResolvedValue([]);
    hermesMocks.deleteHermesSession.mockResolvedValue(undefined);
  });

  it("renders the notes entry and starts agent sessions from the sidebar", async () => {
    const user = userEvent.setup();
    const onChangeView = vi.fn();
    const onNewSession = vi.fn();
    window.addEventListener(AGENT_NEW_SESSION_EVENT, onNewSession);
    render(
      <Sidebar
        notes={notes}
        activeView="notes"
        onChangeView={onChangeView}
        onSelectNote={vi.fn()}
        onDeleteNote={vi.fn()}
        onOpenMoveDialog={vi.fn()}
        onRemoveNoteFromFolder={vi.fn()}
        onNewAgentSession={() => onChangeView("agent")}
        onSelectAgentSession={vi.fn()}
      />,
    );

    expect(screen.getByText("OS June")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Notes" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Folders" })).toBeNull();
    expect(screen.getByRole("button", { name: "Agent" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Notes" }));
    await user.click(screen.getByRole("button", { name: "New Session" }));

    expect(onChangeView).toHaveBeenCalledWith("notes");
    expect(onChangeView).toHaveBeenCalledWith("agent");
    await waitFor(() => expect(onNewSession).toHaveBeenCalled());

    window.removeEventListener(AGENT_NEW_SESSION_EVENT, onNewSession);
  });

  it("renders agent sessions in the sidebar and selects them", async () => {
    const user = userEvent.setup();
    const onChangeView = vi.fn();
    const onSelectAgentSession = vi.fn();
    render(
      <Sidebar
        notes={notes}
        activeView="notes"
        onChangeView={onChangeView}
        onSelectNote={vi.fn()}
        onDeleteNote={vi.fn()}
        onOpenMoveDialog={vi.fn()}
        onRemoveNoteFromFolder={vi.fn()}
        onNewAgentSession={vi.fn()}
        onSelectAgentSession={onSelectAgentSession}
      />,
    );

    act(() => {
      window.dispatchEvent(
        new CustomEvent(AGENT_SESSIONS_CHANGED_EVENT, {
          detail: {
            sessions: [
              {
                id: "session-1",
                title: "Researching Google",
                preview: "Generate a PDF",
                last_active: "2026-06-04T19:00:00Z",
              },
            ],
            selectedSessionId: "session-1",
            workingSessionIds: ["session-1"],
          },
        }),
      );
    });

    expect(await screen.findByText("Researching Google")).toBeInTheDocument();
    expect(screen.getByLabelText("Working")).toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: /Researching Google/ }),
    );

    expect(onChangeView).not.toHaveBeenCalled();
    expect(onSelectAgentSession).toHaveBeenCalledWith(
      expect.objectContaining({ id: "session-1" }),
    );
  });

  it("marks agent sessions that need input", async () => {
    render(
      <Sidebar
        notes={notes}
        activeView="agent"
        onChangeView={vi.fn()}
        onSelectNote={vi.fn()}
        onDeleteNote={vi.fn()}
        onOpenMoveDialog={vi.fn()}
        onRemoveNoteFromFolder={vi.fn()}
        onNewAgentSession={vi.fn()}
        onSelectAgentSession={vi.fn()}
      />,
    );

    act(() => {
      window.dispatchEvent(
        new CustomEvent(AGENT_SESSIONS_CHANGED_EVENT, {
          detail: {
            sessions: [
              {
                id: "session-1",
                title: "Update website",
                preview: "",
                last_active: "2026-06-04T19:00:00Z",
              },
            ],
            selectedSessionId: "session-1",
            workingSessionIds: ["session-1"],
            waitingSessionIds: ["session-1"],
          },
        }),
      );
    });

    expect(await screen.findByText("Update website")).toBeInTheDocument();
    expect(screen.getByLabelText("Needs you")).toBeInTheDocument();
    expect(screen.queryByLabelText("Working")).toBeNull();
  });

  it("keeps the sidebar agent session list capped after workspace refreshes", async () => {
    render(
      <Sidebar
        notes={notes}
        activeView="agent"
        onChangeView={vi.fn()}
        onSelectNote={vi.fn()}
        onDeleteNote={vi.fn()}
        onOpenMoveDialog={vi.fn()}
        onRemoveNoteFromFolder={vi.fn()}
        onNewAgentSession={vi.fn()}
        onSelectAgentSession={vi.fn()}
      />,
    );

    const sessions = Array.from({ length: 13 }, (_, index) => ({
      id: `session-${index + 1}`,
      title: `Agent session ${index + 1}`,
      preview: "",
      last_active: `2026-06-04T19:${String(59 - index).padStart(2, "0")}:00Z`,
    }));

    act(() => {
      window.dispatchEvent(
        new CustomEvent(AGENT_SESSIONS_CHANGED_EVENT, {
          detail: {
            sessions,
            selectedSessionId: "session-1",
            workingSessionIds: [],
          },
        }),
      );
    });

    expect(await screen.findByText("Agent session 1")).toBeInTheDocument();
    expect(screen.getByText("Agent session 12")).toBeInTheDocument();
    expect(screen.queryByText("Agent session 13")).toBeNull();
  });

  it("deletes agent sessions from the sidebar action", async () => {
    const user = userEvent.setup();
    const onDeleteAgentSession = vi.fn();
    window.addEventListener(AGENT_DELETE_SESSION_EVENT, onDeleteAgentSession);
    render(
      <Sidebar
        notes={notes}
        activeView="agent"
        onChangeView={vi.fn()}
        onSelectNote={vi.fn()}
        onDeleteNote={vi.fn()}
        onOpenMoveDialog={vi.fn()}
        onRemoveNoteFromFolder={vi.fn()}
        onNewAgentSession={vi.fn()}
        onSelectAgentSession={vi.fn()}
      />,
    );

    act(() => {
      window.dispatchEvent(
        new CustomEvent(AGENT_SESSIONS_CHANGED_EVENT, {
          detail: {
            sessions: [
              {
                id: "session-1",
                title: "Researching Google",
                preview: "Generate a PDF",
                last_active: "2026-06-04T19:00:00Z",
              },
            ],
            selectedSessionId: "session-1",
            workingSessionIds: [],
          },
        }),
      );
    });

    expect(await screen.findByText("Researching Google")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Delete session" }));
    const dialog = await screen.findByRole("dialog", {
      name: 'Delete "Researching Google"?',
    });
    expect(
      within(dialog).getByText("This agent session cannot be restored."),
    ).toBeInTheDocument();
    await user.click(
      within(dialog).getByRole("button", { name: "Delete session" }),
    );

    await waitFor(() =>
      expect(hermesMocks.deleteHermesSession).toHaveBeenCalledWith("session-1"),
    );
    await waitFor(() =>
      expect(screen.queryByText("Researching Google")).toBeNull(),
    );
    await waitFor(() => expect(onDeleteAgentSession).toHaveBeenCalled());
    const detail = (onDeleteAgentSession.mock.calls[0][0] as CustomEvent)
      .detail;
    expect(detail).toEqual({ sessionId: "session-1" });

    window.removeEventListener(
      AGENT_DELETE_SESSION_EVENT,
      onDeleteAgentSession,
    );
  });

  it("shows notes with placeholders and selects notes", async () => {
    const user = userEvent.setup();
    const onSelectNote = vi.fn();
    const { container } = render(
      <NotesList
        notes={notes}
        selectedNoteId="note-2"
        onSelectNote={onSelectNote}
        onCreateNote={vi.fn()}
        onOpenMoveDialog={vi.fn()}
        onDeleteNote={vi.fn()}
      />,
    );
    const list = within(
      container.querySelector(".all-notes-list") as HTMLElement,
    );

    expect(list.getByRole("button", { name: /^Second/ })).toBeInTheDocument();
    expect(screen.queryByText("Ideas")).not.toBeInTheDocument();

    await user.click(list.getByRole("button", { name: /^Second/ }));
    expect(onSelectNote).toHaveBeenCalledWith("note-2");
  });

  it("labels future-dated notes explicitly", () => {
    render(
      <NotesList
        notes={[
          {
            ...notes[0],
            id: "future-note",
            updatedAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
          },
        ]}
        onSelectNote={vi.fn()}
        onCreateNote={vi.fn()}
        onOpenMoveDialog={vi.fn()}
        onDeleteNote={vi.fn()}
      />,
    );

    expect(screen.getByText("Future")).toBeInTheDocument();
  });

  it("shows empty state with create action", () => {
    render(
      <NotesList
        notes={[]}
        onSelectNote={vi.fn()}
        onCreateNote={vi.fn()}
        onOpenMoveDialog={vi.fn()}
        onDeleteNote={vi.fn()}
      />,
    );

    expect(screen.getByText("No notes yet.")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Create your first note" }),
    ).toBeInTheDocument();
  });
});
