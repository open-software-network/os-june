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
import {
  reserveHermesSessionDispatch,
  resetHermesSessionDispatchForTests,
} from "../lib/hermes-session-dispatch-mutex";
import { classifyHermesEvent } from "../lib/hermes-control-plane/event-classifier";
import { HermesGatewayError } from "../lib/hermes-gateway";
import {
  rememberAppliedSessionModelSelection,
  stageSessionModelSelection,
} from "../lib/hermes-session-model-selection";
import { PROVIDER_MODEL_SETTINGS_CHANGED_EVENT } from "../lib/model-privacy";
import {
  AGENT_RUN_SETTLED_EVENT,
  AGENT_RUN_STARTED_EVENT,
  AGENT_SESSION_STATUS_EVENT,
  type AgentSessionStatusDetail,
} from "../lib/agent-events";
import type { HermesSessionMessage } from "../lib/tauri";

const mocks = vi.hoisted(() => ({
  agentRunMonitorSnapshot: vi.fn(),
  canAttributeUntaggedAgentRun: vi.fn(() => true),
  cancelAgentRunMonitoring: vi.fn(),
  stopAgentRunMonitoring: vi.fn(
    (_storedSessionId: string, _generation: number, onStopped?: () => void) => {
      queueMicrotask(() => onStopped?.());
      return true;
    },
  ),
  gatewayRequest: vi.fn(),
  gatewayConnect: vi.fn(),
  gatewayEventHandlers: new Set<(event: Record<string, unknown>) => void>(),
  gatewayCloseHandlers: new Set<() => void>(),
  hermesBridgeImageDataUrl: vi.fn(),
  hermesBridgeSessionMessages: vi.fn(),
  listHermesSessions: vi.fn(),
  hermesBridgeStatus: vi.fn(),
  isAgentRunMonitorGenerationCurrent: vi.fn(() => true),
  listVeniceModels: vi.fn(),
  markAgentRunSucceeded: vi.fn(),
  preserveAgentRunTerminalEvidence: vi.fn(),
  providerModelSettings: vi.fn(),
  setCostQuality: vi.fn(),
  setLocalGenerationEnabled: vi.fn(),
  setVeniceModel: vi.fn(),
  startHermesBridge: vi.fn(),
  startAgentRunMonitoring: vi.fn(),
}));

vi.mock("../lib/agent-run-monitor", () => ({
  agentRunMonitorSnapshot: mocks.agentRunMonitorSnapshot,
  canAttributeUntaggedAgentRun: mocks.canAttributeUntaggedAgentRun,
  cancelAgentRunMonitoring: mocks.cancelAgentRunMonitoring,
  stopAgentRunMonitoring: mocks.stopAgentRunMonitoring,
  isAgentRunMonitorGenerationCurrent: mocks.isAgentRunMonitorGenerationCurrent,
  markAgentRunSucceeded: mocks.markAgentRunSucceeded,
  preserveAgentRunTerminalEvidence: mocks.preserveAgentRunTerminalEvidence,
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

function noteChatTextParts(chat: NoteChat, role: AgentChatTurn["role"]) {
  return chat.turns
    .filter((turn) => turn.role === role)
    .flatMap((turn) => turn.parts)
    .filter((part) => part.type === "text")
    .map((part) => part.text);
}

function noteChatReasoningText(chat: NoteChat) {
  return chat.turns
    .flatMap((turn) => turn.parts)
    .filter((part) => part.type === "reasoning")
    .map((part) => part.text)
    .join(" ");
}

function hermesRuntimeStatus(pid: number, port: number) {
  return {
    running: true,
    connection: {
      port,
      wsUrl: `ws://127.0.0.1:${port}`,
      pid,
      fullMode: false,
    },
  };
}

function persistedNoteChatRun(
  prompt: string,
  assistant: string,
  suffix: string,
): HermesSessionMessage[] {
  return [
    {
      id: `persisted-runtime-replacement-user-${suffix}`,
      role: "user",
      content: prompt,
      timestamp: new Date(Date.now() + 1_000).toISOString(),
    },
    {
      id: `persisted-runtime-replacement-assistant-${suffix}`,
      role: "assistant",
      content: assistant,
      timestamp: new Date(Date.now() + 2_000).toISOString(),
    },
  ];
}

function rawResumeMessages(messages: HermesSessionMessage[]) {
  return messages.map(({ id: _id, ...message }) => message);
}

describe("note chat session map", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetHermesSessionDispatchForTests();
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
    mocks.agentRunMonitorSnapshot.mockReturnValue(undefined);
    mocks.stopAgentRunMonitoring.mockImplementation(
      (_storedSessionId: string, _generation: number, onStopped?: () => void) => {
        queueMicrotask(() => onStopped?.());
        return true;
      },
    );
    mocks.isAgentRunMonitorGenerationCurrent.mockReturnValue(true);
    mocks.startAgentRunMonitoring.mockReturnValue(1);
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
    expect(mocks.stopAgentRunMonitoring).toHaveBeenCalledTimes(1);
  });

  it("holds a replacement Send behind an accepted central Stop", async () => {
    rememberNoteChatSession("note-1", "stored-note-chat");
    let finishStop: (() => void) | undefined;
    mocks.stopAgentRunMonitoring.mockImplementation(
      (_storedSessionId: string, _generation: number, onStopped?: () => void) => {
        finishStop = onStopped;
        return true;
      },
    );
    const { result } = renderHook(() => useNoteChat({ id: "note-1", title: "Launch planning" }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => {
      expect(await result.current.submit("Run before central Stop.")).toBe(true);
    });

    act(() => result.current.stop());
    let replacement: Promise<boolean> = Promise.resolve(false);
    act(() => {
      replacement = result.current.submit("Run after central Stop.");
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(
      mocks.gatewayRequest.mock.calls.filter(([method]) => method === "prompt.submit"),
    ).toHaveLength(1);

    await act(async () => finishStop?.());
    await act(async () => {
      expect(await replacement).toBe(true);
    });
    expect(
      mocks.gatewayRequest.mock.calls.filter(([method]) => method === "prompt.submit"),
    ).toHaveLength(2);
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
    expect(mocks.markAgentRunSucceeded).toHaveBeenCalledWith("stored-note-chat", 1);
    expect(mocks.startAgentRunMonitoring).toHaveBeenCalledWith(
      expect.objectContaining({ storedSessionId: "stored-note-chat" }),
    );
  });

  it("does not treat a persisted tool-call tail as authority for a deferred completion", async () => {
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
      submission = result.current.submit("Finish after the tool result.");
    });
    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
        session_id: "runtime-note-chat",
        text: "Finish after the tool result.",
      }),
    );
    act(() => {
      for (const handler of mocks.gatewayEventHandlers) {
        handler({
          type: "turn.completed",
          event_id: "deferred-tool-tail-completion",
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
          content: "Finish after the tool result.",
          timestamp: new Date().toISOString(),
        },
        {
          id: "assistant-tool-call",
          role: "assistant",
          content: "I will inspect that now.",
          tool_calls: [{ id: "read-1", name: "read_file" }],
          timestamp: new Date(Date.now() + 500).toISOString(),
        },
        {
          id: "tool-result",
          role: "tool",
          content: "Tool result",
          tool_call_id: "read-1",
          timestamp: new Date(Date.now() + 1_000).toISOString(),
        },
      ],
    });

    await act(async () => acceptPrompt?.());
    await expect(submission).resolves.toBe(true);
    await act(async () => Promise.resolve());
    expect(result.current.working).toBe(true);
    expect(mocks.markAgentRunSucceeded).not.toHaveBeenCalled();
    expect(mocks.gatewayRequest).not.toHaveBeenCalledWith("session.active_list", {});
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
    await waitFor(() => expect(result.current.storedSessionId).toBe("stored-note-chat"));

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
    expect(mocks.markAgentRunSucceeded).toHaveBeenCalledWith("stored-note-chat", 1);
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

  it("replaces an abandoned ID-less prefix after an idle distinct-process resume and keeps one copy across remount", async () => {
    const prompt = "Keep the recovered answer singular.";
    const livePrefix = "Final ans";
    const persistedAnswer = "Final answer.";
    const acceptedStatus = hermesRuntimeStatus(701, 61701);
    const replacementStatus = hermesRuntimeStatus(702, 61702);
    const persistedMessages = persistedNoteChatRun(prompt, persistedAnswer, "singular");
    rememberNoteChatSession("note-1", "stored-note-chat");
    mocks.hermesBridgeStatus.mockResolvedValue(acceptedStatus);

    let resumeCount = 0;
    mocks.gatewayRequest.mockImplementation((method: string) => {
      if (method !== "session.resume") return Promise.resolve({});
      resumeCount += 1;
      return Promise.resolve(
        resumeCount === 1
          ? { session_id: "runtime-before-replacement" }
          : {
              messages: rawResumeMessages(persistedMessages),
              retired_approval_request_ids: [],
              running: false,
              session_id: "runtime-after-replacement",
            },
      );
    });

    const first = renderHook(() => useNoteChat({ id: "note-1", title: "Launch planning" }));
    await waitFor(() => expect(first.result.current.loading).toBe(false));
    await act(async () => {
      expect(await first.result.current.submit(prompt)).toBe(true);
    });
    await waitFor(() =>
      expect(mocks.gatewayConnect).toHaveBeenCalledWith(acceptedStatus.connection.wsUrl),
    );

    const acceptedHandler = [...mocks.gatewayEventHandlers].at(-1);
    act(() => {
      acceptedHandler?.({
        type: "message.start",
        event_id: "runtime-replacement-open-start",
        session_id: "runtime-before-replacement",
        payload: {},
      });
      acceptedHandler?.({
        type: "message.delta",
        event_id: "runtime-replacement-open-delta",
        session_id: "runtime-before-replacement",
        payload: { delta: livePrefix },
      });
    });
    expect(noteChatTextParts(first.result.current, "assistant")).toEqual([livePrefix]);

    mocks.hermesBridgeSessionMessages.mockResolvedValue({ messages: persistedMessages });
    mocks.hermesBridgeStatus.mockResolvedValue(replacementStatus);
    act(() => {
      for (const close of mocks.gatewayCloseHandlers) close();
    });
    await waitFor(() => expect(resumeCount).toBe(2));

    await waitFor(() =>
      expect(noteChatTextParts(first.result.current, "assistant")).toEqual([persistedAnswer]),
    );
    expect(mocks.gatewayConnect).toHaveBeenLastCalledWith(replacementStatus.connection.wsUrl);

    first.unmount();
    const second = renderHook(() => useNoteChat({ id: "note-1", title: "Launch planning" }));
    await waitFor(() => expect(second.result.current.loading).toBe(false));
    expect(noteChatTextParts(second.result.current, "assistant")).toEqual([persistedAnswer]);
    second.unmount();
  });

  it("keeps an abandoned ID-less prefix fail-closed when the process incarnation is unchanged", async () => {
    const prompt = "Keep uncertain replacement text.";
    const livePrefix = "Live partial";
    const persistedAnswer = "Live partial completed.";
    const acceptedStatus = hermesRuntimeStatus(711, 61711);
    const persistedMessages = persistedNoteChatRun(prompt, persistedAnswer, "same-process");
    rememberNoteChatSession("note-1", "stored-note-chat");
    mocks.hermesBridgeStatus.mockResolvedValue(acceptedStatus);

    let resumeCount = 0;
    mocks.gatewayRequest.mockImplementation((method: string) => {
      if (method !== "session.resume") return Promise.resolve({});
      resumeCount += 1;
      return Promise.resolve(
        resumeCount === 1
          ? { session_id: "runtime-before-fail-closed-replacement" }
          : {
              messages: rawResumeMessages(persistedMessages),
              retired_approval_request_ids: [],
              running: false,
              session_id: "runtime-after-fail-closed-replacement",
            },
      );
    });

    const view = renderHook(() => useNoteChat({ id: "note-1", title: "Launch planning" }));
    await waitFor(() => expect(view.result.current.loading).toBe(false));
    await act(async () => {
      expect(await view.result.current.submit(prompt)).toBe(true);
    });
    const acceptedHandler = [...mocks.gatewayEventHandlers].at(-1);
    act(() => {
      acceptedHandler?.({
        type: "message.start",
        event_id: "fail-closed-runtime-replacement-start",
        session_id: "runtime-before-fail-closed-replacement",
        payload: {},
      });
      acceptedHandler?.({
        type: "message.delta",
        event_id: "fail-closed-runtime-replacement-delta",
        session_id: "runtime-before-fail-closed-replacement",
        payload: { delta: livePrefix },
      });
    });

    mocks.hermesBridgeSessionMessages.mockResolvedValue({ messages: persistedMessages });
    mocks.hermesBridgeStatus.mockResolvedValue(acceptedStatus);
    act(() => {
      for (const close of mocks.gatewayCloseHandlers) close();
    });

    await waitFor(() => expect(resumeCount).toBe(2));
    await waitFor(() => {
      const assistantParts = noteChatTextParts(view.result.current, "assistant");
      expect(assistantParts).toContain(persistedAnswer);
      expect(assistantParts).toContain(livePrefix);
      expect(assistantParts).toHaveLength(2);
    });
    view.unmount();
  });

  it("attributes pre-ack ID-less text to the dispatch process before a same-process reconnect", async () => {
    const firstStatus = hermesRuntimeStatus(721, 61721);
    const dispatchStatus = hermesRuntimeStatus(722, 61722);
    const firstPrompt = "Establish process A.";
    const prompt = "Keep the pre-ack process boundary.";
    const predecessorAnswer = "Pre-dispatch predecessor";
    const livePrefix = "Pre-ack partial";
    const persistedAnswer = "Pre-ack partial completed.";
    const persistedAt = Date.now() + 1_000;
    const persistedMessages: HermesSessionMessage[] = [
      {
        id: "persisted-process-a-user",
        role: "user",
        content: firstPrompt,
        timestamp: new Date(persistedAt).toISOString(),
      },
      {
        id: "persisted-process-a-assistant",
        role: "assistant",
        content: predecessorAnswer,
        timestamp: new Date(persistedAt + 1_000).toISOString(),
      },
      {
        id: "persisted-process-b-user",
        role: "user",
        content: prompt,
        timestamp: new Date(persistedAt + 2_000).toISOString(),
      },
      {
        id: "persisted-process-b-assistant",
        role: "assistant",
        content: persistedAnswer,
        timestamp: new Date(persistedAt + 3_000).toISOString(),
      },
    ];
    rememberNoteChatSession("note-1", "stored-note-chat");
    mocks.hermesBridgeStatus.mockResolvedValue(firstStatus);

    let resumeCount = 0;
    let promptCount = 0;
    let acknowledgeSecondResume: ((value: { session_id: string }) => void) | undefined;
    const secondResumeAcknowledgement = new Promise<{ session_id: string }>((resolve) => {
      acknowledgeSecondResume = resolve;
    });
    let acknowledgeSecondPrompt: (() => void) | undefined;
    const secondPromptAcknowledgement = new Promise<void>((resolve) => {
      acknowledgeSecondPrompt = resolve;
    });
    mocks.gatewayRequest.mockImplementation((method: string) => {
      if (method === "session.resume") {
        resumeCount += 1;
        if (resumeCount === 1) return Promise.resolve({ session_id: "runtime-process-a" });
        if (resumeCount === 2) return secondResumeAcknowledgement;
        return Promise.resolve({
          messages: rawResumeMessages(persistedMessages),
          retired_approval_request_ids: [],
          running: false,
          session_id: "runtime-process-b-after-close",
        });
      }
      if (method === "prompt.submit") {
        promptCount += 1;
        if (promptCount === 2) return secondPromptAcknowledgement;
      }
      return Promise.resolve({});
    });

    const view = renderHook(() => useNoteChat({ id: "note-1", title: "Launch planning" }));
    await waitFor(() => expect(view.result.current.loading).toBe(false));
    await act(async () => {
      expect(await view.result.current.submit(firstPrompt)).toBe(true);
    });
    act(() => {
      window.dispatchEvent(
        new CustomEvent(AGENT_RUN_SETTLED_EVENT, {
          detail: {
            sessionId: "stored-note-chat",
            runMonitorGeneration: 1,
            title: "Launch planning",
            summary: "June finished.",
          },
        }),
      );
    });
    await waitFor(() => expect(view.result.current.working).toBe(false));

    mocks.hermesBridgeStatus.mockResolvedValue(dispatchStatus);
    act(() => {
      for (const close of mocks.gatewayCloseHandlers) close();
    });

    let secondSubmission: Promise<boolean> = Promise.resolve(false);
    act(() => {
      secondSubmission = view.result.current.submit(prompt);
    });
    await waitFor(() => expect(resumeCount).toBe(2));
    const processBHandler = [...mocks.gatewayEventHandlers].at(-1);
    act(() => {
      processBHandler?.({
        type: "message.start",
        event_id: "process-b-pre-dispatch-start",
        session_id: "runtime-process-b",
        payload: {},
      });
      processBHandler?.({
        type: "message.delta",
        event_id: "process-b-pre-dispatch-delta",
        session_id: "runtime-process-b",
        payload: { delta: predecessorAnswer },
      });
      processBHandler?.({
        type: "message.complete",
        event_id: "process-b-pre-dispatch-complete",
        session_id: "runtime-process-b",
        payload: { text: predecessorAnswer },
      });
    });
    await act(async () => acknowledgeSecondResume?.({ session_id: "runtime-process-b" }));
    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
        session_id: "runtime-process-b",
        text: prompt,
      }),
    );
    act(() => {
      processBHandler?.({
        type: "message.start",
        event_id: "process-b-pre-ack-start",
        session_id: "runtime-process-b",
        payload: {},
      });
      processBHandler?.({
        type: "message.delta",
        event_id: "process-b-pre-ack-delta",
        session_id: "runtime-process-b",
        payload: { delta: livePrefix },
      });
    });
    expect(noteChatTextParts(view.result.current, "assistant")).toContain(livePrefix);

    await act(async () => acknowledgeSecondPrompt?.());
    await expect(secondSubmission).resolves.toBe(true);

    mocks.hermesBridgeSessionMessages.mockResolvedValue({ messages: persistedMessages });
    act(() => {
      for (const close of mocks.gatewayCloseHandlers) close();
    });
    await waitFor(() => expect(resumeCount).toBe(3));
    await waitFor(() => {
      const assistantParts = noteChatTextParts(view.result.current, "assistant");
      expect(assistantParts.filter((text) => text === predecessorAnswer)).toHaveLength(1);
      expect(assistantParts).toContain(livePrefix);
      expect(assistantParts).toContain(persistedAnswer);
    });
    view.unmount();
  });

  it("replays replacement text before the resume ACK, then fills only its missing snapshot suffix", async () => {
    rememberNoteChatSession("note-1", "stored-note-chat");
    let resumeCount = 0;
    let finishRecovery:
      | ((value: {
          session_id: string;
          running: boolean;
          inflight: { assistant: string; streaming: boolean };
          retired_approval_request_ids: string[];
        }) => void)
      | undefined;
    const recovery = new Promise<{
      session_id: string;
      running: boolean;
      inflight: { assistant: string; streaming: boolean };
      retired_approval_request_ids: string[];
    }>((resolve) => {
      finishRecovery = resolve;
    });
    mocks.gatewayRequest.mockImplementation((method: string) => {
      if (method !== "session.resume") return Promise.resolve({});
      resumeCount += 1;
      return resumeCount === 1 ? Promise.resolve({ session_id: "runtime-before-close" }) : recovery;
    });
    const { result } = renderHook(() => useNoteChat({ id: "note-1", title: "Launch planning" }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => {
      expect(await result.current.submit("Keep streaming through reconnect.")).toBe(true);
    });

    act(() => {
      for (const close of mocks.gatewayCloseHandlers) close();
    });
    await waitFor(() => expect(resumeCount).toBe(2));
    const replacementHandler = [...mocks.gatewayEventHandlers].at(-1);
    act(() => {
      replacementHandler?.({
        type: "message.start",
        session_id: "runtime-after-close",
        payload: { message_id: "replacement-message" },
      });
      replacementHandler?.({
        type: "message.delta",
        session_id: "runtime-after-close",
        payload: { message_id: "replacement-message", delta: "Hello " },
      });
    });
    expect(noteChatText(result.current, "assistant")).not.toContain("Hello ");

    await act(async () =>
      finishRecovery?.({
        session_id: "runtime-after-close",
        running: true,
        inflight: { assistant: "Hello world", streaming: true },
        retired_approval_request_ids: [],
      }),
    );

    await waitFor(() => expect(noteChatText(result.current, "assistant")).toBe("Hello world"));
    expect(result.current.working).toBe(true);
  });

  it.each([
    { label: "with exact pending-complete proof", assistantOrdinal: 1, expectedCopies: 1 },
    { label: "without pending-complete proof", assistantOrdinal: undefined, expectedCopies: 2 },
  ])("keeps a boundary-crossing ID-less completion fail-closed $label", async ({
    assistantOrdinal,
    expectedCopies,
  }) => {
    rememberNoteChatSession("note-1", "stored-note-chat");
    let resumeCount = 0;
    let finishRecovery:
      | ((value: {
          messages: unknown[];
          pending_message_complete?: { assistant_ordinal: number };
          retired_approval_request_ids: string[];
          running: boolean;
          session_id: string;
        }) => void)
      | undefined;
    const recovery = new Promise<{
      messages: unknown[];
      pending_message_complete?: { assistant_ordinal: number };
      retired_approval_request_ids: string[];
      running: boolean;
      session_id: string;
    }>((resolve) => {
      finishRecovery = resolve;
    });
    mocks.gatewayRequest.mockImplementation((method: string) => {
      if (method !== "session.resume") return Promise.resolve({});
      resumeCount += 1;
      return resumeCount === 1
        ? Promise.resolve({ session_id: "runtime-before-crossing-close" })
        : recovery;
    });
    const { result } = renderHook(() => useNoteChat({ id: "note-1", title: "Launch planning" }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => {
      expect(await result.current.submit("Keep the crossing reply singular when proven.")).toBe(
        true,
      );
    });

    const persistedMessages: HermesSessionMessage[] = [
      {
        id: "persisted-crossing-note-chat-user",
        role: "user",
        content: "Keep the crossing reply singular when proven.",
        timestamp: new Date(Date.now() + 1_000).toISOString(),
      },
      {
        id: "persisted-crossing-note-chat-earlier-assistant",
        role: "assistant",
        content: "Earlier content-bearing reply.",
        timestamp: new Date(Date.now() + 2_000).toISOString(),
      },
      {
        id: "persisted-crossing-note-chat-tool-call-assistant",
        role: "assistant",
        content: "   ",
        tool_calls: [{ id: "note-chat-read-1", name: "read_file" }],
        timestamp: new Date(Date.now() + 3_000).toISOString(),
      },
      {
        id: "persisted-crossing-note-chat-tool-result",
        role: "tool",
        content: "result",
        tool_call_id: "note-chat-read-1",
        timestamp: new Date(Date.now() + 4_000).toISOString(),
      },
      {
        id: "persisted-crossing-note-chat-final-assistant",
        role: "assistant",
        content: "Final Note Chat reply crossing the resume boundary.",
        timestamp: new Date(Date.now() + 5_000).toISOString(),
      },
    ];
    const originalHandler = [...mocks.gatewayEventHandlers].at(-1);
    act(() => {
      originalHandler?.({
        type: "message.start",
        event_id: `note-chat-crossing-start-${assistantOrdinal ?? "absent"}`,
        session_id: "runtime-before-crossing-close",
        payload: {},
      });
      originalHandler?.({
        type: "message.delta",
        event_id: `note-chat-crossing-delta-${assistantOrdinal ?? "absent"}`,
        session_id: "runtime-before-crossing-close",
        payload: { delta: "Final Note Chat reply crossing the resume boundary." },
      });
      for (const close of mocks.gatewayCloseHandlers) close();
    });
    await waitFor(() => expect(resumeCount).toBe(2));

    mocks.hermesBridgeSessionMessages.mockResolvedValue({ messages: persistedMessages });
    const replacementHandler = [...mocks.gatewayEventHandlers].at(-1);
    act(() => {
      replacementHandler?.({
        type: "message.complete",
        event_id: `note-chat-crossing-complete-${assistantOrdinal ?? "absent"}`,
        session_id: "runtime-after-crossing-close",
        payload: { text: "Final Note Chat reply crossing the resume boundary." },
      });
      replacementHandler?.({
        type: "turn.completed",
        event_id: `note-chat-crossing-terminal-${assistantOrdinal ?? "absent"}`,
        session_id: "runtime-after-crossing-close",
        payload: { status: "success" },
      });
    });
    const rawResumeMessages = persistedMessages.map(({ id: _id, ...message }) => message);
    await act(async () =>
      finishRecovery?.({
        messages: rawResumeMessages,
        ...(assistantOrdinal === undefined
          ? {}
          : { pending_message_complete: { assistant_ordinal: assistantOrdinal } }),
        retired_approval_request_ids: [],
        running: true,
        session_id: "runtime-after-crossing-close",
      }),
    );

    await waitFor(() => expect(result.current.working).toBe(false));
    await waitFor(() =>
      expect(
        noteChatTextParts(result.current, "assistant").filter(
          (text) => text === "Final Note Chat reply crossing the resume boundary.",
        ),
      ).toHaveLength(expectedCopies),
    );
  });

  it("replays a replacement terminal only after the resume ACK binds its runtime session id", async () => {
    rememberNoteChatSession("note-1", "stored-note-chat");
    let resumeCount = 0;
    let finishRecovery:
      | ((value: {
          session_id: string;
          running: boolean;
          retired_approval_request_ids: string[];
        }) => void)
      | undefined;
    const recovery = new Promise<{
      session_id: string;
      running: boolean;
      retired_approval_request_ids: string[];
    }>((resolve) => {
      finishRecovery = resolve;
    });
    mocks.gatewayRequest.mockImplementation((method: string) => {
      if (method !== "session.resume") return Promise.resolve({});
      resumeCount += 1;
      return resumeCount === 1 ? Promise.resolve({ session_id: "runtime-before-close" }) : recovery;
    });
    const { result } = renderHook(() => useNoteChat({ id: "note-1", title: "Launch planning" }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => {
      expect(await result.current.submit("Finish through reconnect.")).toBe(true);
    });

    act(() => {
      for (const close of mocks.gatewayCloseHandlers) close();
    });
    await waitFor(() => expect(resumeCount).toBe(2));
    act(() => {
      [...mocks.gatewayEventHandlers].at(-1)?.({
        type: "turn.completed",
        event_id: "replacement-terminal",
        session_id: "runtime-after-close",
        payload: { status: "success" },
      });
    });
    expect(result.current.working).toBe(true);

    await act(async () =>
      finishRecovery?.({
        session_id: "runtime-after-close",
        running: false,
        retired_approval_request_ids: [],
      }),
    );

    await waitFor(() => expect(result.current.working).toBe(false));
  });

  it("retires only open approvals on close and preserves fresh pre-ACK approvals", async () => {
    rememberNoteChatSession("note-1", "stored-note-chat");
    let resumeCount = 0;
    let finishRecovery:
      | ((value: { session_id: string; retired_approval_request_ids: string[] }) => void)
      | undefined;
    const recovery = new Promise<{
      session_id: string;
      retired_approval_request_ids: string[];
    }>((resolve) => {
      finishRecovery = resolve;
    });
    mocks.gatewayRequest.mockImplementation((method: string) => {
      if (method !== "session.resume") return Promise.resolve({});
      resumeCount += 1;
      return resumeCount === 1 ? Promise.resolve({ session_id: "runtime-before-close" }) : recovery;
    });
    const { result } = renderHook(() => useNoteChat({ id: "note-1", title: "Launch planning" }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => {
      expect(await result.current.submit("Exercise approval handoff.")).toBe(true);
    });
    const originalHandler = [...mocks.gatewayEventHandlers].at(-1);
    act(() => {
      originalHandler?.({
        type: "approval.request",
        session_id: "runtime-before-close",
        payload: { request_id: "open-before-close", description: "Open before close" },
      });
      originalHandler?.({
        type: "approval.request",
        session_id: "runtime-before-close",
        payload: { request_id: "resolved-before-close", description: "Already resolved" },
      });
      originalHandler?.({
        type: "approval.response",
        session_id: "runtime-before-close",
        payload: { request_id: "resolved-before-close", choice: "deny" },
      });
    });

    act(() => {
      for (const close of mocks.gatewayCloseHandlers) close();
    });
    await waitFor(() => expect(resumeCount).toBe(2));
    const approvalPartsAfterClose = result.current.turns
      .flatMap((turn) => turn.parts)
      .filter((part) => part.type === "approval");
    expect(approvalPartsAfterClose).toContainEqual(
      expect.objectContaining({ id: "open-before-close", status: "expired" }),
    );
    expect(approvalPartsAfterClose).toContainEqual(
      expect.objectContaining({ id: "resolved-before-close", status: "resolved" }),
    );

    const replacementHandler = [...mocks.gatewayEventHandlers].at(-1);
    act(() => {
      replacementHandler?.({
        type: "approval.request",
        session_id: "runtime-after-close",
        payload: { request_id: "open-before-close", description: "Retired transport replay" },
      });
      replacementHandler?.({
        type: "approval.request",
        session_id: "runtime-after-close",
        payload: { request_id: "fresh-after-close", description: "Fresh replacement request" },
      });
    });
    await act(async () =>
      finishRecovery?.({
        session_id: "runtime-after-close",
        retired_approval_request_ids: ["open-before-close"],
      }),
    );

    await waitFor(() =>
      expect(
        result.current.turns
          .flatMap((turn) => turn.parts)
          .find((part) => part.type === "approval" && part.id === "fresh-after-close"),
      ).toMatchObject({ status: "pending" }),
    );
    expect(
      result.current.turns
        .flatMap((turn) => turn.parts)
        .filter((part) => part.type === "approval" && part.id === "open-before-close"),
    ).toEqual([expect.objectContaining({ status: "expired" })]);
  });

  it("drops pre-ACK approval transitions when resume retirement metadata is absent", async () => {
    rememberNoteChatSession("note-1", "stored-note-chat");
    let resumeCount = 0;
    let finishRecovery: ((value: { session_id: string }) => void) | undefined;
    const recovery = new Promise<{ session_id: string }>((resolve) => {
      finishRecovery = resolve;
    });
    mocks.gatewayRequest.mockImplementation((method: string) => {
      if (method !== "session.resume") return Promise.resolve({});
      resumeCount += 1;
      return resumeCount === 1 ? Promise.resolve({ session_id: "runtime-before-close" }) : recovery;
    });
    const { result } = renderHook(() => useNoteChat({ id: "note-1", title: "Launch planning" }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => {
      expect(await result.current.submit("Use fail-closed approval recovery.")).toBe(true);
    });

    act(() => {
      for (const close of mocks.gatewayCloseHandlers) close();
    });
    await waitFor(() => expect(resumeCount).toBe(2));
    act(() => {
      [...mocks.gatewayEventHandlers].at(-1)?.({
        type: "approval.request",
        session_id: "runtime-after-close",
        payload: { request_id: "unproven-approval", description: "Unproven request" },
      });
    });
    await act(async () => finishRecovery?.({ session_id: "runtime-after-close" }));

    expect(
      result.current.turns
        .flatMap((turn) => turn.parts)
        .find((part) => part.type === "approval" && part.id === "unproven-approval"),
    ).toBeUndefined();
  });

  it("lets recovery overtake a dormant dispatch for the stored session id", async () => {
    rememberNoteChatSession("note-1", "stored-note-chat");
    let resumeCount = 0;
    mocks.gatewayRequest.mockImplementation((method: string) => {
      if (method !== "session.resume") return Promise.resolve({});
      resumeCount += 1;
      return Promise.resolve({
        session_id: resumeCount === 1 ? "runtime-before-close" : "runtime-after-close",
        retired_approval_request_ids: [],
      });
    });
    const { result } = renderHook(() => useNoteChat({ id: "note-1", title: "Launch planning" }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => {
      expect(await result.current.submit("Recover around the dormant dispatch.")).toBe(true);
    });

    let releaseDormantDispatch: (() => void) | undefined;
    const dormantDispatch = reserveHermesSessionDispatch("stored-note-chat").run(
      () =>
        new Promise<void>((resolve) => {
          releaseDormantDispatch = resolve;
        }),
    );
    await waitFor(() => expect(releaseDormantDispatch).toBeTypeOf("function"));
    let queuedDispatchStarted = false;
    const queuedDispatch = reserveHermesSessionDispatch("stored-note-chat").run(async () => {
      queuedDispatchStarted = true;
    });
    act(() => {
      for (const close of mocks.gatewayCloseHandlers) close();
    });

    try {
      await waitFor(() => expect(resumeCount).toBe(2), { timeout: 500 });
      expect(queuedDispatchStarted).toBe(false);
    } finally {
      releaseDormantDispatch?.();
      await Promise.all([dormantDispatch, queuedDispatch]);
    }
    expect(queuedDispatchStarted).toBe(true);
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

  it("does not reattribute a concurrently staged untagged terminal after another run settles", async () => {
    rememberNoteChatSession("note-a", "stored-a");
    rememberNoteChatSession("note-b", "stored-b");
    const resumeCounts = new Map<string, number>();
    const recoveryResolvers = new Map<
      string,
      (value: { session_id: string; retired_approval_request_ids: string[] }) => void
    >();
    mocks.gatewayRequest.mockImplementation((method: string, params?: { session_id?: string }) => {
      if (method !== "session.resume") return Promise.resolve({});
      const storedSessionId = params?.session_id ?? "";
      const count = (resumeCounts.get(storedSessionId) ?? 0) + 1;
      resumeCounts.set(storedSessionId, count);
      if (count === 1) {
        return Promise.resolve({ session_id: `${storedSessionId}-runtime-before-close` });
      }
      return new Promise((resolve) => {
        recoveryResolvers.set(storedSessionId, resolve);
      });
    });
    const noteA = renderHook(() => useNoteChat({ id: "note-a", title: "Note A" }));
    const noteB = renderHook(() => useNoteChat({ id: "note-b", title: "Note B" }));
    await waitFor(() => expect(noteA.result.current.loading).toBe(false));
    await waitFor(() => expect(noteB.result.current.loading).toBe(false));
    await act(async () => {
      expect(await noteA.result.current.submit("Keep A running.")).toBe(true);
      expect(await noteB.result.current.submit("Finish B first.")).toBe(true);
    });

    act(() => {
      [...mocks.gatewayCloseHandlers].at(-1)?.();
    });
    await waitFor(() => {
      expect(recoveryResolvers.has("stored-a")).toBe(true);
      expect(recoveryResolvers.has("stored-b")).toBe(true);
    });
    const replacementHandler = [...mocks.gatewayEventHandlers].at(-1);
    act(() => {
      replacementHandler?.({
        type: "turn.completed",
        event_id: "untagged-b-before-resume-ack",
        payload: { status: "success" },
      });
    });

    await act(async () =>
      recoveryResolvers.get("stored-b")?.({
        session_id: "stored-b-runtime-after-close",
        retired_approval_request_ids: [],
      }),
    );
    act(() => {
      replacementHandler?.({
        type: "turn.completed",
        event_id: "tagged-b-after-resume-ack",
        session_id: "stored-b-runtime-after-close",
        payload: { status: "success" },
      });
    });
    await waitFor(() => expect(noteB.result.current.working).toBe(false));
    expect(noteA.result.current.working).toBe(true);

    await act(async () =>
      recoveryResolvers.get("stored-a")?.({
        session_id: "stored-a-runtime-after-close",
        retired_approval_request_ids: [],
      }),
    );

    expect(noteA.result.current.working).toBe(true);
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

  it("does not let gateway recovery resume over a newer cross-surface Agent run", async () => {
    rememberNoteChatSession("note-1", "stored-note-chat");
    let resumeCount = 0;
    let finishRecovery: ((value: { session_id: string }) => void) | undefined;
    const recovery = new Promise<{ session_id: string }>((resolve) => {
      finishRecovery = resolve;
    });
    mocks.gatewayRequest.mockImplementation((method: string) => {
      if (method !== "session.resume") return Promise.resolve({});
      resumeCount += 1;
      if (resumeCount === 1) return Promise.resolve({ session_id: "runtime-before-close" });
      return recovery;
    });
    const { result } = renderHook(() => useNoteChat({ id: "note-1", title: "Launch planning" }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => {
      expect(await result.current.submit("Reconnect this Note Chat Agent run.")).toBe(true);
    });

    act(() => {
      for (const close of mocks.gatewayCloseHandlers) close();
    });
    await waitFor(() => expect(resumeCount).toBe(2));

    mocks.agentRunMonitorSnapshot.mockReturnValue({
      generation: 9,
      runtimeSessionId: "runtime-workspace",
      fullMode: false,
      phase: "active",
    });
    act(() => {
      window.dispatchEvent(
        new CustomEvent(AGENT_RUN_STARTED_EVENT, {
          detail: {
            storedSessionId: "stored-note-chat",
            runMonitorGeneration: 9,
            runtimeSessionId: "runtime-workspace",
            fullMode: false,
          },
        }),
      );
    });
    await act(async () => finishRecovery?.({ session_id: "runtime-after-close" }));

    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("session.interrupt", {
        session_id: "runtime-after-close",
      }),
    );
  });

  it("serializes a same runtime session id replacement through the stale interrupt", async () => {
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
    mocks.stopAgentRunMonitoring.mockReturnValue(false);
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
      expect(mocks.markAgentRunSucceeded).toHaveBeenCalledWith("stored-note-chat", 1),
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
    const priorMessages = [
      {
        id: "prior-identical-user",
        role: "user" as const,
        content: "Summarize the current plan.",
        timestamp: "2026-07-14T11:59:00Z",
      },
      {
        id: "prior-identical-assistant",
        role: "assistant" as const,
        content: "Prior summary.",
        timestamp: "2026-07-14T11:59:01Z",
      },
    ];
    mocks.hermesBridgeSessionMessages.mockResolvedValue({ messages: priorMessages });
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
    expect(mocks.startAgentRunMonitoring).toHaveBeenCalledWith(
      expect.objectContaining({
        storedSessionId: "stored-note-chat",
        runtimeSessionId: "runtime-note-chat",
        title: "Launch planning",
        fullMode: false,
        settlementHeld: false,
        acceptedPrompt: {
          dispatchedAtMs: expect.any(Number),
          findPersistedUserIndex: expect.any(Function),
        },
      }),
    );
    const acceptedPrompt = mocks.startAgentRunMonitoring.mock.calls[0]?.[0]?.acceptedPrompt;
    expect(acceptedPrompt?.findPersistedUserIndex(priorMessages)).toBe(-1);
    expect(
      acceptedPrompt?.findPersistedUserIndex([
        ...priorMessages,
        {
          id: "current-identical-user",
          role: "user",
          content: "Summarize the current plan.",
          timestamp: new Date().toISOString(),
        },
      ]),
    ).toBe(2);

    act(() => {
      for (const handler of mocks.gatewayEventHandlers) {
        handler({
          type: "turn.completed",
          session_id: "runtime-note-chat",
          payload: { status: "success" },
        });
      }
    });
    expect(mocks.markAgentRunSucceeded).toHaveBeenCalledWith("stored-note-chat", 1);
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

  it("preserves a Note Chat Agent run and offscreen continuation across panel remount", async () => {
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

  it("compacts settled offscreen reasoning once canonical history persists it", async () => {
    rememberNoteChatSession("reasoning-note", "stored-reasoning-note");
    const first = renderHook(() =>
      useNoteChat({ id: "reasoning-note", title: "Reasoning persistence" }),
    );
    await waitFor(() => expect(first.result.current.loading).toBe(false));
    await act(async () => {
      expect(await first.result.current.submit("Persist this reasoning.")).toBe(true);
    });

    const persistedMessages: HermesSessionMessage[] = [
      {
        id: "persisted-reasoning-user",
        role: "user",
        content: "Persist this reasoning.",
        timestamp: new Date(Date.now() + 1_000).toISOString(),
      },
      {
        id: "persisted-reasoning-answer",
        role: "assistant",
        content: "Persisted reasoning answer.",
        reasoning_details: [{ type: "text", text: "Matched persisted reasoning." }],
        timestamp: new Date(Date.now() + 2_000).toISOString(),
      },
    ];
    mocks.hermesBridgeSessionMessages.mockClear();
    let resolveOffscreenPersistence:
      | ((value: { messages: HermesSessionMessage[] }) => void)
      | undefined;
    mocks.hermesBridgeSessionMessages.mockReturnValue(
      new Promise((resolve) => {
        resolveOffscreenPersistence = resolve;
      }),
    );
    first.unmount();
    const handler = [...mocks.gatewayEventHandlers].at(-1);
    act(() => {
      handler?.({
        type: "message.start",
        event_id: "persisted-reasoning-start",
        session_id: "runtime-note-chat",
        payload: { message_id: "persisted-reasoning-answer" },
      });
      handler?.({
        type: "reasoning.delta",
        event_id: "persisted-reasoning-delta",
        session_id: "runtime-note-chat",
        payload: { delta: "Stale streamed prefix." },
      });
      handler?.({
        type: "reasoning.available",
        event_id: "persisted-reasoning-snapshot",
        session_id: "runtime-note-chat",
        payload: { text: "Matched persisted reasoning." },
      });
      handler?.({
        type: "message.complete",
        event_id: "persisted-reasoning-complete",
        session_id: "runtime-note-chat",
        payload: {
          message_id: "persisted-reasoning-answer",
          text: "Persisted reasoning answer.",
        },
      });
      handler?.({
        type: "turn.completed",
        event_id: "persisted-reasoning-terminal",
        session_id: "runtime-note-chat",
        payload: { status: "success" },
      });
    });
    await waitFor(() => expect(mocks.hermesBridgeSessionMessages).toHaveBeenCalled());
    await act(async () => resolveOffscreenPersistence?.({ messages: persistedMessages }));
    await act(async () => Promise.resolve());

    let resolveRehydration: ((value: { messages: HermesSessionMessage[] }) => void) | undefined;
    mocks.hermesBridgeSessionMessages.mockReturnValue(
      new Promise((resolve) => {
        resolveRehydration = resolve;
      }),
    );
    const second = renderHook(() =>
      useNoteChat({ id: "reasoning-note", title: "Reasoning persistence" }),
    );
    await waitFor(() =>
      expect(second.result.current.storedSessionId).toBe("stored-reasoning-note"),
    );
    expect(second.result.current.turns).toEqual([]);

    await act(async () => resolveRehydration?.({ messages: persistedMessages }));
    await waitFor(() => expect(second.result.current.loading).toBe(false));
    expect(noteChatReasoningText(second.result.current)).toBe("Matched persisted reasoning.");
  });

  it("retains settled offscreen reasoning that canonical history does not cover", async () => {
    rememberNoteChatSession("unmatched-reasoning-note", "stored-unmatched-reasoning-note");
    const first = renderHook(() =>
      useNoteChat({ id: "unmatched-reasoning-note", title: "Unmatched reasoning" }),
    );
    await waitFor(() => expect(first.result.current.loading).toBe(false));
    await act(async () => {
      expect(await first.result.current.submit("Keep unmatched reasoning.")).toBe(true);
    });

    const persistedMessages: HermesSessionMessage[] = [
      {
        id: "unmatched-reasoning-user",
        role: "user",
        content: "Keep unmatched reasoning.",
        timestamp: new Date(Date.now() + 1_000).toISOString(),
      },
      {
        id: "unmatched-reasoning-answer",
        role: "assistant",
        content: "Persisted unmatched answer.",
        reasoning_content: "Different persisted reasoning.",
        timestamp: new Date(Date.now() + 2_000).toISOString(),
      },
    ];
    mocks.hermesBridgeSessionMessages.mockClear();
    let resolveOffscreenPersistence:
      | ((value: { messages: HermesSessionMessage[] }) => void)
      | undefined;
    mocks.hermesBridgeSessionMessages.mockReturnValue(
      new Promise((resolve) => {
        resolveOffscreenPersistence = resolve;
      }),
    );
    first.unmount();
    const handler = [...mocks.gatewayEventHandlers].at(-1);
    act(() => {
      handler?.({
        type: "message.start",
        event_id: "unmatched-reasoning-start",
        session_id: "runtime-note-chat",
        payload: { message_id: "unmatched-reasoning-answer" },
      });
      handler?.({
        type: "reasoning.delta",
        event_id: "unmatched-reasoning-delta",
        session_id: "runtime-note-chat",
        payload: { delta: "Unique live reasoning." },
      });
      handler?.({
        type: "message.complete",
        event_id: "unmatched-reasoning-complete",
        session_id: "runtime-note-chat",
        payload: {
          message_id: "unmatched-reasoning-answer",
          text: "Persisted unmatched answer.",
        },
      });
      handler?.({
        type: "turn.completed",
        event_id: "unmatched-reasoning-terminal",
        session_id: "runtime-note-chat",
        payload: { status: "success" },
      });
    });
    await waitFor(() => expect(mocks.hermesBridgeSessionMessages).toHaveBeenCalled());
    await act(async () => resolveOffscreenPersistence?.({ messages: persistedMessages }));
    await act(async () => Promise.resolve());

    let resolveRehydration: ((value: { messages: HermesSessionMessage[] }) => void) | undefined;
    mocks.hermesBridgeSessionMessages.mockReturnValue(
      new Promise((resolve) => {
        resolveRehydration = resolve;
      }),
    );
    const second = renderHook(() =>
      useNoteChat({ id: "unmatched-reasoning-note", title: "Unmatched reasoning" }),
    );
    await waitFor(() =>
      expect(second.result.current.storedSessionId).toBe("stored-unmatched-reasoning-note"),
    );
    expect(noteChatReasoningText(second.result.current)).toContain("Unique live reasoning.");

    await act(async () => resolveRehydration?.({ messages: persistedMessages }));
    await waitFor(() => expect(second.result.current.loading).toBe(false));
  });

  it("replaces a covered mounted ID-less transcript with one canonical copy", async () => {
    rememberNoteChatSession("note-1", "stored-note-chat");
    const { result } = renderHook(() => useNoteChat({ id: "note-1", title: "Launch planning" }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => {
      expect(await result.current.submit("Keep one canonical answer.")).toBe(true);
    });

    let resolveRefresh: ((value: { messages: HermesSessionMessage[] }) => void) | undefined;
    mocks.hermesBridgeSessionMessages.mockClear();
    mocks.hermesBridgeSessionMessages.mockReturnValue(
      new Promise((resolve) => {
        resolveRefresh = resolve;
      }),
    );
    const handler = [...mocks.gatewayEventHandlers].at(-1);
    act(() => {
      handler?.({
        type: "message.complete",
        event_id: "mounted-idless-complete",
        session_id: "runtime-note-chat",
        payload: { text: "One canonical answer." },
      });
    });
    await waitFor(() => expect(mocks.hermesBridgeSessionMessages).toHaveBeenCalledTimes(1));
    expect(noteChatTextParts(result.current, "assistant")).toEqual(["One canonical answer."]);

    await act(async () =>
      resolveRefresh?.({
        messages: [
          {
            id: "persisted-mounted-user",
            role: "user",
            content: "Keep one canonical answer.",
            timestamp: new Date(Date.now() + 1_000).toISOString(),
          },
          {
            id: "persisted-mounted-assistant",
            role: "assistant",
            content: "One canonical answer.",
            timestamp: new Date(Date.now() + 2_000).toISOString(),
          },
        ],
      }),
    );

    expect(noteChatTextParts(result.current, "assistant")).toEqual(["One canonical answer."]);
  });

  it.each([
    {
      label: "media-only",
      path: "/tmp/note-chat-idless-media-only.png",
      prefix: "",
    },
    {
      label: "media-prefixed",
      path: "/tmp/note-chat-idless-media-prefixed.png",
      prefix: "Rendered once with its image.",
    },
  ])("replaces a covered mounted $label ID-less transcript with one canonical copy", async ({
    path,
    prefix,
  }) => {
    rememberNoteChatSession("note-1", "stored-note-chat");
    const first = renderHook(() => useNoteChat({ id: "note-1", title: "Launch planning" }));
    await waitFor(() => expect(first.result.current.loading).toBe(false));
    await act(async () => {
      expect(await first.result.current.submit("Keep one canonical generated image.")).toBe(true);
    });

    const transportText = [prefix, `MEDIA:${path}`].filter(Boolean).join("\n");
    let resolveRefresh: ((value: { messages: HermesSessionMessage[] }) => void) | undefined;
    mocks.hermesBridgeSessionMessages.mockClear();
    mocks.hermesBridgeSessionMessages.mockReturnValue(
      new Promise((resolve) => {
        resolveRefresh = resolve;
      }),
    );
    const handler = [...mocks.gatewayEventHandlers].at(-1);
    act(() => {
      handler?.({
        type: "message.complete",
        event_id: `mounted-${path.split("/").at(-1)}-complete`,
        session_id: "runtime-note-chat",
        payload: { text: transportText },
      });
    });
    await waitFor(() => expect(mocks.hermesBridgeSessionMessages).toHaveBeenCalledTimes(1));
    expect(
      first.result.current.turns
        .flatMap((turn) => turn.parts)
        .filter((part) => part.type === "image" && part.path === path),
    ).toHaveLength(1);

    await act(async () =>
      resolveRefresh?.({
        messages: [
          {
            id: `persisted-${path.split("/").at(-1)}-user`,
            role: "user",
            content: "Keep one canonical generated image.",
            timestamp: new Date(Date.now() + 1_000).toISOString(),
          },
          {
            id: `persisted-${path.split("/").at(-1)}-assistant`,
            role: "assistant",
            content: transportText,
            timestamp: new Date(Date.now() + 2_000).toISOString(),
          },
        ],
      }),
    );

    expect(
      first.result.current.turns
        .flatMap((turn) => turn.parts)
        .filter((part) => part.type === "image" && part.path === path),
    ).toHaveLength(1);
    if (prefix) {
      expect(
        noteChatTextParts(first.result.current, "assistant").filter((text) => text === prefix),
      ).toHaveLength(1);
    }

    mocks.hermesBridgeSessionMessages.mockResolvedValue({
      messages: [
        {
          id: `persisted-${path.split("/").at(-1)}-user`,
          role: "user",
          content: "Keep one canonical generated image.",
          timestamp: new Date(Date.now() + 1_000).toISOString(),
        },
        {
          id: `persisted-${path.split("/").at(-1)}-assistant`,
          role: "assistant",
          content: transportText,
          timestamp: new Date(Date.now() + 2_000).toISOString(),
        },
      ],
    });
    act(() => {
      handler?.({
        type: "turn.completed",
        event_id: `mounted-${path.split("/").at(-1)}-terminal`,
        session_id: "runtime-note-chat",
        payload: { status: "success" },
      });
    });
    await waitFor(() => expect(first.result.current.working).toBe(false));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    let resolveRemount: ((value: { messages: HermesSessionMessage[] }) => void) | undefined;
    mocks.hermesBridgeSessionMessages.mockReturnValue(
      new Promise((resolve) => {
        resolveRemount = resolve;
      }),
    );
    first.unmount();
    const second = renderHook(() => useNoteChat({ id: "note-1", title: "Launch planning" }));
    await waitFor(() => expect(second.result.current.storedSessionId).toBe("stored-note-chat"));
    expect(second.result.current.turns).toEqual([]);
    await act(async () => resolveRemount?.({ messages: [] }));
  });

  it("ignores empty assistant tool-call rows when proving an ID-less canonical reply", async () => {
    rememberNoteChatSession("note-1", "stored-note-chat");
    const { result } = renderHook(() => useNoteChat({ id: "note-1", title: "Launch planning" }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => {
      expect(await result.current.submit("Read the file, then answer.")).toBe(true);
    });

    let resolveRefresh: ((value: { messages: HermesSessionMessage[] }) => void) | undefined;
    mocks.hermesBridgeSessionMessages.mockClear();
    mocks.hermesBridgeSessionMessages.mockReturnValue(
      new Promise((resolve) => {
        resolveRefresh = resolve;
      }),
    );
    const handler = [...mocks.gatewayEventHandlers].at(-1);
    act(() => {
      handler?.({
        type: "message.complete",
        event_id: "tool-tail-idless-complete",
        session_id: "runtime-note-chat",
        payload: { text: "The file says hello." },
      });
    });
    await waitFor(() => expect(mocks.hermesBridgeSessionMessages).toHaveBeenCalledTimes(1));

    await act(async () =>
      resolveRefresh?.({
        messages: [
          {
            id: "persisted-tool-tail-user",
            role: "user",
            content: "Read the file, then answer.",
            timestamp: new Date(Date.now() + 1_000).toISOString(),
          },
          {
            id: "persisted-empty-tool-call-assistant",
            role: "assistant",
            content: "   ",
            tool_calls: [{ id: "read-1", name: "read_file" }],
            timestamp: new Date(Date.now() + 2_000).toISOString(),
          },
          {
            id: "persisted-tool-result",
            role: "tool",
            content: "hello",
            tool_call_id: "read-1",
            timestamp: new Date(Date.now() + 3_000).toISOString(),
          },
          {
            id: "persisted-tool-tail-answer",
            role: "assistant",
            content: "The file says hello.",
            timestamp: new Date(Date.now() + 4_000).toISOString(),
          },
        ],
      }),
    );

    expect(noteChatTextParts(result.current, "assistant")).toEqual(["The file says hello."]);
  });

  it("does not reuse a persisted assistant ordinal for a later identical ID-less reply", async () => {
    rememberNoteChatSession("note-1", "stored-note-chat");
    const { result } = renderHook(() => useNoteChat({ id: "note-1", title: "Launch planning" }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => {
      expect(await result.current.submit("Give both identical replies.")).toBe(true);
    });

    const firstPersistedReply: HermesSessionMessage[] = [
      {
        id: "persisted-identical-user",
        role: "user",
        content: "Give both identical replies.",
        timestamp: new Date(Date.now() + 1_000).toISOString(),
      },
      {
        id: "persisted-first-identical-assistant",
        role: "assistant",
        content: "Same reply.",
        timestamp: new Date(Date.now() + 2_000).toISOString(),
      },
    ];
    let resolveFirstRefresh: ((value: { messages: HermesSessionMessage[] }) => void) | undefined;
    mocks.hermesBridgeSessionMessages.mockClear();
    mocks.hermesBridgeSessionMessages.mockReturnValue(
      new Promise((resolve) => {
        resolveFirstRefresh = resolve;
      }),
    );
    const handler = [...mocks.gatewayEventHandlers].at(-1);
    act(() => {
      handler?.({
        type: "message.complete",
        event_id: "first-identical-idless-complete",
        session_id: "runtime-note-chat",
        payload: { text: "Same reply." },
      });
    });
    await waitFor(() => expect(mocks.hermesBridgeSessionMessages).toHaveBeenCalledTimes(1));
    await act(async () => resolveFirstRefresh?.({ messages: firstPersistedReply }));
    expect(noteChatTextParts(result.current, "assistant")).toEqual(["Same reply."]);

    let resolveSecondRefresh: ((value: { messages: HermesSessionMessage[] }) => void) | undefined;
    mocks.hermesBridgeSessionMessages.mockClear();
    mocks.hermesBridgeSessionMessages.mockReturnValue(
      new Promise((resolve) => {
        resolveSecondRefresh = resolve;
      }),
    );
    act(() => {
      handler?.({
        type: "message.complete",
        event_id: "second-identical-idless-complete",
        session_id: "runtime-note-chat",
        payload: { text: "Same reply." },
      });
    });
    await waitFor(() => expect(mocks.hermesBridgeSessionMessages).toHaveBeenCalledTimes(1));
    expect(noteChatTextParts(result.current, "assistant")).toEqual(["Same reply.", "Same reply."]);

    await act(async () => resolveSecondRefresh?.({ messages: firstPersistedReply }));
    expect(noteChatTextParts(result.current, "assistant")).toEqual(["Same reply.", "Same reply."]);
  });

  it("retains an active ID-less partial during persisted hydration", async () => {
    rememberNoteChatSession("note-1", "stored-note-chat");
    const first = renderHook(() => useNoteChat({ id: "note-1", title: "Launch planning" }));
    await waitFor(() => expect(first.result.current.loading).toBe(false));
    await act(async () => {
      expect(await first.result.current.submit("Keep the active partial.")).toBe(true);
    });

    const handler = [...mocks.gatewayEventHandlers].at(-1);
    act(() => {
      handler?.({
        type: "message.delta",
        event_id: "active-idless-partial",
        session_id: "runtime-note-chat",
        payload: { delta: "Active partial" },
      });
    });
    expect(noteChatTextParts(first.result.current, "assistant")).toEqual(["Active partial"]);
    first.unmount();

    let resolveHydration: ((value: { messages: HermesSessionMessage[] }) => void) | undefined;
    mocks.hermesBridgeSessionMessages.mockReturnValue(
      new Promise((resolve) => {
        resolveHydration = resolve;
      }),
    );
    const second = renderHook(() => useNoteChat({ id: "note-1", title: "Launch planning" }));
    await waitFor(() => expect(second.result.current.storedSessionId).toBe("stored-note-chat"));
    expect(noteChatTextParts(second.result.current, "assistant")).toEqual(["Active partial"]);

    await act(async () =>
      resolveHydration?.({
        messages: [
          {
            id: "persisted-active-partial-user",
            role: "user",
            content: "Keep the active partial.",
            timestamp: new Date(Date.now() + 1_000).toISOString(),
          },
          {
            id: "persisted-active-partial-assistant",
            role: "assistant",
            content: "Active partial completed by persistence.",
            timestamp: new Date(Date.now() + 2_000).toISOString(),
          },
        ],
      }),
    );
    await waitFor(() => expect(second.result.current.loading).toBe(false));

    expect(noteChatTextParts(second.result.current, "assistant")).toEqual([
      "Active partial completed by persistence.",
      "Active partial",
    ]);
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

  it("retains distinct complete-only idless messages until every text part persists", async () => {
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
    mocks.hermesBridgeSessionMessages
      .mockResolvedValueOnce({ messages: [] })
      .mockReturnValueOnce(older)
      .mockReturnValueOnce(newer);
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
    await waitFor(() => expect(mocks.hermesBridgeSessionMessages).toHaveBeenCalledTimes(2));
    act(() => {
      for (const handler of mocks.gatewayEventHandlers) {
        handler({
          type: "message.complete",
          session_id: "runtime-note-chat",
          payload: { message_id: "m2", text: "Second live answer." },
        });
      }
    });
    await waitFor(() => expect(mocks.hermesBridgeSessionMessages).toHaveBeenCalledTimes(3));

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
          detail: {
            sessionId: "another-session",
            runMonitorGeneration: 1,
            title: "Other",
            summary: "June finished.",
          },
        }),
      );
    });
    expect(result.current.working).toBe(true);

    act(() => {
      window.dispatchEvent(
        new CustomEvent(AGENT_RUN_SETTLED_EVENT, {
          detail: {
            sessionId: "stored-note-chat",
            runMonitorGeneration: 1,
            title: "Launch planning",
            summary: "June finished.",
          },
        }),
      );
    });
    expect(result.current.working).toBe(false);
    await waitFor(() => expect(mocks.hermesBridgeSessionMessages).toHaveBeenCalledTimes(2));
  });

  it("keeps a newer external run working when its old local gateway terminal arrives", async () => {
    rememberNoteChatSession("note-1", "stored-note-chat");
    mocks.startAgentRunMonitoring.mockReturnValueOnce(41).mockReturnValueOnce(42);
    const { result } = renderHook(() => useNoteChat({ id: "note-1", title: "Launch planning" }));
    await waitFor(() => expect(result.current.storedSessionId).toBe("stored-note-chat"));

    await act(async () => {
      expect(await result.current.submit("Finish the first generation.")).toBe(true);
    });
    act(() => {
      for (const handler of mocks.gatewayEventHandlers) {
        handler({
          type: "turn.completed",
          session_id: "runtime-note-chat",
          event_id: "first-generation-terminal",
          payload: { status: "success" },
        });
      }
    });
    expect(result.current.working).toBe(false);
    expect(mocks.markAgentRunSucceeded).toHaveBeenCalledWith("stored-note-chat", 41);

    await act(async () => {
      expect(await result.current.submit("Keep the second generation working.")).toBe(true);
    });
    expect(result.current.working).toBe(true);

    act(() => {
      window.dispatchEvent(
        new CustomEvent(AGENT_RUN_STARTED_EVENT, {
          detail: {
            storedSessionId: "stored-note-chat",
            runMonitorGeneration: 43,
            runtimeSessionId: "runtime-note-chat",
            fullMode: false,
          },
        }),
      );
    });
    expect(result.current.working).toBe(true);
    expect(result.current.error).toBeNull();

    act(() => {
      for (const handler of mocks.gatewayEventHandlers) {
        handler({
          type: "error",
          session_id: "runtime-note-chat",
          event_id: "terminal-after-monitor-replacement",
          payload: {
            message: "The local run failed after replacement",
            code: 500,
            recoverable: false,
          },
        });
      }
    });
    expect(mocks.isAgentRunMonitorGenerationCurrent).not.toHaveBeenCalledWith(
      "stored-note-chat",
      42,
    );
    expect(result.current.working).toBe(true);
    expect(result.current.error).toBeNull();
    expect(mocks.cancelAgentRunMonitoring).not.toHaveBeenCalledWith("stored-note-chat", 42);

    act(() => {
      window.dispatchEvent(
        new CustomEvent<AgentSessionStatusDetail>(AGENT_SESSION_STATUS_EVENT, {
          detail: {
            sessionId: "stored-note-chat",
            runMonitorGeneration: 43,
            title: "Launch planning",
            status: "failed",
            summary: "The newer external run failed",
          },
        }),
      );
    });
    expect(result.current.working).toBe(false);
    expect(result.current.error).toBe("The newer external run failed");
  });

  it("shows an externally started run in an otherwise idle note chat", async () => {
    rememberNoteChatSession("note-1", "stored-note-chat");
    const { result } = renderHook(() => useNoteChat({ id: "note-1", title: "Launch planning" }));
    await waitFor(() => expect(result.current.storedSessionId).toBe("stored-note-chat"));
    expect(result.current.working).toBe(false);

    act(() => {
      window.dispatchEvent(
        new CustomEvent(AGENT_RUN_STARTED_EVENT, {
          detail: {
            storedSessionId: "stored-note-chat",
            runMonitorGeneration: 7,
            runtimeSessionId: "runtime-workspace",
            fullMode: false,
          },
        }),
      );
    });
    expect(result.current.working).toBe(true);
    await act(async () => {
      expect(await result.current.submit("Do not overlap the external run.")).toBe(false);
    });
    const turnsBeforeStaleFrames = result.current.turns;

    act(() => {
      for (const handler of mocks.gatewayEventHandlers) {
        handler({
          type: "message.delta",
          session_id: "runtime-workspace",
          payload: { message_id: "stale-message", delta: "Stale external text" },
        });
        handler({
          type: "error",
          session_id: "runtime-workspace",
          event_id: "unowned-external-terminal",
          payload: { message: "External gateway failed", code: 500, recoverable: false },
        });
      }
    });
    expect(result.current.working).toBe(true);
    expect(result.current.error).toBeNull();
    expect(result.current.turns).toEqual(turnsBeforeStaleFrames);
    expect(noteChatText(result.current, "assistant")).not.toContain("Stale external text");

    act(() => {
      window.dispatchEvent(
        new CustomEvent(AGENT_RUN_SETTLED_EVENT, {
          detail: {
            sessionId: "stored-note-chat",
            runMonitorGeneration: 7,
            title: "Launch planning",
            summary: "June finished.",
          },
        }),
      );
    });
    expect(result.current.working).toBe(false);
  });

  it("hydrates a note chat that mounts after an external monitor started", async () => {
    rememberNoteChatSession("note-1", "stored-note-chat");
    mocks.agentRunMonitorSnapshot.mockReturnValue({
      generation: 8,
      runtimeSessionId: "runtime-workspace",
      fullMode: false,
      phase: "active",
    });

    const { result } = renderHook(() => useNoteChat({ id: "note-1", title: "Launch planning" }));
    await waitFor(() => expect(result.current.storedSessionId).toBe("stored-note-chat"));
    expect(result.current.working).toBe(true);
    await act(async () => {
      expect(await result.current.submit("Do not overlap the late-mounted run.")).toBe(false);
    });

    act(() => {
      window.dispatchEvent(
        new CustomEvent(AGENT_RUN_SETTLED_EVENT, {
          detail: {
            sessionId: "stored-note-chat",
            runMonitorGeneration: 8,
            title: "Launch planning",
            summary: "June finished.",
          },
        }),
      );
    });
    expect(result.current.working).toBe(false);
  });

  it.each([
    "stopping",
    "succeeded",
    "terminal",
  ] as const)("keeps a late-mounted %s monitor snapshot idle", async (phase) => {
    rememberNoteChatSession("note-1", "stored-note-chat");
    mocks.agentRunMonitorSnapshot.mockReturnValue({
      generation: 9,
      runtimeSessionId: "runtime-old",
      fullMode: false,
      phase,
    });
    const { result } = renderHook(() => useNoteChat({ id: "note-1", title: "Launch planning" }));
    await waitFor(() => expect(result.current.storedSessionId).toBe("stored-note-chat"));
    expect(result.current.working).toBe(false);

    if (phase === "stopping") {
      await act(async () => {
        expect(await result.current.submit("Resume only after Stop.")).toBe(true);
      });
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("session.resume", {
        session_id: "stored-note-chat",
        cols: 96,
      });
      expect(mocks.gatewayRequest).not.toHaveBeenCalledWith("prompt.submit", {
        session_id: "runtime-old",
        text: "Resume only after Stop.",
      });
    }
  });

  it("preserves a failure that arrives before its queued same-generation start", async () => {
    rememberNoteChatSession("note-1", "stored-note-chat");
    mocks.agentRunMonitorSnapshot.mockReturnValue({
      generation: 12,
      runtimeSessionId: "runtime-workspace",
      fullMode: false,
      phase: "terminal",
    });
    const { result } = renderHook(() => useNoteChat({ id: "note-1", title: "Launch planning" }));
    await waitFor(() => expect(result.current.storedSessionId).toBe("stored-note-chat"));

    act(() => {
      window.dispatchEvent(
        new CustomEvent<AgentSessionStatusDetail>(AGENT_SESSION_STATUS_EVENT, {
          detail: {
            sessionId: "stored-note-chat",
            runMonitorGeneration: 12,
            status: "failed",
            summary: "Fast failure.",
          },
        }),
      );
      window.dispatchEvent(
        new CustomEvent(AGENT_RUN_STARTED_EVENT, {
          detail: {
            storedSessionId: "stored-note-chat",
            runMonitorGeneration: 12,
            runtimeSessionId: "runtime-workspace",
            fullMode: false,
          },
        }),
      );
    });

    expect(result.current.working).toBe(false);
    expect(result.current.error).toBe("Fast failure.");
  });

  it("lets a newer terminal supersede an older stopped generation before its queued start", async () => {
    rememberNoteChatSession("note-1", "stored-note-chat");
    const { result } = renderHook(() => useNoteChat({ id: "note-1", title: "Launch planning" }));
    await waitFor(() => expect(result.current.storedSessionId).toBe("stored-note-chat"));
    await act(async () => {
      expect(await result.current.submit("Start generation one.")).toBe(true);
    });
    act(() => result.current.stop());
    expect(result.current.working).toBe(false);

    mocks.agentRunMonitorSnapshot.mockReturnValue({
      generation: 2,
      runtimeSessionId: "runtime-workspace",
      fullMode: false,
      phase: "terminal",
    });
    act(() => {
      window.dispatchEvent(
        new CustomEvent<AgentSessionStatusDetail>(AGENT_SESSION_STATUS_EVENT, {
          detail: {
            sessionId: "stored-note-chat",
            runMonitorGeneration: 2,
            status: "failed",
            summary: "Generation two failed fast.",
          },
        }),
      );
      window.dispatchEvent(
        new CustomEvent(AGENT_RUN_STARTED_EVENT, {
          detail: {
            storedSessionId: "stored-note-chat",
            runMonitorGeneration: 2,
            runtimeSessionId: "runtime-workspace",
            fullMode: false,
          },
        }),
      );
    });

    expect(result.current.working).toBe(false);
    expect(result.current.error).toBe("Generation two failed fast.");
  });

  it("keeps legacy approval retirement sticky when a newer terminal arrives before run-start", async () => {
    rememberNoteChatSession("note-1", "stored-note-chat");
    let rejectPrompt: ((error: Error) => void) | undefined;
    const heldPrompt = new Promise<void>((_resolve, reject) => {
      rejectPrompt = reject;
    });
    mocks.gatewayRequest.mockImplementation((method: string) => {
      if (method === "session.resume") {
        return Promise.resolve({ session_id: "runtime-note-chat" });
      }
      if (method === "prompt.submit") return heldPrompt;
      return Promise.resolve({});
    });
    const { result } = renderHook(() => useNoteChat({ id: "note-1", title: "Launch planning" }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    let submission = Promise.resolve(true);
    act(() => {
      submission = result.current.submit("An older local prompt.");
    });
    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", expect.anything()),
    );

    const legacyApproval = {
      type: "approval.request",
      session_id: "runtime-note-chat",
      payload: {
        description: "Connect the calendar account?",
        pattern_key: "mcp_elicitation",
      },
    };
    const classifiedApproval = classifyHermesEvent(legacyApproval);
    if (
      classifiedApproval.kind !== "pending_action" ||
      classifiedApproval.action.kind !== "approval"
    ) {
      throw new Error("Expected an approval request");
    }
    act(() => {
      for (const handler of mocks.gatewayEventHandlers) {
        handler(legacyApproval);
        handler({
          type: "approval.expire",
          session_id: "runtime-note-chat",
          payload: {
            request_id: classifiedApproval.action.requestId,
            reason: "disconnect",
          },
        });
      }
    });

    mocks.agentRunMonitorSnapshot.mockReturnValue({
      generation: 9,
      runtimeSessionId: "runtime-workspace",
      fullMode: false,
      phase: "terminal",
    });
    act(() => {
      window.dispatchEvent(
        new CustomEvent<AgentSessionStatusDetail>(AGENT_SESSION_STATUS_EVENT, {
          detail: {
            sessionId: "stored-note-chat",
            runMonitorGeneration: 9,
            status: "failed",
            summary: "The newer run failed before start delivery.",
          },
        }),
      );
    });
    expect(result.current.working).toBe(false);

    act(() => {
      for (const handler of mocks.gatewayEventHandlers) handler(legacyApproval);
    });
    expect(
      result.current.turns
        .flatMap((turn) => turn.parts)
        .find(
          (part) => part.type === "approval" && part.id === classifiedApproval.action.requestId,
        ),
    ).toMatchObject({ type: "approval", status: "expired" });

    await act(async () => rejectPrompt?.(new Error("Older prompt failed.")));
    await expect(submission).resolves.toBe(false);
  });

  it.each([
    "resolve",
    "reject",
  ] as const)("preserves a newer external run when an older in-flight NoteChat submit %s", async (outcome) => {
    rememberNoteChatSession("note-1", "stored-note-chat");
    let resolvePrompt: (() => void) | undefined;
    let rejectPrompt: ((error: Error) => void) | undefined;
    const heldPrompt = new Promise<void>((resolve, reject) => {
      resolvePrompt = resolve;
      rejectPrompt = reject;
    });
    mocks.gatewayRequest.mockImplementation((method: string) => {
      if (method === "session.resume") {
        return Promise.resolve({ session_id: "runtime-note-chat" });
      }
      if (method === "prompt.submit") return heldPrompt;
      return Promise.resolve({});
    });
    const { result } = renderHook(() => useNoteChat({ id: "note-1", title: "Launch planning" }));
    await waitFor(() => expect(result.current.storedSessionId).toBe("stored-note-chat"));

    let submission = Promise.resolve(true);
    act(() => {
      submission = result.current.submit("Older in-flight prompt.");
    });
    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
        session_id: "runtime-note-chat",
        text: "Older in-flight prompt.",
      }),
    );
    act(() => {
      window.dispatchEvent(
        new CustomEvent(AGENT_RUN_STARTED_EVENT, {
          detail: {
            storedSessionId: "stored-note-chat",
            runMonitorGeneration: 9,
            runtimeSessionId: "runtime-workspace",
            fullMode: false,
          },
        }),
      );
    });
    await act(async () => {
      if (outcome === "resolve") resolvePrompt?.();
      else rejectPrompt?.(new Error("Older prompt failed."));
      await submission;
    });

    await expect(submission).resolves.toBe(false);
    expect(result.current.working).toBe(true);
    expect(result.current.error).toBeNull();
    expect(mocks.startAgentRunMonitoring).not.toHaveBeenCalled();
    expect(mocks.cancelAgentRunMonitoring).not.toHaveBeenCalled();
  });

  it.each([
    "resolve",
    "reject",
  ] as const)("keeps a newer fast terminal authoritative when an older pre-ACK NoteChat submit %s", async (outcome) => {
    rememberNoteChatSession("note-1", "stored-note-chat");
    let resolvePrompt: (() => void) | undefined;
    let rejectPrompt: ((error: Error) => void) | undefined;
    const heldPrompt = new Promise<void>((resolve, reject) => {
      resolvePrompt = resolve;
      rejectPrompt = reject;
    });
    mocks.gatewayRequest.mockImplementation((method: string) => {
      if (method === "session.resume") {
        return Promise.resolve({ session_id: "runtime-note-chat" });
      }
      if (method === "prompt.submit") return heldPrompt;
      return Promise.resolve({});
    });
    const { result } = renderHook(() => useNoteChat({ id: "note-1", title: "Launch planning" }));
    await waitFor(() => expect(result.current.storedSessionId).toBe("stored-note-chat"));
    let submission = Promise.resolve(true);
    act(() => {
      submission = result.current.submit("Older pre-ACK prompt.");
    });
    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
        session_id: "runtime-note-chat",
        text: "Older pre-ACK prompt.",
      }),
    );

    mocks.agentRunMonitorSnapshot.mockReturnValue({
      generation: 9,
      runtimeSessionId: "runtime-workspace",
      fullMode: false,
      phase: "terminal",
    });
    act(() => {
      window.dispatchEvent(
        new CustomEvent<AgentSessionStatusDetail>(AGENT_SESSION_STATUS_EVENT, {
          detail: {
            sessionId: "stored-note-chat",
            runMonitorGeneration: 9,
            status: "failed",
            summary: "Newer run failed before start delivery.",
          },
        }),
      );
      window.dispatchEvent(
        new CustomEvent(AGENT_RUN_STARTED_EVENT, {
          detail: {
            storedSessionId: "stored-note-chat",
            runMonitorGeneration: 9,
            runtimeSessionId: "runtime-workspace",
            fullMode: false,
          },
        }),
      );
    });
    expect(result.current.working).toBe(false);
    expect(result.current.error).toBe("Newer run failed before start delivery.");

    await act(async () => {
      if (outcome === "resolve") resolvePrompt?.();
      else rejectPrompt?.(new Error("Older prompt failed."));
      await submission;
    });
    await expect(submission).resolves.toBe(false);
    expect(result.current.working).toBe(false);
    expect(result.current.error).toBe("Newer run failed before start delivery.");
    expect(mocks.startAgentRunMonitoring).not.toHaveBeenCalled();
  });

  it("ignores a prior Agent run monitor settlement before the current submit is accepted", async () => {
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
            runMonitorGeneration: 1,
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
    expect(mocks.markAgentRunSucceeded).toHaveBeenCalledWith("stored-note-chat", 1);
  });

  it("does not let a replayed terminal settle a later Note Chat Agent run", async () => {
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

  it("does not let an untagged terminal replay settle a later Note Chat Agent run", async () => {
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

  it("does not let a repeated no-id completion plus partial prose beat a current failure", async () => {
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
          content: "I only wrote part of the answer.",
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
    expect(mocks.preserveAgentRunTerminalEvidence).toHaveBeenCalledWith(
      "stored-note-chat",
      expect.objectContaining({
        status: "completed",
        summary: "June finished.",
        notBeforeMs: expect.any(Number),
      }),
      1,
    );

    activeStatus = "idle";
    act(() => {
      for (const handler of mocks.gatewayEventHandlers) handler(terminal);
    });
    await waitFor(() =>
      expect(
        mocks.gatewayRequest.mock.calls.filter(([method]) => method === "session.active_list"),
      ).toHaveLength(activeListCallsBefore + 2),
    );
    expect(result.current.working).toBe(true);
    expect(mocks.markAgentRunSucceeded).not.toHaveBeenCalled();

    act(() => {
      for (const handler of mocks.gatewayEventHandlers) {
        handler({
          type: "error",
          session_id: "runtime-note-chat",
          event_id: "current-run-failure",
          payload: {
            message: "The current run failed after partial output",
            code: 500,
            recoverable: false,
          },
        });
      }
    });
    expect(result.current.working).toBe(false);
    expect(result.current.error).toBe("The current run failed after partial output");
    expect(mocks.markAgentRunSucceeded).not.toHaveBeenCalled();
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

  it("preserves a consecutive identical no-id failure until monitoring resolves it", async () => {
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

    await waitFor(() =>
      expect(mocks.preserveAgentRunTerminalEvidence).toHaveBeenCalledWith(
        "stored-note-chat",
        expect.objectContaining({
          status: "failed",
          summary: "Upstream failed",
          notBeforeMs: expect.any(Number),
        }),
        1,
      ),
    );
    expect(result.current.working).toBe(true);
    expect(mocks.cancelAgentRunMonitoring).toHaveBeenCalledTimes(1);

    act(() => {
      window.dispatchEvent(
        new CustomEvent<AgentSessionStatusDetail>(AGENT_SESSION_STATUS_EVENT, {
          detail: {
            sessionId: "stored-note-chat",
            runMonitorGeneration: 1,
            title: "Launch planning",
            status: "failed",
            summary: "Upstream failed",
          },
        }),
      );
    });
    await waitFor(() => expect(result.current.working).toBe(false));
    expect(result.current.error).toBe("Upstream failed");
  });

  it("does not let a repeated no-id failure override a persisted successful reply", async () => {
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
    const staleFailure = {
      type: "error",
      session_id: "runtime-note-chat",
      payload: { message: "Prior upstream failure", code: 500, recoverable: false },
    };

    await act(async () => {
      expect(await result.current.submit("Seed the prior failure.")).toBe(true);
    });
    act(() => {
      for (const handler of mocks.gatewayEventHandlers) handler(staleFailure);
    });
    expect(result.current.working).toBe(false);

    await act(async () => {
      expect(await result.current.submit("Complete the current run successfully.")).toBe(true);
    });
    let releaseAuthorityProbe: ((value: { messages: HermesSessionMessage[] }) => void) | undefined;
    const authorityProbe = new Promise<{ messages: HermesSessionMessage[] }>((resolve) => {
      releaseAuthorityProbe = resolve;
    });
    mocks.hermesBridgeSessionMessages.mockClear();
    mocks.hermesBridgeSessionMessages.mockReturnValue(authorityProbe);
    mocks.cancelAgentRunMonitoring.mockClear();

    act(() => {
      for (const handler of mocks.gatewayEventHandlers) handler(staleFailure);
    });
    await waitFor(() => expect(mocks.hermesBridgeSessionMessages).toHaveBeenCalledTimes(1));
    await act(async () =>
      releaseAuthorityProbe?.({
        messages: [
          {
            id: "current-user",
            role: "user",
            content: "Complete the current run successfully.",
            timestamp: new Date().toISOString(),
          },
          {
            id: "current-assistant",
            role: "assistant",
            content: "The current run completed successfully.",
            timestamp: new Date(Date.now() + 1_000).toISOString(),
          },
        ],
      }),
    );

    expect(result.current.working).toBe(true);
    expect(result.current.error).toBeNull();
    expect(mocks.cancelAgentRunMonitoring).not.toHaveBeenCalled();

    act(() => {
      for (const handler of mocks.gatewayEventHandlers) {
        handler({
          type: "turn.completed",
          session_id: "runtime-note-chat",
          event_id: "current-success",
          payload: { status: "success" },
        });
      }
    });
    expect(result.current.working).toBe(false);
    expect(mocks.markAgentRunSucceeded).toHaveBeenCalledWith("stored-note-chat", 1);
  });

  it("preserves a failed message completion without terminally settling the Note Chat Agent run", async () => {
    rememberNoteChatSession("note-1", "stored-note-chat");
    const { result } = renderHook(() => useNoteChat({ id: "note-1", title: "Launch planning" }));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      expect(await result.current.submit("Search the note, then summarize it.")).toBe(true);
    });
    const monitorInput = mocks.startAgentRunMonitoring.mock.calls[0]?.[0];
    const dispatchedAtMs = monitorInput?.acceptedPrompt?.dispatchedAtMs;
    expect(dispatchedAtMs).toEqual(expect.any(Number));
    mocks.preserveAgentRunTerminalEvidence.mockClear();
    mocks.markAgentRunSucceeded.mockClear();
    mocks.cancelAgentRunMonitoring.mockClear();

    act(() => {
      for (const handler of mocks.gatewayEventHandlers) {
        handler({
          type: "message.complete",
          session_id: "runtime-note-chat",
          payload: {
            message_id: "failed-after-tool",
            status: "error",
            text: "Context length exceeded after the final tool result.",
          },
        });
      }
    });

    expect(mocks.preserveAgentRunTerminalEvidence).toHaveBeenCalledWith(
      "stored-note-chat",
      {
        status: "failed",
        summary: "Context length exceeded after the final tool result.",
        notBeforeMs: dispatchedAtMs,
      },
      1,
    );
    expect(mocks.markAgentRunSucceeded).not.toHaveBeenCalled();
    expect(mocks.cancelAgentRunMonitoring).not.toHaveBeenCalled();
    expect(result.current.working).toBe(true);
  });

  it("passes a pre-ack failed message completion into the accepted run monitor", async () => {
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
    await waitFor(() => expect(result.current.loading).toBe(false));

    let submission: Promise<boolean> = Promise.resolve(false);
    act(() => {
      submission = result.current.submit("Fail before the acknowledgement arrives.");
    });
    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", expect.anything()),
    );
    act(() => {
      for (const handler of mocks.gatewayEventHandlers) {
        handler({
          type: "message.complete",
          session_id: "runtime-note-chat",
          payload: {
            message_id: "pre-ack-failure",
            status: "error",
            text: "The provider stopped before replying.",
          },
        });
      }
    });

    expect(mocks.startAgentRunMonitoring).not.toHaveBeenCalled();
    expect(mocks.preserveAgentRunTerminalEvidence).not.toHaveBeenCalled();
    expect(result.current.working).toBe(true);

    await act(async () => acceptPrompt?.());
    await expect(submission).resolves.toBe(true);
    expect(mocks.startAgentRunMonitoring).toHaveBeenCalledWith(
      expect.objectContaining({
        storedSessionId: "stored-note-chat",
        terminalEvidence: {
          status: "failed",
          summary: "The provider stopped before replying.",
          notBeforeMs: expect.any(Number),
        },
      }),
    );
    const monitorInput = mocks.startAgentRunMonitoring.mock.calls[0]?.[0];
    expect(monitorInput?.terminalEvidence?.notBeforeMs).toBe(
      monitorInput?.acceptedPrompt?.dispatchedAtMs,
    );
    expect(mocks.markAgentRunSucceeded).not.toHaveBeenCalled();
    expect(mocks.cancelAgentRunMonitoring).not.toHaveBeenCalled();
    expect(result.current.working).toBe(true);
  });

  it("does not carry a rejected prompt's failed completion into the next Note Chat Agent run", async () => {
    rememberNoteChatSession("note-1", "stored-note-chat");
    let rejectPrompt: ((reason: Error) => void) | undefined;
    const rejectedPrompt = new Promise<void>((_resolve, reject) => {
      rejectPrompt = reject;
    });
    let rejectFirstPrompt = true;
    mocks.gatewayRequest.mockImplementation((method: string) => {
      if (method === "session.resume") {
        return Promise.resolve({ session_id: "runtime-note-chat" });
      }
      if (method === "prompt.submit" && rejectFirstPrompt) return rejectedPrompt;
      return Promise.resolve({});
    });
    const { result } = renderHook(() => useNoteChat({ id: "note-1", title: "Launch planning" }));
    await waitFor(() => expect(result.current.loading).toBe(false));

    let rejectedSubmission: Promise<boolean> = Promise.resolve(true);
    act(() => {
      rejectedSubmission = result.current.submit("Reject this failed run.");
    });
    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", expect.anything()),
    );
    act(() => {
      for (const handler of mocks.gatewayEventHandlers) {
        handler({
          type: "message.complete",
          session_id: "runtime-note-chat",
          payload: {
            message_id: "rejected-prompt-failure",
            status: "error",
            text: "This evidence belongs only to the rejected prompt.",
          },
        });
      }
    });
    await act(async () => rejectPrompt?.(new Error("Prompt rejected")));
    await expect(rejectedSubmission).resolves.toBe(false);
    expect(mocks.startAgentRunMonitoring).not.toHaveBeenCalled();
    expect(mocks.preserveAgentRunTerminalEvidence).not.toHaveBeenCalled();

    rejectFirstPrompt = false;
    await act(async () => {
      expect(await result.current.submit("Start a clean replacement run.")).toBe(true);
    });
    expect(mocks.startAgentRunMonitoring).toHaveBeenCalledTimes(1);
    expect(mocks.startAgentRunMonitoring.mock.calls[0]?.[0]?.terminalEvidence).toBeUndefined();
    expect(result.current.working).toBe(true);
  });

  it("preserves a repeated pre-ack failure when the failed run persisted partial prose", async () => {
    rememberNoteChatSession("note-1", "stored-note-chat");
    let holdPrompt = false;
    let acceptPrompt: (() => void) | undefined;
    const heldPrompt = new Promise<void>((resolve) => {
      acceptPrompt = resolve;
    });
    mocks.gatewayRequest.mockImplementation((method: string) => {
      if (method === "session.resume") {
        return Promise.resolve({ session_id: "runtime-note-chat" });
      }
      if (method === "prompt.submit") return holdPrompt ? heldPrompt : Promise.resolve({});
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
    const failure = {
      type: "error",
      session_id: "runtime-note-chat",
      payload: {
        message: "Pre-ack failure after partial reply",
        code: 504,
        recoverable: false,
      },
    };

    await act(async () => {
      expect(await result.current.submit("Seed the repeated failure.")).toBe(true);
    });
    act(() => {
      for (const handler of mocks.gatewayEventHandlers) handler(failure);
    });

    let releaseEarlierSend: () => void = () => undefined;
    const earlierSend = reserveHermesSessionDispatch("stored-note-chat").run(
      () =>
        new Promise<void>((resolve) => {
          releaseEarlierSend = resolve;
        }),
    );
    holdPrompt = true;
    mocks.gatewayRequest.mockClear();
    mocks.preserveAgentRunTerminalEvidence.mockClear();
    mocks.startAgentRunMonitoring.mockClear();
    const optimisticCreatedBeforeMs = Date.now();
    let submission: Promise<boolean> = Promise.resolve(false);
    act(() => {
      submission = result.current.submit("Fail after writing partial prose.");
    });
    await waitFor(() => expect(result.current.working).toBe(true));
    expect(mocks.gatewayRequest).not.toHaveBeenCalledWith("prompt.submit", expect.anything());
    await new Promise((resolve) => setTimeout(resolve, 10));
    const dispatchReleasedAtMs = Date.now();
    releaseEarlierSend();
    await earlierSend;
    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", expect.anything()),
    );
    mocks.hermesBridgeSessionMessages.mockResolvedValue({
      messages: [
        {
          id: "current-user",
          role: "user",
          content: "Fail after writing partial prose.",
          timestamp: new Date().toISOString(),
        },
        {
          id: "partial-assistant",
          role: "assistant",
          content: "I started the answer but could not finish.",
          timestamp: new Date(Date.now() + 1_000).toISOString(),
        },
      ],
    });
    act(() => {
      for (const handler of mocks.gatewayEventHandlers) handler(failure);
    });
    expect(mocks.preserveAgentRunTerminalEvidence).not.toHaveBeenCalled();

    await act(async () => acceptPrompt?.());
    await expect(submission).resolves.toBe(true);
    expect(mocks.startAgentRunMonitoring).toHaveBeenCalledWith(
      expect.objectContaining({
        storedSessionId: "stored-note-chat",
        terminalEvidence: expect.objectContaining({
          status: "failed",
          summary: "Pre-ack failure after partial reply",
          notBeforeMs: expect.any(Number),
        }),
      }),
    );
    const monitorInput = mocks.startAgentRunMonitoring.mock.calls[0]?.[0];
    const initialEvidence = monitorInput?.terminalEvidence;
    expect(initialEvidence?.notBeforeMs).toBeGreaterThan(optimisticCreatedBeforeMs);
    expect(initialEvidence?.notBeforeMs).toBeGreaterThanOrEqual(dispatchReleasedAtMs);
    expect(monitorInput?.acceptedPrompt.dispatchedAtMs).toBe(initialEvidence?.notBeforeMs);
    expect(
      monitorInput?.acceptedPrompt.findPersistedUserIndex([
        {
          id: "older-unrelated-user",
          role: "user",
          content: "A different question.",
          timestamp: new Date(optimisticCreatedBeforeMs - 1_000).toISOString(),
        },
        {
          id: "current-user",
          role: "user",
          content: "Fail after writing partial prose.",
          timestamp: new Date().toISOString(),
        },
      ]),
    ).toBe(1);
    await waitFor(() =>
      expect(mocks.preserveAgentRunTerminalEvidence).toHaveBeenCalledWith(
        "stored-note-chat",
        expect.objectContaining({
          status: "failed",
          summary: "Pre-ack failure after partial reply",
          notBeforeMs: expect.any(Number),
        }),
        1,
      ),
    );
    expect(result.current.working).toBe(true);
    expect(mocks.markAgentRunSucceeded).not.toHaveBeenCalled();

    act(() => {
      window.dispatchEvent(
        new CustomEvent<AgentSessionStatusDetail>(AGENT_SESSION_STATUS_EVENT, {
          detail: {
            sessionId: "stored-note-chat",
            runMonitorGeneration: 1,
            title: "Launch planning",
            status: "failed",
            summary: "Pre-ack failure after partial reply",
          },
        }),
      );
    });
    await waitFor(() => expect(result.current.working).toBe(false));
    await waitFor(() =>
      expect(noteChatText(result.current, "assistant")).toContain(
        "I started the answer but could not finish.",
      ),
    );
    expect(result.current.error).toBe("Pre-ack failure after partial reply");
  });

  it("latches a unique pre-ack failure when its one-shot authority read fails", async () => {
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
      submission = result.current.submit("Fail uniquely before acknowledgement.");
    });
    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", expect.anything()),
    );
    act(() => {
      for (const handler of mocks.gatewayEventHandlers) {
        handler({
          type: "error",
          event_id: "unique-pre-ack-failure",
          session_id: "runtime-note-chat",
          payload: {
            message: "Unique pre-ack failure",
            code: 500,
            recoverable: false,
          },
        });
      }
    });
    mocks.hermesBridgeSessionMessages.mockRejectedValueOnce(
      new Error("Transient persistence read failure"),
    );

    await act(async () => acceptPrompt?.());
    await expect(submission).resolves.toBe(true);
    await waitFor(() => expect(mocks.startAgentRunMonitoring).toHaveBeenCalledTimes(1));

    expect(mocks.startAgentRunMonitoring).toHaveBeenCalledWith(
      expect.objectContaining({
        storedSessionId: "stored-note-chat",
        terminalEvidence: expect.objectContaining({
          status: "failed",
          summary: "Unique pre-ack failure",
          notBeforeMs: expect.any(Number),
        }),
      }),
    );
    expect(result.current.working).toBe(true);
    expect(mocks.markAgentRunSucceeded).not.toHaveBeenCalled();
  });

  it("discards buffered terminal ambiguity when prompt submission is rejected", async () => {
    rememberNoteChatSession("note-1", "stored-note-chat");
    let rejectCurrentPrompt = false;
    let rejectPrompt: ((reason: Error) => void) | undefined;
    const rejectedPrompt = new Promise<void>((_resolve, reject) => {
      rejectPrompt = reject;
    });
    mocks.gatewayRequest.mockImplementation((method: string) => {
      if (method === "session.resume") {
        return Promise.resolve({ session_id: "runtime-note-chat" });
      }
      if (method === "prompt.submit") {
        return rejectCurrentPrompt ? rejectedPrompt : Promise.resolve({});
      }
      return Promise.resolve({});
    });
    const { result } = renderHook(() => useNoteChat({ id: "note-1", title: "Launch planning" }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    const failure = {
      type: "error",
      session_id: "runtime-note-chat",
      payload: { message: "Buffered failure", code: 500, recoverable: false },
    };

    await act(async () => {
      expect(await result.current.submit("Seed buffered failure.")).toBe(true);
    });
    act(() => {
      for (const handler of mocks.gatewayEventHandlers) handler(failure);
    });

    rejectCurrentPrompt = true;
    mocks.gatewayRequest.mockClear();
    mocks.preserveAgentRunTerminalEvidence.mockClear();
    mocks.startAgentRunMonitoring.mockClear();
    let submission: Promise<boolean> = Promise.resolve(true);
    act(() => {
      submission = result.current.submit("Reject this prompt.");
    });
    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", expect.anything()),
    );
    act(() => {
      for (const handler of mocks.gatewayEventHandlers) handler(failure);
    });
    await act(async () => rejectPrompt?.(new Error("Prompt rejected")));

    await expect(submission).resolves.toBe(false);
    expect(mocks.preserveAgentRunTerminalEvidence).not.toHaveBeenCalled();
    expect(mocks.startAgentRunMonitoring).not.toHaveBeenCalled();
    expect(result.current.working).toBe(false);
  });

  it("drains a newer repeated terminal after a lagging authority probe", async () => {
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
    const staleFailure = {
      type: "error",
      session_id: "runtime-note-chat",
      payload: { message: "Stale replay failure", code: 500, recoverable: false },
    };
    const currentFailure = {
      type: "error",
      session_id: "runtime-note-chat",
      payload: { message: "Current run failure", code: 503, recoverable: false },
    };

    await act(async () => {
      expect(await result.current.submit("Seed stale replay authority.")).toBe(true);
    });
    act(() => {
      for (const handler of mocks.gatewayEventHandlers) handler(staleFailure);
    });
    await act(async () => {
      expect(await result.current.submit("Seed current failure authority.")).toBe(true);
    });
    act(() => {
      for (const handler of mocks.gatewayEventHandlers) handler(currentFailure);
    });

    await act(async () => {
      expect(await result.current.submit("Fail the current run after replay.")).toBe(true);
    });
    let releaseLaggingProbe: ((value: { messages: HermesSessionMessage[] }) => void) | undefined;
    const laggingProbe = new Promise<{ messages: HermesSessionMessage[] }>((resolve) => {
      releaseLaggingProbe = resolve;
    });
    let authorityReads = 0;
    mocks.hermesBridgeSessionMessages.mockImplementation(() => {
      authorityReads += 1;
      if (authorityReads === 1) return laggingProbe;
      return Promise.resolve({
        messages: [
          {
            id: "current-failed-user",
            role: "user",
            content: "Fail the current run after replay.",
            timestamp: new Date().toISOString(),
          },
        ],
      });
    });

    act(() => {
      for (const handler of mocks.gatewayEventHandlers) handler(staleFailure);
    });
    await waitFor(() => expect(authorityReads).toBe(1));
    act(() => {
      for (let duplicate = 0; duplicate < 3; duplicate += 1) {
        for (const handler of mocks.gatewayEventHandlers) handler(currentFailure);
      }
    });
    await act(async () => releaseLaggingProbe?.({ messages: [] }));

    await waitFor(() =>
      expect(mocks.preserveAgentRunTerminalEvidence).toHaveBeenCalledWith(
        "stored-note-chat",
        expect.objectContaining({
          status: "failed",
          summary: "Current run failure",
          notBeforeMs: expect.any(Number),
        }),
        1,
      ),
    );
    expect(result.current.working).toBe(true);
    expect(authorityReads).toBe(2);

    act(() => {
      window.dispatchEvent(
        new CustomEvent<AgentSessionStatusDetail>(AGENT_SESSION_STATUS_EVENT, {
          detail: {
            sessionId: "stored-note-chat",
            runMonitorGeneration: 1,
            title: "Launch planning",
            status: "failed",
            summary: "Current run failure",
          },
        }),
      );
    });
    await waitFor(() => expect(result.current.working).toBe(false));
    expect(result.current.error).toBe("Current run failure");
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
    expect(mocks.stopAgentRunMonitoring).toHaveBeenCalledWith(
      "stored-note-chat",
      1,
      expect.any(Function),
    );
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

  it("does not attribute an untagged terminal when another Note Chat Agent run exists", async () => {
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
      expect(mocks.cancelAgentRunMonitoring).toHaveBeenCalledWith("stored-note-chat", 1);
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

    await waitFor(() => expect(result.current.working).toBe(true));
    expect(mocks.gatewayRequest).not.toHaveBeenCalledWith("session.resume", expect.anything());
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

  it("does not resume a queued session before an external run-start supersedes it", async () => {
    rememberNoteChatSession("note-1", "stored-note-chat");
    const { result } = renderHook(() => useNoteChat({ id: "note-1", title: "Launch planning" }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    mocks.gatewayRequest.mockClear();

    let releaseEarlierSend: () => void = () => undefined;
    const earlierSend = reserveHermesSessionDispatch("stored-note-chat").run(
      () =>
        new Promise<void>((resolve) => {
          releaseEarlierSend = resolve;
        }),
    );
    let submission: Promise<boolean> = Promise.resolve(true);
    act(() => {
      submission = result.current.submit("This send should be superseded.");
    });
    await waitFor(() => expect(result.current.working).toBe(true));

    expect(mocks.gatewayRequest).not.toHaveBeenCalledWith("session.resume", expect.anything());
    expect(mocks.gatewayRequest).not.toHaveBeenCalledWith("prompt.submit", expect.anything());

    act(() => {
      window.dispatchEvent(
        new CustomEvent(AGENT_RUN_STARTED_EVENT, {
          detail: {
            storedSessionId: "stored-note-chat",
            runMonitorGeneration: 9,
            runtimeSessionId: "runtime-workspace",
            fullMode: false,
          },
        }),
      );
    });
    releaseEarlierSend();
    await earlierSend;
    await expect(submission).resolves.toBe(false);

    expect(mocks.gatewayRequest).not.toHaveBeenCalledWith("session.resume", expect.anything());
    expect(mocks.gatewayRequest).not.toHaveBeenCalledWith("prompt.submit", expect.anything());
  });

  it("checks the external run monitor before rebinding a session transport", async () => {
    rememberNoteChatSession("note-1", "stored-note-chat");
    const { result } = renderHook(() => useNoteChat({ id: "note-1", title: "Launch planning" }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    mocks.gatewayRequest.mockClear();
    // The external monitor can be installed after this continuity record was
    // created but before its transport-rebinding resume reaches the gateway.
    mocks.agentRunMonitorSnapshot.mockReturnValue({
      generation: 9,
      runtimeSessionId: "runtime-workspace",
      fullMode: false,
      phase: "active",
    });

    await act(async () => {
      expect(await result.current.submit("Do not steal the active run.")).toBe(false);
    });

    expect(mocks.gatewayRequest).not.toHaveBeenCalledWith("session.resume", expect.anything());
    expect(mocks.gatewayRequest).not.toHaveBeenCalledWith("prompt.submit", expect.anything());
    expect(result.current.error).toBe("June is still working on the previous message.");
  });

  it("submits with the cached runtime after its own monitor reports success", async () => {
    rememberNoteChatSession("note-1", "stored-note-chat");
    const { result } = renderHook(() => useNoteChat({ id: "note-1", title: "Launch planning" }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => {
      expect(await result.current.submit("Finish the first run.")).toBe(true);
    });
    act(() => {
      for (const handler of mocks.gatewayEventHandlers) {
        handler({
          type: "turn.completed",
          event_id: "first-run-terminal",
          session_id: "runtime-note-chat",
          payload: { status: "success" },
        });
      }
    });
    await waitFor(() => expect(result.current.working).toBe(false));
    mocks.agentRunMonitorSnapshot.mockReturnValue({
      generation: 1,
      runtimeSessionId: "runtime-note-chat",
      fullMode: false,
      phase: "succeeded",
    });
    mocks.gatewayRequest.mockClear();

    await act(async () => {
      expect(await result.current.submit("Start the next run.")).toBe(true);
    });

    expect(mocks.gatewayRequest).not.toHaveBeenCalledWith("session.resume", expect.anything());
    expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
      session_id: "runtime-note-chat",
      text: "Start the next run.",
    });
  });

  it("does not recover an external Agent run onto the NoteChat gateway", async () => {
    rememberNoteChatSession("note-1", "stored-note-chat");
    const { result } = renderHook(() => useNoteChat({ id: "note-1", title: "Launch planning" }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => {
      expect(await result.current.submit("Establish the NoteChat gateway.")).toBe(true);
    });

    mocks.agentRunMonitorSnapshot.mockReturnValue({
      generation: 9,
      runtimeSessionId: "runtime-workspace",
      fullMode: false,
      phase: "active",
    });
    act(() => {
      window.dispatchEvent(
        new CustomEvent(AGENT_RUN_STARTED_EVENT, {
          detail: {
            storedSessionId: "stored-note-chat",
            runMonitorGeneration: 9,
            runtimeSessionId: "runtime-workspace",
            fullMode: false,
          },
        }),
      );
    });
    mocks.gatewayRequest.mockClear();

    act(() => {
      for (const handler of mocks.gatewayCloseHandlers) handler();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(mocks.gatewayRequest).not.toHaveBeenCalledWith("session.resume", expect.anything());
  });

  it("starts legacy approval replay scope at the queued prompt dispatch boundary", async () => {
    rememberNoteChatSession("note-1", "stored-note-chat");
    const { result } = renderHook(() => useNoteChat({ id: "note-1", title: "Launch planning" }));
    await waitFor(() => expect(result.current.loading).toBe(false));

    let releaseEarlierSend: () => void = () => undefined;
    const earlierSend = reserveHermesSessionDispatch("stored-note-chat").run(
      () =>
        new Promise<void>((resolve) => {
          releaseEarlierSend = resolve;
        }),
    );
    let submission: Promise<boolean> = Promise.resolve(false);
    act(() => {
      submission = result.current.submit("Ask after the earlier surface finishes.");
    });
    await waitFor(() => expect(result.current.working).toBe(true));
    expect(mocks.gatewayRequest).not.toHaveBeenCalledWith("session.resume", expect.anything());
    expect(mocks.gatewayRequest).not.toHaveBeenCalledWith("prompt.submit", expect.anything());

    const legacyApproval = {
      type: "approval.request",
      session_id: "runtime-note-chat",
      payload: {
        description: "Connect the calendar account?",
        pattern_key: "mcp_elicitation",
      },
    };
    const classifiedApproval = classifyHermesEvent(legacyApproval);
    if (
      classifiedApproval.kind !== "pending_action" ||
      classifiedApproval.action.kind !== "approval"
    ) {
      throw new Error("Expected an approval request");
    }
    act(() => {
      for (const handler of mocks.gatewayEventHandlers) {
        handler(legacyApproval);
        handler({
          type: "approval.expire",
          session_id: "runtime-note-chat",
          payload: {
            request_id: classifiedApproval.action.requestId,
            reason: "disconnect",
          },
        });
      }
    });

    releaseEarlierSend();
    await earlierSend;
    await act(async () => expect(await submission).toBe(true));

    act(() => {
      for (const handler of mocks.gatewayEventHandlers) handler(legacyApproval);
    });

    expect(
      result.current.turns
        .flatMap((turn) => turn.parts)
        .find(
          (part) => part.type === "approval" && part.id === classifiedApproval.action.requestId,
        ),
    ).toMatchObject({ type: "approval", status: "pending" });
  });

  it("restores legacy approval replay scope when prompt dispatch is rejected", async () => {
    rememberNoteChatSession("note-1", "stored-note-chat");
    mocks.gatewayRequest.mockImplementation((method: string) => {
      if (method === "session.resume") {
        return Promise.resolve({ session_id: "runtime-note-chat" });
      }
      if (method === "prompt.submit") return Promise.reject(new Error("session is busy"));
      return Promise.resolve({});
    });
    const { result } = renderHook(() => useNoteChat({ id: "note-1", title: "Launch planning" }));
    await waitFor(() => expect(result.current.loading).toBe(false));

    const legacyApproval = {
      type: "approval.request",
      session_id: "stored-note-chat",
      payload: {
        description: "Connect the calendar account?",
        pattern_key: "mcp_elicitation",
      },
    };
    const classifiedApproval = classifyHermesEvent(legacyApproval);
    if (
      classifiedApproval.kind !== "pending_action" ||
      classifiedApproval.action.kind !== "approval"
    ) {
      throw new Error("Expected an approval request");
    }
    act(() => {
      for (const handler of mocks.gatewayEventHandlers) {
        handler(legacyApproval);
        handler({
          type: "approval.expire",
          session_id: "stored-note-chat",
          payload: {
            request_id: classifiedApproval.action.requestId,
            reason: "disconnect",
          },
        });
      }
    });

    await act(async () => {
      expect(await result.current.submit("This prompt will be rejected.")).toBe(false);
    });
    act(() => {
      for (const handler of mocks.gatewayEventHandlers) handler(legacyApproval);
    });

    expect(
      result.current.turns
        .flatMap((turn) => turn.parts)
        .find(
          (part) => part.type === "approval" && part.id === classifiedApproval.action.requestId,
        ),
    ).toMatchObject({ type: "approval", status: "expired" });
  });

  it("rolls back legacy approval events admitted while prompt dispatch is pending", async () => {
    rememberNoteChatSession("note-1", "stored-note-chat");
    const { result } = renderHook(() => useNoteChat({ id: "note-1", title: "Launch planning" }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => {
      expect(await result.current.submit("Seed the preceding run.")).toBe(true);
    });

    const legacyApproval = {
      type: "approval.request",
      session_id: "stored-note-chat",
      payload: {
        description: "Connect the calendar account?",
        pattern_key: "mcp_elicitation",
      },
    };
    const classifiedApproval = classifyHermesEvent(legacyApproval);
    if (
      classifiedApproval.kind !== "pending_action" ||
      classifiedApproval.action.kind !== "approval"
    ) {
      throw new Error("Expected an approval request");
    }
    act(() => {
      for (const handler of mocks.gatewayEventHandlers) {
        handler(legacyApproval);
        handler({
          type: "approval.expire",
          session_id: "stored-note-chat",
          payload: {
            request_id: classifiedApproval.action.requestId,
            reason: "disconnect",
          },
        });
      }
    });
    expect(
      result.current.turns
        .flatMap((turn) => turn.parts)
        .some(
          (part) =>
            part.type === "approval" &&
            part.id === classifiedApproval.action.requestId &&
            part.status === "expired",
        ),
    ).toBe(true);

    act(() => {
      window.dispatchEvent(
        new CustomEvent(AGENT_RUN_SETTLED_EVENT, {
          detail: {
            sessionId: "stored-note-chat",
            title: "Launch planning",
            runMonitorGeneration: 1,
            summary: "June finished.",
          },
        }),
      );
    });
    await waitFor(() => expect(result.current.working).toBe(false));

    let rejectPrompt: ((error: Error) => void) | undefined;
    const heldPrompt = new Promise<void>((_resolve, reject) => {
      rejectPrompt = reject;
    });
    mocks.gatewayRequest.mockImplementation((method: string) => {
      if (method === "prompt.submit") return heldPrompt;
      return Promise.resolve({});
    });

    let submission = Promise.resolve(true);
    act(() => {
      submission = result.current.submit("This prompt will be rejected after dispatch.");
    });
    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", expect.anything()),
    );
    act(() => {
      for (const handler of mocks.gatewayEventHandlers) {
        handler({ ...legacyApproval, session_id: "runtime-note-chat" });
      }
    });
    expect(
      result.current.turns
        .flatMap((turn) => turn.parts)
        .some(
          (part) =>
            part.type === "approval" &&
            part.id === classifiedApproval.action.requestId &&
            part.status === "pending",
        ),
    ).toBe(false);

    // The socket may close before the rejected RPC settles. Deferred events
    // must already carry the stored session id because close invalidates runtime session id aliases.
    act(() => {
      for (const handler of mocks.gatewayCloseHandlers) handler();
    });

    await act(async () => rejectPrompt?.(new HermesGatewayError("session is busy", 4009)));
    await expect(submission).resolves.toBe(false);
    const approvals = result.current.turns
      .flatMap((turn) => turn.parts)
      .filter(
        (part) => part.type === "approval" && part.id === classifiedApproval.action.requestId,
      );
    expect(approvals).toContainEqual(expect.objectContaining({ status: "expired" }));
    expect(approvals).not.toContainEqual(expect.objectContaining({ status: "pending" }));
  });

  it("snapshots persisted users after the dispatch lock before matching an identical prompt", async () => {
    rememberNoteChatSession("note-1", "stored-note-chat");
    const { result } = renderHook(() => useNoteChat({ id: "note-1", title: "Launch planning" }));
    await waitFor(() => expect(result.current.loading).toBe(false));

    let releaseEarlierSend: () => void = () => undefined;
    const earlierSend = reserveHermesSessionDispatch("stored-note-chat").run(
      () =>
        new Promise<void>((resolve) => {
          releaseEarlierSend = resolve;
        }),
    );
    let submission: Promise<boolean> = Promise.resolve(false);
    act(() => {
      submission = result.current.submit("Repeat the queued prompt.");
    });
    await waitFor(() => expect(result.current.working).toBe(true));
    expect(mocks.gatewayRequest).not.toHaveBeenCalledWith("prompt.submit", expect.anything());

    const earlierPersistedRun: HermesSessionMessage[] = [
      {
        id: "earlier-identical-user",
        role: "user",
        content: "Repeat the queued prompt.",
        timestamp: "2026-07-16T12:00:00Z",
      },
      {
        id: "earlier-identical-assistant",
        role: "assistant",
        content: "Earlier queued answer.",
        timestamp: "2026-07-16T12:00:00Z",
      },
    ];
    mocks.hermesBridgeSessionMessages.mockResolvedValue({ messages: earlierPersistedRun });
    releaseEarlierSend();
    await earlierSend;
    await act(async () => expect(await submission).toBe(true));

    const monitorInput = mocks.startAgentRunMonitoring.mock.calls[0]?.[0];
    expect(monitorInput?.acceptedPrompt.findPersistedUserIndex(earlierPersistedRun)).toBe(-1);
    expect(
      monitorInput?.acceptedPrompt.findPersistedUserIndex([
        ...earlierPersistedRun,
        {
          id: "current-identical-user",
          role: "user",
          content: "Repeat the queued prompt.",
          // Hermes can truncate the current row to second precision. Its
          // post-lock ordinal still proves it was not in the baseline.
          timestamp: new Date(
            Math.floor(monitorInput.acceptedPrompt.dispatchedAtMs / 1_000) * 1_000,
          ).toISOString(),
        },
      ]),
    ).toBe(2);
  });

  it("falls back without blocking Send when the dispatch snapshot read hangs", async () => {
    rememberNoteChatSession("note-1", "stored-note-chat");
    const { result } = renderHook(() => useNoteChat({ id: "note-1", title: "Launch planning" }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    mocks.hermesBridgeSessionMessages.mockImplementation(() => new Promise(() => {}));

    vi.useFakeTimers();
    try {
      let submission: Promise<boolean> = Promise.resolve(false);
      act(() => {
        submission = result.current.submit("Send despite the hung snapshot.");
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(mocks.gatewayRequest).not.toHaveBeenCalledWith("prompt.submit", expect.anything());

      await act(async () => {
        await vi.advanceTimersByTimeAsync(250);
      });
      await expect(submission).resolves.toBe(true);
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
        session_id: "runtime-note-chat",
        text: "Send despite the hung snapshot.",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("finalizes a dispatched Note Chat Agent run without clearing the new note's Stop fence", async () => {
    rememberNoteChatSession("note-a", "stored-a");
    rememberNoteChatSession("note-b", "stored-b");
    let acceptPrompt: (() => void) | undefined;
    const promptAccepted = new Promise<void>((resolve) => {
      acceptPrompt = resolve;
    });
    mocks.gatewayRequest.mockImplementation((method: string, params?: { session_id?: string }) => {
      if (method === "session.resume") {
        return Promise.resolve({
          session_id: params?.session_id === "stored-a" ? "runtime-a" : "runtime-b",
        });
      }
      if (method === "prompt.submit" && params?.session_id === "runtime-a") {
        return promptAccepted;
      }
      return Promise.resolve({});
    });

    const sending = renderHook(
      ({ id }) => useNoteChat({ id, title: id === "note-a" ? "Note A" : "Note B" }),
      { initialProps: { id: "note-a" } },
    );
    await waitFor(() => expect(sending.result.current.loading).toBe(false));

    let noteASubmit: Promise<boolean> = Promise.resolve(false);
    act(() => {
      noteASubmit = sending.result.current.submit("Question for A");
    });
    await waitFor(() =>
      expect(mocks.gatewayRequest).toHaveBeenCalledWith("prompt.submit", {
        session_id: "runtime-a",
        text: "Question for A",
      }),
    );

    sending.rerender({ id: "note-b" });
    await waitFor(() => expect(sending.result.current.loading).toBe(false));
    expect(sending.result.current.storedSessionId).toBe("stored-b");
    expect(sending.result.current.working).toBe(false);
    expect(sending.result.current.turns).toEqual([]);

    await act(async () => {
      expect(await sending.result.current.submit("Question for B")).toBe(true);
    });
    expect(sending.result.current.working).toBe(true);
    act(() => sending.result.current.stop());
    expect(mocks.stopAgentRunMonitoring).toHaveBeenCalledWith("stored-b", 1, expect.any(Function));
    expect(sending.result.current.working).toBe(false);
    expect(noteChatText(sending.result.current, "user")).toContain("Question for B");
    mocks.markAgentRunSucceeded.mockClear();

    await act(async () => acceptPrompt?.());
    await expect(noteASubmit).resolves.toBe(false);
    expect(mocks.startAgentRunMonitoring).toHaveBeenCalledWith(
      expect.objectContaining({
        storedSessionId: "stored-a",
        runtimeSessionId: "runtime-a",
      }),
    );
    expect(sending.result.current.storedSessionId).toBe("stored-b");
    expect(sending.result.current.working).toBe(false);
    expect(noteChatText(sending.result.current, "user")).toContain("Question for B");

    act(() => {
      for (const handler of mocks.gatewayEventHandlers) {
        handler({
          type: "turn.completed",
          session_id: "runtime-b",
          payload: { status: "success" },
        });
      }
    });
    expect(mocks.markAgentRunSucceeded).not.toHaveBeenCalledWith("stored-b", 1);
    expect(sending.result.current.working).toBe(false);

    const noteAWhileWorking = renderHook(() => useNoteChat({ id: "note-a", title: "Note A" }));
    await waitFor(() => expect(noteAWhileWorking.result.current.loading).toBe(false));
    expect(noteAWhileWorking.result.current.working).toBe(true);
    noteAWhileWorking.unmount();

    const noteARefreshesBefore = mocks.hermesBridgeSessionMessages.mock.calls.filter(
      ([sessionId]) => sessionId === "stored-a",
    ).length;
    mocks.hermesBridgeSessionMessages.mockImplementation((sessionId: string) =>
      Promise.resolve({
        messages:
          sessionId === "stored-a"
            ? [
                {
                  id: "note-a-user",
                  role: "user",
                  content: "Question for A",
                  timestamp: new Date(Date.now() + 1_000).toISOString(),
                },
                {
                  id: "note-a-assistant",
                  role: "assistant",
                  content: "Answer for A",
                  timestamp: new Date(Date.now() + 2_000).toISOString(),
                },
              ]
            : [],
      }),
    );
    act(() => {
      window.dispatchEvent(
        new CustomEvent(AGENT_RUN_SETTLED_EVENT, {
          detail: {
            sessionId: "stored-a",
            runMonitorGeneration: 1,
            title: "Note A",
            summary: "June finished.",
          },
        }),
      );
    });
    await waitFor(() =>
      expect(
        mocks.hermesBridgeSessionMessages.mock.calls.filter(
          ([sessionId]) => sessionId === "stored-a",
        ).length,
      ).toBeGreaterThan(noteARefreshesBefore),
    );
    expect(sending.result.current.storedSessionId).toBe("stored-b");
    expect(sending.result.current.working).toBe(false);
    expect(noteChatText(sending.result.current, "user")).toContain("Question for B");

    const noteAAfterSettlement = renderHook(() => useNoteChat({ id: "note-a", title: "Note A" }));
    await waitFor(() =>
      expect(noteChatText(noteAAfterSettlement.result.current, "assistant")).toContain(
        "Answer for A",
      ),
    );
    expect(noteAAfterSettlement.result.current.working).toBe(false);
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
    mocks.stopAgentRunMonitoring.mockImplementation(() => true);
    mocks.gatewayRequest.mockImplementation((method: string, params?: { session_id?: string }) => {
      if (method === "session.resume") {
        return Promise.resolve({ session_id: `runtime-${params?.session_id}` });
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
    expect(mocks.stopAgentRunMonitoring).toHaveBeenCalledWith("stored-a", 1, expect.any(Function));
    const stopCalls = mocks.stopAgentRunMonitoring.mock.calls as unknown as Array<
      [string, number, () => void]
    >;
    const onStopped = stopCalls.at(-1)?.[2];
    sending.rerender({ id: "note-b" });
    await waitFor(() => expect(sending.result.current.loading).toBe(false));
    const refreshCountBefore = mocks.hermesBridgeSessionMessages.mock.calls.length;
    await act(async () => onStopped?.());
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
