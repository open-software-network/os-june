import type { PendingIssueReport } from "./agent-session-continuity";
import { type AgentWorkspaceErrorOptions } from "./agent-workspace-errors";
import type * as React from "react";

export type CreateIssueReportActionsDependencies = {
  ISSUE_REPORT_SENT_TOAST_ID: "agent-issue-report-sent";
  clearErrorForSession: (sessionId: string) => void;
  reviewableIssueReportsRef: React.MutableRefObject<Record<string, PendingIssueReport>>;
  selectedHermesSessionIdRef: React.MutableRefObject<string | undefined>;
  setError: (message: string | null, options?: AgentWorkspaceErrorOptions) => void;
  setIssueReportSubmitting: (sessionId: string, submitting: boolean) => void;
  setReviewableIssueReport: (sessionId: string, report: PendingIssueReport | null) => void;
  setSubmittingErrorIssueReport: React.Dispatch<React.SetStateAction<boolean>>;
  submittingErrorIssueReport: boolean;
  submittingIssueReportSessionIdsRef: React.MutableRefObject<Set<string>>;
  waitForIssueReportDiagnosisRefresh: (sessionId: string) => Promise<void>;
};
