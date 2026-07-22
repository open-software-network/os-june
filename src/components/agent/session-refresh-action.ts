import { dispatchAgentSessionStatus } from "../../lib/agent-events";
import { markAgentRunSucceeded } from "../../lib/agent-run-monitor";
import { describeHermesError, messageFromError } from "../../lib/errors";
import { isSessionGoneError, reportableAgentErrorOptions } from "./agent-workspace-errors";
import {
  retainUnpersistedPendingMessages,
  sessionHasAssistantAfterLatestUser,
  sessionHasActiveWork,
} from "./session-state-helpers";
import type { createSessionRefreshActionDependencies } from "./session-refresh-action-types";

export function createSessionRefreshAction(dependencies: createSessionRefreshActionDependencies) {
  const {
    clearSessionActivity,
    continueAfterCompletedAgentRun,
    hermesSessionItems,
    hermesSessionMessagesRef,
    listSessionMessagesOrdered,
    liveEventsRef,
    loadHermesSessions,
    pendingHermesMessagesRef,
    promotePendingIssueReportToReview,
    releaseAllComputerUseRuns,
    setError,
    setHermesSessionMessages,
    setLiveEvents,
    setPendingHermesMessages,
    suggestTitleForUntitledSession,
    waitingSessionIdsRef,
    workingSessionIdsRef,
  } = dependencies;

  async function refreshHermesSessionImplementationBody(sessionId: string) {
    try {
      const messages = await listSessionMessagesOrdered(sessionId);
      if (!messages) return undefined;
      const retainedPending = retainUnpersistedPendingMessages(
        pendingHermesMessagesRef.current[sessionId] ?? [],
        messages,
      );
      const combined = [...messages, ...retainedPending];
      setHermesSessionMessages((current) => {
        const next = {
          ...current,
          [sessionId]: messages,
        };
        hermesSessionMessagesRef.current = next;
        return next;
      });
      setPendingHermesMessages((current) => {
        const next = {
          ...current,
          [sessionId]: retainedPending,
        };
        pendingHermesMessagesRef.current = next;
        return next;
      });
      void suggestTitleForUntitledSession(sessionId, messages);
      if (sessionHasAssistantAfterLatestUser(combined)) {
        promotePendingIssueReportToReview(sessionId, {
          queueDiagnosisRefresh: false,
        });
        const wasActive = sessionHasActiveWork(
          sessionId,
          workingSessionIdsRef.current,
          waitingSessionIdsRef.current,
          liveEventsRef.current,
        );
        const activityCounts = clearSessionActivity(sessionId);
        if (wasActive) {
          void releaseAllComputerUseRuns(sessionId);
          markAgentRunSucceeded(sessionId);
          dispatchAgentSessionStatus({
            sessionId,
            title:
              hermesSessionItems.find((session) => session.id === sessionId)?.title ??
              "Agent session",
            status: "completed",
            summary: "June finished.",
            ...activityCounts,
          });
          continueAfterCompletedAgentRun(sessionId);
        }
        liveEventsRef.current = { ...liveEventsRef.current, [sessionId]: [] };
        setLiveEvents(liveEventsRef.current);
      }
      await loadHermesSessions();
      return combined;
    } catch (err) {
      const message = messageFromError(err);
      // Background refresh racing a just-created session: a transient
      // "Session not found" 404 resolves on the next poll, so don't surface
      // it as an error banner (JUN-116).
      if (isSessionGoneError(message)) return undefined;
      setError(describeHermesError(err), reportableAgentErrorOptions(err, { sessionId }));
      return undefined;
    }
  }

  return {
    refreshHermesSessionImplementationBody,
  };
}
