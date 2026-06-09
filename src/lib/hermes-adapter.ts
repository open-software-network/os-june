import {
  deleteHermesBridgeSession,
  hermesBridgeSessionMessages,
  hermesBridgeSessions,
  type HermesSessionInfo,
  type HermesSessionMessage,
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

export async function deleteHermesSession(sessionId: string) {
  await deleteHermesBridgeSession(sessionId);
}

export function normalizeHermesSessionsResponse(response: unknown) {
  return extractList(response, "sessions")
    .filter(isHermesSessionInfo)
    .sort((a, b) => sessionTimestamp(b).localeCompare(sessionTimestamp(a)));
}

export function normalizeHermesSessionMessagesResponse(response: unknown) {
  return extractList(response, "messages").flatMap(
    normalizeHermesSessionMessage,
  );
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

function extractList(
  response: unknown,
  preferredKey: "sessions" | "messages",
) {
  if (!response || typeof response !== "object") return [];
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

function normalizeHermesSessionMessage(value: unknown): HermesSessionMessage[] {
  if (!value || typeof value !== "object") return [];
  const message = value as HermesSessionMessage & {
    id?: unknown;
    role?: unknown;
  };
  if (typeof message.id !== "string" && typeof message.id !== "number")
    return [];
  if (
    message.role !== "system" &&
    message.role !== "user" &&
    message.role !== "assistant" &&
    message.role !== "tool"
  )
    return [];
  return [{ ...message, id: String(message.id) }];
}

function timestampString(value: unknown) {
  if (typeof value === "string" && value.trim()) return value;
  if (typeof value === "number" && Number.isFinite(value)) {
    const milliseconds =
      value > 0 && value < 10_000_000_000 ? value * 1000 : value;
    return new Date(milliseconds).toISOString();
  }
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString();
  }
  return new Date(0).toISOString();
}
