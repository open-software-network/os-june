import {
  hermesBridgeSessionMessages,
  hermesBridgeSessions,
  type HermesSessionInfo,
  type HermesSessionMessage,
  type HermesSessionMessagesResponse,
  type HermesSessionsResponse,
} from "./tauri";

export type HermesSessionListOptions = {
  limit?: number;
  offset?: number;
  archived?: "exclude" | "include" | "only";
  minMessages?: number;
  order?: "created" | "recent" | string;
  query?: string;
};

export async function listHermesSessions(
  options: HermesSessionListOptions = {},
) {
  const response = await hermesBridgeSessions({
    limit: 100,
    offset: 0,
    archived: "exclude",
    minMessages: 0,
    order: "recent",
    ...options,
  });
  return normalizeHermesSessionsResponse(response);
}

export async function listHermesSessionMessages(sessionId: string) {
  const response = await hermesBridgeSessionMessages(sessionId);
  return normalizeHermesSessionMessagesResponse(response);
}

export function normalizeHermesSessionsResponse(
  response: HermesSessionsResponse,
) {
  return extractList(response, "sessions")
    .filter(isHermesSessionInfo)
    .sort((a, b) => sessionTimestamp(b).localeCompare(sessionTimestamp(a)));
}

export function normalizeHermesSessionMessagesResponse(
  response: HermesSessionMessagesResponse,
) {
  return extractList(response, "messages").filter(isHermesSessionMessage);
}

export function sessionTimestamp(session: HermesSessionInfo) {
  return timestampString(
    session.last_active ??
      session.started_at ??
      session.ended_at ??
      (session as { lastActive?: unknown }).lastActive ??
      (session as { startedAt?: unknown }).startedAt ??
      (session as { endedAt?: unknown }).endedAt,
  );
}

export function titleFromPrompt(prompt: string) {
  const title = prompt.replace(/\s+/g, " ").trim();
  if (title.length <= 72) return title || "Untitled session";
  return `${title.slice(0, 69).trim()}...`;
}

function extractList<T extends object>(
  response: T,
  preferredKey: "sessions" | "messages",
) {
  const record = response as Record<string, unknown>;
  const candidates = [
    record[preferredKey],
    record.items,
    record.data,
    record.results,
  ];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate;
  }
  return [];
}

function isHermesSessionInfo(value: unknown): value is HermesSessionInfo {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    typeof (value as { id?: unknown }).id === "string"
  );
}

function isHermesSessionMessage(value: unknown): value is HermesSessionMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as { id?: unknown; role?: unknown };
  return (
    typeof message.id === "string" &&
    (message.role === "system" ||
      message.role === "user" ||
      message.role === "assistant" ||
      message.role === "tool")
  );
}

function timestampString(value: unknown) {
  if (typeof value === "string" && value.trim()) return value;
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value).toISOString();
  }
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString();
  }
  return new Date(0).toISOString();
}
