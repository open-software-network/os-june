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
    (
      window as unknown as { __sidebarStates?: (show?: boolean) => string }
    ).__sidebarStates?.(false);
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

    expect(screen.getByText("June")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Meeting notes" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Folders" })).toBeNull();
    expect(screen.getByRole("button", { name: "Agent" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Meeting notes" }));
    await user.click(screen.getByRole("button", { name: "New session" }));

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

  it("retries initial agent session hydration when the bridge is still starting", async () => {
    vi.useFakeTimers();
    try {
      hermesMocks.listHermesSessions
        .mockRejectedValueOnce({
          code: "hermes_bridge_not_running",
          message: "Hermes bridge is not running.",
        })
        .mockResolvedValueOnce([
          {
            id: "session-1",
            title: "Existing session",
            preview: "Previous work",
            last_active: "2026-06-04T19:00:00Z",
          },
        ]);

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
          onSelectAgentSession={vi.fn()}
        />,
      );

      expect(hermesMocks.listHermesSessions).toHaveBeenCalledTimes(1);
      expect(screen.getByText("No sessions yet")).toBeInTheDocument();

      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      await act(async () => {
        await vi.runOnlyPendingTimersAsync();
        await Promise.resolve();
      });

      expect(hermesMocks.listHermesSessions).toHaveBeenCalledTimes(2);
      expect(screen.getByText("Existing session")).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
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

  it("seeds the sidebar state preview from the dev console hook", async () => {
    const onChangeView = vi.fn();
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
        onSelectAgentSession={vi.fn()}
      />,
    );

    const sidebarStates = (
      window as unknown as { __sidebarStates?: (show?: boolean) => string }
    ).__sidebarStates;
    expect(sidebarStates).toBeTypeOf("function");

    act(() => {
      sidebarStates?.();
    });

    expect(await screen.findByText("Selected session")).toBeInTheDocument();
    expect(screen.getByText("Working spinner")).toBeInTheDocument();
    expect(screen.getByLabelText("Working")).toBeInTheDocument();
    expect(screen.getByText("Needs you")).toBeInTheDocument();
    expect(screen.getByLabelText("Needs you")).toBeInTheDocument();
    expect(screen.getByText("New reply")).toBeInTheDocument();
    expect(screen.getByLabelText("New reply")).toBeInTheDocument();
    expect(screen.getByText("Recent timestamp")).toBeInTheDocument();
    expect(screen.getByText("Older timestamp")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Very long session title that should truncate cleanly before the right edge state slot",
      ),
    ).toBeInTheDocument();
    expect(onChangeView).toHaveBeenCalledWith("agent");

    act(() => {
      sidebarStates?.(false);
    });

    await waitFor(() =>
      expect(screen.getByText("No sessions yet")).toBeInTheDocument(),
    );
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
        onDeleteNotes={vi.fn()}
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

  it("keeps only one meeting actions menu open", async () => {
    const user = userEvent.setup();
    render(
      <NotesList
        notes={notes}
        onSelectNote={vi.fn()}
        onCreateNote={vi.fn()}
        onOpenMoveDialog={vi.fn()}
        onDeleteNote={vi.fn()}
        onDeleteNotes={vi.fn()}
      />,
    );

    const secondActions = screen.getByRole("button", {
      name: "Actions for Second",
    });
    const newMeetingActions = screen.getByRole("button", {
      name: "Actions for New note",
    });

    await user.click(secondActions);

    expect(screen.getAllByRole("menu")).toHaveLength(1);
    expect(secondActions).toHaveAttribute("aria-expanded", "true");

    await user.click(newMeetingActions);

    expect(screen.getAllByRole("menu")).toHaveLength(1);
    expect(secondActions).toHaveAttribute("aria-expanded", "false");
    expect(newMeetingActions).toHaveAttribute("aria-expanded", "true");
    expect(
      screen.getAllByRole("menuitem", { name: "Move to project" }),
    ).toHaveLength(1);
  });

  it("positions the meeting actions menu inside the viewport", async () => {
    const user = userEvent.setup();
    const originalInnerWidth = window.innerWidth;
    const originalInnerHeight = window.innerHeight;

    try {
      Object.defineProperty(window, "innerWidth", {
        configurable: true,
        value: 1000,
      });
      Object.defineProperty(window, "innerHeight", {
        configurable: true,
        value: 760,
      });
      render(
        <NotesList
          notes={notes}
          onSelectNote={vi.fn()}
          onCreateNote={vi.fn()}
          onOpenMoveDialog={vi.fn()}
          onDeleteNote={vi.fn()}
          onDeleteNotes={vi.fn()}
        />,
      );

      const actions = screen.getByRole("button", {
        name: "Actions for Second",
      });
      actions.getBoundingClientRect = vi.fn(
        () =>
          ({
            x: 900,
            y: 700,
            left: 900,
            right: 924,
            top: 700,
            bottom: 724,
            width: 24,
            height: 24,
            toJSON: () => ({}),
          }) as DOMRect,
      );

      await user.click(actions);

      const menu = screen.getByRole("menu");
      expect(menu).toHaveStyle({ right: "104px", top: "622px" });
    } finally {
      Object.defineProperty(window, "innerWidth", {
        configurable: true,
        value: originalInnerWidth,
      });
      Object.defineProperty(window, "innerHeight", {
        configurable: true,
        value: originalInnerHeight,
      });
    }
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
        onDeleteNotes={vi.fn()}
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
        onDeleteNotes={vi.fn()}
      />,
    );

    expect(screen.getByText("No notes yet.")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Create your first note" }),
    ).toBeInTheDocument();
  });

  it("bulk deletes selected meetings from the main list", async () => {
    const user = userEvent.setup();
    const onDeleteNotes = vi.fn();
    render(
      <NotesList
        notes={notes}
        onSelectNote={vi.fn()}
        onCreateNote={vi.fn()}
        onOpenMoveDialog={vi.fn()}
        onDeleteNote={vi.fn()}
        onDeleteNotes={onDeleteNotes}
      />,
    );

    expect(screen.queryByRole("button", { name: "Select" })).toBeNull();
    expect(
      screen.getByRole("checkbox", { name: "Select Second" }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("checkbox", { name: "Select Second" }));
    await user.click(screen.getByRole("checkbox", { name: "Select New note" }));
    await user.click(screen.getByRole("button", { name: "Delete 2 notes" }));
    await user.click(screen.getByRole("button", { name: "Delete notes" }));

    expect(onDeleteNotes).toHaveBeenCalledWith(["note-2", "note-1"]);
  });

  it("selects all visible meetings after one meeting is selected", async () => {
    const user = userEvent.setup();
    const onDeleteNotes = vi.fn();
    render(
      <NotesList
        notes={notes}
        onSelectNote={vi.fn()}
        onCreateNote={vi.fn()}
        onOpenMoveDialog={vi.fn()}
        onDeleteNote={vi.fn()}
        onDeleteNotes={onDeleteNotes}
      />,
    );

    await user.click(screen.getByRole("checkbox", { name: "Select Second" }));
    await user.click(screen.getByRole("button", { name: "Select all" }));
    await user.click(screen.getByRole("button", { name: "Delete 2 notes" }));
    await user.click(screen.getByRole("button", { name: "Delete notes" }));

    expect(onDeleteNotes).toHaveBeenCalledWith(["note-2", "note-1"]);
  });

  it("deselects all visible meetings after all visible meetings are selected", async () => {
    const user = userEvent.setup();
    render(
      <NotesList
        notes={notes}
        onSelectNote={vi.fn()}
        onCreateNote={vi.fn()}
        onOpenMoveDialog={vi.fn()}
        onDeleteNote={vi.fn()}
        onDeleteNotes={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("checkbox", { name: "Select Second" }));
    await user.click(screen.getByRole("button", { name: "Select all" }));
    await user.click(screen.getByRole("button", { name: "Deselect all" }));

    expect(screen.queryByRole("button", { name: "Delete 2 notes" })).toBeNull();
    expect(
      screen.getByRole("checkbox", { name: "Select Second" }),
    ).not.toBeChecked();
    expect(
      screen.getByRole("checkbox", { name: "Select New note" }),
    ).not.toBeChecked();
  });
});
