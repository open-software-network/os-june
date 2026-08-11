import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../app/App";
import { HERO_GREETINGS } from "../components/agent/AgentWorkspace";
import { appSettingsTabsForCompanionPairing } from "../components/settings/AppSettings";
import { settingsTabsForCompanionPairing } from "../components/settings/settings-config";
import {
  dispatchDataPartitionChanged,
  resetCurrentDataPartitionForTests,
  setCurrentDataPartitionName,
} from "../lib/data-partition";
import { MEETING_START_TRANSCRIPTION_EVENT } from "../lib/events";
import { companionFrontendConsumerAvailable } from "../lib/companion-frontend-router";
import { rememberSessionModel } from "../lib/agent-session-models";
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
  VeniceModelDto,
  VeniceModelsResponse,
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
  companionCompleteFrontendRequest: vi.fn(),
  companionConsumeAttachments: vi.fn().mockResolvedValue(undefined),
  companionPublishAgentEvent: vi.fn().mockResolvedValue(undefined),
  companionListAgentMedia: vi.fn().mockResolvedValue([]),
  companionReadAgentMediaChunk: vi.fn(),
  companionPairingEnabled: true,
  listAgentItems: vi.fn().mockResolvedValue([]),
  getAgentSession: vi.fn(),
  createAgentSession: vi.fn(),
  startAgentRun: vi.fn(),
  getLatestAgentRun: vi.fn(),
  cancelAgentRun: vi.fn(),
  listAgentSkills: vi.fn().mockResolvedValue([]),
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
  listSessionFolders: vi.fn(),
  listSessionPartitions: vi.fn(),
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
  startPeriodicClovyUpdateChecks: vi.fn(),
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

vi.mock("../lib/experimental-flags", () => ({
  INITIAL_EXPERIMENTAL_UNLOCK_CLICK_STATE: { count: 0, startedAt: null },
  experimentalBrowserUseEnabled: () => false,
  registerExperimentalUnlockClick: vi.fn((state) => ({ state, unlocked: false })),
  setExperimentalFlags: vi.fn(async (flags) => flags),
  useExperimentalFlags: () => ({
    unlocked: false,
    browser_use: false,
    companion_pairing: mocks.companionPairingEnabled,
    loaded: true,
    browserUseEnabled: false,
    companionPairingEnabled: mocks.companionPairingEnabled,
  }),
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
    startPeriodicClovyUpdateChecks: mocks.startPeriodicClovyUpdateChecks,
  };
});

vi.mock("../lib/tauri", () => ({
  agentRuntimeBindings: {
    listSessions: mocks.listAgentSessions,
    getSession: mocks.getAgentSession,
    getLatestRun: mocks.getLatestAgentRun,
    createSession: mocks.createAgentSession,
    renameSession: vi.fn(),
    deleteSession: vi.fn(),
    listItems: mocks.listAgentItems,
    listArtifacts: vi.fn(async () => []),
    startRun: mocks.startAgentRun,
    cancelRun: mocks.cancelAgentRun,
    retryRun: vi.fn(),
    resolveInterruption: vi.fn(),
    listSkills: mocks.listAgentSkills,
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
  listSessionFolders: mocks.listSessionFolders,
  listCompletedSessions: vi.fn(async () => []),
  setSessionCompleted: vi.fn(async () => undefined),
  listSessionPartitions: mocks.listSessionPartitions,
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
  NOTE_SAVE_FLUSH_REQUESTED_EVENT: "clovy://flush-pending-note-saves",
  checkRecordingSourceReadiness: mocks.checkRecordingSourceReadiness,
  companionCompleteFrontendRequest: mocks.companionCompleteFrontendRequest,
  companionConsumeAttachments: mocks.companionConsumeAttachments,
  companionPublishAgentEvent: mocks.companionPublishAgentEvent,
  companionListAgentMedia: mocks.companionListAgentMedia,
  companionReadAgentMediaChunk: mocks.companionReadAgentMediaChunk,
  listAgentItems: mocks.listAgentItems,
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
  clovyOpenVerifyPage: vi.fn(async () => ""),
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
    workspacePath: `/tmp/clovy-agent-workspaces/${id}`,
    source: "user",
    createdAt: now,
    updatedAt: now,
  };
}

function generationModel(id: string, overrides: Partial<VeniceModelDto> = {}): VeniceModelDto {
  return {
    provider: "venice",
    id,
    name: id,
    modelType: "text",
    privacy: "private",
    traits: ["private"],
    capabilities: ["supportsFunctionCalling"],
    priceUnit: "tokens",
    priceDescription: "",
    inputCreditsPerMillionTokens: 850,
    outputCreditsPerMillionTokens: 4660,
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
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
    window.localStorage.setItem("clovy:active-agent-profile", "default");
    window.localStorage.removeItem("clovy:agent:last-open-session");
    window.localStorage.removeItem("clovy.agent.sessionModels");
    mocks.companionPairingEnabled = true;
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
    mocks.companionCompleteFrontendRequest.mockResolvedValue(undefined);
    mocks.companionListAgentMedia.mockResolvedValue([]);
    mocks.companionReadAgentMediaChunk.mockResolvedValue({
      artifactId: "artifact-default",
      offsetBytes: 0,
      totalSizeBytes: 1,
      sha256: "0".repeat(64),
      bytes: "AA==",
      complete: true,
    });
    mocks.getAgentSession.mockImplementation(async (sessionId: string) => {
      const sessions = await mocks.listAgentSessions();
      const found = sessions.find((candidate: AgentSessionDto) => candidate.id === sessionId);
      if (!found) throw new Error("missing session");
      return found;
    });
    mocks.createAgentSession.mockResolvedValue(agentSession("session-new", "New session"));
    mocks.startAgentRun.mockImplementation(async (request) => ({
      id: "run-companion",
      sessionId: request.sessionId,
      status: "running",
      model: request.model,
    }));
    mocks.getLatestAgentRun.mockResolvedValue(null);
    mocks.cancelAgentRun.mockResolvedValue(undefined);
    mocks.listAgentSkills.mockResolvedValue([]);
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
    mocks.listSessionFolders.mockResolvedValue([]);
    mocks.listSessionPartitions.mockResolvedValue([]);
    mocks.listVeniceModels.mockResolvedValue({
      mode: "generation",
      modelType: "text",
      selectedModel: "",
      models: [],
    });
    mocks.providerModelSettings.mockResolvedValue({
      settings: { generationModel: "", costQuality: 100 },
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
    mocks.startPeriodicClovyUpdateChecks.mockReturnValue(vi.fn());
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
      await waitFor(() => expect(mocks.startPeriodicClovyUpdateChecks).toHaveBeenCalledOnce());
      expect(mocks.startPeriodicClovyUpdateChecks.mock.calls[0]?.[0]).toEqual(expect.any(Function));
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("serves companion agent reads without opening the agent workspace", async () => {
    const user = userEvent.setup();
    mocks.listAgentSessions.mockResolvedValue([
      {
        id: "session-companion",
        title: "Companion planning",
        status: "completed",
        model: "auto",
        safetyMode: "sandboxed",
        workspacePath: "/tmp/session-companion",
        source: "user",
        createdAt: "2026-07-16T09:00:00.000Z",
        updatedAt: "2026-07-16T10:00:00.000Z",
      },
    ]);
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "Meeting notes" }));

    await waitFor(() =>
      expect(mocks.listen.mock.calls.some(([event]) => event === "clovy://companion-request")).toBe(
        true,
      ),
    );
    const payload = {
      operationId: "operation-companion",
      intent: { type: "agentSessionsList", data: { limit: 50 } },
    };
    act(() => {
      for (const [event, handler] of mocks.listen.mock.calls) {
        if (event === "clovy://companion-request") handler({ payload });
      }
    });

    await waitFor(() =>
      expect(mocks.companionCompleteFrontendRequest).toHaveBeenCalledWith("operation-companion", {
        type: "agentSessions",
        data: {
          items: [
            {
              id: "session-companion",
              title: "Companion planning",
              status: "completed",
              updatedAt: "2026-07-16T10:00:00.000Z",
            },
          ],
        },
      }),
    );
    expect(screen.queryByText(HERO_GREETING)).not.toBeInTheDocument();
  });

  it("returns only Auto and the live curated desktop models with canonical labels", async () => {
    mocks.listVeniceModels.mockResolvedValue({
      mode: "generation",
      modelType: "text",
      selectedModel: "zai-org-glm-5-2",
      models: [
        generationModel("kimi-k2-6", { name: "Kimi K2.6" }),
        generationModel("uncurated", { name: "Uncurated" }),
        generationModel("zai-org-glm-5-2", { name: "GLM 5.2" }),
      ],
    });
    render(<App />);

    await waitFor(() => expect(mocks.listeners.has("clovy://companion-request")).toBe(true));
    act(() => {
      mocks.listeners.get("clovy://companion-request")?.({
        payload: {
          operationId: "operation-models-list",
          intent: { type: "modelsList" },
        },
      });
    });

    await waitFor(() =>
      expect(mocks.companionCompleteFrontendRequest).toHaveBeenCalledWith("operation-models-list", {
        type: "models",
        data: {
          models: [
            expect.objectContaining({
              id: "open-software/auto",
              name: "Auto",
              routing: "automatic",
            }),
            expect.objectContaining({
              id: "zai-org-glm-5-2",
              name: "GLM 5.2",
              privacy: "private",
              privacyLabel: "Private mode",
            }),
            expect.objectContaining({
              id: "kimi-k2-6",
              name: "Kimi K2.6",
              priceLabel: "$0.85 input / $4.66 output per 1M tokens",
            }),
          ],
        },
      }),
    );
  });

  it("reads and stages a companion model switch without disturbing an active run", async () => {
    const session = {
      ...agentSession("session-model", "Model session"),
      status: "running" as const,
      model: "zai-org-glm-5-2",
    };
    mocks.listAgentSessions.mockResolvedValue([session]);
    mocks.listVeniceModels.mockResolvedValue({
      mode: "generation",
      modelType: "text",
      selectedModel: "zai-org-glm-5-2",
      models: [generationModel("kimi-k2-6", { name: "Kimi K2.6" })],
    });
    mocks.providerModelSettings.mockResolvedValue({
      settings: { generationModel: "zai-org-glm-5-2", costQuality: 100 },
    });
    window.localStorage.setItem(
      "clovy.agent.sessionModels",
      JSON.stringify({ [session.id]: "__june_auto_generation__:20" }),
    );
    render(<App />);

    await waitFor(() => expect(mocks.listeners.has("clovy://companion-request")).toBe(true));
    act(() => {
      mocks.listeners.get("clovy://companion-request")?.({
        payload: {
          operationId: "operation-model-get",
          intent: { type: "sessionModelGet", data: { storedSessionId: session.id } },
        },
      });
    });
    await waitFor(() =>
      expect(mocks.companionCompleteFrontendRequest).toHaveBeenCalledWith("operation-model-get", {
        type: "sessionModel",
        data: {
          storedSessionId: session.id,
          modelId: "open-software/auto",
          modelName: "Auto",
          costQuality: 20,
        },
      }),
    );

    act(() => {
      mocks.listeners.get("clovy://companion-request")?.({
        payload: {
          operationId: "operation-model-set",
          intent: {
            type: "sessionModelSet",
            data: { storedSessionId: session.id, modelId: "kimi-k2-6" },
          },
        },
      });
    });
    await waitFor(() =>
      expect(mocks.companionCompleteFrontendRequest).toHaveBeenCalledWith("operation-model-set", {
        type: "sessionModel",
        data: {
          storedSessionId: session.id,
          modelId: "kimi-k2-6",
          modelName: "Kimi K2.6",
        },
      }),
    );
    expect(JSON.parse(window.localStorage.getItem("clovy.agent.sessionModels") ?? "{}")).toEqual({
      [session.id]: "kimi-k2-6",
    });
    expect(mocks.startAgentRun).not.toHaveBeenCalled();
    expect(mocks.cancelAgentRun).not.toHaveBeenCalled();
  });

  it("publishes a model event when the desktop stages a session choice", async () => {
    const session = agentSession("session-desktop-model", "Desktop model session");
    mocks.listAgentSessions.mockResolvedValue([session]);
    mocks.listVeniceModels.mockResolvedValue({
      mode: "generation",
      modelType: "text",
      selectedModel: "zai-org-glm-5-2",
      models: [generationModel("kimi-k2-6", { name: "Kimi K2.6" })],
    });
    mocks.providerModelSettings.mockResolvedValue({
      settings: { generationModel: "zai-org-glm-5-2", costQuality: 100 },
    });
    render(<App />);

    await waitFor(() => expect(mocks.listeners.has("clovy://companion-request")).toBe(true));
    act(() => rememberSessionModel(session.id, "kimi-k2-6"));

    await waitFor(() =>
      expect(mocks.companionPublishAgentEvent).toHaveBeenCalledWith({
        type: "modelChanged",
        data: {
          selection: {
            storedSessionId: session.id,
            modelId: "kimi-k2-6",
            modelName: "Kimi K2.6",
          },
        },
      }),
    );
  });

  it("drops a staged model event when the data partition changes during catalog loading", async () => {
    const partitionASession = agentSession("session-model-partition-a", "Partition A model");
    const partitionBSession = agentSession("session-model-partition-b", "Partition B model");
    mocks.listAgentSessions.mockResolvedValue([partitionASession, partitionBSession]);
    mocks.listSessionPartitions.mockResolvedValue([
      { sessionId: partitionASession.id, profile: "partition-a" },
      { sessionId: partitionBSession.id, profile: "partition-b" },
    ]);
    setCurrentDataPartitionName("partition-a");
    render(<App />);

    await waitFor(() => expect(mocks.listeners.has("clovy://companion-request")).toBe(true));
    mocks.companionPublishAgentEvent.mockClear();
    mocks.listVeniceModels.mockClear();
    const catalog = deferred<VeniceModelsResponse>();
    mocks.listVeniceModels.mockReturnValueOnce(catalog.promise);

    await act(async () => {
      rememberSessionModel(partitionASession.id, "kimi-k2-6");
      await Promise.resolve();
      await Promise.resolve();
    });
    setCurrentDataPartitionName("partition-b");
    await act(async () => {
      catalog.resolve({
        mode: "generation",
        modelType: "text",
        selectedModel: "zai-org-glm-5-2",
        models: [generationModel("kimi-k2-6", { name: "Kimi K2.6" })],
      });
      await catalog.promise;
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.companionPublishAgentEvent).not.toHaveBeenCalled();
  });

  it("rejects uncurated companion model writes", async () => {
    const session = agentSession("session-model-rejected", "Rejected model session");
    mocks.listAgentSessions.mockResolvedValue([session]);
    mocks.listVeniceModels.mockResolvedValue({
      mode: "generation",
      modelType: "text",
      selectedModel: "zai-org-glm-5-2",
      models: [generationModel("kimi-k2-6")],
    });
    render(<App />);

    await waitFor(() => expect(mocks.listeners.has("clovy://companion-request")).toBe(true));
    act(() => {
      mocks.listeners.get("clovy://companion-request")?.({
        payload: {
          operationId: "operation-model-rejected",
          intent: {
            type: "sessionModelSet",
            data: { storedSessionId: session.id, modelId: "uncurated" },
          },
        },
      });
    });

    await waitFor(() =>
      expect(mocks.companionCompleteFrontendRequest).toHaveBeenCalledWith(
        "operation-model-rejected",
        expect.objectContaining({
          type: "error",
          data: expect.objectContaining({ code: "unsupported" }),
        }),
      ),
    );
    expect(window.localStorage.getItem("clovy.agent.sessionModels")).toBeNull();
  });

  it("pages companion agent messages backward from the newest turns", async () => {
    mocks.listAgentSessions.mockResolvedValue([
      {
        id: "session-companion",
        title: "Companion planning",
        status: "completed",
        model: "auto",
        safetyMode: "sandboxed",
        workspacePath: "/tmp/session-companion",
        source: "user",
        createdAt: "2026-07-16T09:00:00.000Z",
        updatedAt: "2026-07-16T10:03:00.000Z",
      },
    ]);
    mocks.listAgentItems.mockResolvedValue([
      {
        id: "message-1",
        sessionId: "session-companion",
        sequence: 1,
        kind: "message",
        role: "user",
        text: "Oldest question",
        status: "complete",
        createdAt: "2026-07-16T10:01:00.000Z",
      },
      {
        id: "message-2",
        sessionId: "session-companion",
        sequence: 2,
        kind: "message",
        role: "assistant",
        text: "Recent answer",
        status: "complete",
        createdAt: "2026-07-16T10:02:00.000Z",
      },
      {
        id: "message-3",
        sessionId: "session-companion",
        sequence: 3,
        kind: "message",
        role: "user",
        text: "Newest question",
        status: "complete",
        createdAt: "2026-07-16T10:03:00.000Z",
      },
    ]);
    render(<App />);

    await waitFor(() =>
      expect(mocks.listen.mock.calls.some(([event]) => event === "clovy://companion-request")).toBe(
        true,
      ),
    );
    const dispatch = (cursor?: string) => {
      const payload = {
        operationId: cursor ? "operation-older" : "operation-latest",
        intent: {
          type: "agentMessagesList",
          data: {
            storedSessionId: "session-companion",
            limit: 2,
            ...(cursor ? { cursor } : {}),
          },
        },
      };
      act(() => {
        for (const [event, handler] of mocks.listen.mock.calls) {
          if (event === "clovy://companion-request") handler({ payload });
        }
      });
    };

    dispatch();
    await waitFor(() =>
      expect(mocks.companionCompleteFrontendRequest).toHaveBeenCalledWith("operation-latest", {
        type: "agentMessages",
        data: {
          items: [
            expect.objectContaining({ id: "message-2", text: "Recent answer" }),
            expect.objectContaining({ id: "message-3", text: "Newest question" }),
          ],
          nextCursor: "2",
        },
      }),
    );

    dispatch("2");
    await waitFor(() =>
      expect(mocks.companionCompleteFrontendRequest).toHaveBeenCalledWith("operation-older", {
        type: "agentMessages",
        data: {
          items: [expect.objectContaining({ id: "message-1", text: "Oldest question" })],
        },
      }),
    );
  });

  it("returns canonical media references with companion agent history", async () => {
    const session = agentSession("session-media", "Generated media");
    mocks.listAgentSessions.mockResolvedValue([session]);
    mocks.listAgentItems.mockResolvedValue([
      {
        id: "message-media",
        sessionId: session.id,
        runId: "run-media",
        sequence: 1,
        kind: "message",
        role: "assistant",
        text: "Here is the result.",
        status: "complete",
        createdAt: "2026-07-28T10:00:00.000Z",
      },
    ]);
    mocks.companionListAgentMedia.mockResolvedValue([
      {
        runId: "run-media",
        createdAt: "2026-07-28T09:59:59.000Z",
        reference: {
          artifactId: "artifact-media",
          kind: "image",
          mediaType: "image/png",
          widthPx: 1024,
          heightPx: 1024,
          sizeBytes: 4096,
        },
      },
    ]);
    render(<App />);

    await waitFor(() =>
      expect(mocks.listen.mock.calls.some(([event]) => event === "clovy://companion-request")).toBe(
        true,
      ),
    );
    act(() => {
      for (const [event, handler] of mocks.listen.mock.calls) {
        if (event === "clovy://companion-request") {
          handler({
            payload: {
              operationId: "operation-media",
              intent: {
                type: "agentMessagesList",
                data: { storedSessionId: session.id, limit: 50 },
              },
            },
          });
        }
      }
    });

    await waitFor(() =>
      expect(mocks.companionCompleteFrontendRequest).toHaveBeenCalledWith("operation-media", {
        type: "agentMessages",
        data: {
          items: [
            expect.objectContaining({
              id: "message-media",
              media: [
                expect.objectContaining({
                  artifactId: "artifact-media",
                  kind: "image",
                  mediaType: "image/png",
                }),
              ],
            }),
          ],
        },
      }),
    );
    expect(mocks.companionListAgentMedia).toHaveBeenCalledWith(session.id);
  });

  it("returns a verified media chunk through the partition-scoped frontend boundary", async () => {
    const session = agentSession("session-media-fetch", "Generated media");
    const chunk = {
      artifactId: "artifact-media",
      offsetBytes: 31 * 1024,
      totalSizeBytes: 31 * 1024 + 4,
      sha256: "a".repeat(64),
      bytes: "dGFpbA==",
      complete: true,
    };
    mocks.listAgentSessions.mockResolvedValue([session]);
    mocks.companionReadAgentMediaChunk.mockResolvedValue(chunk);
    render(<App />);

    await waitFor(() => expect(mocks.listeners.has("clovy://companion-request")).toBe(true));
    act(() => {
      mocks.listeners.get("clovy://companion-request")?.({
        payload: {
          operationId: "operation-media-fetch",
          intent: {
            type: "mediaFetch",
            data: {
              storedSessionId: session.id,
              artifactId: chunk.artifactId,
              offsetBytes: chunk.offsetBytes,
            },
          },
        },
      });
    });

    await waitFor(() =>
      expect(mocks.companionCompleteFrontendRequest).toHaveBeenCalledWith("operation-media-fetch", {
        type: "mediaChunk",
        data: chunk,
      }),
    );
    expect(mocks.companionReadAgentMediaChunk).toHaveBeenCalledWith(
      session.id,
      chunk.artifactId,
      chunk.offsetBytes,
    );
  });

  it("discards a media chunk when the active partition changes during the read", async () => {
    const session = agentSession("session-media-partition-a", "Partition A media");
    const chunk = deferred<{
      artifactId: string;
      offsetBytes: number;
      totalSizeBytes: number;
      sha256: string;
      bytes: string;
      complete: boolean;
    }>();
    setCurrentDataPartitionName("partition-a");
    mocks.listAgentSessions.mockResolvedValue([session]);
    mocks.listSessionPartitions.mockResolvedValue([
      { sessionId: session.id, profile: "partition-a" },
    ]);
    mocks.companionReadAgentMediaChunk.mockReturnValue(chunk.promise);
    render(<App />);

    await waitFor(() => expect(mocks.listeners.has("clovy://companion-request")).toBe(true));
    act(() => {
      mocks.listeners.get("clovy://companion-request")?.({
        payload: {
          operationId: "operation-media-partition",
          intent: {
            type: "mediaFetch",
            data: {
              storedSessionId: session.id,
              artifactId: "artifact-private",
              offsetBytes: 0,
            },
          },
        },
      });
    });
    await waitFor(() =>
      expect(mocks.companionReadAgentMediaChunk).toHaveBeenCalledWith(
        session.id,
        "artifact-private",
        0,
      ),
    );

    setCurrentDataPartitionName("partition-b");
    chunk.resolve({
      artifactId: "artifact-private",
      offsetBytes: 0,
      totalSizeBytes: 1,
      sha256: "b".repeat(64),
      bytes: "AA==",
      complete: true,
    });

    await waitFor(() =>
      expect(mocks.companionCompleteFrontendRequest).toHaveBeenCalledWith(
        "operation-media-partition",
        expect.objectContaining({
          type: "error",
          data: expect.objectContaining({ code: "not_found" }),
        }),
      ),
    );
    expect(mocks.companionCompleteFrontendRequest).not.toHaveBeenCalledWith(
      "operation-media-partition",
      expect.objectContaining({ type: "mediaChunk" }),
    );
  });

  it("preserves a missing media artifact as a non-retryable not-found result", async () => {
    const session = agentSession("session-media-missing", "Missing media");
    mocks.listAgentSessions.mockResolvedValue([session]);
    mocks.companionReadAgentMediaChunk.mockRejectedValue({
      code: "companion_media_not_found",
      message: "That generated media is no longer available.",
    });
    render(<App />);

    await waitFor(() => expect(mocks.listeners.has("clovy://companion-request")).toBe(true));
    act(() => {
      mocks.listeners.get("clovy://companion-request")?.({
        payload: {
          operationId: "operation-media-missing",
          intent: {
            type: "mediaFetch",
            data: {
              storedSessionId: session.id,
              artifactId: "artifact-missing",
              offsetBytes: 0,
            },
          },
        },
      });
    });

    await waitFor(() =>
      expect(mocks.companionCompleteFrontendRequest).toHaveBeenCalledWith(
        "operation-media-missing",
        {
          type: "error",
          data: {
            code: "not_found",
            message: "That generated media is no longer available.",
            retryable: false,
          },
        },
      ),
    );
  });

  it("opens the stored agent session requested by the companion", async () => {
    const focusedSession = {
      id: "session-companion",
      title: "Companion planning",
      status: "completed" as const,
      model: "auto",
      safetyMode: "sandboxed" as const,
      workspacePath: "/tmp/session-companion",
      source: "user" as const,
      createdAt: "2026-07-16T09:00:00.000Z",
      updatedAt: "2026-07-16T10:03:00.000Z",
    };
    mocks.listAgentSessions.mockResolvedValue([focusedSession]);
    mocks.listSessionPartitions.mockResolvedValue([
      { sessionId: focusedSession.id, profile: "default" },
    ]);
    render(<App />);

    await waitFor(() => expect(mocks.getNote).toHaveBeenCalledWith("note-1"));
    await waitFor(() => expect(mocks.listeners.has("clovy://companion-focus")).toBe(true));
    act(() => {
      mocks.listeners.get("clovy://companion-focus")?.({
        payload: { agent: { storedSessionId: "session-companion" } },
      });
    });

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Send message" })).toBeInTheDocument(),
    );
    expect(screen.queryByRole("heading", { name: HERO_GREETING })).not.toBeInTheDocument();
  });

  it("uses the target session model and safety mode for companion sends", async () => {
    const unrestricted = {
      ...agentSession("session-unrestricted", "Unrestricted session"),
      model: "unrestricted-model",
      safetyMode: "unrestricted" as const,
    };
    const sandboxed = {
      ...agentSession("session-sandboxed", "Sandboxed session"),
      model: "sandboxed-model",
      safetyMode: "sandboxed" as const,
    };
    mocks.listAgentSessions.mockResolvedValue([unrestricted, sandboxed]);
    mocks.getAgentSession.mockImplementation(async (sessionId: string) =>
      sessionId === sandboxed.id ? sandboxed : unrestricted,
    );
    render(<App />);

    await waitFor(() => expect(mocks.listeners.has("clovy://companion-request")).toBe(true));
    act(() => {
      mocks.listeners.get("clovy://companion-request")?.({
        payload: {
          operationId: "operation-sandboxed-send",
          intent: {
            type: "agentSend",
            data: {
              storedSessionId: sandboxed.id,
              message: "Keep this run sandboxed",
            },
          },
        },
      });
    });

    await waitFor(() =>
      expect(mocks.startAgentRun).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: sandboxed.id,
          model: sandboxed.model,
          safetyMode: sandboxed.safetyMode,
        }),
      ),
    );
    expect(mocks.startAgentRun).not.toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: sandboxed.id,
        safetyMode: unrestricted.safetyMode,
      }),
    );
    expect(mocks.companionCompleteFrontendRequest).toHaveBeenCalledWith(
      "operation-sandboxed-send",
      {
        type: "agentAccepted",
        data: { storedSessionId: sandboxed.id },
      },
    );
  });

  it("hands resolved companion attachments to the normal agent run and consumes references", async () => {
    const target = agentSession("session-with-phone-file", "Attachment session");
    mocks.listAgentSessions.mockResolvedValue([target]);
    mocks.getAgentSession.mockResolvedValue(target);
    render(<App />);

    await waitFor(() => expect(mocks.listeners.has("clovy://companion-request")).toBe(true));
    act(() => {
      mocks.listeners.get("clovy://companion-request")?.({
        payload: {
          operationId: "operation-attachment-send",
          intent: {
            type: "agentSend",
            data: {
              storedSessionId: target.id,
              message: "Read the attached brief",
              attachments: [
                {
                  path: "/tmp/companion/content",
                  name: "photo.png",
                  mediaType: "image/png",
                },
              ],
              attachmentReferenceIds: ["00000000-0000-0000-0000-000000000003"],
            },
          },
        },
      });
    });

    await waitFor(() =>
      expect(mocks.startAgentRun).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: target.id,
          attachments: ["/tmp/companion/content"],
          attachmentMetadata: [{ name: "photo.png", mediaType: "image/png" }],
        }),
      ),
    );
    expect(mocks.companionConsumeAttachments).toHaveBeenCalledWith([
      "00000000-0000-0000-0000-000000000003",
    ]);
    expect(mocks.companionCompleteFrontendRequest).toHaveBeenCalledWith(
      "operation-attachment-send",
      {
        type: "agentAccepted",
        data: { storedSessionId: target.id },
      },
    );
  });

  it("applies and clears a companion-staged model at the companion run boundary", async () => {
    const target = agentSession("session-staged-companion", "Staged model session");
    mocks.listAgentSessions.mockResolvedValue([target]);
    mocks.getAgentSession.mockResolvedValue(target);
    rememberSessionModel(target.id, "model-staged-by-phone");
    render(<App />);

    await waitFor(() => expect(mocks.listeners.has("clovy://companion-request")).toBe(true));
    act(() => {
      mocks.listeners.get("clovy://companion-request")?.({
        payload: {
          operationId: "operation-staged-model-send",
          intent: {
            type: "agentSend",
            data: {
              storedSessionId: target.id,
              message: "Use the staged model",
            },
          },
        },
      });
    });

    await waitFor(() =>
      expect(mocks.startAgentRun).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: target.id,
          model: "model-staged-by-phone",
        }),
      ),
    );
    expect(JSON.parse(window.localStorage.getItem("clovy.agent.sessionModels") ?? "{}")).toEqual(
      {},
    );
  });

  it("reports acceptance when attachment cleanup fails after run dispatch", async () => {
    const target = agentSession("session-cleanup-failure", "Cleanup failure session");
    mocks.listAgentSessions.mockResolvedValue([target]);
    mocks.getAgentSession.mockResolvedValue(target);
    mocks.companionConsumeAttachments.mockRejectedValueOnce(new Error("cleanup failed"));
    render(<App />);

    await waitFor(() => expect(mocks.listeners.has("clovy://companion-request")).toBe(true));
    act(() => {
      mocks.listeners.get("clovy://companion-request")?.({
        payload: {
          operationId: "operation-cleanup-failure",
          intent: {
            type: "agentSend",
            data: {
              storedSessionId: target.id,
              message: "Dispatch once",
              attachmentReferenceIds: ["00000000-0000-0000-0000-000000000004"],
            },
          },
        },
      });
    });

    await waitFor(() =>
      expect(mocks.companionCompleteFrontendRequest).toHaveBeenCalledWith(
        "operation-cleanup-failure",
        {
          type: "agentAccepted",
          data: { storedSessionId: target.id },
        },
      ),
    );
    expect(mocks.startAgentRun).toHaveBeenCalledTimes(1);
  });

  it("prepares companion sends with current project context and clearing markers", async () => {
    const session = agentSession("session-project-companion", "Project session");
    const folder = {
      id: "folder-companion",
      name: "Private launch",
      description: "Local project",
      instructions: "Answer with the current launch constraints.",
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
    mocks.listAgentSessions.mockResolvedValue([session]);
    mocks.listSessionFolders.mockResolvedValue([{ sessionId: session.id, folderId: folder.id }]);
    mocks.listSessionPartitions.mockResolvedValue([{ sessionId: session.id, profile: "default" }]);
    const firstApp = render(<App />);

    await waitFor(() => expect(mocks.listSessionFolders).toHaveBeenCalled());
    await waitFor(() => expect(mocks.listeners.has("clovy://companion-request")).toBe(true));
    act(() => {
      mocks.listeners.get("clovy://companion-request")?.({
        payload: {
          operationId: "operation-project-send",
          intent: {
            type: "agentSend",
            data: { storedSessionId: session.id, message: "What changed?" },
          },
        },
      });
    });

    await waitFor(() =>
      expect(mocks.startAgentRun).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: session.id,
          prompt: expect.stringContaining(
            "instructions:\nAnswer with the current launch constraints.",
          ),
        }),
      ),
    );

    firstApp.unmount();
    mocks.listeners.clear();
    mocks.startAgentRun.mockClear();
    mocks.listSessionFolders.mockClear();
    mocks.listSessionFolders.mockResolvedValue([]);
    render(<App />);

    await waitFor(() => expect(mocks.listSessionFolders).toHaveBeenCalled());
    await waitFor(() => expect(mocks.listeners.has("clovy://companion-request")).toBe(true));
    act(() => {
      mocks.listeners.get("clovy://companion-request")?.({
        payload: {
          operationId: "operation-project-cleared-send",
          intent: {
            type: "agentSend",
            data: { storedSessionId: session.id, message: "What now?" },
          },
        },
      });
    });

    await waitFor(() =>
      expect(mocks.startAgentRun).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: session.id,
          prompt: expect.stringContaining(
            "This session is no longer filed in a project. Previous project instructions no longer apply",
          ),
        }),
      ),
    );
    expect(mocks.startAgentRun).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining("\n[/Clovy project context]\n\nWhat now?"),
      }),
    );
  });

  it("creates companion-started sessions with the sandboxed session defaults", async () => {
    const created = {
      ...agentSession("session-created-by-companion", "Companion request"),
      model: "open-software/auto",
      safetyMode: "sandboxed" as const,
    };
    mocks.createAgentSession.mockResolvedValue(created);
    render(<App />);

    await waitFor(() => expect(mocks.listeners.has("clovy://companion-request")).toBe(true));
    act(() => {
      mocks.listeners.get("clovy://companion-request")?.({
        payload: {
          operationId: "operation-new-session-send",
          intent: {
            type: "agentSend",
            data: { message: "Start a safe session" },
          },
        },
      });
    });

    await waitFor(() =>
      expect(mocks.createAgentSession).toHaveBeenCalledWith(
        expect.objectContaining({
          model: "open-software/auto",
          safetyMode: "sandboxed",
          profile: "default",
        }),
      ),
    );
    expect(mocks.startAgentRun).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: created.id,
        model: created.model,
        safetyMode: created.safetyMode,
      }),
    );
  });

  it("rejects a cached companion send after the active partition changes", async () => {
    const cached = agentSession("session-partition-a", "Partition A session");
    setCurrentDataPartitionName("partition-a");
    mocks.listAgentSessions.mockResolvedValue([cached]);
    mocks.listSessionPartitions.mockResolvedValue([
      { sessionId: cached.id, profile: "partition-a" },
    ]);
    render(<App />);

    await waitFor(() => expect(mocks.listeners.has("clovy://companion-request")).toBe(true));
    setCurrentDataPartitionName("partition-b");
    act(() => {
      mocks.listeners.get("clovy://companion-request")?.({
        payload: {
          operationId: "operation-stale-send",
          intent: {
            type: "agentSend",
            data: { storedSessionId: cached.id, message: "Cross the boundary" },
          },
        },
      });
    });

    await waitFor(() =>
      expect(mocks.companionCompleteFrontendRequest).toHaveBeenCalledWith("operation-stale-send", {
        type: "error",
        data: {
          code: "not_found",
          message: "That agent session is no longer available.",
          retryable: false,
        },
      }),
    );
    expect(mocks.startAgentRun).not.toHaveBeenCalled();
  });

  it("rejects a cached companion cancellation after the active partition changes", async () => {
    const cached = agentSession("session-partition-a", "Partition A session");
    setCurrentDataPartitionName("partition-a");
    mocks.listAgentSessions.mockResolvedValue([cached]);
    mocks.listSessionPartitions.mockResolvedValue([
      { sessionId: cached.id, profile: "partition-a" },
    ]);
    render(<App />);

    await waitFor(() => expect(mocks.listeners.has("clovy://companion-request")).toBe(true));
    setCurrentDataPartitionName("partition-b");
    act(() => {
      mocks.listeners.get("clovy://companion-request")?.({
        payload: {
          operationId: "operation-stale-cancel",
          intent: {
            type: "agentCancel",
            data: { storedSessionId: cached.id },
          },
        },
      });
    });

    await waitFor(() =>
      expect(mocks.companionCompleteFrontendRequest).toHaveBeenCalledWith(
        "operation-stale-cancel",
        expect.objectContaining({
          type: "error",
          data: expect.objectContaining({ code: "not_found" }),
        }),
      ),
    );
    expect(mocks.cancelAgentRun).not.toHaveBeenCalled();
  });

  it("rejects a companion send when the active partition changes while skills load", async () => {
    const cached = agentSession("session-partition-a", "Partition A session");
    const skills = deferred<never[]>();
    setCurrentDataPartitionName("partition-a");
    mocks.listAgentSessions.mockResolvedValue([cached]);
    mocks.listSessionPartitions.mockResolvedValue([
      { sessionId: cached.id, profile: "partition-a" },
    ]);
    mocks.listAgentSkills.mockReturnValue(skills.promise);
    render(<App />);

    await waitFor(() => expect(mocks.listeners.has("clovy://companion-request")).toBe(true));
    act(() => {
      mocks.listeners.get("clovy://companion-request")?.({
        payload: {
          operationId: "operation-mid-await-send",
          intent: {
            type: "agentSend",
            data: { storedSessionId: cached.id, message: "Cross the boundary" },
          },
        },
      });
    });
    await waitFor(() => expect(mocks.listAgentSkills).toHaveBeenCalled());

    setCurrentDataPartitionName("partition-b");
    skills.resolve([]);

    await waitFor(() =>
      expect(mocks.companionCompleteFrontendRequest).toHaveBeenCalledWith(
        "operation-mid-await-send",
        expect.objectContaining({
          type: "error",
          data: expect.objectContaining({ code: "not_found" }),
        }),
      ),
    );
    expect(mocks.startAgentRun).not.toHaveBeenCalled();
  });

  it("rejects a companion cancellation when the active partition changes while the run loads", async () => {
    const cached = agentSession("session-partition-a", "Partition A session");
    const latestRun = deferred<{
      id: string;
      sessionId: string;
      status: "running";
      model: string;
    }>();
    setCurrentDataPartitionName("partition-a");
    mocks.listAgentSessions.mockResolvedValue([cached]);
    mocks.listSessionPartitions.mockResolvedValue([
      { sessionId: cached.id, profile: "partition-a" },
    ]);
    mocks.getLatestAgentRun.mockReturnValue(latestRun.promise);
    render(<App />);

    await waitFor(() => expect(mocks.listeners.has("clovy://companion-request")).toBe(true));
    act(() => {
      mocks.listeners.get("clovy://companion-request")?.({
        payload: {
          operationId: "operation-mid-await-cancel",
          intent: {
            type: "agentCancel",
            data: { storedSessionId: cached.id },
          },
        },
      });
    });
    await waitFor(() => expect(mocks.getLatestAgentRun).toHaveBeenCalledWith(cached.id));

    setCurrentDataPartitionName("partition-b");
    latestRun.resolve({
      id: "run-partition-a",
      sessionId: cached.id,
      status: "running",
      model: "auto",
    });

    await waitFor(() =>
      expect(mocks.companionCompleteFrontendRequest).toHaveBeenCalledWith(
        "operation-mid-await-cancel",
        expect.objectContaining({
          type: "error",
          data: expect.objectContaining({ code: "not_found" }),
        }),
      ),
    );
    expect(mocks.cancelAgentRun).not.toHaveBeenCalled();
  });

  it("returns no companion messages when the active partition changes while items load", async () => {
    const cached = agentSession("session-partition-a", "Partition A session");
    const items =
      deferred<
        Array<{
          id: string;
          sessionId: string;
          sequence: number;
          kind: "message";
          role: "assistant";
          text: string;
          status: "complete";
          createdAt: string;
        }>
      >();
    setCurrentDataPartitionName("partition-a");
    mocks.listAgentSessions.mockResolvedValue([cached]);
    mocks.listSessionPartitions.mockResolvedValue([
      { sessionId: cached.id, profile: "partition-a" },
    ]);
    mocks.listAgentItems.mockReturnValue(items.promise);
    render(<App />);

    await waitFor(() => expect(mocks.listeners.has("clovy://companion-request")).toBe(true));
    act(() => {
      mocks.listeners.get("clovy://companion-request")?.({
        payload: {
          operationId: "operation-mid-await-messages",
          intent: {
            type: "agentMessagesList",
            data: { storedSessionId: cached.id, limit: 50 },
          },
        },
      });
    });
    await waitFor(() => expect(mocks.listAgentItems).toHaveBeenCalledWith(cached.id));

    setCurrentDataPartitionName("partition-b");
    items.resolve([
      {
        id: "message-partition-a",
        sessionId: cached.id,
        sequence: 1,
        kind: "message",
        role: "assistant",
        text: "Partition A secret",
        status: "complete",
        createdAt: "2026-07-16T10:00:00.000Z",
      },
    ]);

    await waitFor(() =>
      expect(mocks.companionCompleteFrontendRequest).toHaveBeenCalledWith(
        "operation-mid-await-messages",
        expect.objectContaining({
          type: "error",
          data: expect.objectContaining({ code: "not_found" }),
        }),
      ),
    );
    expect(mocks.companionCompleteFrontendRequest).not.toHaveBeenCalledWith(
      "operation-mid-await-messages",
      expect.objectContaining({ type: "agentMessages" }),
    );
  });

  it("ignores a cached companion focus target after the active partition changes", async () => {
    const user = userEvent.setup();
    const cached = agentSession("session-partition-a", "Partition A session");
    setCurrentDataPartitionName("partition-a");
    mocks.listAgentSessions.mockResolvedValue([cached]);
    mocks.listSessionPartitions.mockResolvedValue([
      { sessionId: cached.id, profile: "partition-a" },
    ]);
    render(<App />);

    await waitFor(() => expect(mocks.getNote).toHaveBeenCalledWith("note-1"));
    await user.click(screen.getByRole("button", { name: "Meeting notes" }));
    await screen.findByRole("heading", { name: /Meeting notes/ });
    await waitFor(() => expect(mocks.listeners.has("clovy://companion-focus")).toBe(true));
    setCurrentDataPartitionName("partition-b");
    act(() => {
      mocks.listeners.get("clovy://companion-focus")?.({
        payload: { agent: { storedSessionId: cached.id } },
      });
    });

    await waitFor(() =>
      expect(screen.queryByRole("textbox", { name: "Message Clovy" })).not.toBeInTheDocument(),
    );
  });

  it("clears the OS Accounts browser session from sidebar sign-out", async () => {
    const user = userEvent.setup();

    render(<App />);

    await waitFor(() => expect(mocks.getNote).toHaveBeenCalledWith("note-1"));

    await user.click(screen.getByRole("button", { name: "alex@example.com, account menu" }));
    await user.click(screen.getByRole("menuitem", { name: "Sign out" }));

    expect(mocks.osAccountsLogout).toHaveBeenCalledWith({ clearBrowserSession: true });
    expect(await screen.findByRole("heading", { name: "Welcome to Clovy" })).toBeInTheDocument();
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
    expect(await screen.findByRole("heading", { name: "Welcome to Clovy" })).toBeInTheDocument();
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
      (await screen.findAllByText("Your starter credits are used up. Upgrade to keep using Clovy."))
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

      expect(await screen.findByRole("region", { name: "Home" })).toBeInTheDocument();

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
        window.dispatchEvent(
          new CustomEvent(AGENT_OPEN_EVENT, { detail: { session: firstSession } }),
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

  it("keeps every companion surface dark until the experiment is enabled", async () => {
    mocks.companionPairingEnabled = false;
    const disabled = render(<App />);

    await waitFor(() => expect(mocks.listeners.has(OPEN_SETTINGS_EVENT)).toBe(true));
    await waitFor(() => expect(mocks.listeners.has("clovy://agent-runtime-event")).toBe(true));
    expect(mocks.listeners.has("clovy://companion-focus")).toBe(false);
    expect(mocks.listeners.has("clovy://companion-request")).toBe(false);
    expect(companionFrontendConsumerAvailable()).toBe(false);
    act(() => {
      mocks.listeners.get("clovy://agent-runtime-event")?.({
        payload: {
          method: "message.delta",
          sessionId: "session-companion",
          data: { delta: "Hidden companion update" },
        },
      });
    });
    expect(mocks.companionPublishAgentEvent).not.toHaveBeenCalled();
    expect(
      appSettingsTabsForCompanionPairing(false).some((tab) => tab.id === "linked-devices"),
    ).toBe(false);
    expect(settingsTabsForCompanionPairing(false).some((tab) => tab.id === "linked-devices")).toBe(
      false,
    );

    act(() => {
      mocks.listeners.get(OPEN_SETTINGS_EVENT)?.({});
    });
    await screen.findByRole("heading", { name: "General" });
    expect(screen.queryByRole("button", { name: "Linked devices" })).not.toBeInTheDocument();

    disabled.unmount();
    mocks.listeners.clear();
    mocks.listen.mockClear();
    mocks.companionPairingEnabled = true;
    mocks.listAgentSessions.mockResolvedValue([
      agentSession("session-companion", "Companion session"),
    ]);
    mocks.listSessionPartitions.mockResolvedValue([
      { sessionId: "session-companion", profile: "default" },
    ]);
    render(<App />);

    await waitFor(() => expect(mocks.listeners.has("clovy://companion-focus")).toBe(true));
    expect(mocks.listeners.has("clovy://companion-request")).toBe(true);
    await waitFor(() => expect(companionFrontendConsumerAvailable()).toBe(true));
    act(() => {
      mocks.listeners.get("clovy://agent-runtime-event")?.({
        payload: {
          method: "message.delta",
          sessionId: "session-companion",
          data: { delta: "Visible companion update" },
        },
      });
    });
    await waitFor(() =>
      expect(mocks.companionPublishAgentEvent).toHaveBeenCalledWith({
        type: "delta",
        data: {
          storedSessionId: "session-companion",
          text: "Visible companion update",
        },
      }),
    );
    expect(
      appSettingsTabsForCompanionPairing(true).some((tab) => tab.id === "linked-devices"),
    ).toBe(true);
    expect(settingsTabsForCompanionPairing(true).some((tab) => tab.id === "linked-devices")).toBe(
      true,
    );

    act(() => {
      mocks.listeners.get(OPEN_SETTINGS_EVENT)?.({});
    });
    expect(await screen.findByRole("button", { name: "Linked devices" })).toBeInTheDocument();
  });

  it("does not publish any agent event from an inactive data partition", async () => {
    const partitionASession = agentSession("session-partition-a", "Partition A session");
    const partitionBSession = agentSession("session-partition-b", "Partition B session");
    mocks.listAgentSessions.mockResolvedValue([partitionASession, partitionBSession]);
    mocks.listSessionPartitions.mockResolvedValue([
      { sessionId: partitionASession.id, profile: "partition-a" },
      { sessionId: partitionBSession.id, profile: "partition-b" },
    ]);
    setCurrentDataPartitionName("partition-b");
    render(<App />);

    await waitFor(() => expect(mocks.listeners.has("clovy://agent-runtime-event")).toBe(true));
    mocks.companionPublishAgentEvent.mockClear();
    mocks.listSessionPartitions.mockClear();

    act(() => {
      mocks.listeners.get("clovy://agent-runtime-event")?.({
        payload: {
          protocolVersion: 1,
          eventId: "event-partition-a-delta",
          sessionId: partitionASession.id,
          runId: "run-partition-a",
          sequence: 1,
          method: "message.delta",
          data: {
            itemId: "message-partition-a",
            role: "assistant",
            delta: "Private partition A text",
            createdAt: now,
          },
        },
      });
      mocks.listeners.get("clovy://agent-runtime-event")?.({
        payload: {
          protocolVersion: 1,
          eventId: "event-partition-a-run-started",
          sessionId: partitionASession.id,
          runId: "run-partition-a",
          sequence: 2,
          method: "run.started",
          data: { startedAt: now, model: "auto" },
        },
      });
      mocks.listeners.get("clovy://agent-runtime-event")?.({
        payload: {
          protocolVersion: 1,
          eventId: "event-partition-a-tool-completed",
          sessionId: partitionASession.id,
          runId: "run-partition-a",
          sequence: 3,
          method: "tool.completed",
          data: {
            itemId: "tool-result-partition-a",
            callId: "call-partition-a",
            name: "generate_image",
            output: [],
            createdAt: now,
          },
        },
      });
    });

    await waitFor(() =>
      expect(mocks.listSessionPartitions.mock.calls.length).toBeGreaterThanOrEqual(3),
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mocks.companionPublishAgentEvent).not.toHaveBeenCalled();
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
    window.localStorage.setItem("clovy:agent:last-open-session", staleSession.id);
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
      window.localStorage.removeItem("clovy:agent:last-open-session");
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

    expect(await screen.findByRole("heading", { name: "Welcome to Clovy" })).toBeInTheDocument();
    expect(mocks.bootstrapApp).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "New note" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Continue with OpenSoftware" }));

    await waitFor(() => expect(mocks.bootstrapApp).toHaveBeenCalledOnce());
    // Clearing the gate lands in the persistent Clovy conversation, not a new note.
    expect(await screen.findByRole("region", { name: "Home" })).toBeInTheDocument();
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

    expect(screen.queryByRole("heading", { name: "Welcome to Clovy" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Continue with OpenSoftware" })).toBeNull();
    expect(mocks.bootstrapApp).not.toHaveBeenCalled();

    resolveStatus?.({
      signedIn: true,
      configured: true,
      user: { id: "usr_123", handle: "alex", email: "alex@example.com" },
      balance: { usdMillis: 1200 },
      subscription: { subscribed: true, status: "active" },
    });

    expect(await screen.findByRole("region", { name: "Home" })).toBeInTheDocument();
  });

  it("bypasses account gates in dev when account status is unavailable", async () => {
    mocks.osAccountsStatus.mockRejectedValue(new Error("accounts unavailable"));

    render(<App />);

    expect(await screen.findByRole("region", { name: "Home" })).toBeInTheDocument();
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

  it("exposes no sessions before the data partition mapping has loaded successfully", async () => {
    const user = userEvent.setup();
    const privateSession = {
      id: "partition-a-session",
      title: "Named data partition secret",
      preview: "Private data partition conversation",
      last_active: now,
    };
    mocks.listSessionPartitions.mockRejectedValue(
      new Error("session data partition map unavailable"),
    );

    render(<App />);
    await waitFor(() => expect(mocks.listSessionPartitions).toHaveBeenCalled());

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

  it("invalidates note tabs from the previous data partition", async () => {
    const user = userEvent.setup();
    const partitionANote = note({ id: "note-a", title: "Data partition A private note" });
    const partitionBNote = note({ id: "note-b", title: "Data partition B note" });
    mocks.createNote.mockResolvedValue(partitionANote);

    render(<App />);
    await waitFor(() => expect(mocks.getNote).toHaveBeenCalledWith("note-1"));

    fireEvent.keyDown(window, { key: "n", metaKey: true, shiftKey: true });
    await waitFor(() =>
      expect(screen.getByRole("tab", { name: "Data partition A private note" })).toHaveAttribute(
        "data-active",
        "true",
      ),
    );
    await user.click(screen.getByRole("button", { name: "New tab" }));

    mocks.listNotes.mockResolvedValue({ items: [partitionBNote] });
    mocks.listFolders.mockResolvedValue([]);
    mocks.getNote.mockImplementation(async (noteId: string) =>
      noteId === partitionBNote.id ? partitionBNote : partitionANote,
    );
    act(() => setCurrentDataPartitionName("partition-b"));

    await waitFor(() => expect(mocks.getNote).toHaveBeenCalledWith(partitionBNote.id));
    mocks.getNote.mockClear();

    fireEvent.keyDown(window, { key: "1", metaKey: true });

    const invalidatedTab = await screen.findByRole("tab", { name: "Notes" });
    await waitFor(() => expect(invalidatedTab).toHaveAttribute("data-active", "true"));
    expect(mocks.getNote).not.toHaveBeenCalled();
    expect(screen.queryByText("Data partition A private note")).toBeNull();
  });

  it("abandons pending project intent when the data partition switches", async () => {
    const user = userEvent.setup();
    const folder = {
      id: "folder-a",
      name: "Data partition A project",
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
    act(() => setCurrentDataPartitionName("partition-b"));
    await waitFor(() => expect(mocks.listFolders).toHaveBeenCalled());

    act(() => {
      window.dispatchEvent(
        new CustomEvent(AGENT_SESSIONS_CHANGED_EVENT, {
          detail: {
            sessions: [{ id: "partition-b-session", title: "Data partition B session" }],
            selectedSessionId: "partition-b-session",
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

  it("opens the chat for an Agent HUD click carrying a stored session id", async () => {
    mocks.listAgentSessions.mockResolvedValue([agentSession("session-9", "Notified session")]);

    render(<App />);
    await waitFor(() => expect(mocks.getNote).toHaveBeenCalledWith("note-1"));
    await waitFor(() => expect(mocks.agentOpenReady).toHaveBeenCalledOnce());
    mocks.agentOpenReady.mockClear();

    act(() => {
      window.dispatchEvent(
        new CustomEvent(AGENT_OPEN_EVENT, { detail: { storedSessionId: "session-9" } }),
      );
    });

    expect(await screen.findByRole("button", { name: "Send message" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: HERO_GREETING })).not.toBeInTheDocument();
    expect(mocks.agentOpenReady).not.toHaveBeenCalled();
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

  it("preserves a newer notification click while acknowledging the delivered one", async () => {
    mocks.listAgentSessions.mockResolvedValue([
      agentSession("session-old", "Older notification"),
      agentSession("session-new", "Newer notification"),
    ]);

    render(<App />);
    await screen.findByRole("button", { name: "Older notification" });
    await waitFor(() => expect(mocks.agentOpenReady).toHaveBeenCalledOnce());
    mocks.agentOpenReady.mockClear();
    mocks.agentOpenReady.mockResolvedValueOnce("session-new");

    act(() => {
      window.dispatchEvent(
        new CustomEvent(AGENT_OPEN_EVENT, { detail: { sessionId: "session-old" } }),
      );
    });

    await waitFor(() => expect(mocks.agentOpenReady).toHaveBeenCalledOnce());
    await waitFor(() => expect(mocks.getAgentSession).toHaveBeenCalledWith("session-new"));
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
