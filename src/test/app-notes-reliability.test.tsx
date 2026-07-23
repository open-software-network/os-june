import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../app/App";
import {
  resetActiveHermesProfileForTests,
  setActiveHermesProfileName,
} from "../lib/active-hermes-profile";
import { MEETING_START_TRANSCRIPTION_EVENT } from "../lib/events";
import {
  beginMaxGrantWait,
  clearMaxGrantWait,
  currentMaxGrantWait,
  markMaxGrantWaitSlow,
} from "../lib/max-upgrade";
import type {
  AccountStatus,
  BootstrapResponse,
  NoteDto,
  RecoverableRecordingDto,
  RecordingSessionDto,
} from "../lib/tauri";

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
  listFolders: vi.fn(),
  listHermesSessions: vi.fn(),
  getNote: vi.fn(),
  deleteNote: vi.fn(),
  deleteNotes: vi.fn(),
  downloadNoteAudio: vi.fn(),
  revealPath: vi.fn(),
  updateNote: vi.fn(),
  patchNote: vi.fn(),
  completeNoteSaveFlush: vi.fn(async () => true),
  checkRecordingSourceReadiness: vi.fn(),
  openPrivacySettings: vi.fn(),
  startRecording: vi.fn(),
  startMeetingRecording: vi.fn(),
  pauseRecording: vi.fn(),
  resumeRecording: vi.fn(),
  getRecordingStatus: vi.fn(),
  setRecordingPresenceBounds: vi.fn(),
  finishRecording: vi.fn(),
  retryProcessing: vi.fn(),
  recoverRecording: vi.fn(),
  dictationHelperCommand: vi.fn(),
  dictationSettings: vi.fn(),
  listDictationHistory: vi.fn(),
  listDictionaryEntries: vi.fn(),
  deleteDictationHistoryItem: vi.fn(),
  osAccountsStatus: vi.fn(),
  osAccountsLogin: vi.fn(),
  osAccountsCancelLogin: vi.fn(),
  osAccountsLogout: vi.fn(),
  osAccountsUpgrade: vi.fn(),
  osAccountsUpgradeSession: vi.fn(),
  osAccountsChangePlan: vi.fn(),
  agentHudShow: vi.fn(),
  agentOpenReady: vi.fn().mockResolvedValue(null),
  agentHudHide: vi.fn(),
  playRecordingSound: vi.fn(),
  preloadRecordingSounds: vi.fn(),
  preloadAgentSounds: vi.fn(),
  toast: Object.assign(vi.fn(), {
    dismiss: vi.fn(),
    error: vi.fn(),
    loading: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
  }),
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

vi.mock("../lib/hermes-adapter", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/hermes-adapter")>()),
  listHermesSessions: mocks.listHermesSessions,
}));

vi.mock("../components/ui/Toaster", () => ({
  toast: mocks.toast,
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
  NOTE_CALENDAR_CONTEXT_UPDATED_EVENT: "june://note-calendar-context-updated",
  NOTE_SAVE_FLUSH_REQUESTED_EVENT: "june://flush-pending-note-saves",
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
  listFolders: mocks.listFolders,
  getNote: mocks.getNote,
  deleteNote: mocks.deleteNote,
  deleteNotes: mocks.deleteNotes,
  downloadNoteAudio: mocks.downloadNoteAudio,
  revealPath: mocks.revealPath,
  updateNote: mocks.updateNote,
  patchNote: mocks.patchNote,
  completeNoteSaveFlush: mocks.completeNoteSaveFlush,
  checkRecordingSourceReadiness: mocks.checkRecordingSourceReadiness,
  openPrivacySettings: mocks.openPrivacySettings,
  startRecording: mocks.startRecording,
  pauseRecording: mocks.pauseRecording,
  resumeRecording: mocks.resumeRecording,
  getRecordingStatus: mocks.getRecordingStatus,
  setRecordingPresenceBounds: mocks.setRecordingPresenceBounds,
  finishRecording: mocks.finishRecording,
  retryProcessing: mocks.retryProcessing,
  recoverRecording: mocks.recoverRecording,
  dictationHelperCommand: mocks.dictationHelperCommand,
  dictationSettings: mocks.dictationSettings,
  listDictationHistory: mocks.listDictationHistory,
  listDictionaryEntries: mocks.listDictionaryEntries,
  deleteDictationHistoryItem: mocks.deleteDictationHistoryItem,
  osAccountsStatus: mocks.osAccountsStatus,
  osAccountsStatusLocal: mocks.osAccountsStatus,
  osAccountsLogin: mocks.osAccountsLogin,
  osAccountsCancelLogin: mocks.osAccountsCancelLogin,
  osAccountsLogout: mocks.osAccountsLogout,
  osAccountsUpgrade: mocks.osAccountsUpgrade,
  osAccountsUpgradeSession: mocks.osAccountsUpgradeSession,
  osAccountsChangePlan: mocks.osAccountsChangePlan,
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

function recovery(overrides: Partial<RecoverableRecordingDto> = {}): RecoverableRecordingDto {
  return {
    sessionId: "rec-1",
    noteId: "note-1",
    sourceMode: "microphonePlusSystem",
    startedAt: now,
    partialPathPresent: true,
    finalPathPresent: true,
    bytesFound: 2048,
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

function stubNoteDetailScroller(initialScrollTop: number) {
  const element = document.querySelector<HTMLElement>(".note-detail-scroll");
  if (!element) throw new Error("Expected the note detail scroller to be mounted");
  let scrollTop = initialScrollTop;
  Object.defineProperties(element, {
    scrollHeight: { configurable: true, get: () => 1000 },
    clientHeight: { configurable: true, get: () => 400 },
    scrollTop: {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = value;
      },
    },
  });
  const scrollTo = vi.fn(({ top }: ScrollToOptions) => {
    scrollTop = Math.min(Number(top), 600);
    element.dispatchEvent(new Event("scroll"));
  });
  Object.defineProperty(element, "scrollTo", { configurable: true, value: scrollTo });
  return {
    element,
    scrollTo,
    setScrollTop(value: number) {
      scrollTop = value;
    },
  };
}

describe("notes recording reliability", () => {
  const first = note();
  // Draft on purpose: drafts were the worst case for the wrong-note
  // optimistic update — a falsely stamped "transcribing" draft locks its
  // record button and shimmers forever.
  const second = note({
    id: "note-2",
    title: "Second note",
    processingStatus: "draft",
    generatedContent: undefined,
  });

  beforeEach(() => {
    clearMaxGrantWait();
    vi.clearAllMocks();
    mocks.listeners.clear();
    mocks.pendingMeetingStartRequest = undefined;
    mocks.readPendingMeetingStartRequest.mockImplementation(
      async () => mocks.pendingMeetingStartRequest ?? null,
    );
    mocks.acknowledgeMeetingStartRequest.mockImplementation(async (requestId: string) => {
      if (mocks.pendingMeetingStartRequest?.requestId !== requestId) return false;
      mocks.pendingMeetingStartRequest = undefined;
      return true;
    });
    resetActiveHermesProfileForTests();
    mocks.listFolders.mockResolvedValue([]);
    mocks.listHermesSessions.mockResolvedValue([]);

    const payload: BootstrapResponse = {
      folders: [],
      notes: [first, second],
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
    // The meeting-detected start path creates a fresh note to record into; this
    // suite asserts recording lands on note-1, so the fresh note IS note-1.
    mocks.createNote.mockResolvedValue(first);
    mocks.deleteNote.mockResolvedValue(undefined);
    mocks.deleteNotes.mockResolvedValue(undefined);
    mocks.downloadNoteAudio.mockResolvedValue({
      path: "/Users/alex/Downloads/First note audio.wav",
      fileName: "First note audio.wav",
      sourceCount: 1,
    });
    mocks.revealPath.mockResolvedValue(undefined);
    mocks.listNotes.mockResolvedValue({ items: [first, second] });
    mocks.getNote.mockImplementation(async (noteId: string) =>
      noteId === "note-2" ? second : first,
    );
    mocks.checkRecordingSourceReadiness.mockResolvedValue({
      sourceMode: "microphonePlusSystem",
      sources: [
        { source: "microphone", ready: true },
        { source: "system", ready: true, permissionState: "granted" },
      ],
    });
    mocks.startRecording.mockResolvedValue(recording());
    mocks.startMeetingRecording.mockResolvedValue({
      status: "started",
      note: first,
      recording: recording(),
    });
    mocks.getRecordingStatus.mockResolvedValue({
      sessionId: "rec-1",
      state: "recording",
      elapsedMs: 500,
      level: { peak: 0.2, rms: 0.1, recentPeaks: [0.2] },
      silenceWarning: false,
      bytesWritten: 2048,
    });
    mocks.dictationHelperCommand.mockResolvedValue(undefined);
    mocks.dictationSettings.mockResolvedValue({
      settings: {
        pushToTalkShortcut: {
          code: "KeyD",
          label: "Ctrl+Opt+D",
          pressCount: 1,
          modifiers: {
            command: false,
            control: true,
            option: true,
            shift: false,
            function: false,
          },
        },
        toggleShortcut: {
          code: "KeyT",
          label: "Ctrl+Opt+T",
          pressCount: 1,
          modifiers: {
            command: false,
            control: true,
            option: true,
            shift: false,
            function: false,
          },
        },
        microphone: {},
        style: "standard",
      },
    });
    mocks.listDictationHistory.mockResolvedValue({
      items: [],
      retentionDays: 7,
    });
    mocks.listDictionaryEntries.mockResolvedValue([]);
    mocks.deleteDictationHistoryItem.mockResolvedValue(undefined);
    mocks.osAccountsStatus.mockResolvedValue(account);
    mocks.osAccountsLogin.mockResolvedValue(account);
    mocks.osAccountsLogout.mockResolvedValue(undefined);
    mocks.osAccountsCancelLogin.mockResolvedValue(undefined);
    mocks.osAccountsUpgrade.mockResolvedValue(undefined);
    mocks.osAccountsUpgradeSession.mockResolvedValue(undefined);
    mocks.osAccountsChangePlan.mockResolvedValue({
      subscribed: true,
      status: "active",
      plan: "max",
    });
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
      updatedAt: now,
    }));
  });

  async function startRecordingOnFirstNote() {
    render(<App />);
    await waitFor(() => expect(mocks.listeners.has(MEETING_START_TRANSCRIPTION_EVENT)).toBe(true));
    await waitFor(() => expect(mocks.getNote).toHaveBeenCalledWith("note-1"));
    mocks.pendingMeetingStartRequest = {
      requestId: "meeting-request-1",
      noteId: "note-1",
      requestedAtMs: Date.now(),
      expired: false,
    };
    await act(async () => {
      await mocks.listeners.get(MEETING_START_TRANSCRIPTION_EVENT)?.({
        payload: undefined,
      });
    });
    await waitFor(() =>
      expect(mocks.startMeetingRecording).toHaveBeenCalledWith(
        "meeting-request-1",
        "microphonePlusSystem",
      ),
    );
  }

  async function startRecordingDirectlyOnFirstNote() {
    render(<App />);
    await waitFor(() => expect(mocks.getNote).toHaveBeenCalledWith("note-1"));
    await userEvent.click(await screen.findByRole("button", { name: "Meeting notes" }));
    await userEvent.click(screen.getByRole("button", { name: "First note Preview" }));
    await userEvent.click(screen.getByRole("button", { name: "Record" }));
    await waitFor(() =>
      expect(mocks.startRecording).toHaveBeenCalledWith("note-1", "microphonePlusSystem"),
    );
  }

  it("swaps notes to the new profile's list when the active profile switches", async () => {
    render(<App />);
    await waitFor(() => expect(mocks.getNote).toHaveBeenCalledWith("note-1"));

    const workNote = note({ id: "note-work", title: "Work profile note" });
    mocks.listNotes.mockResolvedValue({ items: [workNote] });
    mocks.getNote.mockResolvedValue(workNote);
    const listCallsBefore = mocks.listNotes.mock.calls.length;

    await act(async () => {
      setActiveHermesProfileName("work");
    });

    await waitFor(() => expect(mocks.listNotes.mock.calls.length).toBeGreaterThan(listCallsBefore));
    await userEvent.click(await screen.findByRole("button", { name: "Meeting notes" }));
    expect(await screen.findByText("Work profile note")).toBeInTheDocument();
    expect(screen.queryByText("First note")).toBeNull();
  });

  it("shows calendar context as soon as the backend matches the open note", async () => {
    await startRecordingOnFirstNote();
    await userEvent.click(await screen.findByRole("button", { name: "Meeting notes" }));
    await userEvent.click(await screen.findByRole("button", { name: /First note Preview/ }));
    expect(await screen.findByDisplayValue("First note")).toBeInTheDocument();
    await waitFor(() =>
      expect(mocks.listeners.has("june://note-calendar-context-updated")).toBe(true),
    );

    await act(async () => {
      await mocks.listeners.get("june://note-calendar-context-updated")?.({
        payload: {
          ...first,
          title: "Product review",
          calendarEvent: {
            eventId: "event-1",
            title: "Product review",
            startAt: "2026-07-20T14:00:00Z",
            endAt: "2026-07-20T14:30:00Z",
            accountEmail: "june@example.com",
          },
        },
      });
    });

    expect(await screen.findByText("Google Calendar")).toBeInTheDocument();
    expect(screen.getByText("june@example.com")).toBeInTheDocument();
  });

  it("flushes pending note edits and acknowledges the native app-quit barrier", async () => {
    render(<App />);
    await waitFor(() => expect(mocks.getNote).toHaveBeenCalledWith("note-1"));
    await userEvent.click(await screen.findByRole("button", { name: "Meeting notes" }));
    await userEvent.click(screen.getByRole("button", { name: /First note Preview/ }));
    const title = await screen.findByDisplayValue("First note");
    mocks.patchNote.mockClear();

    await userEvent.type(title, " unsaved");
    await act(async () => {
      await mocks.listeners.get("june://flush-pending-note-saves")?.({
        payload: { requestId: "flush-1" },
      });
    });

    expect(mocks.patchNote).toHaveBeenCalledWith("note-1", {
      title: "First note unsaved",
    });
    expect(mocks.completeNoteSaveFlush).toHaveBeenCalledWith("flush-1");
  });

  it("does not acknowledge app quit when pending note persistence fails", async () => {
    mocks.patchNote.mockRejectedValue(new Error("database busy"));
    render(<App />);
    await waitFor(() => expect(mocks.getNote).toHaveBeenCalledWith("note-1"));
    await userEvent.click(await screen.findByRole("button", { name: "Meeting notes" }));
    await userEvent.click(screen.getByRole("button", { name: /First note Preview/ }));
    const title = await screen.findByDisplayValue("First note");
    mocks.completeNoteSaveFlush.mockClear();

    await userEvent.type(title, " unsaved");
    await act(async () => {
      await mocks.listeners.get("june://flush-pending-note-saves")?.({
        payload: { requestId: "flush-failed" },
      });
    });

    expect(mocks.completeNoteSaveFlush).not.toHaveBeenCalled();
    expect(await screen.findByText("database busy")).toBeInTheDocument();
  });

  it("ignores calendar context without profile provenance after a renderer reload", async () => {
    render(<App />);
    await waitFor(() => expect(mocks.getNote).toHaveBeenCalledWith("note-1"));
    await waitFor(() =>
      expect(mocks.listeners.has("june://note-calendar-context-updated")).toBe(true),
    );

    await act(async () => {
      await mocks.listeners.get("june://note-calendar-context-updated")?.({
        payload: {
          ...first,
          title: "Stale calendar note",
          calendarEvent: {
            eventId: "event-stale",
            title: "Stale calendar note",
            startAt: "2026-07-20T14:00:00Z",
            endAt: "2026-07-20T14:30:00Z",
            accountEmail: "unknown-profile@example.com",
          },
        },
      });
    });

    await userEvent.click(await screen.findByRole("button", { name: "Meeting notes" }));
    expect(screen.queryByText("Stale calendar note")).toBeNull();
    expect(screen.queryByText("unknown-profile@example.com")).toBeNull();
    expect(await screen.findByText("First note")).toBeInTheDocument();
  });

  it("retires an old-profile recording note as soon as the recording stops", async () => {
    const workNote = note({ id: "note-work", title: "Work profile note" });
    mocks.finishRecording.mockResolvedValue({
      note: { ...first, processingStatus: "transcribing" },
      recording: recording({ state: "ready" }),
      validation: {},
      processingStarted: true,
    });

    await startRecordingOnFirstNote();

    mocks.listNotes.mockResolvedValue({ items: [workNote] });
    mocks.getNote.mockImplementation(async (noteId: string) =>
      noteId === workNote.id ? workNote : first,
    );
    const listCallsBeforeSwitch = mocks.listNotes.mock.calls.length;
    await act(async () => {
      setActiveHermesProfileName("work");
    });

    await waitFor(() =>
      expect(mocks.listNotes.mock.calls.length).toBeGreaterThan(listCallsBeforeSwitch),
    );
    await waitFor(() => expect(mocks.getNote).toHaveBeenCalledWith(first.id));
    const listCallsBeforeFinish = mocks.listNotes.mock.calls.length;
    await userEvent.click(await screen.findByRole("button", { name: "Done" }));
    await waitFor(() => expect(mocks.finishRecording).toHaveBeenCalledWith("rec-1"));
    await waitFor(() =>
      expect(mocks.listNotes.mock.calls.length).toBeGreaterThan(listCallsBeforeFinish),
    );

    const notesTab = await screen.findByRole("tab", { name: "Notes" });
    expect(notesTab).toHaveAttribute("data-active", "true");
    await userEvent.click(screen.getByRole("button", { name: "Meeting notes" }));
    expect(await screen.findByText("Work profile note")).toBeInTheDocument();
    expect(screen.queryByText("First note")).toBeNull();

    await act(async () => {
      await mocks.listeners.get("june://note-calendar-context-updated")?.({
        payload: {
          ...first,
          title: "Old profile calendar note",
          calendarEvent: {
            eventId: "event-old-profile",
            title: "Old profile calendar note",
            startAt: "2026-07-20T14:00:00Z",
            endAt: "2026-07-20T14:30:00Z",
            accountEmail: "personal@example.com",
          },
        },
      });
    });

    expect(screen.queryByText("Old profile calendar note")).toBeNull();
    expect(screen.queryByText("First note")).toBeNull();
  });

  it("hides audio download when the selected note has no finalized audio", async () => {
    render(<App />);
    await waitFor(() => expect(mocks.getNote).toHaveBeenCalledWith("note-1"));
    await userEvent.click(await screen.findByRole("button", { name: "Meeting notes" }));
    await userEvent.click(screen.getByRole("button", { name: /First note Preview/ }));

    await userEvent.click(screen.getByRole("button", { name: "Note actions" }));

    expect(screen.queryByRole("menuitem", { name: "Download audio" })).not.toBeInTheDocument();
  });

  it.each([
    { format: "wav", sizeBytes: 0, label: "an empty WAV" },
    { format: "mp3", sizeBytes: 2048, label: "a non-WAV artifact" },
  ])("hides audio download for $label", async ({ format, sizeBytes }) => {
    const noteWithoutDownloadableAudio = note({
      audioSources: [
        {
          id: "audio-1",
          source: "microphone",
          format,
          durationMs: 1000,
          sizeBytes,
          checksum: "abc",
          createdAt: now,
        },
      ],
    });
    mocks.bootstrapApp.mockResolvedValue({
      folders: [],
      notes: [noteWithoutDownloadableAudio, second],
      activeRecoveries: [],
      providerConfigured: true,
    });
    mocks.getNote.mockImplementation(async (noteId: string) =>
      noteId === "note-2" ? second : noteWithoutDownloadableAudio,
    );

    render(<App />);
    await waitFor(() => expect(mocks.getNote).toHaveBeenCalledWith("note-1"));
    await userEvent.click(await screen.findByRole("button", { name: "Meeting notes" }));
    await userEvent.click(screen.getByRole("button", { name: /First note Preview/ }));
    await userEvent.click(screen.getByRole("button", { name: "Note actions" }));

    expect(screen.queryByRole("menuitem", { name: "Download audio" })).not.toBeInTheDocument();
  });

  it("downloads selected note audio and reveals the saved file from the success toast", async () => {
    const noteWithAudio = note({
      audioSources: [
        {
          id: "audio-1",
          source: "microphone",
          format: "wav",
          durationMs: 1000,
          sizeBytes: 2048,
          checksum: "abc",
          createdAt: now,
        },
      ],
    });
    mocks.bootstrapApp.mockResolvedValue({
      folders: [],
      notes: [noteWithAudio, second],
      activeRecoveries: [],
      providerConfigured: true,
    });
    mocks.getNote.mockImplementation(async (noteId: string) =>
      noteId === "note-2" ? second : noteWithAudio,
    );

    render(<App />);
    await waitFor(() => expect(mocks.getNote).toHaveBeenCalledWith("note-1"));
    await userEvent.click(await screen.findByRole("button", { name: "Meeting notes" }));
    await userEvent.click(screen.getByRole("button", { name: /First note Preview/ }));
    await userEvent.click(screen.getByRole("button", { name: "Note actions" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Download audio" }));

    await waitFor(() => expect(mocks.downloadNoteAudio).toHaveBeenCalledWith("note-1"));
    expect(mocks.toast.success).toHaveBeenCalledWith("Audio downloaded", {
      action: {
        label: "Show file",
        onClick: expect.any(Function),
      },
    });

    const toastOptions = mocks.toast.success.mock.calls[0]?.[1] as {
      action: { onClick: () => void };
    };
    toastOptions.action.onClick();

    await waitFor(() =>
      expect(mocks.revealPath).toHaveBeenCalledWith("/Users/alex/Downloads/First note audio.wav"),
    );
  });

  it("shows download and reveal failures as error toasts", async () => {
    const noteWithAudio = note({
      audio: {
        id: "audio-1",
        source: "microphone",
        format: "wav",
        durationMs: 1000,
        sizeBytes: 2048,
        checksum: "abc",
        createdAt: now,
      },
    });
    mocks.bootstrapApp.mockResolvedValue({
      folders: [],
      notes: [noteWithAudio, second],
      activeRecoveries: [],
      providerConfigured: true,
    });
    mocks.getNote.mockImplementation(async (noteId: string) =>
      noteId === "note-2" ? second : noteWithAudio,
    );
    mocks.downloadNoteAudio.mockRejectedValueOnce(new Error("Audio download failed"));

    render(<App />);
    await waitFor(() => expect(mocks.getNote).toHaveBeenCalledWith("note-1"));
    await userEvent.click(await screen.findByRole("button", { name: "Meeting notes" }));
    await userEvent.click(screen.getByRole("button", { name: /First note Preview/ }));
    await userEvent.click(screen.getByRole("button", { name: "Note actions" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Download audio" }));

    await waitFor(() => expect(mocks.toast.error).toHaveBeenCalledWith("Audio download failed"));

    mocks.toast.error.mockClear();
    mocks.downloadNoteAudio.mockResolvedValueOnce({
      path: "/Users/alex/Downloads/First note audio.wav",
      fileName: "First note audio.wav",
      sourceCount: 1,
    });
    mocks.revealPath.mockRejectedValueOnce(new Error("Could not show file"));
    await userEvent.click(screen.getByRole("button", { name: "Note actions" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Download audio" }));
    await waitFor(() => expect(mocks.toast.success).toHaveBeenCalled());

    const latestToastOptions = mocks.toast.success.mock.calls.at(-1)?.[1] as {
      action: { onClick: () => void };
    };
    latestToastOptions.action.onClick();

    await waitFor(() => expect(mocks.toast.error).toHaveBeenCalledWith("Could not show file"));
  });

  it("stays on notes after deleting the last note", async () => {
    mocks.bootstrapApp.mockResolvedValue({
      folders: [],
      notes: [first],
      activeRecoveries: [],
      providerConfigured: true,
    });
    mocks.listNotes.mockResolvedValue({ items: [] });

    render(<App />);
    await waitFor(() => expect(mocks.getNote).toHaveBeenCalledWith("note-1"));

    await userEvent.click(await screen.findByRole("button", { name: "Meeting notes" }));
    await userEvent.click(screen.getByRole("button", { name: "Actions for First note" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Delete note" }));
    await userEvent.click(screen.getByRole("button", { name: "Delete note" }));

    await waitFor(() => expect(mocks.deleteNote).toHaveBeenCalledWith("note-1"));
    expect(
      screen.getByRole("button", { name: "Meeting notes", current: "page" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Capture your first meeting" })).toBeInTheDocument();
  });

  it("stays on notes after bulk deleting every note", async () => {
    mocks.listNotes.mockResolvedValue({ items: [] });

    render(<App />);
    await waitFor(() => expect(mocks.getNote).toHaveBeenCalledWith("note-1"));

    await userEvent.click(await screen.findByRole("button", { name: "Meeting notes" }));
    await userEvent.click(screen.getByRole("checkbox", { name: "Select First note" }));
    await userEvent.click(screen.getByRole("checkbox", { name: "Select Second note" }));
    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    await userEvent.click(screen.getByRole("button", { name: "Delete notes" }));

    await waitFor(() => expect(mocks.deleteNotes).toHaveBeenCalledWith(["note-1", "note-2"]));
    expect(
      screen.getByRole("button", { name: "Meeting notes", current: "page" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Capture your first meeting" })).toBeInTheDocument();
  });

  it("does not mark a different note transcribing when finishing a recording started elsewhere", async () => {
    mocks.finishRecording.mockResolvedValue({
      note: { ...first, processingStatus: "transcribing" },
      recording: recording({ state: "ready" }),
      validation: {},
      processingStarted: true,
    });

    await startRecordingOnFirstNote();

    // Browse to another note while the recording keeps running on note-1.
    await userEvent.click(screen.getByRole("button", { name: "Meeting notes", current: "page" }));
    await userEvent.click(screen.getByRole("button", { name: /Second note Preview/ }));
    await waitFor(() => expect(mocks.getNote).toHaveBeenCalledWith("note-2"));

    // Off the recording's note, the sidebar indicator stands in for the
    // in-note bar. Click it back to note-1, where Done lives.
    const indicator = await screen.findByRole("button", {
      name: "Open recording: First note",
    });
    await userEvent.click(indicator);
    await waitFor(() => expect(mocks.getNote).toHaveBeenCalledWith("note-1"));
    await userEvent.click(await screen.findByRole("button", { name: "Done" }));
    await waitFor(() => expect(mocks.finishRecording).toHaveBeenCalledWith("rec-1"));

    // note-2 must not pick up note-1's optimistic "transcribing" lock.
    mocks.getNote.mockClear();
    await userEvent.click(screen.getByRole("button", { name: "Meeting notes", current: "page" }));
    await userEvent.click(screen.getByRole("button", { name: /Second note Preview/ }));
    await waitFor(() => expect(mocks.getNote).toHaveBeenCalledWith("note-2"));
    expect(screen.queryByText(/Transcribing audio/)).not.toBeInTheDocument();
  });

  it("keeps provisional transcript visible after Stop while saved-audio processing is pending", async () => {
    const pendingFinish = deferred<never>();
    mocks.finishRecording.mockReturnValue(pendingFinish.promise);

    await startRecordingOnFirstNote();
    await waitFor(() => expect(mocks.listeners.has("live-transcript-event")).toBe(true));
    await act(async () => {
      await mocks.listeners.get("live-transcript-event")?.({
        payload: {
          noteId: "note-1",
          sessionId: "rec-1",
          sourceMode: "microphonePlusSystem",
          source: "microphone",
          segmentId: "microphone-0",
          startMs: 0,
          endMs: 4000,
          text: "Provisional words survive Stop",
          stability: "final",
        },
      });
    });

    await userEvent.click(screen.getByRole("button", { name: "Transcription" }));
    expect(await screen.findByText("Provisional words survive Stop")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() => expect(mocks.finishRecording).toHaveBeenCalledWith("rec-1"));
    expect(screen.getByText("Provisional words survive Stop")).toBeInTheDocument();
  });

  it("follows live transcription until the reader scrolls upward, then resumes at the bottom", async () => {
    await startRecordingOnFirstNote();
    await waitFor(() => expect(mocks.listeners.has("live-transcript-event")).toBe(true));
    const scroller = stubNoteDetailScroller(100);

    await userEvent.click(screen.getByRole("button", { name: "Transcription" }));
    await waitFor(() =>
      expect(scroller.scrollTo).toHaveBeenCalledWith({ top: 1000, behavior: "smooth" }),
    );
    scroller.scrollTo.mockClear();

    const emitPreview = async (segmentId: string, text: string, startMs: number) => {
      await act(async () => {
        await mocks.listeners.get("live-transcript-event")?.({
          payload: {
            noteId: "note-1",
            sessionId: "rec-1",
            sourceMode: "microphonePlusSystem",
            source: "microphone",
            segmentId,
            startMs,
            endMs: startMs + 4000,
            text,
            stability: "final",
          },
        });
      });
    };

    await emitPreview("microphone-0", "First live words", 0);
    await waitFor(() => expect(scroller.scrollTo).toHaveBeenCalledTimes(1));

    scroller.scrollTo.mockClear();
    scroller.setScrollTop(100);
    fireEvent.wheel(scroller.element);
    fireEvent.scroll(scroller.element);
    await emitPreview("microphone-1", "Words while reading above", 4000);
    expect(scroller.scrollTo).not.toHaveBeenCalled();

    scroller.setScrollTop(600);
    fireEvent.scroll(scroller.element);
    await emitPreview("microphone-2", "Following resumes", 8000);
    await waitFor(() => expect(scroller.scrollTo).toHaveBeenCalledTimes(1));
  });

  it("does not clear a newer preview when the note still has queued recordings", async () => {
    mocks.finishRecording.mockResolvedValue({
      note: { ...first, activeTab: "transcription", queuedRecordings: 1 },
      recording: recording({ state: "ready" }),
      validation: {},
      processingStarted: true,
    });

    await startRecordingOnFirstNote();
    await waitFor(() => expect(mocks.listeners.has("live-transcript-event")).toBe(true));
    await act(async () => {
      await mocks.listeners.get("live-transcript-event")?.({
        payload: {
          noteId: "note-1",
          sessionId: "rec-1",
          sourceMode: "microphonePlusSystem",
          source: "microphone",
          segmentId: "microphone-queued",
          startMs: 0,
          endMs: 4000,
          text: "Queued session preview remains",
          stability: "final",
        },
      });
    });

    await userEvent.click(screen.getByRole("button", { name: "Transcription" }));
    await userEvent.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() => expect(mocks.finishRecording).toHaveBeenCalledWith("rec-1"));
    expect(await screen.findByText("Queued session preview remains")).toBeInTheDocument();
  });

  it("shows a sidebar recorder indicator off the recording's note and reopens it on click", async () => {
    await startRecordingOnFirstNote();

    // Browse away from the recording note while the take keeps running.
    await userEvent.click(screen.getByRole("button", { name: "Meeting notes", current: "page" }));
    await userEvent.click(screen.getByRole("button", { name: /Second note Preview/ }));
    await waitFor(() => expect(mocks.getNote).toHaveBeenCalledWith("note-2"));

    // The sidebar indicator stands in for the in-note bar, titled after note-1.
    const indicator = await screen.findByRole("button", {
      name: "Open recording: First note",
    });

    mocks.getNote.mockClear();
    await userEvent.click(indicator);

    // Clicking it jumps back to the recording's note, where it yields to the
    // in-note recorder bar.
    await waitFor(() => expect(mocks.getNote).toHaveBeenCalledWith("note-1"));
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Open recording: First note" }),
      ).not.toBeInTheDocument(),
    );
  });

  it("updates recording status from native telemetry without polling", async () => {
    await startRecordingOnFirstNote();
    await screen.findByRole("button", { name: "Done" });
    await waitFor(() => expect(mocks.listeners.has("recording-telemetry")).toBe(true));
    expect(mocks.getRecordingStatus).not.toHaveBeenCalled();

    await act(async () => {
      await mocks.listeners.get("recording-telemetry")?.({
        payload: {
          sessionId: "rec-1",
          state: "recording",
          elapsedMs: 1500,
          level: { peak: 0.2, rms: 0.1, recentPeaks: [0.2] },
          silenceWarning: false,
          sources: [],
          warnings: [],
        },
      });
    });
    expect(await screen.findByText("00:01")).toBeInTheDocument();
    expect(mocks.getRecordingStatus).not.toHaveBeenCalled();

    await act(async () => {
      await mocks.listeners.get("recording-telemetry")?.({
        payload: {
          sessionId: "rec-1",
          state: "idle",
          elapsedMs: 1500,
          level: { peak: 0, rms: 0, recentPeaks: [] },
          silenceWarning: false,
          sources: [],
          warnings: [],
        },
      });
    });
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Done" })).not.toBeInTheDocument(),
    );
  });

  it("ignores meeting-start signals while a recording is already live", async () => {
    await startRecordingOnFirstNote();

    mocks.createNote.mockClear();
    mocks.startMeetingRecording.mockClear();

    mocks.pendingMeetingStartRequest = {
      requestId: "meeting-request-2",
      noteId: "meeting-note-2",
      requestedAtMs: Date.now(),
      expired: false,
    };
    await act(async () => {
      await mocks.listeners.get(MEETING_START_TRANSCRIPTION_EVENT)?.({
        payload: undefined,
      });
    });

    expect(mocks.createNote).not.toHaveBeenCalled();
    expect(mocks.startMeetingRecording).not.toHaveBeenCalled();
    expect(mocks.acknowledgeMeetingStartRequest).toHaveBeenCalledWith("meeting-request-2");
  });

  it("serializes duplicate meeting events while native startup is pending", async () => {
    const fresh = note({
      id: "fresh-note",
      title: "New note",
      generatedContent: undefined,
      processingStatus: "draft",
    });
    const pendingStart = deferred<{
      status: "started";
      note: NoteDto;
      recording: RecordingSessionDto;
    }>();
    mocks.startMeetingRecording.mockReturnValue(pendingStart.promise);

    render(<App />);
    await waitFor(() => expect(mocks.listeners.has(MEETING_START_TRANSCRIPTION_EVENT)).toBe(true));
    await waitFor(() => expect(mocks.getNote).toHaveBeenCalledWith("note-1"));

    mocks.pendingMeetingStartRequest = {
      requestId: "meeting-request-1",
      noteId: fresh.id,
      requestedAtMs: Date.now(),
      expired: false,
    };
    act(() => {
      void mocks.listeners.get(MEETING_START_TRANSCRIPTION_EVENT)?.({
        payload: undefined,
      });
    });
    await waitFor(() => expect(mocks.startMeetingRecording).toHaveBeenCalledTimes(1));

    act(() => {
      void mocks.listeners.get(MEETING_START_TRANSCRIPTION_EVENT)?.({
        payload: undefined,
      });
    });

    expect(mocks.startMeetingRecording).toHaveBeenCalledTimes(1);

    await act(async () => {
      pendingStart.resolve({
        status: "started",
        note: fresh,
        recording: recording({ noteId: fresh.id }),
      });
      await pendingStart.promise;
    });

    await waitFor(() =>
      expect(mocks.acknowledgeMeetingStartRequest).toHaveBeenCalledWith("meeting-request-1"),
    );
    expect(mocks.startMeetingRecording).toHaveBeenCalledTimes(1);
  });

  it("acknowledges a visible native startup failure", async () => {
    mocks.startMeetingRecording.mockResolvedValue({
      status: "failed",
      error: {
        code: "source_not_ready",
        message: "Microphone is not ready.",
      },
    });

    render(<App />);
    await waitFor(() => expect(mocks.listeners.has(MEETING_START_TRANSCRIPTION_EVENT)).toBe(true));
    await waitFor(() => expect(mocks.getNote).toHaveBeenCalledWith("note-1"));

    mocks.pendingMeetingStartRequest = {
      requestId: "meeting-request-1",
      noteId: "failed-meeting-note",
      requestedAtMs: Date.now(),
      expired: false,
    };
    await act(async () => {
      await mocks.listeners.get(MEETING_START_TRANSCRIPTION_EVENT)?.({
        payload: undefined,
      });
    });
    expect(await screen.findByText("Microphone is not ready.")).toBeInTheDocument();
    expect(mocks.acknowledgeMeetingStartRequest).toHaveBeenCalledWith("meeting-request-1");
  });

  it("releases the start latch after a terminal native failure", async () => {
    const fresh = note({ id: "second-fresh-note", title: "Second fresh note" });
    mocks.startMeetingRecording
      .mockResolvedValueOnce({
        status: "failed",
        error: {
          code: "capture_start_timeout",
          message: "Could not start the microphone. Try again.",
        },
      })
      .mockResolvedValueOnce({
        status: "started",
        note: fresh,
        recording: recording({ noteId: fresh.id }),
      });

    render(<App />);
    await waitFor(() => expect(mocks.listeners.has(MEETING_START_TRANSCRIPTION_EVENT)).toBe(true));
    await waitFor(() => expect(mocks.getNote).toHaveBeenCalledWith("note-1"));

    mocks.pendingMeetingStartRequest = {
      requestId: "meeting-request-1",
      noteId: "failed-meeting-note",
      requestedAtMs: Date.now(),
      expired: false,
    };
    await act(async () => {
      await mocks.listeners.get(MEETING_START_TRANSCRIPTION_EVENT)?.({
        payload: undefined,
      });
    });
    await waitFor(() => expect(mocks.startMeetingRecording).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(mocks.pendingMeetingStartRequest).toBeUndefined());

    mocks.pendingMeetingStartRequest = {
      requestId: "meeting-request-2",
      noteId: fresh.id,
      requestedAtMs: Date.now(),
      expired: false,
    };
    await act(async () => {
      await mocks.listeners.get(MEETING_START_TRANSCRIPTION_EVENT)?.({
        payload: undefined,
      });
    });
    await waitFor(() => expect(mocks.startMeetingRecording).toHaveBeenCalledTimes(2));
  });

  it("retains and retries a request after an IPC failure", async () => {
    mocks.startMeetingRecording
      .mockRejectedValueOnce(new Error("webview IPC was interrupted"))
      .mockResolvedValueOnce({
        status: "failed",
        error: {
          code: "source_not_ready",
          message: "Microphone is not ready.",
        },
      });

    render(<App />);
    await waitFor(() => expect(mocks.listeners.has(MEETING_START_TRANSCRIPTION_EVENT)).toBe(true));
    await waitFor(() => expect(mocks.getNote).toHaveBeenCalledWith("note-1"));

    mocks.pendingMeetingStartRequest = {
      requestId: "meeting-request-1",
      noteId: "failed-meeting-note",
      requestedAtMs: Date.now(),
      expired: false,
    };
    await act(async () => {
      await mocks.listeners.get(MEETING_START_TRANSCRIPTION_EVENT)?.({
        payload: undefined,
      });
    });
    expect(mocks.acknowledgeMeetingStartRequest).not.toHaveBeenCalled();
    await waitFor(() => expect(mocks.startMeetingRecording).toHaveBeenCalledTimes(2), {
      timeout: 2_000,
    });
    await waitFor(() =>
      expect(mocks.acknowledgeMeetingStartRequest).toHaveBeenCalledWith("meeting-request-1"),
    );
  });

  it("clears the recorder presence and disables retry when a recovery is discarded", async () => {
    mocks.bootstrapApp.mockResolvedValue({
      folders: [],
      notes: [first, second],
      activeRecoveries: [recovery()],
      providerConfigured: true,
    });
    mocks.recoverRecording.mockResolvedValue({
      ...first,
      processingStatus: "failed",
      lastError: "Recording discarded",
      audio: undefined,
      audioSources: [],
    });

    await startRecordingOnFirstNote();

    await userEvent.click(screen.getByRole("button", { name: "Meeting notes", current: "page" }));
    await userEvent.click(screen.getByRole("button", { name: /Second note Preview/ }));
    const indicator = await screen.findByRole("button", {
      name: "Open recording: First note",
    });
    await userEvent.click(indicator);
    await waitFor(() => expect(mocks.getNote).toHaveBeenCalledWith("note-1"));

    await userEvent.click(screen.getByRole("button", { name: "Discard" }));

    await waitFor(() => expect(mocks.recoverRecording).toHaveBeenCalledWith("rec-1", "discard"));
    expect(screen.getByText("Recording discarded")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Retry/ })).toBeDisabled();

    await userEvent.click(screen.getByRole("button", { name: "Meeting notes", current: "page" }));
    await userEvent.click(screen.getByRole("button", { name: /Second note Preview/ }));
    expect(
      screen.queryByRole("button", { name: "Open recording: First note" }),
    ).not.toBeInTheDocument();
  });

  it("keeps recovered transcription failures scoped to the failed note", async () => {
    const failedNote = {
      ...first,
      processingStatus: "failed" as const,
      lastError: "Microphone: upstream_provider_failed",
      audioSources: [
        {
          id: "audio-1",
          source: "microphone" as const,
          format: "wav" as const,
          durationMs: 1000,
          sizeBytes: 2048,
          checksum: "abc",
          createdAt: now,
        },
      ],
    };
    let recoveryFailed = false;
    mocks.bootstrapApp.mockResolvedValue({
      folders: [],
      notes: [first, second],
      activeRecoveries: [recovery()],
      providerConfigured: true,
    });
    mocks.getNote.mockImplementation(async (noteId: string) => {
      if (noteId === "note-2") return second;
      return recoveryFailed ? failedNote : first;
    });
    mocks.recoverRecording.mockImplementation(async () => {
      recoveryFailed = true;
      throw {
        code: "transcription_failed",
        message: "Microphone: The transcription provider could not process this audio.",
      };
    });

    const { container } = render(<App />);
    await waitFor(() => expect(mocks.getNote).toHaveBeenCalledWith("note-1"));
    await userEvent.click(await screen.findByRole("button", { name: "Meeting notes" }));
    await userEvent.click(screen.getByRole("button", { name: /First note Preview/ }));

    await userEvent.click(screen.getByRole("button", { name: "Recover" }));

    await waitFor(() => expect(mocks.recoverRecording).toHaveBeenCalledWith("rec-1", "validate"));
    await waitFor(() =>
      expect(
        screen.getByText(/Microphone: The transcription provider could not process this audio\./),
      ).toBeInTheDocument(),
    );
    expect(container.querySelector(".note-failure-banner")).not.toBeNull();
    expect(container.querySelector(".error-banner")).toBeNull();
    expect(screen.queryByLabelText("Recoverable recording")).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Dictation" }));
    expect(container.querySelector(".note-failure-banner")).toBeNull();
    expect(container.querySelector(".error-banner")).toBeNull();
  });

  it("clears the active recorder when a recovered transcription failure is scoped", async () => {
    const failedNote = {
      ...first,
      processingStatus: "failed" as const,
      lastError: "Microphone: upstream_provider_failed",
      audioSources: [
        {
          id: "audio-1",
          source: "microphone" as const,
          format: "wav" as const,
          durationMs: 1000,
          sizeBytes: 2048,
          checksum: "abc",
          createdAt: now,
        },
      ],
    };
    let recoveryFailed = false;
    mocks.bootstrapApp.mockResolvedValue({
      folders: [],
      notes: [first, second],
      activeRecoveries: [recovery()],
      providerConfigured: true,
    });
    mocks.getNote.mockImplementation(async (noteId: string) => {
      if (noteId === "note-2") return second;
      return recoveryFailed ? failedNote : first;
    });
    mocks.recoverRecording.mockImplementation(async () => {
      recoveryFailed = true;
      throw {
        code: "transcription_failed",
        message: "Microphone: The transcription provider could not process this audio.",
      };
    });

    await startRecordingOnFirstNote();
    expect(await screen.findByRole("button", { name: "Done" })).toBeEnabled();

    await userEvent.click(screen.getByRole("button", { name: "Recover" }));

    await waitFor(() =>
      expect(
        screen.getByText(/Microphone: The transcription provider could not process this audio\./),
      ).toBeInTheDocument(),
    );
    expect(screen.queryByRole("button", { name: "Done" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Open recording: First note" })).toBeNull();
  });

  it("applies the finish result even when the note already sat in a terminal status", async () => {
    mocks.finishRecording.mockResolvedValue({
      note: { ...first, processingStatus: "transcribing" },
      recording: recording({ state: "ready" }),
      validation: {},
      processingStarted: true,
    });

    await startRecordingOnFirstNote();

    // note-1 is "ready" (terminal); stacking another take must still flip it
    // back to transcribing so the shimmer shows and polling resumes.
    await userEvent.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() => expect(mocks.finishRecording).toHaveBeenCalledWith("rec-1"));

    await waitFor(() => expect(screen.getByText(/Transcribing audio/)).toBeInTheDocument());
  });

  it("clears a stale failure when Stop optimistically starts transcription", async () => {
    const failedNote = {
      ...first,
      processingStatus: "failed" as const,
      lastError: "Microphone: upstream_provider_failed",
    };
    mocks.bootstrapApp.mockResolvedValue({
      folders: [],
      notes: [failedNote, second],
      activeRecoveries: [],
      providerConfigured: true,
    });
    mocks.getNote.mockImplementation(async (noteId: string) =>
      noteId === "note-2" ? second : failedNote,
    );
    const pendingFinish = deferred<never>();
    mocks.finishRecording.mockReturnValue(pendingFinish.promise);

    await startRecordingDirectlyOnFirstNote();
    await userEvent.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() => expect(mocks.finishRecording).toHaveBeenCalledWith("rec-1"));

    expect(await screen.findByText(/Transcribing audio/)).toBeInTheDocument();
    expect(screen.queryByRole("alert", { name: "Transcription warning" })).toBeNull();
    expect(
      screen.queryByText(/The transcription provider could not process this audio\./),
    ).toBeNull();
  });

  it("clears a stale recovery error when Stop optimistically starts transcription", async () => {
    const recoverableNote = {
      ...first,
      processingStatus: "recoverable" as const,
      lastError: "Recording interrupted. June saved the audio for recovery.",
    };
    mocks.bootstrapApp.mockResolvedValue({
      folders: [],
      notes: [recoverableNote, second],
      activeRecoveries: [],
      providerConfigured: true,
    });
    mocks.getNote.mockImplementation(async (noteId: string) =>
      noteId === "note-2" ? second : recoverableNote,
    );
    const pendingFinish = deferred<never>();
    mocks.finishRecording.mockReturnValue(pendingFinish.promise);

    await startRecordingDirectlyOnFirstNote();
    await userEvent.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() => expect(mocks.finishRecording).toHaveBeenCalledWith("rec-1"));

    expect(await screen.findByText(/Transcribing audio/)).toBeInTheDocument();
    expect(screen.queryByRole("alert", { name: "Transcription warning" })).toBeNull();
    expect(screen.queryByText(/Recording interrupted/)).toBeNull();
  });

  it("preserves an active warning when Stop queues another recording", async () => {
    const warningNote = {
      ...first,
      processingStatus: "transcribing" as const,
      lastError: "authorization_denied",
    };
    mocks.bootstrapApp.mockResolvedValue({
      folders: [],
      notes: [warningNote, second],
      activeRecoveries: [],
      providerConfigured: true,
    });
    mocks.getNote.mockImplementation(async (noteId: string) =>
      noteId === "note-2" ? second : warningNote,
    );
    mocks.finishRecording.mockResolvedValue({
      note: { ...warningNote, queuedRecordings: 1 },
      recording: recording({ state: "ready" }),
      validation: {},
      processingStarted: true,
    });

    await startRecordingDirectlyOnFirstNote();
    await userEvent.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() => expect(mocks.finishRecording).toHaveBeenCalledWith("rec-1"));

    await waitFor(() =>
      expect(screen.getByRole("alert", { name: "Transcription warning" })).toHaveTextContent(
        "The service is busy right now. Wait a minute, then retry.",
      ),
    );
  });

  it("polls newly persisted turns while note transcription remains active", async () => {
    const selectedNote = note({
      processingStatus: "transcribing",
      activeTab: "transcription",
      sourceTranscripts: [],
    });
    let pollResponse = selectedNote;
    mocks.bootstrapApp.mockResolvedValue({
      folders: [],
      notes: [selectedNote],
      activeRecoveries: [],
      providerConfigured: true,
    });
    mocks.getNote.mockImplementation(async () => pollResponse);

    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "Meeting notes" }));
    await userEvent.click(screen.getByRole("button", { name: /First note Preview/ }));
    await waitFor(() => expect(screen.getByText("Transcribing audio")).toBeInTheDocument());
    const scroller = stubNoteDetailScroller(600);

    expect(screen.queryByText("The first saved turn is visible.")).not.toBeInTheDocument();
    mocks.getNote.mockClear();
    pollResponse = {
      ...selectedNote,
      processingStatus: "transcribing",
      sourceTranscripts: [
        {
          id: "turn-1",
          text: "The first saved turn is visible.",
          source: "microphone",
          sourceMode: "microphonePlusSystem",
          startMs: 0,
          endMs: 4_000,
          turnIndex: 0,
          language: "en",
          status: "succeeded",
          recordedSilence: false,
        },
      ],
    };

    await waitFor(
      () => {
        expect(mocks.getNote).toHaveBeenCalledWith(selectedNote.id);
        expect(screen.getByText("The first saved turn is visible.")).toBeInTheDocument();
      },
      { timeout: 3_000 },
    );
    expect(scroller.scrollTo).toHaveBeenCalledTimes(1);
    const transcribingStatus = screen.getByText("Transcribing audio");
    expect(transcribingStatus.closest('[role="status"]')).not.toBeNull();
  });

  it("keeps retry failures scoped to the failed note", async () => {
    mocks.getNote.mockImplementation(async (noteId: string) =>
      noteId === "note-2"
        ? second
        : {
            ...first,
            processingStatus: "failed",
            lastError: "Network unreachable",
            audio: {
              id: "audio-1",
              format: "wav",
              durationMs: 1000,
              sizeBytes: 2048,
              checksum: "abc",
              createdAt: now,
            },
          },
    );
    mocks.retryProcessing.mockRejectedValue({
      code: "june_api_response_invalid",
      message: "The processing service returned an invalid response.",
    });

    const { container } = render(<App />);
    await waitFor(() => expect(mocks.getNote).toHaveBeenCalledWith("note-1"));

    // The app launches on the agent view; open the note from the Meetings
    // list so the editor (and its failure banner) is on screen.
    await userEvent.click(await screen.findByRole("button", { name: "Meeting notes" }));
    await userEvent.click(screen.getByRole("button", { name: /First note Preview/ }));

    await userEvent.click(screen.getByRole("button", { name: /Retry/ }));

    await waitFor(() =>
      expect(
        screen.getByText(/The processing service returned an invalid response\./),
      ).toBeInTheDocument(),
    );
    expect(container.querySelector(".note-failure-banner")).not.toBeNull();
    expect(container.querySelector(".error-banner")).toBeNull();
    // The banner releases its busy gate so the user can try again.
    await waitFor(() => expect(screen.getByRole("button", { name: /Retry/ })).toBeEnabled());

    await userEvent.click(screen.getByRole("button", { name: "Dictation" }));
    expect(container.querySelector(".note-failure-banner")).toBeNull();
    expect(container.querySelector(".error-banner")).toBeNull();
  });

  it("shows processing immediately after retry starts", async () => {
    const failedNote = {
      ...first,
      activeTab: "notes" as const,
      processingStatus: "failed" as const,
      retryRecordingSessionId: "recording-to-retry",
      lastError: "The processing service returned an invalid response.",
      audio: {
        id: "audio-1",
        format: "wav",
        durationMs: 1000,
        sizeBytes: 2048,
        checksum: "abc",
        createdAt: now,
      },
    };
    const retryingNote = {
      ...failedNote,
      processingStatus: "transcribing" as const,
      lastError: undefined,
    };
    mocks.getNote.mockImplementation(async (noteId: string) =>
      noteId === "note-2" ? second : failedNote,
    );
    mocks.retryProcessing.mockResolvedValue(retryingNote);
    mocks.updateNote.mockImplementation(async (input) => ({
      ...retryingNote,
      ...input,
    }));

    const { container } = render(<App />);
    await waitFor(() => expect(mocks.getNote).toHaveBeenCalledWith("note-1"));
    await userEvent.click(await screen.findByRole("button", { name: "Meeting notes" }));
    await userEvent.click(screen.getByRole("button", { name: /First note Preview/ }));

    await userEvent.click(screen.getByRole("button", { name: /Retry/ }));

    await waitFor(() =>
      expect(mocks.retryProcessing).toHaveBeenCalledWith("note-1", "recording-to-retry"),
    );

    await waitFor(() => expect(screen.getByText(/Transcribing audio/)).toBeInTheDocument());
    expect(container.querySelector(".note-failure-banner")).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Transcription" }));
    await waitFor(() =>
      expect(mocks.patchNote).toHaveBeenCalledWith("note-1", {
        activeTab: "transcription",
      }),
    );
  });

  it("changes to Max in place and announces success only after the credit grant", async () => {
    const failedNote = {
      ...first,
      processingStatus: "failed" as const,
      lastError: "Your balance is too low. Upgrade to continue.",
    };
    const proAccount: AccountStatus = {
      signedIn: true,
      configured: true,
      user: { id: "usr_123", handle: "alex" },
      balance: { credits: 10, usdMillis: 10 },
      subscription: { subscribed: true, status: "active", plan: "pro" },
    };
    mocks.osAccountsStatus.mockResolvedValue(proAccount);
    mocks.bootstrapApp.mockResolvedValue({
      folders: [],
      notes: [failedNote, second],
      activeRecoveries: [],
      providerConfigured: true,
    });
    mocks.getNote.mockImplementation(async (noteId: string) =>
      noteId === "note-2" ? second : failedNote,
    );

    render(<App />);
    await waitFor(() => expect(mocks.getNote).toHaveBeenCalledWith("note-1"));
    await userEvent.click(await screen.findByRole("button", { name: "Meeting notes" }));
    await userEvent.click(screen.getByRole("button", { name: /First note Preview/ }));

    // The banner's action requires confirmation before changing the plan.
    await userEvent.click(await screen.findByRole("button", { name: "Upgrade to Max" }));
    expect(
      await screen.findByText(
        "Max is $100 per month. A secure Stripe page will open in your browser to review and confirm. Your billing cycle restarts today.",
      ),
    ).toBeInTheDocument();
    expect(mocks.osAccountsUpgrade).not.toHaveBeenCalled();
    expect(mocks.osAccountsChangePlan).not.toHaveBeenCalled();

    let resolveGrantRefresh: ((account: AccountStatus) => void) | undefined;
    mocks.osAccountsStatus.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveGrantRefresh = resolve;
        }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Upgrade now" }));

    expect(mocks.osAccountsUpgradeSession).toHaveBeenCalledTimes(1);
    expect(mocks.osAccountsUpgradeSession).toHaveBeenCalledWith("max");
    expect(mocks.osAccountsChangePlan).not.toHaveBeenCalled();
    expect(mocks.osAccountsUpgrade).not.toHaveBeenCalled();
    expect(
      await screen.findByText("Waiting for you to confirm in the browser"),
    ).toBeInTheDocument();
    expect(screen.queryByText("Max is active.")).toBeNull();

    // The waiting refresh resolves only after the payment-backed credit balance
    // change. That landed grant is what allows the active announcement.
    resolveGrantRefresh?.({
      ...proAccount,
      balance: { credits: 50_000, usdMillis: 50_000 },
      subscription: { subscribed: true, status: "active", plan: "max" },
    });
    expect(await screen.findByText("Max is active.")).toBeInTheDocument();
  });

  it("does not reroute a confirmed Max upgrade after the subscription lapses", async () => {
    const failedNote = {
      ...first,
      processingStatus: "failed" as const,
      lastError: "Your balance is too low. Upgrade to continue.",
    };
    const proAccount: AccountStatus = {
      signedIn: true,
      configured: true,
      user: { id: "usr_123", handle: "alex" },
      balance: { credits: 10, usdMillis: 10 },
      subscription: { subscribed: true, status: "active", plan: "pro" },
    };
    mocks.osAccountsStatus.mockResolvedValue(proAccount);
    mocks.bootstrapApp.mockResolvedValue({
      folders: [],
      notes: [failedNote, second],
      activeRecoveries: [],
      providerConfigured: true,
    });
    mocks.getNote.mockImplementation(async (noteId: string) =>
      noteId === "note-2" ? second : failedNote,
    );

    render(<App />);
    await waitFor(() => expect(mocks.getNote).toHaveBeenCalledWith("note-1"));
    await userEvent.click(await screen.findByRole("button", { name: "Meeting notes" }));
    await userEvent.click(screen.getByRole("button", { name: /First note Preview/ }));

    await userEvent.click(await screen.findByRole("button", { name: "Upgrade to Max" }));
    expect(
      await screen.findByText(
        "Max is $100 per month. A secure Stripe page will open in your browser to review and confirm. Your billing cycle restarts today.",
      ),
    ).toBeInTheDocument();

    mocks.osAccountsStatus.mockResolvedValue({
      ...proAccount,
      subscription: { subscribed: false },
    });
    const callsBeforeRefresh = mocks.osAccountsStatus.mock.calls.length;
    window.dispatchEvent(new Event("focus"));
    await waitFor(() =>
      expect(mocks.osAccountsStatus.mock.calls.length).toBeGreaterThan(callsBeforeRefresh),
    );
    expect(await screen.findByRole("button", { name: "Upgrade" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Upgrade now" }));

    await waitFor(() =>
      expect(
        screen.queryByText(
          "Max is $100 per month. A secure Stripe page will open in your browser to review and confirm. Your billing cycle restarts today.",
        ),
      ).toBeNull(),
    );
    // The dialog never closes silently: the confirmed intent evaporated, so
    // the user is told why and pointed back at the surface's options.
    expect(await screen.findByText("Your plan changed - pick an option again")).toBeInTheDocument();
    expect(mocks.osAccountsUpgrade).not.toHaveBeenCalled();
    expect(mocks.osAccountsUpgradeSession).not.toHaveBeenCalled();
    expect(mocks.osAccountsChangePlan).not.toHaveBeenCalled();
  });

  it("adopts a pending upgrade wait instead of offering a second purchase", async () => {
    const failedNote = {
      ...first,
      processingStatus: "failed" as const,
      lastError: "Your balance is too low. Upgrade to continue.",
    };
    const proAccount: AccountStatus = {
      signedIn: true,
      configured: true,
      user: { id: "usr_123", handle: "alex" },
      balance: { credits: 10, usdMillis: 10 },
      subscription: { subscribed: true, status: "active", plan: "pro" },
    };
    mocks.osAccountsStatus.mockResolvedValue(proAccount);
    mocks.bootstrapApp.mockResolvedValue({
      folders: [],
      notes: [failedNote, second],
      activeRecoveries: [],
      providerConfigured: true,
    });
    mocks.getNote.mockImplementation(async (noteId: string) =>
      noteId === "note-2" ? second : failedNote,
    );
    // An upgrade already in flight for this account, started on another
    // surface (Billing settings, the funding gate).
    beginMaxGrantWait(10, "usr_123", "browser");

    render(<App />);
    await waitFor(() => expect(mocks.getNote).toHaveBeenCalledWith("note-1"));
    await userEvent.click(await screen.findByRole("button", { name: "Meeting notes" }));
    await userEvent.click(screen.getByRole("button", { name: /First note Preview/ }));

    await userEvent.click(await screen.findByRole("button", { name: "Upgrade to Max" }));

    // No second confirm, no second session: the surface adopts the wait and
    // re-shows its status.
    expect(
      await screen.findByText("Waiting for you to confirm in the browser"),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(
        "Max is $100 per month. A secure Stripe page will open in your browser to review and confirm. Your billing cycle restarts today.",
      ),
    ).toBeNull();
    expect(mocks.osAccountsUpgradeSession).not.toHaveBeenCalled();
    expect(mocks.osAccountsChangePlan).not.toHaveBeenCalled();
    expect(mocks.osAccountsUpgrade).not.toHaveBeenCalled();
  });

  it("drops the waiting banner when the wait is cancelled on another surface", async () => {
    const failedNote = {
      ...first,
      processingStatus: "failed" as const,
      lastError: "Your balance is too low. Upgrade to continue.",
    };
    const proAccount: AccountStatus = {
      signedIn: true,
      configured: true,
      user: { id: "usr_123", handle: "alex" },
      balance: { credits: 10, usdMillis: 10 },
      subscription: { subscribed: true, status: "active", plan: "pro" },
    };
    mocks.osAccountsStatus.mockResolvedValue(proAccount);
    mocks.bootstrapApp.mockResolvedValue({
      folders: [],
      notes: [failedNote, second],
      activeRecoveries: [],
      providerConfigured: true,
    });
    mocks.getNote.mockImplementation(async (noteId: string) =>
      noteId === "note-2" ? second : failedNote,
    );

    render(<App />);
    await waitFor(() => expect(mocks.getNote).toHaveBeenCalledWith("note-1"));
    await userEvent.click(await screen.findByRole("button", { name: "Meeting notes" }));
    await userEvent.click(screen.getByRole("button", { name: /First note Preview/ }));

    await userEvent.click(await screen.findByRole("button", { name: "Upgrade to Max" }));
    await userEvent.click(await screen.findByRole("button", { name: "Upgrade now" }));
    expect(
      await screen.findByText("Waiting for you to confirm in the browser"),
    ).toBeInTheDocument();

    // The user cancels from the funding notice ("I closed the Stripe page").
    // The banner's cached copy must not keep claiming a wait that no longer
    // exists. A real refresh always yields a fresh snapshot object.
    clearMaxGrantWait();
    mocks.osAccountsStatus.mockResolvedValue({ ...proAccount });
    const callsBeforeRefresh = mocks.osAccountsStatus.mock.calls.length;
    window.dispatchEvent(new Event("focus"));
    await waitFor(() =>
      expect(mocks.osAccountsStatus.mock.calls.length).toBeGreaterThan(callsBeforeRefresh),
    );
    await waitFor(() =>
      expect(screen.queryByText("Waiting for you to confirm in the browser")).toBeNull(),
    );
    expect(mocks.osAccountsChangePlan).not.toHaveBeenCalled();
  });

  it("re-derives the banner when another surface's poll advances the wait phase", async () => {
    const failedNote = {
      ...first,
      processingStatus: "failed" as const,
      lastError: "Your balance is too low. Upgrade to continue.",
    };
    const proAccount: AccountStatus = {
      signedIn: true,
      configured: true,
      user: { id: "usr_123", handle: "alex" },
      balance: { credits: 10, usdMillis: 10 },
      subscription: { subscribed: true, status: "active", plan: "pro" },
    };
    mocks.osAccountsStatus.mockResolvedValue(proAccount);
    mocks.bootstrapApp.mockResolvedValue({
      folders: [],
      notes: [failedNote, second],
      activeRecoveries: [],
      providerConfigured: true,
    });
    mocks.getNote.mockImplementation(async (noteId: string) =>
      noteId === "note-2" ? second : failedNote,
    );

    render(<App />);
    await waitFor(() => expect(mocks.getNote).toHaveBeenCalledWith("note-1"));
    await userEvent.click(await screen.findByRole("button", { name: "Meeting notes" }));
    await userEvent.click(screen.getByRole("button", { name: /First note Preview/ }));

    await userEvent.click(await screen.findByRole("button", { name: "Upgrade to Max" }));
    await userEvent.click(await screen.findByRole("button", { name: "Upgrade now" }));
    expect(
      await screen.findByText("Waiting for you to confirm in the browser"),
    ).toBeInTheDocument();

    // Another surface's poll times out and mutates the shared wait in place.
    // The banner snapshot must follow on the next refresh tick.
    const grantWait = currentMaxGrantWait();
    expect(grantWait).toBeDefined();
    if (grantWait) markMaxGrantWaitSlow(grantWait);
    mocks.osAccountsStatus.mockResolvedValue({ ...proAccount });
    window.dispatchEvent(new Event("focus"));

    expect(
      await screen.findByText(
        "Still waiting for payment confirmation. If you closed the Stripe page, you can try again.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText("Waiting for you to confirm in the browser")).toBeNull();
    expect(mocks.osAccountsChangePlan).not.toHaveBeenCalled();
  });
});
