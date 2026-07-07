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

const sessions: HermesSessionInfo[] = [
  {
    id: "session-recent",
    title: "Recent session",
    preview: "Done yesterday",
    last_active: "2026-06-04T13:00:00Z",
  },
  {
    id: "session-pinned",
    title: "Pinned session",
    preview: "Pinned work",
    last_active: "2026-06-04T12:00:00Z",
  },
];

const notes: NoteListItemDto[] = [];

function renderSidebar(onRenameAgentSession = vi.fn()) {
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
      onRenameAgentSession={onRenameAgentSession}
      onSelectAgentSession={vi.fn()}
    />,
  );

  act(() => {
    window.dispatchEvent(
      new CustomEvent(AGENT_SESSIONS_CHANGED_EVENT, {
        detail: {
          sessions,
          selectedSessionId: "session-recent",
          workingSessionIds: [],
        },
      }),
    );
  });
}

describe("Sidebar agent session rename", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.removeItem("june:pinned-agent-session-ids");
  });

  it("renames a recent agent session row from the context menu", async () => {
    const user = userEvent.setup();
    const onRenameAgentSession = vi.fn();
    renderSidebar(onRenameAgentSession);

    await user.click(await screen.findByRole("button", { name: "Actions for Recent session" }));
    await user.click(screen.getByRole("menuitem", { name: "Rename session" }));
    const input = screen.getByRole("textbox", { name: "Session name" });

    await user.clear(input);
    await user.type(input, "Manual sidebar name{Enter}");

    expect(onRenameAgentSession).toHaveBeenCalledWith("session-recent", "Manual sidebar name");
  });

  it("cancels a pinned agent session row rename on Escape", async () => {
    const user = userEvent.setup();
    const onRenameAgentSession = vi.fn();
    window.localStorage.setItem(
      "june:pinned-agent-session-ids",
      JSON.stringify(["session-pinned"]),
    );
    renderSidebar(onRenameAgentSession);

    await user.click(await screen.findByRole("button", { name: "Actions for Pinned session" }));
    await user.click(screen.getByRole("menuitem", { name: "Rename session" }));
    await user.type(screen.getByRole("textbox", { name: "Session name" }), "{Escape}");

    expect(onRenameAgentSession).not.toHaveBeenCalled();
    expect(screen.getByText("Pinned session")).toBeInTheDocument();
  });
});
