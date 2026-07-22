import { toast } from "../ui/Toaster";
import { submitIssueReport } from "../../lib/tauri";
import { listHermesSessionMessages } from "../../lib/hermes-adapter";
import { recordPositiveFeedbackSent } from "../../lib/referral-nudge";
import { messageFromError } from "../../lib/errors";
import { withTimeout } from "../../lib/async-timeout";
import type { PendingIssueReport } from "./agent-session-continuity";
import { type AgentWorkspaceError } from "./agent-workspace-errors";
import {
  dispatchIssueReportDeliverySettled,
  issueReportDescription,
  issueReportSentMessage,
  messageAfterIssueReportDiagnosisBoundary,
  ISSUE_REPORT_DIAGNOSIS_REFRESH_TIMEOUT_MS,
  type IssueReportDeliveryResult,
} from "./agent-session-continuity";
import { visibleHermesMessageText } from "./session-state-helpers";
import type { CreateIssueReportActionsDependencies } from "./issue-report-actions-types";

export function createIssueReportActions(dependencies: CreateIssueReportActionsDependencies) {
  const {
    ISSUE_REPORT_SENT_TOAST_ID,
    clearErrorForSession,
    reviewableIssueReportsRef,
    selectedHermesSessionIdRef,
    setError,
    setIssueReportSubmitting,
    setReviewableIssueReport,
    setSubmittingErrorIssueReport,
    submittingErrorIssueReport,
    submittingIssueReportSessionIdsRef,
    waitForIssueReportDiagnosisRefresh,
  } = dependencies;

  async function deliverIssueReport(
    sessionId: string,
    report: PendingIssueReport,
  ): Promise<IssueReportDeliveryResult> {
    let agentDiagnosis: string | undefined;
    try {
      const messages = await listHermesSessionMessages(sessionId);
      agentDiagnosis = messages
        .slice()
        .reverse()
        .filter((message) => messageAfterIssueReportDiagnosisBoundary(message, report))
        .map((message) => (message.role === "assistant" ? visibleHermesMessageText(message) : ""))
        .find((text) => text.trim())
        ?.trim();
    } catch {
      // Best-effort; the report ships without the diagnosis.
    }
    try {
      const response = await submitIssueReport({
        category: report.category,
        description: issueReportDescription(report),
        agentDiagnosis,
        attachmentNames: report.attachmentNames,
        attachmentPaths: report.attachmentPaths,
        sessionId,
      });
      clearErrorForSession(sessionId);
      toast.success(issueReportSentMessage(response?.skippedAttachmentNames), {
        id: ISSUE_REPORT_SENT_TOAST_ID,
      });
      // T4 of the referral delight nudge: positive feedback only. The
      // error-report path deliberately doesn't record — a report sent from a
      // failure is not a delight moment, whatever its category.
      if (report.category === "feedback") recordPositiveFeedbackSent();
      return { sent: true };
    } catch (err) {
      const errorMessage = `The issue report could not be sent. ${messageFromError(err)}`;
      setError(errorMessage, { sessionId });
      return { sent: false, errorMessage };
    }
  }

  async function sendReviewableIssueReport(sessionId: string) {
    if (submittingIssueReportSessionIdsRef.current.has(sessionId)) return;
    const report = reviewableIssueReportsRef.current[sessionId];
    if (!report) return;
    setIssueReportSubmitting(sessionId, true);
    let result: IssueReportDeliveryResult | undefined;
    try {
      await withTimeout(
        waitForIssueReportDiagnosisRefresh(sessionId),
        ISSUE_REPORT_DIAGNOSIS_REFRESH_TIMEOUT_MS,
        "Issue report diagnosis refresh timed out.",
      ).catch(() => undefined);
      result = await deliverIssueReport(sessionId, report);
      if (result.sent && reviewableIssueReportsRef.current[sessionId] === report) {
        setReviewableIssueReport(sessionId, null);
      }
    } finally {
      setIssueReportSubmitting(sessionId, false);
      if (result) {
        dispatchIssueReportDeliverySettled({ sessionId, report, result });
      }
    }
  }

  async function sendErrorIssueReport(error: AgentWorkspaceError) {
    const report = error.issueReport;
    if (!report || submittingErrorIssueReport) return;
    const sessionId = error.sessionId ?? selectedHermesSessionIdRef.current;
    setSubmittingErrorIssueReport(true);
    try {
      const response = await submitIssueReport({
        category: report.category,
        description: issueReportDescription(report),
        agentDiagnosis: undefined,
        attachmentNames: report.attachmentNames,
        attachmentPaths: report.attachmentPaths,
        ...(sessionId ? { sessionId } : {}),
      });
      if (sessionId) {
        clearErrorForSession(sessionId);
      } else {
        setError(null);
      }
      toast.success(issueReportSentMessage(response?.skippedAttachmentNames), {
        id: ISSUE_REPORT_SENT_TOAST_ID,
      });
    } catch (err) {
      setError(`The issue report could not be sent. ${messageFromError(err)}`, {
        sessionId: sessionId ?? null,
        issueReport: report,
      });
    } finally {
      setSubmittingErrorIssueReport(false);
    }
  }

  return {
    deliverIssueReport,
    sendReviewableIssueReport,
    sendErrorIssueReport,
  };
}
