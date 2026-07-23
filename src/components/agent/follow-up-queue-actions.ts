import { dispatchAgentSessionStatus } from "../../lib/agent-events";
import { type HermesGatewayEvent } from "../../lib/hermes-gateway";
import { classifyHermesEvent, type JuneHermesEvent } from "../../lib/hermes-control-plane";
import {
  reserveHermesSessionDispatch,
  type HermesSessionDispatchReservation,
} from "../../lib/hermes-session-dispatch-mutex";
import { messageFromError } from "../../lib/errors";
import { appendHermesLiveEvent } from "../../lib/agent-chat-runtime";
import type { AgentAttachment } from "./agent-workspace-models";
import { AttachBlockedError } from "./composer/media-slash-persistence";
import {
  type CapturedSessionModelTarget,
  type PreparedComposerSubmission,
  type QueuedAttachmentFollowUp,
} from "./composer/follow-up-queue";
import { rememberComposerDraft, NEW_SESSION_RECOVERY_QUEUE_KEY } from "./agent-session-continuity";
import type { createFollowUpQueueActionsDependencies } from "./follow-up-queue-actions-types";

export function createFollowUpQueueActions(dependencies: createFollowUpQueueActionsDependencies) {
  const {
    attachmentsRef,
    cancelAgentRunSettlement,
    cancelComposerDispatch,
    categoryRef,
    clearSubmittedSteers,
    completedAgentRunAwaitingAttachmentPreparationRef,
    composerDraftKeyRef,
    composerEditorRef,
    continuingCompletedAgentRunSourcesRef,
    draftRef,
    hermesSessionItemsRef,
    liveEventsRef,
    newSessionModeRef,
    pendingAttachmentPreparationsRef,
    pendingCompletedAgentRunSourcesRef,
    pendingSteerBySessionIdRef,
    queuedAttachmentFollowUpSeqRef,
    queuedAttachmentFollowUpsRef,
    selectedHermesSessionIdRef,
    setAttachments,
    setCategory,
    setDraft,
    setError,
    setLiveEvents,
    setQueuedAttachmentFollowUps,
    submitHermesSession,
    watchCompletedAgentRunSettle,
    workingSessionIdsRef,
  } = dependencies;

  function classifyOptimisticLiveEvent(event: HermesGatewayEvent): JuneHermesEvent {
    return classifyHermesEvent({
      ...event,
      receivedAt: new Date().toISOString(),
    } as HermesGatewayEvent & { receivedAt: string });
  }

  function withStoredHermesSessionId(
    event: JuneHermesEvent,
    storedSessionId: string,
  ): JuneHermesEvent {
    return { ...event, sessionId: storedSessionId } as JuneHermesEvent;
  }

  function pushLiveEvent(key: string, event: JuneHermesEvent) {
    const nextEvents = appendHermesLiveEvent(liveEventsRef.current[key] ?? [], event);
    liveEventsRef.current = {
      ...liveEventsRef.current,
      [key]: nextEvents,
    };
    setLiveEvents(liveEventsRef.current);
  }

  function writeQueuedAttachmentFollowUps(next: Record<string, QueuedAttachmentFollowUp[]>) {
    queuedAttachmentFollowUpsRef.current = next;
    setQueuedAttachmentFollowUps(next);
  }

  function updateQueuedAttachmentFollowUps(
    queueKey: string,
    update: (items: QueuedAttachmentFollowUp[]) => QueuedAttachmentFollowUp[],
  ) {
    const nextItems = update(queuedAttachmentFollowUpsRef.current[queueKey] ?? []).sort(
      (left, right) =>
        (left.dispatchOrder ?? Number.MIN_SAFE_INTEGER) -
        (right.dispatchOrder ?? Number.MIN_SAFE_INTEGER),
    );
    const next = { ...queuedAttachmentFollowUpsRef.current };
    if (nextItems.length) {
      next[queueKey] = nextItems;
    } else {
      delete next[queueKey];
    }
    writeQueuedAttachmentFollowUps(next);
  }

  function discardSessionAttachmentFollowUps(storedSessionId: string) {
    for (const item of queuedAttachmentFollowUpsRef.current[storedSessionId] ?? []) {
      item.dispatchReservation?.cancel();
    }
    const pendingPreparations = pendingAttachmentPreparationsRef.current[storedSessionId];
    if (pendingPreparations) {
      for (const preparation of pendingPreparations.values()) {
        preparation.cancelled = true;
        cancelComposerDispatch(preparation.dispatchReservation);
      }
      delete pendingAttachmentPreparationsRef.current[storedSessionId];
    }
    completedAgentRunAwaitingAttachmentPreparationRef.current.delete(storedSessionId);
    updateQueuedAttachmentFollowUps(storedSessionId, () => []);
  }

  function enqueueAttachmentFollowUp(
    sessionId: string,
    prepared: PreparedComposerSubmission,
    queuedAttachments: AgentAttachment[],
    modelTarget: CapturedSessionModelTarget,
    dispatchReservation?: HermesSessionDispatchReservation,
    dispatchOrder?: number,
  ) {
    queuedAttachmentFollowUpSeqRef.current += 1;
    const item: QueuedAttachmentFollowUp = {
      id: `attachment-follow-up-${queuedAttachmentFollowUpSeqRef.current}`,
      prepared,
      attachments: queuedAttachments,
      modelTarget,
      dispatchReservation,
      dispatchOrder,
      status: "queued",
    };
    updateQueuedAttachmentFollowUps(sessionId, (items) => [...items, item]);
  }

  function enqueueFailedComposerFollowUp(
    queueKey: string,
    prepared: PreparedComposerSubmission,
    queuedAttachments: AgentAttachment[],
    modelTarget: CapturedSessionModelTarget,
    error: string,
    dispatchOrder?: number,
  ) {
    queuedAttachmentFollowUpSeqRef.current += 1;
    const item: QueuedAttachmentFollowUp = {
      id: `attachment-follow-up-${queuedAttachmentFollowUpSeqRef.current}`,
      prepared,
      attachments: queuedAttachments,
      modelTarget,
      dispatchOrder,
      status: "failed",
      error,
    };
    updateQueuedAttachmentFollowUps(queueKey, (items) => [...items, item]);
  }

  function removeQueuedAttachmentFollowUp(queueKey: string, itemId: string) {
    updateQueuedAttachmentFollowUps(queueKey, (items) => {
      const removed = items.find((item) => item.id === itemId && item.status !== "sending");
      removed?.dispatchReservation?.cancel();
      return items.filter((item) => item.id !== itemId || item.status === "sending");
    });
  }

  function editQueuedAttachmentFollowUp(queueKey: string, itemId: string) {
    const isNewSessionRecovery = queueKey === NEW_SESSION_RECOVERY_QUEUE_KEY;
    if (
      isNewSessionRecovery
        ? !newSessionModeRef.current
        : queueKey !== selectedHermesSessionIdRef.current
    ) {
      return;
    }
    if (!composerEditorRef.current?.flushPendingChange()) return;
    if (draftRef.current.trim() || attachmentsRef.current.length) return;
    const item = queuedAttachmentFollowUpsRef.current[queueKey]?.find(
      (candidate) => candidate.id === itemId,
    );
    if (!item || item.status === "sending") return;
    removeQueuedAttachmentFollowUp(queueKey, itemId);
    draftRef.current = item.prepared.typedMessage;
    categoryRef.current = null;
    attachmentsRef.current = item.attachments;
    setDraft(item.prepared.typedMessage);
    setCategory(null);
    setAttachments(item.attachments);
    rememberComposerDraft(
      composerDraftKeyRef.current,
      item.prepared.typedMessage,
      null,
      item.attachments,
    );
    composerEditorRef.current?.setContent(item.prepared.typedMessage);
  }

  async function deliverQueuedAttachmentFollowUp(
    queueKey: string,
    itemId?: string,
    options: { afterCompletion?: boolean } = {},
  ) {
    const isNewSessionRecovery = queueKey === NEW_SESSION_RECOVERY_QUEUE_KEY;
    if (
      !isNewSessionRecovery &&
      !options.afterCompletion &&
      workingSessionIdsRef.current.has(queueKey)
    ) {
      return false;
    }
    const queued = queuedAttachmentFollowUpsRef.current[queueKey] ?? [];
    const item = itemId ? queued.find((candidate) => candidate.id === itemId) : queued[0];
    if (!item || item.status === "sending") return false;
    // Automatic advancement (no itemId) stops at a failed head rather than
    // resending it: the row's UI is an explicit Retry, and silently resending
    // a message the user watched fail - possibly with an image already
    // attached - is worse than holding the queue until they decide.
    if (!itemId && item.status === "failed") return false;
    const session = isNewSessionRecovery
      ? undefined
      : hermesSessionItemsRef.current.find((candidate) => candidate.id === queueKey);
    if (!isNewSessionRecovery && !session) {
      const summary = "This session is no longer available.";
      item.dispatchReservation?.cancel();
      updateQueuedAttachmentFollowUps(queueKey, (items) =>
        items.map((candidate) =>
          candidate.id === item.id
            ? {
                ...candidate,
                dispatchReservation: undefined,
                status: "failed",
                error: summary,
              }
            : candidate,
        ),
      );
      cancelAgentRunSettlement(queueKey);
      dispatchAgentSessionStatus({
        sessionId: queueKey,
        title: "Agent session",
        status: "failed",
        summary,
      });
      return false;
    }
    const dispatchReservation =
      item.dispatchReservation ??
      (!isNewSessionRecovery ? reserveHermesSessionDispatch(queueKey) : undefined);
    updateQueuedAttachmentFollowUps(queueKey, (items) =>
      items.map((candidate) =>
        candidate.id === item.id
          ? { ...candidate, dispatchReservation, status: "sending", error: undefined }
          : candidate,
      ),
    );
    try {
      await submitHermesSession(item.prepared.runtimeContent, session, {
        displayContent: item.prepared.displayContent,
        titleContent: item.prepared.titleContent,
        attachments: item.attachments,
        modelTarget: isNewSessionRecovery
          ? { ...item.modelTarget, targetStoredSessionId: null }
          : item.modelTarget,
        dispatchReservation,
        ...(isNewSessionRecovery ? {} : { selectSession: false }),
        onAttachmentsUpdated: (nextAttachments) => {
          updateQueuedAttachmentFollowUps(queueKey, (items) =>
            items.map((candidate) =>
              candidate.id === item.id ? { ...candidate, attachments: nextAttachments } : candidate,
            ),
          );
        },
      });
      updateQueuedAttachmentFollowUps(queueKey, (items) =>
        items.filter((candidate) => candidate.id !== item.id),
      );
      return true;
    } catch (err) {
      dispatchReservation?.cancel();
      const failedAttachments = err instanceof AttachBlockedError ? err.attachments : undefined;
      updateQueuedAttachmentFollowUps(queueKey, (items) =>
        items.map((candidate) =>
          candidate.id === item.id
            ? {
                ...candidate,
                ...(failedAttachments ? { attachments: failedAttachments } : {}),
                dispatchReservation: undefined,
                status: "failed",
                error: messageFromError(err),
              }
            : candidate,
        ),
      );
      return false;
    }
  }

  function continueAfterCompletedAgentRun(storedSessionId: string, source?: symbol) {
    const continuingSources = continuingCompletedAgentRunSourcesRef.current;
    if (continuingSources.has(storedSessionId)) {
      const continuingSource = continuingSources.get(storedSessionId);
      if (source && source !== continuingSource) {
        pendingCompletedAgentRunSourcesRef.current.set(storedSessionId, source);
      }
      return;
    }
    continuingSources.set(storedSessionId, source);
    const finishContinuation = (watchForSettlement: boolean) => {
      continuingSources.delete(storedSessionId);
      const pendingSource = pendingCompletedAgentRunSourcesRef.current.get(storedSessionId);
      if (pendingSource) {
        pendingCompletedAgentRunSourcesRef.current.delete(storedSessionId);
        continueAfterCompletedAgentRun(storedSessionId, pendingSource);
        return;
      }
      if (watchForSettlement) watchCompletedAgentRunSettle(storedSessionId);
    };
    const submittedSteers = pendingSteerBySessionIdRef.current[storedSessionId] ?? [];
    const unconsumedSteers = submittedSteers.filter(
      (entry) => !(entry.accepted && entry.toolDrained),
    );
    for (const entry of submittedSteers) {
      if (!unconsumedSteers.includes(entry)) entry.dispatchReservation?.cancel();
    }
    clearSubmittedSteers(storedSessionId, { preserveReservations: true });
    // Transfer undrained steers into the durable queue before yielding a tick.
    // An unmount can then preserve their FIFO reservations in continuity.
    const steerFollowUps = unconsumedSteers.map((entry) => {
      queuedAttachmentFollowUpSeqRef.current += 1;
      return {
        id: `attachment-follow-up-${queuedAttachmentFollowUpSeqRef.current}`,
        prepared: {
          displayContent: entry.text,
          runtimeContent: entry.text,
          titleContent: entry.text,
          typedMessage: entry.text,
        },
        attachments: [],
        modelTarget: entry.modelTarget,
        dispatchReservation: entry.dispatchReservation,
        dispatchOrder: entry.dispatchOrder,
        status: "queued" as const,
      };
    });
    if (steerFollowUps.length) {
      updateQueuedAttachmentFollowUps(storedSessionId, (items) => [...items, ...steerFollowUps]);
    }
    window.setTimeout(async () => {
      const pendingPreparations = pendingAttachmentPreparationsRef.current[storedSessionId];
      const queueHead = queuedAttachmentFollowUpsRef.current[storedSessionId]?.[0];
      const earliestPendingPreparationOrder = pendingPreparations?.size
        ? Math.min(...pendingPreparations.keys())
        : undefined;
      const queueHeadOrder = queueHead?.dispatchOrder ?? Number.MAX_SAFE_INTEGER;
      if (
        earliestPendingPreparationOrder !== undefined &&
        earliestPendingPreparationOrder < queueHeadOrder
      ) {
        completedAgentRunAwaitingAttachmentPreparationRef.current.add(storedSessionId);
        finishContinuation(false);
        return;
      }
      if (steerFollowUps.length) {
        const followUpSession = hermesSessionItemsRef.current.find(
          (session) => session.id === storedSessionId,
        );
        if (!followUpSession) {
          for (const followUp of steerFollowUps) {
            removeQueuedAttachmentFollowUp(storedSessionId, followUp.id);
          }
          finishContinuation(false);
          return;
        }
        // Each Send captured its own model and FIFO position. Dispatch the
        // merged queue head; later completions advance one agent run at a time.
        let followUpStarted = false;
        try {
          followUpStarted = await deliverQueuedAttachmentFollowUp(storedSessionId, undefined, {
            afterCompletion: true,
          });
        } catch (err) {
          setError(messageFromError(err), { sessionId: storedSessionId });
        } finally {
          finishContinuation(!followUpStarted);
        }
        return;
      }
      let followUpStarted = false;
      try {
        followUpStarted = await deliverQueuedAttachmentFollowUp(storedSessionId, undefined, {
          afterCompletion: true,
        });
      } finally {
        finishContinuation(!followUpStarted);
      }
    }, 0);
  }

  return {
    classifyOptimisticLiveEvent,
    withStoredHermesSessionId,
    pushLiveEvent,
    writeQueuedAttachmentFollowUps,
    updateQueuedAttachmentFollowUps,
    discardSessionAttachmentFollowUps,
    enqueueAttachmentFollowUp,
    enqueueFailedComposerFollowUp,
    removeQueuedAttachmentFollowUp,
    editQueuedAttachmentFollowUp,
    deliverQueuedAttachmentFollowUp,
    continueAfterCompletedAgentRun,
  };
}
