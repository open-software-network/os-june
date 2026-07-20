import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createRef } from "react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AGENT_DELETE_SESSION_EVENT,
  AGENT_NEW_SESSION_EVENT,
  AGENT_SESSIONS_CHANGED_EVENT,
} from "../components/agent/AgentWorkspace";
import { MoveNoteToFolderDialog } from "../components/folders/MoveNoteToFolderDialog";
import { NotesList, type NotesListHandle } from "../components/notes-list/NotesList";
import { Sidebar } from "../components/sidebar/Sidebar";
import type { FolderDto, NoteListItemDto } from "../lib/tauri";

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

vi.mock("../lib/tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/tauri")>()),
  listSessionProfiles: vi.fn(async () => []),
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
    (window as unknown as { __sidebarStates?: (show?: boolean) => string }).__sidebarStates?.(
      false,
    );
    window.localStorage.removeItem("june:pinned-agent-session-ids");
    hermesMocks.listHermesSessions.mockResolvedValue([]);
    hermesMocks.deleteHermesSession.mockResolvedValue(undefined);
  });

  it("renders the primary entries and starts agent sessions from the sidebar", async () => {
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
        onRenameAgentSession={vi.fn()}
        onSelectAgentSession={vi.fn()}
      />,
    );

    expect(screen.getByRole("img", { name: "June" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Meeting notes" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Folders" })).toBeNull();
    expect(screen.getByRole("button", { name: "Sessions" })).toBeInTheDocument();

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
        onRenameAgentSession={vi.fn()}
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

    await user.click(screen.getByRole("button", { name: "Researching Google" }));

    expect(onChangeView).not.toHaveBeenCalled();
    expect(onSelectAgentSession).toHaveBeenCalledWith(expect.objectContaining({ id: "session-1" }));
  });

  it("marks new session active until an existing agent session is selected", async () => {
    const user = userEvent.setup();
    const onNewAgentSession = vi.fn();
    render(
      <Sidebar
        notes={notes}
        activeView="agent"
        onChangeView={vi.fn()}
        onSelectNote={vi.fn()}
        onDeleteNote={vi.fn()}
        onOpenMoveDialog={vi.fn()}
        onRemoveNoteFromFolder={vi.fn()}
        onNewAgentSession={onNewAgentSession}
        onRenameAgentSession={vi.fn()}
        onSelectAgentSession={vi.fn()}
      />,
    );

    const newSessionButton = screen.getByRole("button", {
      name: "New session",
    });
    expect(newSessionButton).toHaveAttribute("data-active", "true");
    expect(newSessionButton).toHaveAttribute("aria-current", "page");

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

    await screen.findByText("Researching Google");
    expect(newSessionButton).not.toHaveAttribute("data-active");
    expect(newSessionButton).not.toHaveAttribute("aria-current");

    await user.click(newSessionButton);

    expect(onNewAgentSession).toHaveBeenCalledTimes(1);
    expect(newSessionButton).toHaveAttribute("data-active", "true");
    expect(newSessionButton).toHaveAttribute("aria-current", "page");
  });

  it("pins agent sessions in a dedicated sidebar section", async () => {
    const user = userEvent.setup();
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
      />,
    );

    act(() => {
      window.dispatchEvent(
        new CustomEvent(AGENT_SESSIONS_CHANGED_EVENT, {
          detail: {
            sessions: [
              {
                id: "session-1",
                title: "Fetch os platform issues",
                preview: "Check open issues",
                last_active: "2026-06-04T19:00:00Z",
              },
              {
                id: "session-2",
                title: "Review onboarding",
                preview: "Audit first run",
                last_active: "2026-06-04T18:00:00Z",
              },
            ],
            selectedSessionId: "session-1",
            workingSessionIds: [],
          },
        }),
      );
    });

    const row = (await screen.findByText("Fetch os platform issues")).closest(
      ".agent-sidebar-row",
    ) as HTMLElement;
    expect(row).not.toBeNull();

    await user.click(
      within(row).getByRole("button", {
        name: "Actions for Fetch os platform issues",
      }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Pin session" }));

    expect(screen.getByRole("region", { name: "Pinned agent sessions" })).toBeInTheDocument();
    expect(
      within(screen.getByRole("region", { name: "Pinned agent sessions" })).getByText(
        "Fetch os platform issues",
      ),
    ).toBeInTheDocument();
    expect(window.localStorage.getItem("june:pinned-agent-session-ids")).toBe('["session-1"]');

    await user.click(
      within(screen.getByRole("region", { name: "Pinned agent sessions" })).getByRole("button", {
        name: "Actions for Fetch os platform issues",
      }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Unpin session" }));

    expect(screen.queryByRole("region", { name: "Pinned agent sessions" })).toBeNull();
    expect(window.localStorage.getItem("june:pinned-agent-session-ids")).toBe("[]");
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
          onRenameAgentSession={vi.fn()}
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
        onRenameAgentSession={vi.fn()}
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
        onRenameAgentSession={vi.fn()}
        onSelectAgentSession={vi.fn()}
      />,
    );

    const sidebarStates = (window as unknown as { __sidebarStates?: (show?: boolean) => string })
      .__sidebarStates;
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

    await waitFor(() => expect(screen.getByText("No sessions yet")).toBeInTheDocument());
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
        onRenameAgentSession={vi.fn()}
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
        onRenameAgentSession={vi.fn()}
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

    await user.click(screen.getByRole("button", { name: "Actions for Researching Google" }));
    await user.click(screen.getByRole("menuitem", { name: "Delete session" }));
    const dialog = await screen.findByRole("dialog", {
      name: 'Delete "Researching Google"?',
    });
    expect(within(dialog).getByText("This agent session cannot be restored.")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Delete session" }));

    await waitFor(() => expect(hermesMocks.deleteHermesSession).toHaveBeenCalledWith("session-1"));
    await waitFor(() => expect(screen.queryByText("Researching Google")).toBeNull());
    await waitFor(() => expect(onDeleteAgentSession).toHaveBeenCalled());
    const detail = (onDeleteAgentSession.mock.calls[0][0] as CustomEvent).detail;
    expect(detail).toEqual({ sessionId: "session-1" });

    window.removeEventListener(AGENT_DELETE_SESSION_EVENT, onDeleteAgentSession);
  });

  it("shows notes with placeholders and selects notes", async () => {
    const user = userEvent.setup();
    const onSelectNote = vi.fn();
    const { container } = render(
      <NotesList
        notes={notes}
        onSelectNote={onSelectNote}
        onCreateNote={vi.fn()}
        onOpenMoveDialog={vi.fn()}
        onOpenMoveNotes={vi.fn()}
        onDeleteNote={vi.fn()}
        onDeleteNotes={vi.fn()}
      />,
    );
    const list = within(container.querySelector(".all-notes-list") as HTMLElement);

    expect(list.getByRole("button", { name: /^Second/ })).toBeInTheDocument();
    expect(screen.queryByText("Ideas")).not.toBeInTheDocument();

    await user.click(list.getByRole("button", { name: /^Second/ }));
    expect(onSelectNote).toHaveBeenCalledWith("note-2");
  });

  it("shows the recording row state only for the active recording note", () => {
    render(
      <NotesList
        notes={[
          {
            ...notes[0],
            id: "stale-note",
            title: "Stale take",
            preview: "",
            processingStatus: "recording",
          },
          {
            ...notes[1],
            id: "active-note",
            title: "Active take",
            preview: "",
            processingStatus: "recording",
          },
        ]}
        activeRecordingNoteId="active-note"
        onSelectNote={vi.fn()}
        onCreateNote={vi.fn()}
        onOpenMoveDialog={vi.fn()}
        onOpenMoveNotes={vi.fn()}
        onDeleteNote={vi.fn()}
        onDeleteNotes={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: /Active take Recording/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Stale take Draft/ })).toBeInTheDocument();
    expect(screen.getAllByText("Recording")).toHaveLength(1);
  });

  it("keeps only one meeting actions menu open", async () => {
    const user = userEvent.setup();
    render(
      <NotesList
        notes={notes}
        onSelectNote={vi.fn()}
        onCreateNote={vi.fn()}
        onOpenMoveDialog={vi.fn()}
        onOpenMoveNotes={vi.fn()}
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
    expect(screen.getAllByRole("menuitem", { name: "Move to project" })).toHaveLength(1);
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
          onOpenMoveNotes={vi.fn()}
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
        onOpenMoveNotes={vi.fn()}
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
        onOpenMoveNotes={vi.fn()}
        onDeleteNote={vi.fn()}
        onDeleteNotes={vi.fn()}
      />,
    );

    expect(screen.getByText("Capture your first meeting")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create your first note" })).toBeInTheDocument();
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
        onOpenMoveNotes={vi.fn()}
        onDeleteNote={vi.fn()}
        onDeleteNotes={onDeleteNotes}
      />,
    );

    expect(screen.queryByRole("button", { name: "Select" })).toBeNull();
    expect(screen.getByRole("checkbox", { name: "Select Second" })).toBeInTheDocument();

    await user.click(screen.getByRole("checkbox", { name: "Select Second" }));
    await user.click(screen.getByRole("checkbox", { name: "Select New note" }));
    await user.click(screen.getByRole("button", { name: "Delete" }));
    await user.click(screen.getByRole("button", { name: "Delete notes" }));

    expect(onDeleteNotes).toHaveBeenCalledWith(["note-2", "note-1"]);

    // A confirmed delete clears the selection and slides the bar out.
    const bar = screen.getByRole("toolbar", { name: "Selection" });
    expect(bar).toHaveAttribute("data-exit", "slide");
    fireEvent.animationEnd(bar, {
      animationName: "meetings-bulk-bar-out-slide",
    });
    expect(screen.queryByRole("toolbar", { name: "Selection" })).toBeNull();
  });

  it("opens the move dialog with every selected meeting", async () => {
    const user = userEvent.setup();
    const onOpenMoveNotes = vi.fn();
    render(
      <NotesList
        notes={notes}
        onSelectNote={vi.fn()}
        onCreateNote={vi.fn()}
        onOpenMoveDialog={vi.fn()}
        onOpenMoveNotes={onOpenMoveNotes}
        onDeleteNote={vi.fn()}
        onDeleteNotes={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("checkbox", { name: "Select Second" }));
    await user.click(screen.getByRole("checkbox", { name: "Select New note" }));
    await user.click(screen.getByRole("button", { name: "Move" }));

    expect(onOpenMoveNotes).toHaveBeenCalledWith(["note-2", "note-1"]);
  });

  it("can clear selected meetings after a bulk move succeeds", async () => {
    const user = userEvent.setup();
    const notesListRef = createRef<NotesListHandle>();
    render(
      <NotesList
        ref={notesListRef}
        notes={notes}
        onSelectNote={vi.fn()}
        onCreateNote={vi.fn()}
        onOpenMoveDialog={vi.fn()}
        onOpenMoveNotes={vi.fn()}
        onDeleteNote={vi.fn()}
        onDeleteNotes={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("checkbox", { name: "Select Second" }));
    await user.click(screen.getByRole("checkbox", { name: "Select New note" }));

    expect(screen.getByRole("toolbar", { name: "Selection" })).toHaveTextContent("2 selected");

    act(() => notesListRef.current?.resetSelection());

    const bar = screen.getByRole("toolbar", { name: "Selection" });
    expect(bar).toHaveAttribute("data-exit", "slide");
    fireEvent.animationEnd(bar, {
      animationName: "meetings-bulk-bar-out-slide",
    });
    expect(screen.queryByRole("toolbar", { name: "Selection" })).toBeNull();
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
        onOpenMoveNotes={vi.fn()}
        onDeleteNote={vi.fn()}
        onDeleteNotes={onDeleteNotes}
      />,
    );

    await user.click(screen.getByRole("checkbox", { name: "Select Second" }));
    await user.click(screen.getByRole("button", { name: "Select all" }));
    await user.click(screen.getByRole("button", { name: "Delete" }));
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
        onOpenMoveNotes={vi.fn()}
        onDeleteNote={vi.fn()}
        onDeleteNotes={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("checkbox", { name: "Select Second" }));
    await user.click(screen.getByRole("button", { name: "Select all" }));
    await user.click(screen.getByRole("button", { name: "Deselect all" }));

    // Deselect all empties the selection, so the bar fades out and unmounts
    // once its exit animation ends. jsdom never fires animation events, so
    // drive it manually.
    const bar = screen.getByRole("toolbar", { name: "Selection" });
    expect(bar).toHaveAttribute("data-exit", "fade");
    fireEvent.animationEnd(bar, {
      animationName: "meetings-bulk-bar-out-fade",
    });

    expect(screen.queryByRole("toolbar", { name: "Selection" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
    expect(screen.getByRole("checkbox", { name: "Select Second" })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Select New note" })).not.toBeChecked();
  });

  it("slides the bar out and unmounts it after clearing the selection", async () => {
    const user = userEvent.setup();
    render(
      <NotesList
        notes={notes}
        onSelectNote={vi.fn()}
        onCreateNote={vi.fn()}
        onOpenMoveDialog={vi.fn()}
        onOpenMoveNotes={vi.fn()}
        onDeleteNote={vi.fn()}
        onDeleteNotes={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("checkbox", { name: "Select Second" }));
    await user.click(screen.getByRole("button", { name: "Clear selection" }));

    // The × is a deliberate dismiss, so the bar slides out before unmounting.
    const bar = screen.getByRole("toolbar", { name: "Selection" });
    expect(bar).toHaveAttribute("data-exit", "slide");
    fireEvent.animationEnd(bar, {
      animationName: "meetings-bulk-bar-out-slide",
    });

    expect(screen.queryByRole("toolbar", { name: "Selection" })).toBeNull();
  });

  it("cancels the exit when a note is reselected mid-animation", async () => {
    const user = userEvent.setup();
    render(
      <NotesList
        notes={notes}
        onSelectNote={vi.fn()}
        onCreateNote={vi.fn()}
        onOpenMoveDialog={vi.fn()}
        onOpenMoveNotes={vi.fn()}
        onDeleteNote={vi.fn()}
        onDeleteNotes={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("checkbox", { name: "Select Second" }));
    await user.click(screen.getByRole("button", { name: "Clear selection" }));
    expect(screen.getByRole("toolbar", { name: "Selection" })).toHaveAttribute(
      "data-exit",
      "slide",
    );

    // Re-selecting mid-exit shows the live bar again.
    await user.click(screen.getByRole("checkbox", { name: "Select New note" }));
    const bar = screen.getByRole("toolbar", { name: "Selection" });
    expect(bar).not.toHaveAttribute("data-exit");
    expect(within(bar).getByText("1 selected")).toBeInTheDocument();
  });
});

describe("MoveNoteToFolderDialog", () => {
  const moveFolders: FolderDto[] = [
    {
      id: "folder-1",
      name: "Alpha",
      memoryDisabled: false,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "folder-2",
      name: "Beta",
      memoryDisabled: false,
      createdAt: now,
      updatedAt: now,
    },
  ];

  it("moves every selected note to the picked project", async () => {
    const user = userEvent.setup();
    const onSetFolder = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();
    const onMoved = vi.fn();
    render(
      <MoveNoteToFolderDialog
        open
        onClose={onClose}
        notes={notes}
        folders={moveFolders}
        onSetFolder={onSetFolder}
        onMoved={onMoved}
      />,
    );

    expect(screen.getByRole("heading", { name: "Move 2 meeting notes" })).toBeInTheDocument();

    await user.click(screen.getByRole("option", { name: /Beta/ }));
    await user.click(screen.getByRole("button", { name: "Move" }));

    expect(onSetFolder).toHaveBeenCalledTimes(2);
    expect(onSetFolder).toHaveBeenNthCalledWith(1, "note-2", "folder-2");
    expect(onSetFolder).toHaveBeenNthCalledWith(2, "note-1", "folder-2");
    expect(onMoved).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it("keeps single-note copy and excludes its current project", async () => {
    render(
      <MoveNoteToFolderDialog
        open
        onClose={vi.fn()}
        notes={[notes[0]]}
        folders={moveFolders}
        onSetFolder={vi.fn()}
      />,
    );

    expect(screen.getByRole("heading", { name: "Move meeting note" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /Alpha/ })).toBeNull();
    expect(screen.getByRole("option", { name: /Beta/ })).toBeInTheDocument();
  });

  it("lists the current project checked and unfiles the note when clicked", async () => {
    const user = userEvent.setup();
    const onRemoveFolder = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();
    const onMoved = vi.fn();
    render(
      <MoveNoteToFolderDialog
        open
        onClose={onClose}
        notes={[notes[0]]}
        folders={moveFolders}
        onSetFolder={vi.fn()}
        onRemoveFolder={onRemoveFolder}
        onMoved={onMoved}
      />,
    );

    const current = screen.getByRole("option", { name: "Remove from Alpha" });
    expect(current).toHaveAttribute("aria-selected", "true");

    await user.click(current);

    expect(onRemoveFolder).toHaveBeenCalledWith("note-2", "folder-1");
    expect(onMoved).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it("keeps the current project out of the list without an onRemoveFolder handler", () => {
    render(
      <MoveNoteToFolderDialog
        open
        onClose={vi.fn()}
        notes={[notes[0]]}
        folders={moveFolders}
        onSetFolder={vi.fn()}
      />,
    );

    expect(screen.queryByRole("option", { name: /Remove from/ })).toBeNull();
    expect(screen.queryByRole("option", { name: /Alpha/ })).toBeNull();
  });

  it("creates a project from the search query and files the note in it", async () => {
    const user = userEvent.setup();
    const created: FolderDto = {
      id: "folder-new",
      name: "Roadmap",
      memoryDisabled: false,
      createdAt: now,
      updatedAt: now,
    };
    const onCreateFolder = vi.fn().mockResolvedValue(created);
    const onSetFolder = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();
    const onMoved = vi.fn();
    render(
      <MoveNoteToFolderDialog
        open
        onClose={onClose}
        notes={[notes[1]]}
        folders={moveFolders}
        onSetFolder={onSetFolder}
        onCreateFolder={onCreateFolder}
        onMoved={onMoved}
      />,
    );

    await user.type(screen.getByPlaceholderText("Search or create project"), "Roadmap");
    await user.click(screen.getByRole("button", { name: "Create “Roadmap”" }));

    expect(onCreateFolder).toHaveBeenCalledWith("Roadmap");
    expect(onSetFolder).toHaveBeenCalledWith("note-1", "folder-new");
    expect(onMoved).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it("hides the create row when the query matches an existing project name", async () => {
    const user = userEvent.setup();
    render(
      <MoveNoteToFolderDialog
        open
        onClose={vi.fn()}
        notes={[notes[1]]}
        folders={moveFolders}
        onSetFolder={vi.fn()}
        onCreateFolder={vi.fn()}
      />,
    );

    await user.type(screen.getByPlaceholderText("Search or create project"), "alpha");

    expect(screen.queryByRole("button", { name: /^Create/ })).toBeNull();
    expect(screen.getByRole("option", { name: /Alpha/ })).toBeInTheDocument();
  });

  it("lets the user create their first project inline via Enter", async () => {
    const user = userEvent.setup();
    const created: FolderDto = {
      id: "folder-new",
      name: "Client work",
      memoryDisabled: false,
      createdAt: now,
      updatedAt: now,
    };
    const onCreateFolder = vi.fn().mockResolvedValue(created);
    const onSetFolder = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();
    render(
      <MoveNoteToFolderDialog
        open
        onClose={onClose}
        notes={[notes[1]]}
        folders={[]}
        onSetFolder={onSetFolder}
        onCreateFolder={onCreateFolder}
      />,
    );

    expect(screen.getByText("No projects yet. Type a name to create one.")).toBeInTheDocument();

    await user.type(screen.getByPlaceholderText("Search or create project"), "Client work{Enter}");

    expect(onCreateFolder).toHaveBeenCalledWith("Client work");
    expect(onSetFolder).toHaveBeenCalledWith("note-1", "folder-new");
    expect(onClose).toHaveBeenCalled();
  });

  it("keeps the dialog open when assignment fails after creating the project", async () => {
    const user = userEvent.setup();
    const created: FolderDto = {
      id: "folder-new",
      name: "Roadmap",
      memoryDisabled: false,
      createdAt: now,
      updatedAt: now,
    };
    const onCreateFolder = vi.fn().mockResolvedValue(created);
    const onSetFolder = vi.fn().mockRejectedValue(new Error("db locked"));
    const onClose = vi.fn();
    const onMoved = vi.fn();
    render(
      <MoveNoteToFolderDialog
        open
        onClose={onClose}
        notes={[notes[1]]}
        folders={[]}
        onSetFolder={onSetFolder}
        onCreateFolder={onCreateFolder}
        onMoved={onMoved}
      />,
    );

    await user.type(screen.getByPlaceholderText("Search or create project"), "Roadmap");
    await user.click(screen.getByRole("button", { name: "Create “Roadmap”" }));

    expect(onSetFolder).toHaveBeenCalledWith("note-1", "folder-new");
    expect(onMoved).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("keeps the dialog open when project creation fails", async () => {
    const user = userEvent.setup();
    const onCreateFolder = vi.fn().mockResolvedValue(undefined);
    const onSetFolder = vi.fn();
    const onClose = vi.fn();
    render(
      <MoveNoteToFolderDialog
        open
        onClose={onClose}
        notes={[notes[1]]}
        folders={[]}
        onSetFolder={onSetFolder}
        onCreateFolder={onCreateFolder}
      />,
    );

    await user.type(screen.getByPlaceholderText("Search or create project"), "Roadmap");
    await user.click(screen.getByRole("button", { name: "Create “Roadmap”" }));

    expect(onCreateFolder).toHaveBeenCalledWith("Roadmap");
    expect(onSetFolder).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });
});
