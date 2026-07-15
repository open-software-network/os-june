import {
  deleteHermesBridgeSession,
  hermesBridgeSessionMessages,
  hermesBridgeSessions,
  shareDelete,
  shareKeyGet,
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

export async function listHermesSessions(options: HermesSessionListOptions = {}) {
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
  // Revoke any share for this session before deleting it, so its server-side
  // ciphertext and invite ACL don't outlive the session: once it's gone the
  // owner has no Share dialog left to revoke from, and recipient links would
  // keep opening. Fail closed - a failed revoke keeps the session.
  const share = await shareKeyGet("session", sessionId);
  if (share) {
    await shareDelete(share.shareId);
  }
  await deleteHermesBridgeSession(sessionId);
}

export function normalizeHermesSessionsResponse(response: unknown) {
  return extractList(response, "sessions")
    .filter(isHermesSessionInfo)
    .filter((session) => !isDelegatedSubagentSession(session))
    .map(withScheduledRunDisplay)
    .sort((a, b) => sessionTimestamp(b).localeCompare(sessionTimestamp(a)));
}

function isDelegatedSubagentSession(session: HermesSessionInfo) {
  return (
    sessionSource(session) === "tool" ||
    sessionKind(session) === "subagent" ||
    sessionKind(session) === "delegate_task" ||
    hasSubagentId(session)
  );
}

function sessionSource(session: HermesSessionInfo) {
  return normalizeSessionMarker(session.source);
}

function sessionKind(session: HermesSessionInfo) {
  return normalizeSessionMarker(session.session_type ?? session.sessionType ?? session.kind);
}

function hasSubagentId(session: HermesSessionInfo) {
  return Boolean(normalizeSessionMarker(session.subagent_id ?? session.subagentId));
}

function normalizeSessionMarker(value: unknown) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

/** Hermes tags scheduled-routine runs with source "cron". */
export const SCHEDULED_RUN_SOURCE = "cron";

export function isScheduledRunSession(session: HermesSessionInfo) {
  return session.source === SCHEDULED_RUN_SOURCE;
}

/** The cron scheduler mints run session ids as
 * `cron_<job id>_<YYYYMMDD_HHMMSS>` — the embedded job id is the only link
 * from a run back to its routine. Returns undefined for any other id shape. */
export function scheduledRunJobId(sessionId: string) {
  return /^cron_(.+)_\d{8}_\d{6}$/.exec(sessionId)?.[1];
}

/** Hermes's session list has no source filter, so runs are found by fetching
 * a recent window and filtering client-side. 200 covers weeks of mixed
 * activity; runs older than the window age out of the history view. */
const SCHEDULED_RUN_FETCH_LIMIT = 200;
const PENDING_SCHEDULED_RUN_ACTIVE_WINDOW_MS = 5 * 60 * 1000;
const UNTITLED_SESSION_TITLE = "Untitled session";

export type ScheduledRunListOptions = {
  includeActive?: boolean;
};

/** Recent scheduled-routine runs, newest first. */
export async function listScheduledRunSessions(options: ScheduledRunListOptions = {}) {
  const listOptions: HermesSessionListOptions = {
    limit: SCHEDULED_RUN_FETCH_LIMIT,
  };
  if (options.includeActive) {
    // Cron runs are persisted as sessions before their first message lands.
    // The global session list hides zero-message rows, but routine history
    // needs them so a just-started run appears immediately.
    listOptions.minMessages = 0;
  }
  const sessions = await listHermesSessions(listOptions);
  const runs = sessions.filter(isScheduledRunSession);
  return options.includeActive ? runs.map(withScheduledRunActivity) : runs;
}

export function isRunningScheduledRunSession(session: HermesSessionInfo) {
  return isScheduledRunSession(session) && (session.active === true || session.is_active === true);
}

function withScheduledRunActivity(session: HermesSessionInfo): HermesSessionInfo {
  if (!isScheduledRunSession(session)) return session;
  if (!isRunningScheduledRunSession(session) && !isRecentPendingRun(session)) {
    return session;
  }
  return {
    ...session,
    active: true,
    status: session.status?.trim() || "running",
    title: hasScheduledRunContent(session) ? session.title : undefined,
    preview: session.preview?.trim() || undefined,
  };
}

function isRecentPendingRun(session: HermesSessionInfo) {
  if (session.message_count !== 0 || hasSessionEnded(session)) return false;
  const timestamp = Date.parse(sessionTimestamp(session));
  if (!Number.isFinite(timestamp) || timestamp <= 0) return false;
  const ageMs = Date.now() - timestamp;
  return ageMs >= -60_000 && ageMs <= PENDING_SCHEDULED_RUN_ACTIVE_WINDOW_MS;
}

function hasSessionEnded(session: HermesSessionInfo) {
  return Boolean(
    stringPresent(session.ended_at) ||
      stringPresent(session.endedAt) ||
      stringPresent(session.end_reason),
  );
}

function hasScheduledRunContent(session: HermesSessionInfo) {
  return Boolean(session.preview?.trim()) || !isReplaceableScheduledRunTitle(session.title);
}

function stringPresent(value: unknown) {
  return typeof value === "string" && value.trim().length > 0;
}

/** A scheduled run's first message is the routine prompt wrapped in a machine
 * delivery preamble the cron runner injects: `[IMPORTANT: You are running as a
 * scheduled cron job. … nothing more.]`. Recognized by that exact opener so a
 * user message that merely starts with "[IMPORTANT" is never mistaken for it. */
export function isScheduledRunPreamble(content: string) {
  return /^\s*\[IMPORTANT:\s*You are running as a scheduled cron job\.?/i.test(content);
}

/** Strips the leading delivery preamble from a scheduled run's prompt, leaving
 * the routine's actual instructions. The preamble embeds bracketed tokens
 * (`[SILENT]`), so it's removed by matching brackets rather than to the first
 * `]`. A prompt without the preamble is returned unchanged. */
export function stripScheduledRunPreamble(content: string) {
  if (!isScheduledRunPreamble(content)) return content.trim();
  const start = content.indexOf("[");
  let depth = 0;
  for (let index = start; index < content.length; index += 1) {
    const char = content[index];
    if (char === "[") depth += 1;
    else if (char === "]") {
      depth -= 1;
      if (depth === 0) return content.slice(index + 1).trim();
    }
  }
  // Unbalanced (truncated preview): drop the opener line so it's not gibberish.
  return content
    .slice(start)
    .replace(/^\[IMPORTANT:[^\n]*/i, "")
    .trim();
}

export function isReplaceableScheduledRunTitle(title: unknown) {
  const value = typeof title === "string" ? title.trim() : "";
  return (
    !value ||
    value.toLowerCase() === UNTITLED_SESSION_TITLE.toLowerCase() ||
    /^\[IMPORTANT\b/i.test(value)
  );
}

/** Gives a scheduled-run session a readable title and a clean preview when the
 * stored ones are empty or still the raw delivery preamble, so every list
 * surface stops showing "[IMPORTANT…". Non-cron sessions pass through. */
function withScheduledRunDisplay(session: HermesSessionInfo): HermesSessionInfo {
  if (!isScheduledRunSession(session)) return session;
  const cleanedPreview = stripScheduledRunPreamble(session.preview ?? "");
  const storedTitle = session.title?.trim() ?? "";
  // Replace the stored title when it's empty or is the cron scaffolding — a
  // stored title is often truncated ("[IMPORTANT: You are running as"), so a
  // leading "[IMPORTANT" is enough to treat it as raw here, where we already
  // know this is a cron session.
  const title = isReplaceableScheduledRunTitle(storedTitle)
    ? titleFromPrompt(cleanedPreview)
    : storedTitle;
  return { ...session, title, preview: cleanedPreview || session.preview };
}

export function normalizeHermesSessionMessagesResponse(response: unknown) {
  return extractList(response, "messages").flatMap(normalizeHermesSessionMessage);
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
  if (!source) return UNTITLED_SESSION_TITLE;
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
  const title = sentenceCaseSessionTitle(words.join(" "));
  if (title.length <= 72) return title || UNTITLED_SESSION_TITLE;
  return `${title.slice(0, 69).trim()}...`;
}

function promptTitleSource(prompt: string) {
  return stripScheduledRunPreamble(prompt)
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

// Sentence case per spec/sentence-case.md: capitalize the first word and keep
// the user's own casing elsewhere (acronyms and proper nouns survive as typed).
function sentenceCaseSessionTitle(value: string) {
  return value.trim().replace(/^([a-z])/, (match) => match.toUpperCase());
}

function extractList(response: unknown, preferredKey: "sessions" | "messages") {
  if (!response || typeof response !== "object") return [];
  const record = response as Record<string, unknown>;
  const candidates = [record[preferredKey], record.items, record.data, record.results];
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
  if (typeof message.id !== "string" && typeof message.id !== "number") return [];
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
    const milliseconds = value > 0 && value < 10_000_000_000 ? value * 1000 : value;
    return new Date(milliseconds).toISOString();
  }
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString();
  }
  return new Date(0).toISOString();
}
