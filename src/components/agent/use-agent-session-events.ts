import { useEffect } from "react";
import { hermesBridgeStatus, startHermesBridge } from "../../lib/tauri";
import { refreshActiveHermesProfile } from "../../lib/active-hermes-profile";
import { releaseAgentRunSettlement } from "../../lib/agent-run-monitor";
import { describeHermesError } from "../../lib/errors";
import { reportableAgentErrorOptions } from "./agent-workspace-errors";
import {
  captureSessionContinuity,
  clearAgentSessionContinuity,
  writeAgentSessionContinuity,
} from "./agent-session-continuity";
import type { useAgentSessionEventsDependencies } from "./use-agent-session-events-types";

export function useAgentSessionEvents(dependencies: useAgentSessionEventsDependencies) {
  const {
    activeComposerDispatchReservationsRef,
    diagnosisRefreshIssueReportSessionIdsRef,
    gatewaysRef,
    hasAutomaticContinuation,
    hermesSessionItemsRef,
    imageSafeModeConsentRequestRef,
    liveEventsRef,
    pendingHermesMessagesRef,
    pendingIssueReportsRef,
    pendingSteerBySessionIdRef,
    queuedAttachmentFollowUpsRef,
    reviewableIssueReportsRef,
    runtimeSessionIdsRef,
    sessionTitleOverridesRef,
    sessionTitleSourceRef,
    setBridge,
    setError,
    submittingIssueReportSessionIdsRef,
    workingSessionIdsRef,
  } = dependencies;

  useEffect(() => {
    let cancelled = false;
    // This mount owns the snapshot now — consume it so it can't hydrate a
    // second mount (error-boundary remount, overlapping test renders) with
    // data this mount is about to mutate. Consumed here rather than in the
    // continuity initializer because StrictMode double-invokes lazy
    // initializers, which must stay pure; the unmount capture below writes
    // a fresh snapshot either way.
    clearAgentSessionContinuity();
    void (async () => {
      try {
        let status = await hermesBridgeStatus();
        if (cancelled) return;
        if (!status.running) {
          status = await startHermesBridge(undefined, false);
        }
        if (cancelled) return;
        setBridge(status);
        if (status.running) {
          void refreshActiveHermesProfile({ status });
        }
      } catch (err) {
        if (!cancelled) setError(describeHermesError(err), reportableAgentErrorOptions(err));
      }
    })();
    return () => {
      cancelled = true;
      for (const reservation of activeComposerDispatchReservationsRef.current.keys()) {
        reservation.cancel();
      }
      activeComposerDispatchReservationsRef.current.clear();
      for (const entries of Object.values(pendingSteerBySessionIdRef.current)) {
        for (const entry of entries) entry.dispatchReservation?.cancel();
      }
      pendingSteerBySessionIdRef.current = {};
      // Settlement monitoring belongs to the app lifetime, not this view.
      // Release runs with no queued local continuation before the workspace
      // gateway closes so they can still alert from Notes or Settings.
      for (const sessionId of workingSessionIdsRef.current) {
        if (!hasAutomaticContinuation(sessionId)) releaseAgentRunSettlement(sessionId);
      }
      const consentRequest = imageSafeModeConsentRequestRef.current;
      imageSafeModeConsentRequestRef.current = null;
      consentRequest?.resolve({ action: "dismiss" });
      // Keep any mid-run session alive for the next mount before the
      // gateways (and with them the live event streams) go away.
      writeAgentSessionContinuity(
        captureSessionContinuity({
          sessionItems: hermesSessionItemsRef.current,
          pendingMessages: pendingHermesMessagesRef.current,
          runtimeSessionIds: runtimeSessionIdsRef.current,
          liveEvents: liveEventsRef.current,
          titleOverrides: sessionTitleOverridesRef.current,
          titleSources: sessionTitleSourceRef.current,
          pendingIssueReports: Object.fromEntries(pendingIssueReportsRef.current),
          reviewableIssueReports: reviewableIssueReportsRef.current,
          diagnosisRefreshIssueReportSessionIds: diagnosisRefreshIssueReportSessionIdsRef.current,
          submittingIssueReportSessionIds: submittingIssueReportSessionIdsRef.current,
          queuedAttachmentFollowUps: queuedAttachmentFollowUpsRef.current,
        }),
      );
      for (const gateway of gatewaysRef.current.values()) {
        gateway.close();
      }
    };
  }, []);
}
