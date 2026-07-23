import { dispatchAgentRunSettled, dispatchAgentSessionStatus } from "./agent-events";
import { subscribeHermesActiveSessionSnapshots } from "./hermes-active-session-snapshots";
import {
  watchHermesRunSettlement,
  type HermesRunSettlementHandle,
  type HermesRunSettlementObservation,
} from "./hermes-run-settlement";
import {
  hermesBridgeSessionMessages,
  hermesBridgeSessions,
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
  unreachableSnapshots: number;
  settlement?: HermesRunSettlementHandle;
  settlementCleanupTimer?: ReturnType<typeof setTimeout>;
};

type TerminalOutcome =
  | { kind: "succeeded" }
  | { kind: "failed"; summary: string }
  | { kind: "cancelled" };

const MONITOR_TIMEOUT_MS = 6 * 60 * 60 * 1_000;
const REQUIRED_UNREACHABLE_SNAPSHOTS = 3;
const runs = new Map<string, AgentRunMonitor>();
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
    unreachableSnapshots: 0,
  };
  runs.set(input.storedSessionId, run);

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
    timeoutMs: MONITOR_TIMEOUT_MS,
    observeActiveSessions: (observer) => observeRunSnapshots(run, observer),
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

function observeRunSnapshots(
  run: AgentRunMonitor,
  observer: (observation: HermesRunSettlementObservation) => void,
) {
  let cancelled = false;
  let processing = Promise.resolve();
  const unsubscribe = subscribeHermesActiveSessionSnapshots(run.fullMode, (snapshot) => {
    processing = processing
      .then(async () => {
        if (cancelled || !isCurrent(run)) return;
        if (!snapshot.reachable) {
          run.unreachableSnapshots += 1;
          if (run.unreachableSnapshots < REQUIRED_UNREACHABLE_SNAPSHOTS) {
            observer({ rows: undefined });
            return;
          }
          if (!run.succeeded) {
            const outcome = await persistedTerminalOutcome(run.storedSessionId);
            if (cancelled || !isCurrent(run)) return;
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
              return;
            }
          }
          if (!run.succeeded || run.settlementHeld) {
            observer({
              rows: [{ id: run.runtimeSessionId ?? run.storedSessionId, status: "working" }],
            });
            return;
          }
          // Native persisted state confirmed the run is terminal, or the live
          // stream already did. Let the bounded unreachable streak satisfy
          // settlement rather than resetting the idle count forever.
          observer({ countUnreachableAsIdle: true, rows: undefined });
          return;
        }
        run.unreachableSnapshots = 0;
        const rows = snapshot.rows;
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
        // path, but persisted session state is the degraded correctness path
        // after that UI or its stream disappears.
        if (
          !run.succeeded &&
          (run.observedActive || (run.canProbeBeforeObservedActive && matchingRows.length === 0)) &&
          matchingRows.every((row) => row.status === "idle")
        ) {
          const outcome = await persistedTerminalOutcome(run.storedSessionId);
          if (cancelled || !isCurrent(run)) return;
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
            return;
          }
        }

        if (!isCurrent(run) || !run.succeeded || run.settlementHeld) {
          observer({
            rows: [{ id: run.runtimeSessionId ?? run.storedSessionId, status: "working" }],
          });
          return;
        }
        observer({ rows });
      })
      .catch(() => {
        if (!cancelled && isCurrent(run)) observer({ rows: undefined });
      });
  });
  return () => {
    cancelled = true;
    unsubscribe();
  };
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
  if (/(?:complete|success|finish|done)/.test(marker) || (session.ended_at ?? session.endedAt)) {
    return { kind: "succeeded" };
  }
  return undefined;
}

function finishRun(run: AgentRunMonitor) {
  if (!isCurrent(run)) return;
  runs.delete(run.storedSessionId);
  cancelSettlement(run);
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

/** Clears singleton state between tests. Production ownership lasts for App. */
export function resetAgentRunMonitoringForTests() {
  for (const run of runs.values()) cancelSettlement(run);
  runs.clear();
  nextGeneration = 0;
}
