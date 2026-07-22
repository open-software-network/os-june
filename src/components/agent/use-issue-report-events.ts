import { useEffect } from "react";
import {
  ISSUE_REPORT_DELIVERY_SETTLED_EVENT,
  ISSUE_REPORT_FOLLOW_UP_SUBMIT_FAILED_EVENT,
  type IssueReportDeliverySettledDetail,
  type IssueReportFollowUpSubmitFailedDetail,
} from "./agent-session-continuity";
import type { useIssueReportEventsDependencies } from "./use-issue-report-events-types";

export function useIssueReportEvents(dependencies: useIssueReportEventsDependencies) {
  const {
    deferredFailedIssueReportDeliverySessionIdsRef,
    pendingIssueReportsRef,
    reviewableIssueReportsRef,
    setError,
    setIssueReportSubmitting,
    setReviewableIssueReport,
  } = dependencies;

  useEffect(() => {
    function onIssueReportDeliverySettled(event: Event) {
      const detail = (event as CustomEvent<IssueReportDeliverySettledDetail>).detail;
      if (!detail?.sessionId) return;
      setIssueReportSubmitting(detail.sessionId, false);
      if (detail.result.sent) {
        deferredFailedIssueReportDeliverySessionIdsRef.current.delete(detail.sessionId);
        if (reviewableIssueReportsRef.current[detail.sessionId] === detail.report) {
          setReviewableIssueReport(detail.sessionId, null);
        }
        return;
      }
      if (pendingIssueReportsRef.current.has(detail.sessionId)) {
        deferredFailedIssueReportDeliverySessionIdsRef.current.add(detail.sessionId);
      } else if (!reviewableIssueReportsRef.current[detail.sessionId]) {
        setReviewableIssueReport(detail.sessionId, detail.report);
      }
      setError(detail.result.errorMessage, { sessionId: detail.sessionId });
    }

    function onIssueReportFollowUpSubmitFailed(event: Event) {
      const detail = (event as CustomEvent<IssueReportFollowUpSubmitFailedDetail>).detail;
      if (!detail?.sessionId) return;
      if (pendingIssueReportsRef.current.get(detail.sessionId) === detail.queuedReport) {
        pendingIssueReportsRef.current.delete(detail.sessionId);
      }
      if (detail.restoreReport && !reviewableIssueReportsRef.current[detail.sessionId]) {
        setReviewableIssueReport(detail.sessionId, detail.restoreReport);
      }
    }

    window.addEventListener(ISSUE_REPORT_DELIVERY_SETTLED_EVENT, onIssueReportDeliverySettled);
    window.addEventListener(
      ISSUE_REPORT_FOLLOW_UP_SUBMIT_FAILED_EVENT,
      onIssueReportFollowUpSubmitFailed,
    );
    return () => {
      window.removeEventListener(ISSUE_REPORT_DELIVERY_SETTLED_EVENT, onIssueReportDeliverySettled);
      window.removeEventListener(
        ISSUE_REPORT_FOLLOW_UP_SUBMIT_FAILED_EVENT,
        onIssueReportFollowUpSubmitFailed,
      );
    };
  }, [setError]);
}
