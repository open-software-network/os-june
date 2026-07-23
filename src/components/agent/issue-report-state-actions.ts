import type { PendingIssueReport } from "./agent-session-continuity";
import { persistReviewableIssueReports } from "./agent-session-continuity";
import type { createIssueReportStateActionsDependencies } from "./issue-report-state-actions-types";

export function createIssueReportStateActions(
  dependencies: createIssueReportStateActionsDependencies,
) {
  const {
    deferredFailedIssueReportDeliverySessionIdsRef,
    diagnosisRefreshIssueReportSessionIdsRef,
    issueReportDiagnosisRefreshesRef,
    pendingIssueReportsRef,
    refreshHermesSession,
    reviewableIssueReportsRef,
    setDiagnosisRefreshIssueReportSessionIds,
    setReviewableIssueReports,
    setSubmittingIssueReportSessionIds,
    submittingIssueReportSessionIdsRef,
  } = dependencies;

  function setReviewableIssueReport(sessionId: string, report: PendingIssueReport | null) {
    const next = { ...reviewableIssueReportsRef.current };
    if (report) {
      next[sessionId] = report;
    } else {
      delete next[sessionId];
    }
    reviewableIssueReportsRef.current = next;
    persistReviewableIssueReports(next);
    setReviewableIssueReports(next);
  }

  function setIssueReportDiagnosisRefreshing(sessionId: string, refreshing: boolean) {
    const next = new Set(diagnosisRefreshIssueReportSessionIdsRef.current);
    if (refreshing) {
      next.add(sessionId);
    } else {
      next.delete(sessionId);
    }
    diagnosisRefreshIssueReportSessionIdsRef.current = next;
    setDiagnosisRefreshIssueReportSessionIds(next);
  }

  function queueIssueReportDiagnosisRefresh(sessionId: string, delayMs = 300) {
    setIssueReportDiagnosisRefreshing(sessionId, true);
    let refresh: Promise<void>;
    refresh = new Promise<void>((resolve) => {
      window.setTimeout(() => {
        void refreshHermesSession(sessionId).finally(resolve);
      }, delayMs);
    }).finally(() => {
      if (issueReportDiagnosisRefreshesRef.current.get(sessionId) === refresh) {
        issueReportDiagnosisRefreshesRef.current.delete(sessionId);
        setIssueReportDiagnosisRefreshing(sessionId, false);
      }
    });
    issueReportDiagnosisRefreshesRef.current.set(sessionId, refresh);
    return refresh;
  }

  function waitForIssueReportDiagnosisRefresh(sessionId: string) {
    if (!diagnosisRefreshIssueReportSessionIdsRef.current.has(sessionId)) {
      return Promise.resolve();
    }
    return (
      issueReportDiagnosisRefreshesRef.current.get(sessionId) ??
      queueIssueReportDiagnosisRefresh(sessionId)
    );
  }

  function promotePendingIssueReportToReview(
    sessionId: string,
    options: { queueDiagnosisRefresh: boolean },
  ) {
    const issueReport = pendingIssueReportsRef.current.get(sessionId);
    if (!issueReport) return false;
    pendingIssueReportsRef.current.delete(sessionId);
    deferredFailedIssueReportDeliverySessionIdsRef.current.delete(sessionId);
    setReviewableIssueReport(sessionId, issueReport);
    if (options.queueDiagnosisRefresh) {
      queueIssueReportDiagnosisRefresh(sessionId);
    } else {
      setIssueReportDiagnosisRefreshing(sessionId, false);
    }
    return true;
  }

  function setIssueReportSubmitting(sessionId: string, submitting: boolean) {
    const next = new Set(submittingIssueReportSessionIdsRef.current);
    if (submitting) {
      next.add(sessionId);
    } else {
      next.delete(sessionId);
    }
    submittingIssueReportSessionIdsRef.current = next;
    setSubmittingIssueReportSessionIds(next);
  }

  return {
    setReviewableIssueReport,
    setIssueReportDiagnosisRefreshing,
    queueIssueReportDiagnosisRefresh,
    waitForIssueReportDiagnosisRefresh,
    promotePendingIssueReportToReview,
    setIssueReportSubmitting,
  };
}
