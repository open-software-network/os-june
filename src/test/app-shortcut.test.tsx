import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../app/App";
import { HERO_GREETINGS } from "../components/agent/AgentWorkspace";
import { MEETING_START_TRANSCRIPTION_EVENT } from "../lib/events";
import {
  AGENT_NEW_SESSION_EVENT,
  AGENT_SESSIONS_CHANGED_EVENT,
} from "../lib/agent-events";
import { CLOSE_TAB_EVENT, OPEN_SETTINGS_EVENT } from "../lib/menu-bar";
import type {
  AccountStatus,
  BootstrapResponse,
  NoteDto,
  RecordingSessionDto,
  RecordingSourceReadinessDto,
} from "../lib/tauri";

// The hero greeting cycles per visit, so tests match any entry in the pool.
const HERO_GREETING = new RegExp(
  `^(?:${HERO_GREETINGS.map((greeting) => greeting.replace("?", "\\?")).join("|")})$`,
);

function stubNavigatorPlatform(platform: string, userAgent: string) {
  const ownPlatform = Object.getOwnPropertyDescriptor(navigator, "platform");
  const ownUserAgent = Object.getOwnPropertyDescriptor(navigator, "userAgent");
  Object.defineProperty(navigator, "platform", {
    configurable: true,
    get: () => platform,
  });
  Object.defineProperty(navigator, "userAgent", {
    configurable: true,
    get: () => userAgent,
  });
  return () => {
    if (ownPlatform) {
      Object.defineProperty(navigator, "platform", ownPlatform);
    } else {
      Reflect.deleteProperty(navigator, "platform");
    }
    if (ownUserAgent) {
      Object.defineProperty(navigator, "userAgent", ownUserAgent);
    } else {
      Reflect.deleteProperty(navigator, "userAgent");
    }
  };
}

const mocks = vi.hoisted(() => ({
  listen: vi.fn(),
  listeners: new Map<string, (event: { payload?: unknown }) => void>(),
  getCurrentWindow: vi.fn(),
  bootstrapApp: vi.fn(),
  createNote: vi.fn(),
  createFolder: vi.fn(),
  deleteFolder: vi.fn(),
  renameFolder: vi.fn(),
  assignNoteToFolder: vi.fn(),
  removeNoteFromFolder: vi.fn(),
  listNotes: vi.fn(),
  getNote: vi.fn(),
  deleteNote: vi.fn(),
  updateNote: vi.fn(),
  checkRecordingSourceReadiness: vi.fn(),
  openPrivacySettings: vi.fn(),
  startRecording: vi.fn(),
  pauseRecording: vi.fn(),
  resumeRecording: vi.fn(),
  getRecordingStatus: vi.fn(),
  finishRecording: vi.fn(),
  retryProcessing: vi.fn(),
  recoverRecording: vi.fn(),
  dictationHelperCommand: vi.fn(),
  listDictationHistory: vi.fn(),
  osAccountsStatus: vi.fn(),
  osAccountsLogin: vi.fn(),
  osAccountsCancelLogin: vi.fn(),
  osAccountsLogout: vi.fn(),
  osAccountsUpgrade: vi.fn(),
  agentHudShow: vi.fn(),
  agentHudHide: vi.fn(),
  ensureHermesBridgeSession: vi.fn(),
  hermesAgentCliAccess: vi.fn(),
  hermesBridgeFilesystemSnapshot: vi.fn(),
  hermesBridgeStatus: vi.fn(),
  listAgentTasks: vi.fn(),
  listHermesSessionMessages: vi.fn(),
  listHermesSessions: vi.fn(),
  listVeniceModels: vi.fn(),
  playRecordingSound: vi.fn(),
  preloadRecordingSounds: vi.fn(),
  providerModelSettings: vi.fn(),
  startHermesBridge: vi.fn(),
  startPeriodicJuneUpdateChecks: vi.fn(),
  suggestAgentSessionTitle: vi.fn(),
  gatewayRequest: vi.fn(),
  gatewayEventHandlers: new Set<(event: Record<string, unknown>) => void>(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: mocks.listen,
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: mocks.getCurrentWindow,
}));

vi.mock("../lib/recording-sounds", () => ({
  playRecordingSound: mocks.playRecordingSound,
  preloadRecordingSounds: mocks.preloadRecordingSounds,
}));

vi.mock("../lib/hermes-adapter", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/hermes-adapter")>()),
  listHermesSessionMessages: mocks.listHermesSessionMessages,
  listHermesSessions: mocks.listHermesSessions,
  titleFromPrompt: (prompt: string) => prompt.trim() || "Untitled session",
}));

vi.mock("../lib/hermes-gateway", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/hermes-gateway")>()),
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

vi.mock("../app/update-decision", async () => {
  const actual = await vi.importActual<typeof import("../app/update-decision")>(
    "../app/update-decision",
  );
  return {
    ...actual,
    startPeriodicJuneUpdateChecks: mocks.startPeriodicJuneUpdateChecks,
  };
});

vi.mock("../lib/tauri", () => ({
  LIVE_TRANSCRIPT_EVENT: "live-transcript-event",
  // The agent workspace mounts the pending skill-writes tray, whose loader
  // reaches the Rust bridge through this named `invoke`. A quiet stub keeps
  // these shortcut tests focused on the meetings surfaces.
  invoke: vi.fn(async () => []),
  bootstrapApp: mocks.bootstrapApp,
  createNote: mocks.createNote,
  createFolder: mocks.createFolder,
  deleteFolder: mocks.deleteFolder,
  renameFolder: mocks.renameFolder,
  assignNoteToFolder: mocks.assignNoteToFolder,
  listSessionFolders: vi.fn(async () => []),
  assignSessionToFolder: vi.fn(async () => undefined),
  removeSessionFromFolder: vi.fn(async () => undefined),
  removeNoteFromFolder: mocks.removeNoteFromFolder,
  listNotes: mocks.listNotes,
  getNote: mocks.getNote,
  deleteNote: mocks.deleteNote,
  updateNote: mocks.updateNote,
  checkRecordingSourceReadiness: mocks.checkRecordingSourceReadiness,
  openPrivacySettings: mocks.openPrivacySettings,
  startRecording: mocks.startRecording,
  pauseRecording: mocks.pauseRecording,
  resumeRecording: mocks.resumeRecording,
  getRecordingStatus: mocks.getRecordingStatus,
  finishRecording: mocks.finishRecording,
  retryProcessing: mocks.retryProcessing,
  recoverRecording: mocks.recoverRecording,
  dictationHelperCommand: mocks.dictationHelperCommand,
  listDictationHistory: mocks.listDictationHistory,
  osAccountsStatus: mocks.osAccountsStatus,
  osAccountsLogin: mocks.osAccountsLogin,
  osAccountsCancelLogin: mocks.osAccountsCancelLogin,
  osAccountsLogout: mocks.osAccountsLogout,
  osAccountsUpgrade: mocks.osAccountsUpgrade,
  agentHudShow: mocks.agentHudShow,
  agentHudHide: mocks.agentHudHide,
  ensureHermesBridgeSession: mocks.ensureHermesBridgeSession,
  hermesAgentCliAccess: mocks.hermesAgentCliAccess,
  hermesBridgeFilesystemSnapshot: mocks.hermesBridgeFilesystemSnapshot,
  hermesBridgeStatus: mocks.hermesBridgeStatus,
  listAgentTasks: mocks.listAgentTasks,
  juneVerifyUrl: vi.fn(async () => ""),
  providerModelSettings: mocks.providerModelSettings,
  listVeniceModels: mocks.listVeniceModels,
  startHermesBridge: mocks.startHermesBridge,
  suggestAgentSessionTitle: mocks.suggestAgentSessionTitle,
}));

const now = "2026-05-19T10:00:00Z";

function note(overrides: Partial<NoteDto> = {}): NoteDto {
  return {
    id: "note-1",
    title: "First note",
    preview: "Preview",
    processingStatus: "ready",
    folderIds: [],
    createdAt: now,
    updatedAt: now,
    generatedContent: "Existing note",
    activeTab: "notes",
    ...overrides,
  };
}

function recordingReadiness(systemReady: boolean): RecordingSourceReadinessDto {
  return {
    sourceMode: "microphonePlusSystem",
    ready: systemReady,
    sources: [
      {
        source: "microphone",
        required: true,
        ready: true,
        permissionState: "granted",
        deviceAvailable: true,
        captureAvailable: true,
      },
      {
        source: "system",
        required: true,
        ready: systemReady,
        permissionState: systemReady ? "granted" : "denied",
        deviceAvailable: true,
        captureAvailable: systemReady,
        recoveryAction: "openSystemAudioSettings",
      },
    ],
  };
}

function microphoneOnlyReadiness(): RecordingSourceReadinessDto {
  return {
    sourceMode: "microphoneOnly",
    ready: true,
    sources: [
      {
        source: "microphone",
        required: true,
        ready: true,
        permissionState: "granted",
        deviceAvailable: true,
        captureAvailable: true,
      },
    ],
  };
}

function recordingSession(
  overrides: Partial<RecordingSessionDto> = {},
): RecordingSessionDto {
  return {
    id: "rec-1",
    noteId: "note-1",
    sourceMode: "microphoneOnly",
    state: "recording",
    startedAt: now,
    elapsedMs: 0,
    level: { peak: 0, rms: 0, recentPeaks: [] },
    ...overrides,
  };
}

describe("App shortcuts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const first = note();
    const created = note({
      id: "note-2",
      title: "",
      preview: "",
      processingStatus: "draft",
      generatedContent: "",
      editedContent: "",
    });
    const payload: BootstrapResponse = {
      folders: [],
      notes: [first],
      activeRecoveries: [],
      providerConfigured: true,
    };

    mocks.listen.mockResolvedValue(vi.fn());
    mocks.getCurrentWindow.mockReturnValue({
      startDragging: vi.fn().mockResolvedValue(undefined),
    });
    mocks.bootstrapApp.mockResolvedValue(payload);
    mocks.getNote.mockResolvedValue(first);
    mocks.createNote.mockResolvedValue(created);
    mocks.checkRecordingSourceReadiness.mockResolvedValue({
      sources: [
        { source: "microphone", ready: true },
        { source: "system", ready: true },
      ],
    });
    mocks.dictationHelperCommand.mockResolvedValue(undefined);
    mocks.listDictationHistory.mockResolvedValue({
      items: [],
      retentionDays: 7,
    });
    mocks.osAccountsStatus.mockResolvedValue({
      signedIn: true,
      configured: true,
      user: { id: "usr_123", handle: "alex", email: "alex@example.com" },
      balance: { usdMillis: 1200 },
      subscription: { subscribed: true, status: "active" },
    });
    mocks.osAccountsLogin.mockResolvedValue({
      signedIn: true,
      configured: true,
      user: { id: "usr_123", handle: "alex", email: "alex@example.com" },
      balance: { usdMillis: 1200 },
      subscription: { subscribed: true, status: "active" },
    });
    mocks.osAccountsLogout.mockResolvedValue(undefined);
    mocks.osAccountsCancelLogin.mockResolvedValue(undefined);
    mocks.osAccountsUpgrade.mockResolvedValue(undefined);
    mocks.ensureHermesBridgeSession.mockResolvedValue({});
    mocks.hermesAgentCliAccess.mockResolvedValue({ enabled: false });
    mocks.hermesBridgeFilesystemSnapshot.mockResolvedValue({ roots: [] });
    mocks.hermesBridgeStatus.mockResolvedValue({
      running: false,
    });
    mocks.listAgentTasks.mockResolvedValue({ items: [] });
    mocks.listHermesSessionMessages.mockResolvedValue([]);
    mocks.listHermesSessions.mockResolvedValue([]);
    mocks.listVeniceModels.mockResolvedValue({
      mode: "generation",
      modelType: "text",
      selectedModel: "",
      models: [],
    });
    mocks.providerModelSettings.mockResolvedValue({
      settings: { generationModel: "" },
    });
    mocks.startHermesBridge.mockResolvedValue({
      running: false,
    });
    mocks.startPeriodicJuneUpdateChecks.mockReturnValue(vi.fn());
    mocks.suggestAgentSessionTitle.mockImplementation(
      async (prompt: string) => ({
        title: prompt,
      }),
    );
    mocks.gatewayEventHandlers.clear();
    mocks.gatewayRequest.mockImplementation((method: string) => {
      if (method === "session.create") {
        return Promise.resolve({
          session_id: "runtime-session-2",
          stored_session_id: "session-2",
        });
      }
      if (method === "session.resume") {
        return Promise.resolve({ session_id: "runtime-session-2" });
      }
      return Promise.resolve({});
    });
    mocks.listeners.clear();
    mocks.listen.mockImplementation(
      async (
        event: string,
        handler: (event: { payload?: unknown }) => void,
      ) => {
        mocks.listeners.set(event, handler);
        return () => mocks.listeners.delete(event);
      },
    );
    mocks.updateNote.mockImplementation(async (input) => ({
      ...first,
      ...input,
    }));
  });

  it("starts background update checks after launch gates clear", async () => {
    vi.stubEnv("DEV", false);

    try {
      render(<App />);

      await waitFor(() => expect(mocks.getNote).toHaveBeenCalledWith("note-1"));
      await waitFor(() =>
        expect(mocks.startPeriodicJuneUpdateChecks).toHaveBeenCalledOnce(),
      );
      expect(mocks.startPeriodicJuneUpdateChecks.mock.calls[0]?.[0]).toEqual(
        expect.any(Function),
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("starts a new session with Command-N", async () => {
    const onNewSession = vi.fn();
    window.addEventListener(AGENT_NEW_SESSION_EVENT, onNewSession);

    try {
      render(<App />);

      await waitFor(() => expect(mocks.getNote).toHaveBeenCalledWith("note-1"));

      fireEvent.keyDown(window, { key: "n", metaKey: true });

      await waitFor(() => expect(onNewSession).toHaveBeenCalled());
      expect(mocks.createNote).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener(AGENT_NEW_SESSION_EVENT, onNewSession);
    }
  });

  it("keeps a newly started chat attached to its tab before sessions hydrate", async () => {
    const restoreNavigator = stubNavigatorPlatform(
      "MacIntel",
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
    );
    const user = userEvent.setup();
    mocks.hermesBridgeStatus.mockResolvedValue({
      running: true,
      connection: { port: 61234, wsUrl: "ws://127.0.0.1:61234" },
    });
    mocks.startHermesBridge.mockResolvedValue({
      running: true,
      connection: { port: 61234, wsUrl: "ws://127.0.0.1:61234" },
    });
    mocks.listHermesSessions.mockImplementation(
      () => new Promise(() => undefined),
    );

    try {
      render(<App />);

      expect(
        await screen.findByRole("heading", { name: HERO_GREETING }),
      ).toBeInTheDocument();

      window.dispatchEvent(
        new CustomEvent(AGENT_NEW_SESSION_EVENT, {
          detail: { prompt: "plan the release" },
        }),
      );

      await waitFor(() =>
        expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
          session_id: "runtime-session-2",
          text: "plan the release",
        }),
      );
      await waitFor(() =>
        expect(screen.getAllByText("plan the release").length).toBeGreaterThan(
          0,
        ),
      );

      const chatTab = await screen.findByRole("tab", {
        name: "plan the release",
      });
      expect(chatTab).toHaveAttribute("data-active", "true");

      await user.click(screen.getByRole("button", { name: "New tab" }));
      expect(
        await screen.findByRole("heading", { name: HERO_GREETING }),
      ).toBeInTheDocument();

      fireEvent.keyDown(window, { key: "1", metaKey: true });

      await waitFor(() =>
        expect(screen.getAllByText("plan the release").length).toBeGreaterThan(
          0,
        ),
      );
      expect(
        screen.queryByRole("heading", { name: HERO_GREETING }),
      ).not.toBeInTheDocument();
    } finally {
      restoreNavigator();
    }
  });

  it("fills restored session tab metadata from a follow-up before sessions hydrate", async () => {
    const restoreNavigator = stubNavigatorPlatform(
      "MacIntel",
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
    );
    const user = userEvent.setup();
    mocks.hermesBridgeStatus.mockResolvedValue({
      running: true,
      connection: { port: 61234, wsUrl: "ws://127.0.0.1:61234" },
    });
    mocks.startHermesBridge.mockResolvedValue({
      running: true,
      connection: { port: 61234, wsUrl: "ws://127.0.0.1:61234" },
    });
    mocks.listHermesSessions.mockImplementation(
      () => new Promise(() => undefined),
    );

    try {
      render(<App />);

      expect(
        await screen.findByRole("heading", { name: HERO_GREETING }),
      ).toBeInTheDocument();

      act(() => {
        window.dispatchEvent(
          new CustomEvent(AGENT_SESSIONS_CHANGED_EVENT, {
            detail: {
              sessions: [],
              selectedSessionId: "session-1",
              workingSessionIds: [],
            },
          }),
        );
      });

      await waitFor(() =>
        expect(
          screen.queryByRole("heading", { name: HERO_GREETING }),
        ).not.toBeInTheDocument(),
      );

      await user.click(screen.getByRole("button", { name: "New tab" }));
      expect(
        await screen.findByRole("heading", { name: HERO_GREETING }),
      ).toBeInTheDocument();

      fireEvent.keyDown(window, { key: "1", metaKey: true });

      const composer = await screen.findByRole("textbox");
      await user.type(composer, "triage the launch checklist");
      const send = screen.getByRole("button", { name: "Send message" });
      await waitFor(() => expect(send).not.toBeDisabled());
      await user.click(send);

      await waitFor(() =>
        expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
          session_id: "runtime-session-2",
          text: "triage the launch checklist",
        }),
      );
      await waitFor(() =>
        expect(
          screen.getByRole("tab", { name: "triage the launch checklist" }),
        ).toHaveAttribute("data-active", "true"),
      );
    } finally {
      restoreNavigator();
    }
  });

  it("keeps each agent tab tied to its selected session", async () => {
    const restoreNavigator = stubNavigatorPlatform(
      "MacIntel",
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
    );
    const user = userEvent.setup();

    try {
      render(<App />);

      expect(
        await screen.findByRole("heading", { name: HERO_GREETING }),
      ).toBeInTheDocument();

      const firstSession = {
        id: "session-1",
        title: "First session",
        preview: "First preview",
        last_active: "2026-06-04T12:00:00Z",
      };
      act(() => {
        window.dispatchEvent(
          new CustomEvent(AGENT_SESSIONS_CHANGED_EVENT, {
            detail: {
              sessions: [firstSession],
              selectedSessionId: firstSession.id,
              workingSessionIds: [],
            },
          }),
        );
      });

      await waitFor(() =>
        expect(
          screen.getByRole("tab", { name: "First session" }),
        ).toHaveAttribute("data-active", "true"),
      );

      await user.click(screen.getByRole("button", { name: "New tab" }));
      expect(
        await screen.findByRole("tab", { name: "New session" }),
      ).toHaveAttribute("data-active", "true");

      const secondSession = {
        id: "session-2",
        title: "Second session",
        preview: "Second preview",
        last_active: "2026-06-05T12:00:00Z",
      };
      act(() => {
        window.dispatchEvent(
          new CustomEvent(AGENT_SESSIONS_CHANGED_EVENT, {
            detail: {
              sessions: [secondSession, firstSession],
              selectedSessionId: secondSession.id,
              workingSessionIds: [],
            },
          }),
        );
      });

      await waitFor(() =>
        expect(
          screen.getByRole("tab", { name: "Second session" }),
        ).toHaveAttribute("data-active", "true"),
      );

      await user.click(screen.getByRole("button", { name: "Show all 2 tabs" }));
      await user.click(screen.getByRole("menuitem", { name: "First session" }));

      await waitFor(() =>
        expect(
          screen.getByRole("tab", { name: "First session" }),
        ).toHaveAttribute("data-active", "true"),
      );
    } finally {
      restoreNavigator();
    }
  });

  it("creates a loose note with Command-Shift-N but ignores bare n", async () => {
    render(<App />);

    await waitFor(() => expect(mocks.getNote).toHaveBeenCalledWith("note-1"));

    fireEvent.keyDown(window, { key: "n" });
    expect(mocks.createNote).not.toHaveBeenCalled();

    fireEvent.keyDown(window, { key: "n", metaKey: true, shiftKey: true });

    await waitFor(() =>
      expect(mocks.createNote).toHaveBeenCalledWith(undefined),
    );
    await waitFor(() =>
      expect(screen.getByRole("tab", { name: "New note" })).toHaveAttribute(
        "data-active",
        "true",
      ),
    );
  });

  it("closes the active tab with Command-W", async () => {
    render(<App />);

    await waitFor(() => expect(mocks.getNote).toHaveBeenCalledWith("note-1"));
    fireEvent.keyDown(window, { key: "n", metaKey: true, shiftKey: true });
    await waitFor(() =>
      expect(screen.getByRole("tab", { name: "New note" })).toHaveAttribute(
        "data-active",
        "true",
      ),
    );

    fireEvent.keyDown(window, { key: "w", metaKey: true });

    await waitFor(() =>
      expect(
        screen.queryByRole("tab", { name: "New note" }),
      ).not.toBeInTheDocument(),
    );
    expect(screen.getByRole("tab", { name: "New session" })).toHaveAttribute(
      "data-active",
      "true",
    );
  });

  it("closes the active tab from the native close-tab menu event", async () => {
    render(<App />);
    const closeTabListenerCount = () =>
      mocks.listen.mock.calls.filter(([event]) => event === CLOSE_TAB_EVENT)
        .length;

    await waitFor(() => expect(mocks.getNote).toHaveBeenCalledWith("note-1"));
    await waitFor(() =>
      expect(mocks.listeners.has(CLOSE_TAB_EVENT)).toBe(true),
    );
    expect(closeTabListenerCount()).toBe(1);
    fireEvent.keyDown(window, { key: "n", metaKey: true, shiftKey: true });
    await waitFor(() =>
      expect(screen.getByRole("tab", { name: "New note" })).toHaveAttribute(
        "data-active",
        "true",
      ),
    );
    expect(closeTabListenerCount()).toBe(1);

    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    document.body.appendChild(dialog);
    mocks.listeners.get(CLOSE_TAB_EVENT)?.({});
    expect(screen.getByRole("tab", { name: "New note" })).toHaveAttribute(
      "data-active",
      "true",
    );
    dialog.remove();

    mocks.listeners.get(CLOSE_TAB_EVENT)?.({});

    await waitFor(() =>
      expect(
        screen.queryByRole("tab", { name: "New note" }),
      ).not.toBeInTheDocument(),
    );
    expect(screen.getByRole("tab", { name: "New session" })).toHaveAttribute(
      "data-active",
      "true",
    );
    expect(closeTabListenerCount()).toBe(1);
  });

  it("opens settings from the native app menu event", async () => {
    render(<App />);

    await waitFor(() =>
      expect(mocks.listeners.has(OPEN_SETTINGS_EVENT)).toBe(true),
    );

    mocks.listeners.get(OPEN_SETTINGS_EVENT)?.({});

    expect(
      await screen.findByRole("heading", { name: "Appearance" }),
    ).toBeInTheDocument();
  });

  it("refreshes Accessibility after requesting access without opening settings over the native prompt", async () => {
    const user = userEvent.setup();
    render(<App />);

    await waitFor(() =>
      expect(mocks.listeners.has("dictation-event")).toBe(true),
    );
    await waitFor(() => expect(mocks.getNote).toHaveBeenCalledWith("note-1"));

    mocks.dictationHelperCommand.mockClear();
    mocks.openPrivacySettings.mockClear();

    await act(async () => {
      mocks.listeners.get("dictation-event")?.({
        payload: JSON.stringify({
          type: "permission_status",
          payload: { microphone: "granted", accessibility: "missing" },
        }),
      });
    });

    expect(
      await screen.findByText(
        "Dictation can't paste into other apps until you grant accessibility access.",
      ),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Grant access" }));

    expect(mocks.dictationHelperCommand).toHaveBeenCalledWith({
      type: "request_accessibility_permission",
    });
    await waitFor(() =>
      expect(mocks.dictationHelperCommand).toHaveBeenCalledWith({
        type: "get_permission_status",
      }),
    );
    expect(mocks.openPrivacySettings).not.toHaveBeenCalledWith("accessibility");
  });

  it("keeps refreshing Accessibility while access is missing", async () => {
    render(<App />);

    await waitFor(() =>
      expect(mocks.listeners.has("dictation-event")).toBe(true),
    );
    await waitFor(() => expect(mocks.getNote).toHaveBeenCalledWith("note-1"));

    mocks.dictationHelperCommand.mockClear();

    await act(async () => {
      mocks.listeners.get("dictation-event")?.({
        payload: JSON.stringify({
          type: "permission_status",
          payload: { microphone: "granted", accessibility: "missing" },
        }),
      });
    });

    expect(
      await screen.findByText(
        "Dictation can't paste into other apps until you grant accessibility access.",
      ),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(mocks.dictationHelperCommand).toHaveBeenCalledWith({
        type: "get_permission_status",
      }),
    );

    await act(async () => {
      mocks.listeners.get("dictation-event")?.({
        payload: JSON.stringify({
          type: "permission_status",
          payload: { microphone: "granted", accessibility: "granted" },
        }),
      });
    });

    await waitFor(() =>
      expect(
        screen.queryByText(
          "Dictation can't paste into other apps until you grant accessibility access.",
        ),
      ).not.toBeInTheDocument(),
    );
  });

  it("lets users dismiss the Accessibility reminder while access is missing", async () => {
    const user = userEvent.setup();
    render(<App />);

    await waitFor(() =>
      expect(mocks.listeners.has("dictation-event")).toBe(true),
    );
    await waitFor(() => expect(mocks.getNote).toHaveBeenCalledWith("note-1"));

    await act(async () => {
      mocks.listeners.get("dictation-event")?.({
        payload: JSON.stringify({
          type: "permission_status",
          payload: { microphone: "granted", accessibility: "missing" },
        }),
      });
    });

    const message =
      "Dictation can't paste into other apps until you grant accessibility access.";
    expect(await screen.findByText(message)).toBeInTheDocument();

    await user.click(
      screen.getByRole("button", {
        name: "Dismiss accessibility reminder",
      }),
    );
    expect(screen.queryByText(message)).not.toBeInTheDocument();

    await act(async () => {
      mocks.listeners.get("dictation-event")?.({
        payload: JSON.stringify({
          type: "permission_status",
          payload: { microphone: "granted", accessibility: "missing" },
        }),
      });
    });
    expect(screen.queryByText(message)).not.toBeInTheDocument();

    await act(async () => {
      mocks.listeners.get("dictation-event")?.({
        payload: JSON.stringify({
          type: "permission_status",
          payload: { microphone: "granted", accessibility: "granted" },
        }),
      });
    });
    await act(async () => {
      mocks.listeners.get("dictation-event")?.({
        payload: JSON.stringify({
          type: "permission_status",
          payload: { microphone: "granted", accessibility: "missing" },
        }),
      });
    });

    expect(await screen.findByText(message)).toBeInTheDocument();
  });

  it("polls system audio readiness after opening the macOS permission pane", async () => {
    const user = userEvent.setup();
    const restoreNavigator = stubNavigatorPlatform(
      "MacIntel",
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
    );
    const deniedReadiness = recordingReadiness(false);
    const grantedReadiness = recordingReadiness(true);
    mocks.checkRecordingSourceReadiness
      .mockResolvedValueOnce(deniedReadiness)
      .mockResolvedValue(grantedReadiness);

    try {
      render(<App />);

      await waitFor(() =>
        expect(mocks.listeners.has(OPEN_SETTINGS_EVENT)).toBe(true),
      );
      await waitFor(() => expect(mocks.getNote).toHaveBeenCalledWith("note-1"));

      act(() => {
        mocks.listeners.get(OPEN_SETTINGS_EVENT)?.({});
      });

      expect(
        await screen.findByRole("heading", { name: "Appearance" }),
      ).toBeInTheDocument();
      const blockedRow = screen
        .getByText("System audio")
        .closest(".settings-row");
      expect(blockedRow).not.toBeNull();
      expect(
        within(blockedRow as HTMLElement).getByLabelText("Blocked"),
      ).toBeInTheDocument();

      await user.click(
        within(blockedRow as HTMLElement).getByRole("button", {
          name: "Manage System audio permission",
        }),
      );

      expect(mocks.openPrivacySettings).toHaveBeenCalledWith("systemAudio");
      await waitFor(() =>
        expect(mocks.checkRecordingSourceReadiness).toHaveBeenCalledTimes(2),
      );
      await waitFor(() => {
        const allowedRow = screen
          .getByText("System audio")
          .closest(".settings-row");
        expect(allowedRow).not.toBeNull();
        expect(
          within(allowedRow as HTMLElement).getByLabelText("Allowed"),
        ).toBeInTheDocument();
      });
    } finally {
      restoreNavigator();
    }
  });

  it("does not overlap system audio readiness polls while a probe is pending", async () => {
    const restoreNavigator = stubNavigatorPlatform(
      "MacIntel",
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
    );
    let resolveProbe: (value: RecordingSourceReadinessDto) => void = () => {};
    const pendingProbe = new Promise<RecordingSourceReadinessDto>((resolve) => {
      resolveProbe = resolve;
    });
    mocks.checkRecordingSourceReadiness
      .mockResolvedValueOnce(recordingReadiness(false))
      .mockReturnValue(pendingProbe);

    try {
      render(<App />);

      await waitFor(() =>
        expect(mocks.listeners.has(OPEN_SETTINGS_EVENT)).toBe(true),
      );
      await waitFor(() => expect(mocks.getNote).toHaveBeenCalledWith("note-1"));

      act(() => {
        mocks.listeners.get(OPEN_SETTINGS_EVENT)?.({});
      });

      expect(
        await screen.findByRole("heading", { name: "Appearance" }),
      ).toBeInTheDocument();
      const blockedRow = screen
        .getByText("System audio")
        .closest(".settings-row");
      expect(blockedRow).not.toBeNull();

      fireEvent.click(
        within(blockedRow as HTMLElement).getByRole("button", {
          name: "Manage System audio permission",
        }),
      );

      await waitFor(() =>
        expect(mocks.checkRecordingSourceReadiness).toHaveBeenCalledTimes(2),
      );

      await new Promise((resolve) => window.setTimeout(resolve, 1_200));

      expect(mocks.checkRecordingSourceReadiness).toHaveBeenCalledTimes(2);

      await act(async () => {
        resolveProbe(recordingReadiness(true));
        await pendingProbe;
      });
      await waitFor(() => {
        const allowedRow = screen
          .getByText("System audio")
          .closest(".settings-row");
        expect(allowedRow).not.toBeNull();
        expect(
          within(allowedRow as HTMLElement).getByLabelText("Allowed"),
        ).toBeInTheDocument();
      });
    } finally {
      restoreNavigator();
    }
  });

  it("pauses system audio readiness polling while recording is active", async () => {
    const restoreNavigator = stubNavigatorPlatform(
      "MacIntel",
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
    );
    let resolveProbe: (value: RecordingSourceReadinessDto) => void = () => {};
    const pendingProbe = new Promise<RecordingSourceReadinessDto>((resolve) => {
      resolveProbe = resolve;
    });
    let systemReadinessCalls = 0;
    mocks.checkRecordingSourceReadiness.mockImplementation(
      async (mode: string) => {
        if (mode === "microphoneOnly") return microphoneOnlyReadiness();
        systemReadinessCalls += 1;
        if (systemReadinessCalls === 1) return recordingReadiness(false);
        return pendingProbe;
      },
    );
    mocks.startRecording.mockImplementation(
      async (noteId: string, sourceMode: string) =>
        recordingSession({
          noteId,
          sourceMode: sourceMode as RecordingSessionDto["sourceMode"],
        }),
    );
    mocks.getRecordingStatus.mockResolvedValue({
      sessionId: "rec-1",
      noteId: "note-1",
      sourceMode: "microphoneOnly",
      state: "recording",
      elapsedMs: 0,
      level: { peak: 0, rms: 0, recentPeaks: [] },
      silenceWarning: false,
      bytesWritten: 0,
    });

    try {
      render(<App />);

      await waitFor(() =>
        expect(mocks.listeners.has(OPEN_SETTINGS_EVENT)).toBe(true),
      );
      await waitFor(() =>
        expect(mocks.listeners.has(MEETING_START_TRANSCRIPTION_EVENT)).toBe(
          true,
        ),
      );
      await waitFor(() => expect(mocks.getNote).toHaveBeenCalledWith("note-1"));

      act(() => {
        mocks.listeners.get(OPEN_SETTINGS_EVENT)?.({});
      });

      expect(
        await screen.findByRole("heading", { name: "Appearance" }),
      ).toBeInTheDocument();
      const blockedRow = screen
        .getByText("System audio")
        .closest(".settings-row");
      expect(blockedRow).not.toBeNull();

      fireEvent.click(
        within(blockedRow as HTMLElement).getByRole("button", {
          name: "Manage System audio permission",
        }),
      );

      await waitFor(() => expect(systemReadinessCalls).toBe(2));

      await waitFor(async () => {
        if (mocks.startRecording.mock.calls.length === 0) {
          await act(async () => {
            await mocks.listeners.get(MEETING_START_TRANSCRIPTION_EVENT)?.({
              payload: undefined,
            });
          });
        }
        expect(mocks.startRecording).toHaveBeenCalled();
      });
      expect(mocks.startRecording).toHaveBeenCalledWith(
        expect.any(String),
        "microphoneOnly",
      );

      await new Promise((resolve) => window.setTimeout(resolve, 1_200));

      expect(systemReadinessCalls).toBe(2);

      await act(async () => {
        resolveProbe(recordingReadiness(false));
        await pendingProbe;
      });
    } finally {
      restoreNavigator();
    }
  });

  it("starts a session with Ctrl-N and creates a note with Ctrl-Shift-N on Windows", async () => {
    const restoreNavigator = stubNavigatorPlatform(
      "Win32",
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
    );
    const onNewSession = vi.fn();
    window.addEventListener(AGENT_NEW_SESSION_EVENT, onNewSession);
    try {
      render(<App />);

      await waitFor(() => expect(mocks.getNote).toHaveBeenCalledWith("note-1"));

      // The Cmd key does nothing on Windows — Ctrl is the primary modifier.
      fireEvent.keyDown(window, { key: "n", metaKey: true });
      expect(onNewSession).not.toHaveBeenCalled();
      expect(mocks.createNote).not.toHaveBeenCalled();

      fireEvent.keyDown(window, { key: "n", ctrlKey: true });
      await waitFor(() => expect(onNewSession).toHaveBeenCalled());
      expect(mocks.createNote).not.toHaveBeenCalled();

      fireEvent.keyDown(window, { key: "n", ctrlKey: true, shiftKey: true });
      await waitFor(() =>
        expect(mocks.createNote).toHaveBeenCalledWith(undefined),
      );
    } finally {
      window.removeEventListener(AGENT_NEW_SESSION_EVENT, onNewSession);
      restoreNavigator();
    }
  });

  it("returns to the note after opening its folder from the note header", async () => {
    const user = userEvent.setup();
    const first = note({
      title: "First note",
      folderIds: ["folder-1"],
    });
    mocks.bootstrapApp.mockResolvedValue({
      folders: [
        {
          id: "folder-1",
          name: "Testing folder",
          createdAt: now,
          updatedAt: now,
        },
      ],
      notes: [first],
      activeRecoveries: [],
      providerConfigured: true,
    });
    mocks.getNote.mockResolvedValue(first);

    render(<App />);

    // The app launches on the agent view; the notes list is one hop away.
    await user.click(
      await screen.findByRole("button", { name: "Meeting notes" }),
    );
    await user.click(
      await screen.findByRole("button", { name: /^First note/ }),
    );
    await screen.findByDisplayValue("First note");
    fireEvent.click(
      screen.getByRole("button", { name: "Open Testing folder" }),
    );

    expect(
      await screen.findByRole("button", { name: /Rename project/ }),
    ).toHaveTextContent("Testing folder");

    await user.click(
      screen.getByRole("button", { name: /back to first note/i }),
    );

    expect(await screen.findByDisplayValue("First note")).toBeInTheDocument();
  });

  it("gates the app until the user signs in", async () => {
    const user = userEvent.setup();
    mocks.osAccountsStatus.mockResolvedValue({
      signedIn: false,
      configured: true,
    });

    render(<App />);

    expect(
      await screen.findByRole("heading", { name: "Welcome to June" }),
    ).toBeInTheDocument();
    expect(mocks.bootstrapApp).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "New note" })).toBeNull();

    await user.click(
      screen.getByRole("button", { name: "Continue with OpenSoftware" }),
    );

    await waitFor(() => expect(mocks.bootstrapApp).toHaveBeenCalledOnce());
    // Clearing the gate lands on a fresh agent session, not a new note.
    expect(
      await screen.findByRole("heading", { name: HERO_GREETING }),
    ).toBeInTheDocument();
    expect(mocks.createNote).not.toHaveBeenCalled();
  });

  it("uses Windows sign-in copy and opens meeting notes after sign-in", async () => {
    const user = userEvent.setup();
    const restoreNavigator = stubNavigatorPlatform(
      "Win32",
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
    );
    mocks.osAccountsStatus.mockResolvedValue({
      signedIn: false,
      configured: true,
    });

    try {
      render(<App />);

      expect(
        await screen.findByText(
          "Record conversations and turn them into notes with your OpenSoftware account.",
        ),
      ).toBeInTheDocument();
      expect(screen.queryByText(/dictate with/)).not.toBeInTheDocument();

      await user.click(
        screen.getByRole("button", { name: "Continue with OpenSoftware" }),
      );

      expect(
        await screen.findByRole("button", { name: "New note" }),
      ).toBeInTheDocument();
      expect(
        screen.queryByRole("heading", { name: HERO_GREETING }),
      ).not.toBeInTheDocument();
    } finally {
      restoreNavigator();
    }
  });

  it("does not flash the sign-in gate while account status is loading", async () => {
    let resolveStatus: ((status: AccountStatus) => void) | undefined;
    mocks.osAccountsStatus.mockReturnValue(
      new Promise<AccountStatus>((resolve) => {
        resolveStatus = resolve;
      }),
    );

    render(<App />);

    expect(
      screen.queryByRole("heading", { name: "Welcome to June" }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Continue with OpenSoftware" }),
    ).toBeNull();
    expect(mocks.bootstrapApp).not.toHaveBeenCalled();

    resolveStatus?.({
      signedIn: true,
      configured: true,
      user: { id: "usr_123", handle: "alex", email: "alex@example.com" },
      balance: { usdMillis: 1200 },
      subscription: { subscribed: true, status: "active" },
    });

    expect(
      await screen.findByRole("heading", { name: HERO_GREETING }),
    ).toBeInTheDocument();
  });

  it("bypasses account gates in dev when account status is unavailable", async () => {
    mocks.osAccountsStatus.mockRejectedValue(new Error("accounts unavailable"));

    render(<App />);

    expect(
      await screen.findByRole("heading", { name: HERO_GREETING }),
    ).toBeInTheDocument();
    expect(mocks.bootstrapApp).toHaveBeenCalledOnce();
    expect(
      screen.queryByRole("button", { name: "Continue with OpenSoftware" }),
    ).toBeNull();
  });
});
