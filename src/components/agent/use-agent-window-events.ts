import { useEffect } from "react";
import { dispatchAgentSessionStatus } from "../../lib/agent-events";
import { describeHermesError, messageFromError } from "../../lib/errors";
import { isProvisionalHermesSessionId } from "./agent-workspace-config";
import { isSessionGoneError, reportableAgentErrorOptions } from "./agent-workspace-errors";
import {
  retainUnpersistedPendingMessages,
  sessionHasAssistantAfterLatestUser,
  sessionHasActiveWork,
  shouldResumeSessionActivity,
} from "./session-state-helpers";
import type { useAgentWindowEventsDependencies } from "./use-agent-window-events-types";

export function useAgentWindowEvents(dependencies: useAgentWindowEventsDependencies) {
  const {
    bridge,
    clearSessionActivity,
    continueAfterCompletedAgentRun,
    hermesSessionItems,
    hermesSessionMessagesRef,
    hermesSessionsHydrated,
    listSessionMessagesOrdered,
    liveEventsRef,
    pendingHermesMessagesRef,
    promotePendingIssueReportToReview,
    recordSessionRunningActivity,
    selectedHermesSessionId,
    setError,
    setHermesSessionMessages,
    setLiveEvents,
    setPendingHermesMessages,
    suggestTitleForUntitledSession,
    waitingSessionIdsRef,
    workingSessionIdsRef,
  } = dependencies;

  useEffect(() => {
    if (!bridge.running || !hermesSessionsHydrated || !selectedHermesSessionId) return;
    if (isProvisionalHermesSessionId(selectedHermesSessionId)) return;
    let cancelled = false;
    listSessionMessagesOrdered(selectedHermesSessionId)
      .then((messages) => {
        if (cancelled || !messages) return;
        const retainedPending = retainUnpersistedPendingMessages(
          pendingHermesMessagesRef.current[selectedHermesSessionId] ?? [],
          messages,
        );
        setHermesSessionMessages((current) => {
          const next = {
            ...current,
            [selectedHermesSessionId]: messages,
          };
          hermesSessionMessagesRef.current = next;
          return next;
        });
        setPendingHermesMessages((current) => {
          const next = {
            ...current,
            [selectedHermesSessionId]: retainedPending,
          };
          pendingHermesMessagesRef.current = next;
          return next;
        });
        void suggestTitleForUntitledSession(selectedHermesSessionId, messages);
        const combined = [...messages, ...retainedPending];
        if (
          shouldResumeSessionActivity(combined) &&
          !waitingSessionIdsRef.current.has(selectedHermesSessionId)
        ) {
          // An in-flight run from before a remount or gateway drop: the
          // latest message is the user's, so re-arm working state — the
          // working-gated poll below picks the session back up and
          // reconciles it from persisted messages.
          recordSessionRunningActivity(selectedHermesSessionId);
        }
        if (sessionHasAssistantAfterLatestUser(combined)) {
          promotePendingIssueReportToReview(selectedHermesSessionId, {
            queueDiagnosisRefresh: false,
          });
          const wasActive = sessionHasActiveWork(
            selectedHermesSessionId,
            workingSessionIdsRef.current,
            waitingSessionIdsRef.current,
            liveEventsRef.current,
          );
          const activityCounts = clearSessionActivity(selectedHermesSessionId);
          if (wasActive) {
            dispatchAgentSessionStatus({
              sessionId: selectedHermesSessionId,
              title:
                hermesSessionItems.find((session) => session.id === selectedHermesSessionId)
                  ?.title ?? "Agent session",
              status: "completed",
              summary: "June finished.",
              ...activityCounts,
            });
            continueAfterCompletedAgentRun(selectedHermesSessionId);
          }
          liveEventsRef.current = {
            ...liveEventsRef.current,
            [selectedHermesSessionId]: [],
          };
          setLiveEvents(liveEventsRef.current);
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message = messageFromError(err);
        // A freshly created/migrated session can briefly 404 here before its
        // record is queryable over REST (the gateway creates it; visibility
        // lags a beat). That transient "Session not found" is benign — the
        // working-gated poll re-loads once it resolves — so don't flash it as
        // an error banner (JUN-116).
        if (isSessionGoneError(message)) return;
        setError(
          describeHermesError(err),
          reportableAgentErrorOptions(err, { sessionId: selectedHermesSessionId }),
        );
      });
    return () => {
      cancelled = true;
    };
  }, [bridge.running, hermesSessionsHydrated, selectedHermesSessionId]);
}
