import { afterEach, describe, expect, it, vi } from "vitest";
import { AGENT_SESSION_STATUS_EVENT, type AgentSessionStatusDetail } from "../lib/agent-events";
import type { HermesGatewayClient, HermesGatewayEvent } from "../lib/hermes-gateway";
import type { JuneHermesEvent } from "../lib/hermes-control-plane";
import { createSessionEventListener } from "../components/agent/session-event-listener";
import { agentStatusFromHermesEvent } from "../components/agent/session-state-helpers";

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
