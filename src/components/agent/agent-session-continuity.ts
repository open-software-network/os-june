import type { JuneHermesEvent } from "../../lib/hermes-control-plane";
import { hermesActivityStore } from "../../lib/hermes-activity-store";
import type { HermesSessionInfo, HermesSessionMessage } from "../../lib/tauri";
import { isReportCategory, type ReportCategory } from "./composer/reportCategory";
import { hermesMessageTimestampMs } from "./session-state-helpers";
import { hasPendingNewSessionRequest } from "./session-persistence";
import type { AgentAttachment } from "./agent-workspace-models";
import type { QueuedAttachmentFollowUp } from "./composer/follow-up-queue";

export type PendingIssueReport = {
  category: ReportCategory;
  description: string;
  followUps: string[];
  attachmentNames: string[];
  /** Workspace paths captured at submit, so the files can be uploaded with
   * the report even after the composer clears its attachment chips. */
  attachmentPaths: string[];
  /** Existing sessions can have old assistant replies; only use diagnoses
   * produced after this queued report turn started. */
  diagnosisStartedAt?: string;
};

export type ComposerDraftSnapshot = {
  text: string;
  category: ReportCategory | null;
  attachments: AgentAttachment[];
};

/** The right-hand file viewer: a list of every file surfaced in the
 * conversation, or one file opened for reading. */
export type TauriFileDropPayload = {
  paths?: string[];
};

export type FileBytesImportOptions = {
  tooLargeMessage: string;
  readErrorMessage: (file: File) => string;
  maxFiles?: number;
};

export type HermesRuntimeSessionResponse = {
  session_id?: string;
  stored_session_id?: string;
};

// Mid-run continuity across remounts. While June is working, a session has
// state that exists nowhere outside this component: the optimistic list entry
// (title + preview), the just-sent user bubble Hermes hasn't persisted yet,
// the stored→runtime session mapping, the buffered live events, the title
// override, and any queued issue report draft, the review-ready report waiting
// for the user to send, and the delayed diagnosis refresh that makes the final
// June answer available to the report payload. Working/waiting/tool-call
// display state lives in the module-global activity store, which survives this
// workspace unmount.
// Navigating away (e.g. to Settings) unmounts the workspace; without this
// snapshot the remount restores only the selected id from localStorage, and a
// session whose first turn hasn't persisted renders as an empty "Untitled
// session" that nothing ever polls back to life. Captured on unmount for
// sessions with activity-store work or local pending/report state, hydrated by
// the next mount's state initializers so the working poll picks the run
// straight back up.
export type AgentSessionContinuity = {
  sessionItems: HermesSessionInfo[];
  pendingMessages: Record<string, HermesSessionMessage[]>;
  runtimeSessionIds: Record<string, string>;
  liveEvents: Record<string, JuneHermesEvent[]>;
  titleOverrides: Record<string, string>;
  titleSources: Record<string, AgentSessionTitleSource>;
  pendingIssueReports: Record<string, PendingIssueReport>;
  reviewableIssueReports: Record<string, PendingIssueReport>;
  diagnosisRefreshIssueReportSessionIds: string[];
  submittingIssueReportSessionIds: string[];
  queuedAttachmentFollowUps: Record<string, QueuedAttachmentFollowUp[]>;
};

export type AgentSessionTitleSource =
  | "prompt"
  | "exchange"
  | "manual"
  | "rejected"
  | "rejected-final";

export type IssueReportDeliveryResult = { sent: true } | { sent: false; errorMessage: string };

export type IssueReportDeliverySettledDetail = {
  sessionId: string;
  report: PendingIssueReport;
  result: IssueReportDeliveryResult;
};

export type IssueReportFollowUpSubmitFailedDetail = {
  sessionId: string;
  queuedReport: PendingIssueReport;
  restoreReport?: PendingIssueReport;
};

let sessionContinuity: AgentSessionContinuity | null = null;
export const NEW_SESSION_DRAFT_KEY = "new-session";
export const NEW_SESSION_RECOVERY_QUEUE_KEY = "new-session-recovery";
const NEW_SESSION_DRAFT_STORAGE_KEY = "june:agent:new-session-draft";
const REVIEWABLE_ISSUE_REPORTS_STORAGE_KEY = "june:agent:reviewable-issue-reports";
export const ISSUE_REPORT_DELIVERY_SETTLED_EVENT = "june-agent-issue-report-delivery-settled";
export const ISSUE_REPORT_FOLLOW_UP_SUBMIT_FAILED_EVENT =
  "june-agent-issue-report-follow-up-submit-failed";
const ISSUE_REPORT_SENT_MESSAGE =
  "Your report was sent to the June team. Thank you for helping improve June.";

/** Success copy for a delivered report; names files that could not be attached
 * in Open Software (JUN-238: a skipped file must never be a silent drop). */
export function issueReportSentMessage(skippedAttachmentNames: string[] | undefined) {
  if (!skippedAttachmentNames?.length) return ISSUE_REPORT_SENT_MESSAGE;
  return `${ISSUE_REPORT_SENT_MESSAGE} These files could not be attached to the report in Open Software and were sent by name only: ${skippedAttachmentNames.join(", ")}.`;
}
export const ISSUE_REPORT_DIAGNOSIS_REFRESH_TIMEOUT_MS = 1500;
const ISSUE_REPORT_DIAGNOSIS_BOUNDARY_SKEW_MS = 1500;
const agentComposerDrafts = new Map<string, ComposerDraftSnapshot>();

export function sessionComposerDraftKey(sessionId: string) {
  return `session:${sessionId}`;
}

export function rememberComposerDraft(
  key: string | null,
  text: string,
  category: ReportCategory | null,
  attachments: AgentAttachment[] = [],
) {
  if (!key) return;
  if (!text.trim() && !category && attachments.length === 0) {
    agentComposerDrafts.delete(key);
    if (key === NEW_SESSION_DRAFT_KEY) removeStoredNewSessionDraft();
    return;
  }
  const snapshot = {
    text,
    category,
    attachments: [...attachments],
  };
  agentComposerDrafts.set(key, snapshot);
  if (key === NEW_SESSION_DRAFT_KEY) writeStoredNewSessionDraft(snapshot);
}

export function forgetComposerDraft(key: string | null) {
  if (!key) return;
  agentComposerDrafts.delete(key);
  if (key === NEW_SESSION_DRAFT_KEY) removeStoredNewSessionDraft();
}

export function moveComposerDraft(fromKey: string | null, toKey: string | null) {
  if (!fromKey || !toKey || fromKey === toKey) return;
  const snapshot = readComposerDraft(fromKey);
  if (!snapshot) return;
  rememberComposerDraft(toKey, snapshot.text, snapshot.category, snapshot.attachments ?? []);
  forgetComposerDraft(fromKey);
}

export function readComposerDraft(key: string | null) {
  if (!key) return undefined;
  const snapshot = agentComposerDrafts.get(key);
  if (snapshot || key !== NEW_SESSION_DRAFT_KEY) return snapshot;
  const storedSnapshot = readStoredNewSessionDraft();
  if (storedSnapshot) agentComposerDrafts.set(key, storedSnapshot);
  return storedSnapshot;
}

function hasNewSessionComposerDraft() {
  return Boolean(agentComposerDrafts.get(NEW_SESSION_DRAFT_KEY) ?? readStoredNewSessionDraft());
}

function writeStoredNewSessionDraft(snapshot: ComposerDraftSnapshot) {
  const text = snapshot.text;
  const category = snapshot.category;
  if (!text.trim() && !category) {
    removeStoredNewSessionDraft();
    return;
  }
  try {
    window.sessionStorage.setItem(
      NEW_SESSION_DRAFT_STORAGE_KEY,
      JSON.stringify({ text, category }),
    );
  } catch {
    // Storage can be unavailable in restricted webviews; the in-memory draft
    // still covers ordinary view switches in this process.
  }
}

function readStoredNewSessionDraft(): ComposerDraftSnapshot | undefined {
  try {
    const value = window.sessionStorage.getItem(NEW_SESSION_DRAFT_STORAGE_KEY);
    if (!value) return undefined;
    const parsed = JSON.parse(value) as { text?: unknown; category?: unknown };
    const text = typeof parsed.text === "string" ? parsed.text : "";
    const category = isReportCategory(parsed.category) ? parsed.category : null;
    if (!text.trim() && !category) {
      removeStoredNewSessionDraft();
      return undefined;
    }
    return { text, category, attachments: [] };
  } catch {
    removeStoredNewSessionDraft();
    return undefined;
  }
}

function removeStoredNewSessionDraft() {
  try {
    window.sessionStorage.removeItem(NEW_SESSION_DRAFT_STORAGE_KEY);
  } catch {
    // Storage can be unavailable in restricted webviews.
  }
}

function activeHermesActivitySessionIds() {
  const activeIds = new Set<string>();
  for (const record of hermesActivityStore.getRecords()) {
    if (record.phase === "running" || record.phase === "waiting" || record.phase === "background") {
      activeIds.add(record.sessionId);
    }
  }
  return activeIds;
}

export function shouldOpenNewSessionOnMount() {
  return hasPendingNewSessionRequest() || hasNewSessionComposerDraft();
}

export function captureSessionContinuity(state: {
  sessionItems: HermesSessionInfo[];
  pendingMessages: Record<string, HermesSessionMessage[]>;
  runtimeSessionIds: Record<string, string>;
  liveEvents: Record<string, JuneHermesEvent[]>;
  titleOverrides: Record<string, string>;
  titleSources: Record<string, AgentSessionTitleSource>;
  pendingIssueReports: Record<string, PendingIssueReport>;
  reviewableIssueReports: Record<string, PendingIssueReport>;
  diagnosisRefreshIssueReportSessionIds: Set<string>;
  submittingIssueReportSessionIds: Set<string>;
  queuedAttachmentFollowUps: Record<string, QueuedAttachmentFollowUp[]>;
}): AgentSessionContinuity | null {
  const activeIds = activeHermesActivitySessionIds();
  for (const [sessionId, pending] of Object.entries(state.pendingMessages)) {
    if (pending.length > 0) activeIds.add(sessionId);
  }
  for (const sessionId of Object.keys(state.reviewableIssueReports)) {
    activeIds.add(sessionId);
  }
  for (const sessionId of Object.keys(state.pendingIssueReports)) {
    activeIds.add(sessionId);
  }
  for (const sessionId of state.diagnosisRefreshIssueReportSessionIds) {
    activeIds.add(sessionId);
  }
  for (const sessionId of state.submittingIssueReportSessionIds) {
    activeIds.add(sessionId);
  }
  for (const [sessionId, queued] of Object.entries(state.queuedAttachmentFollowUps)) {
    if (queued.length > 0) activeIds.add(sessionId);
  }
  if (activeIds.size === 0) return null;
  const pick = <T>(record: Record<string, T>) =>
    Object.fromEntries(Object.entries(record).filter(([sessionId]) => activeIds.has(sessionId)));
  return {
    sessionItems: state.sessionItems.filter((session) => activeIds.has(session.id)),
    pendingMessages: pick(state.pendingMessages),
    runtimeSessionIds: pick(state.runtimeSessionIds),
    liveEvents: pick(state.liveEvents),
    titleOverrides: pick(state.titleOverrides),
    titleSources: pick(state.titleSources),
    pendingIssueReports: pick(state.pendingIssueReports),
    reviewableIssueReports: pick(state.reviewableIssueReports),
    diagnosisRefreshIssueReportSessionIds: [...state.diagnosisRefreshIssueReportSessionIds].filter(
      (sessionId) => activeIds.has(sessionId),
    ),
    submittingIssueReportSessionIds: [...state.submittingIssueReportSessionIds].filter(
      (sessionId) => activeIds.has(sessionId),
    ),
    queuedAttachmentFollowUps: pick(state.queuedAttachmentFollowUps),
  };
}

export function persistedReviewableIssueReports(): Record<string, PendingIssueReport> {
  try {
    const raw = window.localStorage.getItem(REVIEWABLE_ISSUE_REPORTS_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>)
        .map(([sessionId, value]) => [sessionId, persistedIssueReport(value)])
        .filter(
          (entry): entry is [string, PendingIssueReport] =>
            typeof entry[0] === "string" && entry[1] !== undefined,
        ),
    );
  } catch {
    return {};
  }
}

export function persistReviewableIssueReports(reports: Record<string, PendingIssueReport>) {
  try {
    const entries = Object.entries(reports);
    if (entries.length === 0) {
      window.localStorage.removeItem(REVIEWABLE_ISSUE_REPORTS_STORAGE_KEY);
      return;
    }
    window.localStorage.setItem(
      REVIEWABLE_ISSUE_REPORTS_STORAGE_KEY,
      JSON.stringify(Object.fromEntries(entries)),
    );
  } catch {
    // Best-effort: app reload restore can fail without blocking the report flow.
  }
}

function persistedIssueReport(value: unknown): PendingIssueReport | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const candidate = value as Partial<PendingIssueReport>;
  if (
    !isReportCategory(candidate.category) ||
    typeof candidate.description !== "string" ||
    !Array.isArray(candidate.followUps) ||
    !Array.isArray(candidate.attachmentNames) ||
    !Array.isArray(candidate.attachmentPaths)
  ) {
    return undefined;
  }
  const followUps = candidate.followUps.filter(
    (followUp): followUp is string => typeof followUp === "string",
  );
  const attachmentNames = candidate.attachmentNames.filter(
    (name): name is string => typeof name === "string",
  );
  const attachmentPaths = candidate.attachmentPaths.filter(
    (path): path is string => typeof path === "string",
  );
  return {
    category: candidate.category,
    description: candidate.description,
    followUps,
    attachmentNames,
    attachmentPaths,
    ...(typeof candidate.diagnosisStartedAt === "string"
      ? { diagnosisStartedAt: candidate.diagnosisStartedAt }
      : {}),
  };
}

function updateContinuityAfterIssueReportDelivery(detail: IssueReportDeliverySettledDetail) {
  if (!sessionContinuity) return;
  const reviewableIssueReports = {
    ...sessionContinuity.reviewableIssueReports,
  };
  const pendingIssueReports = { ...sessionContinuity.pendingIssueReports };
  const diagnosisRefreshIssueReportSessionIds = new Set(
    sessionContinuity.diagnosisRefreshIssueReportSessionIds,
  );
  if (detail.result.sent && reviewableIssueReports[detail.sessionId] === detail.report) {
    delete reviewableIssueReports[detail.sessionId];
    diagnosisRefreshIssueReportSessionIds.delete(detail.sessionId);
  } else if (!detail.result.sent && !pendingIssueReports[detail.sessionId]) {
    reviewableIssueReports[detail.sessionId] =
      reviewableIssueReports[detail.sessionId] ?? detail.report;
  }
  persistReviewableIssueReports(reviewableIssueReports);
  sessionContinuity = captureSessionContinuity({
    sessionItems: sessionContinuity.sessionItems,
    pendingMessages: sessionContinuity.pendingMessages,
    runtimeSessionIds: sessionContinuity.runtimeSessionIds,
    liveEvents: sessionContinuity.liveEvents,
    titleOverrides: sessionContinuity.titleOverrides,
    titleSources: sessionContinuity.titleSources,
    pendingIssueReports,
    reviewableIssueReports,
    diagnosisRefreshIssueReportSessionIds,
    submittingIssueReportSessionIds: new Set(
      sessionContinuity.submittingIssueReportSessionIds.filter(
        (sessionId) => sessionId !== detail.sessionId,
      ),
    ),
    queuedAttachmentFollowUps: sessionContinuity.queuedAttachmentFollowUps,
  });
}

function updateContinuityAfterIssueReportFollowUpSubmitFailed(
  detail: IssueReportFollowUpSubmitFailedDetail,
) {
  if (!sessionContinuity) return;
  const pendingIssueReports = { ...sessionContinuity.pendingIssueReports };
  if (pendingIssueReports[detail.sessionId] === detail.queuedReport) {
    delete pendingIssueReports[detail.sessionId];
  }
  const reviewableIssueReports = {
    ...sessionContinuity.reviewableIssueReports,
  };
  if (detail.restoreReport && !reviewableIssueReports[detail.sessionId]) {
    reviewableIssueReports[detail.sessionId] = detail.restoreReport;
  }
  persistReviewableIssueReports(reviewableIssueReports);
  sessionContinuity = captureSessionContinuity({
    sessionItems: sessionContinuity.sessionItems,
    pendingMessages: sessionContinuity.pendingMessages,
    runtimeSessionIds: sessionContinuity.runtimeSessionIds,
    liveEvents: sessionContinuity.liveEvents,
    titleOverrides: sessionContinuity.titleOverrides,
    titleSources: sessionContinuity.titleSources,
    pendingIssueReports,
    reviewableIssueReports,
    diagnosisRefreshIssueReportSessionIds: new Set(
      sessionContinuity.diagnosisRefreshIssueReportSessionIds,
    ),
    submittingIssueReportSessionIds: new Set(sessionContinuity.submittingIssueReportSessionIds),
    queuedAttachmentFollowUps: sessionContinuity.queuedAttachmentFollowUps,
  });
}

/** stored session id (not the runtime session id). */
export function recordManualAgentSessionTitle(sessionId: string, title: string) {
  if (!sessionContinuity) return;
  sessionContinuity = captureSessionContinuity({
    sessionItems: sessionContinuity.sessionItems.map((session) =>
      session.id === sessionId ? { ...session, title } : session,
    ),
    pendingMessages: sessionContinuity.pendingMessages,
    runtimeSessionIds: sessionContinuity.runtimeSessionIds,
    liveEvents: sessionContinuity.liveEvents,
    titleOverrides: {
      ...sessionContinuity.titleOverrides,
      [sessionId]: title,
    },
    titleSources: {
      ...sessionContinuity.titleSources,
      [sessionId]: "manual",
    },
    pendingIssueReports: sessionContinuity.pendingIssueReports,
    reviewableIssueReports: sessionContinuity.reviewableIssueReports,
    diagnosisRefreshIssueReportSessionIds: new Set(
      sessionContinuity.diagnosisRefreshIssueReportSessionIds,
    ),
    submittingIssueReportSessionIds: new Set(sessionContinuity.submittingIssueReportSessionIds),
    queuedAttachmentFollowUps: sessionContinuity.queuedAttachmentFollowUps,
  });
}

export function dispatchIssueReportDeliverySettled(detail: IssueReportDeliverySettledDetail) {
  updateContinuityAfterIssueReportDelivery(detail);
  window.dispatchEvent(
    new CustomEvent<IssueReportDeliverySettledDetail>(ISSUE_REPORT_DELIVERY_SETTLED_EVENT, {
      detail,
    }),
  );
}

export function dispatchIssueReportFollowUpSubmitFailed(
  detail: IssueReportFollowUpSubmitFailedDetail,
) {
  updateContinuityAfterIssueReportFollowUpSubmitFailed(detail);
  window.dispatchEvent(
    new CustomEvent<IssueReportFollowUpSubmitFailedDetail>(
      ISSUE_REPORT_FOLLOW_UP_SUBMIT_FAILED_EVENT,
      { detail },
    ),
  );
}

export function issueReportDescription(report: PendingIssueReport) {
  const followUps = report.followUps.map((followUp) => followUp.trim()).filter(Boolean);
  if (followUps.length === 0) return report.description;
  return [
    report.description,
    "",
    "Follow-up comments:",
    ...followUps.map((followUp, index) => `${index + 1}. ${followUp}`),
  ].join("\n");
}

export function appendIssueReportFollowUp(
  report: PendingIssueReport,
  followUp: string,
  attachmentNames: string[],
  attachmentPaths: string[],
): PendingIssueReport {
  return {
    ...report,
    followUps: [
      ...report.followUps,
      followUp.trim() || "No follow-up text was typed; see the attachments.",
    ],
    attachmentNames: [...report.attachmentNames, ...attachmentNames],
    attachmentPaths: [...report.attachmentPaths, ...attachmentPaths],
  };
}

export function messageAfterIssueReportDiagnosisBoundary(
  message: HermesSessionMessage,
  report: PendingIssueReport,
) {
  if (!report.diagnosisStartedAt) return true;
  const messageTime = hermesMessageTimestampMs(message);
  const boundaryTime = Date.parse(report.diagnosisStartedAt);
  if (!Number.isFinite(boundaryTime)) return true;
  return (
    messageTime !== undefined &&
    messageTime >= boundaryTime - ISSUE_REPORT_DIAGNOSIS_BOUNDARY_SKEW_MS
  );
}

/** Test hook: the snapshot is module state, so a test that unmounts with a
 * working session (testing-library auto-cleanup) would otherwise leak it into
 * the next test's mount. */
export function resetAgentSessionContinuity() {
  for (const items of Object.values(sessionContinuity?.queuedAttachmentFollowUps ?? {})) {
    for (const item of items) item.dispatchReservation?.cancel();
  }
  sessionContinuity = null;
  agentComposerDrafts.clear();
  removeStoredNewSessionDraft();
  for (const record of hermesActivityStore.getRecords()) {
    hermesActivityStore.clearSession(record.sessionId);
  }
}

export function seedAgentComposerDraftForTest(
  key: string,
  snapshot: {
    text: string;
    category: ReportCategory | null;
    attachments?: AgentAttachment[];
  },
) {
  rememberComposerDraft(key, snapshot.text, snapshot.category, snapshot.attachments ?? []);
}

export function readAgentSessionContinuity() {
  return sessionContinuity;
}

export function writeAgentSessionContinuity(next: AgentSessionContinuity | null) {
  sessionContinuity = next;
}

export function clearAgentSessionContinuity() {
  sessionContinuity = null;
}
