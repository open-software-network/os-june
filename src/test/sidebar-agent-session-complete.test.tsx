import { act, render, screen, within } from "@testing-library/react";
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

// The sidebar refreshes the session→profile map before applying a session list,
// and only commits the sessions once that resolves.
vi.mock("../lib/tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/tauri")>()),
  listSessionProfiles: vi.fn(async () => []),
}));

const sessions: HermesSessionInfo[] = [
  {
    id: "session-completed",
    title: "Completed session",
    preview: "Finished work",
    last_active: "2026-06-04T13:00:00Z",
  },
  {
    id: "session-active",
    title: "Active session",
    preview: "Ongoing work",
    last_active: "2026-06-04T12:00:00Z",
  },
];

const notes: NoteListItemDto[] = [];

async function renderSidebar(overrides: Partial<Parameters<typeof Sidebar>[0]> = {}) {
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

  // The sidebar commits the list only after its session→profile refresh
  // resolves, so flush that microtask before asserting.
  await act(async () => {
    window.dispatchEvent(
      new CustomEvent(AGENT_SESSIONS_CHANGED_EVENT, {
        detail: {
          sessions,
          selectedSessionId: "session-active",
          workingSessionIds: [],
        },
      }),
    );
    await Promise.resolve();
  });
}

describe("Sidebar agent session completion actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.removeItem("june:pinned-agent-session-ids");
  });

  it("files completed sessions outside the active list", async () => {
    const user = userEvent.setup();
    await renderSidebar({
      completedSessionIds: { "session-completed": "2026-06-04T14:00:00Z" },
    });

    const activeSessions = screen.getByRole("region", { name: "Sessions" });
    expect(within(activeSessions).queryByText("Completed session")).not.toBeInTheDocument();
    expect(within(activeSessions).getByText("Active session")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Completed" }));

    const completedSessions = screen.getByRole("region", { name: "Completed agent sessions" });
    expect(within(completedSessions).getByText("Completed session")).toBeInTheDocument();
    expect(within(completedSessions).queryByText("Active session")).not.toBeInTheDocument();
  });

  it("marks an active session as complete", async () => {
    const user = userEvent.setup();
    const onToggleSessionCompleted = vi.fn();
    await renderSidebar({ onToggleSessionCompleted });

    await user.click(await screen.findByRole("button", { name: "Actions for Active session" }));
    await user.click(screen.getByRole("menuitem", { name: "Mark as complete" }));

    expect(onToggleSessionCompleted).toHaveBeenCalledWith("session-active", true);
  });

  it("marks a completed session as active", async () => {
    const user = userEvent.setup();
    const onToggleSessionCompleted = vi.fn();
    await renderSidebar({
      completedSessionIds: { "session-completed": "2026-06-04T14:00:00Z" },
      onToggleSessionCompleted,
    });

    await user.click(screen.getByRole("button", { name: "Completed" }));
    await user.click(await screen.findByRole("button", { name: "Actions for Completed session" }));
    await user.click(screen.getByRole("menuitem", { name: "Mark as active" }));

    expect(onToggleSessionCompleted).toHaveBeenCalledWith("session-completed", false);
  });
});
