import {
  dispatchAgentRunSettled,
  dispatchAgentRunStarted,
  dispatchAgentSessionStatus,
} from "./agent-events";
import { hasFinalContentBearingAssistantReply } from "./agent-chat-runtime";
import { hermesConnectionForMode } from "./hermes-connection";
import { HermesGatewayClient } from "./hermes-gateway";
import { watchHermesRunSettlement, type HermesRunSettlementHandle } from "./hermes-run-settlement";
import {
  hermesBridgeSessionMessages,
  hermesBridgeStatus,
  type HermesSessionMessage,
} from "./tauri";

export type StartAgentRunMonitoringInput = {
  storedSessionId: string;
  runtimeSessionId?: string;
  title: string;
  fullMode: boolean;
  settlementHeld: boolean;
  /** Identity and freshness proof for the prompt this monitor owns. The
   * caller retains its surface-specific persisted-user matcher so recovery
   * cannot mistake an older identical user message for this accepted Agent
   * run. */
  acceptedPrompt: AgentRunAcceptedPrompt;
  terminalEvidence?: AgentRunTerminalEvidence;
};

export type AgentRunAcceptedPrompt = {
  dispatchedAtMs: number;
  findPersistedUserIndex: (messages: readonly HermesSessionMessage[]) => number;
};

export type AgentRunTerminalEvidence = {
  status: "completed" | "failed" | "cancelled";
  summary: string;
  /** Earliest timestamp that can belong to this accepted prompt. Persisted
   * or replayed outcome evidence older than this boundary belongs to an
   * earlier run. */
  notBeforeMs: number;
};

export type AgentRunMonitorSnapshot = {
  generation: number;
  runtimeSessionId?: string;
  fullMode: boolean;
  phase: "active" | "stopping" | "succeeded" | "terminal";
};

type AgentRunMonitor = StartAgentRunMonitoringInput & {
  generation: number;
  stopping: boolean;
  succeeded: boolean;
  successAuthority?: "explicit" | "assistant-fallback";
  settlement?: HermesRunSettlementHandle;
  settlementCleanupTimer?: ReturnType<typeof setTimeout>;
  stopCallbacks?: Set<() => void>;
};

type ModeObserver = {
  connected: boolean;
  connecting?: Promise<void>;
  gateway: HermesGatewayClient;
  reconnectTimer?: ReturnType<typeof setTimeout>;
};

type PersistedCompletion = { authority: "assistant-fallback" };

const OBSERVER_RECONNECT_MS = 1_000;
const MONITOR_POLL_INTERVAL_MS = 500;
const MONITOR_TIMEOUT_MS = 6 * 60 * 60 * 1_000;
const MONITOR_STOP_TIMEOUT_MS = 2_000;
const runs = new Map<string, AgentRunMonitor>();
const terminalRunSnapshots = new Map<string, AgentRunMonitorSnapshot>();
const terminalRunSnapshotOrder: string[] = [];
const MAX_RUN_MONITOR_SNAPSHOTS = 100;
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
    generation: ++nextGeneration,
    stopping: false,
    succeeded: false,
    terminalEvidence:
      input.terminalEvidence && Number.isFinite(input.terminalEvidence.notBeforeMs)
        ? input.terminalEvidence
        : undefined,
  };
  runs.set(input.storedSessionId, run);
  forgetTerminalRunSnapshot(input.storedSessionId);

  if (previous && previous.fullMode !== run.fullMode) {
    closeObserverWhenUnused(previous.fullMode);
  }
  void ensureObserver(run.fullMode).catch(() => scheduleObserverReconnect(run.fullMode));
  startSettlementIfReady(run);
  // Publish after the caller receives and records this generation. The
  // initiating surface then ignores equality, while any other surface still
  // holding an older generation can retire its stale local continuity.
  queueMicrotask(() => {
    dispatchAgentRunStarted({
      storedSessionId: run.storedSessionId,
      runMonitorGeneration: run.generation,
      runtimeSessionId: run.runtimeSessionId,
      fullMode: run.fullMode,
    });
  });
  return run.generation;
}

/** Marks a successful terminal edge learned by the submitting UI surface. */
export function markAgentRunSucceeded(storedSessionId: string, expectedGeneration: number) {
  const run = currentRunForGeneration(storedSessionId, expectedGeneration);
  if (!run || run.stopping) return false;
  run.terminalEvidence = undefined;
  armSuccessfulRun(run, "explicit");
  return true;
}

/** Retains unresolved run-outcome evidence for the current monitor generation.
 * A failed transcript completion is negative evidence without itself being an
 * Agent-run terminal; a repeated anonymous terminal is replay-ambiguous. While
 * either is pending, partial assistant prose cannot be inferred as success. */
export function preserveAgentRunTerminalEvidence(
  storedSessionId: string,
  evidence: AgentRunTerminalEvidence,
  expectedGeneration: number,
) {
  const run = currentRunForGeneration(storedSessionId, expectedGeneration);
  if (!run || run.stopping || !Number.isFinite(evidence.notBeforeMs)) return false;
  if (run.successAuthority === "explicit") return false;
  if (
    run.successAuthority === "assistant-fallback" &&
    (evidence.status === "failed" || evidence.status === "cancelled")
  ) {
    run.succeeded = false;
    run.successAuthority = undefined;
  }
  if (
    evidence.status === "completed" &&
    (run.terminalEvidence?.status === "failed" || run.terminalEvidence?.status === "cancelled")
  ) {
    // Anonymous/replayed completion is weaker than negative evidence already
    // observed for this accepted run. Only the surface's explicit terminal
    // authority may clear that failure or cancellation via markAgentRunSucceeded.
    return true;
  }
  run.terminalEvidence = {
    ...evidence,
    notBeforeMs: Math.max(run.terminalEvidence?.notBeforeMs ?? 0, evidence.notBeforeMs),
  };
  return true;
}

/**
 * Retires a failed run learned by the UI. The UI already owns its failed
 * status dispatch, so this function deliberately emits no second event.
 */
export function markAgentRunFailed(
  storedSessionId: string,
  expectedGeneration: number,
  summary?: string,
) {
  void summary;
  const run = currentRunForGeneration(storedSessionId, expectedGeneration);
  if (!run || run.stopping) return false;
  finishRun(run);
  return true;
}

/** Releases a completed run once all automatic continuation work is drained. */
export function releaseAgentRunSettlement(storedSessionId: string, expectedGeneration: number) {
  const run = currentRunForGeneration(storedSessionId, expectedGeneration);
  if (!run || run.stopping) return false;
  run.settlementHeld = false;
  startSettlementIfReady(run);
  return true;
}

/** Cancels readiness for an explicit Stop, deletion, or superseding workflow. */
export function cancelAgentRunMonitoring(storedSessionId: string, expectedGeneration: number) {
  const run = currentRunForGeneration(storedSessionId, expectedGeneration);
  if (!run) return false;
  finishRun(run);
  return true;
}

/** Sends Stop to the exact runtime session and mode owned by this generation.
 * This owns monitor cancellation so passive surfaces never guess from a stale
 * local runtime id. The UI still retires immediately if the observer reconnects. */
export function stopAgentRunMonitoring(
  storedSessionId: string,
  expectedGeneration: number,
  onStopped?: () => void,
) {
  const run = currentRunForGeneration(storedSessionId, expectedGeneration);
  if (!run) return false;
  if (onStopped) {
    if (!run.stopCallbacks) run.stopCallbacks = new Set();
    run.stopCallbacks.add(onStopped);
  }
  if (run.stopping) return true;
  run.stopping = true;
  cancelSettlement(run);
  const runtimeSessionId = run.runtimeSessionId ?? run.storedSessionId;
  let stopTimeout: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    stopTimeout = setTimeout(resolve, MONITOR_STOP_TIMEOUT_MS);
  });
  const interrupt = (async () => {
    const observer = await ensureObserver(run.fullMode);
    if (!isCurrent(run)) return;
    await observer.gateway.request("session.interrupt", { session_id: runtimeSessionId });
  })().catch(() => {});
  void Promise.race([interrupt, timeout]).finally(() => {
    if (stopTimeout !== undefined) clearTimeout(stopTimeout);
    if (isCurrent(run)) finishRun(run);
    const callbacks = [...(run.stopCallbacks ?? [])];
    run.stopCallbacks?.clear();
    for (const callback of callbacks) {
      try {
        callback();
      } catch {
        // Stop completion is best-effort; a surface refresh callback must not
        // turn an already-retired monitor into an unhandled rejection.
      }
    }
  });
  return true;
}

/** Read-only app-lifetime ownership for a surface that mounts after run-start. */
export function agentRunMonitorSnapshot(
  storedSessionId: string,
): AgentRunMonitorSnapshot | undefined {
  const run = runs.get(storedSessionId);
  if (run) {
    return {
      generation: run.generation,
      runtimeSessionId: run.runtimeSessionId,
      fullMode: run.fullMode,
      phase: run.stopping ? "stopping" : run.succeeded ? "succeeded" : "active",
    };
  }
  return terminalRunSnapshots.get(storedSessionId);
}

/** Untagged runtime frames are safe to attribute only when this is the sole
 * monitored run in that mode. */
export function canAttributeUntaggedAgentRun(storedSessionId: string, fullMode: boolean) {
  const modeRuns = [...runs.values()].filter((run) => run.fullMode === fullMode);
  return modeRuns.length === 1 && modeRuns[0]?.storedSessionId === storedSessionId;
}

export function hasPendingAgentRunTerminalEvidence(
  storedSessionId: string,
  expectedGeneration: number,
) {
  return (
    currentRunForGeneration(storedSessionId, expectedGeneration)?.terminalEvidence !== undefined
  );
}

/** True only while this surface's accepted run still owns the app-lifetime
 * monitor slot for the stored session. */
export function isAgentRunMonitorGenerationCurrent(
  storedSessionId: string,
  expectedGeneration: number,
) {
  return currentRunForGeneration(storedSessionId, expectedGeneration) !== undefined;
}

function armSuccessfulRun(run: AgentRunMonitor, authority: AgentRunMonitor["successAuthority"]) {
  if (!isCurrent(run)) return;
  run.succeeded = true;
  run.successAuthority = authority;
  startSettlementIfReady(run);
}

function startSettlementIfReady(run: AgentRunMonitor) {
  if (!isCurrent(run) || run.stopping || run.settlement) return;
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
      // Hermes routes session events only to the transport that created or
      // resumed that session. The submitting UI can report success as a fast
      // path, but persisted messages are the correctness path after that UI
      // disappears.
      if (!run.succeeded && matchingRows.every((row) => row.status === "idle")) {
        const terminalEvidence = run.terminalEvidence;
        const completion = await persistedRunCompletion(run, terminalEvidence);
        if (!isCurrent(run) || run.generation !== generation) {
          return [{ id: run.runtimeSessionId ?? run.storedSessionId, status: "working" }];
        }
        if (run.succeeded) return rows;
        if (run.terminalEvidence !== terminalEvidence) {
          return [{ id: run.runtimeSessionId ?? run.storedSessionId, status: "working" }];
        }
        if (completion) {
          run.terminalEvidence = undefined;
          run.succeeded = true;
          run.successAuthority = completion.authority;
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
        runMonitorGeneration: run.generation,
        summary: "June finished.",
      });
      finishRun(run);
    },
  });
  // The settlement helper intentionally times out silently. Mirror its budget
  // so a runtime that never becomes reachable cannot retain an observer socket
  // or leave a generation owner permanently working in an offscreen surface.
  run.settlementCleanupTimer = setTimeout(() => {
    if (!isCurrent(run) || run.generation !== generation) return;
    finishRun(run);
    dispatchAgentSessionStatus({
      sessionId: run.storedSessionId,
      title: run.title,
      status: "failed",
      runMonitorGeneration: run.generation,
      summary: "June stopped responding.",
    });
  }, MONITOR_TIMEOUT_MS + 1);
}

async function persistedRunCompletion(
  run: AgentRunMonitor,
  terminalEvidence: AgentRunTerminalEvidence | undefined,
): Promise<PersistedCompletion | undefined> {
  try {
    const messagesResponse = await hermesBridgeSessionMessages(run.storedSessionId);
    const messages =
      messagesResponse.messages ?? messagesResponse.items ?? messagesResponse.data ?? [];
    const persistedUserIndex = run.acceptedPrompt.findPersistedUserIndex(messages);
    if (
      !Number.isInteger(persistedUserIndex) ||
      persistedUserIndex < 0 ||
      persistedUserIndex >= messages.length ||
      messages[persistedUserIndex]?.role !== "user"
    ) {
      return undefined;
    }
    // Pinned Hermes persists TUI session lifecycle, not an Agent-run outcome:
    // `/api/sessions` has ended_at/end_reason but no run status. Do not infer a
    // failed or cancelled Agent run from lifecycle teardown metadata.
    // A repeated anonymous failure and a successful run with a stale replay can
    // both persist an assistant row. Until unique runtime evidence breaks that
    // tie, treating prose as success would silently erase a genuine failure.
    if (terminalEvidence?.status === "failed" || terminalEvidence?.status === "cancelled") {
      return undefined;
    }
    return hasFinalContentBearingAssistantReply(messages, persistedUserIndex)
      ? { authority: "assistant-fallback" }
      : undefined;
  } catch {
    return undefined;
  }
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
  rememberTerminalRunSnapshot(run);
  cancelSettlement(run);
  closeObserverWhenUnused(run.fullMode);
}

function rememberTerminalRunSnapshot(run: AgentRunMonitor) {
  terminalRunSnapshots.set(run.storedSessionId, {
    generation: run.generation,
    runtimeSessionId: run.runtimeSessionId,
    fullMode: run.fullMode,
    phase: "terminal",
  });
  const priorIndex = terminalRunSnapshotOrder.indexOf(run.storedSessionId);
  if (priorIndex >= 0) terminalRunSnapshotOrder.splice(priorIndex, 1);
  terminalRunSnapshotOrder.push(run.storedSessionId);
  while (terminalRunSnapshots.size > MAX_RUN_MONITOR_SNAPSHOTS) {
    const evicted = terminalRunSnapshotOrder.shift();
    if (!evicted) return;
    terminalRunSnapshots.delete(evicted);
  }
}

function forgetTerminalRunSnapshot(storedSessionId: string) {
  terminalRunSnapshots.delete(storedSessionId);
  const priorIndex = terminalRunSnapshotOrder.indexOf(storedSessionId);
  if (priorIndex >= 0) terminalRunSnapshotOrder.splice(priorIndex, 1);
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

function currentRunForGeneration(storedSessionId: string, expectedGeneration: number) {
  const run = runs.get(storedSessionId);
  return run?.generation === expectedGeneration ? run : undefined;
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
  terminalRunSnapshots.clear();
  terminalRunSnapshotOrder.length = 0;
  for (const observer of observers.values()) {
    if (observer.reconnectTimer !== undefined) clearTimeout(observer.reconnectTimer);
    observer.gateway.close();
  }
  observers.clear();
  nextGeneration = 0;
}
