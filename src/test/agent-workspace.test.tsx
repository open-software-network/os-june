import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AGENT_DELETE_SESSION_EVENT,
  AGENT_NEW_SESSION_EVENT,
  AGENT_NEW_SESSION_PENDING_KEY,
  AGENT_SESSIONS_CHANGED_EVENT,
  AgentWorkspace,
  type AgentSessionsChangedDetail,
} from "../components/agent/AgentWorkspace";

const mocks = vi.hoisted(() => ({
  cancelAgentTask: vi.fn(),
  createAgentTask: vi.fn(),
  ensureHermesBridgeSession: vi.fn(),
  getAgentTask: vi.fn(),
  hermesBridgeFilesystemSnapshot: vi.fn(),
  hermesBridgeFilePreview: vi.fn(),
  hermesBridgeMessagingPlatforms: vi.fn(),
  hermesBridgeSkills: vi.fn(),
  hermesBridgeStatus: vi.fn(),
  hermesBridgeToolsets: vi.fn(),
  importHermesBridgeFile: vi.fn(),
  importHermesBridgeFileBytes: vi.fn(),
  listAgentTasks: vi.fn(),
  downloadHermesBridgeFile: vi.fn(),
  retryAgentTask: vi.fn(),
  saveAgentAssistantMessage: vi.fn(),
  saveAgentHermesSession: vi.fn(),
  sendAgentMessage: vi.fn(),
  startHermesBridge: vi.fn(),
  suggestAgentSessionTitle: vi.fn(),
  toggleHermesBridgeSkill: vi.fn(),
  toggleHermesBridgeToolset: vi.fn(),
  updateHermesBridgeMessagingPlatform: vi.fn(),
  deleteHermesSession: vi.fn(),
  listHermesSessionMessages: vi.fn(),
  listHermesSessions: vi.fn(),
  gatewayRequest: vi.fn(),
  gatewayEventHandlers: new Set<(event: Record<string, unknown>) => void>(),
  eventHandlers: new Map<
    string,
    (event: { payload?: { paths?: string[] } }) => void
  >(),
  listen: vi.fn(
    async (
      eventName: string,
      handler: (event: { payload?: { paths?: string[] } }) => void,
    ) => {
      mocks.eventHandlers.set(eventName, handler);
      return () => mocks.eventHandlers.delete(eventName);
    },
  ),
}));

vi.mock("../lib/tauri", () => ({
  cancelAgentTask: mocks.cancelAgentTask,
  createAgentTask: mocks.createAgentTask,
  ensureHermesBridgeSession: mocks.ensureHermesBridgeSession,
  getAgentTask: mocks.getAgentTask,
  hermesBridgeFilesystemSnapshot: mocks.hermesBridgeFilesystemSnapshot,
  hermesBridgeFilePreview: mocks.hermesBridgeFilePreview,
  hermesBridgeMessagingPlatforms: mocks.hermesBridgeMessagingPlatforms,
  hermesBridgeSkills: mocks.hermesBridgeSkills,
  hermesBridgeStatus: mocks.hermesBridgeStatus,
  hermesBridgeToolsets: mocks.hermesBridgeToolsets,
  importHermesBridgeFile: mocks.importHermesBridgeFile,
  importHermesBridgeFileBytes: mocks.importHermesBridgeFileBytes,
  listAgentTasks: mocks.listAgentTasks,
  downloadHermesBridgeFile: mocks.downloadHermesBridgeFile,
  retryAgentTask: mocks.retryAgentTask,
  saveAgentAssistantMessage: mocks.saveAgentAssistantMessage,
  saveAgentHermesSession: mocks.saveAgentHermesSession,
  sendAgentMessage: mocks.sendAgentMessage,
  startHermesBridge: mocks.startHermesBridge,
  suggestAgentSessionTitle: mocks.suggestAgentSessionTitle,
  toggleHermesBridgeSkill: mocks.toggleHermesBridgeSkill,
  toggleHermesBridgeToolset: mocks.toggleHermesBridgeToolset,
  updateHermesBridgeMessagingPlatform:
    mocks.updateHermesBridgeMessagingPlatform,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: mocks.listen,
}));

vi.mock("../lib/hermes-adapter", () => ({
  deleteHermesSession: mocks.deleteHermesSession,
  listHermesSessionMessages: mocks.listHermesSessionMessages,
  listHermesSessions: mocks.listHermesSessions,
  sessionTimestamp: (session: { last_active?: string; started_at?: string }) =>
    session.last_active ?? session.started_at ?? "",
  titleFromPrompt: (prompt: string) => prompt.trim() || "Untitled session",
}));

vi.mock("../lib/hermes-gateway", () => ({
  HermesGatewayClient: class {
    connect = vi.fn();
    close = vi.fn();
    onEvent = vi.fn((handler: (event: Record<string, unknown>) => void) => {
      mocks.gatewayEventHandlers.add(handler);
      return () => mocks.gatewayEventHandlers.delete(handler);
    });
    onClose = vi.fn(() => vi.fn());
    request = mocks.gatewayRequest;
  },
}));

const existingTask = {
  id: "task-1",
  title: "Existing task",
  prompt: "Existing task",
  status: "completed",
  progressSummary: "",
  createdAt: "2026-06-04T12:00:00Z",
  updatedAt: "2026-06-04T12:00:00Z",
  messages: [],
  toolEvents: [],
};

const existingSession = {
  id: "session-1",
  title: "Existing session",
  preview: "Existing preview",
  last_active: "2026-06-04T12:00:00Z",
};

describe("AgentWorkspace", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.gatewayEventHandlers.clear();
    window.sessionStorage.clear();
    window.localStorage.clear();
    mocks.listAgentTasks.mockResolvedValue({ items: [existingTask] });
    mocks.getAgentTask.mockResolvedValue(existingTask);
    mocks.hermesBridgeStatus.mockResolvedValue({
      running: true,
      connection: { port: 61234, wsUrl: "ws://127.0.0.1:61234" },
    });
    mocks.startHermesBridge.mockResolvedValue({
      running: true,
      connection: { port: 61234, wsUrl: "ws://127.0.0.1:61234" },
    });
    mocks.listHermesSessions.mockResolvedValue([existingSession]);
    mocks.listHermesSessionMessages.mockResolvedValue([]);
    mocks.hermesBridgeFilesystemSnapshot.mockResolvedValue({ roots: [] });
    mocks.hermesBridgeFilePreview.mockResolvedValue(null);
    mocks.importHermesBridgeFile.mockImplementation(async (path: string) => ({
      name: path.split("/").pop() ?? "attachment",
      path: `/Users/junho/Library/Application Support/co.opensoftware.scribe/hermes/workspace/uploads/${path.split("/").pop() ?? "attachment"}`,
      rootLabel: "Workspace",
      size: 1234,
      previewDataUrl: path.endsWith(".png")
        ? "data:image/png;base64,preview"
        : null,
    }));
    mocks.importHermesBridgeFileBytes.mockImplementation(
      async (name: string) => ({
        name,
        path: `/Users/junho/Library/Application Support/co.opensoftware.scribe/hermes/workspace/uploads/${name}`,
        rootLabel: "Workspace",
        size: 5,
        previewDataUrl: null,
      }),
    );
    mocks.downloadHermesBridgeFile.mockResolvedValue(
      "/Users/junho/Downloads/sample.pdf",
    );
    mocks.ensureHermesBridgeSession.mockResolvedValue({});
    mocks.deleteHermesSession.mockResolvedValue(undefined);
    mocks.suggestAgentSessionTitle.mockResolvedValue({
      title: "Summarize Current Page",
    });
    mocks.gatewayRequest.mockImplementation((method: string) => {
      if (method === "session.create") {
        return Promise.resolve({
          session_id: "runtime-session-2",
          stored_session_id: "session-2",
        });
      }
      if (method === "session.resume") {
        return Promise.resolve({ session_id: "runtime-session-1" });
      }
      return Promise.resolve({});
    });
  });

  it("honors a pending New Session request instead of selecting existing work", async () => {
    window.sessionStorage.setItem(
      AGENT_NEW_SESSION_PENDING_KEY,
      JSON.stringify({ createdAt: Date.now() }),
    );

    render(<AgentWorkspace />);

    expect(
      await screen.findByText("What can June do for you?"),
    ).toBeInTheDocument();
    await waitFor(() => expect(mocks.listHermesSessions).toHaveBeenCalled());
    expect(screen.queryByText("Existing session")).toBeNull();
    expect(screen.queryByText("Existing task")).toBeNull();
    expect(
      window.sessionStorage.getItem(AGENT_NEW_SESSION_PENDING_KEY),
    ).toBeNull();
  });

  it("ignores a stale pending New Session marker left over from a reload", async () => {
    window.sessionStorage.setItem(
      AGENT_NEW_SESSION_PENDING_KEY,
      JSON.stringify({
        createdAt: Date.now() - 60_000,
        prompt: "stale prompt from before the reload",
      }),
    );

    render(<AgentWorkspace />);

    expect(await screen.findByText("Existing session")).toBeInTheDocument();
    expect(
      window.sessionStorage.getItem(AGENT_NEW_SESSION_PENDING_KEY),
    ).toBeNull();
    expect(mocks.gatewayRequest).not.toHaveBeenCalledWith(
      "prompt.submit",
      expect.objectContaining({ text: "stale prompt from before the reload" }),
    );
  });

  it("submits a double-delivered New Session prompt only once", async () => {
    window.sessionStorage.setItem(
      AGENT_NEW_SESSION_PENDING_KEY,
      JSON.stringify({ createdAt: Date.now(), prompt: "audit the repo" }),
    );

    render(<AgentWorkspace />);

    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
        session_id: "runtime-session-2",
        text: "audit the repo",
      }),
    );

    // App.tsx marks the pending marker AND fires the window event in a
    // setTimeout — the event lands after the mount already consumed the
    // marker. The echo must not create a second session.
    act(() => {
      window.dispatchEvent(
        new CustomEvent(AGENT_NEW_SESSION_EVENT, {
          detail: { prompt: "audit the repo" },
        }),
      );
    });
    await act(async () => {
      await Promise.resolve();
    });

    const sessionCreates = mocks.gatewayRequest.mock.calls.filter(
      ([method]) => method === "session.create",
    );
    expect(sessionCreates).toHaveLength(1);
  });

  it("restores the last open session after a reload", async () => {
    window.localStorage.setItem("scribe:agent:last-open-session", "session-1");
    mocks.listHermesSessions.mockResolvedValue([
      {
        id: "session-2",
        title: "Newer session",
        preview: "More recent work",
        last_active: "2026-06-05T12:00:00Z",
      },
      existingSession,
    ]);

    render(<AgentWorkspace />);

    // Without the restore, the workspace would select the newest session
    // (session-2); the persisted id must win — the restored session's title
    // is the one in the session bar and its messages are the ones fetched.
    expect(await screen.findByText("Existing session")).toBeInTheDocument();
    await waitFor(() =>
      expect(mocks.listHermesSessionMessages).toHaveBeenCalledWith("session-1"),
    );
    expect(mocks.listHermesSessionMessages).not.toHaveBeenCalledWith(
      "session-2",
    );
    expect(screen.queryByText("Newer session")).toBeNull();
  });

  it("forgets the persisted session when it is deleted", async () => {
    render(<AgentWorkspace />);

    expect(await screen.findByText("Existing session")).toBeInTheDocument();
    await waitFor(() =>
      expect(
        window.localStorage.getItem("scribe:agent:last-open-session"),
      ).toBe("session-1"),
    );

    act(() => {
      window.dispatchEvent(
        new CustomEvent(AGENT_DELETE_SESSION_EVENT, {
          detail: { sessionId: "session-1" },
        }),
      );
    });

    await waitFor(() =>
      expect(
        window.localStorage.getItem("scribe:agent:last-open-session"),
      ).toBeNull(),
    );
  });

  it("keeps the blank composer after a New Session event during refresh", async () => {
    render(<AgentWorkspace />);

    expect(await screen.findByText("Existing session")).toBeInTheDocument();

    window.dispatchEvent(new CustomEvent(AGENT_NEW_SESSION_EVENT));

    expect(
      await screen.findByText("What can June do for you?"),
    ).toBeInTheDocument();
    expect(screen.queryByText("Existing session")).toBeNull();
  });

  it("submits a pending New Session prompt as a fresh Hermes session", async () => {
    window.sessionStorage.setItem(
      AGENT_NEW_SESSION_PENDING_KEY,
      JSON.stringify({
        createdAt: Date.now(),
        prompt: "summarize the current page",
      }),
    );
    mocks.listHermesSessions.mockResolvedValue([
      {
        id: "session-2",
        title: "Untitled session",
        preview: "summarize the current page",
        last_active: "2026-06-04T12:01:00Z",
      },
    ]);

    render(<AgentWorkspace />);

    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
        session_id: "runtime-session-2",
        text: "summarize the current page",
      }),
    );
    expect(mocks.gatewayRequest).toHaveBeenCalledWith("session.create", {
      title: "Summarize Current Page",
      cols: 96,
    });
    expect(mocks.ensureHermesBridgeSession).toHaveBeenCalledWith({
      sessionId: "session-2",
      title: "Summarize Current Page",
    });
    expect(
      await screen.findByText("Summarize Current Page"),
    ).toBeInTheDocument();
    expect(screen.queryByText("Untitled session")).toBeNull();
    expect(
      window.sessionStorage.getItem(AGENT_NEW_SESSION_PENDING_KEY),
    ).toBeNull();
  });

  it("stops a working session from the composer", async () => {
    window.sessionStorage.setItem(
      AGENT_NEW_SESSION_PENDING_KEY,
      JSON.stringify({
        createdAt: Date.now(),
        prompt: "summarize the current page",
      }),
    );
    mocks.listHermesSessions.mockResolvedValue([
      {
        id: "session-2",
        title: "Untitled session",
        preview: "summarize the current page",
        last_active: "2026-06-04T12:01:00Z",
      },
    ]);

    render(<AgentWorkspace />);

    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
        session_id: "runtime-session-2",
        text: "summarize the current page",
      }),
    );

    // The session is now working, so the composer offers a stop control.
    const stop = await screen.findByRole("button", { name: "Stop June" });
    expect(mocks.gatewayEventHandlers.size).toBe(1);
    await userEvent.click(stop);

    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("session.interrupt", {
        session_id: "runtime-session-2",
      }),
    );
    // The working flag clears even before any gateway event arrives, so the
    // stop control goes away and the session no longer reads as thinking.
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Stop June" })).toBeNull(),
    );
    // Stopping also tears down the per-session gateway listener, so a
    // straggler "running" event can't flip the session back to working.
    expect(mocks.gatewayEventHandlers.size).toBe(0);
  });

  it("creates a fresh Hermes session for a New Session prompt when an initial session is selected", async () => {
    render(<AgentWorkspace initialSession={existingSession} />);

    expect(await screen.findByText("Existing session")).toBeInTheDocument();

    window.dispatchEvent(
      new CustomEvent(AGENT_NEW_SESSION_EVENT, {
        detail: { prompt: "write a project update" },
      }),
    );

    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("session.create", {
        title: "Summarize Current Page",
        cols: 96,
      }),
    );
    expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
      session_id: "runtime-session-2",
      text: "write a project update",
    });
    expect(mocks.gatewayRequest).not.toHaveBeenCalledWith("prompt.submit", {
      session_id: "runtime-session-1",
      text: "write a project update",
    });
  });

  it("keeps an optimistic Hermes session visible while the persisted list lags", async () => {
    window.sessionStorage.setItem(
      AGENT_NEW_SESSION_PENDING_KEY,
      JSON.stringify({
        createdAt: Date.now(),
        prompt: "open the release notes",
      }),
    );
    mocks.listHermesSessions.mockResolvedValue([existingSession]);

    render(<AgentWorkspace />);

    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
        session_id: "runtime-session-2",
        text: "open the release notes",
      }),
    );

    expect(
      await screen.findByText("Summarize Current Page"),
    ).toBeInTheDocument();
    expect(screen.getByText("open the release notes")).toBeInTheDocument();
  });

  it("keeps polling when a follow-up user message is still only pending locally", async () => {
    const user = userEvent.setup();
    mocks.listHermesSessionMessages.mockResolvedValue([
      {
        id: "m1",
        role: "user",
        content: "previous request",
        timestamp: "2026-06-04T12:00:00.000Z",
      },
      {
        id: "m2",
        role: "assistant",
        content: "previous answer",
        timestamp: "2026-06-04T12:00:01.000Z",
      },
    ]);
    mocks.gatewayRequest.mockImplementation((method: string) => {
      if (method === "session.resume") {
        return Promise.resolve({ session_id: "runtime-session-1" });
      }
      return Promise.resolve({});
    });
    let resolveEnsureSession: (value: unknown) => void = () => {};
    mocks.ensureHermesBridgeSession.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveEnsureSession = resolve;
        }),
    );

    render(<AgentWorkspace />);

    expect(await screen.findByText("previous answer")).toBeInTheDocument();
    const initialSessionListCalls = mocks.listHermesSessions.mock.calls.length;

    await user.type(screen.getByRole("textbox"), "follow up while pending");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() =>
      expect(mocks.ensureHermesBridgeSession).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: "session-1",
        }),
      ),
    );

    vi.useFakeTimers();
    try {
      await act(async () => {
        resolveEnsureSession({});
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
        session_id: "runtime-session-1",
        text: "follow up while pending",
      });
      expect(screen.getByText("Thinking…")).toBeInTheDocument();
      expect(mocks.listHermesSessions).toHaveBeenCalledTimes(
        initialSessionListCalls + 1,
      );
      const sessionListCallsAfterSubmit =
        mocks.listHermesSessions.mock.calls.length;

      await act(async () => {
        await vi.advanceTimersByTimeAsync(2500);
      });

      expect(screen.getByText("follow up while pending")).toBeInTheDocument();
      expect(screen.getByText("Thinking…")).toBeInTheDocument();
      expect(mocks.listHermesSessions).toHaveBeenCalledTimes(
        sessionListCallsAfterSubmit + 1,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("renders generated workspace files mentioned by Hermes as downloadable artifacts", async () => {
    const user = userEvent.setup();
    const samplePath =
      "/Users/junho/Library/Application Support/co.opensoftware.scribe/hermes/workspace/sample.pdf";
    mocks.hermesBridgeFilesystemSnapshot.mockResolvedValue({
      roots: [
        {
          id: "workspace",
          label: "Workspace",
          path: "/Users/junho/Library/Application Support/co.opensoftware.scribe/hermes/workspace",
          description: "Hermes scratch files and generated outputs.",
          entries: [
            {
              name: "sample.pdf",
              path: samplePath,
              kind: "file",
              size: 1768,
              modifiedAt: "2026-06-04T18:39:00Z",
            },
          ],
        },
      ],
    });
    mocks.listHermesSessionMessages.mockResolvedValue([
      {
        id: "message-1",
        role: "assistant",
        content: "Done. The PDF is available as `sample.pdf`.",
        timestamp: "2026-06-04T18:39:00Z",
      },
    ]);

    render(<AgentWorkspace />);

    expect(await screen.findByLabelText("Generated files")).toBeInTheDocument();
    expect(screen.getAllByText("sample.pdf").length).toBeGreaterThan(0);

    await user.click(
      screen.getByRole("button", { name: "Download sample.pdf" }),
    );

    expect(mocks.downloadHermesBridgeFile).toHaveBeenCalledWith(samplePath);
  });

  it("renders generated workspace images as thumbnails", async () => {
    const screenshotPath =
      "/Users/junho/Library/Application Support/co.opensoftware.scribe/hermes/workspace/screenshot.png";
    mocks.hermesBridgeFilePreview.mockResolvedValue(
      "data:image/png;base64,generated-preview",
    );
    mocks.hermesBridgeFilesystemSnapshot.mockResolvedValue({
      roots: [
        {
          id: "workspace",
          label: "Workspace",
          path: "/Users/junho/Library/Application Support/co.opensoftware.scribe/hermes/workspace",
          description: "Hermes scratch files and generated outputs.",
          entries: [
            {
              name: "screenshot.png",
              path: screenshotPath,
              kind: "file",
              size: 2048,
              modifiedAt: "2026-06-04T18:39:00Z",
            },
          ],
        },
      ],
    });
    mocks.listHermesSessionMessages.mockResolvedValue([
      {
        id: "message-1",
        role: "assistant",
        content: "I saved the screenshot as `screenshot.png`.",
        timestamp: "2026-06-04T18:39:00Z",
      },
    ]);

    render(<AgentWorkspace />);

    expect(
      await screen.findByRole("img", { name: "screenshot.png" }),
    ).toHaveAttribute("src", "data:image/png;base64,generated-preview");
    expect(mocks.hermesBridgeFilePreview).toHaveBeenCalledWith(screenshotPath);
  });

  it("imports dropped files into the Hermes workspace before submitting", async () => {
    const user = userEvent.setup();
    render(<AgentWorkspace />);

    expect(await screen.findByText("Existing session")).toBeInTheDocument();
    await waitFor(() =>
      expect(mocks.listen).toHaveBeenCalledWith(
        "tauri://drag-drop",
        expect.any(Function),
      ),
    );

    mocks.eventHandlers.get("tauri://drag-drop")?.({
      payload: {
        paths: [
          "/Users/junho/Library/Application Support/CleanShot/media/screenshot.png",
        ],
      },
    });

    expect(await screen.findByText("screenshot.png")).toBeInTheDocument();
    expect(
      document.querySelector(".agent-attachment-chip img"),
    ).toHaveAttribute("src", "data:image/png;base64,preview");
    await user.type(
      screen.getByPlaceholderText("Send a message"),
      "what is in this image?",
    );
    const sendButton = screen.getByRole("button", { name: "Send message" });
    await waitFor(() => expect(sendButton).not.toBeDisabled());
    await user.click(sendButton);

    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
        session_id: "runtime-session-1",
        text: expect.stringContaining(
          "/Users/junho/Library/Application Support/co.opensoftware.scribe/hermes/workspace/uploads/screenshot.png",
        ),
      }),
    );
    expect(mocks.importHermesBridgeFile).toHaveBeenCalledWith(
      "/Users/junho/Library/Application Support/CleanShot/media/screenshot.png",
    );
  });

  it("imports DOM-dropped files by uploading their bytes", async () => {
    // WKWebView never exposes filesystem paths on dropped Files, and Tauri's
    // drag-drop interception is disabled — DOM drops must go through the
    // bytes-based import.
    render(<AgentWorkspace />);
    expect(await screen.findByText("Existing session")).toBeInTheDocument();

    const form = document.querySelector(".agent-composer");
    expect(form).not.toBeNull();
    fireEvent.drop(form as HTMLFormElement, {
      dataTransfer: {
        files: [new File(["hello"], "notes.txt", { type: "text/plain" })],
      },
    });

    expect(await screen.findByText("notes.txt")).toBeInTheDocument();
    expect(mocks.importHermesBridgeFileBytes).toHaveBeenCalledWith(
      "notes.txt",
      expect.any(Uint8Array),
    );
    expect(mocks.importHermesBridgeFile).not.toHaveBeenCalled();
  });

  it("keeps a re-sent duplicate message and the running state against older identical history", async () => {
    const user = userEvent.setup();
    mocks.listHermesSessionMessages.mockResolvedValue([
      {
        id: "m1",
        role: "user",
        content: "continue",
        timestamp: "2026-06-04T12:00:00.000Z",
      },
      {
        id: "m2",
        role: "assistant",
        content: "older answer",
        timestamp: "2026-06-04T12:00:01.000Z",
      },
    ]);

    render(<AgentWorkspace />);

    expect(await screen.findByText("older answer")).toBeInTheDocument();

    await user.type(screen.getByRole("textbox"), "continue");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
        session_id: "runtime-session-1",
        text: "continue",
      }),
    );

    // The just-sent message must not be swallowed by the older identical one.
    expect(screen.getAllByText("continue")).toHaveLength(2);
    expect(screen.getByText("Thinking…")).toBeInTheDocument();

    // Let the working-gated poll (2.5s) refresh against the same old
    // history: the new pending "continue" must survive and the run must not
    // be marked finished against the old answer.
    const refreshCallsBefore =
      mocks.listHermesSessionMessages.mock.calls.length;
    await waitFor(
      () =>
        expect(
          mocks.listHermesSessionMessages.mock.calls.length,
        ).toBeGreaterThan(refreshCallsBefore),
      { timeout: 4000 },
    );
    // Give the refresh's state updates time to land before asserting.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
    });
    expect(screen.getAllByText("continue")).toHaveLength(2);
    expect(screen.getByText("Thinking…")).toBeInTheDocument();
  });

  it("resumes working state when the latest persisted message is a recent user prompt", async () => {
    mocks.listHermesSessionMessages.mockResolvedValue([
      {
        id: "m1",
        role: "user",
        content: "long running task",
        timestamp: new Date(Date.now() - 60_000).toISOString(),
      },
    ]);

    render(<AgentWorkspace />);

    // A remount mid-run (navigation away and back) re-arms the working state
    // and poll instead of leaving the conversation frozen.
    expect(await screen.findByText("long running task")).toBeInTheDocument();
    expect(await screen.findByText("Thinking…")).toBeInTheDocument();
  });

  it("does not resume working state for a stale session that ended on a user message", async () => {
    mocks.listHermesSessionMessages.mockResolvedValue([
      {
        id: "m1",
        role: "user",
        content: "thanks!",
        timestamp: "2026-06-01T12:00:00.000Z",
      },
    ]);

    render(<AgentWorkspace />);

    expect(await screen.findByText("thanks!")).toBeInTheDocument();
    expect(screen.queryByText("Thinking…")).toBeNull();
  });

  it("refreshes the session list after an event-driven new session run", async () => {
    render(<AgentWorkspace />);

    expect(await screen.findByText("Existing session")).toBeInTheDocument();
    const callsBefore = mocks.listHermesSessions.mock.calls.length;

    window.dispatchEvent(
      new CustomEvent(AGENT_NEW_SESSION_EVENT, {
        detail: { prompt: "write a project update" },
      }),
    );

    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
        session_id: "runtime-session-2",
        text: "write a project update",
      }),
    );
    // The mount-time listener must call through to the latest handlers — a
    // first-render closure would no-op loadHermesSessions (bridge not yet
    // running) and the sidebar would never refresh.
    await waitFor(() =>
      expect(mocks.listHermesSessions.mock.calls.length).toBeGreaterThan(
        callsBefore,
      ),
    );
  });

  it("scrubs working state when deleting the selected session from the session bar", async () => {
    const user = userEvent.setup();
    const sessionDetails: AgentSessionsChangedDetail[] = [];
    const onSessionsChanged = (event: Event) =>
      sessionDetails.push(
        (event as CustomEvent<AgentSessionsChangedDetail>).detail,
      );
    window.addEventListener(AGENT_SESSIONS_CHANGED_EVENT, onSessionsChanged);

    try {
      render(<AgentWorkspace />);
      expect(await screen.findByText("Existing session")).toBeInTheDocument();

      await user.type(screen.getByRole("textbox"), "do something long");
      await user.click(screen.getByRole("button", { name: "Send message" }));
      await waitFor(() =>
        expect(sessionDetails.at(-1)?.workingSessionIds).toContain("session-1"),
      );

      mocks.listHermesSessions.mockResolvedValue([]);
      await user.click(screen.getByRole("button", { name: "Session actions" }));
      await user.click(
        screen.getByRole("menuitem", { name: "Delete session" }),
      );

      await waitFor(() =>
        expect(mocks.deleteHermesSession).toHaveBeenCalledWith("session-1"),
      );
      await waitFor(() => {
        const last = sessionDetails.at(-1);
        expect(last?.workingSessionIds).toEqual([]);
        expect(last?.sessions.map((session) => session.id)).not.toContain(
          "session-1",
        );
      });
    } finally {
      window.removeEventListener(
        AGENT_SESSIONS_CHANGED_EVENT,
        onSessionsChanged,
      );
    }
  });

  it("launches a session immediately from a run shortcut", async () => {
    window.sessionStorage.setItem(
      AGENT_NEW_SESSION_PENDING_KEY,
      JSON.stringify({ createdAt: Date.now() }),
    );
    // rand() of 0 keeps the rotating hero suggestions in curated pool order,
    // so the leading window (incl. "Tidy my Downloads") is what renders.
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0);
    try {
      render(<AgentWorkspace />);
      const user = userEvent.setup();

      await user.click(
        await screen.findByRole("button", { name: /Tidy my Downloads/ }),
      );

      await waitFor(() =>
        expect(mocks.gatewayRequest).toHaveBeenCalledWith(
          "prompt.submit",
          expect.objectContaining({
            text: expect.stringContaining("Downloads folder"),
          }),
        ),
      );
    } finally {
      randomSpy.mockRestore();
    }
  });

  it("prefills the composer from a prefill shortcut without submitting", async () => {
    window.sessionStorage.setItem(
      AGENT_NEW_SESSION_PENDING_KEY,
      JSON.stringify({ createdAt: Date.now() }),
    );
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0);
    try {
      render(<AgentWorkspace />);
      const user = userEvent.setup();

      await user.click(
        await screen.findByRole("button", { name: /Research a topic/ }),
      );

      const composer = screen.getByPlaceholderText(
        "Describe a task for June…",
      ) as HTMLTextAreaElement;
      await waitFor(() => expect(composer.value).toContain("Research <topic>"));
      expect(mocks.gatewayRequest).not.toHaveBeenCalledWith(
        "prompt.submit",
        expect.anything(),
      );
    } finally {
      randomSpy.mockRestore();
    }
  });

  // Last in the suite: mounting the workspace kicks off bridge/session
  // bootstrap promises that can leak into a later test's pending-session
  // flow, so nothing runs after this one.
  it("renders origin crumbs and back arrow in the sticky session bar", async () => {
    window.sessionStorage.setItem(
      AGENT_NEW_SESSION_PENDING_KEY,
      JSON.stringify({ createdAt: Date.now() }),
    );
    const onBack = vi.fn();
    const onOpenProjects = vi.fn();
    render(
      <AgentWorkspace
        origin={{
          backLabel: "Back to Scribe",
          onBack,
          crumbs: [
            { label: "Projects", onClick: onOpenProjects },
            { label: "Scribe", onClick: onBack },
          ],
        }}
      />,
    );

    expect(
      await screen.findByText("What can June do for you?"),
    ).toBeInTheDocument();
    expect(screen.getByText("Projects")).toBeInTheDocument();
    expect(screen.getByText("Scribe")).toBeInTheDocument();
    expect(screen.getByText("New session")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Back to Scribe" }));
    expect(onBack).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Projects" }));
    expect(onOpenProjects).toHaveBeenCalled();
  });
});
