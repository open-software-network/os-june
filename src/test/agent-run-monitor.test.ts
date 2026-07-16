import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { HermesSessionInfo } from "../lib/tauri";

type GatewayFrame = {
  type: string;
  session_id?: string;
  payload?: Record<string, unknown>;
};

const monitorMocks = vi.hoisted(() => {
  type EventHandler = (event: GatewayFrame) => void;
  type CloseHandler = () => void;

  const request = vi.fn();
  const bridgeStatus = vi.fn();
  const sessions = vi.fn();
  const sessionMessages = vi.fn();
  const dispatchSettled = vi.fn();
  const dispatchStarted = vi.fn();
  const dispatchStatus = vi.fn();
  const instances: MockGateway[] = [];

  class MockGateway {
    readonly eventHandlers = new Set<EventHandler>();
    readonly closeHandlers = new Set<CloseHandler>();
    close = vi.fn();
    connect = vi.fn(async (_url: string) => undefined);

    constructor() {
      instances.push(this);
    }

    onEvent(handler: EventHandler) {
      this.eventHandlers.add(handler);
      return () => this.eventHandlers.delete(handler);
    }

    onClose(handler: CloseHandler) {
      this.closeHandlers.add(handler);
      return () => this.closeHandlers.delete(handler);
    }

    request<T>(method: string, params: Record<string, unknown>) {
      return request(method, params) as Promise<T>;
    }

    emit(event: GatewayFrame) {
      for (const handler of [...this.eventHandlers]) handler(event);
    }
  }

  return {
    MockGateway,
    bridgeStatus,
    dispatchSettled,
    dispatchStarted,
    dispatchStatus,
    instances,
    request,
    sessions,
    sessionMessages,
  };
});

vi.mock("../lib/hermes-gateway", () => ({
  HermesGatewayClient: monitorMocks.MockGateway,
}));

vi.mock("../lib/tauri", () => ({
  hermesBridgeStatus: monitorMocks.bridgeStatus,
  hermesBridgeSessions: monitorMocks.sessions,
  hermesBridgeSessionMessages: monitorMocks.sessionMessages,
}));

vi.mock("../lib/agent-events", () => ({
  dispatchAgentRunSettled: monitorMocks.dispatchSettled,
  dispatchAgentRunStarted: monitorMocks.dispatchStarted,
  dispatchAgentSessionStatus: monitorMocks.dispatchStatus,
}));

import {
  agentRunMonitorSnapshot,
  canAttributeUntaggedAgentRun,
  cancelAgentRunMonitoring,
  isAgentRunMonitorGenerationCurrent,
  markAgentRunFailed,
  markAgentRunSucceeded,
  preserveAgentRunTerminalEvidence,
  releaseAgentRunSettlement,
  resetAgentRunMonitoringForTests,
  startAgentRunMonitoring,
  stopAgentRunMonitoring,
} from "../lib/agent-run-monitor";
import {
  holdHermesSessionDispatch,
  withHermesSessionDispatchLock,
} from "../lib/hermes-session-dispatch-mutex";

const SANDBOXED_CONNECTION = {
  baseUrl: "http://127.0.0.1:9000",
  wsUrl: "ws://127.0.0.1:9000",
  token: "test-token",
  port: 9000,
  command: "hermes",
  hermesHome: "/tmp/hermes",
  providerProxyPort: 9001,
  pid: 1,
  sandboxed: true,
  fullMode: false,
};

const UNRESTRICTED_CONNECTION = {
  ...SANDBOXED_CONNECTION,
  baseUrl: "http://127.0.0.1:9010",
  wsUrl: "ws://127.0.0.1:9010",
  port: 9010,
  pid: 2,
  sandboxed: false,
  fullMode: true,
};

let latestGeneration = 0;
const ACCEPTED_PROMPT_DISPATCHED_AT_MS = Date.parse("2026-07-14T12:00:00Z");

function persistedTuiSession(overrides: Partial<HermesSessionInfo> = {}): HermesSessionInfo {
  return {
    id: "stored-1",
    source: "tui",
    model: "openai/gpt-5",
    title: "Prepare launch notes",
    started_at: 1_752_494_340,
    ended_at: null,
    end_reason: null,
    last_active: 1_752_494_400,
    is_active: false,
    message_count: 2,
    tool_call_count: 0,
    ...overrides,
  };
}

function startRun(overrides: Partial<Parameters<typeof startAgentRunMonitoring>[0]> = {}) {
  latestGeneration = startAgentRunMonitoring({
    storedSessionId: "stored-1",
    runtimeSessionId: "runtime-1",
    title: "Prepare launch notes",
    fullMode: false,
    settlementHeld: false,
    acceptedPrompt: {
      dispatchedAtMs: ACCEPTED_PROMPT_DISPATCHED_AT_MS,
      findPersistedUserIndex: (messages) =>
        messages.findIndex((message) => message.role === "user" && message.id === "user-1"),
    },
    ...overrides,
  });
  return latestGeneration;
}

function preserveTerminalEvidence(input: {
  status: "completed" | "failed" | "cancelled";
  summary: string;
  notBeforeMs: number;
}) {
  expect(preserveAgentRunTerminalEvidence("stored-1", input, latestGeneration)).toBe(true);
}

async function flush() {
  await vi.advanceTimersByTimeAsync(0);
}

async function observeTwoIdleSnapshots() {
  await flush();
  await vi.advanceTimersByTimeAsync(1_000);
}

function activeRuntime(runtimeSessionId = "runtime-1") {
  let active = true;
  monitorMocks.request.mockImplementation(async () => ({
    sessions: active ? [{ id: runtimeSessionId, status: "working" }] : [],
  }));
  return () => {
    active = false;
  };
}

describe("agent run monitor", () => {
  beforeEach(() => {
    resetAgentRunMonitoringForTests();
    latestGeneration = 0;
    vi.useFakeTimers();
    monitorMocks.instances.length = 0;
    monitorMocks.bridgeStatus.mockReset().mockResolvedValue({
      running: true,
      connections: [SANDBOXED_CONNECTION, UNRESTRICTED_CONNECTION],
    });
    monitorMocks.request.mockReset().mockResolvedValue({ sessions: [] });
    monitorMocks.sessions.mockReset().mockResolvedValue({
      sessions: [persistedTuiSession()],
    });
    monitorMocks.sessionMessages.mockReset().mockResolvedValue({
      messages: [
        {
          id: "user-1",
          role: "user",
          content: "Do the work",
          timestamp: "2026-07-14T12:00:00Z",
        },
        {
          id: "assistant-1",
          role: "assistant",
          content: "Finished reply",
          timestamp: "2026-07-14T12:00:05Z",
        },
      ],
    });
    monitorMocks.dispatchSettled.mockReset();
    monitorMocks.dispatchStarted.mockReset();
    monitorMocks.dispatchStatus.mockReset();
  });

  afterEach(() => {
    resetAgentRunMonitoringForTests();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("survives the submitting caller going away and settles from persisted runtime state", async () => {
    const finishRuntime = activeRuntime();
    const submitAndLeave = () => startRun();
    submitAndLeave();
    await flush();

    finishRuntime();
    await observeTwoIdleSnapshots();

    expect(monitorMocks.dispatchSettled).toHaveBeenCalledOnce();
    expect(monitorMocks.dispatchSettled).toHaveBeenCalledWith({
      sessionId: "stored-1",
      title: "Prepare launch notes",
      runMonitorGeneration: 1,
      summary: "June finished.",
    });
  });

  it("settles a fast completion that disappears before an active row is observed", async () => {
    startRun();
    await flush();

    expect(monitorMocks.sessionMessages).toHaveBeenCalledOnce();
    expect(monitorMocks.sessions).not.toHaveBeenCalled();
    expect(monitorMocks.dispatchSettled).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(500);

    expect(monitorMocks.dispatchSettled).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(monitorMocks.dispatchSettled).toHaveBeenCalledOnce();
  });

  it("settles a fast accepted reply retained as an idle active-list row", async () => {
    monitorMocks.request.mockResolvedValue({
      sessions: [{ id: "runtime-1", status: "idle" }],
    });
    monitorMocks.sessionMessages.mockResolvedValue({
      messages: [
        { id: "user-1", role: "user", content: "Do the work" },
        { id: "assistant-1", role: "assistant", content: "Finished reply" },
      ],
    });

    startRun();
    await observeTwoIdleSnapshots();

    expect(monitorMocks.dispatchSettled).toHaveBeenCalledWith({
      sessionId: "stored-1",
      title: "Prepare launch notes",
      runMonitorGeneration: 1,
      summary: "June finished.",
    });
  });

  it("probes a retained idle row for a replacement generation", async () => {
    monitorMocks.request.mockResolvedValue({
      sessions: [{ id: "runtime-1", status: "idle" }],
    });
    monitorMocks.sessionMessages.mockResolvedValue({
      messages: [
        { id: "user-1", role: "user", content: "Do the work" },
        { id: "assistant-1", role: "assistant", content: "Replacement reply" },
      ],
    });
    startRun({ runtimeSessionId: "runtime-old" });
    const replacementGeneration = startRun();

    await observeTwoIdleSnapshots();

    expect(monitorMocks.dispatchSettled).toHaveBeenCalledWith({
      sessionId: "stored-1",
      title: "Prepare launch notes",
      runMonitorGeneration: replacementGeneration,
      summary: "June finished.",
    });
  });

  it("does not use a reply from before the accepted prompt persists", async () => {
    monitorMocks.sessionMessages.mockResolvedValue({
      messages: [
        { id: "prior-user", role: "user", content: "Do the work" },
        { id: "prior-assistant", role: "assistant", content: "Prior result" },
      ],
    });

    startRun();
    await vi.advanceTimersByTimeAsync(1_500);

    expect(monitorMocks.dispatchStatus).not.toHaveBeenCalled();
    expect(monitorMocks.dispatchSettled).not.toHaveBeenCalled();
  });

  it("does not use a reply from before the accepted prompt after observing current activity", async () => {
    const finishRuntime = activeRuntime();
    monitorMocks.sessionMessages.mockResolvedValue({
      messages: [
        { id: "prior-user", role: "user", content: "Do the work" },
        { id: "prior-assistant", role: "assistant", content: "Prior result" },
      ],
    });

    startRun();
    await flush();
    finishRuntime();
    await vi.advanceTimersByTimeAsync(1_500);

    expect(monitorMocks.dispatchStatus).not.toHaveBeenCalled();
    expect(monitorMocks.dispatchSettled).not.toHaveBeenCalled();
  });

  it("does not settle before the accepted prompt has an assistant response", async () => {
    monitorMocks.sessionMessages.mockResolvedValue({
      messages: [
        {
          id: "user-1",
          role: "user",
          content: "Do the work",
          timestamp: "2026-07-14T12:00:00Z",
        },
      ],
    });

    startRun();
    await vi.advanceTimersByTimeAsync(1_500);

    expect(monitorMocks.dispatchStatus).not.toHaveBeenCalled();
    expect(monitorMocks.dispatchSettled).not.toHaveBeenCalled();
  });

  it("does not use an assistant reply from a later Agent run", async () => {
    monitorMocks.sessionMessages.mockResolvedValue({
      messages: [
        { id: "user-1", role: "user", content: "Do the work" },
        { id: "later-user", role: "user", content: "Different run" },
        { id: "later-assistant", role: "assistant", content: "Later result" },
      ],
    });

    startRun();
    await vi.advanceTimersByTimeAsync(1_500);

    expect(monitorMocks.dispatchSettled).not.toHaveBeenCalled();
  });

  it("uses the persisted reply when the session status only reaches idle", async () => {
    const finishRuntime = activeRuntime();
    monitorMocks.sessionMessages.mockResolvedValue({
      messages: [
        { id: "user-1", role: "user", content: "Do the work" },
        { id: "assistant-1", role: "assistant", content: "Done" },
      ],
    });
    startRun();
    await flush();

    finishRuntime();
    await observeTwoIdleSnapshots();

    expect(monitorMocks.dispatchSettled).toHaveBeenCalledOnce();
  });

  it.each([
    "failed",
    "cancelled",
  ] as const)("keeps ambiguous %s evidence unresolved despite persisted assistant prose", async (status) => {
    const submittedAtMs = Date.parse("2026-07-14T12:00:00Z");
    const finishRuntime = activeRuntime();
    monitorMocks.sessionMessages.mockResolvedValue({
      messages: [
        { id: "user-1", role: "user", content: "Do the work" },
        { id: "assistant-1", role: "assistant", content: "Partial prose" },
      ],
    });
    startRun();
    preserveTerminalEvidence({
      status,
      summary: `The current run was ${status}.`,
      notBeforeMs: submittedAtMs,
    });
    await flush();

    finishRuntime();
    await vi.advanceTimersByTimeAsync(2_000);

    expect(monitorMocks.dispatchSettled).not.toHaveBeenCalled();
    expect(monitorMocks.dispatchStatus).not.toHaveBeenCalled();
  });

  it("does not let ambiguous completion overwrite latched failure evidence", async () => {
    const submittedAtMs = Date.parse("2026-07-14T12:00:00Z");
    const finishRuntime = activeRuntime();
    monitorMocks.sessionMessages.mockResolvedValue({
      messages: [
        { id: "user-1", role: "user", content: "Do the work" },
        { id: "assistant-1", role: "assistant", content: "Partial prose before failure" },
      ],
    });
    startRun();
    preserveTerminalEvidence({
      status: "failed",
      summary: "The provider failed.",
      notBeforeMs: submittedAtMs,
    });
    preserveTerminalEvidence({
      status: "completed",
      summary: "A repeated completion frame was ambiguous.",
      notBeforeMs: submittedAtMs,
    });
    await flush();

    finishRuntime();
    await observeTwoIdleSnapshots();

    expect(monitorMocks.dispatchSettled).not.toHaveBeenCalled();
    expect(monitorMocks.dispatchStatus).not.toHaveBeenCalled();
  });

  it("keeps a tool-call-only reply unresolved without explicit completion evidence", async () => {
    const finishRuntime = activeRuntime();
    monitorMocks.sessions.mockRejectedValue(new Error("session lifecycle is not run outcome"));
    monitorMocks.sessionMessages.mockResolvedValue({
      messages: [
        { id: "user-1", role: "user", content: "Do the work" },
        {
          id: "assistant-tool-call",
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call-1",
              type: "function",
              function: { name: "search_notes", arguments: '{"query":"launch"}' },
            },
          ],
        },
        {
          id: "tool-1",
          role: "tool",
          content: "No matching notes",
          tool_call_id: "call-1",
        },
      ],
    });

    startRun();
    await flush();
    finishRuntime();
    await observeTwoIdleSnapshots();

    expect(monitorMocks.dispatchSettled).not.toHaveBeenCalled();
    expect(monitorMocks.sessions).not.toHaveBeenCalled();
  });

  it("does not infer success from assistant prose before the last tool result", async () => {
    const finishRuntime = activeRuntime();
    monitorMocks.sessionMessages.mockResolvedValue({
      messages: [
        { id: "user-1", role: "user", content: "Do the work" },
        {
          id: "assistant-tool-call",
          role: "assistant",
          content: "I will search the notes now.",
          tool_calls: [
            {
              id: "call-1",
              type: "function",
              function: { name: "search_notes", arguments: '{"query":"launch"}' },
            },
          ],
        },
        {
          id: "tool-1",
          role: "tool",
          content: "No matching notes",
          tool_call_id: "call-1",
        },
      ],
    });

    startRun();
    await flush();
    finishRuntime();
    await observeTwoIdleSnapshots();

    expect(monitorMocks.dispatchSettled).not.toHaveBeenCalled();
  });

  it("settles from a content-bearing assistant reply after the last tool result", async () => {
    const finishRuntime = activeRuntime();
    monitorMocks.sessionMessages.mockResolvedValue({
      messages: [
        { id: "user-1", role: "user", content: "Do the work" },
        {
          id: "assistant-tool-call",
          role: "assistant",
          content: "I will search the notes now.",
          tool_calls: [
            {
              id: "call-1",
              type: "function",
              function: { name: "search_notes", arguments: '{"query":"launch"}' },
            },
          ],
        },
        {
          id: "tool-1",
          role: "tool",
          content: "No matching notes",
          tool_call_id: "call-1",
        },
        {
          id: "assistant-final",
          role: "assistant",
          content: "I could not find any matching launch notes.",
        },
      ],
    });

    startRun();
    await flush();
    finishRuntime();
    await observeTwoIdleSnapshots();

    expect(monitorMocks.dispatchSettled).toHaveBeenCalledOnce();
  });

  it("does not infer success from a trailing assistant that starts another tool call", async () => {
    const finishRuntime = activeRuntime();
    monitorMocks.sessionMessages.mockResolvedValue({
      messages: [
        { id: "user-1", role: "user", content: "Do the work" },
        {
          id: "assistant-first-tool-call",
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call-1",
              type: "function",
              function: { name: "search_notes", arguments: '{"query":"launch"}' },
            },
          ],
        },
        {
          id: "tool-1",
          role: "tool",
          content: "One matching note",
          tool_call_id: "call-1",
        },
        {
          id: "assistant-second-tool-call",
          role: "assistant",
          content: "I found one note and will inspect it now.",
          tool_calls: [
            {
              id: "call-2",
              type: "function",
              function: { name: "read_note", arguments: '{"id":"note-1"}' },
            },
          ],
        },
      ],
    });

    startRun();
    await flush();
    finishRuntime();
    await observeTwoIdleSnapshots();

    expect(monitorMocks.dispatchSettled).not.toHaveBeenCalled();
  });

  it("settles a tool-call-only reply when explicit completion was observed", async () => {
    const finishRuntime = activeRuntime();
    monitorMocks.sessionMessages.mockResolvedValue({
      messages: [
        { id: "user-1", role: "user", content: "Do the work" },
        {
          id: "assistant-tool-call",
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call-1",
              type: "function",
              function: { name: "search_notes", arguments: '{"query":"launch"}' },
            },
          ],
        },
        {
          id: "tool-1",
          role: "tool",
          content: "No matching notes",
          tool_call_id: "call-1",
        },
      ],
    });

    startRun();
    await flush();
    expect(markAgentRunSucceeded("stored-1", latestGeneration)).toBe(true);
    finishRuntime();
    await observeTwoIdleSnapshots();

    expect(monitorMocks.dispatchSettled).toHaveBeenCalledOnce();
  });

  it.each([
    "tui_close",
    "ws_disconnect",
    "ws_orphan_reap",
    "tui_shutdown",
    "idle_timeout",
  ])("does not query persisted session lifecycle for the %s teardown reason", async (endReason) => {
    monitorMocks.sessions.mockResolvedValue({
      sessions: [
        persistedTuiSession({
          ended_at: 1_752_494_460,
          end_reason: endReason,
          last_active: 1_752_494_460,
        }),
      ],
    });
    monitorMocks.sessionMessages.mockResolvedValue({
      messages: [{ id: "user-1", role: "user", content: "Do the work" }],
    });

    startRun();
    await vi.advanceTimersByTimeAsync(1_500);

    expect(monitorMocks.sessions).not.toHaveBeenCalled();
    expect(monitorMocks.dispatchStatus).not.toHaveBeenCalled();
    expect(monitorMocks.dispatchSettled).not.toHaveBeenCalled();
  });

  it("allows persisted assistant completion when ambiguous evidence was positive", async () => {
    const finishRuntime = activeRuntime();
    startRun();
    preserveTerminalEvidence({
      status: "completed",
      summary: "A repeated completion frame was ambiguous.",
      notBeforeMs: Date.parse("2026-07-14T12:00:00Z"),
    });
    await flush();

    finishRuntime();
    await observeTwoIdleSnapshots();

    expect(monitorMocks.dispatchSettled).toHaveBeenCalledOnce();
    expect(monitorMocks.dispatchStatus).not.toHaveBeenCalled();
  });

  it("revokes assistant-fallback success when ambiguity arrives before settlement", async () => {
    const finishRuntime = activeRuntime();
    monitorMocks.sessionMessages.mockResolvedValue({
      messages: [
        { id: "user-1", role: "user", content: "Do the work" },
        { id: "assistant-1", role: "assistant", content: "Partial prose" },
      ],
    });
    startRun();
    await flush();

    finishRuntime();
    await vi.advanceTimersByTimeAsync(500);
    expect(monitorMocks.dispatchSettled).not.toHaveBeenCalled();

    preserveTerminalEvidence({
      status: "failed",
      summary: "The run failed after partial prose.",
      notBeforeMs: Date.parse("2026-07-14T12:00:00Z"),
    });
    await vi.advanceTimersByTimeAsync(1_000);

    expect(monitorMocks.dispatchSettled).not.toHaveBeenCalled();
    expect(monitorMocks.dispatchStatus).not.toHaveBeenCalled();
  });

  it("does not dispatch a terminal result from a monitor generation replaced during persistence", async () => {
    let resolveOldMessages:
      | ((value: {
          messages: Array<{ id: string; role: "user" | "assistant"; content: string }>;
        }) => void)
      | undefined;
    monitorMocks.request.mockResolvedValue({ sessions: [] });
    monitorMocks.sessionMessages.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOldMessages = resolve;
        }),
    );
    startRun();
    preserveTerminalEvidence({
      status: "failed",
      summary: "Old generation failed.",
      notBeforeMs: Date.parse("2026-07-14T12:00:00Z"),
    });
    await flush();
    expect(resolveOldMessages).toBeTypeOf("function");

    startRun({ runtimeSessionId: "runtime-2" });
    await Promise.resolve();
    resolveOldMessages?.({
      messages: [
        { id: "user-1", role: "user", content: "Do the work" },
        { id: "assistant-1", role: "assistant", content: "Old generation result" },
      ],
    });
    await flush();

    expect(monitorMocks.dispatchStatus).not.toHaveBeenCalled();
    expect(monitorMocks.dispatchSettled).not.toHaveBeenCalled();
  });

  it("holds a successful run until automatic continuation work is released", async () => {
    const finishRuntime = activeRuntime();
    startRun({ settlementHeld: true });
    await flush();
    finishRuntime();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(monitorMocks.request).toHaveBeenCalled();
    expect(monitorMocks.dispatchSettled).not.toHaveBeenCalled();

    expect(releaseAgentRunSettlement("stored-1", latestGeneration)).toBe(true);
    await observeTwoIdleSnapshots();
    expect(monitorMocks.dispatchSettled).toHaveBeenCalledOnce();
  });

  it("can be armed explicitly before release", async () => {
    startRun({ settlementHeld: true });
    await flush();

    expect(markAgentRunSucceeded("stored-1", latestGeneration)).toBe(true);
    expect(releaseAgentRunSettlement("stored-1", latestGeneration)).toBe(true);
    await observeTwoIdleSnapshots();

    expect(monitorMocks.dispatchSettled).toHaveBeenCalledOnce();
  });

  it("does not duplicate a failed status already reported by the UI", async () => {
    startRun();
    await flush();

    expect(markAgentRunFailed("stored-1", latestGeneration, "Already shown")).toBe(true);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(monitorMocks.dispatchStatus).not.toHaveBeenCalled();
    expect(monitorMocks.dispatchSettled).not.toHaveBeenCalled();
  });

  it("ignores a late successful terminal frame after Stop", async () => {
    startRun();
    await flush();
    const requestsBeforeStop = monitorMocks.request.mock.calls.length;

    expect(cancelAgentRunMonitoring("stored-1", latestGeneration)).toBe(true);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(monitorMocks.dispatchSettled).not.toHaveBeenCalled();
    expect(monitorMocks.request).toHaveBeenCalledTimes(requestsBeforeStop);
  });

  it("ignores terminal frames from an older runtime generation", async () => {
    let rows = [{ id: "runtime-old", status: "working" }];
    monitorMocks.request.mockImplementation(async () => ({ sessions: rows }));
    monitorMocks.sessionMessages.mockResolvedValue({
      messages: [{ id: "prior-user", role: "user", content: "Prior work" }],
    });
    const oldGeneration = startRun({ runtimeSessionId: "runtime-old" });
    await flush();
    const newGeneration = startRun({ runtimeSessionId: "runtime-new", title: "New run" });

    expect(newGeneration).toBeGreaterThan(oldGeneration);
    rows = [];
    await vi.advanceTimersByTimeAsync(1_000);
    expect(monitorMocks.dispatchSettled).not.toHaveBeenCalled();

    rows = [{ id: "runtime-new", status: "working" }];
    await vi.advanceTimersByTimeAsync(500);
    monitorMocks.sessionMessages.mockResolvedValue({
      messages: [
        { id: "user-1", role: "user", content: "Do the work" },
        { id: "assistant-1", role: "assistant", content: "Current result" },
      ],
    });
    rows = [];
    await observeTwoIdleSnapshots();

    expect(monitorMocks.dispatchSettled).toHaveBeenCalledWith({
      sessionId: "stored-1",
      title: "New run",
      runMonitorGeneration: newGeneration,
      summary: "June finished.",
    });
  });

  it("rejects every monitor mutation from a replaced generation", async () => {
    const oldGeneration = startRun({ runtimeSessionId: "runtime-old" });
    const newGeneration = startRun({ runtimeSessionId: "runtime-new" });

    expect(isAgentRunMonitorGenerationCurrent("stored-1", oldGeneration)).toBe(false);
    expect(isAgentRunMonitorGenerationCurrent("stored-1", newGeneration)).toBe(true);
    expect(markAgentRunSucceeded("stored-1", oldGeneration)).toBe(false);
    expect(
      preserveAgentRunTerminalEvidence(
        "stored-1",
        {
          status: "failed",
          summary: "Old generation failed.",
          notBeforeMs: Date.parse("2026-07-14T12:00:00Z"),
        },
        oldGeneration,
      ),
    ).toBe(false);
    expect(releaseAgentRunSettlement("stored-1", oldGeneration)).toBe(false);
    expect(markAgentRunFailed("stored-1", oldGeneration, "Old generation failed.")).toBe(false);
    expect(cancelAgentRunMonitoring("stored-1", oldGeneration)).toBe(false);
    expect(isAgentRunMonitorGenerationCurrent("stored-1", newGeneration)).toBe(true);
  });

  it("publishes every new generation after the caller can record it", async () => {
    const firstGeneration = startRun();
    expect(monitorMocks.dispatchStarted).not.toHaveBeenCalled();
    await flush();
    expect(monitorMocks.dispatchStarted).toHaveBeenLastCalledWith({
      storedSessionId: "stored-1",
      runMonitorGeneration: firstGeneration,
      runtimeSessionId: "runtime-1",
      fullMode: false,
    });

    expect(markAgentRunFailed("stored-1", firstGeneration)).toBe(true);
    const replacementGeneration = startRun();
    expect(monitorMocks.dispatchStarted).toHaveBeenCalledTimes(1);
    await flush();
    expect(monitorMocks.dispatchStarted).toHaveBeenLastCalledWith({
      storedSessionId: "stored-1",
      runMonitorGeneration: replacementGeneration,
      runtimeSessionId: "runtime-1",
      fullMode: false,
    });
  });

  it("keeps a reconnecting exact-mode observer alive until Stop is sent", async () => {
    let resolveBridgeStatus:
      | ((value: { running: boolean; connections: Array<typeof SANDBOXED_CONNECTION> }) => void)
      | undefined;
    monitorMocks.bridgeStatus.mockReturnValue(
      new Promise((resolve) => {
        resolveBridgeStatus = resolve;
      }),
    );
    const generation = startRun({
      runtimeSessionId: "runtime-full-stop",
      fullMode: true,
    });
    const onStopped = vi.fn();

    expect(stopAgentRunMonitoring("stored-1", generation, onStopped)).toBe(true);
    expect(isAgentRunMonitorGenerationCurrent("stored-1", generation)).toBe(true);
    expect(onStopped).not.toHaveBeenCalled();
    resolveBridgeStatus?.({
      running: true,
      connections: [SANDBOXED_CONNECTION, UNRESTRICTED_CONNECTION],
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(monitorMocks.request).toHaveBeenCalledWith("session.interrupt", {
      session_id: "runtime-full-stop",
    });
    expect(monitorMocks.instances).toHaveLength(1);
    expect(monitorMocks.instances[0]?.connect).toHaveBeenCalledWith(UNRESTRICTED_CONNECTION.wsUrl);
    expect(isAgentRunMonitorGenerationCurrent("stored-1", generation)).toBe(false);
    expect(onStopped).toHaveBeenCalledOnce();
  });

  it("holds replacement dispatch behind an accepted reconnecting Stop", async () => {
    let resolveInterrupt: (() => void) | undefined;
    const interrupt = new Promise<void>((resolve) => {
      resolveInterrupt = resolve;
    });
    monitorMocks.request.mockImplementation((method: string) => {
      if (method === "session.interrupt") return interrupt;
      return Promise.resolve({ sessions: [{ id: "runtime-1", status: "working" }] });
    });
    const generation = startRun();
    await flush();

    const stopHold = holdHermesSessionDispatch("stored-1");
    expect(stopAgentRunMonitoring("stored-1", generation, () => stopHold.release())).toBe(true);
    expect(agentRunMonitorSnapshot("stored-1")).toMatchObject({
      generation,
      runtimeSessionId: "runtime-1",
      phase: "stopping",
    });
    let replacementDispatched = false;
    const replacement = withHermesSessionDispatchLock("stored-1", async () => {
      replacementDispatched = true;
    });
    await flush();
    expect(monitorMocks.request).toHaveBeenCalledWith("session.interrupt", {
      session_id: "runtime-1",
    });
    expect(replacementDispatched).toBe(false);

    resolveInterrupt?.();
    await flush();
    await replacement;
    expect(replacementDispatched).toBe(true);
    expect(agentRunMonitorSnapshot("stored-1")).toMatchObject({
      generation,
      runtimeSessionId: "runtime-1",
      phase: "terminal",
    });
  });

  it("retains a finished tombstone independently of the live-run count", () => {
    for (let index = 0; index < 101; index += 1) {
      startRun({
        storedSessionId: `stored-live-${index}`,
        runtimeSessionId: `runtime-live-${index}`,
        settlementHeld: true,
      });
    }
    const terminalGeneration = startRun({
      storedSessionId: "stored-terminal",
      runtimeSessionId: "runtime-terminal",
      settlementHeld: true,
    });

    expect(markAgentRunFailed("stored-terminal", terminalGeneration)).toBe(true);
    expect(agentRunMonitorSnapshot("stored-terminal")).toMatchObject({
      generation: terminalGeneration,
      phase: "terminal",
    });
    expect(agentRunMonitorSnapshot("stored-live-0")).toMatchObject({ phase: "active" });
  });

  it("dispatches a generation-tagged failure when the monitor budget expires", async () => {
    monitorMocks.request.mockImplementation(() => new Promise(() => {}));
    startRun();
    await flush();

    await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1_000 + 1);

    expect(monitorMocks.dispatchStatus).toHaveBeenCalledOnce();
    expect(monitorMocks.dispatchStatus).toHaveBeenCalledWith({
      sessionId: "stored-1",
      title: "Prepare launch notes",
      status: "failed",
      runMonitorGeneration: 1,
      summary: "June stopped responding.",
    });
    expect(isAgentRunMonitorGenerationCurrent("stored-1", latestGeneration)).toBe(false);
  });

  it("retries an active-session error without counting it as idle", async () => {
    monitorMocks.request
      .mockRejectedValueOnce(new Error("gateway unavailable"))
      .mockResolvedValue({ sessions: [] });
    startRun();
    markAgentRunSucceeded("stored-1", latestGeneration);
    await flush();
    expect(monitorMocks.dispatchSettled).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(500);
    expect(monitorMocks.dispatchSettled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(500);

    expect(monitorMocks.request).toHaveBeenCalledTimes(3);
    expect(monitorMocks.dispatchSettled).toHaveBeenCalledOnce();
  });

  it("uses one dedicated observer gateway per runtime mode", async () => {
    startRun();
    startRun({ storedSessionId: "stored-2", runtimeSessionId: "runtime-2" });
    startRun({
      storedSessionId: "stored-full",
      runtimeSessionId: "runtime-full",
      fullMode: true,
    });
    await flush();

    expect(monitorMocks.instances).toHaveLength(2);
    expect(monitorMocks.instances[0]?.connect).toHaveBeenCalledWith(SANDBOXED_CONNECTION.wsUrl);
    expect(monitorMocks.instances[1]?.connect).toHaveBeenCalledWith(UNRESTRICTED_CONNECTION.wsUrl);
  });

  it("attributes an untagged frame only when one run exists in that mode", () => {
    startRun();
    expect(canAttributeUntaggedAgentRun("stored-1", false)).toBe(true);

    startRun({ storedSessionId: "stored-2", runtimeSessionId: "runtime-2" });
    expect(canAttributeUntaggedAgentRun("stored-1", false)).toBe(false);
    expect(canAttributeUntaggedAgentRun("stored-2", false)).toBe(false);
  });
});
