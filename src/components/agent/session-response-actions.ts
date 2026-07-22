import {
  registerBrowserExtensionHost,
  setHermesAgentCliAccess,
  setHermesBrowserAccess,
} from "../../lib/tauri";
import { createHermesMethods, type HermesMode } from "../../lib/hermes-control-plane";
import { pendingActionStore } from "../../lib/hermes-pending-actions";
import { hermesTraceBuffer } from "../../lib/hermes-trace-buffer";
import { messageFromError } from "../../lib/errors";
import { AGENT_CLI_ACCESS_ENABLED_MESSAGE } from "../../lib/agent-cli-access";
import { BROWSER_ACCESS_ENABLED_MESSAGE } from "../../lib/browser-access";
import { type AgentApprovalChoice } from "../../lib/agent-chat-runtime";
import { SESSION_GONE_MESSAGE, isSessionGoneError } from "./agent-workspace-errors";
import { omitRecordKey } from "./agent-workspace-support";
import type { createSessionResponseActionsDependencies } from "./session-response-actions-types";

export function createSessionResponseActions(
  dependencies: createSessionResponseActionsDependencies,
) {
  const {
    approvalResponseKey,
    approvalResponsesInFlightRef,
    cancelComposerDispatch,
    captureSessionModelTarget,
    classifyOptimisticLiveEvent,
    clearSessionActivity,
    composerDispatchWasInvalidated,
    ensureHermesGateway,
    hermesSessionItemsRef,
    liveEventsRef,
    loadHermesSessions,
    pushLiveEvent,
    recordOptimisticHermesActivityAndDispatchStatus,
    reserveComposerDispatch,
    selectedHermesSessionIdRef,
    sessionGatewayUnlistenRef,
    setApprovalSubmitting,
    setBrowserAccessEnabled,
    setBrowserAccessSubmitting,
    setClarifySubmitting,
    setCliAccessEnabled,
    setCliAccessSubmitting,
    setError,
    setLiveEvents,
    setSecretSubmitting,
    setSudoSubmitting,
    setWorkingTaskIds,
    submitHermesSession,
  } = dependencies;

  async function respondToApproval(
    liveEventKey: string,
    sessionId: string,
    requestId: string,
    choice: AgentApprovalChoice,
    unrestricted = false,
  ) {
    const responseKey = approvalResponseKey(liveEventKey, requestId);
    // The card disables on the next render; guard synchronously too so a rapid
    // second activation cannot target the same logical approval twice.
    if (approvalResponsesInFlightRef.current.has(responseKey)) return;
    approvalResponsesInFlightRef.current.set(responseKey, choice);
    setApprovalSubmitting((current) => ({ ...current, [requestId]: choice }));
    try {
      // The approval lives in the runtime process that asked, so the
      // response must go out on that mode's gateway.
      const gateway = await ensureHermesGateway(unrestricted);
      hermesTraceBuffer.recordOutbound({
        sessionId: liveEventKey,
        method: "approval.respond",
        params: { session_id: sessionId, request_id: requestId, choice },
      });
      const response = await gateway.request<unknown>("approval.respond", {
        session_id: sessionId,
        request_id: requestId,
        choice,
      });
      if (
        response === null ||
        typeof response !== "object" ||
        Array.isArray(response) ||
        !("resolved" in response) ||
        (response.resolved !== 0 && response.resolved !== 1)
      ) {
        setError("June could not confirm the approval outcome. Reconnect, then try again.", {
          sessionId: liveEventKey,
        });
        return;
      }
      if (response.resolved === 0) {
        const expiration = classifyOptimisticLiveEvent({
          type: "approval.expire",
          session_id: sessionId,
          payload: { request_id: requestId, reason: "stale" },
        });
        pushLiveEvent(liveEventKey, expiration);
        pendingActionStore.expireRequest(liveEventKey, requestId, "stale");
        recordOptimisticHermesActivityAndDispatchStatus(expiration, liveEventKey);
        setError("This approval is no longer pending. Nothing was approved.", { sessionId });
        return;
      }
      const resolution = classifyOptimisticLiveEvent({
        type: "approval.response",
        session_id: sessionId,
        payload: { request_id: requestId, choice },
      });
      pushLiveEvent(liveEventKey, resolution);
      // Feature 04: the user just answered this approval — clear its global
      // "Needs you" row immediately (the response itself is the resolution).
      pendingActionStore.resolveRequest(liveEventKey, requestId);
      recordOptimisticHermesActivityAndDispatchStatus(resolution, liveEventKey);
      setError(null);
    } catch (err) {
      const message = messageFromError(err);
      if (isSessionGoneError(message)) {
        // The runtime session is gone. Scrub only the affected session/task —
        // including its waiting flag, so the "Needs you" badge clears —
        // without clobbering other healthy sessions' working state or live
        // event streams.
        setWorkingTaskIds((current) => {
          if (!current.has(liveEventKey)) return current;
          const next = new Set(current);
          next.delete(liveEventKey);
          return next;
        });
        for (const key of new Set([liveEventKey, sessionId])) {
          sessionGatewayUnlistenRef.current.get(key)?.();
          clearSessionActivity(key);
        }
        liveEventsRef.current = omitRecordKey(liveEventsRef.current, liveEventKey);
        setLiveEvents(liveEventsRef.current);
        // The request can never be answered now — retire its card so neither the
        // sidebar count nor the inline prompt offers a dead-end "Respond".
        pendingActionStore.expireRequest(liveEventKey, requestId, "disconnect");
        void loadHermesSessions();
        setError(SESSION_GONE_MESSAGE, { sessionId });
      } else {
        setError(message, { sessionId });
      }
    } finally {
      approvalResponsesInFlightRef.current.delete(responseKey);
      setApprovalSubmitting((current) => {
        const next = { ...current };
        delete next[requestId];
        return next;
      });
    }
  }

  async function respondToClarify(
    liveEventKey: string,
    requestId: string,
    answer: string,
    unrestricted = false,
  ) {
    setClarifySubmitting((current) => ({ ...current, [requestId]: answer }));
    try {
      const gateway = await ensureHermesGateway(unrestricted);
      await gateway.request("clarify.respond", {
        request_id: requestId,
        answer,
      });
      const resolution = classifyOptimisticLiveEvent({
        type: "clarify.response",
        payload: { request_id: requestId, answer },
      });
      pushLiveEvent(liveEventKey, resolution);
      // Feature 04: the user answered the clarification — clear its pending record.
      pendingActionStore.resolveRequest(liveEventKey, requestId);
      recordOptimisticHermesActivityAndDispatchStatus(resolution, liveEventKey);
      setError(null);
    } catch (err) {
      const message = messageFromError(err);
      if (isSessionGoneError(message)) {
        // The runtime is gone, so this clarification can never be answered —
        // retire its card and say so plainly instead of leaking the raw 404.
        pendingActionStore.resolveRequest(liveEventKey, requestId);
        setError(SESSION_GONE_MESSAGE);
      } else {
        setError(message);
      }
    } finally {
      setClarifySubmitting((current) => {
        const next = { ...current };
        delete next[requestId];
        return next;
      });
    }
  }

  // Sudo (privilege escalation) is resolved through the typed control-plane
  // method (sudo.respond), not a hand-written request, so the wire shape stays
  // in one place. The optimistic sudo.response event flips the card to
  // resolved before the gateway round-trips.
  async function respondToSudo(
    liveEventKey: string,
    sessionId: string,
    requestId: string,
    approved: boolean,
    mode?: HermesMode,
    unrestricted = false,
  ) {
    setSudoSubmitting((current) => ({
      ...current,
      [requestId]: approved ? "approve" : "deny",
    }));
    try {
      const gateway = await ensureHermesGateway(unrestricted);
      await createHermesMethods(gateway).respondToSudo({
        sessionId,
        requestId,
        approved,
        mode,
      });
      const resolution = classifyOptimisticLiveEvent({
        type: "sudo.response",
        session_id: sessionId,
        payload: { request_id: requestId, granted: approved, mode },
      });
      pushLiveEvent(liveEventKey, resolution);
      // Feature 04: the user resolved the sudo prompt — clear its pending record.
      pendingActionStore.resolveRequest(liveEventKey, requestId);
      recordOptimisticHermesActivityAndDispatchStatus(resolution, liveEventKey);
      setError(null);
    } catch (err) {
      const message = messageFromError(err);
      if (isSessionGoneError(message)) {
        // The runtime is gone, so this prompt can never be answered — retire
        // its card and say so plainly instead of leaking the raw 404.
        pendingActionStore.resolveRequest(liveEventKey, requestId);
        setError(SESSION_GONE_MESSAGE, { sessionId });
      } else {
        setError(message, { sessionId });
      }
    } finally {
      setSudoSubmitting((current) => {
        const next = { ...current };
        delete next[requestId];
        return next;
      });
    }
  }

  // Secret entry: the value arrives here only to be handed to the gateway via
  // the typed secret.respond method, and is never stored, logged, or placed on
  // an event. The optimistic secret.response carries ONLY a `provided` flag.
  async function respondToSecret(
    liveEventKey: string,
    sessionId: string,
    requestId: string,
    value: string,
    unrestricted = false,
  ) {
    setSecretSubmitting((current) => ({ ...current, [requestId]: true }));
    try {
      const gateway = await ensureHermesGateway(unrestricted);
      await createHermesMethods(gateway).respondToSecret({
        sessionId,
        requestId,
        value,
      });
      const resolution = classifyOptimisticLiveEvent({
        type: "secret.response",
        session_id: sessionId,
        payload: { request_id: requestId, provided: true },
      });
      pushLiveEvent(liveEventKey, resolution);
      // Feature 04: the user provided the secret — clear its pending record.
      pendingActionStore.resolveRequest(liveEventKey, requestId);
      recordOptimisticHermesActivityAndDispatchStatus(resolution, liveEventKey);
      setError(null);
    } catch (err) {
      const message = messageFromError(err);
      if (isSessionGoneError(message)) {
        // The runtime is gone, so this secret prompt can never be answered —
        // retire its card and say so plainly instead of leaking the raw 404.
        pendingActionStore.resolveRequest(liveEventKey, requestId);
        setError(SESSION_GONE_MESSAGE, { sessionId });
      } else {
        setError(message, { sessionId });
      }
    } finally {
      setSecretSubmitting((current) => {
        const next = { ...current };
        delete next[requestId];
        return next;
      });
    }
  }

  // One-click approval of June's in-chat [REQUEST:AGENT_CLI_ACCESS] card.
  // The agent can never flip the setting itself (the flag lives outside the
  // sandbox's write roots), so the click is the trust boundary: it persists
  // the opt-in, which also retires the sandboxed runtime, and the follow-up
  // send respawns it with the CLI state folders writable and hands the
  // conversation back to June to retry.
  async function enableCliAccessFromChat() {
    const targetStoredSessionId = selectedHermesSessionIdRef.current;
    const targetSession = targetStoredSessionId
      ? hermesSessionItemsRef.current.find((session) => session.id === targetStoredSessionId)
      : undefined;
    const modelTarget = captureSessionModelTarget(targetSession);
    const dispatchReservation = targetStoredSessionId
      ? reserveComposerDispatch(targetStoredSessionId)
      : undefined;
    setCliAccessSubmitting(true);
    try {
      await setHermesAgentCliAccess(true);
      if (composerDispatchWasInvalidated(dispatchReservation)) return;
      setCliAccessEnabled(true);
      if (!targetSession) {
        throw new Error("This session is no longer available.");
      }
      await submitHermesSession(AGENT_CLI_ACCESS_ENABLED_MESSAGE, targetSession, {
        modelTarget,
        dispatchReservation,
        selectSession: false,
      });
      setError(null);
    } catch (err) {
      setError(messageFromError(err));
    } finally {
      cancelComposerDispatch(dispatchReservation);
      setCliAccessSubmitting(false);
    }
  }

  // One-click approval of June's in-chat [REQUEST:BROWSER_ACCESS] card. Same
  // trust boundary as the CLI access card above: the click persists the
  // Browser access grant (the setter also retires both runtime modes), and
  // the follow-up send retries the turn that asked — the request-card path is
  // the only retried shape, so no completed tool call is ever re-issued.
  async function enableBrowserAccessFromChat() {
    setBrowserAccessSubmitting(true);
    try {
      await setHermesBrowserAccess(true);
      await registerBrowserExtensionHost();
      setBrowserAccessEnabled(true);
      await submitHermesSession(BROWSER_ACCESS_ENABLED_MESSAGE);
      setError(null);
    } catch (err) {
      setError(messageFromError(err));
    } finally {
      setBrowserAccessSubmitting(false);
    }
  }

  return {
    respondToApproval,
    respondToClarify,
    respondToSudo,
    respondToSecret,
    enableCliAccessFromChat,
    enableBrowserAccessFromChat,
  };
}
