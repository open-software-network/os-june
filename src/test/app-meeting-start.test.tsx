import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../app/App";
import { AGENT_RECORDER_REQUEST_EVENT, MEETING_START_TRANSCRIPTION_EVENT } from "../lib/events";
import type { AccountStatus, BootstrapResponse, NoteDto, RecordingSessionDto } from "../lib/tauri";

type TauriListener = (event: { payload: unknown }) => unknown;

const mocks = vi.hoisted(() => ({
  listeners: new Map<string, TauriListener>(),
  listen: vi.fn((event: string, listener: TauriListener) => {
    mocks.listeners.set(event, listener);
    return Promise.resolve(vi.fn());
  }),
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
  resolveAgentRecorderRequest: vi.fn(),
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
  playRecordingSound: vi.fn(),
  preloadRecordingSounds: vi.fn(),
  preloadAgentSounds: vi.fn(),
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

vi.mock("../lib/tauri", () => ({
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
  resolveAgentRecorderRequest: mocks.resolveAgentRecorderRequest,
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
  // The agent workspace mounts at launch; a quiet, not-running bridge keeps
  // these tests focused on the meetings surfaces.
  hermesBridgeStatus: vi.fn(async () => ({ running: false })),
  listAgentTasks: vi.fn(async () => ({ items: [] })),
  juneVerifyUrl: vi.fn(async () => ""),
  providerModelSettings: vi.fn(async () => ({
    settings: { generationModel: "" },
  })),
  setVeniceApiKey: vi.fn(async () => ({
    generationModel: "",
    veniceApiKeyConfigured: true,
  })),
  clearVeniceApiKey: vi.fn(async () => ({
    generationModel: "",
    veniceApiKeyConfigured: false,
  })),
  hermesAgentCliAccess: vi.fn(async () => ({ enabled: false })),
  listVeniceModels: vi.fn(async () => ({
    mode: "generation",
    modelType: "text",
    selectedModel: "",
    models: [],
  })),
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

function recording(overrides: Partial<RecordingSessionDto> = {}) {
  return {
    id: "rec-1",
    noteId: "note-1",
    sourceMode: "microphonePlusSystem" as const,
    state: "recording" as const,
    startedAt: now,
    elapsedMs: 0,
    level: { peak: 0, rms: 0, recentPeaks: [] },
    sources: [],
    warnings: [],
    ...overrides,
  };
}

describe("meeting start transcription event", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listeners.clear();

    const first = note();
    const payload: BootstrapResponse = {
      folders: [],
      notes: [first],
      activeRecoveries: [],
      providerConfigured: true,
    };
    const account: AccountStatus = {
      signedIn: true,
      configured: true,
      user: { id: "usr_123", handle: "alex", email: "alex@example.com" },
      balance: { usdMillis: 1200 },
      subscription: { subscribed: true, status: "active" },
    };

    mocks.getCurrentWindow.mockReturnValue({
      show: vi.fn().mockResolvedValue(undefined),
      unminimize: vi.fn().mockResolvedValue(undefined),
      setFocus: vi.fn().mockResolvedValue(undefined),
      startDragging: vi.fn().mockResolvedValue(undefined),
    });
    mocks.bootstrapApp.mockResolvedValue(payload);
    mocks.getNote.mockResolvedValue(first);
    mocks.checkRecordingSourceReadiness.mockResolvedValue({
      sourceMode: "microphonePlusSystem",
      sources: [
        { source: "microphone", ready: true },
        { source: "system", ready: true, permissionState: "granted" },
      ],
    });
    mocks.startRecording.mockResolvedValue(recording());
    // The active-recording poll (App.tsx ~20Hz waveform interval) calls this
    // on a timer; without a resolved value the tick throws on undefined.then
    // as an unhandled error after the assertions finish - a timing-dependent
    // CI failure that coverage instrumentation reliably triggers.
    mocks.getRecordingStatus.mockResolvedValue({
      sessionId: "rec-1",
      state: "recording",
      elapsedMs: 500,
      level: { peak: 0.2, rms: 0.1, recentPeaks: [0.2] },
      silenceWarning: false,
      bytesWritten: 2048,
    });
    mocks.dictationHelperCommand.mockResolvedValue(undefined);
    mocks.listDictationHistory.mockResolvedValue({
      items: [],
      retentionDays: 7,
    });
    mocks.osAccountsStatus.mockResolvedValue(account);
    mocks.osAccountsLogin.mockResolvedValue(account);
    mocks.osAccountsLogout.mockResolvedValue(undefined);
    mocks.osAccountsCancelLogin.mockResolvedValue(undefined);
    mocks.osAccountsUpgrade.mockResolvedValue(undefined);
    mocks.updateNote.mockImplementation(async (input) => ({
      ...first,
      ...input,
    }));
  });

  // The meeting-start listener silently drops events until the effect
  // re-subscribes with bootstrapped=true — and that happens in a passive
  // effect of a commit made outside act (getNote's resolution), so on slow
  // (coverage) runs the listener in the map can still be a stale closure
  // when we fire. Re-fire until the live listener takes the event; the
  // calls-length guard makes a successful start fire exactly once, so this
  // can never double-start a recording.
  async function fireMeetingStartUntilRecording() {
    await waitFor(async () => {
      if (mocks.startRecording.mock.calls.length === 0) {
        await act(async () => {
          await mocks.listeners.get(MEETING_START_TRANSCRIPTION_EVENT)?.({
            payload: undefined,
          });
        });
      }
      expect(mocks.createNote).toHaveBeenCalledWith(undefined);
      expect(mocks.startRecording).toHaveBeenCalledWith("note-2", "microphonePlusSystem");
    });
  }

  it("creates a fresh note before recording from the meeting prompt", async () => {
    const fresh = note({
      id: "note-2",
      title: "New meeting",
      preview: "",
      generatedContent: undefined,
    });
    mocks.createNote.mockResolvedValue(fresh);
    mocks.startRecording.mockResolvedValue(recording({ noteId: "note-2" }));

    render(<App />);

    await waitFor(() => expect(mocks.listeners.has(MEETING_START_TRANSCRIPTION_EVENT)).toBe(true));
    await waitFor(() => expect(mocks.getNote).toHaveBeenCalledWith("note-1"));

    await fireMeetingStartUntilRecording();
    expect(mocks.playRecordingSound).toHaveBeenCalledWith("start");
    expect(screen.getByLabelText("Note title")).toHaveValue("New meeting");
  });

  it("reopens the recording HUD to the note editor for the active recording", async () => {
    const fresh = note({
      id: "note-2",
      title: "New meeting",
      preview: "",
      generatedContent: undefined,
    });
    mocks.createNote.mockResolvedValue(fresh);
    mocks.startRecording.mockResolvedValue(recording({ noteId: "note-2" }));
    mocks.getNote.mockImplementation(async (id: string) => (id === "note-2" ? fresh : note()));

    render(<App />);

    await waitFor(() => expect(mocks.listeners.has(MEETING_START_TRANSCRIPTION_EVENT)).toBe(true));
    await waitFor(() => expect(mocks.getNote).toHaveBeenCalledWith("note-1"));

    await fireMeetingStartUntilRecording();
    expect(mocks.startRecording).toHaveBeenCalledOnce();
    expect(screen.getByLabelText("Note title")).toHaveValue("New meeting");

    await act(async () => {
      await mocks.listeners.get("meeting-hud-action")?.({
        payload: { action: "reopen" },
      });
    });

    await waitFor(() => expect(screen.getByLabelText("Note title")).toHaveValue("New meeting"));
  });

  it("cleans up Tauri listeners that resolve after unmount", async () => {
    const cleanups: Array<ReturnType<typeof vi.fn>> = [];
    const pendingListeners: Array<(cleanup: (typeof cleanups)[number]) => void> = [];
    mocks.listen.mockImplementation((event: string, listener: TauriListener) => {
      mocks.listeners.set(event, listener);
      return new Promise((resolve) => {
        pendingListeners.push(resolve);
      });
    });

    const { unmount } = render(<App />);

    await waitFor(() => expect(mocks.listen).toHaveBeenCalled());
    unmount();

    await act(async () => {
      for (const resolve of pendingListeners) {
        const cleanup = vi.fn();
        cleanups.push(cleanup);
        resolve(cleanup);
      }
    });

    expect(cleanups.length).toBeGreaterThan(0);
    for (const cleanup of cleanups) {
      expect(cleanup).toHaveBeenCalledOnce();
    }
  });
});

describe("agent recorder request event", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listeners.clear();

    const first = note();
    const payload: BootstrapResponse = {
      folders: [],
      notes: [first],
      activeRecoveries: [],
      providerConfigured: true,
    };
    const account: AccountStatus = {
      signedIn: true,
      configured: true,
      user: { id: "usr_123", handle: "alex", email: "alex@example.com" },
      balance: { usdMillis: 1200 },
      subscription: { subscribed: true, status: "active" },
    };

    mocks.getCurrentWindow.mockReturnValue({
      show: vi.fn().mockResolvedValue(undefined),
      unminimize: vi.fn().mockResolvedValue(undefined),
      setFocus: vi.fn().mockResolvedValue(undefined),
      startDragging: vi.fn().mockResolvedValue(undefined),
    });
    mocks.bootstrapApp.mockResolvedValue(payload);
    mocks.getNote.mockResolvedValue(first);
    mocks.createNote.mockResolvedValue(
      note({ id: "note-agent", title: "Agent recording", generatedContent: undefined }),
    );
    mocks.checkRecordingSourceReadiness.mockResolvedValue({
      sourceMode: "microphonePlusSystem",
      sources: [
        { source: "microphone", ready: true },
        { source: "system", ready: true, permissionState: "granted" },
      ],
    });
    mocks.startRecording.mockResolvedValue(recording({ id: "rec-agent", noteId: "note-agent" }));
    mocks.getRecordingStatus.mockResolvedValue({
      sessionId: "rec-agent",
      noteId: "note-agent",
      sourceMode: "microphonePlusSystem",
      state: "recording",
      elapsedMs: 500,
      level: { peak: 0.2, rms: 0.1, recentPeaks: [0.2] },
      silenceWarning: false,
      bytesWritten: 2048,
    });
    mocks.finishRecording.mockResolvedValue({
      note: note({ id: "note-agent", title: "Agent recording", processingStatus: "transcribing" }),
      recording: recording({ id: "rec-agent", noteId: "note-agent" }),
      validation: {},
      validations: [],
      processingStarted: true,
      warnings: [],
    });
    mocks.dictationHelperCommand.mockResolvedValue(undefined);
    mocks.listDictationHistory.mockResolvedValue({ items: [], retentionDays: 7 });
    mocks.osAccountsStatus.mockResolvedValue(account);
    mocks.osAccountsLogin.mockResolvedValue(account);
    mocks.osAccountsLogout.mockResolvedValue(undefined);
    mocks.osAccountsCancelLogin.mockResolvedValue(undefined);
    mocks.osAccountsUpgrade.mockResolvedValue(undefined);
    mocks.updateNote.mockImplementation(async (input) => ({ ...first, ...input }));
    mocks.resolveAgentRecorderRequest.mockResolvedValue(undefined);
  });

  // The agent-recorder chain is fully mocked but multi-hop async; the 1s
  // default waitFor timeout flakes under full-suite machine load.
  const waitForLoaded = <T,>(callback: () => T) => waitFor(callback, { timeout: 5_000 });

  async function renderUntilAgentRecorderListener() {
    render(<App />);
    // The listener registers exactly once; its handler reads app state
    // through a latest-closure ref, so waiting for bootstrap data (getNote)
    // is enough for the handler to see the ready app.
    await waitForLoaded(() => expect(mocks.listeners.has(AGENT_RECORDER_REQUEST_EVENT)).toBe(true));
    await waitForLoaded(() => expect(mocks.getNote).toHaveBeenCalledWith("note-1"));
  }

  it("starts a requested recording and acks with the created note", async () => {
    await renderUntilAgentRecorderListener();

    await act(async () => {
      await mocks.listeners.get(AGENT_RECORDER_REQUEST_EVENT)?.({
        payload: {
          requestId: "req-start",
          action: "start",
          sourceMode: "microphonePlusSystem",
        },
      });
    });

    await waitForLoaded(() => {
      expect(mocks.startRecording).toHaveBeenCalledWith("note-agent", "microphonePlusSystem");
      expect(mocks.resolveAgentRecorderRequest).toHaveBeenCalledWith({
        requestId: "req-start",
        ok: true,
        noteId: "note-agent",
        noteTitle: "Agent recording",
      });
    });
  });

  it("acks start with an error when recording is already running", async () => {
    await renderUntilAgentRecorderListener();
    await act(async () => {
      await mocks.listeners.get(AGENT_RECORDER_REQUEST_EVENT)?.({
        payload: {
          requestId: "req-first",
          action: "start",
          sourceMode: "microphonePlusSystem",
        },
      });
    });
    await waitForLoaded(() => expect(mocks.startRecording).toHaveBeenCalledOnce());

    await act(async () => {
      await mocks.listeners.get(AGENT_RECORDER_REQUEST_EVENT)?.({
        payload: {
          requestId: "req-second",
          action: "start",
          sourceMode: "microphonePlusSystem",
        },
      });
    });

    expect(mocks.resolveAgentRecorderRequest).toHaveBeenLastCalledWith({
      requestId: "req-second",
      ok: false,
      errorCode: "agent_recorder_failed",
      errorMessage: "A recording is already running for note note-agent.",
    });
  });

  it("stops the active recording and acks the owning note", async () => {
    await renderUntilAgentRecorderListener();
    await act(async () => {
      await mocks.listeners.get(AGENT_RECORDER_REQUEST_EVENT)?.({
        payload: {
          requestId: "req-start",
          action: "start",
          sourceMode: "microphonePlusSystem",
        },
      });
    });
    // Wait for the start ACK (not just the startRecording call): the stop
    // below must see the recording status already reflected, or it races
    // into the recording_not_found branch under suite load.
    await waitForLoaded(() =>
      expect(mocks.resolveAgentRecorderRequest).toHaveBeenLastCalledWith(
        expect.objectContaining({ requestId: "req-start", ok: true }),
      ),
    );

    await act(async () => {
      await mocks.listeners.get(AGENT_RECORDER_REQUEST_EVENT)?.({
        payload: { requestId: "req-stop", action: "stop" },
      });
    });

    await waitForLoaded(() => {
      expect(mocks.finishRecording).toHaveBeenCalledWith("rec-agent");
      expect(mocks.resolveAgentRecorderRequest).toHaveBeenLastCalledWith({
        requestId: "req-stop",
        ok: true,
        noteId: "note-agent",
        noteTitle: "Agent recording",
      });
    });
  });
});
