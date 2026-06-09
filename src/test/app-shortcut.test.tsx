import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../app/App";
import type { AccountStatus, BootstrapResponse, NoteDto } from "../lib/tauri";

const mocks = vi.hoisted(() => ({
  listen: vi.fn(),
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
      user: { id: "usr_123", handle: "junho", email: "junho@example.com" },
      balance: { usdMillis: 1200 },
    });
    mocks.osAccountsLogin.mockResolvedValue({
      signedIn: true,
      configured: true,
      user: { id: "usr_123", handle: "junho", email: "junho@example.com" },
      balance: { usdMillis: 1200 },
    });
    mocks.osAccountsLogout.mockResolvedValue(undefined);
    mocks.osAccountsCancelLogin.mockResolvedValue(undefined);
    mocks.osAccountsTopUp.mockResolvedValue(undefined);
    mocks.updateNote.mockImplementation(async (input) => ({
      ...first,
      ...input,
    }));
  });

  it("creates a loose note with Command-N but ignores bare n", async () => {
    render(<App />);

    await waitFor(() => expect(mocks.getNote).toHaveBeenCalledWith("note-1"));

    fireEvent.keyDown(window, { key: "n" });
    expect(mocks.createNote).not.toHaveBeenCalled();

    fireEvent.keyDown(window, { key: "n", metaKey: true });

    await waitFor(() =>
      expect(mocks.createNote).toHaveBeenCalledWith(undefined),
    );
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

    await user.click(
      await screen.findByRole("button", { name: /^First note/ }),
    );
    await screen.findByDisplayValue("First note");
    fireEvent.click(
      screen.getByRole("button", { name: "Open Testing folder" }),
    );

    expect(
      await screen.findByRole("button", { name: /Rename folder/ }),
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
      await screen.findByRole("heading", { name: "Welcome to OS June" }),
    ).toBeInTheDocument();
    expect(mocks.bootstrapApp).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "New note" })).toBeNull();

    await user.click(
      screen.getByRole("button", { name: "Continue with OpenSoftware" }),
    );

    await waitFor(() => expect(mocks.bootstrapApp).toHaveBeenCalledOnce());
    await waitFor(() =>
      expect(mocks.createNote).toHaveBeenCalledWith(undefined),
    );
    await waitFor(() =>
      expect(screen.getByLabelText("Note title")).toHaveValue(""),
    );
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
      screen.queryByRole("heading", { name: "Welcome to OS June" }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Continue with OpenSoftware" }),
    ).toBeNull();
    expect(mocks.bootstrapApp).not.toHaveBeenCalled();

    resolveStatus?.({
      signedIn: true,
      configured: true,
      user: { id: "usr_123", handle: "junho", email: "junho@example.com" },
      balance: { usdMillis: 1200 },
    });

    expect(
      await screen.findByRole("heading", { name: "Notes" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /^First note/ }),
    ).toBeInTheDocument();
  });
});
