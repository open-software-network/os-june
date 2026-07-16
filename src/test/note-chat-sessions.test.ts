import { act, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NoteChatPanel } from "../components/note-chat/NoteChatPanel";
import type { AgentChatTurn } from "../lib/agent-chat-runtime";
import {
  forgetNoteChatSession,
  noteChatSessionIdFor,
  rememberNoteChatSession,
} from "../components/note-chat/noteChatSessions";
import {
  type NoteChat,
  resetNoteChatContinuityForTest,
  useNoteChat,
} from "../components/note-chat/useNoteChat";
import { reserveHermesSessionDispatch } from "../lib/hermes-session-dispatch-mutex";
import {
  rememberAppliedSessionModelSelection,
  stageSessionModelSelection,
} from "../lib/hermes-session-model-selection";
import { PROVIDER_MODEL_SETTINGS_CHANGED_EVENT } from "../lib/model-privacy";
import {
  AGENT_RUN_SETTLED_EVENT,
  AGENT_SESSION_STATUS_EVENT,
  type AgentSessionStatusDetail,
} from "../lib/agent-events";
import type { HermesSessionMessage } from "../lib/tauri";

const mocks = vi.hoisted(() => ({
  canAttributeUntaggedAgentRun: vi.fn(() => true),
  cancelAgentRunMonitoring: vi.fn(),
  gatewayRequest: vi.fn(),
  gatewayConnect: vi.fn(),
  gatewayEventHandlers: new Set<(event: Record<string, unknown>) => void>(),
  gatewayCloseHandlers: new Set<() => void>(),
  hermesBridgeImageDataUrl: vi.fn(),
  hermesBridgeSessionMessages: vi.fn(),
  listHermesSessions: vi.fn(),
  hermesBridgeStatus: vi.fn(),
  listVeniceModels: vi.fn(),
  markAgentRunSucceeded: vi.fn(),
  providerModelSettings: vi.fn(),
  setCostQuality: vi.fn(),
  setLocalGenerationEnabled: vi.fn(),
  setVeniceModel: vi.fn(),
  startHermesBridge: vi.fn(),
  startAgentRunMonitoring: vi.fn(),
}));

vi.mock("../lib/agent-run-monitor", () => ({
  canAttributeUntaggedAgentRun: mocks.canAttributeUntaggedAgentRun,
  cancelAgentRunMonitoring: mocks.cancelAgentRunMonitoring,
  markAgentRunSucceeded: mocks.markAgentRunSucceeded,
  startAgentRunMonitoring: mocks.startAgentRunMonitoring,
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

vi.mock("../lib/hermes-adapter", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/hermes-adapter")>()),
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
    onClose = vi.fn((handler: () => void) => {
      mocks.gatewayCloseHandlers.add(handler);
      return () => mocks.gatewayCloseHandlers.delete(handler);
    });
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

function noteChatText(chat: NoteChat, role: AgentChatTurn["role"]) {
  return chat.turns
    .filter((turn) => turn.role === role)
    .flatMap((turn) => turn.parts)
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join(" ");
}

describe("note chat session map", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetNoteChatContinuityForTest();
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
    mocks.canAttributeUntaggedAgentRun.mockReturnValue(true);
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

  it("keeps a newly created session mounted through terminal persistence", async () => {
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
      expect(await result.current.submit("Keep this visible.")).toBe(true);
    });
    const second = renderHook(() => useNoteChat({ id: "note-1", title: "Launch planning" }));
    await waitFor(() => expect(second.result.current.storedSessionId).toBe("stored-note-chat"));
    mocks.markAgentRunSucceeded.mockClear();
    mocks.hermesBridgeSessionMessages.mockResolvedValue({
      messages: [
        {
          id: "persisted-user",
          role: "user",
          content: "Keep this visible.",
          timestamp: "2026-07-16T00:00:00.000Z",
        },
        {
          id: "persisted-answer",
          role: "assistant",
          content: "Still visible.",
          timestamp: "2026-07-16T00:00:01.000Z",
        },
      ],
    });

    act(() => {
      for (const handler of mocks.gatewayEventHandlers) {
        handler({
          type: "message.complete",
          event_id: "fresh-message-complete",
          session_id: "runtime-note-chat",
          payload: { message_id: "persisted-answer", text: "Still visible." },
        });
        handler({
          type: "turn.completed",
          event_id: "fresh-run-terminal",
          session_id: "runtime-note-chat",
          payload: { status: "success" },
        });
      }
    });

    await waitFor(() =>
      expect(noteChatText(result.current, "assistant")).toContain("Still visible."),
    );
    await act(async () => Promise.resolve());
    expect(noteChatText(result.current, "assistant")).toContain("Still visible.");
    expect(noteChatText(second.result.current, "assistant")).toContain("Still visible.");
    expect(mocks.markAgentRunSucceeded).toHaveBeenCalledTimes(1);
  });

  it("synchronizes submit and Stop across two views of the same note chat", async () => {
    rememberNoteChatSession("note-1", "stored-note-chat");
    const first = renderHook(() => useNoteChat({ id: "note-1", title: "Launch planning" }));
    const second = renderHook(() => useNoteChat({ id: "note-1", title: "Launch planning" }));
    await waitFor(() => expect(first.result.current.loading).toBe(false));
    await waitFor(() => expect(second.result.current.loading).toBe(false));

    await act(async () => {
      expect(await first.result.current.submit("Keep both views in sync.")).toBe(true);
    });
    expect(first.result.current.working).toBe(true);
    expect(second.result.current.working).toBe(true);
    expect(noteChatText(second.result.current, "user")).toContain("Keep both views in sync.");
    await act(async () => {
      expect(await second.result.current.submit("Do not submit twice.")).toBe(false);
    });
    expect(
      mocks.gatewayRequest.mock.calls.filter(([method]) => method === "prompt.submit"),
    ).toHaveLength(1);

    act(() => first.result.current.stop());
    expect(first.result.current.working).toBe(false);
    expect(second.result.current.working).toBe(false);
    expect(mocks.cancelAgentRunMonitoring).toHaveBeenCalledTimes(1);
  });

  it("synchronizes an out-of-order transcript refresh across same-note views", async () => {
    rememberNoteChatSession("note-1", "stored-note-chat");
    const refreshResolvers: Array<(value: { messages: HermesSessionMessage[] }) => void> = [];
    mocks.hermesBridgeSessionMessages.mockImplementation(
      () =>
        new Promise<{ messages: HermesSessionMessage[] }>((resolve) => {
          refreshResolvers.push(resolve);
        }),
    );
    const persistedMessages: HermesSessionMessage[] = [
      {
        id: "persisted-user",
        role: "user",
        content: "What changed?",
        timestamp: "2026-07-16T00:00:00.000Z",
      },
      {
        id: "persisted-answer",
        role: "assistant",
        content: "Shared persisted answer.",
        timestamp: "2026-07-16T00:00:01.000Z",
      },
    ];

    const first = renderHook(() => useNoteChat({ id: "note-1", title: "Launch planning" }));
    const second = renderHook(() => useNoteChat({ id: "note-1", title: "Launch planning" }));
    await waitFor(() => expect(refreshResolvers).toHaveLength(2));

    await act(async () => refreshResolvers[1]?.({ messages: persistedMessages }));
    await waitFor(() =>
      expect(noteChatText(second.result.current, "assistant")).toContain(
        "Shared persisted answer.",
      ),
    );
    await act(async () => refreshResolvers[0]?.({ messages: persistedMessages }));
    await waitFor(() => expect(first.result.current.loading).toBe(false));

    expect(noteChatText(first.result.current, "assistant")).toContain("Shared persisted answer.");
  });

  it("serializes a fresh session submit across two views before session creation", async () => {
    let resolveCreate:
      | ((value: { session_id: string; stored_session_id: string }) => void)
      | undefined;
    const created = new Promise<{ session_id: string; stored_session_id: string }>((resolve) => {
      resolveCreate = resolve;
    });
    mocks.gatewayRequest.mockImplementation((method: string) => {
      if (method === "session.create") return created;
      return Promise.resolve({});
    });
    const first = renderHook(() => useNoteChat({ id: "note-1", title: "Launch planning" }));
    const second = renderHook(() => useNoteChat({ id: "note-1", title: "Launch planning" }));

    let firstSubmission: Promise<boolean> = Promise.resolve(false);
    act(() => {
      firstSubmission = first.result.current.submit("Create this once.");
    });
    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("session.create", expect.anything()),
    );
    await act(async () => {
      expect(await second.result.current.submit("Do not create another.")).toBe(false);
    });
    expect(
      mocks.gatewayRequest.mock.calls.filter(([method]) => method === "session.create"),
    ).toHaveLength(1);

    await act(async () =>
      resolveCreate?.({
        session_id: "runtime-note-chat",
        stored_session_id: "stored-note-chat",
      }),
    );
    await expect(firstSubmission).resolves.toBe(true);
    expect(second.result.current.storedSessionId).toBe("stored-note-chat");
    expect(second.result.current.working).toBe(true);
    expect(noteChatText(second.result.current, "user")).toContain("Create this once.");
  });

  it("shares and cancels a fresh same-note submit before session creation resolves", async () => {
    let resolveCreate:
      | ((value: { session_id: string; stored_session_id: string }) => void)
      | undefined;
    mocks.gatewayRequest.mockImplementation((method: string) => {
      if (method === "session.create") {
        return new Promise((resolve) => {
          resolveCreate = resolve;
        });
      }
      return Promise.resolve({});
    });
    const first = renderHook(() => useNoteChat({ id: "note-1", title: "Launch planning" }));
    const peer = renderHook(() => useNoteChat({ id: "note-1", title: "Launch planning" }));

    const submission = first.result.current.submit("Cancel this creation.");
    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("session.create", expect.anything()),
    );
    expect(peer.result.current.working).toBe(true);
    expect(noteChatText(peer.result.current, "user")).toContain("Cancel this creation.");

    act(() => peer.result.current.stop());
    await act(async () =>
      resolveCreate?.({
        session_id: "runtime-note-chat",
        stored_session_id: "stored-note-chat",
      }),
    );

    await expect(submission).resolves.toBe(false);
    expect(first.result.current.working).toBe(false);
    expect(peer.result.current.working).toBe(false);
    expect(mocks.gatewayRequest).not.toHaveBeenCalledWith("prompt.submit", expect.anything());
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

  it("keeps a keyed assistant markdown node mounted when earlier activity appears", () => {
    const textPart = {
      type: "text" as const,
      text: "Stable answer\n\nMEDIA:/tmp/keyed-ima",
      status: "running" as const,
      renderKey: "m1:text:0",
    };
    const imagePart = {
      type: "image" as const,
      status: "running" as const,
      prompt: "Keyed image",
    };
    const turn = {
      id: "m1",
      role: "assistant" as const,
      createdAt: "2026-06-04T10:00:00.000Z",
      status: "running" as const,
      parts: [textPart, imagePart],
    };
    const panelProps = {
      note: { id: "note-1", title: "Launch planning" },
      onClose: vi.fn(),
      onOpenInAgent: vi.fn(),
    };
    const view = render(
      createElement(NoteChatPanel, {
        ...panelProps,
        chat: noteChat({ turns: [turn] }),
      }),
    );
    const firstNode = view.container.querySelector(".agent-markdown");
    expect(firstNode).not.toBeNull();
    expect(firstNode).toHaveTextContent("Stable answer");
    expect(firstNode).not.toHaveTextContent("MEDIA:");

    view.rerender(
      createElement(NoteChatPanel, {
        ...panelProps,
        chat: noteChat({
          turns: [
            {
              ...turn,
              status: "complete",
              parts: [
                {
                  type: "tool",
                  id: "tool-1",
                  name: "Search",
                  text: "",
                  status: "complete",
                },
                { ...textPart, status: "complete" },
                { ...imagePart, status: "complete" },
              ],
            },
          ],
        }),
      }),
    );

    expect(view.container.querySelector(".agent-markdown")).toBe(firstNode);
    expect(firstNode).not.toHaveTextContent("MEDIA:");
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
    await act(async () => {
      await Promise.resolve();
    });
    expect(mocks.gatewayRequest).not.toHaveBeenCalledWith("prompt.submit", expect.anything());
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

  it("keeps the opening text after more than 200 note-chat deltas", async () => {
    rememberNoteChatSession("note-1", "stored-note-chat");
    const { result } = renderHook(() => useNoteChat({ id: "note-1", title: "Launch planning" }));
    await waitFor(() => expect(result.current.storedSessionId).toBe("stored-note-chat"));
    await act(async () => {
      expect(await result.current.submit("Stream the full answer.")).toBe(true);
    });

    const chunks = Array.from({ length: 205 }, (_, index) => `chunk-${index}|`);
    act(() => {
      for (const handler of mocks.gatewayEventHandlers) {
        handler({
          type: "message.start",
          session_id: "runtime-note-chat",
          payload: { message_id: "long-message" },
        });
        for (const chunk of chunks) {
          handler({
            type: "message.delta",
            session_id: "runtime-note-chat",
            payload: { message_id: "long-message", delta: chunk },
          });
        }
      }
    });

    const assistantText = result.current.turns
      .filter((turn) => turn.role === "assistant")
      .flatMap((turn) => turn.parts)
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("");
    expect(assistantText).toBe(chunks.join(""));
  });

  it("keeps note chat active after message completion until one lifecycle terminal", async () => {
    rememberNoteChatSession("note-1", "stored-note-chat");
    const { result } = renderHook(() => useNoteChat({ id: "note-1", title: "Launch planning" }));
    await waitFor(() => expect(result.current.storedSessionId).toBe("stored-note-chat"));
    await act(async () => {
      expect(await result.current.submit("Complete the whole run.")).toBe(true);
    });

    act(() => {
      for (const handler of mocks.gatewayEventHandlers) {
        handler({
          type: "message.start",
          session_id: "runtime-note-chat",
          payload: { message_id: "m1" },
        });
        handler({
          type: "message.delta",
          session_id: "runtime-note-chat",
          payload: { message_id: "m1", delta: "First answer." },
        });
        handler({
          type: "message.complete",
          session_id: "runtime-note-chat",
          payload: { message_id: "m1", text: "First answer." },
        });
        handler({
          type: "tool.start",
          session_id: "runtime-note-chat",
          payload: { tool_id: "read-1", tool_name: "read_file", path: "README.md" },
        });
        handler({
          type: "message.start",
          session_id: "runtime-note-chat",
          payload: { message_id: "m2" },
        });
        handler({
          type: "message.delta",
          session_id: "runtime-note-chat",
          payload: { message_id: "m2", delta: "Continuation after the tool." },
        });
      }
    });

    expect(result.current.working).toBe(true);
    expect(mocks.markAgentRunSucceeded).not.toHaveBeenCalledWith("stored-note-chat");
    const parts = result.current.turns.flatMap((turn) => turn.parts);
    expect(parts).toContainEqual(expect.objectContaining({ type: "tool", id: "read-1" }));
    expect(parts).toContainEqual(
      expect.objectContaining({ type: "text", text: "Continuation after the tool." }),
    );

    const retainedHandlers = [...mocks.gatewayEventHandlers];
    act(() => {
      for (const handler of retainedHandlers) {
        handler({
          type: "turn.completed",
          session_id: "runtime-note-chat",
          payload: { status: "success" },
        });
      }
    });
    expect(result.current.working).toBe(false);
    expect(mocks.markAgentRunSucceeded).toHaveBeenCalledTimes(1);
    act(() => {
      for (const handler of retainedHandlers) {
        handler({
          type: "turn.completed",
          session_id: "runtime-note-chat",
          payload: { status: "success" },
        });
      }
    });
    expect(mocks.markAgentRunSucceeded).toHaveBeenCalledTimes(1);
  });

  it("defers a newly delivered tagged terminal until prompt submission is accepted", async () => {
    rememberNoteChatSession("note-1", "stored-note-chat");
    let acceptPrompt: (() => void) | undefined;
    const promptAccepted = new Promise<void>((resolve) => {
      acceptPrompt = resolve;
    });
    mocks.gatewayRequest.mockImplementation((method: string) => {
      if (method === "session.resume") {
        return Promise.resolve({ session_id: "runtime-note-chat" });
      }
      if (method === "prompt.submit") return promptAccepted;
      if (method === "session.active_list") {
        return Promise.resolve({
          sessions: [
            {
              id: "runtime-note-chat",
              session_key: "stored-note-chat",
              status: "idle",
            },
          ],
        });
      }
      return Promise.resolve({});
    });
    const { result } = renderHook(() => useNoteChat({ id: "note-1", title: "Launch planning" }));
    await waitFor(() => expect(result.current.storedSessionId).toBe("stored-note-chat"));
    await waitFor(() => expect(result.current.loading).toBe(false));

    let submission: Promise<boolean> = Promise.resolve(false);
    act(() => {
      submission = result.current.submit("Wait for acknowledgement.");
    });
    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
        session_id: "runtime-note-chat",
        text: "Wait for acknowledgement.",
      }),
    );
    act(() => {
      for (const handler of mocks.gatewayEventHandlers) {
        handler({
          type: "turn.completed",
          event_id: "new-terminal-before-ack",
          session_id: "runtime-note-chat",
          payload: { status: "success" },
        });
      }
    });

    expect(result.current.working).toBe(true);
    expect(mocks.markAgentRunSucceeded).not.toHaveBeenCalled();

    mocks.hermesBridgeSessionMessages.mockResolvedValue({
      messages: [
        {
          id: "current-user",
          role: "user",
          content: "Wait for acknowledgement.",
          timestamp: new Date().toISOString(),
        },
        {
          id: "current-assistant",
          role: "assistant",
          content: "Done.",
          timestamp: new Date(Date.now() + 1_000).toISOString(),
        },
      ],
    });
    await act(async () => acceptPrompt?.());
    await expect(submission).resolves.toBe(true);
    await waitFor(() => expect(result.current.working).toBe(false));
    expect(mocks.markAgentRunSucceeded).toHaveBeenCalledWith("stored-note-chat");
    expect(mocks.startAgentRunMonitoring).toHaveBeenCalledWith(
      expect.objectContaining({ storedSessionId: "stored-note-chat" }),
    );
  });

  it("settles a current pre-ack failure after rejecting a stale success candidate", async () => {
    rememberNoteChatSession("note-1", "stored-note-chat");
    let acceptPrompt: (() => void) | undefined;
    const promptAccepted = new Promise<void>((resolve) => {
      acceptPrompt = resolve;
    });
    mocks.gatewayRequest.mockImplementation((method: string) => {
      if (method === "session.resume") {
        return Promise.resolve({ session_id: "runtime-note-chat" });
      }
      if (method === "prompt.submit") return promptAccepted;
      if (method === "session.active_list") {
        return Promise.resolve({
          sessions: [
            {
              id: "runtime-note-chat",
              session_key: "stored-note-chat",
              status: "idle",
            },
          ],
        });
      }
      return Promise.resolve({});
    });
    const { result } = renderHook(() => useNoteChat({ id: "note-1", title: "Launch planning" }));
    await waitFor(() => expect(result.current.loading).toBe(false));

    let submission: Promise<boolean> = Promise.resolve(false);
    act(() => {
      submission = result.current.submit("Fail the current acknowledged run.");
    });
    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
        session_id: "runtime-note-chat",
        text: "Fail the current acknowledged run.",
      }),
    );
    const handler = [...mocks.gatewayEventHandlers].at(-1);
    act(() => {
      handler?.({
        type: "turn.completed",
        event_id: "stale-success-before-ack",
        session_id: "runtime-note-chat",
        payload: { status: "success" },
      });
      handler?.({
        type: "error",
        event_id: "current-failure-before-ack",
        session_id: "runtime-note-chat",
        payload: { message: "Current run failed", code: 500, recoverable: false },
      });
    });
    mocks.hermesBridgeSessionMessages.mockResolvedValue({
      messages: [
        {
          id: "current-user",
          role: "user",
          content: "Fail the current acknowledged run.",
          timestamp: new Date().toISOString(),
        },
      ],
    });

    await act(async () => acceptPrompt?.());
    await expect(submission).resolves.toBe(true);
    await waitFor(() => expect(result.current.working).toBe(false));
    expect(result.current.error).toBe("Current run failed");
    expect(mocks.markAgentRunSucceeded).not.toHaveBeenCalled();
  });

  it("settles a current pre-ack success after rejecting a stale failure candidate", async () => {
    rememberNoteChatSession("note-1", "stored-note-chat");
    let acceptPrompt: (() => void) | undefined;
    const promptAccepted = new Promise<void>((resolve) => {
      acceptPrompt = resolve;
    });
    mocks.gatewayRequest.mockImplementation((method: string) => {
      if (method === "session.resume") {
        return Promise.resolve({ session_id: "runtime-note-chat" });
      }
      if (method === "prompt.submit") return promptAccepted;
      if (method === "session.active_list") {
        return Promise.resolve({
          sessions: [
            {
              id: "runtime-note-chat",
              session_key: "stored-note-chat",
              status: "idle",
            },
          ],
        });
      }
      return Promise.resolve({});
    });
    const { result } = renderHook(() => useNoteChat({ id: "note-1", title: "Launch planning" }));
    await waitFor(() => expect(result.current.loading).toBe(false));

    let submission: Promise<boolean> = Promise.resolve(false);
    act(() => {
      submission = result.current.submit("Complete the current acknowledged run.");
    });
    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
        session_id: "runtime-note-chat",
        text: "Complete the current acknowledged run.",
      }),
    );
    const handler = [...mocks.gatewayEventHandlers].at(-1);
    act(() => {
      handler?.({
        type: "error",
        event_id: "stale-failure-before-ack",
        session_id: "runtime-note-chat",
        payload: { message: "Stale prior run failed", code: 500, recoverable: false },
      });
      handler?.({
        type: "turn.completed",
        event_id: "current-success-before-ack",
        session_id: "runtime-note-chat",
        payload: { status: "success" },
      });
    });
    mocks.hermesBridgeSessionMessages.mockResolvedValue({
      messages: [
        {
          id: "current-user",
          role: "user",
          content: "Complete the current acknowledged run.",
          timestamp: new Date().toISOString(),
        },
        {
          id: "current-assistant",
          role: "assistant",
          content: "Current run completed.",
          timestamp: new Date(Date.now() + 1_000).toISOString(),
        },
      ],
    });

    await act(async () => acceptPrompt?.());
    await expect(submission).resolves.toBe(true);
    await waitFor(() => expect(result.current.working).toBe(false));
    expect(result.current.error).toBeNull();
    expect(mocks.markAgentRunSucceeded).toHaveBeenCalledWith("stored-note-chat");
  });

  it.each([
    ["absent", []],
    [
      "still working",
      [
        {
          id: "runtime-note-chat",
          session_key: "stored-note-chat",
          status: "working",
        },
      ],
    ],
  ])("leaves a deferred terminal to monitoring when runtime authority is %s", async (_label, sessions) => {
    rememberNoteChatSession("note-1", "stored-note-chat");
    let acceptPrompt: (() => void) | undefined;
    const promptAccepted = new Promise<void>((resolve) => {
      acceptPrompt = resolve;
    });
    mocks.gatewayRequest.mockImplementation((method: string) => {
      if (method === "session.resume") {
        return Promise.resolve({ session_id: "runtime-note-chat" });
      }
      if (method === "prompt.submit") return promptAccepted;
      if (method === "session.active_list") return Promise.resolve({ sessions });
      return Promise.resolve({});
    });
    const { result } = renderHook(() => useNoteChat({ id: "note-1", title: "Launch planning" }));
    await waitFor(() => expect(result.current.storedSessionId).toBe("stored-note-chat"));

    let submission: Promise<boolean> = Promise.resolve(false);
    act(() => {
      submission = result.current.submit("Wait for runtime authority.");
    });
    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", expect.anything()),
    );
    act(() => {
      for (const handler of mocks.gatewayEventHandlers) {
        handler({
          type: "turn.completed",
          event_id: "deferred-terminal-without-authority",
          session_id: "runtime-note-chat",
          payload: { status: "success" },
        });
      }
    });
    mocks.hermesBridgeSessionMessages.mockResolvedValue({
      messages: [
        {
          id: "current-user",
          role: "user",
          content: "Wait for runtime authority.",
          timestamp: new Date().toISOString(),
        },
        {
          id: "current-assistant",
          role: "assistant",
          content: "Done.",
          timestamp: new Date(Date.now() + 1_000).toISOString(),
        },
      ],
    });

    await act(async () => acceptPrompt?.());
    await expect(submission).resolves.toBe(true);
    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("session.active_list", {}),
    );
    await act(async () => Promise.resolve());
    expect(result.current.working).toBe(true);
    expect(mocks.markAgentRunSucceeded).not.toHaveBeenCalled();
    expect(mocks.startAgentRunMonitoring).toHaveBeenCalledWith(
      expect.objectContaining({ storedSessionId: "stored-note-chat" }),
    );
  });

  it("discards an eligible untagged terminal when prompt submission is rejected", async () => {
    rememberNoteChatSession("note-1", "stored-note-chat");
    let rejectPrompt: ((reason: Error) => void) | undefined;
    const promptRejected = new Promise<void>((_resolve, reject) => {
      rejectPrompt = reject;
    });
    mocks.gatewayRequest.mockImplementation((method: string) => {
      if (method === "session.resume") {
        return Promise.resolve({ session_id: "runtime-note-chat" });
      }
      if (method === "prompt.submit") return promptRejected;
      return Promise.resolve({});
    });
    const { result } = renderHook(() => useNoteChat({ id: "note-1", title: "Launch planning" }));
    await waitFor(() => expect(result.current.storedSessionId).toBe("stored-note-chat"));

    let submission: Promise<boolean> = Promise.resolve(true);
    act(() => {
      submission = result.current.submit("Reject this prompt.");
    });
    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
        session_id: "runtime-note-chat",
        text: "Reject this prompt.",
      }),
    );
    act(() => {
      for (const handler of mocks.gatewayEventHandlers) {
        handler({
          type: "turn.completed",
          event_id: "eligible-untagged-terminal",
          payload: { status: "success" },
        });
      }
    });
    expect(result.current.working).toBe(true);
    expect(mocks.markAgentRunSucceeded).not.toHaveBeenCalled();

    await act(async () => rejectPrompt?.(new Error("submit rejected")));
    await expect(submission).resolves.toBe(false);
    expect(result.current.working).toBe(false);
    expect(result.current.error).toBe("submit rejected");
    expect(mocks.markAgentRunSucceeded).not.toHaveBeenCalled();
    expect(mocks.startAgentRunMonitoring).not.toHaveBeenCalled();
  });

  it("invalidates a closed note-chat runtime and resumes before later events", async () => {
    rememberNoteChatSession("note-1", "stored-note-chat");
    let resumeCount = 0;
    mocks.gatewayRequest.mockImplementation((method: string) => {
      if (method === "session.resume") {
        resumeCount += 1;
        return Promise.resolve({
          session_id: resumeCount === 1 ? "runtime-before-close" : "runtime-after-close",
        });
      }
      return Promise.resolve({});
    });
    const { result } = renderHook(() => useNoteChat({ id: "note-1", title: "Launch planning" }));
    await waitFor(() => expect(result.current.storedSessionId).toBe("stored-note-chat"));
    await act(async () => {
      expect(await result.current.submit("Survive reconnect.")).toBe(true);
    });

    const beforeCloseHandler = [...mocks.gatewayEventHandlers].at(-1);
    act(() => {
      beforeCloseHandler?.({
        type: "message.start",
        session_id: "runtime-before-close",
        payload: { message_id: "m1" },
      });
      beforeCloseHandler?.({
        type: "message.delta",
        session_id: "runtime-before-close",
        payload: { message_id: "m1", delta: "Hello " },
      });
      for (const close of mocks.gatewayCloseHandlers) close();
    });

    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("session.resume", {
        session_id: "stored-note-chat",
        cols: 96,
      }),
    );
    await waitFor(() => expect(resumeCount).toBe(2));
    const recoveredHandler = [...mocks.gatewayEventHandlers].at(-1);
    act(() => {
      recoveredHandler?.({
        type: "message.start",
        session_id: "runtime-after-close",
        payload: { message_id: "m1" },
      });
      recoveredHandler?.({
        type: "message.delta",
        session_id: "runtime-after-close",
        payload: { message_id: "m1", delta: "Hello " },
      });
      recoveredHandler?.({
        type: "message.complete",
        session_id: "runtime-after-close",
        payload: { message_id: "m1", text: "Hello world" },
      });
    });

    const assistantText = result.current.turns
      .filter((turn) => turn.role === "assistant")
      .flatMap((turn) => turn.parts)
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("");
    expect(assistantText).toBe("Hello world");

    act(() => {
      recoveredHandler?.({
        type: "turn.completed",
        session_id: "runtime-after-close",
        payload: { status: "success" },
      });
    });
    await waitFor(() => expect(result.current.working).toBe(false));

    mocks.gatewayRequest.mockClear();
    await act(async () => {
      expect(await result.current.submit("Use the recovered runtime.")).toBe(true);
    });
    expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
      session_id: "runtime-after-close",
      text: "Use the recovered runtime.",
    });
    expect(mocks.gatewayRequest).not.toHaveBeenCalledWith(
      "session.resume",
      expect.objectContaining({ session_id: "stored-note-chat" }),
    );
  });

  it("retries recovery when the replacement gateway closes during session resume", async () => {
    rememberNoteChatSession("note-1", "stored-note-chat");
    let resumeCount = 0;
    let rejectRecovery: ((reason: Error) => void) | undefined;
    const heldRecovery = new Promise<{ session_id: string }>((_resolve, reject) => {
      rejectRecovery = reject;
    });
    mocks.gatewayRequest.mockImplementation((method: string) => {
      if (method !== "session.resume") return Promise.resolve({});
      resumeCount += 1;
      if (resumeCount === 1) return Promise.resolve({ session_id: "runtime-before-close" });
      if (resumeCount === 2) return heldRecovery;
      return Promise.resolve({ session_id: "runtime-after-second-close" });
    });
    const { result } = renderHook(() => useNoteChat({ id: "note-1", title: "Launch planning" }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => {
      expect(await result.current.submit("Recover through both closes.")).toBe(true);
    });

    act(() => {
      [...mocks.gatewayCloseHandlers].at(-1)?.();
    });
    await waitFor(() => expect(resumeCount).toBe(2));
    act(() => {
      [...mocks.gatewayCloseHandlers].at(-1)?.();
    });
    await act(async () => {
      rejectRecovery?.(new Error("replacement gateway closed"));
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => expect(resumeCount).toBe(3));
    expect(mocks.gatewayRequest).toHaveBeenCalledWith("session.resume", {
      session_id: "stored-note-chat",
      cols: 96,
    });
  });

  it("interrupts a resumed runtime when Stop lands during reconnect", async () => {
    rememberNoteChatSession("note-1", "stored-note-chat");
    let resumeCount = 0;
    let finishRecovery: ((value: { session_id: string }) => void) | undefined;
    const recovery = new Promise<{ session_id: string }>((resolve) => {
      finishRecovery = resolve;
    });
    mocks.gatewayRequest.mockImplementation((method: string) => {
      if (method === "session.resume") {
        resumeCount += 1;
        if (resumeCount === 1) return Promise.resolve({ session_id: "runtime-before-close" });
        if (resumeCount === 2) return recovery;
        return Promise.resolve({ session_id: "runtime-new-run" });
      }
      return Promise.resolve({});
    });
    const { result } = renderHook(() => useNoteChat({ id: "note-1", title: "Launch planning" }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => {
      expect(await result.current.submit("Reconnect this run.")).toBe(true);
    });

    act(() => {
      for (const close of mocks.gatewayCloseHandlers) close();
    });
    await waitFor(() => expect(resumeCount).toBe(2));
    act(() => result.current.stop());
    await act(async () => finishRecovery?.({ session_id: "runtime-after-close" }));

    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("session.interrupt", {
        session_id: "runtime-after-close",
      }),
    );
    mocks.gatewayRequest.mockClear();
    await act(async () => {
      expect(await result.current.submit("Start on a clean runtime.")).toBe(true);
    });
    expect(mocks.gatewayRequest).toHaveBeenCalledWith("session.resume", {
      session_id: "stored-note-chat",
      cols: 96,
    });
    expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
      session_id: "runtime-new-run",
      text: "Start on a clean runtime.",
    });
    expect(mocks.gatewayRequest).not.toHaveBeenCalledWith("prompt.submit", {
      session_id: "runtime-after-close",
      text: "Start on a clean runtime.",
    });
  });

  it("serializes a same-ID replacement resume through the stale interrupt", async () => {
    rememberNoteChatSession("note-1", "stored-note-chat");
    let resumeCount = 0;
    let finishStoppedRecovery: ((value: { session_id: string }) => void) | undefined;
    let finishStoppedInterrupt: (() => void) | undefined;
    const stoppedRecovery = new Promise<{ session_id: string }>((resolve) => {
      finishStoppedRecovery = resolve;
    });
    const stoppedInterrupt = new Promise<void>((resolve) => {
      finishStoppedInterrupt = resolve;
    });
    mocks.gatewayRequest.mockImplementation((method: string, params?: { session_id?: string }) => {
      if (method === "session.resume") {
        resumeCount += 1;
        if (resumeCount === 1) return Promise.resolve({ session_id: "runtime-before-close" });
        if (resumeCount === 2) return stoppedRecovery;
        return Promise.resolve({ session_id: "runtime-shared" });
      }
      if (method === "session.interrupt" && params?.session_id === "runtime-shared") {
        return stoppedInterrupt;
      }
      return Promise.resolve({});
    });
    const { result } = renderHook(() => useNoteChat({ id: "note-1", title: "Launch planning" }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => {
      expect(await result.current.submit("Reconnect the old run.")).toBe(true);
    });

    act(() => {
      for (const close of mocks.gatewayCloseHandlers) close();
    });
    await waitFor(() => expect(resumeCount).toBe(2));
    act(() => result.current.stop());

    let newSubmission: Promise<boolean> = Promise.resolve(false);
    act(() => {
      newSubmission = result.current.submit("Start the new run now.");
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(resumeCount).toBe(2);
    expect(mocks.gatewayRequest).not.toHaveBeenCalledWith("prompt.submit", {
      session_id: "runtime-shared",
      text: "Start the new run now.",
    });

    await act(async () => finishStoppedRecovery?.({ session_id: "runtime-shared" }));
    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("session.interrupt", {
        session_id: "runtime-shared",
      }),
    );
    expect(resumeCount).toBe(2);
    expect(mocks.gatewayRequest).not.toHaveBeenCalledWith("prompt.submit", {
      session_id: "runtime-shared",
      text: "Start the new run now.",
    });

    await act(async () => finishStoppedInterrupt?.());
    await waitFor(() => expect(resumeCount).toBe(3));
    await act(async () => {
      expect(await newSubmission).toBe(true);
    });
    expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
      session_id: "runtime-shared",
      text: "Start the new run now.",
    });
  });

  it("waits for Stop to interrupt an existing runtime before resuming Submit", async () => {
    rememberNoteChatSession("note-1", "stored-note-chat");
    let resumeCount = 0;
    let finishStoppedInterrupt: (() => void) | undefined;
    const stoppedInterrupt = new Promise<void>((resolve) => {
      finishStoppedInterrupt = resolve;
    });
    mocks.gatewayRequest.mockImplementation((method: string, params?: { session_id?: string }) => {
      if (method === "session.resume") {
        resumeCount += 1;
        return Promise.resolve({
          session_id: resumeCount === 1 ? "runtime-before-stop" : "runtime-after-stop",
        });
      }
      if (method === "session.interrupt" && params?.session_id === "runtime-before-stop") {
        return stoppedInterrupt;
      }
      return Promise.resolve({});
    });
    const { result } = renderHook(() => useNoteChat({ id: "note-1", title: "Launch planning" }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => {
      expect(await result.current.submit("Run before Stop.")).toBe(true);
    });
    expect(resumeCount).toBe(1);

    act(() => result.current.stop());
    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("session.interrupt", {
        session_id: "runtime-before-stop",
      }),
    );
    let replacement: Promise<boolean> = Promise.resolve(false);
    act(() => {
      replacement = result.current.submit("Run after Stop.");
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(resumeCount).toBe(1);
    expect(mocks.gatewayRequest).not.toHaveBeenCalledWith("prompt.submit", {
      session_id: "runtime-before-stop",
      text: "Run after Stop.",
    });

    await act(async () => finishStoppedInterrupt?.());
    await waitFor(() => expect(resumeCount).toBe(2));
    await act(async () => {
      expect(await replacement).toBe(true);
    });
    expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
      session_id: "runtime-after-stop",
      text: "Run after Stop.",
    });
  });

  it("recovers an offscreen working note after the shared gateway closes", async () => {
    rememberNoteChatSession("note-1", "stored-note-chat");
    let resumeCount = 0;
    mocks.gatewayRequest.mockImplementation((method: string) => {
      if (method === "session.resume") {
        resumeCount += 1;
        return Promise.resolve({
          session_id: resumeCount === 1 ? "runtime-before-close" : "runtime-after-close",
        });
      }
      return Promise.resolve({});
    });
    const first = renderHook(() => useNoteChat({ id: "note-1", title: "Launch planning" }));
    await waitFor(() => expect(first.result.current.storedSessionId).toBe("stored-note-chat"));
    await act(async () => {
      expect(await first.result.current.submit("Keep working offscreen.")).toBe(true);
    });
    first.unmount();

    act(() => {
      for (const close of mocks.gatewayCloseHandlers) close();
    });

    await waitFor(() => expect(resumeCount).toBe(2));
    const recoveredHandler = [...mocks.gatewayEventHandlers].at(-1);
    act(() => {
      recoveredHandler?.({
        type: "message.complete",
        session_id: "runtime-after-close",
        payload: { message_id: "m1", text: "Recovered while offscreen." },
      });
    });

    const second = renderHook(() => useNoteChat({ id: "note-1", title: "Launch planning" }));
    await waitFor(() => expect(second.result.current.storedSessionId).toBe("stored-note-chat"));
    expect(noteChatText(second.result.current, "assistant")).toContain(
      "Recovered while offscreen.",
    );
    expect(second.result.current.working).toBe(true);
  });

  it("keeps reconnect authority when the panel switches notes during session resume", async () => {
    rememberNoteChatSession("note-a", "stored-a");
    rememberNoteChatSession("note-b", "stored-b");
    let resumeCount = 0;
    let finishRecovery: ((value: { session_id: string }) => void) | undefined;
    const recovery = new Promise<{ session_id: string }>((resolve) => {
      finishRecovery = resolve;
    });
    mocks.gatewayRequest.mockImplementation((method: string, params?: { session_id?: string }) => {
      if (method !== "session.resume") return Promise.resolve({});
      resumeCount += 1;
      if (params?.session_id === "stored-a" && resumeCount === 1) {
        return Promise.resolve({ session_id: "runtime-before-close" });
      }
      if (params?.session_id === "stored-a") return recovery;
      return Promise.resolve({ session_id: "runtime-b" });
    });

    const { result, rerender } = renderHook(
      ({ id }) => useNoteChat({ id, title: id === "note-a" ? "Note A" : "Note B" }),
      { initialProps: { id: "note-a" } },
    );
    await waitFor(() => expect(result.current.storedSessionId).toBe("stored-a"));
    await act(async () => {
      expect(await result.current.submit("Keep Note A running.")).toBe(true);
    });
    act(() => {
      for (const close of mocks.gatewayCloseHandlers) close();
    });
    await waitFor(() => expect(resumeCount).toBe(2));

    rerender({ id: "note-b" });
    await waitFor(() => expect(result.current.storedSessionId).toBe("stored-b"));
    await act(async () => finishRecovery?.({ session_id: "runtime-after-close" }));
    const recoveredHandler = [...mocks.gatewayEventHandlers].at(-1);
    act(() => {
      recoveredHandler?.({
        type: "message.complete",
        session_id: "runtime-after-close",
        payload: { message_id: "m1", text: "Note A kept streaming." },
      });
    });

    rerender({ id: "note-a" });
    await waitFor(() => expect(result.current.storedSessionId).toBe("stored-a"));
    expect(noteChatText(result.current, "assistant")).toContain("Note A kept streaming.");
    expect(result.current.working).toBe(true);
  });

  it("keeps the markdown node and post-watermark events during persisted hydration", async () => {
    rememberNoteChatSession("note-1", "stored-note-chat");
    const user = userEvent.setup();
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
    await waitFor(() => expect(mocks.hermesBridgeSessionMessages).toHaveBeenCalledTimes(1));
    mocks.hermesBridgeSessionMessages.mockClear();

    let resolveHydration: (value: {
      messages: Array<{
        id: string;
        role: "assistant";
        content: string;
        timestamp: string;
      }>;
    }) => void = () => undefined;
    const hydrationPromise = new Promise<{
      messages: Array<{
        id: string;
        role: "assistant";
        content: string;
        timestamp: string;
      }>;
    }>((resolve) => {
      resolveHydration = resolve;
    });
    mocks.hermesBridgeSessionMessages.mockReturnValue(hydrationPromise);
    await user.type(await screen.findByRole("textbox"), "Hydrate this answer.");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
        session_id: "runtime-note-chat",
        text: "Hydrate this answer.",
      }),
    );

    act(() => {
      for (const handler of mocks.gatewayEventHandlers) {
        handler({
          type: "message.start",
          session_id: "runtime-note-chat",
          payload: { message_id: "m1" },
        });
        handler({
          type: "message.delta",
          session_id: "runtime-note-chat",
          payload: { message_id: "m1", delta: "Stable answer" },
        });
        handler({
          type: "message.complete",
          session_id: "runtime-note-chat",
          payload: { message_id: "m1", text: "Stable answer" },
        });
      }
    });
    const firstMarkdown = (await screen.findByText("Stable answer")).closest(".agent-markdown");
    expect(firstMarkdown).not.toBeNull();
    await waitFor(() => expect(mocks.hermesBridgeSessionMessages).toHaveBeenCalled());

    act(() => {
      for (const handler of mocks.gatewayEventHandlers) {
        handler({
          type: "message.start",
          session_id: "runtime-note-chat",
          payload: { message_id: "m2" },
        });
        handler({
          type: "message.delta",
          session_id: "runtime-note-chat",
          payload: { message_id: "m2", delta: "Post watermark event." },
        });
      }
      resolveHydration({
        messages: [
          {
            id: "m1",
            role: "assistant",
            content: "Stable answer plus",
            timestamp: "2026-06-04T10:00:01.000Z",
          },
        ],
      });
    });

    expect(await screen.findByText("Stable answer plus")).toBeInTheDocument();
    expect(await screen.findByText("Post watermark event.")).toBeInTheDocument();
    expect(screen.getByText("Stable answer plus").closest(".agent-markdown")).toBe(firstMarkdown);
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
    await waitFor(() =>
      expect(mocks.markAgentRunSucceeded).toHaveBeenCalledWith("stored-note-chat"),
    );
    mocks.gatewayRequest.mockClear();

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

  it("hands a completed note chat to app-lifetime settlement monitoring", async () => {
    rememberNoteChatSession("note-1", "stored-note-chat");
    mocks.gatewayRequest.mockImplementation((method: string) => {
      if (method === "session.resume") {
        return Promise.resolve({ session_id: "runtime-note-chat" });
      }
      return Promise.resolve({});
    });
    const { result } = renderHook(() => useNoteChat({ id: "note-1", title: "Launch planning" }));
    await waitFor(() => expect(result.current.storedSessionId).toBe("stored-note-chat"));
    await act(async () => {
      expect(await result.current.submit("Summarize the current plan.")).toBe(true);
    });
    expect(mocks.startAgentRunMonitoring).toHaveBeenCalledWith({
      storedSessionId: "stored-note-chat",
      runtimeSessionId: "runtime-note-chat",
      title: "Launch planning",
      fullMode: false,
      settlementHeld: false,
    });

    act(() => {
      for (const handler of mocks.gatewayEventHandlers) {
        handler({
          type: "turn.completed",
          session_id: "runtime-note-chat",
          payload: { status: "success" },
        });
      }
    });
    expect(mocks.markAgentRunSucceeded).toHaveBeenCalledWith("stored-note-chat");
  });

  it("keeps monitoring a note-chat run after its panel unmounts", async () => {
    rememberNoteChatSession("note-1", "stored-note-chat");
    const { result, unmount } = renderHook(() =>
      useNoteChat({ id: "note-1", title: "Launch planning" }),
    );
    await waitFor(() => expect(result.current.storedSessionId).toBe("stored-note-chat"));
    await act(async () => {
      expect(await result.current.submit("Summarize the current plan.")).toBe(true);
    });

    unmount();

    expect(mocks.cancelAgentRunMonitoring).not.toHaveBeenCalledWith("stored-note-chat");
  });

  it("preserves a note-chat run and offscreen continuation across panel remount", async () => {
    rememberNoteChatSession("note-1", "stored-note-chat");
    const first = renderHook(() => useNoteChat({ id: "note-1", title: "Launch planning" }));
    await waitFor(() => expect(first.result.current.storedSessionId).toBe("stored-note-chat"));
    await waitFor(() => expect(mocks.hermesBridgeSessionMessages).toHaveBeenCalled());

    let resolvePersistence: (value: { messages: HermesSessionMessage[] }) => void = () => undefined;
    const persistence = new Promise<{ messages: HermesSessionMessage[] }>((resolve) => {
      resolvePersistence = resolve;
    });
    mocks.hermesBridgeSessionMessages.mockClear();
    mocks.hermesBridgeSessionMessages.mockReturnValue(persistence);
    await act(async () => {
      expect(await first.result.current.submit("Follow the whole run.")).toBe(true);
    });

    act(() => {
      for (const handler of mocks.gatewayEventHandlers) {
        handler({
          type: "message.start",
          session_id: "runtime-note-chat",
          payload: { message_id: "m1" },
        });
        handler({
          type: "message.delta",
          session_id: "runtime-note-chat",
          payload: { message_id: "m1", delta: "First answer." },
        });
        handler({
          type: "message.complete",
          session_id: "runtime-note-chat",
          payload: { message_id: "m1", text: "First answer." },
        });
      }
    });
    await waitFor(() => expect(mocks.hermesBridgeSessionMessages).toHaveBeenCalled());
    first.unmount();

    act(() => {
      for (const handler of mocks.gatewayEventHandlers) {
        handler({
          type: "tool.start",
          session_id: "runtime-note-chat",
          payload: { tool_id: "read-1", tool_name: "read_file", path: "README.md" },
        });
        handler({
          type: "message.start",
          session_id: "runtime-note-chat",
          payload: { message_id: "m2" },
        });
        handler({
          type: "message.complete",
          session_id: "runtime-note-chat",
          payload: { message_id: "m2", text: "Continuation after the tool." },
        });
        handler({
          type: "turn.completed",
          session_id: "runtime-note-chat",
          payload: { status: "success" },
        });
      }
    });

    const second = renderHook(() => useNoteChat({ id: "note-1", title: "Launch planning" }));
    await waitFor(() => expect(second.result.current.storedSessionId).toBe("stored-note-chat"));
    expect(noteChatText(second.result.current, "user")).toContain("Follow the whole run.");
    expect(noteChatText(second.result.current, "assistant")).toContain("First answer.");
    expect(noteChatText(second.result.current, "assistant")).toContain(
      "Continuation after the tool.",
    );
    expect(second.result.current.working).toBe(false);

    resolvePersistence({ messages: [] });
  });

  it("retains an unpersisted structured continuation across a settled remount", async () => {
    rememberNoteChatSession("note-1", "stored-note-chat");
    const first = renderHook(() => useNoteChat({ id: "note-1", title: "Launch planning" }));
    await waitFor(() => expect(first.result.current.loading).toBe(false));
    await act(async () => {
      expect(await first.result.current.submit("Keep the structured continuation.")).toBe(true);
    });

    const laggingMessages: HermesSessionMessage[] = [
      {
        id: "persisted-user",
        role: "user",
        content: "Keep the structured continuation.",
        timestamp: new Date(Date.now() + 1_000).toISOString(),
      },
      {
        id: "m1",
        role: "assistant",
        content: "Persisted opening answer.",
        timestamp: new Date(Date.now() + 2_000).toISOString(),
      },
    ];
    mocks.hermesBridgeSessionMessages.mockClear();
    mocks.hermesBridgeSessionMessages.mockResolvedValue({ messages: laggingMessages });
    const handler = [...mocks.gatewayEventHandlers].at(-1);
    act(() => {
      handler?.({
        type: "message.complete",
        event_id: "persisted-opening-answer",
        session_id: "runtime-note-chat",
        payload: { message_id: "m1", text: "Persisted opening answer." },
      });
      handler?.({
        type: "tool.start",
        event_id: "structured-tool-start",
        session_id: "runtime-note-chat",
        payload: { tool_call_id: "structured-tool", name: "read_file", path: "README.md" },
      });
      handler?.({
        type: "tool.complete",
        event_id: "structured-tool-complete",
        session_id: "runtime-note-chat",
        payload: {
          tool_call_id: "structured-tool",
          name: "read_file",
          text: "README loaded.",
        },
      });
      handler?.({
        type: "turn.completed",
        event_id: "structured-run-terminal",
        session_id: "runtime-note-chat",
        payload: { status: "success" },
      });
    });
    await waitFor(() => expect(first.result.current.working).toBe(false));
    await waitFor(() =>
      expect(mocks.hermesBridgeSessionMessages.mock.calls.length).toBeGreaterThanOrEqual(2),
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    first.unmount();

    let resolveRehydration: ((value: { messages: HermesSessionMessage[] }) => void) | undefined;
    mocks.hermesBridgeSessionMessages.mockReturnValue(
      new Promise((resolve) => {
        resolveRehydration = resolve;
      }),
    );
    const remount = renderHook(() => useNoteChat({ id: "note-1", title: "Launch planning" }));
    await waitFor(() => expect(remount.result.current.storedSessionId).toBe("stored-note-chat"));
    expect(
      remount.result.current.turns
        .flatMap((turn) => turn.parts)
        .find((part) => part.type === "tool" && part.id === "structured-tool"),
    ).toEqual(expect.objectContaining({ status: "complete", text: "README loaded." }));

    await act(async () => resolveRehydration?.({ messages: laggingMessages }));
    await waitFor(() => expect(remount.result.current.loading).toBe(false));
  });

  it("does not evict an unpersisted offscreen answer at the continuity cap", async () => {
    rememberNoteChatSession("lagging-note", "stored-lagging-note");
    const first = renderHook(() =>
      useNoteChat({ id: "lagging-note", title: "Lagging persistence" }),
    );
    await waitFor(() => expect(first.result.current.loading).toBe(false));
    await act(async () => {
      expect(await first.result.current.submit("Keep this unresolved answer.")).toBe(true);
    });

    const persistedUser: HermesSessionMessage = {
      id: "lagging-user",
      role: "user",
      content: "Keep this unresolved answer.",
      timestamp: new Date(Date.now() + 1_000).toISOString(),
    };
    mocks.hermesBridgeSessionMessages.mockClear();
    mocks.hermesBridgeSessionMessages.mockResolvedValue({ messages: [persistedUser] });
    first.unmount();
    const handler = [...mocks.gatewayEventHandlers].at(-1);
    act(() => {
      handler?.({
        type: "message.delta",
        event_id: "lagging-offscreen-answer",
        session_id: "runtime-note-chat",
        payload: { delta: "Unpersisted canonical answer." },
      });
      handler?.({
        type: "turn.completed",
        event_id: "lagging-offscreen-terminal",
        session_id: "runtime-note-chat",
        payload: { status: "success" },
      });
    });
    await waitFor(() => expect(mocks.hermesBridgeSessionMessages).toHaveBeenCalledTimes(1));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    for (let index = 0; index < 20; index += 1) {
      const noteId = `safe-note-${index}`;
      rememberNoteChatSession(noteId, `stored-safe-${index}`);
      const safe = renderHook(() => useNoteChat({ id: noteId, title: `Safe ${index}` }));
      await waitFor(() => expect(safe.result.current.loading).toBe(false));
      safe.unmount();
    }

    let resolveLaggingHydration:
      | ((value: { messages: HermesSessionMessage[] }) => void)
      | undefined;
    mocks.hermesBridgeSessionMessages.mockReturnValue(
      new Promise((resolve) => {
        resolveLaggingHydration = resolve;
      }),
    );
    const remount = renderHook(() =>
      useNoteChat({ id: "lagging-note", title: "Lagging persistence" }),
    );
    await waitFor(() => expect(remount.result.current.storedSessionId).toBe("stored-lagging-note"));
    expect(noteChatText(remount.result.current, "assistant")).toContain(
      "Unpersisted canonical answer.",
    );

    await act(async () => resolveLaggingHydration?.({ messages: [persistedUser] }));
    await waitFor(() => expect(remount.result.current.loading).toBe(false));
  });

  it("drops a fully persisted settled offscreen payload and rehydrates it on remount", async () => {
    rememberNoteChatSession("note-1", "stored-note-chat");
    const first = renderHook(() => useNoteChat({ id: "note-1", title: "Launch planning" }));
    await waitFor(() => expect(first.result.current.loading).toBe(false));
    await act(async () => {
      expect(await first.result.current.submit("Persist this run.")).toBe(true);
    });

    const persistedMessages: HermesSessionMessage[] = [
      {
        id: "persisted-user",
        role: "user",
        content: "Persist this run.",
        timestamp: new Date(Date.now() - 60_000).toISOString(),
      },
      {
        id: "persisted-answer",
        role: "assistant",
        content: "Persisted answer.",
        timestamp: new Date(Date.now() - 59_000).toISOString(),
      },
      ...Array.from(
        { length: 80 },
        (_, index): HermesSessionMessage => ({
          id: `persisted-tool-result-${index}`,
          role: "tool",
          content: `Read result ${index}.`,
          tool_call_id: `tool-${index}`,
          tool_name: "read_file",
          timestamp: new Date(Date.now() - 58_000 + index).toISOString(),
        }),
      ),
    ];
    mocks.hermesBridgeSessionMessages.mockClear();
    let resolveOffscreenPersistence:
      | ((value: { messages: HermesSessionMessage[] }) => void)
      | undefined;
    const offscreenPersistence = new Promise<{ messages: HermesSessionMessage[] }>((resolve) => {
      resolveOffscreenPersistence = resolve;
    });
    mocks.hermesBridgeSessionMessages.mockReturnValue(offscreenPersistence);
    first.unmount();
    act(() => {
      for (const handler of mocks.gatewayEventHandlers) {
        handler({
          type: "message.complete",
          event_id: "persisted-message-complete",
          session_id: "runtime-note-chat",
          payload: { message_id: "persisted-answer", text: "Persisted answer." },
        });
        for (let index = 0; index < 80; index += 1) {
          handler({
            type: "tool.start",
            event_id: `settled-tool-${index}`,
            session_id: "runtime-note-chat",
            payload: { tool_id: `tool-${index}`, tool_name: "read_file", path: `${index}.md` },
          });
        }
        handler({
          type: "turn.completed",
          event_id: "persisted-run-terminal",
          session_id: "runtime-note-chat",
          payload: { status: "success" },
        });
      }
    });
    await waitFor(() => expect(mocks.hermesBridgeSessionMessages).toHaveBeenCalled());
    await act(async () => resolveOffscreenPersistence?.({ messages: persistedMessages }));
    await act(async () => Promise.resolve());

    let resolveRehydration: ((value: { messages: HermesSessionMessage[] }) => void) | undefined;
    const rehydration = new Promise<{ messages: HermesSessionMessage[] }>((resolve) => {
      resolveRehydration = resolve;
    });
    mocks.hermesBridgeSessionMessages.mockReturnValue(rehydration);
    const second = renderHook(() => useNoteChat({ id: "note-1", title: "Launch planning" }));
    await waitFor(() => expect(second.result.current.storedSessionId).toBe("stored-note-chat"));
    expect(second.result.current.turns).toEqual([]);

    await act(async () => resolveRehydration?.({ messages: persistedMessages }));
    await waitFor(() =>
      expect(noteChatText(second.result.current, "assistant")).toContain("Persisted answer."),
    );

    await act(async () => {
      expect(await second.result.current.submit("Start a later run.")).toBe(true);
    });
    act(() => {
      for (const handler of mocks.gatewayEventHandlers) {
        handler({
          type: "turn.completed",
          event_id: "persisted-run-terminal",
          session_id: "runtime-note-chat",
          payload: { status: "success" },
        });
      }
    });
    expect(second.result.current.working).toBe(true);

    const persistedThroughSecondRun: HermesSessionMessage[] = [
      ...persistedMessages,
      {
        id: "later-user",
        role: "user",
        content: "Start a later run.",
        timestamp: new Date(Date.now() + 2_000).toISOString(),
      },
      {
        id: "later-assistant",
        role: "assistant",
        content: "Later answer.",
        timestamp: new Date(Date.now() + 3_000).toISOString(),
      },
    ];
    mocks.hermesBridgeSessionMessages.mockResolvedValue({ messages: persistedThroughSecondRun });
    act(() => {
      for (const handler of mocks.gatewayEventHandlers) {
        handler({
          type: "turn.completed",
          session_id: "runtime-note-chat",
          payload: { status: "success" },
        });
      }
    });
    await waitFor(() => expect(second.result.current.working).toBe(false));
    await waitFor(() =>
      expect(noteChatText(second.result.current, "assistant")).toContain("Later answer."),
    );
    second.unmount();
    await act(async () => Promise.resolve());

    let resolveThirdHydration: ((value: { messages: HermesSessionMessage[] }) => void) | undefined;
    const thirdHydration = new Promise<{ messages: HermesSessionMessage[] }>((resolve) => {
      resolveThirdHydration = resolve;
    });
    mocks.hermesBridgeSessionMessages.mockReturnValue(thirdHydration);
    const third = renderHook(() => useNoteChat({ id: "note-1", title: "Launch planning" }));
    await waitFor(() => expect(third.result.current.storedSessionId).toBe("stored-note-chat"));
    expect(third.result.current.turns).toEqual([]);
    mocks.gatewayRequest.mockImplementation((method: string) => {
      if (method === "session.active_list") {
        return Promise.resolve({
          sessions: [
            {
              id: "runtime-note-chat",
              session_key: "stored-note-chat",
              status: "idle",
            },
          ],
        });
      }
      return Promise.resolve({});
    });
    await act(async () => {
      expect(await third.result.current.submit("Persist this run.")).toBe(true);
    });
    act(() => {
      for (const handler of mocks.gatewayEventHandlers) {
        handler({
          type: "turn.completed",
          session_id: "runtime-note-chat",
          payload: { status: "success" },
        });
      }
    });
    await act(async () => resolveThirdHydration?.({ messages: persistedThroughSecondRun }));
    await waitFor(() => expect(third.result.current.loading).toBe(false));
    await act(async () => Promise.resolve());
    expect(third.result.current.working).toBe(true);

    act(() => {
      for (const handler of mocks.gatewayEventHandlers) {
        handler({
          type: "turn.completed",
          event_id: "persisted-run-terminal",
          session_id: "runtime-note-chat",
          payload: { status: "success" },
        });
      }
    });
    expect(third.result.current.working).toBe(true);

    act(() => {
      for (const handler of mocks.gatewayEventHandlers) {
        handler({
          type: "turn.completed",
          event_id: "third-run-terminal",
          session_id: "runtime-note-chat",
          payload: { status: "success" },
        });
      }
    });
    expect(third.result.current.working).toBe(false);
  });

  it("retains an idless transcript until persistence covers it, then compacts", async () => {
    rememberNoteChatSession("note-1", "stored-note-chat");
    const first = renderHook(() => useNoteChat({ id: "note-1", title: "Launch planning" }));
    await waitFor(() => expect(first.result.current.loading).toBe(false));
    await act(async () => {
      expect(await first.result.current.submit("Keep the unkeyed answer.")).toBe(true);
    });

    const persistedUser: HermesSessionMessage = {
      id: "persisted-user",
      role: "user",
      content: "Keep the unkeyed answer.",
      timestamp: new Date(Date.now() + 1_000).toISOString(),
    };
    mocks.hermesBridgeSessionMessages.mockClear();
    mocks.hermesBridgeSessionMessages.mockResolvedValue({ messages: [persistedUser] });
    first.unmount();
    const handler = [...mocks.gatewayEventHandlers].at(-1);
    act(() => {
      handler?.({
        type: "message.delta",
        event_id: "unkeyed-answer-delta",
        session_id: "runtime-note-chat",
        payload: { delta: "Unkeyed answer remains visible." },
      });
      handler?.({
        type: "turn.completed",
        event_id: "unkeyed-answer-terminal",
        session_id: "runtime-note-chat",
        payload: { status: "success" },
      });
    });
    await waitFor(() => expect(mocks.hermesBridgeSessionMessages).toHaveBeenCalledTimes(1));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    let resolveRehydration: ((value: { messages: HermesSessionMessage[] }) => void) | undefined;
    mocks.hermesBridgeSessionMessages.mockReturnValue(
      new Promise((resolve) => {
        resolveRehydration = resolve;
      }),
    );
    const second = renderHook(() => useNoteChat({ id: "note-1", title: "Launch planning" }));
    await waitFor(() => expect(second.result.current.storedSessionId).toBe("stored-note-chat"));

    expect(noteChatText(second.result.current, "assistant")).toContain(
      "Unkeyed answer remains visible.",
    );
    const coveredMessages: HermesSessionMessage[] = [
      persistedUser,
      {
        id: "persisted-assistant",
        role: "assistant",
        content: "Unkeyed answer remains visible.",
        timestamp: new Date(Date.now() + 2_000).toISOString(),
      },
    ];
    await act(async () => resolveRehydration?.({ messages: coveredMessages }));
    await waitFor(() => expect(second.result.current.loading).toBe(false));
    second.unmount();

    let resolveFinalHydration: ((value: { messages: HermesSessionMessage[] }) => void) | undefined;
    mocks.hermesBridgeSessionMessages.mockReturnValue(
      new Promise((resolve) => {
        resolveFinalHydration = resolve;
      }),
    );
    const third = renderHook(() => useNoteChat({ id: "note-1", title: "Launch planning" }));
    await waitFor(() => expect(third.result.current.storedSessionId).toBe("stored-note-chat"));
    expect(third.result.current.turns).toEqual([]);

    await act(async () => resolveFinalHydration?.({ messages: coveredMessages }));
    await waitFor(() =>
      expect(noteChatText(third.result.current, "assistant")).toContain(
        "Unkeyed answer remains visible.",
      ),
    );
  });

  it.each([
    ["conflicting", "A different persisted answer."],
    ["shorter", "Unkeyed answer remains"],
  ])("retains idless live text when persistence is %s", async (_kind, persistedAnswer) => {
    rememberNoteChatSession("note-1", "stored-note-chat");
    const first = renderHook(() => useNoteChat({ id: "note-1", title: "Launch planning" }));
    await waitFor(() => expect(first.result.current.loading).toBe(false));
    await act(async () => {
      expect(await first.result.current.submit("Keep the exact live answer.")).toBe(true);
    });

    const persistedMessages: HermesSessionMessage[] = [
      {
        id: "persisted-user",
        role: "user",
        content: "Keep the exact live answer.",
        timestamp: new Date(Date.now() + 1_000).toISOString(),
      },
      {
        id: "persisted-assistant",
        role: "assistant",
        content: persistedAnswer,
        timestamp: new Date(Date.now() + 2_000).toISOString(),
      },
    ];
    mocks.hermesBridgeSessionMessages.mockClear();
    mocks.hermesBridgeSessionMessages.mockResolvedValue({ messages: persistedMessages });
    first.unmount();
    const handler = [...mocks.gatewayEventHandlers].at(-1);
    act(() => {
      handler?.({
        type: "message.delta",
        event_id: `idless-${_kind}-delta`,
        session_id: "runtime-note-chat",
        payload: { delta: "Unkeyed answer remains visible." },
      });
      handler?.({
        type: "turn.completed",
        event_id: `idless-${_kind}-terminal`,
        session_id: "runtime-note-chat",
        payload: { status: "success" },
      });
    });
    await waitFor(() => expect(mocks.hermesBridgeSessionMessages).toHaveBeenCalledTimes(1));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    let resolveRehydration: ((value: { messages: HermesSessionMessage[] }) => void) | undefined;
    mocks.hermesBridgeSessionMessages.mockReturnValue(
      new Promise((resolve) => {
        resolveRehydration = resolve;
      }),
    );
    const second = renderHook(() => useNoteChat({ id: "note-1", title: "Launch planning" }));
    await waitFor(() => expect(second.result.current.storedSessionId).toBe("stored-note-chat"));
    expect(noteChatText(second.result.current, "assistant")).toContain(
      "Unkeyed answer remains visible.",
    );

    await act(async () => resolveRehydration?.({ messages: persistedMessages }));
    await waitFor(() => expect(second.result.current.loading).toBe(false));
  });

  it("compacts late post-terminal idless text after compatible persistence", async () => {
    rememberNoteChatSession("note-1", "stored-note-chat");
    const first = renderHook(() => useNoteChat({ id: "note-1", title: "Launch planning" }));
    await waitFor(() => expect(first.result.current.loading).toBe(false));
    await act(async () => {
      expect(await first.result.current.submit("Persist the late answer.")).toBe(true);
    });

    const persistedUser: HermesSessionMessage = {
      id: "persisted-user",
      role: "user",
      content: "Persist the late answer.",
      timestamp: new Date(Date.now() + 1_000).toISOString(),
    };
    mocks.hermesBridgeSessionMessages.mockClear();
    mocks.hermesBridgeSessionMessages.mockResolvedValue({ messages: [persistedUser] });
    const handler = [...mocks.gatewayEventHandlers].at(-1);
    act(() => {
      handler?.({
        type: "turn.completed",
        event_id: "late-idless-terminal",
        session_id: "runtime-note-chat",
        payload: { status: "success" },
      });
    });
    await waitFor(() => expect(mocks.hermesBridgeSessionMessages).toHaveBeenCalledTimes(1));

    const coveredMessages: HermesSessionMessage[] = [
      persistedUser,
      {
        id: "persisted-assistant",
        role: "assistant",
        content: "Late answer persisted completely.",
        timestamp: new Date(Date.now() + 2_000).toISOString(),
      },
    ];
    mocks.hermesBridgeSessionMessages.mockClear();
    mocks.hermesBridgeSessionMessages.mockResolvedValue({ messages: coveredMessages });
    act(() => {
      handler?.({
        type: "message.complete",
        event_id: "late-idless-complete",
        session_id: "runtime-note-chat",
        payload: { text: "Late answer persisted completely." },
      });
    });
    await waitFor(() => expect(mocks.hermesBridgeSessionMessages).toHaveBeenCalledTimes(1));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    first.unmount();

    let resolveFinalHydration: ((value: { messages: HermesSessionMessage[] }) => void) | undefined;
    mocks.hermesBridgeSessionMessages.mockReturnValue(
      new Promise((resolve) => {
        resolveFinalHydration = resolve;
      }),
    );
    const second = renderHook(() => useNoteChat({ id: "note-1", title: "Launch planning" }));
    await waitFor(() => expect(second.result.current.storedSessionId).toBe("stored-note-chat"));
    expect(second.result.current.turns).toEqual([]);

    await act(async () => resolveFinalHydration?.({ messages: coveredMessages }));
    await waitFor(() =>
      expect(noteChatText(second.result.current, "assistant")).toContain(
        "Late answer persisted completely.",
      ),
    );
  });

  it("retains distinct complete-only idless turns until every segment persists", async () => {
    rememberNoteChatSession("note-1", "stored-note-chat");
    const first = renderHook(() => useNoteChat({ id: "note-1", title: "Launch planning" }));
    await waitFor(() => expect(first.result.current.loading).toBe(false));
    await act(async () => {
      expect(await first.result.current.submit("Keep both idless answers.")).toBe(true);
    });

    const persistedMessages: HermesSessionMessage[] = [
      {
        id: "persisted-user",
        role: "user",
        content: "Keep both idless answers.",
        timestamp: new Date(Date.now() + 1_000).toISOString(),
      },
      {
        id: "persisted-first-assistant",
        role: "assistant",
        content: "First complete-only answer.",
        timestamp: new Date(Date.now() + 2_000).toISOString(),
      },
    ];
    mocks.hermesBridgeSessionMessages.mockClear();
    mocks.hermesBridgeSessionMessages.mockResolvedValue({ messages: persistedMessages });
    const handler = [...mocks.gatewayEventHandlers].at(-1);
    act(() => {
      handler?.({
        type: "message.complete",
        event_id: "first-complete-only-idless",
        session_id: "runtime-note-chat",
        payload: { text: "First complete-only answer." },
      });
      handler?.({
        type: "message.complete",
        event_id: "second-complete-only-idless",
        session_id: "runtime-note-chat",
        payload: { text: "Second complete-only answer." },
      });
      handler?.({
        type: "turn.completed",
        event_id: "complete-only-idless-terminal",
        session_id: "runtime-note-chat",
        payload: { status: "success" },
      });
    });
    const liveAssistantTexts = first.result.current.turns
      .filter((turn) => turn.role === "assistant")
      .map((turn) =>
        turn.parts
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join(""),
      );
    expect(liveAssistantTexts).toEqual([
      "First complete-only answer.",
      "Second complete-only answer.",
    ]);
    await waitFor(() => expect(mocks.hermesBridgeSessionMessages).toHaveBeenCalledTimes(3));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    first.unmount();

    let resolveRehydration: ((value: { messages: HermesSessionMessage[] }) => void) | undefined;
    mocks.hermesBridgeSessionMessages.mockReturnValue(
      new Promise((resolve) => {
        resolveRehydration = resolve;
      }),
    );
    const second = renderHook(() => useNoteChat({ id: "note-1", title: "Launch planning" }));
    await waitFor(() => expect(second.result.current.storedSessionId).toBe("stored-note-chat"));
    expect(noteChatText(second.result.current, "assistant")).toContain(
      "Second complete-only answer.",
    );

    await act(async () => resolveRehydration?.({ messages: persistedMessages }));
    await waitFor(() => expect(second.result.current.loading).toBe(false));
  });

  it("binds repeated-prompt idless proof to the earliest eligible persisted run", async () => {
    rememberNoteChatSession("note-1", "stored-note-chat");
    const first = renderHook(() => useNoteChat({ id: "note-1", title: "Launch planning" }));
    await waitFor(() => expect(first.result.current.loading).toBe(false));
    await act(async () => {
      expect(await first.result.current.submit("Repeat this prompt.")).toBe(true);
    });

    const firstRunMessages: HermesSessionMessage[] = [
      {
        id: "first-repeated-user",
        role: "user",
        content: "Repeat this prompt.",
        timestamp: new Date(Date.now() + 1_000).toISOString(),
      },
      {
        id: "first-conflicting-assistant",
        role: "assistant",
        content: "Conflicting first persistence.",
        timestamp: new Date(Date.now() + 2_000).toISOString(),
      },
    ];
    mocks.hermesBridgeSessionMessages.mockClear();
    mocks.hermesBridgeSessionMessages.mockResolvedValue({ messages: firstRunMessages });
    const handler = [...mocks.gatewayEventHandlers].at(-1);
    act(() => {
      handler?.({
        type: "message.delta",
        event_id: "first-repeated-live-answer",
        session_id: "runtime-note-chat",
        payload: { delta: "Canonical" },
      });
      handler?.({
        type: "turn.completed",
        event_id: "first-repeated-terminal",
        session_id: "runtime-note-chat",
        payload: { status: "success" },
      });
    });
    await waitFor(() => expect(mocks.hermesBridgeSessionMessages).toHaveBeenCalledTimes(1));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      expect(await first.result.current.submit("Repeat this prompt.")).toBe(true);
    });
    const secondRunMessages: HermesSessionMessage[] = [
      ...firstRunMessages,
      {
        id: "second-repeated-user",
        role: "user",
        content: "Repeat this prompt.",
        timestamp: new Date(Date.now() + 3_000).toISOString(),
      },
      {
        id: "second-matching-assistant",
        role: "assistant",
        content: "Canonical extended",
        timestamp: new Date(Date.now() + 4_000).toISOString(),
      },
    ];
    mocks.hermesBridgeSessionMessages.mockClear();
    mocks.hermesBridgeSessionMessages.mockResolvedValue({ messages: secondRunMessages });
    act(() => {
      handler?.({
        type: "message.delta",
        event_id: "second-repeated-live-answer",
        session_id: "runtime-note-chat",
        payload: { delta: "Canonical extended" },
      });
      handler?.({
        type: "turn.completed",
        event_id: "second-repeated-terminal",
        session_id: "runtime-note-chat",
        payload: { status: "success" },
      });
    });
    await waitFor(() => expect(mocks.hermesBridgeSessionMessages).toHaveBeenCalledTimes(1));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    first.unmount();

    let resolveRehydration: ((value: { messages: HermesSessionMessage[] }) => void) | undefined;
    mocks.hermesBridgeSessionMessages.mockReturnValue(
      new Promise((resolve) => {
        resolveRehydration = resolve;
      }),
    );
    const remount = renderHook(() => useNoteChat({ id: "note-1", title: "Launch planning" }));
    await waitFor(() => expect(remount.result.current.storedSessionId).toBe("stored-note-chat"));
    expect(noteChatText(remount.result.current, "assistant")).toContain("Canonical");

    await act(async () => resolveRehydration?.({ messages: secondRunMessages }));
    await waitFor(() => expect(remount.result.current.loading).toBe(false));
  });

  it("keeps the newest transcript refresh and unmatched optimistic user turn", async () => {
    rememberNoteChatSession("note-1", "stored-note-chat");
    const { result } = renderHook(() => useNoteChat({ id: "note-1", title: "Launch planning" }));
    await waitFor(() => expect(result.current.storedSessionId).toBe("stored-note-chat"));
    await waitFor(() => expect(mocks.hermesBridgeSessionMessages).toHaveBeenCalled());
    mocks.hermesBridgeSessionMessages.mockClear();

    let resolveOlder: (value: { messages: HermesSessionMessage[] }) => void = () => undefined;
    let resolveNewer: (value: { messages: HermesSessionMessage[] }) => void = () => undefined;
    const older = new Promise<{ messages: HermesSessionMessage[] }>((resolve) => {
      resolveOlder = resolve;
    });
    const newer = new Promise<{ messages: HermesSessionMessage[] }>((resolve) => {
      resolveNewer = resolve;
    });
    mocks.hermesBridgeSessionMessages.mockReturnValueOnce(older).mockReturnValueOnce(newer);
    await act(async () => {
      expect(await result.current.submit("Still pending question.")).toBe(true);
    });

    act(() => {
      for (const handler of mocks.gatewayEventHandlers) {
        handler({
          type: "message.complete",
          session_id: "runtime-note-chat",
          payload: { message_id: "m1", text: "First live answer." },
        });
      }
    });
    await waitFor(() => expect(mocks.hermesBridgeSessionMessages).toHaveBeenCalledTimes(1));
    act(() => {
      for (const handler of mocks.gatewayEventHandlers) {
        handler({
          type: "message.complete",
          session_id: "runtime-note-chat",
          payload: { message_id: "m2", text: "Second live answer." },
        });
      }
    });
    await waitFor(() => expect(mocks.hermesBridgeSessionMessages).toHaveBeenCalledTimes(2));

    await act(async () => {
      resolveNewer({
        messages: [
          {
            id: "server-only-new",
            role: "assistant",
            content: "Persisted later insight.",
            timestamp: "2026-07-16T00:00:03.000Z",
          },
          {
            id: "m1",
            role: "assistant",
            content: "First live answer.",
            timestamp: "2026-07-16T00:00:04.000Z",
          },
          {
            id: "m2",
            role: "assistant",
            content: "Second live answer.",
            timestamp: "2026-07-16T00:00:05.000Z",
          },
        ],
      });
      await newer;
    });
    expect(noteChatText(result.current, "user")).toContain("Still pending question.");
    expect(noteChatText(result.current, "assistant")).toContain("Persisted later insight.");

    await act(async () => {
      resolveOlder({
        messages: [
          {
            id: "m1",
            role: "assistant",
            content: "First live answer.",
            timestamp: "2026-07-16T00:00:04.000Z",
          },
        ],
      });
      await older;
    });
    expect(noteChatText(result.current, "user")).toContain("Still pending question.");
    expect(noteChatText(result.current, "assistant")).toContain("Persisted later insight.");
  });

  it("reconciles an attachment prompt persisted more than five seconds after its optimistic turn", async () => {
    rememberNoteChatSession("note-1", "stored-note-chat");
    const first = renderHook(() => useNoteChat({ id: "note-1", title: "Launch planning" }));
    await waitFor(() => expect(first.result.current.storedSessionId).toBe("stored-note-chat"));
    await waitFor(() => expect(first.result.current.loading).toBe(false));
    const attachment = {
      id: "attachment-1",
      name: "brief.pdf",
      path: "/tmp/hermes/workspace/uploads/brief.pdf",
      rootLabel: "Workspace",
      size: 42,
      previewDataUrl: null,
      attach: {
        localId: "attachment-1",
        kind: "file" as const,
        displayName: "brief.pdf",
        workspacePath: "/tmp/hermes/workspace/uploads/brief.pdf",
        status: "imported" as const,
      },
    };
    await act(async () => {
      expect(await first.result.current.submit("Review the brief.", [attachment])).toBe(true);
    });
    expect(first.result.current.turns.filter((turn) => turn.role === "user")).toHaveLength(1);
    first.unmount();

    const persistedMessages: HermesSessionMessage[] = [
      {
        id: "persisted-user",
        role: "user",
        content: [
          "Review the brief.",
          "",
          "Attached files copied into the June workspace:",
          "- brief.pdf (Workspace): uploads/brief.pdf",
          "",
          "Use these file paths when inspecting or operating on the files.",
        ].join("\n"),
        timestamp: new Date(Date.now() + 30_000).toISOString(),
      },
      {
        id: "persisted-assistant",
        role: "assistant",
        content: "The brief is clear.",
        timestamp: new Date(Date.now() + 31_000).toISOString(),
      },
    ];
    mocks.hermesBridgeSessionMessages.mockClear();
    mocks.hermesBridgeSessionMessages.mockResolvedValue({ messages: persistedMessages });
    const second = renderHook(() => useNoteChat({ id: "note-1", title: "Launch planning" }));
    await waitFor(() => expect(mocks.hermesBridgeSessionMessages).toHaveBeenCalledTimes(1));
    await act(async () => {
      await mocks.hermesBridgeSessionMessages.mock.results.at(-1)?.value;
    });
    await waitFor(() => expect(second.result.current.loading).toBe(false));
    await waitFor(() =>
      expect(noteChatText(second.result.current, "assistant")).toContain("The brief is clear."),
    );
    expect(second.result.current.turns.filter((turn) => turn.role === "user")).toHaveLength(1);
  });

  it("reconciles an attachment-only first prompt with its persisted fallback text", async () => {
    mocks.gatewayRequest.mockImplementation((method: string) => {
      if (method === "session.create") {
        return Promise.resolve({
          session_id: "runtime-note-chat",
          stored_session_id: "stored-note-chat",
        });
      }
      return Promise.resolve({});
    });
    const attachment = {
      id: "attachment-1",
      name: "brief.pdf",
      path: "/tmp/hermes/workspace/uploads/brief.pdf",
      rootLabel: "Workspace",
      size: 42,
      previewDataUrl: null,
      attach: {
        localId: "attachment-1",
        kind: "file" as const,
        displayName: "brief.pdf",
        workspacePath: "/tmp/hermes/workspace/uploads/brief.pdf",
        status: "imported" as const,
      },
    };
    const { result } = renderHook(() => useNoteChat({ id: "note-1", title: "Launch planning" }));
    await act(async () => {
      expect(await result.current.submit("", [attachment])).toBe(true);
    });
    expect(mocks.gatewayRequest).toHaveBeenCalledWith(
      "prompt.submit",
      expect.objectContaining({
        text: expect.stringContaining('@note:note-1 ("Launch planning") Use the attached file(s).'),
      }),
    );

    mocks.hermesBridgeSessionMessages.mockResolvedValue({
      messages: [
        {
          id: "persisted-user",
          role: "user",
          content: [
            '@note:note-1 ("Launch planning") Use the attached file(s).',
            "",
            "Attached files copied into the June workspace:",
            "- brief.pdf (Workspace): uploads/brief.pdf",
            "",
            "Use these file paths when inspecting or operating on the files.",
          ].join("\n"),
          timestamp: new Date(Date.now() + 1_000).toISOString(),
        },
        {
          id: "persisted-assistant",
          role: "assistant",
          content: "The brief is ready.",
          timestamp: new Date(Date.now() + 2_000).toISOString(),
        },
      ],
    });
    act(() => {
      for (const handler of mocks.gatewayEventHandlers) {
        handler({
          type: "message.complete",
          event_id: "attachment-answer-complete",
          session_id: "runtime-note-chat",
          payload: { message_id: "persisted-assistant", text: "The brief is ready." },
        });
      }
    });
    await waitFor(() =>
      expect(noteChatText(result.current, "assistant")).toContain("The brief is ready."),
    );
    expect(result.current.turns.filter((turn) => turn.role === "user")).toHaveLength(1);
    expect(result.current.turns.some((turn) => turn.id.startsWith("note-chat-pending:"))).toBe(
      false,
    );
  });

  it("does not consume a repeated optimistic prompt with older identical history", async () => {
    rememberNoteChatSession("note-1", "stored-note-chat");
    const olderMessages: HermesSessionMessage[] = [
      {
        id: "older-user",
        role: "user",
        content: "Repeat this.",
        timestamp: "2026-07-16T00:00:00.000Z",
      },
      {
        id: "older-assistant",
        role: "assistant",
        content: "Older answer.",
        timestamp: "2026-07-16T00:00:01.000Z",
      },
    ];
    mocks.hermesBridgeSessionMessages.mockResolvedValue({ messages: olderMessages });
    const first = renderHook(() => useNoteChat({ id: "note-1", title: "Launch planning" }));
    await waitFor(() =>
      expect(noteChatText(first.result.current, "assistant")).toContain("Older answer."),
    );
    await act(async () => {
      expect(await first.result.current.submit("Repeat this.")).toBe(true);
    });
    first.unmount();

    mocks.hermesBridgeSessionMessages.mockResolvedValue({ messages: olderMessages });
    const second = renderHook(() => useNoteChat({ id: "note-1", title: "Launch planning" }));
    await waitFor(() => expect(second.result.current.loading).toBe(false));
    expect(
      second.result.current.turns.some((turn) => turn.id.startsWith("note-chat-pending:")),
    ).toBe(true);
    second.unmount();

    mocks.hermesBridgeSessionMessages.mockResolvedValue({
      messages: [
        ...olderMessages,
        {
          id: "new-user",
          role: "user",
          content: "Repeat this.",
          timestamp: "2026-07-16T00:00:10.000Z",
        },
        {
          id: "new-assistant",
          role: "assistant",
          content: "New answer.",
          timestamp: "2026-07-16T00:00:11.000Z",
        },
      ],
    });
    const third = renderHook(() => useNoteChat({ id: "note-1", title: "Launch planning" }));
    await waitFor(() =>
      expect(noteChatText(third.result.current, "assistant")).toContain("New answer."),
    );
    expect(
      third.result.current.turns.some((turn) => turn.id.startsWith("note-chat-pending:")),
    ).toBe(false);
    expect(third.result.current.turns.filter((turn) => turn.role === "user")).toHaveLength(2);
  });

  it("does not authorize a repeated prompt from history while initial hydration is pending", async () => {
    rememberNoteChatSession("note-1", "stored-note-chat");
    const olderMessages: HermesSessionMessage[] = [
      {
        id: "older-user",
        role: "user",
        content: "Repeat this.",
        timestamp: "2026-07-15T00:00:00.000Z",
      },
      {
        id: "older-assistant",
        role: "assistant",
        content: "Older answer.",
        timestamp: "2026-07-15T00:00:01.000Z",
      },
    ];
    let resolveInitialHydration:
      | ((value: { messages: HermesSessionMessage[] }) => void)
      | undefined;
    const initialHydration = new Promise<{ messages: HermesSessionMessage[] }>((resolve) => {
      resolveInitialHydration = resolve;
    });
    mocks.hermesBridgeSessionMessages
      .mockReturnValueOnce(initialHydration)
      .mockResolvedValue({ messages: olderMessages });
    let acceptPrompt: (() => void) | undefined;
    const promptAccepted = new Promise<void>((resolve) => {
      acceptPrompt = resolve;
    });
    mocks.gatewayRequest.mockImplementation((method: string) => {
      if (method === "session.resume") {
        return Promise.resolve({ session_id: "runtime-note-chat" });
      }
      if (method === "prompt.submit") return promptAccepted;
      if (method === "session.active_list") {
        return Promise.resolve({
          sessions: [
            {
              id: "runtime-note-chat",
              session_key: "stored-note-chat",
              status: "idle",
            },
          ],
        });
      }
      return Promise.resolve({});
    });
    const { result } = renderHook(() => useNoteChat({ id: "note-1", title: "Launch planning" }));
    await waitFor(() => expect(mocks.hermesBridgeSessionMessages).toHaveBeenCalledTimes(1));

    let submission: Promise<boolean> = Promise.resolve(false);
    act(() => {
      submission = result.current.submit("Repeat this.");
    });
    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", expect.anything()),
    );
    act(() => {
      for (const handler of mocks.gatewayEventHandlers) {
        handler({
          type: "turn.completed",
          event_id: "lagging-terminal",
          session_id: "runtime-note-chat",
          payload: { status: "success" },
        });
      }
    });
    await act(async () => acceptPrompt?.());
    await expect(submission).resolves.toBe(true);
    await waitFor(() =>
      expect(mocks.hermesBridgeSessionMessages.mock.calls.length).toBeGreaterThanOrEqual(2),
    );
    await act(async () => Promise.resolve());

    expect(result.current.working).toBe(true);
    expect(result.current.turns.some((turn) => turn.id.startsWith("note-chat-pending:"))).toBe(
      true,
    );
    expect(mocks.markAgentRunSucceeded).not.toHaveBeenCalled();
    expect(mocks.gatewayRequest).not.toHaveBeenCalledWith("session.active_list", {});
    await act(async () => resolveInitialHydration?.({ messages: olderMessages }));
  });

  it("settles the current note chat from the app-lifetime run monitor", async () => {
    rememberNoteChatSession("note-1", "stored-note-chat");
    const { result } = renderHook(() => useNoteChat({ id: "note-1", title: "Launch planning" }));
    await waitFor(() => expect(result.current.storedSessionId).toBe("stored-note-chat"));
    await waitFor(() => expect(mocks.hermesBridgeSessionMessages).toHaveBeenCalled());
    mocks.hermesBridgeSessionMessages.mockClear();
    await act(async () => {
      expect(await result.current.submit("Recover a lost terminal.")).toBe(true);
    });
    expect(result.current.working).toBe(true);

    act(() => {
      window.dispatchEvent(
        new CustomEvent(AGENT_RUN_SETTLED_EVENT, {
          detail: { sessionId: "another-session", title: "Other", summary: "June finished." },
        }),
      );
    });
    expect(result.current.working).toBe(true);

    act(() => {
      window.dispatchEvent(
        new CustomEvent(AGENT_RUN_SETTLED_EVENT, {
          detail: {
            sessionId: "stored-note-chat",
            title: "Launch planning",
            summary: "June finished.",
          },
        }),
      );
    });
    expect(result.current.working).toBe(false);
    await waitFor(() => expect(mocks.hermesBridgeSessionMessages).toHaveBeenCalledTimes(1));
  });

  it("ignores a prior run monitor settlement before the current submit is accepted", async () => {
    rememberNoteChatSession("note-1", "stored-note-chat");
    let acceptPrompt: (() => void) | undefined;
    const promptAccepted = new Promise<void>((resolve) => {
      acceptPrompt = resolve;
    });
    mocks.gatewayRequest.mockImplementation((method: string) => {
      if (method === "session.resume") {
        return Promise.resolve({ session_id: "runtime-note-chat" });
      }
      if (method === "prompt.submit") return promptAccepted;
      return Promise.resolve({});
    });
    const { result } = renderHook(() => useNoteChat({ id: "note-1", title: "Launch planning" }));
    await waitFor(() => expect(result.current.storedSessionId).toBe("stored-note-chat"));

    let submission: Promise<boolean> = Promise.resolve(false);
    act(() => {
      submission = result.current.submit("Start the current run.");
    });
    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", expect.anything()),
    );
    act(() => {
      window.dispatchEvent(
        new CustomEvent(AGENT_RUN_SETTLED_EVENT, {
          detail: {
            sessionId: "stored-note-chat",
            title: "Launch planning",
            summary: "June finished.",
          },
        }),
      );
    });
    expect(result.current.working).toBe(true);

    await act(async () => acceptPrompt?.());
    await expect(submission).resolves.toBe(true);
    expect(result.current.working).toBe(true);
    expect(mocks.startAgentRunMonitoring).toHaveBeenCalledTimes(1);
  });

  it("attributes a sole note-chat terminal before run-monitor registration", async () => {
    rememberNoteChatSession("note-1", "stored-note-chat");
    mocks.canAttributeUntaggedAgentRun.mockReturnValue(false);
    let acceptPrompt: (() => void) | undefined;
    const promptAccepted = new Promise<void>((resolve) => {
      acceptPrompt = resolve;
    });
    mocks.gatewayRequest.mockImplementation((method: string) => {
      if (method === "session.resume") {
        return Promise.resolve({ session_id: "runtime-note-chat" });
      }
      if (method === "prompt.submit") return promptAccepted;
      if (method === "session.active_list") {
        return Promise.resolve({
          sessions: [
            {
              id: "runtime-note-chat",
              session_key: "stored-note-chat",
              status: "idle",
            },
          ],
        });
      }
      return Promise.resolve({});
    });
    const { result } = renderHook(() => useNoteChat({ id: "note-1", title: "Launch planning" }));
    await waitFor(() => expect(result.current.loading).toBe(false));

    let submission: Promise<boolean> = Promise.resolve(false);
    act(() => {
      submission = result.current.submit("Finish before monitor registration.");
    });
    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", expect.anything()),
    );
    mocks.hermesBridgeSessionMessages.mockResolvedValue({
      messages: [
        {
          id: "current-user",
          role: "user",
          content: "Finish before monitor registration.",
          timestamp: new Date().toISOString(),
        },
        {
          id: "current-assistant",
          role: "assistant",
          content: "Finished quickly.",
          timestamp: new Date(Date.now() + 1_000).toISOString(),
        },
      ],
    });
    act(() => {
      for (const handler of mocks.gatewayEventHandlers) {
        handler({ type: "turn.completed", payload: { status: "success" } });
      }
    });
    await act(async () => acceptPrompt?.());
    await expect(submission).resolves.toBe(true);

    await waitFor(() => expect(result.current.working).toBe(false));
    expect(mocks.markAgentRunSucceeded).toHaveBeenCalledWith("stored-note-chat");
  });

  it("does not let a replayed terminal settle a later note-chat run", async () => {
    rememberNoteChatSession("note-1", "stored-note-chat");
    const { result } = renderHook(() => useNoteChat({ id: "note-1", title: "Launch planning" }));
    await waitFor(() => expect(result.current.storedSessionId).toBe("stored-note-chat"));

    await act(async () => {
      expect(await result.current.submit("Finish the first run.")).toBe(true);
    });
    const firstTerminal = {
      type: "turn.completed",
      session_id: "runtime-note-chat",
      event_id: "first-run-terminal",
      payload: { status: "success" },
    };
    act(() => {
      for (const handler of mocks.gatewayEventHandlers) handler(firstTerminal);
    });
    expect(result.current.working).toBe(false);

    await act(async () => {
      expect(await result.current.submit("Finish the later run.")).toBe(true);
    });
    expect(result.current.working).toBe(true);
    act(() => {
      for (const handler of mocks.gatewayEventHandlers) handler(firstTerminal);
    });
    expect(result.current.working).toBe(true);

    act(() => {
      for (const handler of mocks.gatewayEventHandlers) {
        handler({ ...firstTerminal, event_id: "later-run-terminal" });
      }
    });
    expect(result.current.working).toBe(false);
  });

  it("does not let an untagged terminal replay settle a later note-chat run", async () => {
    rememberNoteChatSession("note-1", "stored-note-chat");
    const { result } = renderHook(() => useNoteChat({ id: "note-1", title: "Launch planning" }));
    await waitFor(() => expect(result.current.storedSessionId).toBe("stored-note-chat"));

    await act(async () => {
      expect(await result.current.submit("Finish the first run.")).toBe(true);
    });
    const untaggedTerminal = {
      type: "turn.completed",
      event_id: "untagged-run-terminal",
      payload: { status: "success" },
    };
    act(() => {
      for (const handler of mocks.gatewayEventHandlers) handler(untaggedTerminal);
    });
    expect(result.current.working).toBe(false);

    await act(async () => {
      expect(await result.current.submit("Keep the later run working.")).toBe(true);
    });
    mocks.markAgentRunSucceeded.mockClear();
    act(() => {
      for (const handler of mocks.gatewayEventHandlers) handler(untaggedTerminal);
    });

    expect(result.current.working).toBe(true);
    expect(mocks.markAgentRunSucceeded).not.toHaveBeenCalled();
  });

  it("settles a consecutive identical no-id terminal only with current idle authority", async () => {
    rememberNoteChatSession("note-1", "stored-note-chat");
    let activeStatus: "working" | "idle" = "working";
    mocks.gatewayRequest.mockImplementation((method: string) => {
      if (method === "session.resume") {
        return Promise.resolve({ session_id: "runtime-note-chat" });
      }
      if (method === "session.active_list") {
        return Promise.resolve({
          sessions: [
            {
              id: "runtime-note-chat",
              session_key: "stored-note-chat",
              status: activeStatus,
            },
          ],
        });
      }
      return Promise.resolve({});
    });
    const { result } = renderHook(() => useNoteChat({ id: "note-1", title: "Launch planning" }));
    await waitFor(() => expect(result.current.storedSessionId).toBe("stored-note-chat"));

    await act(async () => {
      expect(await result.current.submit("Finish the first run.")).toBe(true);
    });
    const terminal = {
      type: "turn.completed",
      session_id: "runtime-note-chat",
      payload: { status: "success" },
    };
    act(() => {
      for (const handler of mocks.gatewayEventHandlers) handler(terminal);
    });
    expect(result.current.working).toBe(false);

    mocks.markAgentRunSucceeded.mockClear();
    await act(async () => {
      expect(await result.current.submit("Finish the second run.")).toBe(true);
    });
    mocks.hermesBridgeSessionMessages.mockResolvedValue({
      messages: [
        {
          id: "second-user",
          role: "user",
          content: "Finish the second run.",
          timestamp: new Date().toISOString(),
        },
        {
          id: "second-assistant",
          role: "assistant",
          content: "Done again.",
          timestamp: new Date(Date.now() + 1_000).toISOString(),
        },
      ],
    });

    const activeListCallsBefore = mocks.gatewayRequest.mock.calls.filter(
      ([method]) => method === "session.active_list",
    ).length;
    act(() => {
      for (const handler of mocks.gatewayEventHandlers) handler(terminal);
    });
    await waitFor(() =>
      expect(
        mocks.gatewayRequest.mock.calls.filter(([method]) => method === "session.active_list"),
      ).toHaveLength(activeListCallsBefore + 1),
    );
    expect(result.current.working).toBe(true);
    expect(mocks.markAgentRunSucceeded).not.toHaveBeenCalled();

    activeStatus = "idle";
    act(() => {
      for (const handler of mocks.gatewayEventHandlers) handler(terminal);
    });
    await waitFor(() => expect(result.current.working).toBe(false));
    expect(mocks.markAgentRunSucceeded).toHaveBeenCalledWith("stored-note-chat");
  });

  it("requires current authority for a non-consecutive replayed no-id terminal", async () => {
    rememberNoteChatSession("note-1", "stored-note-chat");
    let activeStatus: "working" | "idle" = "working";
    mocks.gatewayRequest.mockImplementation((method: string) => {
      if (method === "session.resume") {
        return Promise.resolve({ session_id: "runtime-note-chat" });
      }
      if (method === "session.active_list") {
        return Promise.resolve({
          sessions: [
            {
              id: "runtime-note-chat",
              session_key: "stored-note-chat",
              status: activeStatus,
            },
          ],
        });
      }
      return Promise.resolve({});
    });
    const { result } = renderHook(() => useNoteChat({ id: "note-1", title: "Launch planning" }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    const successfulTerminal = {
      type: "turn.completed",
      session_id: "runtime-note-chat",
      payload: { status: "success" },
    };

    await act(async () => {
      expect(await result.current.submit("Finish run one.")).toBe(true);
    });
    act(() => {
      for (const handler of mocks.gatewayEventHandlers) handler(successfulTerminal);
    });
    await act(async () => {
      expect(await result.current.submit("Fail run two.")).toBe(true);
    });
    act(() => {
      for (const handler of mocks.gatewayEventHandlers) {
        handler({
          type: "error",
          session_id: "runtime-note-chat",
          payload: { message: "Run two failed", code: 500, recoverable: false },
        });
      }
    });

    await act(async () => {
      expect(await result.current.submit("Keep run three working.")).toBe(true);
    });
    mocks.hermesBridgeSessionMessages.mockResolvedValue({
      messages: [
        {
          id: "third-user",
          role: "user",
          content: "Keep run three working.",
          timestamp: new Date().toISOString(),
        },
        {
          id: "third-assistant",
          role: "assistant",
          content: "Run three reply.",
          timestamp: new Date(Date.now() + 1_000).toISOString(),
        },
      ],
    });
    act(() => {
      for (const handler of mocks.gatewayEventHandlers) handler(successfulTerminal);
    });
    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("session.active_list", {}),
    );
    expect(result.current.working).toBe(true);

    activeStatus = "idle";
    act(() => {
      for (const handler of mocks.gatewayEventHandlers) {
        handler({ ...successfulTerminal, event_id: "third-run-terminal" });
      }
    });
    expect(result.current.working).toBe(false);
  });

  it("settles a consecutive identical no-id failure without requiring an assistant reply", async () => {
    rememberNoteChatSession("note-1", "stored-note-chat");
    mocks.gatewayRequest.mockImplementation((method: string) => {
      if (method === "session.resume") {
        return Promise.resolve({ session_id: "runtime-note-chat" });
      }
      if (method === "session.active_list") {
        return Promise.resolve({
          sessions: [
            {
              id: "runtime-note-chat",
              session_key: "stored-note-chat",
              status: "idle",
            },
          ],
        });
      }
      return Promise.resolve({});
    });
    const { result } = renderHook(() => useNoteChat({ id: "note-1", title: "Launch planning" }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    const terminal = {
      type: "error",
      session_id: "runtime-note-chat",
      payload: { message: "Upstream failed", code: 500, recoverable: false },
    };

    await act(async () => {
      expect(await result.current.submit("Fail the first run.")).toBe(true);
    });
    act(() => {
      for (const handler of mocks.gatewayEventHandlers) handler(terminal);
    });
    expect(result.current.working).toBe(false);

    await act(async () => {
      expect(await result.current.submit("Fail the second run.")).toBe(true);
    });
    mocks.hermesBridgeSessionMessages.mockResolvedValue({
      messages: [
        {
          id: "second-user",
          role: "user",
          content: "Fail the second run.",
          timestamp: new Date().toISOString(),
        },
      ],
    });
    act(() => {
      for (const handler of mocks.gatewayEventHandlers) handler(terminal);
    });

    await waitFor(() => expect(result.current.working).toBe(false));
    expect(result.current.error).toBe("Upstream failed");
    expect(mocks.cancelAgentRunMonitoring).toHaveBeenCalledTimes(2);
  });

  it("cancels an in-flight submit when stopped during gateway connection", async () => {
    rememberNoteChatSession("note-1", "stored-note-chat");
    let finishConnection: (() => void) | undefined;
    const connection = new Promise<void>((resolve) => {
      finishConnection = resolve;
    });
    mocks.gatewayConnect.mockReturnValue(connection);
    const { result } = renderHook(() => useNoteChat({ id: "note-1", title: "Launch planning" }));
    await waitFor(() => expect(result.current.storedSessionId).toBe("stored-note-chat"));

    let submission: Promise<boolean> = Promise.resolve(true);
    act(() => {
      submission = result.current.submit("Do not start this run.");
    });
    await waitFor(() => expect(mocks.gatewayConnect).toHaveBeenCalled());
    act(() => result.current.stop());
    expect(result.current.working).toBe(false);
    expect(result.current.submissionPending).toBe(true);

    await act(async () => finishConnection?.());
    await expect(submission).resolves.toBe(false);
    expect(result.current.submissionPending).toBe(false);
    expect(mocks.gatewayRequest).not.toHaveBeenCalledWith("prompt.submit", expect.anything());
    expect(mocks.startAgentRunMonitoring).not.toHaveBeenCalled();
    expect(result.current.working).toBe(false);
  });

  it("cancels an in-flight submit when stopped during model preparation", async () => {
    rememberNoteChatSession("note-1", "stored-note-chat");
    rememberAppliedSessionModelSelection("stored-note-chat", { modelId: currentModel.id });
    stageSessionModelSelection("stored-note-chat", { modelId: legacyModel.id });
    let finishModelSwitch: (() => void) | undefined;
    const modelSwitch = new Promise<void>((resolve) => {
      finishModelSwitch = resolve;
    });
    mocks.gatewayRequest.mockImplementation((method: string) => {
      if (method === "session.resume") {
        return Promise.resolve({ session_id: "runtime-note-chat" });
      }
      if (method === "config.set") return modelSwitch;
      return Promise.resolve({});
    });
    const { result } = renderHook(() => useNoteChat({ id: "note-1", title: "Launch planning" }));
    await waitFor(() => expect(result.current.storedSessionId).toBe("stored-note-chat"));

    let submission: Promise<boolean> = Promise.resolve(true);
    act(() => {
      submission = result.current.submit("Do not run after the model switch.");
    });
    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith(
        "config.set",
        expect.objectContaining({ session_id: "runtime-note-chat" }),
      ),
    );
    act(() => result.current.stop());
    await act(async () => finishModelSwitch?.());

    await expect(submission).resolves.toBe(false);
    expect(mocks.gatewayRequest).not.toHaveBeenCalledWith("prompt.submit", expect.anything());
    expect(mocks.startAgentRunMonitoring).not.toHaveBeenCalled();
    expect(result.current.working).toBe(false);
  });

  it("ignores a late successful terminal after stopping note chat", async () => {
    rememberNoteChatSession("note-1", "stored-note-chat");
    const { result } = renderHook(() => useNoteChat({ id: "note-1", title: "Launch planning" }));
    await waitFor(() => expect(result.current.storedSessionId).toBe("stored-note-chat"));
    await act(async () => {
      expect(await result.current.submit("Summarize the current plan.")).toBe(true);
    });

    act(() => result.current.stop());
    expect(mocks.cancelAgentRunMonitoring).toHaveBeenCalledWith("stored-note-chat");
    mocks.markAgentRunSucceeded.mockClear();
    act(() => {
      for (const handler of mocks.gatewayEventHandlers) {
        handler({
          type: "turn.completed",
          session_id: "runtime-note-chat",
          payload: { status: "success" },
        });
      }
    });

    expect(mocks.markAgentRunSucceeded).not.toHaveBeenCalled();
  });

  it("does not attribute an untagged terminal when another note-chat run exists", async () => {
    rememberNoteChatSession("note-1", "stored-note-chat-1");
    rememberNoteChatSession("note-2", "stored-note-chat-2");
    mocks.canAttributeUntaggedAgentRun.mockReturnValue(false);
    mocks.gatewayRequest.mockImplementation((method: string, params?: { session_id?: string }) => {
      if (method === "session.resume") {
        return Promise.resolve({ session_id: `runtime-${params?.session_id}` });
      }
      return Promise.resolve({});
    });
    const first = renderHook(() => useNoteChat({ id: "note-1", title: "Launch planning" }));
    const second = renderHook(() => useNoteChat({ id: "note-2", title: "Budget planning" }));
    await waitFor(() => expect(first.result.current.storedSessionId).toBe("stored-note-chat-1"));
    await waitFor(() => expect(second.result.current.storedSessionId).toBe("stored-note-chat-2"));
    await act(async () => {
      expect(await first.result.current.submit("Summarize the current plan.")).toBe(true);
      expect(await second.result.current.submit("Summarize the budget plan.")).toBe(true);
    });
    mocks.markAgentRunSucceeded.mockClear();
    mocks.cancelAgentRunMonitoring.mockClear();

    act(() => {
      for (const handler of mocks.gatewayEventHandlers) {
        handler({
          type: "turn.completed",
          payload: { status: "success" },
        });
      }
    });

    expect(first.result.current.working).toBe(true);
    expect(second.result.current.working).toBe(true);
    expect(mocks.markAgentRunSucceeded).not.toHaveBeenCalled();
    expect(mocks.cancelAgentRunMonitoring).not.toHaveBeenCalled();
  });

  it("dispatches a failed status for a failure-flavored note-chat terminal", async () => {
    rememberNoteChatSession("note-1", "stored-note-chat");
    const statuses: AgentSessionStatusDetail[] = [];
    const handleStatus = (event: Event) => {
      statuses.push((event as CustomEvent<AgentSessionStatusDetail>).detail);
    };
    window.addEventListener(AGENT_SESSION_STATUS_EVENT, handleStatus);
    try {
      const { result } = renderHook(() => useNoteChat({ id: "note-1", title: "Launch planning" }));
      await waitFor(() => expect(result.current.storedSessionId).toBe("stored-note-chat"));
      await act(async () => {
        expect(await result.current.submit("Summarize the current plan.")).toBe(true);
      });

      act(() => {
        for (const handler of mocks.gatewayEventHandlers) {
          handler({
            type: "lifecycle.complete",
            session_id: "runtime-note-chat",
            payload: { status: "timeout" },
          });
        }
      });

      expect(statuses).toContainEqual(
        expect.objectContaining({
          sessionId: "stored-note-chat",
          status: "failed",
          summary: "June stopped before replying.",
        }),
      );
      expect(mocks.cancelAgentRunMonitoring).toHaveBeenCalledWith("stored-note-chat");
    } finally {
      window.removeEventListener(AGENT_SESSION_STATUS_EVENT, handleStatus);
    }
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

  it("cancels an in-flight send instead of retargeting it after switching notes", async () => {
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
    expect(mocks.gatewayRequest).not.toHaveBeenCalledWith("prompt.submit", {
      session_id: "runtime-a",
      text: "Question for A",
    });
    expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
      session_id: "runtime-b",
      text: "Question for B",
    });
    expect(result.current.storedSessionId).toBe("stored-b");
    expect(result.current.working).toBe(true);
    expect(result.current.error).toBeNull();
  });

  it("keeps a peer view bound to its note when the sending view switches notes", async () => {
    rememberNoteChatSession("note-a", "stored-a");
    rememberNoteChatSession("note-b", "stored-b");
    let releaseConnection: (() => void) | undefined;
    mocks.gatewayConnect.mockReturnValue(
      new Promise<void>((resolve) => {
        releaseConnection = resolve;
      }),
    );

    const sending = renderHook(
      ({ id }) => useNoteChat({ id, title: id === "note-a" ? "Note A" : "Note B" }),
      { initialProps: { id: "note-a" } },
    );
    const peer = renderHook(() => useNoteChat({ id: "note-a", title: "Note A" }));
    await waitFor(() => expect(sending.result.current.storedSessionId).toBe("stored-a"));
    await waitFor(() => expect(peer.result.current.storedSessionId).toBe("stored-a"));

    const noteASubmit = sending.result.current.submit("Question for A");
    await waitFor(() => expect(mocks.gatewayConnect).toHaveBeenCalled());
    sending.rerender({ id: "note-b" });
    await waitFor(() => expect(sending.result.current.storedSessionId).toBe("stored-b"));
    await act(async () => releaseConnection?.());

    await expect(noteASubmit).resolves.toBe(false);
    expect(peer.result.current.storedSessionId).toBe("stored-a");
    expect(noteChatText(peer.result.current, "user")).not.toContain("Question for A");
  });

  it("keeps a delayed Stop refresh scoped to the note that was stopped", async () => {
    rememberNoteChatSession("note-a", "stored-a");
    rememberNoteChatSession("note-b", "stored-b");
    let finishInterrupt: (() => void) | undefined;
    mocks.gatewayRequest.mockImplementation((method: string, params?: { session_id?: string }) => {
      if (method === "session.resume") {
        return Promise.resolve({ session_id: `runtime-${params?.session_id}` });
      }
      if (method === "session.interrupt") {
        return new Promise<void>((resolve) => {
          finishInterrupt = resolve;
        });
      }
      return Promise.resolve({});
    });
    const sending = renderHook(
      ({ id }) => useNoteChat({ id, title: id === "note-a" ? "Note A" : "Note B" }),
      { initialProps: { id: "note-a" } },
    );
    const peer = renderHook(() => useNoteChat({ id: "note-a", title: "Note A" }));
    await waitFor(() => expect(sending.result.current.loading).toBe(false));
    await waitFor(() => expect(peer.result.current.loading).toBe(false));
    await act(async () => {
      expect(await sending.result.current.submit("Stop A only.")).toBe(true);
    });

    act(() => sending.result.current.stop());
    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("session.interrupt", {
        session_id: "runtime-stored-a",
      }),
    );
    sending.rerender({ id: "note-b" });
    await waitFor(() => expect(sending.result.current.loading).toBe(false));
    const refreshCountBefore = mocks.hermesBridgeSessionMessages.mock.calls.length;
    await act(async () => finishInterrupt?.());
    await waitFor(() =>
      expect(mocks.hermesBridgeSessionMessages.mock.calls.length).toBeGreaterThan(
        refreshCountBefore,
      ),
    );

    expect(peer.result.current.storedSessionId).toBe("stored-a");
  });

  it("keeps a delayed gateway recovery refresh scoped to its originating note", async () => {
    rememberNoteChatSession("note-a", "stored-a");
    rememberNoteChatSession("note-b", "stored-b");
    let noteAResumeCount = 0;
    let finishRecovery: ((value: { session_id: string }) => void) | undefined;
    const recovery = new Promise<{ session_id: string }>((resolve) => {
      finishRecovery = resolve;
    });
    mocks.gatewayRequest.mockImplementation((method: string, params?: { session_id?: string }) => {
      if (method !== "session.resume") return Promise.resolve({});
      if (params?.session_id === "stored-a") {
        noteAResumeCount += 1;
        return noteAResumeCount === 1
          ? Promise.resolve({ session_id: "runtime-before-close" })
          : recovery;
      }
      return Promise.resolve({ session_id: "runtime-b" });
    });
    const sending = renderHook(
      ({ id }) => useNoteChat({ id, title: id === "note-a" ? "Note A" : "Note B" }),
      { initialProps: { id: "note-a" } },
    );
    const peer = renderHook(() => useNoteChat({ id: "note-a", title: "Note A" }));
    await waitFor(() => expect(sending.result.current.loading).toBe(false));
    await waitFor(() => expect(peer.result.current.loading).toBe(false));
    await act(async () => {
      expect(await sending.result.current.submit("Recover A only.")).toBe(true);
    });

    act(() => {
      for (const close of mocks.gatewayCloseHandlers) close();
    });
    await waitFor(() => expect(noteAResumeCount).toBe(2));
    sending.rerender({ id: "note-b" });
    await waitFor(() => expect(sending.result.current.loading).toBe(false));
    const noteBRefreshesBefore = mocks.hermesBridgeSessionMessages.mock.calls.filter(
      ([sessionId]) => sessionId === "stored-b",
    ).length;
    await act(async () => finishRecovery?.({ session_id: "runtime-after-close" }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(
      mocks.hermesBridgeSessionMessages.mock.calls.filter(
        ([sessionId]) => sessionId === "stored-b",
      ),
    ).toHaveLength(noteBRefreshesBefore);
    expect(peer.result.current.storedSessionId).toBe("stored-a");
  });
});
