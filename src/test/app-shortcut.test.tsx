import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../app/App";
import { HERO_GREETINGS } from "../components/agent/AgentWorkspace";
import { AGENT_NEW_SESSION_EVENT } from "../lib/agent-events";
import { OPEN_SETTINGS_EVENT } from "../lib/menu-bar";
import type { AccountStatus, BootstrapResponse, NoteDto } from "../lib/tauri";

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
  osAccountsTopUp: vi.fn(),
  agentHudShow: vi.fn(),
  agentHudHide: vi.fn(),
  playRecordingSound: vi.fn(),
  preloadRecordingSounds: vi.fn(),
  startPeriodicScribeUpdateChecks: vi.fn(),
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

vi.mock("../app/update-decision", async () => {
  const actual = await vi.importActual<typeof import("../app/update-decision")>(
    "../app/update-decision",
  );
  return {
    ...actual,
    startPeriodicScribeUpdateChecks: mocks.startPeriodicScribeUpdateChecks,
  };
});

vi.mock("../lib/tauri", () => ({
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
      subscription: { subscribed: true, status: "active" },
    });
    mocks.osAccountsLogin.mockResolvedValue({
      signedIn: true,
      configured: true,
      user: { id: "usr_123", handle: "junho", email: "junho@example.com" },
      balance: { usdMillis: 1200 },
      subscription: { subscribed: true, status: "active" },
    });
    mocks.osAccountsLogout.mockResolvedValue(undefined);
    mocks.osAccountsCancelLogin.mockResolvedValue(undefined);
    mocks.osAccountsTopUp.mockResolvedValue(undefined);
    mocks.startPeriodicScribeUpdateChecks.mockReturnValue(vi.fn());
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
        expect(mocks.startPeriodicScribeUpdateChecks).toHaveBeenCalledOnce(),
      );
      expect(mocks.startPeriodicScribeUpdateChecks.mock.calls[0]?.[0]).toEqual(
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

  it("creates a loose note with Command-Shift-N but ignores bare n", async () => {
    render(<App />);

    await waitFor(() => expect(mocks.getNote).toHaveBeenCalledWith("note-1"));

    fireEvent.keyDown(window, { key: "n" });
    expect(mocks.createNote).not.toHaveBeenCalled();

    fireEvent.keyDown(window, { key: "n", metaKey: true, shiftKey: true });

    await waitFor(() =>
      expect(mocks.createNote).toHaveBeenCalledWith(undefined),
    );
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
      user: { id: "usr_123", handle: "junho", email: "junho@example.com" },
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
