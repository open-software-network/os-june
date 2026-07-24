import { afterEach, describe, expect, it, vi } from "vitest";
import { AGENT_SESSION_STATUS_EVENT, type AgentSessionStatusDetail } from "../lib/agent-events";
import type { HermesGatewayClient, HermesGatewayEvent } from "../lib/hermes-gateway";
import type { JuneHermesEvent } from "../lib/hermes-control-plane";
import { createSessionEventListener } from "../components/agent/session-event-listener";
import { agentStatusFromHermesEvent } from "../components/agent/session-state-helpers";
import {
  type TurnDiagnosticsContext,
  clearTurnDiagnostics,
  getTurnDiagnostics,
} from "../lib/turn-diagnostics";

afterEach(() => {
  vi.useRealTimers();
});

describe("createSessionEventListener activity publications", () => {
  it("bounds stream status subscribers and still releases the run lease on the terminal frame", () => {
    vi.useFakeTimers();
    let eventHandler: ((event: HermesGatewayEvent) => void) | undefined;
    const gateway = {
      onEvent(handler: (event: HermesGatewayEvent) => void) {
        eventHandler = handler;
        return () => {
          eventHandler = undefined;
        };
      },
    } as unknown as HermesGatewayClient;
    const setLiveEvents = vi.fn();
    const releaseComputerUseRun = vi.fn().mockResolvedValue(undefined);
    const statuses: AgentSessionStatusDetail[] = [];
    const onStatus = (event: Event) => {
      statuses.push((event as CustomEvent<AgentSessionStatusDetail>).detail);
    };
    window.addEventListener(AGENT_SESSION_STATUS_EVENT, onStatus);

    const sessionGatewayUnlistenRef = { current: new Map<string, () => void>() };
    const liveEventsRef = { current: {} as Record<string, JuneHermesEvent[]> };
    const { attachHermesSessionEventListener } = createSessionEventListener({
      cancelAgentRunSettlement: vi.fn(),
      clearSessionActivity: vi.fn(() => ({ activeCount: 0, needsUserCount: 0 })),
      clearSubmittedSteers: vi.fn(),
      continueAfterCompletedAgentRun: vi.fn(),
      liveEventsRef,
      onArtifactFilesystemChange: vi.fn(),
      pendingSteerBySessionIdRef: { current: {} },
      promotePendingIssueReportToReview: vi.fn(() => true),
      recordHermesActivityAndDeriveStatus: (event) => agentStatusFromHermesEvent(event),
      refreshHermesSession: vi.fn().mockResolvedValue(undefined),
      releaseAllComputerUseRuns: vi.fn().mockResolvedValue(undefined),
      releaseComputerUseRun,
      sessionGatewayUnlistenRef,
      sessionThinkingAppliedRef: { current: {} },
      sessionThinkingEfforts: () => ({}),
      sessionThinkingEffortsRef: { current: {} },
      setLiveEvents,
      withStoredHermesSessionId: (event, storedSessionId) =>
        ({ ...event, sessionId: storedSessionId }) as JuneHermesEvent,
    });

    attachHermesSessionEventListener({
      gateway,
      runtimeSessionId: "runtime-session",
      sessionDisplayTitle: "Long response",
      storedSessionId: "stored-session",
      computerUseRunLeaseId: "stored-session:lease",
    });

    for (let index = 0; index < 5_000; index += 1) {
      eventHandler?.({
        type: "thinking.delta",
        session_id: "runtime-session",
        payload: { delta: `thought-${index}` },
      });
    }

    expect(statuses).toHaveLength(1);
    expect(statuses[0]).toMatchObject({
      sessionId: "stored-session",
      status: "running",
      summary: "Thinking.",
    });
    expect(setLiveEvents).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(50);

    expect(statuses).toHaveLength(2);
    expect(statuses.at(-1)).toMatchObject({
      sessionId: "stored-session",
      status: "running",
      summary: "Thinking.",
    });
    expect(setLiveEvents).toHaveBeenCalledTimes(2);

    eventHandler?.({
      type: "session.info",
      session_id: "runtime-session",
      payload: { running: false },
    });

    expect(statuses.at(-1)).toMatchObject({
      sessionId: "stored-session",
      status: "completed",
    });
    expect(releaseComputerUseRun).toHaveBeenCalledWith("stored-session", "stored-session:lease");
    expect(eventHandler).toBeUndefined();
    vi.runAllTimers();
    expect(statuses).toHaveLength(3);

    window.removeEventListener(AGENT_SESSION_STATUS_EVENT, onStatus);
  });
});

describe("createSessionEventListener turn diagnostics", () => {
  const diagnosticSessionIds = [
    "diag-session",
    "usage-diag-session",
    "no-diag-session",
    "duplicate-diag-session",
  ];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const sessionId of diagnosticSessionIds) clearTurnDiagnostics(sessionId);
  });

  function attachListener({
    request,
    storedSessionId,
    turnDiagnostics,
  }: {
    request: ReturnType<typeof vi.fn>;
    storedSessionId: string;
    turnDiagnostics?: TurnDiagnosticsContext;
  }) {
    let eventHandler: ((event: HermesGatewayEvent) => void) | undefined;
    const gateway = {
      onEvent(handler: (event: HermesGatewayEvent) => void) {
        eventHandler = handler;
        return () => {
          eventHandler = undefined;
        };
      },
      request,
    } as unknown as HermesGatewayClient;
    const { attachHermesSessionEventListener } = createSessionEventListener({
      cancelAgentRunSettlement: vi.fn(),
      clearSessionActivity: vi.fn(() => ({ activeCount: 0, needsUserCount: 0 })),
      clearSubmittedSteers: vi.fn(),
      continueAfterCompletedAgentRun: vi.fn(),
      liveEventsRef: { current: {} as Record<string, JuneHermesEvent[]> },
      onArtifactFilesystemChange: vi.fn(),
      pendingSteerBySessionIdRef: { current: {} },
      promotePendingIssueReportToReview: vi.fn(() => true),
      recordHermesActivityAndDeriveStatus: (event) => agentStatusFromHermesEvent(event),
      refreshHermesSession: vi.fn().mockResolvedValue(undefined),
      releaseAllComputerUseRuns: vi.fn().mockResolvedValue(undefined),
      releaseComputerUseRun: vi.fn().mockResolvedValue(undefined),
      sessionGatewayUnlistenRef: { current: new Map<string, () => void>() },
      sessionThinkingAppliedRef: { current: {} },
      sessionThinkingEfforts: () => ({}),
      sessionThinkingEffortsRef: { current: {} },
      setLiveEvents: vi.fn(),
      withStoredHermesSessionId: (event, sessionId) => ({ ...event, sessionId }) as JuneHermesEvent,
    });

    attachHermesSessionEventListener({
      gateway,
      runtimeSessionId: "runtime-session",
      sessionDisplayTitle: "Diagnostic response",
      storedSessionId,
      turnDiagnostics,
    });

    return {
      emit(event: HermesGatewayEvent) {
        eventHandler?.(event);
      },
      request,
    };
  }

  it("publishes timing-only diagnostics when post-turn usage rejects", async () => {
    vi.spyOn(performance, "now").mockReturnValue(1_100);
    const listener = attachListener({
      request: vi.fn().mockRejectedValue(new Error("gateway unavailable")),
      storedSessionId: "diag-session",
      turnDiagnostics: { startAt: 1_000 },
    });

    listener.emit({
      type: "message.delta",
      session_id: "runtime-session",
      payload: { delta: "hello" },
    });
    listener.emit({
      type: "session.info",
      session_id: "runtime-session",
      payload: { running: false },
    });

    await vi.waitFor(() => expect(getTurnDiagnostics("diag-session")).toBeDefined());
    const diagnostics = getTurnDiagnostics("diag-session");
    expect(diagnostics?.totalDurationMs).toBeGreaterThan(0);
    expect(diagnostics?.ttftMs).toBeGreaterThanOrEqual(0);
    expect(diagnostics?.outputTokens).toBeUndefined();
    clearTurnDiagnostics("diag-session");
  });

  it("publishes diagnostics with token deltas when post-turn usage succeeds", async () => {
    vi.spyOn(performance, "now").mockReturnValue(1_100);
    const listener = attachListener({
      request: vi.fn().mockResolvedValue({
        usage: {
          prompt_tokens: 200,
          completion_tokens: 110,
          total_tokens: 310,
          cache_read_input_tokens: 20,
          cache_creation_input_tokens: 10,
        },
      }),
      storedSessionId: "usage-diag-session",
      turnDiagnostics: {
        startAt: 1_000,
        usageBefore: {
          promptTokens: 100,
          completionTokens: 100,
          totalTokens: 200,
          cacheReadTokens: 10,
          cacheWriteTokens: 5,
        },
      },
    });

    listener.emit({
      type: "message.delta",
      session_id: "runtime-session",
      payload: { delta: "hello" },
    });
    listener.emit({
      type: "session.info",
      session_id: "runtime-session",
      payload: { running: false },
    });

    await vi.waitFor(() => expect(getTurnDiagnostics("usage-diag-session")).toBeDefined());
    expect(getTurnDiagnostics("usage-diag-session")).toMatchObject({
      outputTokens: 10,
      inputTokens: 100,
      totalTokens: 110,
      cacheReadTokens: 10,
      cacheWriteTokens: 5,
    });
    clearTurnDiagnostics("usage-diag-session");
  });

  it("does not capture diagnostics when turnDiagnostics is not provided", () => {
    const listener = attachListener({
      request: vi.fn(),
      storedSessionId: "no-diag-session",
    });

    listener.emit({
      type: "session.info",
      session_id: "runtime-session",
      payload: { running: false },
    });

    expect(listener.request).not.toHaveBeenCalled();
    expect(getTurnDiagnostics("no-diag-session")).toBeUndefined();
    clearTurnDiagnostics("no-diag-session");
  });

  it("does not publish diagnostics for duplicate terminal frames", async () => {
    vi.spyOn(performance, "now").mockReturnValue(1_100);
    const listener = attachListener({
      request: vi.fn().mockResolvedValue({ usage: { prompt_tokens: 200 } }),
      storedSessionId: "duplicate-diag-session",
      turnDiagnostics: { startAt: 1_000 },
    });
    const terminalEvent: HermesGatewayEvent = {
      type: "session.info",
      session_id: "runtime-session",
      payload: { running: false },
    };

    listener.emit(terminalEvent);
    listener.emit(terminalEvent);

    await vi.waitFor(() => expect(getTurnDiagnostics("duplicate-diag-session")).toBeDefined());
    expect(listener.request).toHaveBeenCalledTimes(1);
    clearTurnDiagnostics("duplicate-diag-session");
  });
});
