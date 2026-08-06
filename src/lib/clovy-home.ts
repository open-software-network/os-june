export const CLOVY_HOME_SESSION_IDS_STORAGE_KEY = "clovy:home:session-ids:v1";
export const CLOVY_HOME_CHECK_INS_STORAGE_KEY = "clovy:home:check-ins:v1";
export const CLOVY_HOME_TASK_HANDOFFS_STORAGE_KEY = "clovy:home:task-handoffs:v1";
export const CLOVY_HOME_DIRECT_TURNS_STORAGE_KEY = "clovy:home:direct-turns:v1";
export const LEGACY_CLOVY_HOME_TASK_HANDOFFS_STORAGE_KEY = "clovy.home.taskHandoffs.v1";
export const LEGACY_CLOVY_HOME_DIRECT_TURNS_STORAGE_KEY = "clovy.home.directTurns.v1";
export const CLOVY_HOME_THREAD_CHANGED_EVENT = "clovy:agent:home-thread-changed";

const homeThreadRetargets = new Map<string, string | null>();

export const CLOVY_HOME_CONTEXT_OPEN = "[Clovy home context]";
export const CLOVY_HOME_CONTEXT_CLOSE = "[/Clovy home context]";
const LEGACY_CLOVY_HOME_CONTEXT_OPEN = "[June home context]";
const LEGACY_CLOVY_HOME_CONTEXT_CLOSE = "[/June home context]";
const CLOVY_HOME_CONTEXT_MARKERS = [
  [CLOVY_HOME_CONTEXT_OPEN, CLOVY_HOME_CONTEXT_CLOSE],
  [LEGACY_CLOVY_HOME_CONTEXT_OPEN, LEGACY_CLOVY_HOME_CONTEXT_CLOSE],
] as const;

export type ClovyHomeTaskRequest = {
  title: string;
  prompt: string;
  summary?: string;
  requiresCurrentResearch?: boolean;
};

export type ClovyHomeConversationMessage = {
  role: "user" | "assistant";
  content: string;
  createdAt?: string;
};

export type ClovyHomeConversationContext = {
  recentMessages: Array<Pick<ClovyHomeConversationMessage, "role" | "content">>;
  earlierContext?: string;
};

const HOME_RECENT_MESSAGE_LIMIT = 80;
const HOME_RECENT_CHARACTER_LIMIT = 48_000;
const HOME_EARLIER_EXCERPT_LIMIT = 24;
const HOME_EARLIER_EXCERPT_CHARACTER_LIMIT = 12_000;
const HOME_EARLIER_MESSAGE_CHARACTER_LIMIT = 600;
const HOME_CONTEXT_STOP_WORDS = new Set([
  "about",
  "after",
  "again",
  "also",
  "because",
  "been",
  "before",
  "could",
  "from",
  "have",
  "just",
  "like",
  "more",
  "that",
  "their",
  "them",
  "there",
  "these",
  "they",
  "this",
  "those",
  "what",
  "when",
  "where",
  "which",
  "with",
  "would",
  "your",
]);

function homeContextTerms(content: string): Set<string> {
  return new Set(
    content
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(
        (term) => term.length >= 3 && !HOME_CONTEXT_STOP_WORDS.has(term) && !/^\d+$/.test(term),
      ),
  );
}

function homeExcerptLine(message: ClovyHomeConversationMessage): string {
  const characters = Array.from(message.content);
  const excerpt = characters.slice(0, HOME_EARLIER_MESSAGE_CHARACTER_LIMIT).join("");
  const truncated =
    characters.length > HOME_EARLIER_MESSAGE_CHARACTER_LIMIT
      ? `${excerpt.trimEnd()}...`
      : excerpt.trimEnd();
  const date = /^\d{4}-\d{2}-\d{2}/.exec(message.createdAt ?? "")?.[0];
  return `${date ? `${date} ` : ""}${message.role === "user" ? "User" : "Clovy"}: ${truncated}`;
}

function earlierHomeExcerpt(
  messages: ClovyHomeConversationMessage[],
  latestUserMessage: string,
): string | undefined {
  if (!messages.length) return undefined;

  const selected = new Set<number>();
  const addWithNeighbor = (index: number) => {
    if (index < 0 || index >= messages.length || selected.size >= HOME_EARLIER_EXCERPT_LIMIT)
      return;
    selected.add(index);
    if (selected.size >= HOME_EARLIER_EXCERPT_LIMIT) return;
    const neighbor = messages[index].role === "user" ? index + 1 : index - 1;
    if (neighbor >= 0 && neighbor < messages.length) selected.add(neighbor);
  };

  const currentTerms = homeContextTerms(latestUserMessage);
  const relevant = messages
    .map((message, index) => {
      const overlap = [...homeContextTerms(message.content)].filter((term) =>
        currentTerms.has(term),
      ).length;
      const preference =
        message.role === "user" &&
        /\b(?:i prefer|i usually|keep that in mind|remember|my favorite|works best for me)\b/i.test(
          message.content,
        )
          ? 1
          : 0;
      return { index, score: overlap * 100 + preference * 20 + index / messages.length };
    })
    .filter((candidate) => candidate.score >= 20)
    .sort((left, right) => right.score - left.score);
  for (const candidate of relevant.slice(0, 8)) addWithNeighbor(candidate.index);

  for (
    let index = messages.length - 1;
    index >= 0 && selected.size < HOME_EARLIER_EXCERPT_LIMIT - 4;
    index -= 1
  ) {
    addWithNeighbor(index);
  }

  const userIndices = messages
    .map((message, index) => (message.role === "user" ? index : -1))
    .filter((index) => index >= 0);
  const sampleCount = Math.min(4, userIndices.length);
  for (let sample = 0; sample < sampleCount; sample += 1) {
    const at =
      sampleCount === 1
        ? userIndices.length - 1
        : Math.round((sample * (userIndices.length - 1)) / (sampleCount - 1));
    addWithNeighbor(userIndices[at]);
  }

  const lines: string[] = [];
  let characters = 0;
  for (const index of [...selected].sort((left, right) => left - right)) {
    const line = homeExcerptLine(messages[index]);
    const lineCharacters = Array.from(line).length;
    if (characters + lineCharacters > HOME_EARLIER_EXCERPT_CHARACTER_LIMIT) break;
    lines.push(line);
    characters += lineCharacters;
  }
  return lines.length ? lines.join("\n") : undefined;
}

export function buildClovyHomeConversationContext(
  messages: ReadonlyArray<ClovyHomeConversationMessage>,
): ClovyHomeConversationContext {
  const normalized = messages
    .map((message, sourceIndex) => ({
      ...message,
      sourceIndex,
      content: message.content.trim(),
    }))
    .filter((message) => message.content);
  if (!normalized.length) return { recentMessages: [] };

  const retained: typeof normalized = [];
  let retainedCharacters = 0;
  for (let index = normalized.length - 1; index >= 0; index -= 1) {
    const message = normalized[index];
    const characters = Array.from(message.content).length;
    if (
      retained.length > 0 &&
      (retained.length >= HOME_RECENT_MESSAGE_LIMIT ||
        retainedCharacters + characters > HOME_RECENT_CHARACTER_LIMIT)
    ) {
      break;
    }
    retained.push(message);
    retainedCharacters += characters;
  }
  retained.reverse();
  while (retained[0]?.role === "assistant") retained.shift();

  const recentStart = retained[0]?.sourceIndex ?? normalized.length;
  const recentMessages = retained.map(({ role, content }) => ({ role, content }));
  const latestUserMessage =
    [...recentMessages].reverse().find((message) => message.role === "user")?.content ?? "";
  const earlierContext = earlierHomeExcerpt(
    normalized.slice(0, recentStart).map(({ role, content, createdAt }) => ({
      role,
      content,
      createdAt,
    })),
    latestUserMessage,
  );
  return {
    recentMessages,
    ...(earlierContext ? { earlierContext } : {}),
  };
}

export type ClovyHomeCheckIn = {
  createdAt: string;
  text: string;
};

type HomeCheckInRecord = {
  date: string;
  createdAt: string;
};

function storageOrUndefined(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

function readUnknownMap(key: string): Record<string, unknown> {
  try {
    const raw = storageOrUndefined()?.getItem(key);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function readStringMap(key: string): Record<string, string> {
  return Object.fromEntries(
    Object.entries(readUnknownMap(key)).filter((entry): entry is [string, string] => {
      return typeof entry[1] === "string";
    }),
  );
}

function writeJson(key: string, value: unknown): void {
  try {
    storageOrUndefined()?.setItem(key, JSON.stringify(value));
  } catch {
    // Home remains usable for this launch when storage is unavailable.
  }
}

export function readClovyHomeStoredSessionId(profile: string): string | undefined {
  const storedSessionId = readStringMap(CLOVY_HOME_SESSION_IDS_STORAGE_KEY)[profile]?.trim();
  return storedSessionId || undefined;
}

export function writeClovyHomeStoredSessionId(profile: string, storedSessionId: string): void {
  const normalizedProfile = profile.trim() || "default";
  const normalizedSessionId = storedSessionId.trim();
  if (!normalizedSessionId) return;
  // An explicit new profile mapping reactivates this id. This matters when a
  // test fixture or repaired prerelease database deliberately reuses an id
  // that was retired earlier in the same WebView process.
  homeThreadRetargets.delete(normalizedSessionId);
  writeJson(CLOVY_HOME_SESSION_IDS_STORAGE_KEY, {
    ...readStringMap(CLOVY_HOME_SESSION_IDS_STORAGE_KEY),
    [normalizedProfile]: normalizedSessionId,
  });
}

/** Resolve writes owned by an in-flight Home request after its profile was
 * moved or deleted. Moving redirects the late assistant reply into the merged
 * thread; permanent deletion drops it instead of recreating private data. */
export function resolveClovyHomeThreadSessionId(storedSessionId: string): string | undefined {
  let current = storedSessionId;
  const visited = new Set<string>();
  while (!visited.has(current) && homeThreadRetargets.has(current)) {
    visited.add(current);
    const target = homeThreadRetargets.get(current);
    if (!target) return undefined;
    current = target;
  }
  return current;
}

export function retargetClovyHomeThread(sourceSessionId: string, targetSessionId?: string): void {
  const source = sourceSessionId.trim();
  const target = targetSessionId?.trim();
  if (!source || source === target) return;
  homeThreadRetargets.set(source, target || null);
}

export function forgetClovyHomeStoredSessionId(
  profile: string,
  expectedStoredSessionId?: string,
): void {
  const records = readStringMap(CLOVY_HOME_SESSION_IDS_STORAGE_KEY);
  if (expectedStoredSessionId && records[profile] !== expectedStoredSessionId) return;
  if (!(profile in records)) return;
  delete records[profile];
  writeJson(CLOVY_HOME_SESSION_IDS_STORAGE_KEY, records);
}

export function dispatchClovyHomeThreadChanged(storedSessionId: string): void {
  window.dispatchEvent(
    new CustomEvent<{ storedSessionId: string }>(CLOVY_HOME_THREAD_CHANGED_EVENT, {
      detail: { storedSessionId },
    }),
  );
}

function mergedHomeArray(left: unknown, right: unknown): unknown[] {
  const values = [...(Array.isArray(left) ? left : []), ...(Array.isArray(right) ? right : [])];
  const byId = new Map<string, unknown>();
  const withoutId: unknown[] = [];
  for (const value of values) {
    const id =
      value && typeof value === "object" && !Array.isArray(value) && "id" in value
        ? (value as { id?: unknown }).id
        : undefined;
    if (typeof id === "string") byId.set(id, value);
    else withoutId.push(value);
  }
  return [...withoutId, ...byId.values()].sort((leftValue, rightValue) => {
    const createdAt = (value: unknown) =>
      value && typeof value === "object" && !Array.isArray(value) && "createdAt" in value
        ? String((value as { createdAt?: unknown }).createdAt ?? "")
        : "";
    const leftCreatedAt = createdAt(leftValue);
    const rightCreatedAt = createdAt(rightValue);
    return leftCreatedAt && rightCreatedAt ? leftCreatedAt.localeCompare(rightCreatedAt) : 0;
  });
}

function reconcileHomeThreadStore(
  storageKey: string,
  sourceSessionId: string,
  targetSessionId: string | undefined,
): void {
  const records = readUnknownMap(storageKey);
  if (!(sourceSessionId in records)) return;
  if (targetSessionId && targetSessionId !== sourceSessionId) {
    records[targetSessionId] = mergedHomeArray(records[targetSessionId], records[sourceSessionId]);
  }
  if (targetSessionId !== sourceSessionId) delete records[sourceSessionId];
  writeJson(storageKey, records);
}

export type ClovyHomeProfileRemovalPlan = {
  sourceSessionId?: string;
  targetSessionId?: string;
  redundantSessionId?: string;
};

export function clovyHomeProfileRemovalPlan(
  profile: string,
  disposition: "move" | "delete",
): ClovyHomeProfileRemovalPlan {
  const normalizedProfile = profile.trim();
  if (!normalizedProfile || normalizedProfile === "default") return {};
  const sessionIds = readStringMap(CLOVY_HOME_SESSION_IDS_STORAGE_KEY);
  const sourceSessionId = sessionIds[normalizedProfile]?.trim();
  const targetSessionId =
    disposition === "move" ? sessionIds.default?.trim() || sourceSessionId : undefined;
  return {
    ...(sourceSessionId ? { sourceSessionId } : {}),
    ...(targetSessionId ? { targetSessionId } : {}),
    ...(disposition === "move" && sourceSessionId && targetSessionId !== sourceSessionId
      ? { redundantSessionId: sourceSessionId }
      : {}),
  };
}

export function reconcileClovyHomeProfileRemoval(
  profile: string,
  disposition: "move" | "delete",
): ClovyHomeProfileRemovalPlan {
  const normalizedProfile = profile.trim();
  if (!normalizedProfile || normalizedProfile === "default") return {};

  const sessionIds = readStringMap(CLOVY_HOME_SESSION_IDS_STORAGE_KEY);
  const plan = clovyHomeProfileRemovalPlan(profile, disposition);
  const { sourceSessionId, targetSessionId } = plan;

  if (sourceSessionId) {
    retargetClovyHomeThread(sourceSessionId, targetSessionId);
    for (const storageKey of [
      CLOVY_HOME_DIRECT_TURNS_STORAGE_KEY,
      CLOVY_HOME_TASK_HANDOFFS_STORAGE_KEY,
      LEGACY_CLOVY_HOME_DIRECT_TURNS_STORAGE_KEY,
      LEGACY_CLOVY_HOME_TASK_HANDOFFS_STORAGE_KEY,
    ]) {
      reconcileHomeThreadStore(storageKey, sourceSessionId, targetSessionId);
    }
    if (targetSessionId) dispatchClovyHomeThreadChanged(targetSessionId);
  }

  delete sessionIds[normalizedProfile];
  if (disposition === "move" && targetSessionId) sessionIds.default = targetSessionId;
  writeJson(CLOVY_HOME_SESSION_IDS_STORAGE_KEY, sessionIds);

  const checkIns = readUnknownMap(CLOVY_HOME_CHECK_INS_STORAGE_KEY);
  if (disposition === "move" && !checkIns.default && checkIns[normalizedProfile]) {
    checkIns.default = checkIns[normalizedProfile];
  }
  delete checkIns[normalizedProfile];
  writeJson(CLOVY_HOME_CHECK_INS_STORAGE_KEY, checkIns);

  return plan;
}

export function withClovyHomeContext(prompt: string): string {
  const visiblePrompt = stripClovyHomeContext(prompt).trim();
  return [
    CLOVY_HOME_CONTEXT_OPEN,
    "This is Clovy's persistent Home conversation with the user.",
    "Keep quick answers, conversation, clarifying questions, and preference updates in Home.",
    "When a concrete request benefits from focused work or background execution, call the clovy_home start_task tool exactly once with a short title and a complete standalone prompt. Do not perform that focused task in Home after handing it off.",
    "After start_task returns, stop working on that task in Home. Reply with one short handoff acknowledgement only; the Home UI adds the session button. Never include findings, progress, or a second answer from the focused task in Home.",
    "A brief acknowledgement after a handoff, such as ok, thanks, sounds good, or got it, is conversation. It does not request another task or session.",
    CLOVY_HOME_CONTEXT_CLOSE,
    "",
    visiblePrompt,
  ].join("\n");
}

function normalizedHomeTaskPrompt(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export function withClovyHomeLatestTaskIntent(
  standalonePrompt: string,
  latestMessage: string,
): string {
  const resolvedTask = standalonePrompt.trim();
  const latestRequest = latestMessage.trim();
  if (!resolvedTask) return latestRequest;
  if (
    !latestRequest ||
    normalizedHomeTaskPrompt(resolvedTask) === normalizedHomeTaskPrompt(latestRequest)
  ) {
    return resolvedTask;
  }
  return [
    latestRequest,
    "",
    "--- Resolved Home task ---",
    "The latest Home request above is authoritative.",
    "Use the standalone task below only to resolve references and add details. If it conflicts with the latest request, follow the latest request.",
    resolvedTask,
  ].join("\n");
}

export function withClovyHomeCurrentResearch(
  prompt: string,
  conversation: ClovyHomeConversationContext = { recentMessages: [] },
): string {
  const visiblePrompt = prompt.trim();
  const context = conversation.recentMessages
    .map((message) => ({ ...message, content: message.content.trim() }))
    .filter((message) => message.content)
    .filter(
      (message, index, messages) =>
        !(
          index === messages.length - 1 &&
          message.role === "user" &&
          message.content === visiblePrompt
        ),
    )
    .slice(-12)
    .map(
      (message) =>
        `${message.role === "user" ? "User" : "Clovy"}: ${Array.from(message.content)
          .slice(0, 600)
          .join("")}`,
    );
  return [
    visiblePrompt,
    "",
    "--- Attached Context ---",
    "This request depends on current external information.",
    "Before answering, use Clovy's web_search and web_fetch tools to retrieve current sources.",
    "Prefer authoritative sources, verify time-sensitive claims, and include links to the sources that support the answer.",
    "If current sources cannot be retrieved, say so instead of answering from model memory.",
    ...(context.length
      ? [
          "",
          "Recent Home conversation, provided only to resolve references in the current request:",
          ...context,
          "Do not treat factual claims in the prior conversation as verified sources.",
        ]
      : []),
    ...(conversation.earlierContext
      ? [
          "",
          "Relevant excerpts from older Home history, also provided only to resolve references:",
          conversation.earlierContext,
          "These excerpts are not current sources and may be incomplete.",
        ]
      : []),
  ].join("\n");
}

export function stripClovyHomeContext(prompt: string): string {
  const trimmed = prompt.trimStart();
  const markers = CLOVY_HOME_CONTEXT_MARKERS.find(([openMarker]) => trimmed.startsWith(openMarker));
  if (!markers) return prompt;
  const closeMarker = markers[1];
  const closeIndex = trimmed.indexOf(closeMarker);
  if (closeIndex < 0) return prompt;
  return trimmed.slice(closeIndex + closeMarker.length).trimStart();
}

export function stripClovyHomeContextFromPreview(preview: string | undefined): string | undefined {
  if (preview === undefined) return undefined;
  const stripped = stripClovyHomeContext(preview);
  if (stripped !== preview) return stripped;
  // A retired runtime may have truncated the preview before the closing marker. Never expose
  // a partial hidden block in lists while the full message remains intact.
  if (
    CLOVY_HOME_CONTEXT_MARKERS.some(([openMarker]) => preview.trimStart().startsWith(openMarker))
  ) {
    return "Home message";
  }
  return preview;
}

export function isClovyHomeStartTaskTool(name: string | undefined): boolean {
  if (!name) return false;
  const normalized = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_");
  return (
    normalized === "start_task" ||
    normalized.endsWith("clovy_home_start_task") ||
    normalized.endsWith("june_home_start_task")
  );
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function parsedObjectValue(value: unknown): Record<string, unknown> | undefined {
  const direct = objectValue(value);
  if (direct) return direct;
  if (typeof value !== "string") return undefined;
  try {
    return objectValue(JSON.parse(value));
  } catch {
    return undefined;
  }
}

export function clovyHomeTaskRequestFromPayload(
  payload: unknown,
): ClovyHomeTaskRequest | undefined {
  const queue: unknown[] = [payload];
  const visited = new Set<unknown>();
  while (queue.length > 0) {
    const candidate = queue.shift();
    if (visited.has(candidate)) continue;
    visited.add(candidate);
    const value = parsedObjectValue(candidate);
    if (!value) continue;
    const title = typeof value.title === "string" ? value.title.trim() : "";
    const prompt = typeof value.prompt === "string" ? value.prompt.trim() : "";
    const summary = typeof value.summary === "string" ? value.summary.trim() : "";
    if (title && prompt) return { title, prompt, ...(summary ? { summary } : {}) };
    for (const key of [
      "arguments",
      "args",
      "input",
      "params",
      "request",
      "structuredContent",
      "structured_content",
      "result",
      "data",
      "output",
      "content",
      "text",
    ]) {
      const nested = value[key];
      if (Array.isArray(nested)) queue.push(...nested);
      else if (nested !== undefined) queue.push(nested);
    }
  }
  return undefined;
}

function localDateKey(now: Date): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** Local calendar-day key for a turn timestamp, or "" when unparseable, so the
 * Home transcript can detect day boundaries without inventing one for turns
 * whose timestamps are missing or malformed. */
export function clovyHomeDayKey(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return localDateKey(date);
}

/** Human day-boundary label for the Home thread ("Today at 2:45 PM",
 * "Yesterday at 9:04 AM", "Monday at 8:12 AM", "March 3 at 4:20 PM"). */
export function clovyHomeDayLabel(iso: string, now = new Date()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const time = date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const startOfDay = (value: Date) =>
    new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
  const dayDiff = Math.round((startOfDay(now) - startOfDay(date)) / 86_400_000);
  if (dayDiff <= 0) return `Today at ${time}`;
  if (dayDiff === 1) return `Yesterday at ${time}`;
  if (dayDiff < 7) return `${date.toLocaleDateString(undefined, { weekday: "long" })} at ${time}`;
  const sameYear = date.getFullYear() === now.getFullYear();
  const day = date.toLocaleDateString(
    undefined,
    sameYear
      ? { month: "long", day: "numeric" }
      : { month: "long", day: "numeric", year: "numeric" },
  );
  return `${day} at ${time}`;
}

/** The live greeting for the Home surface, derived from the CURRENT clock
 * (unlike the stored check-in, whose text is pinned to its creation time).
 * Early hours read as evening: "Good morning" at 00:37 feels wrong. */
export type ClovyHomeGreetingContext = {
  displayName?: string;
  returning?: boolean;
};

function firstNameFromDisplayName(displayName: string | undefined): string | undefined {
  return displayName?.trim().split(/\s+/)[0] || undefined;
}

export function clovyHomeGreetingParts(
  now = new Date(),
  context: ClovyHomeGreetingContext = {},
): {
  salutation: string;
  question: string;
} {
  const hour = now.getHours();
  const firstName = firstNameFromDisplayName(context.displayName);
  const personalized = (salutation: string) =>
    firstName ? `${salutation}, ${firstName}` : salutation;
  if (hour >= 5 && hour < 12) {
    return {
      salutation: personalized("Good morning"),
      question: context.returning
        ? "What should we pick up today?"
        : "What would you like help with today?",
    };
  }
  if (hour >= 12 && hour < 18) {
    return {
      salutation: personalized("Good afternoon"),
      question: context.returning
        ? "What should we pick up this afternoon?"
        : "What would you like help with this afternoon?",
    };
  }
  return {
    salutation: personalized("Good evening"),
    question: context.returning
      ? "What should we pick up this evening?"
      : "What would you like help with this evening?",
  };
}

/** Quiet first-step prompts that follow the user's local day without claiming
 * access to context Clovy has not actually loaded. */
export function clovyHomeNudgePrompts(now = new Date()): readonly string[] {
  const hour = now.getHours();
  if (hour >= 5 && hour < 12) {
    return ["Plan my day", "Think through a decision", "Help me get something done"];
  }
  if (hour >= 12 && hour < 18) {
    return ["Plan the rest of my day", "Work through a blocker", "Help me prioritize"];
  }
  return ["Review my day", "Plan tomorrow", "Think through a decision"];
}

function checkInText(now: Date): string {
  const greeting = clovyHomeGreetingParts(now);
  return `${greeting.salutation}. ${greeting.question}`;
}

export function clovyHomeDailyCheckIn(profile: string, now = new Date()): ClovyHomeCheckIn {
  let records: Record<string, HomeCheckInRecord> = {};
  try {
    const raw = storageOrUndefined()?.getItem(CLOVY_HOME_CHECK_INS_STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      records = parsed as Record<string, HomeCheckInRecord>;
    }
  } catch {
    records = {};
  }
  const date = localDateKey(now);
  const existing = records[profile];
  const createdAt =
    existing?.date === date && typeof existing.createdAt === "string"
      ? existing.createdAt
      : now.toISOString();
  if (existing?.date !== date || existing.createdAt !== createdAt) {
    writeJson(CLOVY_HOME_CHECK_INS_STORAGE_KEY, {
      ...records,
      [profile]: { date, createdAt },
    });
  }
  return { createdAt, text: checkInText(new Date(createdAt)) };
}
