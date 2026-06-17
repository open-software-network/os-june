import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../app/App";
import { MEETING_START_TRANSCRIPTION_EVENT } from "../lib/events";
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
  osAccountsTopUp: vi.fn(),
  agentHudShow: vi.fn(),
  agentHudHide: vi.fn(),
  playRecordingSound: vi.fn(),
  preloadRecordingSounds: vi.fn(),
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

vi.mock("../lib/tauri", () => ({
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
  osAccountsLogin: mocks.osAccountsLogin,
  osAccountsCancelLogin: mocks.osAccountsCancelLogin,
  osAccountsLogout: mocks.osAccountsLogout,
  osAccountsTopUp: mocks.osAccountsTopUp,
  agentHudShow: mocks.agentHudShow,
  agentHudHide: mocks.agentHudHide,
  // The agent workspace mounts at launch; a quiet, not-running bridge keeps
  // these tests focused on the meetings surfaces.
  hermesBridgeStatus: vi.fn(async () => ({ running: false })),
  listAgentTasks: vi.fn(async () => ({ items: [] })),
  scribeVerifyUrl: vi.fn(async () => ""),
  providerModelSettings: vi.fn(async () => ({
    settings: { generationModel: "" },
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

function recovery(
  overrides: Partial<RecoverableRecordingDto> = {},
): RecoverableRecordingDto {
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
    vi.clearAllMocks();
    mocks.listeners.clear();

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
      startDragging: vi.fn().mockResolvedValue(undefined),
    });
    mocks.bootstrapApp.mockResolvedValue(payload);
    // The meeting-detected start path creates a fresh note to record into; this
    // suite asserts recording lands on note-1, so the fresh note IS note-1.
    mocks.createNote.mockResolvedValue(first);
    mocks.deleteNote.mockResolvedValue(undefined);
    mocks.listNotes.mockResolvedValue({ items: [first, second] });
    mocks.getNote.mockImplementation(async (noteId: string) =>
      noteId === "note-2" ? second : first,
    );
    mocks.checkRecordingSourceReadiness.mockResolvedValue({
      sourceMode: "microphonePlusSystem",
      sources: [
        { source: "microphone", ready: true },
        { source: "system", ready: true },
      ],
    });
    mocks.startRecording.mockResolvedValue(recording());
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
    mocks.osAccountsTopUp.mockResolvedValue(undefined);
    mocks.updateNote.mockImplementation(async (input) => ({
      ...first,
      ...input,
    }));
  });

  async function startRecordingOnFirstNote() {
    render(<App />);
    await waitFor(() =>
      expect(mocks.listeners.has(MEETING_START_TRANSCRIPTION_EVENT)).toBe(true),
    );
    await waitFor(() => expect(mocks.getNote).toHaveBeenCalledWith("note-1"));
    // The meeting-start listener silently drops events until the effect
    // re-subscribes with bootstrapped=true — and that happens in a passive
    // effect of a commit made outside act (getNote's resolution), so on slow
    // (coverage) runs the listener in the map can still be a stale closure
    // when we fire. Re-fire until the live listener takes the event; the
    // calls-length guard makes a successful start fire exactly once, so this
    // can never double-start a recording.
    await waitFor(async () => {
      if (mocks.startRecording.mock.calls.length === 0) {
        await act(async () => {
          await mocks.listeners.get(MEETING_START_TRANSCRIPTION_EVENT)?.({
            payload: undefined,
          });
        });
      }
      expect(mocks.startRecording).toHaveBeenCalledWith(
        "note-1",
        "microphonePlusSystem",
      );
    });
  }

  it("does not mark a different note transcribing when finishing a recording started elsewhere", async () => {
    mocks.finishRecording.mockResolvedValue({
      note: { ...first, processingStatus: "transcribing" },
      recording: recording({ state: "ready" }),
      validation: {},
      processingStarted: true,
    });

    await startRecordingOnFirstNote();

    // Browse to another note while the recording keeps running on note-1.
    await userEvent.click(
      screen.getByRole("button", { name: "Meeting notes", current: "page" }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: /Second note Preview/ }),
    );
    await waitFor(() => expect(mocks.getNote).toHaveBeenCalledWith("note-2"));

    // Off the recording's note, the sidebar indicator stands in for the
    // in-note bar. Click it back to note-1, where Done lives.
    const indicator = await screen.findByRole("button", {
      name: "Open recording: First note",
    });
    await userEvent.click(indicator);
    await waitFor(() => expect(mocks.getNote).toHaveBeenCalledWith("note-1"));
    await userEvent.click(await screen.findByRole("button", { name: "Done" }));
    await waitFor(() =>
      expect(mocks.finishRecording).toHaveBeenCalledWith("rec-1"),
    );

    // note-2 must not pick up note-1's optimistic "transcribing" lock.
    mocks.getNote.mockClear();
    await userEvent.click(
      screen.getByRole("button", { name: "Meeting notes", current: "page" }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: /Second note Preview/ }),
    );
    await waitFor(() => expect(mocks.getNote).toHaveBeenCalledWith("note-2"));
    expect(screen.queryByText(/Transcribing audio/)).not.toBeInTheDocument();
  });

  it("shows a sidebar recorder indicator off the recording's note and reopens it on click", async () => {
    await startRecordingOnFirstNote();

    // Browse away from the recording note while the take keeps running.
    await userEvent.click(
      screen.getByRole("button", { name: "Meeting notes", current: "page" }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: /Second note Preview/ }),
    );
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

  it("ignores meeting-start signals while a recording is already live", async () => {
    await startRecordingOnFirstNote();

    mocks.createNote.mockClear();
    mocks.startRecording.mockClear();

    await act(async () => {
      await mocks.listeners.get(MEETING_START_TRANSCRIPTION_EVENT)?.({
        payload: undefined,
      });
    });

    expect(mocks.createNote).not.toHaveBeenCalled();
    expect(mocks.startRecording).not.toHaveBeenCalled();
  });

  it("claims a meeting-start attempt before creating the fresh note", async () => {
    const fresh = note({
      id: "fresh-note",
      title: "New note",
      generatedContent: undefined,
      processingStatus: "draft",
    });
    const pendingCreate = deferred<NoteDto>();
    mocks.createNote.mockReturnValue(pendingCreate.promise);
    mocks.startRecording.mockResolvedValue(recording({ noteId: "fresh-note" }));

    render(<App />);
    await waitFor(() =>
      expect(mocks.listeners.has(MEETING_START_TRANSCRIPTION_EVENT)).toBe(true),
    );
    await waitFor(() => expect(mocks.getNote).toHaveBeenCalledWith("note-1"));

    await waitFor(() => {
      if (mocks.createNote.mock.calls.length === 0) {
        act(() => {
          void mocks.listeners.get(MEETING_START_TRANSCRIPTION_EVENT)?.({
            payload: undefined,
          });
        });
      }
      expect(mocks.createNote).toHaveBeenCalledTimes(1);
    });

    act(() => {
      void mocks.listeners.get(MEETING_START_TRANSCRIPTION_EVENT)?.({
        payload: undefined,
      });
    });

    expect(mocks.createNote).toHaveBeenCalledTimes(1);
    expect(mocks.startRecording).not.toHaveBeenCalled();

    await act(async () => {
      pendingCreate.resolve(fresh);
      await pendingCreate.promise;
    });

    await waitFor(() =>
      expect(mocks.startRecording).toHaveBeenCalledWith(
        "fresh-note",
        "microphonePlusSystem",
      ),
    );
    expect(mocks.createNote).toHaveBeenCalledTimes(1);
  });

  it("removes the fresh meeting note when recording fails to start", async () => {
    const fresh = note({
      id: "fresh-note",
      title: "New note",
      generatedContent: undefined,
      processingStatus: "draft",
    });
    mocks.createNote.mockResolvedValue(fresh);
    mocks.getNote.mockImplementation(async (noteId: string) => {
      if (noteId === "fresh-note") return fresh;
      if (noteId === "note-2") return second;
      return first;
    });
    mocks.checkRecordingSourceReadiness.mockResolvedValue({
      sourceMode: "microphonePlusSystem",
      sources: [
        {
          source: "microphone",
          ready: false,
          message: "Microphone is not ready.",
        },
        { source: "system", ready: true },
      ],
    });

    render(<App />);
    await waitFor(() =>
      expect(mocks.listeners.has(MEETING_START_TRANSCRIPTION_EVENT)).toBe(true),
    );
    await waitFor(() => expect(mocks.getNote).toHaveBeenCalledWith("note-1"));

    await waitFor(async () => {
      if (mocks.deleteNote.mock.calls.length === 0) {
        await act(async () => {
          await mocks.listeners.get(MEETING_START_TRANSCRIPTION_EVENT)?.({
            payload: undefined,
          });
        });
      }
      expect(mocks.deleteNote).toHaveBeenCalledWith("fresh-note");
    });
    expect(mocks.listNotes).toHaveBeenCalled();
    expect(mocks.startRecording).not.toHaveBeenCalled();
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

    await userEvent.click(
      screen.getByRole("button", { name: "Meeting notes", current: "page" }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: /Second note Preview/ }),
    );
    const indicator = await screen.findByRole("button", {
      name: "Open recording: First note",
    });
    await userEvent.click(indicator);
    await waitFor(() => expect(mocks.getNote).toHaveBeenCalledWith("note-1"));

    await userEvent.click(screen.getByRole("button", { name: "Discard" }));

    await waitFor(() =>
      expect(mocks.recoverRecording).toHaveBeenCalledWith("rec-1", "discard"),
    );
    expect(screen.getByText("Recording discarded")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Retry/ })).toBeDisabled();

    await userEvent.click(
      screen.getByRole("button", { name: "Meeting notes", current: "page" }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: /Second note Preview/ }),
    );
    expect(
      screen.queryByRole("button", { name: "Open recording: First note" }),
    ).not.toBeInTheDocument();
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
    await waitFor(() =>
      expect(mocks.finishRecording).toHaveBeenCalledWith("rec-1"),
    );

    await waitFor(() =>
      expect(screen.getByText(/Transcribing audio/)).toBeInTheDocument(),
    );
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
      code: "scribe_api_response_invalid",
      message: "The processing service returned an invalid response.",
    });

    const { container } = render(<App />);
    await waitFor(() => expect(mocks.getNote).toHaveBeenCalledWith("note-1"));

    // The app launches on the agent view; open the note from the Meetings
    // list so the editor (and its failure banner) is on screen.
    await userEvent.click(
      await screen.findByRole("button", { name: "Meeting notes" }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: /First note Preview/ }),
    );

    await userEvent.click(screen.getByRole("button", { name: /Retry/ }));

    await waitFor(() =>
      expect(
        screen.getByText(
          /The processing service returned an invalid response\./,
        ),
      ).toBeInTheDocument(),
    );
    expect(container.querySelector(".note-failure-banner")).not.toBeNull();
    expect(container.querySelector(".error-banner")).toBeNull();
    // The banner releases its busy gate so the user can try again.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Retry/ })).toBeEnabled(),
    );

    await userEvent.click(screen.getByRole("button", { name: "Dictation" }));
    expect(container.querySelector(".note-failure-banner")).toBeNull();
    expect(container.querySelector(".error-banner")).toBeNull();
  });

  it("shows processing immediately after retry starts", async () => {
    const failedNote = {
      ...first,
      activeTab: "notes" as const,
      processingStatus: "failed" as const,
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
    await userEvent.click(
      await screen.findByRole("button", { name: "Meeting notes" }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: /First note Preview/ }),
    );

    await userEvent.click(screen.getByRole("button", { name: /Retry/ }));

    await waitFor(() =>
      expect(screen.getByText(/Transcribing audio/)).toBeInTheDocument(),
    );
    expect(container.querySelector(".note-failure-banner")).toBeNull();

    await userEvent.click(
      screen.getByRole("button", { name: "Transcription" }),
    );
    await waitFor(() =>
      expect(mocks.updateNote).toHaveBeenCalledWith({
        noteId: "note-1",
        activeTab: "transcription",
      }),
    );
  });
});
