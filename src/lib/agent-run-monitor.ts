import { dispatchAgentRunSettled, dispatchAgentSessionStatus } from "./agent-events";
import { hermesConnectionForMode } from "./hermes-connection";
import { HermesGatewayClient } from "./hermes-gateway";
import { watchHermesRunSettlement, type HermesRunSettlementHandle } from "./hermes-run-settlement";
import {
  hermesBridgeSessionMessages,
  hermesBridgeSessions,
  hermesBridgeStatus,
  type HermesSessionMessage,
  type HermesSessionInfo,
} from "./tauri";

export type StartAgentRunMonitoringInput = {
  storedSessionId: string;
  runtimeSessionId?: string;
  title: string;
  fullMode: boolean;
  settlementHeld: boolean;
};

type AgentRunMonitor = StartAgentRunMonitoringInput & {
  canProbeBeforeObservedActive: boolean;
  generation: number;
  observedActive: boolean;
  succeeded: boolean;
  settlement?: HermesRunSettlementHandle;
  settlementCleanupTimer?: ReturnType<typeof setTimeout>;
};

type ModeObserver = {
  connected: boolean;
  connecting?: Promise<void>;
  gateway: HermesGatewayClient;
  reconnectTimer?: ReturnType<typeof setTimeout>;
};

type TerminalOutcome =
  | { kind: "succeeded" }
  | { kind: "failed"; summary: string }
  | { kind: "cancelled" };

const OBSERVER_RECONNECT_MS = 1_000;
const MONITOR_POLL_INTERVAL_MS = 500;
const MONITOR_TIMEOUT_MS = 6 * 60 * 60 * 1_000;
const runs = new Map<string, AgentRunMonitor>();
const observers = new Map<boolean, ModeObserver>();
let nextGeneration = 0;

/**
 * Starts observing one accepted Agent run independently of the React surface
 * that submitted it. A later call for the same stored session replaces the
 * prior generation, so delayed frames tagged with its old runtime id cannot
 * settle the new run.
 */
export function startAgentRunMonitoring(input: StartAgentRunMonitoringInput) {
  const previous = runs.get(input.storedSessionId);
  cancelSettlement(previous);

  const run: AgentRunMonitor = {
    ...input,
    canProbeBeforeObservedActive: previous === undefined,
    generation: ++nextGeneration,
    observedActive: false,
    succeeded: false,
  };
  runs.set(input.storedSessionId, run);

  if (previous && previous.fullMode !== run.fullMode) {
    closeObserverWhenUnused(previous.fullMode);
  }
  void ensureObserver(run.fullMode).catch(() => scheduleObserverReconnect(run.fullMode));
  startSettlementIfReady(run);
  return run.generation;
}

/** Marks a successful terminal edge learned by the submitting UI surface. */
export function markAgentRunSucceeded(storedSessionId: string) {
  const run = runs.get(storedSessionId);
  if (!run) return false;
  armSuccessfulRun(run);
  return true;
}

/**
 * Retires a failed run learned by the UI. The UI already owns its failed
 * status dispatch, so this function deliberately emits no second event.
 */
export function markAgentRunFailed(storedSessionId: string, summary?: string) {
  void summary;
  const run = runs.get(storedSessionId);
  if (!run) return false;
  finishRun(run);
  return true;
}

/** Releases a completed run once all automatic continuation work is drained. */
export function releaseAgentRunSettlement(storedSessionId: string) {
  const run = runs.get(storedSessionId);
  if (!run) return false;
  run.settlementHeld = false;
  startSettlementIfReady(run);
  return true;
}

/** Cancels readiness for an explicit Stop, deletion, or superseding workflow. */
export function cancelAgentRunMonitoring(storedSessionId: string) {
  const run = runs.get(storedSessionId);
  if (!run) return false;
  finishRun(run);
  return true;
}

/** Untagged runtime frames are safe to attribute only when this is the sole
 * monitored run in that mode. */
export function canAttributeUntaggedAgentRun(storedSessionId: string, fullMode: boolean) {
  const modeRuns = [...runs.values()].filter((run) => run.fullMode === fullMode);
  return modeRuns.length === 1 && modeRuns[0]?.storedSessionId === storedSessionId;
}

function armSuccessfulRun(run: AgentRunMonitor) {
  if (!isCurrent(run)) return;
  run.succeeded = true;
  startSettlementIfReady(run);
}

function startSettlementIfReady(run: AgentRunMonitor) {
  if (!isCurrent(run) || run.settlement) return;
  const generation = run.generation;
  run.settlement = watchHermesRunSettlement({
    storedSessionId: run.storedSessionId,
    runtimeSessionId: run.runtimeSessionId,
    pollIntervalMs: MONITOR_POLL_INTERVAL_MS,
    timeoutMs: MONITOR_TIMEOUT_MS,
    listActiveSessions: async () => {
      const observer = await ensureObserver(run.fullMode);
      const response = await observer.gateway.request<{
        sessions?: Array<{ id?: string; session_key?: string; status?: string }>;
      }>("session.active_list", {});
      const rows = Array.isArray(response?.sessions) ? response.sessions : [];
      const matchingRows = rows.filter(
        (row) =>
          row.id === run.runtimeSessionId ||
          row.id === run.storedSessionId ||
          row.session_key === run.runtimeSessionId ||
          row.session_key === run.storedSessionId,
      );
      if (matchingRows.some((row) => row.status !== "idle")) run.observedActive = true;

      // Hermes routes session events only to the transport that created or
      // resumed that session. The submitting UI can report success as a fast
      // path, but persisted session state is the correctness path after that
      // UI disappears.
      if (
        !run.succeeded &&
        (run.observedActive || (run.canProbeBeforeObservedActive && matchingRows.length === 0)) &&
        matchingRows.every((row) => row.status === "idle")
      ) {
        const outcome = await persistedTerminalOutcome(run.storedSessionId);
        if (outcome?.kind === "succeeded") {
          run.succeeded = true;
        } else if (outcome) {
          finishRun(run);
          if (outcome.kind === "failed") {
            dispatchAgentSessionStatus({
              sessionId: run.storedSessionId,
              title: run.title,
              status: "failed",
              summary: outcome.summary,
            });
          }
        }
      }

      if (!isCurrent(run) || !run.succeeded || run.settlementHeld) {
        return [{ id: run.runtimeSessionId ?? run.storedSessionId, status: "working" }];
      }
      return rows;
    },
    onSettled: () => {
      if (!isCurrent(run) || run.generation !== generation) return;
      dispatchAgentRunSettled({
        sessionId: run.storedSessionId,
        title: run.title,
        summary: "June finished.",
        // Exclude the run that is about to be retired below. The HUD uses the
        // global count to sweep anonymous pending rows only when no other
        // monitored run can still own one of them.
        activeCount: Math.max(0, runs.size - 1),
      });
      finishRun(run);
    },
  });
  // The settlement helper intentionally times out silently. Mirror its budget
  // so a runtime that never becomes reachable cannot retain an observer socket.
  run.settlementCleanupTimer = setTimeout(() => {
    if (isCurrent(run) && run.generation === generation) finishRun(run);
  }, MONITOR_TIMEOUT_MS + 1);
}

async function persistedTerminalOutcome(
  storedSessionId: string,
): Promise<TerminalOutcome | undefined> {
  try {
    const response = await hermesBridgeSessions({
      limit: 100,
      minMessages: 0,
      order: "recent",
    });
    const session = response.sessions?.find((candidate) => candidate.id === storedSessionId);
    if (!session) return undefined;
    const outcome = terminalOutcomeFromSession(session);
    if (outcome || sessionLooksWaiting(session)) return outcome;
    const messages = await hermesBridgeSessionMessages(storedSessionId);
    return assistantRepliedAfterLatestUser(
      messages.messages ?? messages.items ?? messages.data ?? [],
    )
      ? { kind: "succeeded" }
      : undefined;
  } catch {
    return undefined;
  }
}

function sessionLooksWaiting(session: HermesSessionInfo) {
  return /(?:waiting|approval|needs.?input|clarif)/i.test(
    `${session.status ?? ""} ${session.end_reason ?? ""}`,
  );
}

function assistantRepliedAfterLatestUser(messages: readonly HermesSessionMessage[]) {
  let latestUser = -1;
  for (let index = 0; index < messages.length; index += 1) {
    if (messages[index]?.role === "user") latestUser = index;
  }
  return (
    latestUser >= 0 &&
    messages.slice(latestUser + 1).some((message) => message.role === "assistant")
  );
}

function terminalOutcomeFromSession(session: HermesSessionInfo): TerminalOutcome | undefined {
  if (session.active === true || session.is_active === true) return undefined;
  const marker = `${session.status ?? ""} ${session.end_reason ?? ""}`.toLowerCase();
  if (/(?:cancel|stop|interrupt|abort)/.test(marker)) return { kind: "cancelled" };
  if (/(?:fail|error|timeout)/.test(marker)) {
    return { kind: "failed", summary: "June hit a problem." };
  }
  if (
    /(?:complete|success|finish|done)/.test(marker) ||
    Boolean(session.ended_at ?? session.endedAt)
  ) {
    return { kind: "succeeded" };
  }
  return undefined;
}

function createObserver(fullMode: boolean) {
  const gateway = new HermesGatewayClient();
  const observer: ModeObserver = { connected: false, gateway };
  gateway.onClose(() => {
    if (observers.get(fullMode) !== observer) return;
    observer.connected = false;
    scheduleObserverReconnect(fullMode);
  });
  observers.set(fullMode, observer);
  return observer;
}

async function ensureObserver(fullMode: boolean) {
  const observer = observers.get(fullMode) ?? createObserver(fullMode);
  if (observer.connected) return observer;
  if (!observer.connecting) {
    const connectionAttempt = (async () => {
      const status = await hermesBridgeStatus();
      const connection = hermesConnectionForMode(status, fullMode);
      if (!connection?.wsUrl) throw new Error("Hermes gateway is not available.");
      if (observers.get(fullMode) !== observer) throw new Error("Agent run observer was replaced.");
      await observer.gateway.connect(connection.wsUrl);
      if (observers.get(fullMode) !== observer) {
        observer.gateway.close();
        throw new Error("Agent run observer was replaced.");
      }
      observer.connected = true;
    })().finally(() => {
      if (observer.connecting === connectionAttempt) observer.connecting = undefined;
    });
    observer.connecting = connectionAttempt;
  }
  await observer.connecting;
  return observer;
}

function scheduleObserverReconnect(fullMode: boolean) {
  const observer = observers.get(fullMode);
  if (!observer || observer.reconnectTimer || !hasRunsForMode(fullMode)) return;
  observer.reconnectTimer = setTimeout(() => {
    observer.reconnectTimer = undefined;
    void ensureObserver(fullMode).catch(() => scheduleObserverReconnect(fullMode));
  }, OBSERVER_RECONNECT_MS);
}

function finishRun(run: AgentRunMonitor) {
  if (!isCurrent(run)) return;
  runs.delete(run.storedSessionId);
  cancelSettlement(run);
  closeObserverWhenUnused(run.fullMode);
}

function cancelSettlement(run: AgentRunMonitor | undefined) {
  if (!run) return;
  run.settlement?.cancel();
  run.settlement = undefined;
  if (run.settlementCleanupTimer !== undefined) {
    clearTimeout(run.settlementCleanupTimer);
    run.settlementCleanupTimer = undefined;
  }
}

function isCurrent(run: AgentRunMonitor) {
  return runs.get(run.storedSessionId)?.generation === run.generation;
}

function hasRunsForMode(fullMode: boolean) {
  return [...runs.values()].some((run) => run.fullMode === fullMode);
}

function closeObserverWhenUnused(fullMode: boolean) {
  if (hasRunsForMode(fullMode)) return;
  const observer = observers.get(fullMode);
  if (!observer) return;
  observers.delete(fullMode);
  if (observer.reconnectTimer !== undefined) clearTimeout(observer.reconnectTimer);
  observer.gateway.close();
}

/** Clears singleton state between tests. Production ownership lasts for App. */
export function resetAgentRunMonitoringForTests() {
  for (const run of runs.values()) cancelSettlement(run);
  runs.clear();
  for (const observer of observers.values()) {
    if (observer.reconnectTimer !== undefined) clearTimeout(observer.reconnectTimer);
    observer.gateway.close();
  }
  observers.clear();
  nextGeneration = 0;
}
