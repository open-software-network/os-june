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
    // Sessions exist before their first message persists (a routine run that
    // hasn't produced a turn yet, or a created session whose submit failed) —
    // listed at minMessages 0 they render as empty "Untitled session" rows
    // that vanish or morph moments later. A just-created session the user is
    // typing into is not affected: every list surface shows the workspace's
    // merged list, which carries the optimistic local entry until the first
    // message persists.
    minMessages: 1,
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
  const source = promptTitleSource(prompt);
  if (!source) return "Untitled session";
  const stripped = stripRequestPrefix(source) || source;
  const firstClause = stripped
    .split(/(?:[.!?;:]|\s+-\s+|\s+--\s+)/)
    .at(0)
    ?.trim();
  const words = (firstClause || stripped)
    .replace(/\s+/g, " ")
    .split(" ")
    .filter(Boolean)
    .slice(0, 6);
  const title = titleCaseSessionTitle(words.join(" "));
  if (title.length <= 72) return title || "Untitled session";
  return `${title.slice(0, 69).trim()}...`;
}

function promptTitleSource(prompt: string) {
  return prompt
    .replace(/\n*--- Attached Context ---[\s\S]*$/m, "")
    .replace(/\n*--- Context Warnings ---[\s\S]*$/m, "")
    .replace(/\n+Attached files copied into[\s\S]*$/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^["'`]+|["'`]+$/g, "");
}

function stripRequestPrefix(value: string) {
  let title = value.trim();
  const prefixes = [
    /^(?:hey\s+)?june,?\s+/i,
    /^(?:please\s+)?(?:can|could|would)\s+you\s+/i,
    /^(?:please\s+)?help\s+me(?:\s+to)?\s+/i,
    /^(?:i\s+want\s+you\s+to|i\s+want\s+to|i\s+need\s+you\s+to|i\s+need\s+to|i'd\s+like\s+you\s+to|i'd\s+like\s+to)\s+/i,
    /^(?:have|ask)\s+june\s+to\s+/i,
    /^please\s+/i,
  ];
  let changed = true;
  while (changed) {
    changed = false;
    for (const prefix of prefixes) {
      const next = title.replace(prefix, "").trim();
      if (next !== title) {
        title = next;
        changed = true;
      }
    }
  }
  return title;
}

function titleCaseSessionTitle(value: string) {
  const smallWords = new Set([
    "a",
    "an",
    "and",
    "as",
    "at",
    "but",
    "by",
    "for",
    "from",
    "in",
    "into",
    "of",
    "on",
    "or",
    "the",
    "to",
    "with",
  ]);
  return value
    .split(" ")
    .map((word, index) => {
      if (!word) return word;
      if (/[A-Z]/.test(word) && word === word.toUpperCase()) return word;
      const lower = word.toLowerCase();
      if (index > 0 && smallWords.has(lower)) return lower;
      return lower.replace(/^([a-z])/, (match) => match.toUpperCase());
    })
    .join(" ")
    .trim();
}

function extractList(response: unknown, preferredKey: "sessions" | "messages") {
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
