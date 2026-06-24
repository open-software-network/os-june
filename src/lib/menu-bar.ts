import type { AgentSessionStatusDetail } from "./agent-events";
import type { HermesSessionInfo } from "./tauri";

export const AGENT_MENU_BAR_STATE_EVENT = "scribe:menu-bar:agent-state";
export const AGENT_MENU_BAR_NEW_SESSION_EVENT =
  "scribe:menu-bar:new-agent-session";
export const AGENT_MENU_BAR_OPEN_SESSION_EVENT =
  "scribe:menu-bar:open-agent-session";
export const AGENT_MENU_BAR_SET_AGENT_HUD_EVENT =
  "scribe:menu-bar:set-agent-hud";
export const CLOSE_TAB_EVENT = "scribe://close-tab";
export const OPEN_SETTINGS_EVENT = "scribe://open-settings";

export type AgentMenuBarSessionStatus = "idle" | "running" | "waitingForUser";

export type AgentMenuBarSession = {
  id: string;
  title: string;
  status: AgentMenuBarSessionStatus;
  lastActive?: string;
};

export type AgentMenuBarState = {
  activeCount: number;
  needsUserCount: number;
  sessions: AgentMenuBarSession[];
  agentHudEnabled: boolean;
  lastStatus?: {
    sessionId?: string;
    title?: string;
    status: AgentSessionStatusDetail["status"];
    summary?: string;
  };
  updatedAt: string;
};

type BuildAgentMenuBarStateOptions = {
  sessions: HermesSessionInfo[];
  workingSessionIds: ReadonlySet<string>;
  waitingSessionIds: ReadonlySet<string>;
  lastStatus?: AgentSessionStatusDetail;
  agentHudEnabled?: boolean;
  limit?: number;
  now?: Date;
};

const DEFAULT_SESSION_LIMIT = 6;
const TITLE_LIMIT = 64;
const SUBTITLE_LIMIT = 84;

export function buildAgentMenuBarState({
  sessions,
  workingSessionIds,
  waitingSessionIds,
  lastStatus,
  agentHudEnabled = true,
  limit = DEFAULT_SESSION_LIMIT,
  now = new Date(),
}: BuildAgentMenuBarStateOptions): AgentMenuBarState {
  const activeSessionIds = new Set([
    ...Array.from(workingSessionIds),
    ...Array.from(waitingSessionIds),
  ]);
  const orderedSessions = [...sessions]
    .filter((session) => typeof session.id === "string" && session.id.trim())
    .sort((a, b) => {
      const statusRankDelta =
        statusPriority(b.id, workingSessionIds, waitingSessionIds) -
        statusPriority(a.id, workingSessionIds, waitingSessionIds);
      if (statusRankDelta !== 0) return statusRankDelta;
      return sessionTimestamp(b).localeCompare(sessionTimestamp(a));
    })
    .slice(0, limit)
    .map((session) => ({
      id: session.id,
      title: titleForSession(session),
      status: statusForSession(
        session.id,
        workingSessionIds,
        waitingSessionIds,
      ),
      lastActive: sessionTimestamp(session),
    }));

  return {
    activeCount: activeSessionIds.size,
    needsUserCount: waitingSessionIds.size,
    sessions: orderedSessions,
    agentHudEnabled,
    lastStatus: lastStatus
      ? {
          sessionId: lastStatus.sessionId,
          title:
            normalizeText(lastStatus.title, TITLE_LIMIT) ??
            normalizeText(lastStatus.prompt, TITLE_LIMIT),
          status: lastStatus.status,
          summary: normalizeText(lastStatus.summary, SUBTITLE_LIMIT),
        }
      : undefined,
    updatedAt: now.toISOString(),
  };
}

function statusPriority(
  sessionId: string,
  workingSessionIds: ReadonlySet<string>,
  waitingSessionIds: ReadonlySet<string>,
) {
  if (waitingSessionIds.has(sessionId)) return 2;
  if (workingSessionIds.has(sessionId)) return 1;
  return 0;
}

export async function emitAgentMenuBarState(state: AgentMenuBarState) {
  try {
    const api = await import("@tauri-apps/api/event");
    if (typeof api.emit !== "function") return;
    await api.emit(AGENT_MENU_BAR_STATE_EVENT, state);
  } catch {
    // Browser-only tests and web previews do not have a native menu bar.
  }
}

function statusForSession(
  sessionId: string,
  workingSessionIds: ReadonlySet<string>,
  waitingSessionIds: ReadonlySet<string>,
): AgentMenuBarSessionStatus {
  if (waitingSessionIds.has(sessionId)) return "waitingForUser";
  if (workingSessionIds.has(sessionId)) return "running";
  return "idle";
}

function titleForSession(session: HermesSessionInfo) {
  return (
    normalizeText(session.title, TITLE_LIMIT) ??
    normalizeText(session.preview, TITLE_LIMIT) ??
    "Untitled session"
  );
}

function sessionTimestamp(session: HermesSessionInfo) {
  return timestampString(
    session.last_active ??
      session.lastActive ??
      session.started_at ??
      session.startedAt ??
      session.ended_at ??
      session.endedAt,
  );
}

function timestampString(value: unknown) {
  if (typeof value === "string" && value.trim()) return value;
  if (typeof value === "number" && Number.isFinite(value)) {
    const milliseconds =
      value > 0 && value < 10_000_000_000 ? value * 1000 : value;
    return new Date(milliseconds).toISOString();
  }
  return new Date(0).toISOString();
}

function normalizeText(value: unknown, limit: number) {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return undefined;
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, Math.max(0, limit - 3)).trim()}...`;
}
