import { dispatchAgentSessionStatus } from "../../lib/agent-events";
import { markAgentRunSucceeded } from "../../lib/agent-run-monitor";
import { HermesGatewayClient } from "../../lib/hermes-gateway";
import {
  classifyHermesEvent,
  hermesModeFor,
  isTerminalHermesEvent,
} from "../../lib/hermes-control-plane";
import { unsupportedEventStore } from "../../lib/hermes-unsupported-events";
import { pendingActionStore } from "../../lib/hermes-pending-actions";
import { hermesArtifactStore } from "../../lib/hermes-artifact-store";
import { hermesTraceBuffer } from "../../lib/hermes-trace-buffer";
import {
  rememberSessionThinkingLevel,
  thinkingEffortForLevel,
  thinkingLevelForEffort,
} from "../../lib/thinking-level";
import { appendHermesLiveEvent } from "../../lib/agent-chat-runtime";
import {
  agentActivityCountsFromStore,
  agentStatusSummaryFromHermesEvent,
} from "./session-state-helpers";
import { createLeadingTrailingMicrobatch } from "../../lib/trailing-microbatch";
import type { createSessionEventListenerDependencies } from "./session-event-listener-types";

const HERMES_STREAM_STATE_BATCH_INTERVAL_MS = 50;

function isHermesStreamDelta(event: ReturnType<typeof classifyHermesEvent>) {
  return (
    (event.kind === "transcript" && !event.complete && event.delta !== undefined) ||
    (event.kind === "reasoning" && !event.full)
  );
}

export function createSessionEventListener(dependencies: createSessionEventListenerDependencies) {
  const {
    cancelAgentRunSettlement,
    clearSessionActivity,
    clearSubmittedSteers,
    continueAfterCompletedAgentRun,
    liveEventsRef,
    pendingSteerBySessionIdRef,
    promotePendingIssueReportToReview,
    recordHermesActivityAndDeriveStatus,
    refreshHermesSession,
    releaseAllComputerUseRuns,
    releaseComputerUseRun,
    sessionGatewayUnlistenRef,
    sessionThinkingAppliedRef,
    sessionThinkingEfforts,
    sessionThinkingEffortsRef,
    setLiveEvents,
    withStoredHermesSessionId,
  } = dependencies;

  function attachHermesSessionEventListener({
    gateway,
    runtimeSessionId,
    sessionDisplayTitle,
    storedSessionId,
    computerUseRunLeaseId,
  }: {
    gateway: HermesGatewayClient;
    runtimeSessionId: string;
    sessionDisplayTitle: string;
    storedSessionId: string;
    computerUseRunLeaseId?: string;
  }) {
    sessionGatewayUnlistenRef.current.get(storedSessionId)?.();
    const agentRunCompletionSource = Symbol(storedSessionId);
    let unlisten = () => {};
    const liveEventsBatch = createLeadingTrailingMicrobatch(
      () => setLiveEvents(liveEventsRef.current),
      HERMES_STREAM_STATE_BATCH_INTERVAL_MS,
    );
    const removeListener = gateway.onEvent((event) => {
      if (event.session_id !== runtimeSessionId && event.session_id !== storedSessionId) return;
      const liveEvent = { ...event, receivedAt: new Date().toISOString() };
      // Classify the raw frame once at ingress. Stores and transcript rendering
      // consume the typed event; the raw frame remains only for trace capture
      // and the Stage B status helpers below.
      const classified = classifyHermesEvent(liveEvent);
      const storedClassified = withStoredHermesSessionId(classified, storedSessionId);
      // Feature 15: record every inbound frame (raw type + the kind it
      // classified to) into the bounded, sanitized trace buffer so the dev/debug
      // trace panel can reconstruct the session. recordInbound re-classifies and
      // sanitizes internally; nothing raw is retained.
      hermesTraceBuffer.recordInbound(liveEvent, { storedSessionId });
      // The runtime's session.info is the source of truth for the effort a
      // session ACTUALLY runs at (emitted after every build and on every
      // live retune): hydrate the per-session record from it so the composer
      // labels this chat with its own level after a relaunch or a change made
      // outside June, and mark the reporting runtime as known-at that effort
      // so the send flow never fires a redundant config.set against it.
      if (event.type === "session.info") {
        const reportedEffort = (event.payload as { reasoning_effort?: unknown } | undefined)
          ?.reasoning_effort;
        const reportedLevel = thinkingLevelForEffort(
          typeof reportedEffort === "string" ? reportedEffort : undefined,
        );
        if (reportedLevel) {
          sessionThinkingEffortsRef.current = {
            ...sessionThinkingEfforts(),
            [storedSessionId]: reportedLevel,
          };
          rememberSessionThinkingLevel(storedSessionId, reportedLevel);
          sessionThinkingAppliedRef.current = {
            ...sessionThinkingAppliedRef.current,
            [storedSessionId]: {
              runtimeId: runtimeSessionId,
              effort: thinkingEffortForLevel(reportedLevel),
            },
          };
        }
      }
      if (storedClassified.kind === "unsupported") {
        // Feed the bounded per-session store so the user gets a recoverable
        // notice (when this is the active session) and developers get a
        // sanitized, issue-report-safe export. The payload is already sanitized
        // by the classifier; nothing raw is retained or logged.
        unsupportedEventStore.record(storedClassified);
        if (import.meta.env.DEV) {
          // biome-ignore lint/suspicious/noConsole: dev-only unsupported-event diagnostic
          console.debug(
            "[hermes] unsupported event",
            storedClassified.rawType,
            storedClassified.sanitizedPayload,
          );
        }
      } else if (storedClassified.kind === "pending_action") {
        // Feature 04: aggregate this blocker into the pending-action store
        // keyed by mode + session + request. The session's mode comes from its
        // recorded opt-in (sudo carries its own; the rest derive it here). A
        // fresh event for a known request also re-confirms a row that went
        // stale across a reconnect (see the store's reconcile logic).
        pendingActionStore.record(storedClassified, hermesModeFor(storedSessionId));
      } else if (storedClassified.kind === "pending_action_resolution") {
        // Resolution events can arrive independently of this surface's local
        // response promise (for example after reconnect). Reconcile the exact
        // logical request before deriving the session status so another
        // distinct pending action keeps the session in "Needs you".
        pendingActionStore.resolveRequest(storedSessionId, storedClassified.action.requestId);
      } else if (storedClassified.kind === "pending_action_expiration") {
        pendingActionStore.expireRequest(
          storedSessionId,
          storedClassified.action.requestId,
          storedClassified.action.reason,
        );
      }
      // Feature 11: roll EVERY classified event into the global activity store
      // that backs the Agent activity drawer. The store is total and ignores
      // unattributable events, so one unconditional call covers all kinds; it
      // derives the session's phase (running/waiting/background/error/complete),
      // current tool, and subagent count from the normalized event — never from
      // the raw frame (raw JSON belongs to feature 15's trace panel).
      const status = recordHermesActivityAndDeriveStatus(storedClassified, storedSessionId);
      // Feature 14: extract any file/artifact reference this event carries into
      // the per-session artifact timeline behind the drawer's "Artifacts"
      // section. The store is total and only acts on `tool` completions that
      // name a known file/url field (conservative — never parses prose), so one
      // unconditional call is safe for every kind. Mode rides along so each
      // artifact can show its blast radius (sandboxed copy vs unrestricted path).
      hermesArtifactStore.record(storedClassified, hermesModeFor(storedSessionId));
      const nextSessionEvents = appendHermesLiveEvent(
        liveEventsRef.current[storedSessionId] ?? [],
        classified,
      );
      liveEventsRef.current = {
        ...liveEventsRef.current,
        [storedSessionId]: nextSessionEvents,
      };
      // The ref remains authoritative for every ingress consumer. Only the
      // React publication trails rapid text/reasoning deltas, coalescing the
      // same burst that the streamed-markdown presenter reveals in batches.
      // Action, lifecycle, and terminal frames still paint immediately and
      // flush any text already waiting in the batch.
      if (isHermesStreamDelta(classified)) {
        liveEventsBatch.schedule();
      } else {
        liveEventsBatch.flush();
      }
      const toolEventPhase = classified.kind === "tool" ? classified.phase : undefined;
      if (toolEventPhase === "complete") {
        // The classifier treats any tool.*complete* subtype as complete, a
        // superset of the old exact tool.complete drain trigger.
        // Hermes drains every accepted steer into the tool result it just
        // produced (run_agent.steer). Mark the pending entries drained rather
        // than removing them here: whether a steer was ACCEPTED is settled
        // asynchronously (the steer RPC's .then), which can resolve AFTER this
        // event, so the consume-vs-resend decision is deferred to the terminal
        // handler where both flags are final. Removing on `registered` alone
        // here would resubmit a steer that was accepted + drained before its
        // .then ran (the duplicate-delivery race).
        const list = pendingSteerBySessionIdRef.current[storedSessionId];
        if (list) {
          for (const entry of list) entry.toolDrained = true;
        }
      }
      const activityCounts =
        status === "completed" || status === "failed" || status === "cancelled"
          ? agentActivityCountsFromStore()
          : undefined;
      if (activityCounts) {
        // Feature 04: the session reached a terminal state (completed, a
        // terminal error, or an interrupt) — the agent is no longer blocked, so
        // any of its outstanding "Needs you" rows are moot. Clear them so the
        // sidebar "Needs you" count never shows a dead blocker for a finished
        // session.
        pendingActionStore.resolveSession(storedSessionId);
      }
      if (status) {
        if (status === "completed") {
          markAgentRunSucceeded(storedSessionId);
        } else if (status === "failed" || status === "cancelled") {
          cancelAgentRunSettlement(storedSessionId);
        }
        dispatchAgentSessionStatus({
          sessionId: storedSessionId,
          title: sessionDisplayTitle,
          status,
          summary: agentStatusSummaryFromHermesEvent(classified, status),
          ...activityCounts,
        });
      }
      if (isTerminalHermesEvent(classified)) {
        if (computerUseRunLeaseId) {
          void releaseComputerUseRun(storedSessionId, computerUseRunLeaseId);
        } else {
          void releaseAllComputerUseRuns(storedSessionId);
        }
        unlisten();
        if (!activityCounts) {
          clearSessionActivity(storedSessionId);
        }
        if (status === "completed") {
          // Serialize any undrained text steer ahead of the first local
          // attachment follow-up. Each accepted follow-up installs its own
          // terminal listener, which advances the attachment FIFO one turn at
          // a time.
          continueAfterCompletedAgentRun(storedSessionId, agentRunCompletionSource);
        } else {
          // Submitted text steers cannot be recalled and are retired on a
          // failed/cancelled run. Local attachment follow-ups remain available
          // to edit, remove, or send once the session is idle.
          clearSubmittedSteers(storedSessionId);
        }
        // The diagnostic turn is over (even on error): let the user append
        // anything June's summary surfaced before sending the bundled report.
        const promotedIssueReport = promotePendingIssueReportToReview(storedSessionId, {
          queueDiagnosisRefresh: true,
        });
        if (!promotedIssueReport) {
          window.setTimeout(() => {
            void refreshHermesSession(storedSessionId);
          }, 300);
        }
      }
    });
    unlisten = () => {
      removeListener();
      liveEventsBatch.cancel();
      if (sessionGatewayUnlistenRef.current.get(storedSessionId) === unlisten) {
        sessionGatewayUnlistenRef.current.delete(storedSessionId);
      }
    };
    sessionGatewayUnlistenRef.current.set(storedSessionId, unlisten);
    return unlisten;
  }

  return {
    attachHermesSessionEventListener,
  };
}
