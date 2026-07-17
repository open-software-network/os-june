import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Sidebar } from "../components/sidebar/Sidebar";
import { AGENT_SESSIONS_CHANGED_EVENT } from "../lib/agent-events";
import {
  resetActiveHermesProfileForTests,
  setActiveHermesProfileName,
} from "../lib/active-hermes-profile";
import type { HermesSessionInfo } from "../lib/tauri";

vi.mock("../lib/hermes-adapter", () => ({
  deleteHermesSession: vi.fn(),
  listHermesSessions: vi.fn().mockResolvedValue([]),
  sessionTimestamp: (session: { last_active?: string; started_at?: string }) =>
    session.last_active ?? session.started_at ?? "",
}));

const mocks = vi.hoisted(() => ({
  listSessionProfiles: vi.fn(),
}));

vi.mock("../lib/tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/tauri")>()),
  listSessionProfiles: mocks.listSessionProfiles,
}));

const sessions: HermesSessionInfo[] = [
  {
    id: "default-chat",
    title: "Default chat",
    preview: "Belongs to the default profile",
    last_active: "2026-07-12T13:00:00Z",
  },
  {
    id: "work-chat",
    title: "Work chat",
    preview: "Belongs to the work profile",
    last_active: "2026-07-12T12:00:00Z",
  },
];

function renderSidebar() {
  render(
    <Sidebar
      notes={[]}
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
          sessions,
          workingSessionIds: [],
        },
      }),
    );
  });
}

describe("Sidebar profile-scoped chat list", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetActiveHermesProfileForTests();
    window.localStorage.removeItem("june:pinned-agent-session-ids");
    mocks.listSessionProfiles.mockResolvedValue([{ sessionId: "work-chat", profile: "work" }]);
  });

  it("shows only the active profile's chats and re-filters on switch", async () => {
    renderSidebar();

    // Default profile: unmapped sessions belong to default; work-mapped hidden.
    expect(await screen.findByText("Default chat")).toBeInTheDocument();
    expect(screen.queryByText("Work chat")).toBeNull();

    // Switching the active profile re-filters the already-loaded list without
    // a new sessions-changed event.
    act(() => {
      setActiveHermesProfileName("work");
    });
    expect(await screen.findByText("Work chat")).toBeInTheDocument();
    expect(screen.queryByText("Default chat")).toBeNull();

    act(() => {
      setActiveHermesProfileName("default");
    });
    expect(await screen.findByText("Default chat")).toBeInTheDocument();
    expect(screen.queryByText("Work chat")).toBeNull();
  });

  it("hides chats when the first profile map read fails", async () => {
    mocks.listSessionProfiles.mockRejectedValue(new Error("no tauri shell"));
    renderSidebar();

    await waitFor(() => expect(mocks.listSessionProfiles).toHaveBeenCalled());
    expect(screen.queryByText("Default chat")).toBeNull();
    expect(screen.queryByText("Work chat")).toBeNull();
  });
});
