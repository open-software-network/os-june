import { dispatchAgentSessionStatus } from "../../lib/agent-events";
import { cancelAgentRunMonitoring, releaseAgentRunSettlement } from "../../lib/agent-run-monitor";
import type { HermesActiveSessionSnapshot } from "../../lib/hermes-active-session-snapshots";
import { sessionUnrestricted } from "../../lib/agent-session-modes";
import {
  agentActivityCountsFromStore,
  sessionHasAssistantAfterLatestUser,
} from "./session-state-helpers";
import type { createRuntimeReconciliationDependencies } from "./runtime-reconciliation-types";

// The shared scheduler runs every 500ms so settlement stays prompt. Preserve
// the workspace's pre-consolidation five-second registration-race tolerance
// before treating an absent active row as a missed lifecycle heartbeat.
const REQUIRED_MISSING_LIFECYCLE_SNAPSHOTS = 11;

export function createRuntimeReconciliation(dependencies: createRuntimeReconciliationDependencies) {
  const {
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

  function runtimeSnapshotHasSession(snapshot: HermesActiveSessionSnapshot, sessionId: string) {
    const runtimeSessionId = runtimeSessionIdsRef.current[sessionId];
    return (
      snapshot.liveSessionIds.has(sessionId) ||
      Boolean(runtimeSessionId && snapshot.liveSessionIds.has(runtimeSessionId))
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

  async function reconcileWorkingSessionsAgainstRuntime(snapshot: HermesActiveSessionSnapshot) {
    const allWorking = Array.from(workingSessionIdsRef.current);
    const misses = workingReconcileMissesRef.current;
    for (const sessionId of misses.keys()) {
      if (!allWorking.includes(sessionId)) misses.delete(sessionId);
    }
    if (!snapshot.reachable) return;
    const working = allWorking.filter(
      (sessionId) => sessionUnrestricted(sessionId) === snapshot.fullMode,
    );
    if (working.length === 0) return;
    for (const sessionId of working) {
      if (runtimeSnapshotHasSession(snapshot, sessionId)) {
        misses.delete(sessionId);
        continue;
      }
      const seen = (misses.get(sessionId) ?? 0) + 1;
      if (seen < REQUIRED_MISSING_LIFECYCLE_SNAPSHOTS) {
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
    cancelAgentRunSettlement,
    hasAutomaticContinuation,
    watchCompletedAgentRunSettle,
    reconcileWorkingSessionsAgainstRuntime,
  };
}
