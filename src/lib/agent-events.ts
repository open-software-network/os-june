import type { HermesSessionInfo } from "./tauri";

export const AGENT_NEW_SESSION_EVENT = "june:agent:new-session";
export const AGENT_DELETE_SESSION_EVENT = "june:agent:delete-session";
export const AGENT_SESSIONS_CHANGED_EVENT = "june:agent:sessions-changed";
export const AGENT_NEW_SESSION_PENDING_KEY = "june:agent:new-session-pending";
export const AGENT_SESSION_STATUS_EVENT = "june:agent:session-status";
export const AGENT_RUN_SETTLED_EVENT = "june:agent:run-settled";
export const AGENT_RUN_STARTED_EVENT = "june:agent:run-started";
export const AGENT_OPEN_EVENT = "june:agent:open";
// Dev-only: toggles the agent response gallery (window.__agentGallery) or its
// error-focused variant (window.__agentErrors).
export const AGENT_GALLERY_EVENT = "june:agent:gallery";

export type AgentGalleryDetail = { show: boolean; errors?: boolean };

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
  /** App-lifetime monitor generation that owns this terminal, whether the
   * monitor or its submitting surface resolved it. */
  runMonitorGeneration?: number;
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
  /** App-lifetime monitor generation that owns this completion. */
  runMonitorGeneration: number;
  summary: string;
};

export type AgentRunStartedDetail = {
  storedSessionId: string;
  /** Newly installed app-lifetime monitor generation. Surfaces retire only
   * generations strictly older than this one. */
  runMonitorGeneration: number;
  runtimeSessionId?: string;
  fullMode: boolean;
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

export function dispatchAgentRunStarted(detail: AgentRunStartedDetail) {
  window.dispatchEvent(
    new CustomEvent<AgentRunStartedDetail>(AGENT_RUN_STARTED_EVENT, {
      detail,
    }),
  );
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
