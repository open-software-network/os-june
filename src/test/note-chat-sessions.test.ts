import { act, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NoteChatPanel } from "../components/note-chat/NoteChatPanel";
import {
  forgetNoteChatSession,
  noteChatSessionIdFor,
  rememberNoteChatSession,
} from "../components/note-chat/noteChatSessions";
import { type NoteChat, useNoteChat } from "../components/note-chat/useNoteChat";
import { reserveHermesSessionDispatch } from "../lib/hermes-session-dispatch-mutex";
import {
  rememberAppliedSessionModelSelection,
  stageSessionModelSelection,
} from "../lib/hermes-session-model-selection";
import { PROVIDER_MODEL_SETTINGS_CHANGED_EVENT } from "../lib/model-privacy";

const mocks = vi.hoisted(() => ({
  gatewayRequest: vi.fn(),
  gatewayConnect: vi.fn(),
  gatewayEventHandlers: new Set<(event: Record<string, unknown>) => void>(),
  hermesBridgeImageDataUrl: vi.fn(),
  hermesBridgeSessionMessages: vi.fn(),
  listHermesSessions: vi.fn(),
  hermesBridgeStatus: vi.fn(),
  listVeniceModels: vi.fn(),
  providerModelSettings: vi.fn(),
  setCostQuality: vi.fn(),
  setLocalGenerationEnabled: vi.fn(),
  setVeniceModel: vi.fn(),
  startHermesBridge: vi.fn(),
}));

vi.mock("../lib/tauri", () => ({
  dictationHelperCommand: vi.fn(),
  hermesBridgeImageDataUrl: mocks.hermesBridgeImageDataUrl,
  hermesBridgeSessionMessages: mocks.hermesBridgeSessionMessages,
  hermesBridgeStatus: mocks.hermesBridgeStatus,
  importHermesBridgeFile: vi.fn(),
  listVeniceModels: mocks.listVeniceModels,
  providerModelSettings: mocks.providerModelSettings,
  setCostQuality: mocks.setCostQuality,
  setLocalGenerationEnabled: mocks.setLocalGenerationEnabled,
  setVeniceModel: mocks.setVeniceModel,
  startHermesBridge: mocks.startHermesBridge,
}));

vi.mock("../lib/hermes-adapter", () => ({
  listHermesSessions: mocks.listHermesSessions,
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(),
}));

vi.mock("../lib/hermes-gateway", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/hermes-gateway")>()),
  HermesGatewayClient: class {
    connect = mocks.gatewayConnect;
    close = vi.fn();
    onEvent = vi.fn((handler: (event: Record<string, unknown>) => void) => {
      mocks.gatewayEventHandlers.add(handler);
      return () => mocks.gatewayEventHandlers.delete(handler);
    });
    onClose = vi.fn();
    request = mocks.gatewayRequest;
  },
}));

const STORAGE_KEY = "june.noteChat.sessionsByNote.v1";

const currentModel = {
  provider: "venice",
  id: "zai-org-glm-5-2",
  name: "GLM 5.2",
  modelType: "text",
  privacy: "private",
  traits: [],
  capabilities: ["supportsFunctionCalling"],
};

const autoModel = {
  provider: "open-software",
  id: "open-software/auto",
  name: "Auto",
  modelType: "text",
  privacy: "private",
  traits: [],
  capabilities: ["supportsFunctionCalling"],
};

const legacyModel = {
  provider: "venice",
  id: "kimi-k2-6",
  name: "Kimi K2.6",
  modelType: "text",
  privacy: "private",
  traits: [],
  capabilities: ["supportsFunctionCalling"],
};

function noteChat(overrides: Partial<NoteChat> = {}): NoteChat {
  return {
    turns: [],
    working: false,
    submissionPending: false,
    loading: false,
    error: null,
    storedSessionId: undefined,
    modelSelection: undefined,
    appliedHermesModelId: undefined,
    submit: vi.fn(async () => true),
    stop: vi.fn(),
    setSessionModel: vi.fn(),
    ...overrides,
  };
}

describe("note chat session map", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    mocks.hermesBridgeStatus.mockResolvedValue({
      running: true,
      connection: { port: 61234, wsUrl: "ws://127.0.0.1:61234" },
    });
    mocks.hermesBridgeSessionMessages.mockResolvedValue({ messages: [] });
    mocks.listHermesSessions.mockResolvedValue([]);
    mocks.providerModelSettings.mockResolvedValue({
      settings: {
        transcriptionProvider: "venice",
        generationProvider: "venice",
        transcriptionModel: "nvidia/parakeet-tdt-0.6b-v3",
        generationModel: currentModel.id,
        remoteGenerationModel: currentModel.id,
        costQuality: 100,
        imageModel: "venice-sd35",
        videoModel: "wan-2.2-a14b-text-to-video",
        veniceApiKeyConfigured: false,
        localGeneration: { baseUrl: "", modelId: "", apiKey: "" },
        imageSafeMode: true,
        imageSafeModePromptDismissed: false,
      },
    });
    mocks.listVeniceModels.mockResolvedValue({
      mode: "generation",
      modelType: "text",
      selectedModel: currentModel.id,
      models: [currentModel, autoModel],
    });
    mocks.setCostQuality.mockResolvedValue({ costQuality: 50 });
    mocks.setLocalGenerationEnabled.mockResolvedValue({});
    mocks.setVeniceModel.mockResolvedValue({});
    mocks.startHermesBridge.mockResolvedValue({
      running: true,
      connection: { port: 61234, wsUrl: "ws://127.0.0.1:61234" },
    });
    mocks.gatewayRequest.mockImplementation((method: string) => {
      if (method === "session.resume") {
        return Promise.resolve({ session_id: "runtime-note-chat" });
      }
      return Promise.resolve({});
    });
    mocks.gatewayConnect.mockResolvedValue(undefined);
  });

  it("remembers and recalls the session for a note", () => {
    rememberNoteChatSession("note-1", "sess-a");
    rememberNoteChatSession("note-2", "sess-b");

    expect(noteChatSessionIdFor("note-1")).toBe("sess-a");
    expect(noteChatSessionIdFor("note-2")).toBe("sess-b");
    expect(noteChatSessionIdFor("note-3")).toBeUndefined();
  });

  it("replaces the pairing when a note gets a new session", () => {
    rememberNoteChatSession("note-1", "sess-a");
    rememberNoteChatSession("note-1", "sess-c");

    expect(noteChatSessionIdFor("note-1")).toBe("sess-c");
  });

  it("forgets a pairing without touching other notes", () => {
    rememberNoteChatSession("note-1", "sess-a");
    rememberNoteChatSession("note-2", "sess-b");

    forgetNoteChatSession("note-1");

    expect(noteChatSessionIdFor("note-1")).toBeUndefined();
    expect(noteChatSessionIdFor("note-2")).toBe("sess-b");
  });

  it("survives corrupt storage", () => {
    window.localStorage.setItem(STORAGE_KEY, "{not json");
    expect(noteChatSessionIdFor("note-1")).toBeUndefined();

    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(["sess-a"]));
    expect(noteChatSessionIdFor("note-1")).toBeUndefined();

    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ "note-1": 7 }));
    expect(noteChatSessionIdFor("note-1")).toBeUndefined();

    // A write over corrupt storage heals it.
    rememberNoteChatSession("note-1", "sess-a");
    expect(noteChatSessionIdFor("note-1")).toBe("sess-a");
  });

  it("hydrates the applied model for a legacy chat without a selection entry", async () => {
    rememberNoteChatSession("note-1", "stored-note-chat");
    mocks.listHermesSessions.mockResolvedValue([
      {
        id: "stored-note-chat",
        model: "kimi-k2-6",
      },
    ]);

    const { result } = renderHook(() => useNoteChat({ id: "note-1", title: "Launch planning" }));

    await waitFor(() => expect(result.current.appliedHermesModelId).toBe("kimi-k2-6"));
    expect(result.current.modelSelection).toEqual({ modelId: "kimi-k2-6" });

    await act(async () => {
      expect(await result.current.submit("Use the upgraded route.")).toBe(true);
    });
    expect(mocks.gatewayRequest).toHaveBeenCalledWith("config.set", {
      session_id: "runtime-note-chat",
      key: "model",
      value: "__june_remote_generation__:kimi-k2-6 --session",
      confirm_expensive_model: true,
    });
  });

  it("upgrades a legacy configured-local session without treating it as remote", async () => {
    rememberNoteChatSession("note-1", "stored-note-chat");
    const defaults = await mocks.providerModelSettings();
    mocks.providerModelSettings.mockResolvedValue({
      settings: {
        ...defaults.settings,
        localGeneration: {
          baseUrl: "http://localhost:11434/v1",
          modelId: "llama3.1:8b",
          apiKey: "",
        },
      },
    });
    mocks.listHermesSessions.mockResolvedValue([{ id: "stored-note-chat", model: "llama3.1:8b" }]);

    const { result } = renderHook(() => useNoteChat({ id: "note-1", title: "Launch planning" }));

    await waitFor(() =>
      expect(result.current.modelSelection).toEqual({
        modelId: "__june_local_generation__:llama3.1%3A8b",
      }),
    );
    await act(async () => {
      expect(await result.current.submit("Keep this local.")).toBe(true);
    });
    expect(mocks.gatewayRequest).toHaveBeenCalledWith(
      "config.set",
      expect.objectContaining({
        value: "__june_local_generation__:llama3.1%3A8b --session",
      }),
    );
  });

  it("waits for legacy session metadata instead of applying the app default", async () => {
    rememberNoteChatSession("note-1", "stored-note-chat");
    const defaults = await mocks.providerModelSettings();
    mocks.providerModelSettings.mockResolvedValue({
      settings: {
        ...defaults.settings,
        localGeneration: {
          baseUrl: "http://localhost:11434/v1",
          modelId: "llama3.1:8b",
          apiKey: "",
        },
      },
    });
    let resolveSessions: (sessions: Array<{ id: string; model: string }>) => void = () => undefined;
    mocks.listHermesSessions.mockReturnValue(
      new Promise((resolve) => {
        resolveSessions = resolve;
      }),
    );

    const { result } = renderHook(() => useNoteChat({ id: "note-1", title: "Launch planning" }));
    let submission: Promise<boolean> = Promise.resolve(false);
    act(() => {
      submission = result.current.submit("Keep the legacy route.");
    });
    await waitFor(() => expect(mocks.listHermesSessions).toHaveBeenCalled());
    resolveSessions([{ id: "stored-note-chat", model: "llama3.1:8b" }]);

    await act(async () => {
      expect(await submission).toBe(true);
    });
    expect(mocks.gatewayRequest).toHaveBeenCalledWith("config.set", {
      session_id: "runtime-note-chat",
      key: "model",
      value: "__june_local_generation__:llama3.1%3A8b --session",
      confirm_expensive_model: true,
    });
    expect(mocks.gatewayRequest).not.toHaveBeenCalledWith(
      "config.set",
      expect.objectContaining({ value: "__june_remote_generation__:zai-org-glm-5-2 --session" }),
    );
  });

  it("keeps Hermes metadata authoritative across unrelated selection writes", async () => {
    rememberNoteChatSession("note-1", "stored-note-chat");
    rememberAppliedSessionModelSelection("stored-note-chat", { modelId: "zai-org-glm-5-2" });
    mocks.listHermesSessions.mockResolvedValue([
      {
        id: "stored-note-chat",
        model: "__june_remote_generation__:kimi-k2-6",
      },
    ]);

    const { result } = renderHook(() => useNoteChat({ id: "note-1", title: "Launch planning" }));

    await waitFor(() =>
      expect(result.current.appliedHermesModelId).toBe("__june_remote_generation__:kimi-k2-6"),
    );
    stageSessionModelSelection("another-session", { modelId: "kimi-k2-6" });
    expect(result.current.appliedHermesModelId).toBe("__june_remote_generation__:kimi-k2-6");

    await act(async () => {
      expect(await result.current.submit("Keep my queued GLM choice.")).toBe(true);
    });
    expect(mocks.gatewayRequest).toHaveBeenCalledWith("config.set", {
      session_id: "runtime-note-chat",
      key: "model",
      value: "__june_remote_generation__:zai-org-glm-5-2 --session",
      confirm_expensive_model: true,
    });
  });

  it("snapshots the app default when a first submit beats picker initialization", async () => {
    mocks.gatewayRequest.mockImplementation((method: string) => {
      if (method === "session.create") {
        return Promise.resolve({
          session_id: "runtime-note-chat",
          stored_session_id: "stored-note-chat",
        });
      }
      return Promise.resolve({});
    });
    const { result } = renderHook(() => useNoteChat({ id: "note-1", title: "Launch planning" }));

    await act(async () => {
      expect(await result.current.submit("What changed?")).toBe(true);
    });

    expect(mocks.gatewayRequest).toHaveBeenCalledWith("session.create", {
      title: "Launch planning",
      cols: 96,
      model: "__june_remote_generation__:zai-org-glm-5-2",
    });
  });

  it("updates the app-wide generation default before a note chat session exists", async () => {
    const user = userEvent.setup();
    const chat = noteChat();
    const settingsChanged = vi.fn();
    window.addEventListener(PROVIDER_MODEL_SETTINGS_CHANGED_EVENT, settingsChanged);

    render(
      createElement(NoteChatPanel, {
        note: { id: "note-1", title: "Launch planning" },
        chat,
        onClose: vi.fn(),
        onOpenInAgent: vi.fn(),
      }),
    );

    await user.click(await screen.findByRole("button", { name: "Model: GLM 5.2" }));
    const picker = screen.getByRole("dialog", { name: "Choose text model" });
    await user.click(within(picker).getByRole("button", { name: "All models" }));
    await user.click(
      within(screen.getByRole("group", { name: "All text models" })).getByRole("option", {
        name: /^Auto /,
      }),
    );

    expect(chat.setSessionModel).toHaveBeenCalledWith({
      modelId: "open-software/auto",
      costQuality: 100,
    });
    await waitFor(() => {
      expect(mocks.setCostQuality).toHaveBeenCalledWith(100);
      expect(mocks.setVeniceModel).toHaveBeenCalledWith("generation", "open-software/auto");
      expect(settingsChanged).toHaveBeenCalledTimes(1);
    });
    expect((settingsChanged.mock.calls[0]?.[0] as CustomEvent).detail).toEqual({
      mode: "generation",
      modelId: "open-software/auto",
    });

    window.removeEventListener(PROVIDER_MODEL_SETTINGS_CHANGED_EVENT, settingsChanged);
  });

  it("shows the Auto billing note in the picker while a Venice key is saved", async () => {
    const user = userEvent.setup();
    mocks.providerModelSettings.mockResolvedValue({
      settings: {
        transcriptionProvider: "venice",
        generationProvider: "venice",
        transcriptionModel: "nvidia/parakeet-tdt-0.6b-v3",
        generationModel: autoModel.id,
        remoteGenerationModel: autoModel.id,
        costQuality: 100,
        imageModel: "venice-sd35",
        videoModel: "wan-2.2-a14b-text-to-video",
        veniceApiKeyConfigured: true,
        localGeneration: { baseUrl: "", modelId: "", apiKey: "" },
        imageSafeMode: true,
        imageSafeModePromptDismissed: false,
      },
    });

    render(
      createElement(NoteChatPanel, {
        note: { id: "note-1", title: "Launch planning" },
        chat: noteChat(),
        onClose: vi.fn(),
        onOpenInAgent: vi.fn(),
      }),
    );

    await user.click(await screen.findByRole("button", { name: /^Model: Auto/ }));
    const picker = screen.getByRole("dialog", { name: "Choose text model" });
    expect(
      within(picker).getByText(
        "Auto is billed to June credits and does not use your Venice API key.",
      ),
    ).toBeInTheDocument();
  });

  it("keeps a first-run picker change session-local while session creation is pending", async () => {
    const user = userEvent.setup();
    const chat = noteChat({
      working: true,
      submissionPending: true,
      modelSelection: { modelId: currentModel.id },
    });

    render(
      createElement(NoteChatPanel, {
        note: { id: "note-1", title: "Launch planning" },
        chat,
        onClose: vi.fn(),
        onOpenInAgent: vi.fn(),
      }),
    );

    await user.click(await screen.findByRole("button", { name: "Model: GLM 5.2" }));
    const picker = screen.getByRole("dialog", { name: "Choose text model" });
    await user.click(within(picker).getByRole("button", { name: "All models" }));
    await user.click(
      within(screen.getByRole("group", { name: "All text models" })).getByRole("option", {
        name: /^Auto /,
      }),
    );

    expect(chat.setSessionModel).toHaveBeenCalledWith({
      modelId: "open-software/auto",
      costQuality: 100,
    });
    expect(mocks.setCostQuality).not.toHaveBeenCalled();
    expect(mocks.setVeniceModel).not.toHaveBeenCalled();
    expect(mocks.setLocalGenerationEnabled).not.toHaveBeenCalled();
  });

  it("keeps first-run model changes session-local after Stop hides the busy state", async () => {
    const user = userEvent.setup();
    let resolveCreate: (value: { session_id: string; stored_session_id: string }) => void = () =>
      undefined;
    mocks.gatewayRequest.mockImplementation((method: string) => {
      if (method === "session.create") {
        return new Promise((resolve) => {
          resolveCreate = resolve;
        });
      }
      return Promise.resolve({});
    });
    function LiveNoteChatPanel() {
      const chat = useNoteChat({ id: "note-1", title: "Launch planning" });
      return createElement(NoteChatPanel, {
        note: { id: "note-1", title: "Launch planning" },
        chat,
        onClose: vi.fn(),
        onOpenInAgent: vi.fn(),
      });
    }
    render(createElement(LiveNoteChatPanel));

    const composer = await screen.findByRole("textbox");
    await user.type(composer, "What changed?");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("session.create", expect.anything()),
    );
    await user.click(screen.getByRole("button", { name: "Stop June" }));

    await user.click(screen.getByRole("button", { name: "Model: GLM 5.2" }));
    const picker = screen.getByRole("dialog", { name: "Choose text model" });
    await user.click(within(picker).getByRole("button", { name: "All models" }));
    await user.click(
      within(screen.getByRole("group", { name: "All text models" })).getByRole("option", {
        name: /^Auto /,
      }),
    );

    expect(mocks.setCostQuality).not.toHaveBeenCalled();
    expect(mocks.setVeniceModel).not.toHaveBeenCalled();
    expect(mocks.setLocalGenerationEnabled).not.toHaveBeenCalled();

    resolveCreate({
      session_id: "runtime-note-chat",
      stored_session_id: "stored-note-chat",
    });
    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
        session_id: "runtime-note-chat",
        text: expect.stringContaining("What changed?"),
      }),
    );
  });

  it("shows a legacy chat's applied model instead of the app-wide default", async () => {
    mocks.listVeniceModels.mockResolvedValue({
      mode: "generation",
      modelType: "text",
      selectedModel: currentModel.id,
      models: [currentModel, autoModel, legacyModel],
    });

    render(
      createElement(NoteChatPanel, {
        note: { id: "note-1", title: "Launch planning" },
        chat: noteChat({
          storedSessionId: "stored-note-chat",
          appliedHermesModelId: "__june_remote_generation__:kimi-k2-6",
        }),
        onClose: vi.fn(),
        onOpenInAgent: vi.fn(),
      }),
    );

    expect(await screen.findByRole("button", { name: "Model: Kimi K2.6" })).toBeInTheDocument();
  });

  it("switches models on a reopened note chat", async () => {
    rememberNoteChatSession("note-1", "stored-note-chat");

    const { result } = renderHook(() => useNoteChat({ id: "note-1", title: "Launch planning" }));

    await waitFor(() => expect(result.current.storedSessionId).toBe("stored-note-chat"));
    act(() => result.current.setSessionModel({ modelId: "kimi-k2-6" }));

    let accepted = false;
    await act(async () => {
      accepted = await result.current.submit("What remains blocked?");
    });

    expect(accepted).toBe(true);
    expect(mocks.gatewayRequest).toHaveBeenCalledWith("session.resume", {
      session_id: "stored-note-chat",
      cols: 96,
    });
    expect(mocks.gatewayRequest).toHaveBeenCalledWith("config.set", {
      session_id: "runtime-note-chat",
      key: "model",
      value: "__june_remote_generation__:kimi-k2-6 --session",
      confirm_expensive_model: true,
    });
  });

  it("queues a model picked while responding for the next agent run", async () => {
    rememberNoteChatSession("note-1", "stored-note-chat");

    const { result } = renderHook(() => useNoteChat({ id: "note-1", title: "Launch planning" }));

    await waitFor(() => expect(result.current.storedSessionId).toBe("stored-note-chat"));

    await act(async () => {
      expect(await result.current.submit("Summarize the current plan.")).toBe(true);
    });
    expect(result.current.working).toBe(true);

    mocks.gatewayRequest.mockClear();
    act(() => result.current.setSessionModel({ modelId: "kimi-k2-6" }));

    expect(result.current.modelSelection).toEqual({ modelId: "kimi-k2-6" });
    expect(mocks.gatewayRequest).not.toHaveBeenCalled();

    act(() => {
      for (const handler of mocks.gatewayEventHandlers) {
        handler({
          type: "turn.completed",
          session_id: "runtime-note-chat",
          payload: { status: "success" },
        });
      }
    });
    expect(result.current.working).toBe(false);
    expect(mocks.gatewayRequest).not.toHaveBeenCalled();

    await act(async () => {
      expect(await result.current.submit("What should we do next?")).toBe(true);
    });

    expect(mocks.gatewayRequest.mock.calls).toEqual([
      [
        "config.set",
        {
          session_id: "runtime-note-chat",
          key: "model",
          value: "__june_remote_generation__:kimi-k2-6 --session",
          confirm_expensive_model: true,
        },
      ],
      [
        "prompt.submit",
        {
          session_id: "runtime-note-chat",
          text: "What should we do next?",
        },
      ],
    ]);
  });

  it("waits behind an earlier cross-surface Send before submitting the same model", async () => {
    rememberNoteChatSession("note-1", "stored-note-chat");
    rememberAppliedSessionModelSelection("stored-note-chat", { modelId: currentModel.id });
    mocks.listHermesSessions.mockResolvedValue([
      {
        id: "stored-note-chat",
        model: "__june_remote_generation__:zai-org-glm-5-2",
      },
    ]);

    const { result } = renderHook(() => useNoteChat({ id: "note-1", title: "Launch planning" }));
    await waitFor(() => expect(result.current.storedSessionId).toBe("stored-note-chat"));
    await waitFor(() =>
      expect(result.current.appliedHermesModelId).toBe(
        "__june_remote_generation__:zai-org-glm-5-2",
      ),
    );
    mocks.gatewayRequest.mockClear();

    let releaseEarlierSend: () => void = () => undefined;
    const earlierSend = reserveHermesSessionDispatch("stored-note-chat").run(
      () =>
        new Promise<void>((resolve) => {
          releaseEarlierSend = resolve;
        }),
    );
    let noteSubmit: Promise<boolean> = Promise.resolve(false);
    act(() => {
      noteSubmit = result.current.submit("Run after the workspace message.");
    });

    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("session.resume", {
        session_id: "stored-note-chat",
        cols: 96,
      }),
    );
    expect(mocks.gatewayRequest).not.toHaveBeenCalledWith("prompt.submit", expect.anything());

    releaseEarlierSend();
    await earlierSend;
    await act(async () => {
      expect(await noteSubmit).toBe(true);
    });
    expect(mocks.gatewayRequest.mock.calls.slice(-2)).toEqual([
      [
        "config.set",
        {
          session_id: "runtime-note-chat",
          key: "model",
          value: "__june_remote_generation__:zai-org-glm-5-2 --session",
          confirm_expensive_model: true,
        },
      ],
      [
        "prompt.submit",
        {
          session_id: "runtime-note-chat",
          text: "Run after the workspace message.",
        },
      ],
    ]);
  });

  it("never retargets an in-flight send or its failure after switching notes", async () => {
    rememberNoteChatSession("note-a", "stored-a");
    rememberNoteChatSession("note-b", "stored-b");
    rememberAppliedSessionModelSelection("stored-a", { modelId: "kimi-k2-6" });
    rememberAppliedSessionModelSelection("stored-b", { modelId: "zai-org-glm-5-2" });
    let releaseConnection: (() => void) | undefined;
    const connection = new Promise<void>((resolve) => {
      releaseConnection = resolve;
    });
    mocks.gatewayConnect.mockReturnValue(connection);
    mocks.gatewayRequest.mockImplementation((method: string, params?: { session_id?: string }) => {
      if (method === "session.resume") {
        return Promise.resolve({
          session_id: params?.session_id === "stored-a" ? "runtime-a" : "runtime-b",
        });
      }
      if (method === "prompt.submit" && params?.session_id === "runtime-a") {
        return Promise.reject(new Error("Note A failed"));
      }
      return Promise.resolve({});
    });

    const { result, rerender } = renderHook(
      ({ id }) => useNoteChat({ id, title: id === "note-a" ? "Note A" : "Note B" }),
      { initialProps: { id: "note-a" } },
    );
    await waitFor(() => expect(result.current.storedSessionId).toBe("stored-a"));
    const noteASubmit = result.current.submit("Question for A");
    await waitFor(() => expect(mocks.gatewayConnect).toHaveBeenCalled());

    rerender({ id: "note-b" });
    await waitFor(() => expect(result.current.storedSessionId).toBe("stored-b"));
    expect(result.current.submissionPending).toBe(false);
    const noteBSubmit = result.current.submit("Question for B");
    await act(async () => releaseConnection?.());

    await expect(noteASubmit).resolves.toBe(false);
    await expect(noteBSubmit).resolves.toBe(true);
    expect(mocks.gatewayRequest).toHaveBeenCalledWith("session.resume", {
      session_id: "stored-a",
      cols: 96,
    });
    expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
      session_id: "runtime-b",
      text: "Question for B",
    });
    expect(result.current.storedSessionId).toBe("stored-b");
    expect(result.current.working).toBe(true);
    expect(result.current.error).toBeNull();
  });
});
