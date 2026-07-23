import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../app/App";
import { AGENT_RECORDER_REQUEST_EVENT, MEETING_START_TRANSCRIPTION_EVENT } from "../lib/events";
import type { AccountStatus, BootstrapResponse, NoteDto, RecordingSessionDto } from "../lib/tauri";

type TauriListener = (event: { payload: unknown }) => unknown;

const mocks = vi.hoisted(() => ({
  listeners: new Map<string, TauriListener>(),
  pendingMeetingStartRequest: undefined as
    | { requestId: string; noteId: string; requestedAtMs: number; expired: boolean }
    | undefined,
  listen: vi.fn((event: string, listener: TauriListener) => {
    mocks.listeners.set(event, listener);
    return Promise.resolve(vi.fn());
  }),
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
  removeNoteFromFolder: vi.fn(),
  listNotes: vi.fn(),
  getNote: vi.fn(),
  deleteNote: vi.fn(),
  updateNote: vi.fn(),
  checkRecordingSourceReadiness: vi.fn(),
  openPrivacySettings: vi.fn(),
  startRecording: vi.fn(),
  startMeetingRecording: vi.fn(),
  pauseRecording: vi.fn(),
  resumeRecording: vi.fn(),
  setRecordingPresenceBounds: vi.fn(async () => undefined),
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
  RECORDING_TELEMETRY_EVENT: "recording-telemetry",
  NOTE_CALENDAR_CONTEXT_UPDATED_EVENT: "note-calendar-context-updated-event",
  bootstrapApp: mocks.bootstrapApp,
  createNote: mocks.createNote,
  createFolder: mocks.createFolder,
  deleteFolder: mocks.deleteFolder,
  renameFolder: mocks.renameFolder,
  assignNoteToFolder: mocks.assignNoteToFolder,
  listSessionFolders: vi.fn(async () => []),
  listCompletedSessions: vi.fn(async () => []),
  setSessionCompleted: vi.fn(async () => undefined),
  listSessionProfiles: vi.fn(async () => []),
  assignSessionToFolder: vi.fn(async () => undefined),
  assignSessionToProfile: vi.fn(async () => undefined),
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
  setRecordingPresenceBounds: mocks.setRecordingPresenceBounds,
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
  pendingMeetingStartRequest: mocks.readPendingMeetingStartRequest,
  acknowledgeMeetingStartRequest: mocks.acknowledgeMeetingStartRequest,
  startMeetingRecording: mocks.startMeetingRecording,
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
  hermesBrowserAccess: vi.fn(async () => ({ enabled: false })),
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve };
}

function installDefaultListenMock() {
  mocks.listen.mockImplementation((event: string, listener: TauriListener) => {
    mocks.listeners.set(event, listener);
    return Promise.resolve(vi.fn());
  });
}

describe("meeting start transcription event", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listeners.clear();
    mocks.pendingMeetingStartRequest = undefined;
    installDefaultListenMock();
    mocks.readPendingMeetingStartRequest.mockImplementation(
      async () => mocks.pendingMeetingStartRequest ?? null,
    );
    mocks.acknowledgeMeetingStartRequest.mockImplementation(async (requestId: string) => {
      if (mocks.pendingMeetingStartRequest?.requestId !== requestId) return false;
      mocks.pendingMeetingStartRequest = undefined;
      return true;
    });

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

  async function fireMeetingStart(expired = false) {
    mocks.pendingMeetingStartRequest = {
      requestId: "meeting-request-1",
      noteId: "note-2",
      requestedAtMs: Date.now(),
      expired,
    };
    await act(async () => {
      await mocks.listeners.get(MEETING_START_TRANSCRIPTION_EVENT)?.({
        payload: undefined,
      });
    });
  }

  it("creates a fresh note before recording from the meeting prompt", async () => {
    const fresh = note({
      id: "note-2",
      title: "New meeting",
      preview: "",
      generatedContent: undefined,
    });
    mocks.startMeetingRecording.mockResolvedValue({
      status: "started",
      note: fresh,
      recording: recording({ noteId: "note-2" }),
    });

    render(<App />);

    await waitFor(() => expect(mocks.listeners.has(MEETING_START_TRANSCRIPTION_EVENT)).toBe(true));
    await waitFor(() => expect(mocks.getNote).toHaveBeenCalledWith("note-1"));

    await fireMeetingStart();
    await waitFor(() => {
      expect(mocks.startMeetingRecording).toHaveBeenCalledWith(
        "meeting-request-1",
        "microphonePlusSystem",
      );
    });
    expect(mocks.acknowledgeMeetingStartRequest).toHaveBeenCalledWith("meeting-request-1");
    expect(mocks.playRecordingSound).toHaveBeenCalledWith("start");
    expect(await screen.findByLabelText("Note title")).toHaveValue("New meeting");
  });

  it("keeps calendar enrichment that arrives before native meeting startup resolves", async () => {
    const staleNote = note({
      id: "calendar-meeting-note",
      title: "New meeting",
      preview: "",
      generatedContent: undefined,
    });
    const enrichedNote = note({
      ...staleNote,
      title: "Roadmap sync",
      calendarEvent: {
        eventId: "calendar-event-1",
        title: "Roadmap sync",
        startAt: "2026-07-21T16:00:00Z",
        endAt: "2026-07-21T16:30:00Z",
        accountEmail: "calendar-owner@example.com",
      },
    });
    const outcome = {
      status: "started" as const,
      note: staleNote,
      recording: recording({ noteId: staleNote.id }),
    };
    const pendingStart = deferred<typeof outcome>();
    mocks.startMeetingRecording.mockReturnValue(pendingStart.promise);

    render(<App />);
    await waitFor(() => expect(mocks.listeners.has(MEETING_START_TRANSCRIPTION_EVENT)).toBe(true));
    await waitFor(() =>
      expect(mocks.listeners.has("note-calendar-context-updated-event")).toBe(true),
    );
    await waitFor(() => expect(mocks.getNote).toHaveBeenCalledWith("note-1"));

    mocks.pendingMeetingStartRequest = {
      requestId: "calendar-meeting-request",
      noteId: staleNote.id,
      requestedAtMs: Date.now(),
      expired: false,
    };
    await act(async () => {
      await mocks.listeners.get(MEETING_START_TRANSCRIPTION_EVENT)?.({ payload: undefined });
    });
    await waitFor(() => expect(mocks.startMeetingRecording).toHaveBeenCalledOnce());

    await act(async () => {
      await mocks.listeners.get("note-calendar-context-updated-event")?.({
        payload: enrichedNote,
      });
      pendingStart.resolve(outcome);
      await pendingStart.promise;
    });

    expect(await screen.findByLabelText("Note title")).toHaveValue("Roadmap sync");
    expect(screen.getByText("calendar-owner@example.com")).toBeInTheDocument();
  });

  it("reopens the recording HUD to the note editor for the active recording", async () => {
    const fresh = note({
      id: "note-2",
      title: "New meeting",
      preview: "",
      generatedContent: undefined,
    });
    mocks.startMeetingRecording.mockResolvedValue({
      status: "started",
      note: fresh,
      recording: recording({ noteId: "note-2" }),
    });
    mocks.getNote.mockImplementation(async (id: string) => (id === "note-2" ? fresh : note()));

    render(<App />);

    await waitFor(() => expect(mocks.listeners.has(MEETING_START_TRANSCRIPTION_EVENT)).toBe(true));
    await waitFor(() => expect(mocks.getNote).toHaveBeenCalledWith("note-1"));

    await fireMeetingStart();
    await waitFor(() => expect(mocks.startMeetingRecording).toHaveBeenCalledOnce());
    expect(screen.getByLabelText("Note title")).toHaveValue("New meeting");

    await act(async () => {
      await mocks.listeners.get("meeting-hud-action")?.({
        payload: { action: "reopen" },
      });
    });

    await waitFor(() => expect(screen.getByLabelText("Note title")).toHaveValue("New meeting"));
  });

  it("queues one meeting start until bootstrap is ready without re-registering", async () => {
    const first = note();
    const fresh = note({
      id: "note-2",
      title: "New meeting",
      preview: "",
      generatedContent: undefined,
    });
    const bootstrap = deferred<BootstrapResponse>();
    mocks.bootstrapApp.mockReturnValue(bootstrap.promise);
    mocks.startMeetingRecording.mockResolvedValue({
      status: "started",
      note: fresh,
      recording: recording({ noteId: fresh.id }),
    });

    render(<App />);

    await waitFor(() => expect(mocks.listeners.has(MEETING_START_TRANSCRIPTION_EVENT)).toBe(true));
    await fireMeetingStart();
    expect(mocks.readPendingMeetingStartRequest).not.toHaveBeenCalled();
    expect(mocks.createNote).not.toHaveBeenCalled();

    await waitFor(() => expect(mocks.bootstrapApp).toHaveBeenCalledOnce());
    await act(async () => {
      bootstrap.resolve({
        folders: [],
        notes: [first],
        activeRecoveries: [],
        providerConfigured: true,
      });
      await bootstrap.promise;
    });

    await waitFor(() =>
      expect(mocks.startMeetingRecording).toHaveBeenCalledWith(
        "meeting-request-1",
        "microphonePlusSystem",
      ),
    );
    expect(mocks.startMeetingRecording).toHaveBeenCalledOnce();
    expect(
      mocks.listen.mock.calls.filter(
        ([eventName]) => eventName === MEETING_START_TRANSCRIPTION_EVENT,
      ),
    ).toHaveLength(1);
  });

  it("explains when a queued meeting start expires before recording begins", async () => {
    const first = note();
    const bootstrap = deferred<BootstrapResponse>();
    const mainWindow = mocks.getCurrentWindow();
    mocks.bootstrapApp.mockReturnValue(bootstrap.promise);

    render(<App />);

    await waitFor(() => expect(mocks.listeners.has(MEETING_START_TRANSCRIPTION_EVENT)).toBe(true));
    await fireMeetingStart(true);

    await act(async () => {
      bootstrap.resolve({
        folders: [],
        notes: [first],
        activeRecoveries: [],
        providerConfigured: true,
      });
      await bootstrap.promise;
    });

    await waitFor(() =>
      expect(
        screen.getByText(
          "Recording did not start in time. Open meeting notes and select Record to try again.",
        ),
      ).toBeInTheDocument(),
    );
    expect(mocks.startMeetingRecording).not.toHaveBeenCalled();
    expect(mocks.acknowledgeMeetingStartRequest).toHaveBeenCalledWith("meeting-request-1");
    expect(mainWindow.show).toHaveBeenCalled();
    expect(mainWindow.unminimize).toHaveBeenCalled();
    expect(mainWindow.setFocus).toHaveBeenCalled();
  });

  it("reveals and focuses the main window when native meeting startup fails", async () => {
    const first = note();
    const mainWindow = mocks.getCurrentWindow();
    mocks.listNotes.mockResolvedValue({ items: [first] });
    mocks.startMeetingRecording.mockResolvedValue({
      status: "failed",
      error: {
        code: "source_not_ready",
        message: "Microphone is not ready.",
      },
    });

    render(<App />);
    await waitFor(() => expect(mocks.listeners.has(MEETING_START_TRANSCRIPTION_EVENT)).toBe(true));
    await waitFor(() => expect(mocks.getNote).toHaveBeenCalledWith(first.id));

    await fireMeetingStart();

    expect(await screen.findByText("Microphone is not ready.")).toBeInTheDocument();
    expect(mainWindow.show).toHaveBeenCalled();
    expect(mainWindow.unminimize).toHaveBeenCalled();
    expect(mainWindow.setFocus).toHaveBeenCalled();
  });

  it("drains the newer generation when an expired request loses the acknowledgement race", async () => {
    const expiredRequest = {
      requestId: "expired-request",
      noteId: "expired-note",
      requestedAtMs: Date.now() - 60_000,
      expired: true,
    };
    const newerRequest = {
      requestId: "newer-request",
      noteId: "newer-note",
      requestedAtMs: Date.now(),
      expired: false,
    };
    const fresh = note({ id: newerRequest.noteId, title: "Newer meeting" });
    mocks.pendingMeetingStartRequest = expiredRequest;
    mocks.acknowledgeMeetingStartRequest.mockImplementation(async (requestId: string) => {
      if (requestId === expiredRequest.requestId) {
        mocks.pendingMeetingStartRequest = newerRequest;
        return false;
      }
      if (mocks.pendingMeetingStartRequest?.requestId !== requestId) return false;
      mocks.pendingMeetingStartRequest = undefined;
      return true;
    });
    mocks.startMeetingRecording.mockResolvedValue({
      status: "started",
      note: fresh,
      recording: recording({ noteId: fresh.id }),
    });

    render(<App />);

    await waitFor(() =>
      expect(mocks.acknowledgeMeetingStartRequest).toHaveBeenCalledWith(expiredRequest.requestId),
    );
    await waitFor(
      () =>
        expect(mocks.startMeetingRecording).toHaveBeenCalledWith(
          newerRequest.requestId,
          "microphonePlusSystem",
        ),
      { timeout: 2_000 },
    );
    expect(mocks.startMeetingRecording).not.toHaveBeenCalledWith(
      expiredRequest.requestId,
      expect.anything(),
    );
    await waitFor(() =>
      expect(mocks.acknowledgeMeetingStartRequest).toHaveBeenCalledWith(newerRequest.requestId),
    );
  });

  it("drains a native request queued before listener registration completes", async () => {
    const fresh = note({
      id: "note-2",
      title: "New meeting",
      preview: "",
      generatedContent: undefined,
    });
    const cleanup = vi.fn();
    let finishMeetingRegistration: (() => void) | undefined;
    mocks.startMeetingRecording.mockResolvedValue({
      status: "started",
      note: fresh,
      recording: recording({ noteId: fresh.id }),
    });
    mocks.listen.mockImplementation((event: string, listener: TauriListener) => {
      if (event !== MEETING_START_TRANSCRIPTION_EVENT) {
        mocks.listeners.set(event, listener);
        return Promise.resolve(vi.fn());
      }
      return new Promise((resolve) => {
        finishMeetingRegistration = () => {
          mocks.listeners.set(event, listener);
          resolve(cleanup);
        };
      });
    });
    mocks.pendingMeetingStartRequest = {
      requestId: "meeting-request-1",
      noteId: fresh.id,
      requestedAtMs: Date.now(),
      expired: false,
    };

    render(<App />);

    await waitFor(() => expect(finishMeetingRegistration).toBeTypeOf("function"));
    expect(mocks.listeners.has(MEETING_START_TRANSCRIPTION_EVENT)).toBe(false);
    expect(mocks.readPendingMeetingStartRequest).not.toHaveBeenCalled();

    await act(async () => {
      finishMeetingRegistration?.();
    });

    await waitFor(() =>
      expect(mocks.startMeetingRecording).toHaveBeenCalledWith(
        "meeting-request-1",
        "microphonePlusSystem",
      ),
    );
    expect(mocks.readPendingMeetingStartRequest).toHaveBeenCalledOnce();
    expect(mocks.startMeetingRecording).toHaveBeenCalledOnce();
  });

  it("retries listener registration after a transient failure", async () => {
    const fresh = note({
      id: "note-2",
      title: "New meeting",
      preview: "",
      generatedContent: undefined,
    });
    let meetingRegistrationAttempts = 0;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mocks.startMeetingRecording.mockResolvedValue({
      status: "started",
      note: fresh,
      recording: recording({ noteId: fresh.id }),
    });
    mocks.listen.mockImplementation((event: string, listener: TauriListener) => {
      if (event === MEETING_START_TRANSCRIPTION_EVENT) {
        meetingRegistrationAttempts += 1;
        if (meetingRegistrationAttempts === 1) {
          return Promise.reject(new Error("event plugin not ready"));
        }
      }
      mocks.listeners.set(event, listener);
      return Promise.resolve(vi.fn());
    });

    render(<App />);

    await waitFor(
      () => {
        expect(meetingRegistrationAttempts).toBe(2);
        expect(mocks.listeners.has(MEETING_START_TRANSCRIPTION_EVENT)).toBe(true);
      },
      { timeout: 1_000 },
    );
    await fireMeetingStart();

    await waitFor(() =>
      expect(mocks.startMeetingRecording).toHaveBeenCalledWith(
        "meeting-request-1",
        "microphonePlusSystem",
      ),
    );
    expect(mocks.startMeetingRecording).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      "Failed to register the meeting start listener; retrying.",
      expect.any(Error),
    );
    warn.mockRestore();
  });

  it("retains a request when the webview unmounts before the native read resolves", async () => {
    const fresh = note({
      id: "note-2",
      title: "New meeting",
      preview: "",
      generatedContent: undefined,
    });
    const request = {
      requestId: "meeting-request-1",
      noteId: fresh.id,
      requestedAtMs: Date.now(),
      expired: false,
    };
    const firstRead = deferred<typeof request | null>();
    let readCount = 0;
    mocks.pendingMeetingStartRequest = request;
    mocks.readPendingMeetingStartRequest.mockImplementation(async () => {
      readCount += 1;
      return readCount === 1 ? firstRead.promise : (mocks.pendingMeetingStartRequest ?? null);
    });
    mocks.startMeetingRecording.mockResolvedValue({
      status: "started",
      note: fresh,
      recording: recording({ noteId: fresh.id }),
    });

    const firstView = render(<App />);
    await waitFor(() => expect(mocks.readPendingMeetingStartRequest).toHaveBeenCalledOnce());
    firstView.unmount();
    await act(async () => {
      firstRead.resolve(request);
      await firstRead.promise;
    });

    expect(mocks.startMeetingRecording).not.toHaveBeenCalled();
    expect(mocks.acknowledgeMeetingStartRequest).not.toHaveBeenCalled();

    render(<App />);
    await waitFor(() => expect(mocks.startMeetingRecording).toHaveBeenCalledOnce());
    await waitFor(() =>
      expect(mocks.acknowledgeMeetingStartRequest).toHaveBeenCalledWith(request.requestId),
    );
  });

  it("replays a native terminal result after reload before acknowledgement", async () => {
    const fresh = note({
      id: "note-2",
      title: "New meeting",
      preview: "",
      generatedContent: undefined,
    });
    const request = {
      requestId: "meeting-request-1",
      noteId: fresh.id,
      requestedAtMs: Date.now(),
      expired: false,
    };
    const outcome = {
      status: "started" as const,
      note: fresh,
      recording: recording({ noteId: fresh.id }),
    };
    const firstStart = deferred<typeof outcome>();
    mocks.pendingMeetingStartRequest = request;
    mocks.startMeetingRecording
      .mockImplementationOnce(() => firstStart.promise)
      .mockResolvedValue(outcome);

    const firstView = render(<App />);
    await waitFor(() => expect(mocks.startMeetingRecording).toHaveBeenCalledOnce());
    firstView.unmount();
    await act(async () => {
      firstStart.resolve(outcome);
      await firstStart.promise;
    });

    expect(mocks.acknowledgeMeetingStartRequest).not.toHaveBeenCalled();
    expect(mocks.pendingMeetingStartRequest).toEqual(request);

    render(<App />);
    await waitFor(() => expect(mocks.startMeetingRecording).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(mocks.acknowledgeMeetingStartRequest).toHaveBeenCalledWith(request.requestId),
    );
    expect(mocks.playRecordingSound).toHaveBeenCalledTimes(1);
  });

  it("hydrates the active recording after reload while acknowledgement is in flight", async () => {
    const first = note();
    const fresh = note({
      id: "note-2",
      title: "Reloaded meeting",
      preview: "",
      generatedContent: undefined,
    });
    const request = {
      requestId: "meeting-request-1",
      noteId: fresh.id,
      requestedAtMs: Date.now(),
      expired: false,
    };
    const outcome = {
      status: "started" as const,
      note: fresh,
      recording: recording({ id: "rec-reloaded", noteId: fresh.id }),
    };
    const activeRecording = {
      sessionId: outcome.recording.id,
      noteId: fresh.id,
      sourceMode: "microphonePlusSystem" as const,
      state: "recording" as const,
      elapsedMs: 2_000,
      level: { peak: 0.2, rms: 0.1, recentPeaks: [0.2] },
      silenceWarning: false,
      bytesWritten: 2_048,
    };
    const firstStart = deferred<typeof outcome>();
    const acknowledgement = deferred<boolean>();
    mocks.pendingMeetingStartRequest = request;
    mocks.getNote.mockImplementation(async (noteId: string) =>
      noteId === fresh.id ? fresh : first,
    );
    mocks.startMeetingRecording.mockReturnValue(firstStart.promise);
    mocks.acknowledgeMeetingStartRequest.mockImplementationOnce(async (requestId: string) => {
      expect(requestId).toBe(request.requestId);
      mocks.pendingMeetingStartRequest = undefined;
      return acknowledgement.promise;
    });

    const firstView = render(<App />);
    await waitFor(() => expect(mocks.startMeetingRecording).toHaveBeenCalledOnce());
    await act(async () => {
      firstStart.resolve(outcome);
      await firstStart.promise;
    });
    await waitFor(() => expect(mocks.acknowledgeMeetingStartRequest).toHaveBeenCalledOnce());
    expect(mocks.pendingMeetingStartRequest).toBeUndefined();
    firstView.unmount();
    await act(async () => {
      acknowledgement.resolve(true);
      await acknowledgement.promise;
    });
    mocks.bootstrapApp.mockResolvedValue({
      folders: [],
      notes: [first, fresh],
      activeRecoveries: [],
      activeRecording,
      providerConfigured: true,
    });

    render(<App />);

    const openRecording = await screen.findByRole("button", {
      name: "Open recording: Reloaded meeting",
    });
    await userEvent.click(openRecording);
    expect(await screen.findByLabelText("Note title")).toHaveValue("Reloaded meeting");
    expect(screen.getByRole("button", { name: "Pause" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Done" })).toBeEnabled();
    expect(mocks.acknowledgeMeetingStartRequest).toHaveBeenCalledOnce();
    expect(mocks.startMeetingRecording).toHaveBeenCalledOnce();
  });

  it("retains a meeting request while a competing start is provisional and retries after failure", async () => {
    const pendingReadiness = deferred<{
      sourceMode: "microphonePlusSystem";
      sources: Array<
        | { source: "microphone"; ready: false; message: string }
        | { source: "system"; ready: true; permissionState: "granted" }
      >;
    }>();
    const fresh = note({ id: "meeting-note", title: "Detected meeting" });
    mocks.startMeetingRecording.mockResolvedValue({
      status: "started",
      note: fresh,
      recording: recording({ noteId: fresh.id }),
    });

    render(<App />);
    await waitFor(() => expect(mocks.getNote).toHaveBeenCalledWith("note-1"));
    await userEvent.click(await screen.findByRole("button", { name: "Meeting notes" }));
    await userEvent.click(screen.getByRole("button", { name: "First note Preview" }));
    const recordButton = await screen.findByRole("button", { name: "Record" });
    await waitFor(() => expect(recordButton).toBeEnabled());
    mocks.checkRecordingSourceReadiness.mockReturnValueOnce(pendingReadiness.promise);
    await userEvent.click(recordButton);
    expect(await screen.findByRole("button", { name: "Starting" })).toBeDisabled();

    mocks.pendingMeetingStartRequest = {
      requestId: "meeting-request-during-provisional-start",
      noteId: fresh.id,
      requestedAtMs: Date.now(),
      expired: false,
    };
    await act(async () => {
      await mocks.listeners.get(MEETING_START_TRANSCRIPTION_EVENT)?.({ payload: undefined });
    });

    expect(mocks.startMeetingRecording).not.toHaveBeenCalled();
    expect(mocks.acknowledgeMeetingStartRequest).not.toHaveBeenCalled();

    await act(async () => {
      pendingReadiness.resolve({
        sourceMode: "microphonePlusSystem",
        sources: [
          { source: "microphone", ready: false, message: "Microphone is not ready." },
          { source: "system", ready: true, permissionState: "granted" },
        ],
      });
      await pendingReadiness.promise;
    });

    expect(await screen.findByText("Microphone is not ready.")).toBeInTheDocument();
    await waitFor(
      () =>
        expect(mocks.startMeetingRecording).toHaveBeenCalledWith(
          "meeting-request-during-provisional-start",
          "microphonePlusSystem",
        ),
      { timeout: 2_000 },
    );
    await waitFor(() =>
      expect(mocks.acknowledgeMeetingStartRequest).toHaveBeenCalledWith(
        "meeting-request-during-provisional-start",
      ),
    );
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
    mocks.pendingMeetingStartRequest = undefined;
    installDefaultListenMock();

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
