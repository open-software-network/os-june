import type { HermesSessionInfo } from "./tauri";

export const AGENT_NEW_SESSION_EVENT = "june:agent:new-session";
export const AGENT_DELETE_SESSION_EVENT = "june:agent:delete-session";
export const AGENT_SESSIONS_CHANGED_EVENT = "june:agent:sessions-changed";
export const AGENT_NEW_SESSION_PENDING_KEY = "june:agent:new-session-pending";
export const AGENT_SESSION_STATUS_EVENT = "june:agent:session-status";
export const AGENT_OPEN_EVENT = "june:agent:open";
export const AGENT_REPLY_EVENT = "june:agent:reply";

export type AgentSessionStatusKind =
  | "received"
  | "starting"
  | "running"
  | "waitingForUser"
  | "completed"
  | "failed"
  | "cancelled";

export type AgentSessionStatusDetail = {
  sessionId?: string;
  title?: string;
  prompt?: string;
  status: AgentSessionStatusKind;
  summary?: string;
  activeCount?: number;
  needsUserCount?: number;
};

export type AgentSessionsChangedDetail = {
  sessions: HermesSessionInfo[];
  selectedSessionId?: string;
  workingSessionIds: string[];
  waitingSessionIds?: string[];
};

export type AgentReplyDetail = {
  requestId: string;
  session?: HermesSessionInfo;
  text: string;
};

export function dispatchAgentSessionStatus(detail: AgentSessionStatusDetail) {
  window.dispatchEvent(
    new CustomEvent<AgentSessionStatusDetail>(AGENT_SESSION_STATUS_EVENT, {
      detail,
    }),
  );
  void import("@tauri-apps/api/event")
    .then((api) =>
      typeof api.emit === "function"
        ? api.emit(AGENT_SESSION_STATUS_EVENT, detail)
        : undefined,
    )
    .catch(() => {});
}

export function dispatchAgentSessionsChanged(
  detail: AgentSessionsChangedDetail,
) {
  window.dispatchEvent(
    new CustomEvent<AgentSessionsChangedDetail>(AGENT_SESSIONS_CHANGED_EVENT, {
      detail,
    }),
  );
  emitAgentSessionsChanged(detail);
}

export function emitAgentSessionsChanged(detail: AgentSessionsChangedDetail) {
  void import("@tauri-apps/api/event")
    .then((api) =>
      typeof api.emit === "function"
        ? api.emit(AGENT_SESSIONS_CHANGED_EVENT, detail)
        : undefined,
    )
    .catch(() => {});
}
