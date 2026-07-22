import { type HermesSessionMessage } from "../../lib/tauri";
import type { PendingIssueReport } from "./agent-session-continuity";
import type * as React from "react";

export type createIssueReportStateActionsDependencies = {
  deferredFailedIssueReportDeliverySessionIdsRef: React.MutableRefObject<Set<string>>;
  diagnosisRefreshIssueReportSessionIdsRef: React.MutableRefObject<Set<string>>;
  issueReportDiagnosisRefreshesRef: React.MutableRefObject<Map<string, Promise<void>>>;
  pendingIssueReportsRef: React.MutableRefObject<Map<string, PendingIssueReport>>;
  refreshHermesSession: (sessionId: string) => Promise<HermesSessionMessage[] | undefined>;
  reviewableIssueReportsRef: React.MutableRefObject<Record<string, PendingIssueReport>>;
  setDiagnosisRefreshIssueReportSessionIds: React.Dispatch<React.SetStateAction<Set<string>>>;
  setReviewableIssueReports: React.Dispatch<
    React.SetStateAction<Record<string, PendingIssueReport>>
  >;
  setSubmittingIssueReportSessionIds: React.Dispatch<React.SetStateAction<Set<string>>>;
  submittingIssueReportSessionIdsRef: React.MutableRefObject<Set<string>>;
};
