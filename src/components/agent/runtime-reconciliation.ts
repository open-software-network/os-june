import { dispatchAgentSessionStatus } from "../../lib/agent-events";
import { cancelAgentRunMonitoring, releaseAgentRunSettlement } from "../../lib/agent-run-monitor";
import { sessionUnrestricted } from "../../lib/agent-session-modes";
import {
  agentActivityCountsFromStore,
  sessionHasAssistantAfterLatestUser,
} from "./session-state-helpers";
import type { createRuntimeReconciliationDependencies } from "./runtime-reconciliation-types";

export function createRuntimeReconciliation(dependencies: createRuntimeReconciliationDependencies) {
  const {
    ensureHermesGateway,
    hermesSessionItems,
    pendingAttachmentPreparationsRef,
    pendingSteerBySessionIdRef,
    queuedAttachmentFollowUpsRef,
    recordSessionErrorActivity,
    refreshHermesSession,
    runtimeSessionIdsRef,
    setError,
    workingReconcileMissesRef,
    workingSessionIdsRef,
  } = dependencies;

  async function liveRuntimeSessionsForModes(modes: boolean[]) {
    let rows: Array<{ id?: string; session_key?: string; status?: string }> = [];
    const reachableModes = new Set<boolean>();
    for (const mode of modes) {
      try {
        const gateway = await ensureHermesGateway(mode);
        const response = await gateway.request<{
          sessions?: Array<{
            id?: string;
            session_key?: string;
            status?: string;
          }>;
        }>("session.active_list", {});
        rows = rows.concat(Array.isArray(response?.sessions) ? response.sessions : []);
        reachableModes.add(mode);
      } catch {
        // Can't reach this runtime — keep ITS sessions' current state rather
        // than guess, while the reachable mode still reconciles below.
      }
    }
    const live = new Set<string>();
    for (const row of rows) {
      // "idle" means the runtime session exists but isn't processing a turn.
      if (!row || row.status === "idle") continue;
      if (row.session_key) live.add(String(row.session_key));
      if (row.id) live.add(String(row.id));
    }
    return { live, reachableModes };
  }

  function runtimeSnapshotHasSession(snapshot: { live: Set<string> }, sessionId: string) {
    const runtimeSessionId = runtimeSessionIdsRef.current[sessionId];
    return (
      snapshot.live.has(sessionId) ||
      Boolean(runtimeSessionId && snapshot.live.has(runtimeSessionId))
    );
  }

  function cancelAgentRunSettlement(storedSessionId: string) {
    cancelAgentRunMonitoring(storedSessionId);
  }

  function hasAutomaticContinuation(storedSessionId: string) {
    if (pendingAttachmentPreparationsRef.current[storedSessionId]?.size) return true;
    if (pendingSteerBySessionIdRef.current[storedSessionId]?.length) return true;
    // A failed row is still unresolved continuation work: announcing "ready"
    // after its delivery error would contradict the needs-input alert and the
    // visible Retry action.
    return (queuedAttachmentFollowUpsRef.current[storedSessionId] ?? []).length > 0;
  }

  function watchCompletedAgentRunSettle(storedSessionId: string) {
    if (hasAutomaticContinuation(storedSessionId)) return;
    releaseAgentRunSettlement(storedSessionId);
  }

  async function reconcileWorkingSessionsAgainstRuntime() {
    const working = Array.from(workingSessionIdsRef.current);
    const misses = workingReconcileMissesRef.current;
    for (const sessionId of misses.keys()) {
      if (!working.includes(sessionId)) misses.delete(sessionId);
    }
    if (working.length === 0) return;
    // Working sessions may span both runtime processes; ask each mode that
    // has one and union the answers. A mode we can't reach keeps its
    // sessions' current state rather than guessing — so a one-gateway
    // failure must not mark the other mode's sessions dead either.
    const modes = Array.from(new Set(working.map((sessionId) => sessionUnrestricted(sessionId))));
    const snapshot = await liveRuntimeSessionsForModes(modes);
    if (snapshot.reachableModes.size === 0) return;
    for (const sessionId of working) {
      // Sessions of an unreachable mode were not in any answer we got;
      // counting them as misses would mark live work dead.
      if (!snapshot.reachableModes.has(sessionUnrestricted(sessionId))) continue;
      if (runtimeSnapshotHasSession(snapshot, sessionId)) {
        misses.delete(sessionId);
        continue;
      }
      const seen = (misses.get(sessionId) ?? 0) + 1;
      if (seen < 2) {
        misses.set(sessionId, seen);
        continue;
      }
      misses.delete(sessionId);
      const freshMessages = await refreshHermesSession(sessionId);
      if (!freshMessages) continue;
      if (sessionHasAssistantAfterLatestUser(freshMessages)) {
        // refreshHermesSession already saw the assistant reply while this
        // session still counted as active, so it dispatched the terminal
        // "June finished." status and cleared activity — dispatching a
        // second completed status here would overwrite that summary.
        continue;
      }
      const title =
        hermesSessionItems.find((session) => session.id === sessionId)?.title ?? "Agent session";
      const summary = "June stopped before replying.";
      recordSessionErrorActivity(sessionId, summary);
      setError(summary, { sessionId });
      dispatchAgentSessionStatus({
        sessionId,
        title,
        status: "failed",
        summary,
        ...agentActivityCountsFromStore(),
      });
    }
  }

  return {
    liveRuntimeSessionsForModes,
    runtimeSnapshotHasSession,
    cancelAgentRunSettlement,
    hasAutomaticContinuation,
    watchCompletedAgentRunSettle,
    reconcileWorkingSessionsAgainstRuntime,
  };
}
