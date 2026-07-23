import { startHermesBridge } from "../../lib/tauri";
import { refreshActiveHermesProfile } from "../../lib/active-hermes-profile";
import { dispatchAgentSessionStatus, type AgentSessionStatusKind } from "../../lib/agent-events";
import { type JuneHermesEvent } from "../../lib/hermes-control-plane";
import { pendingActionStore } from "../../lib/hermes-pending-actions";
import { describeHermesError, messageFromError } from "../../lib/errors";
import { sessionUnrestricted } from "../../lib/agent-session-modes";
import { UPSTREAM_PROVIDER_FAILURE_RETRY_PROMPT } from "../../lib/agent-chat-runtime";
import { upstreamProviderRecoveryStore } from "../../lib/upstream-provider-recovery";
import { isProvisionalHermesSessionId } from "./agent-workspace-config";
import {
  SESSION_NOT_AVAILABLE_MESSAGE,
  reportableAgentErrorOptions,
} from "./agent-workspace-errors";
import { type HermesRuntimeSessionResponse } from "./agent-session-continuity";
import { agentStatusSummaryFromHermesEvent } from "./session-state-helpers";
import type { createGatewayRecoveryActionsDependencies } from "./gateway-recovery-actions-types";

export function createGatewayRecoveryActions(
  dependencies: createGatewayRecoveryActionsDependencies,
) {
  const {
    approvalResponseKey,
    approvalResponsesInFlightRef,
    attachHermesSessionEventListener,
    captureSessionModelTarget,
    ensureHermesGateway,
    gatewayRecoveringRef,
    hermesSessionItemsRef,
    liveEventsRef,
    loadHermesSessions,
    recordHermesActivityAndDeriveStatus,
    refreshHermesSession,
    selectedHermesSessionIdRef,
    sessionGatewayUnlistenRef,
    setBridge,
    setBridgeStarting,
    setError,
    setLiveEvents,
    setRuntimeSessionIds,
    submitHermesSession,
    waitingSessionIdsRef,
    workingSessionIdsRef,
  } = dependencies;

  async function retryUpstreamProviderFailure(
    storedSessionId: string | undefined,
    recoveryId: string | undefined,
  ) {
    if (!storedSessionId || isProvisionalHermesSessionId(storedSessionId)) return;
    if (
      workingSessionIdsRef.current.has(storedSessionId) ||
      waitingSessionIdsRef.current.has(storedSessionId)
    ) {
      return;
    }
    if (!recoveryId || !upstreamProviderRecoveryStore.reserve(storedSessionId, recoveryId)) return;
    const session = hermesSessionItemsRef.current.find((item) => item.id === storedSessionId);
    if (!session) {
      upstreamProviderRecoveryStore.release(storedSessionId, recoveryId);
      setError(SESSION_NOT_AVAILABLE_MESSAGE, { sessionId: storedSessionId });
      return;
    }

    try {
      // This starts a new agent run in the same stored session and reuses its
      // runtime session when it is still live. The prompt has an exact
      // persisted-display mapping to the "Try again" transcript label, so a
      // later refresh cannot expose the continuation instruction. This path
      // never reads or clears the composer and never replays clarify.respond.
      await submitHermesSession(UPSTREAM_PROVIDER_FAILURE_RETRY_PROMPT, session, {
        displayContent: "Try again",
        titleContent: "Try again",
        modelTarget: captureSessionModelTarget(session),
        selectSession: false,
      });
      setError(null);
    } catch (err) {
      // prompt.submit never accepted the recovery, so the same notice may try
      // again. Once accepted, the key remains spent; a second provider failure
      // creates a new turn id and its own one-shot action.
      upstreamProviderRecoveryStore.release(storedSessionId, recoveryId);
      setError(messageFromError(err), { sessionId: storedSessionId });
    }
  }

  // "Try again" on a connection-shaped error banner: rebuild the bridge +
  // gateway connection and reload sessions, surfacing whatever still fails.
  async function retryGatewayConnection() {
    setError(null);
    try {
      await ensureHermesGateway();
      await loadHermesSessions();
      // Re-run the selected session's transcript load too: a friendly Hermes
      // 5xx banner (JUN-167) can originate from that message fetch, and
      // reconnecting alone would clear the banner without reloading the
      // messages — the load effect is keyed on the session id, which does not
      // change on retry, so it would not re-fire. refreshHermesSession handles
      // its own errors (re-showing the friendly banner if the 5xx persists).
      const sessionId = selectedHermesSessionIdRef.current;
      if (sessionId && !isProvisionalHermesSessionId(sessionId)) {
        await refreshHermesSession(sessionId);
      }
    } catch (err) {
      setError(describeHermesError(err), reportableAgentErrorOptions(err));
    }
  }

  // prompt.submit is ack-style: once acked there are no pending RPCs, so a
  // socket drop mid-run rejects nothing and no event will ever arrive — the
  // session would otherwise stay "working" (and broadcast "June is working.")
  // forever. Try to reconnect and resubscribe the active runtime sessions;
  // either way, refresh them immediately so the working-gated poll reconciles
  // their true state from persisted messages. Only the dropped mode's
  // gateway is rebuilt — sessions of that mode are the ones it served.
  async function recoverFromGatewayClose(fullMode: boolean) {
    if (gatewayRecoveringRef.current.has(fullMode)) return;
    const activeSessionIds = new Set(
      [...workingSessionIdsRef.current, ...waitingSessionIdsRef.current].filter(
        (sessionId) => sessionUnrestricted(sessionId) === fullMode,
      ),
    );
    if (!activeSessionIds.size) return;
    // A listener owns the exact attended Computer use lease opened with its
    // prompt. Tear listeners down before reconnect work so a stalled socket
    // cannot retain that authority through the reconnect timeout or failure.
    for (const sessionId of activeSessionIds) {
      sessionGatewayUnlistenRef.current.get(sessionId)?.();
    }
    gatewayRecoveringRef.current.add(fullMode);
    // The patched Hermes gateway denies and drains unresolved MCP approvals
    // when its notification socket disconnects. Mirror that fail-closed
    // boundary locally before reconnecting: an old card must never remain
    // actionable against a newly resumed runtime. Other pending-action kinds
    // keep their existing stale/reannounce reconciliation contract.
    let retiredApprovalEvents = liveEventsRef.current;
    let retiredApprovalChanged = false;
    const retiredApprovalStatuses = new Map<
      string,
      { event: JuneHermesEvent; status: AgentSessionStatusKind }
    >();
    const retiredAt = new Date().toISOString();
    for (const record of pendingActionStore.openRecords()) {
      if (!activeSessionIds.has(record.sessionId) || record.action.kind !== "approval") continue;
      // The socket rejects pending RPCs immediately before this close handler
      // runs. A response that was already processed upstream may therefore be
      // unacknowledged locally. Retire it so it cannot be sent twice, but do not
      // claim that nothing was approved when the outcome is unknowable.
      const reason = approvalResponsesInFlightRef.current.has(
        approvalResponseKey(record.sessionId, record.requestId),
      )
        ? "unconfirmed"
        : "disconnect";
      pendingActionStore.expireRequest(record.sessionId, record.requestId, reason);
      const expiration: JuneHermesEvent = {
        kind: "pending_action_expiration",
        sessionId: record.sessionId,
        action: {
          kind: "approval",
          requestId: record.requestId,
          reason,
        },
        receivedAt: retiredAt,
      };
      const status = recordHermesActivityAndDeriveStatus(expiration, record.sessionId);
      if (status) {
        retiredApprovalStatuses.set(record.sessionId, { event: expiration, status });
      }
      retiredApprovalEvents = {
        ...retiredApprovalEvents,
        [record.sessionId]: [...(retiredApprovalEvents[record.sessionId] ?? []), expiration].slice(
          -200,
        ),
      };
      retiredApprovalChanged = true;
    }
    if (retiredApprovalChanged) {
      liveEventsRef.current = retiredApprovalEvents;
      setLiveEvents(retiredApprovalEvents);
    }
    for (const [sessionId, { event, status }] of retiredApprovalStatuses) {
      dispatchAgentSessionStatus({
        sessionId,
        title:
          hermesSessionItemsRef.current.find((session) => session.id === sessionId)?.title ??
          "Agent session",
        status,
        summary: agentStatusSummaryFromHermesEvent(event, status),
      });
    }
    try {
      const gateway = await ensureHermesGateway(fullMode);
      await Promise.all(
        Array.from(activeSessionIds).map(async (sessionId) => {
          try {
            const resumed = await gateway.request<HermesRuntimeSessionResponse>("session.resume", {
              session_id: sessionId,
              cols: 96,
            });
            const runtimeSessionId = resumed.session_id;
            if (runtimeSessionId) {
              setRuntimeSessionIds((current) => ({
                ...current,
                [sessionId]: runtimeSessionId,
              }));
              attachHermesSessionEventListener({
                gateway,
                runtimeSessionId,
                sessionDisplayTitle:
                  hermesSessionItemsRef.current.find((session) => session.id === sessionId)
                    ?.title ?? "Agent session",
                storedSessionId: sessionId,
              });
            }
          } catch {
            // The runtime session may be gone; the poll reconciles it.
          }
        }),
      );
    } catch {
      // Reconnect failed — fall back to the persisted-message poll.
    } finally {
      gatewayRecoveringRef.current.delete(fullMode);
    }
    // Feature 04: the gateway is back. Any non-approval pending action not
    // re-announced by a fresh event is unverifiable across the drop, so mark it
    // stale rather than silently dropping a possible blocker. Approvals were
    // already retired above because the gateway drains them fail closed.
    pendingActionStore.reconcileAfterReconnect();
    for (const sessionId of activeSessionIds) {
      void refreshHermesSession(sessionId);
    }
  }

  async function startBridge(fullMode?: boolean) {
    setBridgeStarting(true);
    setError(null);
    try {
      const status = await startHermesBridge(undefined, fullMode);
      setBridge(status);
      await refreshActiveHermesProfile({ status, mode: fullMode ? "unrestricted" : "sandboxed" });
      return status;
    } catch (err) {
      const message = messageFromError(err);
      setError(message);
      throw err;
    } finally {
      setBridgeStarting(false);
    }
  }

  return {
    retryUpstreamProviderFailure,
    retryGatewayConnection,
    recoverFromGatewayClose,
    startBridge,
  };
}
