import {
  deleteHermesBridgeSession,
  hermesBridgeStatus,
  hermesBridgeSessionMessages,
  hermesBridgeSessions,
  startHermesBridge,
  type HermesBridgeConnection,
  type HermesBridgeStatus,
  type HermesSessionInfo,
  type HermesSessionMessage,
} from "./tauri";
import { hermesConnectionForMode } from "./hermes-connection";
import { HermesGatewayClient } from "./hermes-gateway";

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
    .map(withScheduledRunDisplay)
    .sort((a, b) => sessionTimestamp(b).localeCompare(sessionTimestamp(a)));
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

export type ScheduledRunListOptions = {
  includeActive?: boolean;
};

/** Recent scheduled-routine runs, newest first. */
export async function listScheduledRunSessions(
  options: ScheduledRunListOptions = {},
) {
  const sessions = await listHermesSessions({
    limit: SCHEDULED_RUN_FETCH_LIMIT,
  });
  const storedRuns = sessions.filter(isScheduledRunSession);
  if (!options.includeActive) return storedRuns;
  try {
    return mergeScheduledRunSessions(
      storedRuns,
      await listActiveScheduledRunSessions(),
    );
  } catch {
    // Active runtime state is best effort. A websocket/status miss should not
    // hide the persisted run history the session store already returned.
    return storedRuns;
  }
}

type ActiveSessionRow = {
  id?: unknown;
  session_id?: unknown;
  sessionId?: unknown;
  session_key?: unknown;
  sessionKey?: unknown;
  status?: unknown;
  source?: unknown;
  title?: unknown;
  preview?: unknown;
  started_at?: unknown;
  startedAt?: unknown;
  last_active?: unknown;
  lastActive?: unknown;
  message_count?: unknown;
};

/** Scheduled-routine sessions that are currently registered in the runtime. */
export async function listActiveScheduledRunSessions() {
  const connections = await activeSessionConnections();
  const lists = await Promise.all(
    connections.map(async (connection) => {
      const client = new HermesGatewayClient();
      try {
        await client.connect(connection.wsUrl);
        const response = await client.request("session.active_list", {}, 10000);
        return normalizeActiveScheduledRunSessionsResponse(response);
      } catch {
        return [];
      } finally {
        client.close();
      }
    }),
  );
  return mergeScheduledRunSessions([], lists.flat());
}

async function activeSessionConnections() {
  let status = await hermesBridgeStatus();
  if (!status.running || connectionList(status).length === 0) {
    status = await startHermesBridge();
  }
  const connections = [
    ...connectionList(status),
    hermesConnectionForMode(status, false),
    hermesConnectionForMode(status, true),
  ].filter((connection): connection is HermesBridgeConnection =>
    Boolean(connection?.wsUrl),
  );
  return uniqueBy(connections, (connection) => connection.wsUrl);
}

function connectionList(status: HermesBridgeStatus) {
  return status.connections?.length
    ? status.connections
    : status.connection
      ? [status.connection]
      : [];
}

export function normalizeActiveScheduledRunSessionsResponse(response: unknown) {
  return extractList(response, "sessions").flatMap((value) => {
    const row = value as ActiveSessionRow;
    if (!row || typeof row !== "object") return [];
    if (!isActiveSessionStatus(row.status)) return [];
    const sessionId = activeSessionId(row);
    if (!sessionId || !scheduledRunJobId(sessionId)) return [];
    const timestamp = timestampString(
      row.last_active ??
        row.lastActive ??
        row.started_at ??
        row.startedAt ??
        Date.now(),
    );
    return [
      withScheduledRunDisplay({
        id: sessionId,
        active: true,
        source: SCHEDULED_RUN_SOURCE,
        status: statusString(row.status) ?? "running",
        title: stringValue(row.title),
        preview: stringValue(row.preview),
        started_at: timestamp,
        last_active: timestamp,
        message_count: numberValue(row.message_count),
      }),
    ];
  });
}

function activeSessionId(row: ActiveSessionRow) {
  return (
    stringValue(row.session_key) ??
    stringValue(row.sessionKey) ??
    stringValue(row.session_id) ??
    stringValue(row.sessionId) ??
    stringValue(row.id)
  );
}

function isActiveSessionStatus(value: unknown) {
  const status = statusString(value);
  return status !== "idle" && status !== "completed" && status !== "complete";
}

function statusString(value: unknown) {
  return stringValue(value)?.toLowerCase();
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

export function isRunningScheduledRunSession(session: HermesSessionInfo) {
  return isScheduledRunSession(session) && session.active === true;
}

export function mergeScheduledRunSessions(
  storedRuns: HermesSessionInfo[],
  activeRuns: HermesSessionInfo[],
) {
  const byId = new Map<string, HermesSessionInfo>();
  for (const run of storedRuns) {
    if (isScheduledRunSession(run)) byId.set(run.id, run);
  }
  for (const run of activeRuns) {
    if (!isScheduledRunSession(run)) continue;
    const stored = byId.get(run.id);
    byId.set(run.id, stored ? mergeScheduledRunSession(stored, run) : run);
  }
  return Array.from(byId.values()).sort((a, b) =>
    sessionTimestamp(b).localeCompare(sessionTimestamp(a)),
  );
}

function mergeScheduledRunSession(
  stored: HermesSessionInfo,
  active: HermesSessionInfo,
): HermesSessionInfo {
  const activeTimestamp = sessionTimestamp(active);
  const storedTimestamp = sessionTimestamp(stored);
  return withScheduledRunDisplay({
    ...stored,
    ...active,
    title: active.title?.trim() || stored.title,
    preview: active.preview?.trim() || stored.preview,
    started_at: active.started_at ?? stored.started_at,
    last_active:
      activeTimestamp.localeCompare(storedTimestamp) > 0
        ? activeTimestamp
        : storedTimestamp,
    message_count: active.message_count ?? stored.message_count,
  });
}

/** A scheduled run's first message is the routine prompt wrapped in a machine
 * delivery preamble the cron runner injects: `[IMPORTANT: You are running as a
 * scheduled cron job. … nothing more.]`. Recognized by that exact opener so a
 * user message that merely starts with "[IMPORTANT" is never mistaken for it. */
export function isScheduledRunPreamble(content: string) {
  return /^\s*\[IMPORTANT:\s*You are running as a scheduled cron job\.?/i.test(
    content,
  );
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

/** Gives a scheduled-run session a readable title and a clean preview when the
 * stored ones are empty or still the raw delivery preamble, so every list
 * surface stops showing "[IMPORTANT…". Non-cron sessions pass through. */
function withScheduledRunDisplay(
  session: HermesSessionInfo,
): HermesSessionInfo {
  if (!isScheduledRunSession(session)) return session;
  const cleanedPreview = stripScheduledRunPreamble(session.preview ?? "");
  const storedTitle = session.title?.trim() ?? "";
  // Replace the stored title when it's empty or is the cron scaffolding — a
  // stored title is often truncated ("[IMPORTANT: You are running as"), so a
  // leading "[IMPORTANT" is enough to treat it as raw here, where we already
  // know this is a cron session.
  const looksRaw = !storedTitle || /^\[IMPORTANT\b/i.test(storedTitle);
  const title = looksRaw ? titleFromPrompt(cleanedPreview) : storedTitle;
  return { ...session, title, preview: cleanedPreview || session.preview };
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

function uniqueBy<T>(items: T[], key: (item: T) => string) {
  const seen = new Set<string>();
  const unique: T[] = [];
  for (const item of items) {
    const value = key(item);
    if (seen.has(value)) continue;
    seen.add(value);
    unique.push(item);
  }
  return unique;
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
