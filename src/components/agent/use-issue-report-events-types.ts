import type { PendingIssueReport } from "./agent-session-continuity";
import { type AgentWorkspaceErrorOptions } from "./agent-workspace-errors";
import type * as React from "react";

export type useIssueReportEventsDependencies = {
  deferredFailedIssueReportDeliverySessionIdsRef: React.MutableRefObject<Set<string>>;
  pendingIssueReportsRef: React.MutableRefObject<Map<string, PendingIssueReport>>;
  reviewableIssueReportsRef: React.MutableRefObject<Record<string, PendingIssueReport>>;
  setError: (message: string | null, options?: AgentWorkspaceErrorOptions) => void;
  setIssueReportSubmitting: (sessionId: string, submitting: boolean) => void;
  setReviewableIssueReport: (sessionId: string, report: PendingIssueReport | null) => void;
};
