import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../app/App";
import type {
  AccountStatus,
  BootstrapResponse,
  NoteDto,
  RecordingSourceReadinessDto,
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
  osAccountsUpgrade: vi.fn(),
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

const microphoneSource = {
  source: "microphone" as const,
  required: true,
  ready: true,
  permissionState: "granted" as const,
  deviceAvailable: true,
  captureAvailable: true,
};

const systemSource = {
  source: "system" as const,
  required: true,
  ready: true,
  permissionState: "granted" as const,
  deviceAvailable: true,
  captureAvailable: true,
};

const fullReadiness: RecordingSourceReadinessDto = {
  sourceMode: "microphonePlusSystem",
  ready: true,
  checkedAt: now,
  sources: [microphoneSource, systemSource],
};

// What a mic-only recording preflight stores: no system entry at all.
const micOnlyReadiness: RecordingSourceReadinessDto = {
  sourceMode: "microphoneOnly",
  ready: true,
  checkedAt: now,
  sources: [microphoneSource],
};

describe("system audio round trip on Windows", () => {
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
    mocks.checkRecordingSourceReadiness.mockResolvedValue(fullReadiness);
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

  it("re-probes readiness and restores microphonePlusSystem when re-enabled", async () => {
    // The full loop Codex flagged: turning system audio off leads to a
    // mic-only preflight whose stored readiness has no system entry, which
    // zeroes systemGranted. Toggling back on must re-probe the full mode so
    // sourceMode actually returns to microphonePlusSystem, not just record
    // intent.
    const user = userEvent.setup();
    const restoreNavigator = stubNavigatorPlatform(
      "Win32",
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
    );
    try {
      render(<App />);
      await waitFor(() => expect(mocks.getNote).toHaveBeenCalledWith("note-1"));

      // Open the note from the Meetings list so the editor (and its record
      // shell) is on screen.
      await user.click(await screen.findByRole("button", { name: "Meeting notes" }));
      await user.click(await screen.findByRole("button", { name: /First note Preview/ }));

      // Mount probe stored the full readiness; the system toggle reflects
      // microphonePlusSystem.
      await user.click(await screen.findByRole("button", { name: "Recording options" }));
      const systemSwitch = await screen.findByRole("switch", { name: "Capture system audio" });
      await waitFor(() => expect(systemSwitch).toBeChecked());

      // User turns system audio off.
      await user.click(systemSwitch);
      await waitFor(() => expect(systemSwitch).not.toBeChecked());

      // A later refresh (here: the window-focus one, standing in for the
      // recording preflight) stores a readiness result with no system entry.
      mocks.checkRecordingSourceReadiness.mockResolvedValue(micOnlyReadiness);
      const callsBeforeFocus = mocks.checkRecordingSourceReadiness.mock.calls.length;
      await act(async () => {
        window.dispatchEvent(new Event("focus"));
      });
      await waitFor(() =>
        expect(mocks.checkRecordingSourceReadiness.mock.calls.length).toBeGreaterThan(
          callsBeforeFocus,
        ),
      );

      // Sticky support keeps the toggle visible; turning it back on must
      // re-probe the full mode, not just set intent.
      mocks.checkRecordingSourceReadiness.mockResolvedValue(fullReadiness);
      const callsBeforeReenable = mocks.checkRecordingSourceReadiness.mock.calls.length;
      await user.click(systemSwitch);

      await waitFor(() => {
        const reprobes = mocks.checkRecordingSourceReadiness.mock.calls.slice(callsBeforeReenable);
        expect(reprobes.some((call) => call[0] === "microphonePlusSystem")).toBe(true);
      });
      // The re-probe restored systemGranted, so sourceMode followed the
      // intent back to microphonePlusSystem.
      await waitFor(() => expect(systemSwitch).toBeChecked());
    } finally {
      restoreNavigator();
    }
  });
});
