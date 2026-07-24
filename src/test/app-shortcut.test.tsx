import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../app/App";
import { HERO_GREETINGS } from "../components/agent/AgentWorkspace";
import {
  dispatchDataPartitionChanged,
  resetCurrentDataPartitionForTests,
  setCurrentDataPartitionName,
} from "../lib/data-partition";
import { MEETING_START_TRANSCRIPTION_EVENT } from "../lib/events";
import {
  AGENT_NEW_SESSION_EVENT,
  AGENT_NEW_SESSION_PENDING_KEY,
  AGENT_OPEN_EVENT,
  AGENT_SESSIONS_CHANGED_EVENT,
} from "../lib/agent-events";
import { CLOSE_TAB_EVENT, OPEN_SETTINGS_EVENT } from "../lib/menu-bar";
import type { AgentSessionDto } from "../lib/agent-runtime-contract";
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
  pendingMeetingStartRequest: undefined as
    | { requestId: string; noteId: string; requestedAtMs: number; expired: boolean }
    | undefined,
  readPendingMeetingStartRequest: vi.fn(async () => mocks.pendingMeetingStartRequest ?? null),
  acknowledgeMeetingStartRequest: vi.fn(async (requestId: string) => {
    if (mocks.pendingMeetingStartRequest?.requestId !== requestId) return false;
    mocks.pendingMeetingStartRequest = undefined;
    return true;
  }),
  getCurrentWindow: vi.fn(),
  bootstrapApp: vi.fn(),
  createNote: vi.fn(),
  createFolder: vi.fn(),
  deleteFolder: vi.fn(),
  renameFolder: vi.fn(),
  assignNoteToFolder: vi.fn(),
  assignSessionToFolder: vi.fn(),
  removeNoteFromFolder: vi.fn(),
  listNotes: vi.fn(),
  listFolders: vi.fn(),
  getNote: vi.fn(),
  deleteNote: vi.fn(),
  updateNote: vi.fn(),
  patchNote: vi.fn(),
  completeNoteSaveFlush: vi.fn(async () => true),
  checkRecordingSourceReadiness: vi.fn(),
  openPrivacySettings: vi.fn(),
  startRecording: vi.fn(),
  startMeetingRecording: vi.fn(),
  pauseRecording: vi.fn(),
  resumeRecording: vi.fn(),
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
  agentOpenReady: vi.fn().mockResolvedValue(null),
  agentHudHide: vi.fn(),
  listAgentTasks: vi.fn(),
  listAgentSessions: vi.fn(),
  listSessionProfiles: vi.fn(),
  listVeniceModels: vi.fn(),
  localVideoFileSrc: vi.fn((path: string) => `asset://${path}`),
  p3aSettings: vi.fn(),
  playRecordingSound: vi.fn(),
  preloadRecordingSounds: vi.fn(),
  preloadAgentSounds: vi.fn(),
  providerModelSettings: vi.fn(),
  setP3aEnabled: vi.fn(),
  videoGenerate: vi.fn(),
  videoStatus: vi.fn(),
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

vi.mock("../lib/agent-sounds", () => ({
  preloadAgentSounds: mocks.preloadAgentSounds,
}));

vi.mock("../app/update-decision", async () => {
  const actual =
    await vi.importActual<typeof import("../app/update-decision")>("../app/update-decision");
  return {
    ...actual,
    startPeriodicJuneUpdateChecks: mocks.startPeriodicJuneUpdateChecks,
  };
});

vi.mock("../lib/tauri", () => ({
  agentRuntimeBindings: {
    listSessions: mocks.listAgentSessions,
    getSession: vi.fn(),
    createSession: vi.fn(),
    renameSession: vi.fn(),
    deleteSession: vi.fn(),
    listItems: vi.fn(async () => []),
    listArtifacts: vi.fn(async () => []),
    startRun: vi.fn(),
    cancelRun: vi.fn(),
    retryRun: vi.fn(),
    resolveInterruption: vi.fn(),
    listSkills: vi.fn(async () => []),
    updateSkill: vi.fn(),
  },
  listAgentSessions: mocks.listAgentSessions,
  dictationCapabilities: vi.fn().mockResolvedValue({
    capabilities: {
      available: true,
      platform: "macos",
      shortcuts: true,
      paste: true,
      microphoneSelection: true,
      accessibilityPermission: true,
      systemAudio: true,
    },
  }),
  primeGeneratedVideoDir: vi.fn().mockResolvedValue(undefined),
  computerUseBeginRun: vi.fn().mockResolvedValue(undefined),
  computerUseEndRun: vi.fn().mockResolvedValue(undefined),
  computerUseStop: vi.fn().mockResolvedValue(undefined),
  LIVE_TRANSCRIPT_EVENT: "live-transcript-event",
  RECORDING_TELEMETRY_EVENT: "recording-telemetry",
  NOTE_PROCESSING_PROGRESS_EVENT: "note-processing-progress",
  NOTE_CALENDAR_CONTEXT_UPDATED_EVENT: "note-calendar-context-updated-event",
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
  listCompletedSessions: vi.fn(async () => []),
  setSessionCompleted: vi.fn(async () => undefined),
  listSessionProfiles: mocks.listSessionProfiles,
  assignSessionToFolder: mocks.assignSessionToFolder,
  assignSessionToProfile: vi.fn(async () => undefined),
  removeSessionFromFolder: vi.fn(async () => undefined),
  listMemories: vi.fn(async () => []),
  memorySettings: vi.fn(async () => ({ enabled: true })),
  createMemory: vi.fn(),
  updateMemory: vi.fn(),
  deleteMemory: vi.fn(),
  setMemoryEnabled: vi.fn(),
  setFolderInstructions: vi.fn(),
  setFolderMemoryDisabled: vi.fn(),
  removeNoteFromFolder: mocks.removeNoteFromFolder,
  listNotes: mocks.listNotes,
  listFolders: mocks.listFolders,
  getNote: mocks.getNote,
  deleteNote: mocks.deleteNote,
  updateNote: mocks.updateNote,
  patchNote: mocks.patchNote,
  completeNoteSaveFlush: mocks.completeNoteSaveFlush,
  NOTE_SAVE_FLUSH_REQUESTED_EVENT: "june://flush-pending-note-saves",
  checkRecordingSourceReadiness: mocks.checkRecordingSourceReadiness,
  openPrivacySettings: mocks.openPrivacySettings,
  startRecording: mocks.startRecording,
  pauseRecording: mocks.pauseRecording,
  resumeRecording: mocks.resumeRecording,
  finishRecording: mocks.finishRecording,
  retryProcessing: mocks.retryProcessing,
  recoverRecording: mocks.recoverRecording,
  dictationHelperCommand: mocks.dictationHelperCommand,
  listDictationHistory: mocks.listDictationHistory,
  osAccountsStatus: mocks.osAccountsStatus,
  osAccountsStatusLocal: mocks.osAccountsStatus,
  osAccountsLogin: mocks.osAccountsLogin,
  osAccountsCancelLogin: mocks.osAccountsCancelLogin,
  osAccountsLogout: mocks.osAccountsLogout,
  osAccountsUpgrade: mocks.osAccountsUpgrade,
  agentHudShow: mocks.agentHudShow,
  agentOpenReady: mocks.agentOpenReady,
  agentHudHide: mocks.agentHudHide,
  pendingMeetingStartRequest: mocks.readPendingMeetingStartRequest,
  acknowledgeMeetingStartRequest: mocks.acknowledgeMeetingStartRequest,
  startMeetingRecording: mocks.startMeetingRecording,
  listAgentTasks: mocks.listAgentTasks,
  juneVerifyUrl: vi.fn(async () => ""),
  p3aSettings: mocks.p3aSettings,
  providerModelSettings: mocks.providerModelSettings,
  setP3aEnabled: mocks.setP3aEnabled,
  listVeniceModels: mocks.listVeniceModels,
  localVideoFileSrc: mocks.localVideoFileSrc,
  videoGenerate: mocks.videoGenerate,
  videoStatus: mocks.videoStatus,
  setVeniceApiKey: vi.fn(async () => ({
    generationModel: "",
    veniceApiKeyConfigured: true,
  })),
  clearVeniceApiKey: vi.fn(async () => ({
    generationModel: "",
    veniceApiKeyConfigured: false,
  })),
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

function agentSession(id: string, title: string): AgentSessionDto {
  return {
    id,
    title,
    status: "idle",
    model: "auto",
    safetyMode: "sandboxed",
    workspacePath: `/tmp/june-agent-workspaces/${id}`,
    source: "user",
    createdAt: now,
    updatedAt: now,
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

function recordingSession(overrides: Partial<RecordingSessionDto> = {}): RecordingSessionDto {
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
    mocks.pendingMeetingStartRequest = undefined;
    mocks.readPendingMeetingStartRequest.mockImplementation(
      async () => mocks.pendingMeetingStartRequest ?? null,
    );
    mocks.acknowledgeMeetingStartRequest.mockImplementation(async (requestId: string) => {
      if (mocks.pendingMeetingStartRequest?.requestId !== requestId) return false;
      mocks.pendingMeetingStartRequest = undefined;
      return true;
    });
    resetCurrentDataPartitionForTests();
    setCurrentDataPartitionName("default");
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
      show: vi.fn().mockResolvedValue(undefined),
      unminimize: vi.fn().mockResolvedValue(undefined),
      setFocus: vi.fn().mockResolvedValue(undefined),
      startDragging: vi.fn().mockResolvedValue(undefined),
    });
    mocks.bootstrapApp.mockResolvedValue(payload);
    mocks.getNote.mockResolvedValue(first);
    mocks.listFolders.mockResolvedValue([]);
    mocks.createNote.mockResolvedValue(created);
    mocks.assignSessionToFolder.mockResolvedValue(undefined);
    mocks.checkRecordingSourceReadiness.mockResolvedValue({
      sources: [
        { source: "microphone", ready: true },
        { source: "system", ready: true, permissionState: "granted" },
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
    mocks.agentOpenReady.mockResolvedValue(null);
    mocks.listAgentTasks.mockResolvedValue({ items: [] });
    mocks.listAgentSessions.mockResolvedValue([]);
    mocks.listSessionProfiles.mockResolvedValue([]);
    mocks.listVeniceModels.mockResolvedValue({
      mode: "generation",
      modelType: "text",
      selectedModel: "",
      models: [],
    });
    mocks.providerModelSettings.mockResolvedValue({
      settings: { generationModel: "" },
    });
    mocks.p3aSettings.mockResolvedValue({
      settings: {
        enabled: false,
        consentedAtWeek: null,
        consentVersion: 1,
      },
    });
    mocks.setP3aEnabled.mockResolvedValue({
      settings: {
        enabled: false,
        consentedAtWeek: null,
        consentVersion: 1,
      },
    });
    mocks.startPeriodicJuneUpdateChecks.mockReturnValue(vi.fn());
    mocks.suggestAgentSessionTitle.mockImplementation(async (prompt: string) => ({
      title: prompt,
    }));
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
      async (event: string, handler: (event: { payload?: unknown }) => void) => {
        mocks.listeners.set(event, handler);
        return () => mocks.listeners.delete(event);
      },
    );
    mocks.updateNote.mockImplementation(async (input) => ({
      ...first,
      ...input,
    }));
    mocks.patchNote.mockImplementation(async (noteId, patch) => ({
      id: noteId,
      title: patch.title ?? first.title,
      preview: first.preview,
      editedContent: patch.editedContent ?? first.editedContent,
      activeTab: patch.activeTab ?? first.activeTab,
      updatedAt: first.updatedAt,
    }));
  });

  it("starts background update checks after launch gates clear", async () => {
    vi.stubEnv("DEV", false);

    try {
      render(<App />);

      await waitFor(() => expect(mocks.getNote).toHaveBeenCalledWith("note-1"));
      await waitFor(() => expect(mocks.startPeriodicJuneUpdateChecks).toHaveBeenCalledOnce());
      expect(mocks.startPeriodicJuneUpdateChecks.mock.calls[0]?.[0]).toEqual(expect.any(Function));
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("clears the OS Accounts browser session from sidebar sign-out", async () => {
    const user = userEvent.setup();

    render(<App />);

    await waitFor(() => expect(mocks.getNote).toHaveBeenCalledWith("note-1"));

    await user.click(screen.getByRole("button", { name: "alex@example.com, account menu" }));
    await user.click(screen.getByRole("menuitem", { name: "Sign out" }));

    expect(mocks.osAccountsLogout).toHaveBeenCalledWith({ clearBrowserSession: true });
    expect(await screen.findByRole("heading", { name: "Welcome to June" })).toBeInTheDocument();
  });

  it("keeps notes, session history, and sign out available while funding is required", async () => {
    const user = userEvent.setup();
    mocks.osAccountsStatus.mockResolvedValue({
      signedIn: true,
      configured: true,
      user: { id: "usr_123", handle: "alex", email: "alex@example.com" },
      balance: { credits: 0, usdMillis: 0 },
      subscription: { subscribed: false },
    });

    render(<App />);

    await waitFor(() => expect(mocks.getNote).toHaveBeenCalledWith("note-1"));
    // No modal ever blocks the shell; the state lives in the sidebar chip.
    expect(await screen.findByRole("button", { name: "Out of credits" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Meeting notes" }));
    expect(await screen.findByRole("heading", { name: /Meeting notes/ })).toBeInTheDocument();
    expect(screen.getByText("First note")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Sessions" }));
    expect(await screen.findByRole("heading", { name: "Sessions" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "alex@example.com, account menu" }));
    await user.click(screen.getByRole("menuitem", { name: "Sign out" }));
    expect(mocks.osAccountsLogout).toHaveBeenCalledWith({ clearBrowserSession: true });
    expect(await screen.findByRole("heading", { name: "Welcome to June" })).toBeInTheDocument();
  });

  it("docks a persistent, non-dismissible notice above the composer while funding is required", async () => {
    mocks.osAccountsStatus.mockResolvedValue({
      signedIn: true,
      configured: true,
      user: { id: "usr_123", handle: "alex", email: "alex@example.com" },
      balance: { credits: 0, usdMillis: 0 },
      subscription: { subscribed: false },
    });

    render(<App />);

    // The copy renders on the composer notice and inside the sidebar chip's
    // (collapsed) reveal.
    expect(
      (await screen.findAllByText("Your starter credits are used up. Upgrade to keep using June."))
        .length,
    ).toBeGreaterThan(0);
    expect(screen.getAllByRole("button", { name: "Upgrade to Pro" }).length).toBeGreaterThan(0);
    // The notice is not a dialog and offers no dismissal.
    expect(screen.queryByRole("dialog", { name: "Credits needed" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Not now" })).not.toBeInTheDocument();
  });

  it("drives the out-of-credits surfaces from the __fundingDemo console hook", async () => {
    render(<App />);

    await waitFor(() => expect(mocks.getNote).toHaveBeenCalledWith("note-1"));
    const demo = await waitFor(() => {
      const hook = (window as { __fundingDemo?: (branch?: string) => string }).__fundingDemo;
      expect(hook).toBeTypeOf("function");
      return hook as (branch?: string) => string;
    });

    // Funded account: no funding surfaces anywhere.
    expect(screen.queryByRole("button", { name: "Out of credits" })).toBeNull();

    await act(async () => {
      demo("pro");
    });
    expect(
      (
        await screen.findAllByText(
          "You have used your Pro credits for this cycle. Max has 5x the monthly usage.",
        )
      ).length,
    ).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Out of credits" })).toBeInTheDocument();

    await act(async () => {
      demo("off");
    });
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Out of credits" })).toBeNull(),
    );
  });

  it("keeps recoverable audio available while funding blocks recovery", async () => {
    const user = userEvent.setup();
    mocks.bootstrapApp.mockResolvedValue({
      folders: [],
      notes: [note()],
      activeRecoveries: [
        {
          sessionId: "recovery-1",
          noteId: "note-1",
          startedAt: now,
          partialPathPresent: true,
          finalPathPresent: false,
          bytesFound: 4096,
        },
      ],
      providerConfigured: true,
    });
    mocks.osAccountsStatus.mockResolvedValue({
      signedIn: true,
      configured: true,
      user: { id: "usr_123", handle: "alex", email: "alex@example.com" },
      balance: { credits: 0, usdMillis: 0 },
      subscription: { subscribed: false },
    });

    render(<App />);

    await user.click(await screen.findByRole("button", { name: "Meeting notes" }));
    await user.click(await screen.findByText("First note"));

    const recoveryPrompt = await screen.findByLabelText("Recoverable recording");
    const recover = within(recoveryPrompt).getByRole("button", { name: "Recover" });
    expect(recover).toBeDisabled();
    expect(within(recoveryPrompt).getByRole("button", { name: "Discard" })).toBeEnabled();
    expect(
      within(recoveryPrompt).getByText(
        "Add credits before recovering this recording. Your saved audio will stay available.",
      ),
    ).toBeInTheDocument();

    fireEvent.click(recover);
    expect(mocks.recoverRecording).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Recoverable recording")).toBeInTheDocument();
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

  it("keeps each agent tab tied to its selected session", async () => {
    const restoreNavigator = stubNavigatorPlatform(
      "MacIntel",
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
    );
    const user = userEvent.setup();

    try {
      render(<App />);

      expect(await screen.findByRole("heading", { name: HERO_GREETING })).toBeInTheDocument();

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
        expect(screen.getByRole("tab", { name: "First session" })).toHaveAttribute(
          "data-active",
          "true",
        ),
      );

      await user.click(screen.getByRole("button", { name: "New tab" }));
      expect(await screen.findByRole("tab", { name: "New session" })).toHaveAttribute(
        "data-active",
        "true",
      );

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
        expect(screen.getByRole("tab", { name: "Second session" })).toHaveAttribute(
          "data-active",
          "true",
        ),
      );

      await user.click(screen.getByRole("button", { name: "Show all 2 tabs" }));
      await user.click(screen.getByRole("menuitem", { name: "First session" }));

      await waitFor(() =>
        expect(screen.getByRole("tab", { name: "First session" })).toHaveAttribute(
          "data-active",
          "true",
        ),
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

    await waitFor(() => expect(mocks.createNote).toHaveBeenCalledWith(undefined));
    await waitFor(() =>
      expect(screen.getByRole("tab", { name: "New note" })).toHaveAttribute("data-active", "true"),
    );
  });

  it("closes the active tab with Command-W", async () => {
    render(<App />);

    await waitFor(() => expect(mocks.getNote).toHaveBeenCalledWith("note-1"));
    fireEvent.keyDown(window, { key: "n", metaKey: true, shiftKey: true });
    await waitFor(() =>
      expect(screen.getByRole("tab", { name: "New note" })).toHaveAttribute("data-active", "true"),
    );

    fireEvent.keyDown(window, { key: "w", metaKey: true });

    await waitFor(() =>
      expect(screen.queryByRole("tab", { name: "New note" })).not.toBeInTheDocument(),
    );
    expect(screen.getByRole("tab", { name: "New session" })).toHaveAttribute("data-active", "true");
  });

  it("closes the active tab from the native close-tab menu event", async () => {
    render(<App />);
    const closeTabListenerCount = () =>
      mocks.listen.mock.calls.filter(([event]) => event === CLOSE_TAB_EVENT).length;

    await waitFor(() => expect(mocks.getNote).toHaveBeenCalledWith("note-1"));
    await waitFor(() => expect(mocks.listeners.has(CLOSE_TAB_EVENT)).toBe(true));
    expect(closeTabListenerCount()).toBe(1);
    fireEvent.keyDown(window, { key: "n", metaKey: true, shiftKey: true });
    await waitFor(() =>
      expect(screen.getByRole("tab", { name: "New note" })).toHaveAttribute("data-active", "true"),
    );
    expect(closeTabListenerCount()).toBe(1);

    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    document.body.appendChild(dialog);
    mocks.listeners.get(CLOSE_TAB_EVENT)?.({});
    expect(screen.getByRole("tab", { name: "New note" })).toHaveAttribute("data-active", "true");
    dialog.remove();

    mocks.listeners.get(CLOSE_TAB_EVENT)?.({});

    await waitFor(() =>
      expect(screen.queryByRole("tab", { name: "New note" })).not.toBeInTheDocument(),
    );
    expect(screen.getByRole("tab", { name: "New session" })).toHaveAttribute("data-active", "true");
    expect(closeTabListenerCount()).toBe(1);
  });

  it("opens settings from the native app menu event", async () => {
    render(<App />);

    await waitFor(() => expect(mocks.listeners.has(OPEN_SETTINGS_EVENT)).toBe(true));

    act(() => {
      mocks.listeners.get(OPEN_SETTINGS_EVENT)?.({});
    });

    expect(
      await screen.findByRole("heading", { name: "General" }, { timeout: 10_000 }),
    ).toBeInTheDocument();
  });

  it("refreshes Accessibility after requesting access without opening settings over the native prompt", async () => {
    const user = userEvent.setup();
    render(<App />);

    await waitFor(() => expect(mocks.listeners.has("dictation-event")).toBe(true));
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

  it("opens Accessibility settings when the dictation helper is unavailable", async () => {
    const user = userEvent.setup();
    render(<App />);

    await waitFor(() => expect(mocks.listeners.has("dictation-event")).toBe(true));
    await waitFor(() => expect(mocks.getNote).toHaveBeenCalledWith("note-1"));

    mocks.dictationHelperCommand.mockImplementation(async (command: { type: string }) => {
      if (command.type === "request_accessibility_permission") {
        throw new Error("helper unavailable");
      }
      return undefined;
    });
    mocks.openPrivacySettings.mockClear();

    await act(async () => {
      mocks.listeners.get("dictation-event")?.({
        payload: JSON.stringify({
          type: "permission_status",
          payload: { microphone: "granted", accessibility: "missing" },
        }),
      });
    });

    await user.click(await screen.findByRole("button", { name: "Grant access" }));

    await waitFor(() => expect(mocks.openPrivacySettings).toHaveBeenCalledWith("accessibility"));
  });

  it("keeps refreshing Accessibility while access is missing", async () => {
    render(<App />);

    await waitFor(() => expect(mocks.listeners.has("dictation-event")).toBe(true));
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

    await waitFor(() => expect(mocks.listeners.has("dictation-event")).toBe(true));
    await waitFor(() => expect(mocks.getNote).toHaveBeenCalledWith("note-1"));

    await act(async () => {
      mocks.listeners.get("dictation-event")?.({
        payload: JSON.stringify({
          type: "permission_status",
          payload: { microphone: "granted", accessibility: "missing" },
        }),
      });
    });

    const message = "Dictation can't paste into other apps until you grant accessibility access.";
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

      await waitFor(() => expect(mocks.listeners.has(OPEN_SETTINGS_EVENT)).toBe(true));
      await waitFor(() => expect(mocks.getNote).toHaveBeenCalledWith("note-1"));

      act(() => {
        mocks.listeners.get(OPEN_SETTINGS_EVENT)?.({});
      });

      expect(await screen.findByRole("heading", { name: "General" })).toBeInTheDocument();
      const blockedRow = screen.getByText("System audio").closest(".settings-row");
      expect(blockedRow).not.toBeNull();
      expect(within(blockedRow as HTMLElement).getByLabelText("Blocked")).toBeInTheDocument();

      await user.click(
        within(blockedRow as HTMLElement).getByRole("button", {
          name: "Manage System audio permission",
        }),
      );

      expect(mocks.openPrivacySettings).toHaveBeenCalledWith("systemAudio");
      await waitFor(() => expect(mocks.checkRecordingSourceReadiness).toHaveBeenCalledTimes(2));
      await waitFor(() => {
        const allowedRow = screen.getByText("System audio").closest(".settings-row");
        expect(allowedRow).not.toBeNull();
        expect(within(allowedRow as HTMLElement).getByLabelText("Allowed")).toBeInTheDocument();
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

      await waitFor(() => expect(mocks.listeners.has(OPEN_SETTINGS_EVENT)).toBe(true));
      await waitFor(() => expect(mocks.getNote).toHaveBeenCalledWith("note-1"));

      act(() => {
        mocks.listeners.get(OPEN_SETTINGS_EVENT)?.({});
      });

      expect(await screen.findByRole("heading", { name: "General" })).toBeInTheDocument();
      const blockedRow = screen.getByText("System audio").closest(".settings-row");
      expect(blockedRow).not.toBeNull();

      fireEvent.click(
        within(blockedRow as HTMLElement).getByRole("button", {
          name: "Manage System audio permission",
        }),
      );

      await waitFor(() => expect(mocks.checkRecordingSourceReadiness).toHaveBeenCalledTimes(2));

      await new Promise((resolve) => window.setTimeout(resolve, 1_200));

      expect(mocks.checkRecordingSourceReadiness).toHaveBeenCalledTimes(2);

      await act(async () => {
        resolveProbe(recordingReadiness(true));
        await pendingProbe;
      });
      await waitFor(() => {
        const allowedRow = screen.getByText("System audio").closest(".settings-row");
        expect(allowedRow).not.toBeNull();
        expect(within(allowedRow as HTMLElement).getByLabelText("Allowed")).toBeInTheDocument();
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
    mocks.checkRecordingSourceReadiness.mockImplementation(async (mode: string) => {
      if (mode === "microphoneOnly") return microphoneOnlyReadiness();
      systemReadinessCalls += 1;
      if (systemReadinessCalls === 1) return recordingReadiness(false);
      return pendingProbe;
    });
    const meetingNote = note({ id: "meeting-note", title: "" });
    mocks.startMeetingRecording.mockImplementation(
      async (_requestId: string, sourceMode: string) => ({
        status: "started",
        note: meetingNote,
        recording: recordingSession({
          noteId: meetingNote.id,
          sourceMode: sourceMode as RecordingSessionDto["sourceMode"],
        }),
      }),
    );
    try {
      render(<App />);

      await waitFor(() => expect(mocks.listeners.has(OPEN_SETTINGS_EVENT)).toBe(true));
      await waitFor(() =>
        expect(mocks.listeners.has(MEETING_START_TRANSCRIPTION_EVENT)).toBe(true),
      );
      await waitFor(() => expect(mocks.getNote).toHaveBeenCalledWith("note-1"));

      act(() => {
        mocks.listeners.get(OPEN_SETTINGS_EVENT)?.({});
      });

      expect(await screen.findByRole("heading", { name: "General" })).toBeInTheDocument();
      const blockedRow = screen.getByText("System audio").closest(".settings-row");
      expect(blockedRow).not.toBeNull();

      fireEvent.click(
        within(blockedRow as HTMLElement).getByRole("button", {
          name: "Manage System audio permission",
        }),
      );

      await waitFor(() => expect(systemReadinessCalls).toBe(2));

      mocks.pendingMeetingStartRequest = {
        requestId: "meeting-request-1",
        noteId: meetingNote.id,
        requestedAtMs: Date.now(),
        expired: false,
      };
      await act(async () => {
        await mocks.listeners.get(MEETING_START_TRANSCRIPTION_EVENT)?.({
          payload: undefined,
        });
      });
      await waitFor(() => expect(mocks.startMeetingRecording).toHaveBeenCalled());
      expect(mocks.startMeetingRecording).toHaveBeenCalledWith(
        "meeting-request-1",
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
      await waitFor(() => expect(mocks.createNote).toHaveBeenCalledWith(undefined));
    } finally {
      window.removeEventListener(AGENT_NEW_SESSION_EVENT, onNewSession);
      restoreNavigator();
    }
  });

  it("opens a fresh agent session on Windows while preloading the first note", async () => {
    const restoreNavigator = stubNavigatorPlatform(
      "Win32",
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
    );
    const staleSession = {
      id: "session-1",
      title: "Stored session",
      preview: "Stored session preview",
      last_active: now,
    };
    window.localStorage.setItem("june:agent:last-open-session", staleSession.id);
    mocks.listAgentSessions.mockResolvedValue([staleSession]);
    const sessionStorageSetItem = window.sessionStorage.setItem.bind(window.sessionStorage);
    const sessionStorageSetItemSpy = vi
      .spyOn(window.sessionStorage, "setItem")
      .mockImplementation((key, value) => {
        if (key === AGENT_NEW_SESSION_PENDING_KEY) {
          throw new DOMException("Storage unavailable", "QuotaExceededError");
        }
        sessionStorageSetItem(key, value);
      });

    try {
      render(<App />);

      expect(await screen.findByRole("heading", { name: HERO_GREETING })).toBeInTheDocument();
      expect(await screen.findByRole("button", { name: "Stored session" })).toBeInTheDocument();
      expect(screen.getByRole("tab", { name: "New session" })).toHaveAttribute(
        "data-active",
        "true",
      );
      expect(screen.getByRole("button", { name: "New session" })).toHaveAttribute(
        "aria-current",
        "page",
      );
      expect(screen.getByRole("region", { name: "Sessions" })).toHaveAttribute(
        "data-active",
        "true",
      );
      expect(screen.queryByRole("button", { name: "New note" })).not.toBeInTheDocument();
      expect(screen.queryByDisplayValue("First note")).not.toBeInTheDocument();
      await waitFor(() => expect(mocks.getNote).toHaveBeenCalledWith("note-1"));
    } finally {
      sessionStorageSetItemSpy.mockRestore();
      window.localStorage.removeItem("june:agent:last-open-session");
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
    await user.click(await screen.findByRole("button", { name: "Meeting notes" }));
    await user.click(await screen.findByRole("button", { name: /^First note/ }));
    await screen.findByDisplayValue("First note");
    fireEvent.click(screen.getByRole("button", { name: "Open Testing folder" }));

    expect(await screen.findByRole("button", { name: /Rename project/ })).toHaveTextContent(
      "Testing folder",
    );

    await user.click(screen.getByRole("button", { name: /back to first note/i }));

    expect(await screen.findByDisplayValue("First note")).toBeInTheDocument();
  });

  it("gates the app until the user signs in", async () => {
    const user = userEvent.setup();
    mocks.osAccountsStatus.mockResolvedValue({
      signedIn: false,
      configured: true,
    });

    render(<App />);

    expect(await screen.findByRole("heading", { name: "Welcome to June" })).toBeInTheDocument();
    expect(mocks.bootstrapApp).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "New note" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Continue with OpenSoftware" }));

    await waitFor(() => expect(mocks.bootstrapApp).toHaveBeenCalledOnce());
    // Clearing the gate lands on a fresh agent session, not a new note.
    expect(await screen.findByRole("heading", { name: HERO_GREETING })).toBeInTheDocument();
    expect(mocks.createNote).not.toHaveBeenCalled();
  });

  it("uses Windows dictation sign-in copy and opens a fresh agent session after sign-in", async () => {
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
          "Record conversations, turn them into notes, and dictate with your OpenSoftware account.",
        ),
      ).toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: "Continue with OpenSoftware" }));

      expect(await screen.findByRole("heading", { name: HERO_GREETING })).toBeInTheDocument();
      expect(screen.getByRole("tab", { name: "New session" })).toHaveAttribute(
        "data-active",
        "true",
      );
      expect(screen.getByRole("button", { name: "New session" })).toHaveAttribute(
        "aria-current",
        "page",
      );
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

    expect(screen.queryByRole("heading", { name: "Welcome to June" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Continue with OpenSoftware" })).toBeNull();
    expect(mocks.bootstrapApp).not.toHaveBeenCalled();

    resolveStatus?.({
      signedIn: true,
      configured: true,
      user: { id: "usr_123", handle: "alex", email: "alex@example.com" },
      balance: { usdMillis: 1200 },
      subscription: { subscribed: true, status: "active" },
    });

    expect(await screen.findByRole("heading", { name: HERO_GREETING })).toBeInTheDocument();
  });

  it("bypasses account gates in dev when account status is unavailable", async () => {
    mocks.osAccountsStatus.mockRejectedValue(new Error("accounts unavailable"));

    render(<App />);

    expect(await screen.findByRole("heading", { name: HERO_GREETING })).toBeInTheDocument();
    expect(mocks.bootstrapApp).toHaveBeenCalledOnce();
    expect(screen.queryByRole("button", { name: "Continue with OpenSoftware" })).toBeNull();
  });

  it("refreshes partition-scoped chat sessions when the data partition switches", async () => {
    render(<App />);
    await waitFor(() => expect(mocks.getNote).toHaveBeenCalledWith("note-1"));
    await waitFor(() => expect(mocks.listAgentSessions).toHaveBeenCalled());
    const callsBeforeSwitch = mocks.listAgentSessions.mock.calls.length;

    act(() => {
      setCurrentDataPartitionName("research");
    });

    await waitFor(() =>
      expect(mocks.listAgentSessions.mock.calls.length).toBeGreaterThan(callsBeforeSwitch),
    );
  });

  it("exposes no sessions before the profile mapping has loaded successfully", async () => {
    const user = userEvent.setup();
    const privateSession = {
      id: "profile-a-session",
      title: "Named profile secret",
      preview: "Private profile conversation",
      last_active: now,
    };
    mocks.listSessionProfiles.mockRejectedValue(new Error("session profile map unavailable"));

    render(<App />);
    await waitFor(() => expect(mocks.listSessionProfiles).toHaveBeenCalled());

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent(AGENT_SESSIONS_CHANGED_EVENT, {
          detail: {
            sessions: [privateSession],
            selectedSessionId: undefined,
            workingSessionIds: [],
          },
        }),
      );
      await Promise.resolve();
    });

    await user.click(screen.getByRole("button", { name: "Sessions" }));
    expect(await screen.findByRole("heading", { name: "Sessions" })).toBeInTheDocument();
    expect(screen.queryByText(privateSession.title)).toBeNull();
  });

  it("invalidates note tabs from the previous profile", async () => {
    const user = userEvent.setup();
    const profileANote = note({ id: "note-a", title: "Profile A private note" });
    const profileBNote = note({ id: "note-b", title: "Profile B note" });
    mocks.createNote.mockResolvedValue(profileANote);

    render(<App />);
    await waitFor(() => expect(mocks.getNote).toHaveBeenCalledWith("note-1"));

    fireEvent.keyDown(window, { key: "n", metaKey: true, shiftKey: true });
    await waitFor(() =>
      expect(screen.getByRole("tab", { name: "Profile A private note" })).toHaveAttribute(
        "data-active",
        "true",
      ),
    );
    await user.click(screen.getByRole("button", { name: "New tab" }));

    mocks.listNotes.mockResolvedValue({ items: [profileBNote] });
    mocks.listFolders.mockResolvedValue([]);
    mocks.getNote.mockImplementation(async (noteId: string) =>
      noteId === profileBNote.id ? profileBNote : profileANote,
    );
    act(() => setCurrentDataPartitionName("profile-b"));

    await waitFor(() => expect(mocks.getNote).toHaveBeenCalledWith(profileBNote.id));
    mocks.getNote.mockClear();

    fireEvent.keyDown(window, { key: "1", metaKey: true });

    const invalidatedTab = await screen.findByRole("tab", { name: "Notes" });
    await waitFor(() => expect(invalidatedTab).toHaveAttribute("data-active", "true"));
    expect(mocks.getNote).not.toHaveBeenCalled();
    expect(screen.queryByText("Profile A private note")).toBeNull();
  });

  it("abandons pending project intent when the data partition switches", async () => {
    const user = userEvent.setup();
    const folder = {
      id: "folder-a",
      name: "Profile A project",
      memoryDisabled: false,
      createdAt: now,
      updatedAt: now,
    };
    mocks.bootstrapApp.mockResolvedValue({
      folders: [folder],
      notes: [note()],
      activeRecoveries: [],
      providerConfigured: true,
    });

    render(<App />);
    await waitFor(() => expect(mocks.getNote).toHaveBeenCalledWith("note-1"));
    await user.click(screen.getByRole("button", { name: "Projects" }));
    const projectCard = (await screen.findByText(folder.name)).closest("article");
    expect(projectCard).not.toBeNull();
    await user.click(projectCard as HTMLElement);
    const newSessionButtons = await screen.findAllByRole("button", { name: "New session" });
    const projectNewSessionButton = newSessionButtons.at(-1);
    expect(projectNewSessionButton).toBeDefined();
    await user.click(projectNewSessionButton as HTMLElement);

    mocks.listNotes.mockResolvedValue({ items: [] });
    mocks.listFolders.mockResolvedValue([]);
    act(() => setCurrentDataPartitionName("profile-b"));
    await waitFor(() => expect(mocks.listFolders).toHaveBeenCalled());

    act(() => {
      window.dispatchEvent(
        new CustomEvent(AGENT_SESSIONS_CHANGED_EVENT, {
          detail: {
            sessions: [{ id: "profile-b-session", title: "Profile B session" }],
            selectedSessionId: "profile-b-session",
            workingSessionIds: [],
          },
        }),
      );
    });

    await act(async () => {
      await Promise.resolve();
    });
    expect(mocks.assignSessionToFolder).not.toHaveBeenCalled();
  });

  it("refreshes visible data when rows move into the current data partition", async () => {
    render(<App />);
    await waitFor(() => expect(mocks.getNote).toHaveBeenCalledWith("note-1"));
    await waitFor(() => expect(mocks.listAgentSessions).toHaveBeenCalled());
    const noteCallsBeforeMove = mocks.listNotes.mock.calls.length;
    const sessionCallsBeforeMove = mocks.listAgentSessions.mock.calls.length;

    act(() => {
      dispatchDataPartitionChanged("default");
    });

    await waitFor(() =>
      expect(mocks.listNotes.mock.calls.length).toBeGreaterThan(noteCallsBeforeMove),
    );
    await waitFor(() =>
      expect(mocks.listAgentSessions.mock.calls.length).toBeGreaterThan(sessionCallsBeforeMove),
    );
  });

  it("opens the chat for a notification click carrying a session id", async () => {
    mocks.listAgentSessions.mockResolvedValue([agentSession("session-9", "Notified session")]);

    render(<App />);
    await waitFor(() => expect(mocks.getNote).toHaveBeenCalledWith("note-1"));

    act(() => {
      window.dispatchEvent(
        new CustomEvent(AGENT_OPEN_EVENT, { detail: { sessionId: "session-9" } }),
      );
    });

    expect(await screen.findByRole("button", { name: "Send message" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: HERO_GREETING })).not.toBeInTheDocument();
  });

  it("falls back to the agent view when the notified chat is missing", async () => {
    mocks.listAgentSessions.mockResolvedValue([]);

    render(<App />);
    await waitFor(() => expect(mocks.getNote).toHaveBeenCalledWith("note-1"));

    act(() => {
      window.dispatchEvent(
        new CustomEvent(AGENT_OPEN_EVENT, { detail: { sessionId: "session-gone" } }),
      );
    });

    expect(await screen.findByRole("heading", { name: HERO_GREETING })).toBeInTheDocument();
  });

  it("navigates to the chat of a notification clicked before the webview was ready", async () => {
    mocks.agentOpenReady.mockResolvedValue("session-9");
    mocks.listAgentSessions.mockResolvedValue([agentSession("session-9", "Notified session")]);

    render(<App />);

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Send message" })).toBeInTheDocument(),
    );
  });

  it("retries the notified-chat lookup while the agent runtime is still starting", async () => {
    mocks.agentOpenReady.mockResolvedValue("session-9");
    let sessionListCalls = 0;
    mocks.listAgentSessions.mockImplementation(async () => {
      sessionListCalls += 1;
      if (sessionListCalls <= 2) throw new Error("agent_runtime_not_running");
      return [agentSession("session-9", "Notified session")];
    });

    render(<App />);

    expect(
      await screen.findByRole("button", { name: "Send message" }, { timeout: 8_000 }),
    ).toBeInTheDocument();
  }, 15_000);
});
