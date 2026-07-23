import type { HermesSessionInfo } from "./tauri";

export const AGENT_NEW_SESSION_EVENT = "june:agent:new-session";
export const AGENT_DELETE_SESSION_EVENT = "june:agent:delete-session";
export const AGENT_SESSIONS_CHANGED_EVENT = "june:agent:sessions-changed";
export const AGENT_NEW_SESSION_PENDING_KEY = "june:agent:new-session-pending";
export const AGENT_SESSION_RENAMED_EVENT = "june:agent:session-renamed";
export const AGENT_SESSION_STATUS_EVENT = "june:agent:session-status";
export const AGENT_RUN_SETTLED_EVENT = "june:agent:run-settled";
export const AGENT_OPEN_EVENT = "june:agent:open";
// Dev-only: toggles the agent response gallery (window.__agentGallery) or its
// error-focused variant (window.__agentErrors).
export const AGENT_GALLERY_EVENT = "june:agent:gallery";

export type AgentGalleryDetail = { show: boolean; errors?: boolean };

/** Stored session id (not the runtime session id). */
export type AgentSessionRenamedDetail = {
  sessionId: string;
  title: string;
};

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

export type AgentRunSettledDetail = {
  sessionId: string;
  title: string;
  summary: string;
  activeCount: number;
};

export type AgentSessionsChangedDetail = {
  sessions: HermesSessionInfo[];
  selectedSessionId?: string;
  workingSessionIds: string[];
  waitingSessionIds?: string[];
};

export function dispatchAgentSessionStatus(detail: AgentSessionStatusDetail) {
  window.dispatchEvent(
    new CustomEvent<AgentSessionStatusDetail>(AGENT_SESSION_STATUS_EVENT, {
      detail,
    }),
  );
  void import("@tauri-apps/api/event")
    .then((api) =>
      typeof api.emit === "function" ? api.emit(AGENT_SESSION_STATUS_EVENT, detail) : undefined,
    )
    .catch(() => {});
}

export function dispatchAgentRunSettled(detail: AgentRunSettledDetail) {
  window.dispatchEvent(
    new CustomEvent<AgentRunSettledDetail>(AGENT_RUN_SETTLED_EVENT, {
      detail,
    }),
  );
  void import("@tauri-apps/api/event")
    .then((api) =>
      typeof api.emit === "function" ? api.emit(AGENT_RUN_SETTLED_EVENT, detail) : undefined,
    )
    .catch(() => {});
}

export function dispatchAgentSessionsChanged(detail: AgentSessionsChangedDetail) {
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
      typeof api.emit === "function" ? api.emit(AGENT_SESSIONS_CHANGED_EVENT, detail) : undefined,
    )
    .catch(() => {});
}
