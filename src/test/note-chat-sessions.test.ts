import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentRunDto, AgentSessionDto } from "../lib/agent-runtime-contract";
import {
  forgetNoteChatSession,
  noteChatSessionIdFor,
  rememberNoteChatSession,
} from "../components/note-chat/noteChatSessions";

const mocks = vi.hoisted(() => ({
  createSession: vi.fn(),
  getSession: vi.fn(),
  listItems: vi.fn(),
  startRun: vi.fn(),
  cancelRun: vi.fn(),
  listen: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: mocks.listen,
}));

vi.mock("../lib/tauri", () => ({
  agentRuntimeBindings: {
    createSession: mocks.createSession,
    getSession: mocks.getSession,
    listItems: mocks.listItems,
    startRun: mocks.startRun,
    cancelRun: mocks.cancelRun,
  },
}));

import { useNoteChat } from "../components/note-chat/useNoteChat";

function session(overrides: Partial<AgentSessionDto> = {}): AgentSessionDto {
  return {
    id: "note-session",
    title: "Planning",
    status: "idle",
    model: "model-a",
    safetyMode: "sandboxed",
    workspacePath: "/tmp/june/workspace",
    source: "user",
    createdAt: "2026-07-22T00:00:00.000Z",
    updatedAt: "2026-07-22T00:00:00.000Z",
    ...overrides,
  };
}

function run(overrides: Partial<AgentRunDto> = {}): AgentRunDto {
  return {
    id: "run-1",
    sessionId: "note-session",
    status: "queued",
    model: "model-a",
    ...overrides,
  };
}

describe("note chat sessions", () => {
  beforeEach(() => {
    window.localStorage.clear();
    mocks.createSession.mockReset();
    mocks.getSession.mockReset();
    mocks.listItems.mockReset();
    mocks.startRun.mockReset();
    mocks.cancelRun.mockReset();
    mocks.cancelRun.mockResolvedValue(undefined);
    mocks.listen.mockReset();
    mocks.listen.mockResolvedValue(() => undefined);
  });

  it("remembers and forgets a note session pairing", () => {
    rememberNoteChatSession("note-a", "session-a");
    rememberNoteChatSession("note-b", "session-b");

    expect(noteChatSessionIdFor("note-a")).toBe("session-a");
    expect(noteChatSessionIdFor("note-b")).toBe("session-b");

    forgetNoteChatSession("note-a");
    expect(noteChatSessionIdFor("note-a")).toBeUndefined();
    expect(noteChatSessionIdFor("note-b")).toBe("session-b");
  });

  it("creates a sandboxed session and starts a run with the note reference", async () => {
    mocks.createSession.mockResolvedValue(session());
    mocks.startRun.mockResolvedValue(run());
    const { result } = renderHook(() => useNoteChat({ id: "note-1", title: "Planning" }));

    let response: Awaited<ReturnType<typeof result.current.submit>> | undefined;
    await act(async () => {
      response = await result.current.submit("What did we decide?", [
        { id: "file-1", name: "agenda.pdf", path: "/tmp/agenda.pdf" },
      ]);
    });

    expect(response).toEqual({ accepted: true, current: true });
    expect(mocks.createSession).toHaveBeenCalledWith({
      title: "Planning",
      model: "auto",
      safetyMode: "sandboxed",
    });
    expect(mocks.startRun).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "note-session",
        model: "auto",
        safetyMode: "sandboxed",
        attachments: ["/tmp/agenda.pdf"],
        prompt: expect.stringContaining("@note:note-1"),
      }),
    );
    expect(noteChatSessionIdFor("note-1")).toBe("note-session");
  });

  it("hydrates the saved session transcript", async () => {
    rememberNoteChatSession("note-1", "note-session");
    mocks.getSession.mockResolvedValue(session());
    mocks.listItems.mockResolvedValue([
      {
        id: "message-1",
        sessionId: "note-session",
        sequence: 1,
        createdAt: "2026-07-22T00:00:00.000Z",
        kind: "message",
        role: "assistant",
        text: "The decision is to ship Friday.",
        status: "complete",
      },
    ]);

    const { result } = renderHook(() => useNoteChat({ id: "note-1", title: "Planning" }));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.storedSessionId).toBe("note-session");
    expect(result.current.turns).toHaveLength(1);
    expect(result.current.turns[0]?.parts[0]).toMatchObject({
      type: "text",
      text: "The decision is to ship Friday.",
    });
  });

  it("cancels the active runtime run", async () => {
    mocks.createSession.mockResolvedValue(session());
    mocks.startRun.mockResolvedValue(run());
    const { result } = renderHook(() => useNoteChat({ id: "note-1", title: "Planning" }));

    await act(async () => {
      await result.current.submit("Summarize this note.");
    });
    act(() => result.current.stop());

    await waitFor(() => expect(mocks.cancelRun).toHaveBeenCalledWith("run-1"));
  });
});
