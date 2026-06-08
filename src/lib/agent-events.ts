export const AGENT_NEW_SESSION_EVENT = "scribe:agent:new-session";
export const AGENT_DELETE_SESSION_EVENT = "scribe:agent:delete-session";
export const AGENT_SESSIONS_CHANGED_EVENT = "scribe:agent:sessions-changed";
export const AGENT_NEW_SESSION_PENDING_KEY = "scribe:agent:new-session-pending";
export const AGENT_SESSION_STATUS_EVENT = "scribe:agent:session-status";

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
