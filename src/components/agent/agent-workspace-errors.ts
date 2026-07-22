import { isHermesServerError, messageFromError } from "../../lib/errors";
import type { PendingIssueReport } from "./agent-session-continuity";

// Connection-shaped failures get a "Try again" on the error banner. These are
// all June-owned gateway strings, so the match is stable.
export const GATEWAY_CONNECTION_ERROR = /hermes (gateway|bridge)/i;

// A pending request can only be answered by the runtime process that asked for
// it. When that process ends, retire the dead-end card instead of exposing the
// raw gateway 404.
export const SESSION_GONE_MESSAGE =
  "This session has ended, so the request can no longer be answered.";
export const SESSION_NOT_AVAILABLE_MESSAGE =
  "This session is no longer available. Open another conversation or start a new one.";

export function isSessionGoneError(message: string): boolean {
  return message.toLowerCase().includes("session not found");
}

function hermesServerErrorIssueReport(err: unknown): PendingIssueReport | undefined {
  const rawMessage = messageFromError(err).trim();
  if (!isHermesServerError(rawMessage)) return undefined;
  return {
    category: "bug",
    description: [
      "June hit a Hermes server error while loading this agent session.",
      "",
      "Raw error:",
      rawMessage,
    ].join("\n"),
    followUps: [],
    attachmentNames: [],
    attachmentPaths: [],
  };
}

export type AgentWorkspaceError = {
  message: string;
  /** Null means the error belongs to the no-session workspace surface. */
  sessionId: string | null;
  issueReport?: PendingIssueReport;
};

export type AgentWorkspaceErrorOptions = {
  sessionId?: string | null;
  issueReport?: PendingIssueReport;
};

export function reportableAgentErrorOptions(
  err: unknown,
  options: AgentWorkspaceErrorOptions = {},
): AgentWorkspaceErrorOptions {
  const issueReport = hermesServerErrorIssueReport(err);
  if (!issueReport) return options;
  return { ...options, issueReport };
}

export function agentWorkspaceErrorStateForMessage(
  message: string,
  sessionId: string | null,
  issueReport?: PendingIssueReport,
): AgentWorkspaceError | null {
  if (isSessionGoneError(message)) {
    return {
      message: SESSION_NOT_AVAILABLE_MESSAGE,
      sessionId,
      ...(issueReport ? { issueReport } : {}),
    };
  }
  return { message, sessionId, ...(issueReport ? { issueReport } : {}) };
}
