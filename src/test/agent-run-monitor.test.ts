import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  dispatchAgentSessionStatus: monitorMocks.dispatchStatus,
}));

import {
  canAttributeUntaggedAgentRun,
  cancelAgentRunMonitoring,
  markAgentRunFailed,
  markAgentRunSucceeded,
  releaseAgentRunSettlement,
  resetAgentRunMonitoringForTests,
  startAgentRunMonitoring,
} from "../lib/agent-run-monitor";

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

function startRun(overrides: Partial<Parameters<typeof startAgentRunMonitoring>[0]> = {}) {
  return startAgentRunMonitoring({
    storedSessionId: "stored-1",
    runtimeSessionId: "runtime-1",
    title: "Prepare launch notes",
    fullMode: false,
    settlementHeld: false,
    ...overrides,
  });
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
    vi.useFakeTimers();
    monitorMocks.instances.length = 0;
    monitorMocks.bridgeStatus.mockReset().mockResolvedValue({
      running: true,
      connections: [SANDBOXED_CONNECTION, UNRESTRICTED_CONNECTION],
    });
    monitorMocks.request.mockReset().mockResolvedValue({ sessions: [] });
    monitorMocks.sessions.mockReset().mockResolvedValue({
      sessions: [
        {
          id: "stored-1",
          status: "completed",
          ended_at: "2026-07-14T12:00:00Z",
        },
      ],
    });
    monitorMocks.sessionMessages.mockReset().mockResolvedValue({ messages: [] });
    monitorMocks.dispatchSettled.mockReset();
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
      summary: "June finished.",
    });
  });

  it("uses the persisted reply when the session status only reaches idle", async () => {
    const finishRuntime = activeRuntime();
    monitorMocks.sessions.mockResolvedValue({
      sessions: [{ id: "stored-1", status: "idle" }],
    });
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

  it("does not treat a waiting session's assistant question as completion", async () => {
    const finishRuntime = activeRuntime();
    monitorMocks.sessions.mockResolvedValue({
      sessions: [{ id: "stored-1", status: "waiting_for_input" }],
    });
    monitorMocks.sessionMessages.mockResolvedValue({
      messages: [
        { id: "user-1", role: "user", content: "Do the work" },
        { id: "assistant-1", role: "assistant", content: "May I continue?" },
      ],
    });
    startRun();
    await flush();

    finishRuntime();
    await vi.advanceTimersByTimeAsync(2_000);

    expect(monitorMocks.dispatchSettled).not.toHaveBeenCalled();
    expect(monitorMocks.sessionMessages).not.toHaveBeenCalled();
  });

  it("holds a successful run until automatic continuation work is released", async () => {
    const finishRuntime = activeRuntime();
    startRun({ settlementHeld: true });
    await flush();
    finishRuntime();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(monitorMocks.request).toHaveBeenCalled();
    expect(monitorMocks.dispatchSettled).not.toHaveBeenCalled();

    expect(releaseAgentRunSettlement("stored-1")).toBe(true);
    await observeTwoIdleSnapshots();
    expect(monitorMocks.dispatchSettled).toHaveBeenCalledOnce();
  });

  it("can be armed explicitly before release", async () => {
    startRun({ settlementHeld: true });
    await flush();

    expect(markAgentRunSucceeded("stored-1")).toBe(true);
    expect(releaseAgentRunSettlement("stored-1")).toBe(true);
    await observeTwoIdleSnapshots();

    expect(monitorMocks.dispatchSettled).toHaveBeenCalledOnce();
  });

  it("dispatches one failed status when only persisted runtime state reports failure", async () => {
    const finishRuntime = activeRuntime();
    monitorMocks.sessions.mockResolvedValue({
      sessions: [{ id: "stored-1", status: "failed", ended_at: "2026-07-14T12:00:00Z" }],
    });
    startRun();
    await flush();
    finishRuntime();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(monitorMocks.dispatchStatus).toHaveBeenCalledOnce();
    expect(monitorMocks.dispatchStatus).toHaveBeenCalledWith({
      sessionId: "stored-1",
      title: "Prepare launch notes",
      status: "failed",
      summary: "June hit a problem.",
    });
    expect(monitorMocks.dispatchSettled).not.toHaveBeenCalled();
  });

  it("does not duplicate a failed status already reported by the UI", async () => {
    startRun();
    await flush();

    expect(markAgentRunFailed("stored-1", "Already shown")).toBe(true);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(monitorMocks.dispatchStatus).not.toHaveBeenCalled();
    expect(monitorMocks.dispatchSettled).not.toHaveBeenCalled();
  });

  it("retires a persisted cancellation without settling", async () => {
    const finishRuntime = activeRuntime();
    monitorMocks.sessions.mockResolvedValue({
      sessions: [{ id: "stored-1", status: "cancelled", ended_at: "2026-07-14T12:00:00Z" }],
    });
    startRun();
    await flush();
    finishRuntime();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(monitorMocks.dispatchStatus).not.toHaveBeenCalled();
    expect(monitorMocks.dispatchSettled).not.toHaveBeenCalled();
    expect(monitorMocks.request).toHaveBeenCalled();
  });

  it("ignores a late successful terminal frame after Stop", async () => {
    startRun();
    await flush();
    const requestsBeforeStop = monitorMocks.request.mock.calls.length;

    expect(cancelAgentRunMonitoring("stored-1")).toBe(true);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(monitorMocks.dispatchSettled).not.toHaveBeenCalled();
    expect(monitorMocks.request).toHaveBeenCalledTimes(requestsBeforeStop);
  });

  it("ignores terminal frames from an older runtime generation", async () => {
    let rows = [{ id: "runtime-old", status: "working" }];
    monitorMocks.request.mockImplementation(async () => ({ sessions: rows }));
    const oldGeneration = startRun({ runtimeSessionId: "runtime-old" });
    await flush();
    const newGeneration = startRun({ runtimeSessionId: "runtime-new", title: "New run" });

    expect(newGeneration).toBeGreaterThan(oldGeneration);
    rows = [];
    await vi.advanceTimersByTimeAsync(1_000);
    expect(monitorMocks.dispatchSettled).not.toHaveBeenCalled();

    rows = [{ id: "runtime-new", status: "working" }];
    await vi.advanceTimersByTimeAsync(500);
    rows = [];
    await observeTwoIdleSnapshots();

    expect(monitorMocks.dispatchSettled).toHaveBeenCalledWith({
      sessionId: "stored-1",
      title: "New run",
      summary: "June finished.",
    });
  });

  it("retries an active-session error without counting it as idle", async () => {
    monitorMocks.request
      .mockRejectedValueOnce(new Error("gateway unavailable"))
      .mockResolvedValue({ sessions: [] });
    startRun();
    markAgentRunSucceeded("stored-1");
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
