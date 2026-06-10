import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../app/App";
import { MEETING_START_TRANSCRIPTION_EVENT } from "../lib/events";
import type {
  AccountStatus,
  BootstrapResponse,
  NoteDto,
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
  finishRecording: vi.fn(),
  retryProcessing: vi.fn(),
  recoverRecording: vi.fn(),
  dictationHelperCommand: vi.fn(),
  listDictationHistory: vi.fn(),
  osAccountsStatus: vi.fn(),
  osAccountsLogin: vi.fn(),
  osAccountsCancelLogin: vi.fn(),
  osAccountsLogout: vi.fn(),
  osAccountsTopUp: vi.fn(),
  mascotShow: vi.fn(),
  mascotHide: vi.fn(),
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
  bootstrapApp: mocks.bootstrapApp,
  createNote: mocks.createNote,
  createFolder: mocks.createFolder,
  deleteFolder: mocks.deleteFolder,
  renameFolder: mocks.renameFolder,
  assignNoteToFolder: mocks.assignNoteToFolder,
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
  osAccountsTopUp: mocks.osAccountsTopUp,
  mascotShow: mocks.mascotShow,
  mascotHide: mocks.mascotHide,
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
      user: { id: "usr_123", handle: "junho", email: "junho@example.com" },
      balance: { usdMillis: 1200 },
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
        { source: "system", ready: true },
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
    mocks.osAccountsTopUp.mockResolvedValue(undefined);
    mocks.updateNote.mockImplementation(async (input) => ({
      ...first,
      ...input,
    }));
  });

  it("starts recording through the existing recorder flow", async () => {
    render(<App />);

    await waitFor(() =>
      expect(mocks.listeners.has(MEETING_START_TRANSCRIPTION_EVENT)).toBe(true),
    );
    await waitFor(() => expect(mocks.getNote).toHaveBeenCalledWith("note-1"));

    await act(async () => {
      await mocks.listeners.get(MEETING_START_TRANSCRIPTION_EVENT)?.({
        payload: undefined,
      });
    });

    await waitFor(() =>
      expect(mocks.startRecording).toHaveBeenCalledWith(
        "note-1",
        "microphonePlusSystem",
      ),
    );
    expect(mocks.playRecordingSound).toHaveBeenCalledWith("start");
  });

  it("reopens the recording HUD to the note editor for the active recording", async () => {
    render(<App />);

    await waitFor(() =>
      expect(mocks.listeners.has(MEETING_START_TRANSCRIPTION_EVENT)).toBe(true),
    );
    await waitFor(() => expect(mocks.getNote).toHaveBeenCalledWith("note-1"));

    await act(async () => {
      await mocks.listeners.get(MEETING_START_TRANSCRIPTION_EVENT)?.({
        payload: undefined,
      });
    });

    await waitFor(() => expect(mocks.startRecording).toHaveBeenCalledOnce());
    expect(screen.getByLabelText("Note title")).toHaveValue("First note");

    await act(async () => {
      await mocks.listeners.get("meeting-hud-action")?.({
        payload: { action: "reopen" },
      });
    });

    await waitFor(() =>
      expect(screen.getByLabelText("Note title")).toHaveValue("First note"),
    );
  });

  it("cleans up Tauri listeners that resolve after unmount", async () => {
    const cleanups: Array<ReturnType<typeof vi.fn>> = [];
    const pendingListeners: Array<
      (cleanup: (typeof cleanups)[number]) => void
    > = [];
    mocks.listen.mockImplementation(
      (event: string, listener: TauriListener) => {
        mocks.listeners.set(event, listener);
        return new Promise((resolve) => {
          pendingListeners.push(resolve);
        });
      },
    );

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
