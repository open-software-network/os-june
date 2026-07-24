const HOME_SESSION_IDS_STORAGE_KEY = "june:home:session-ids:v1";
const HOME_CHECK_INS_STORAGE_KEY = "june:home:check-ins:v1";

export const JUNE_HOME_CONTEXT_OPEN = "[June home context]";
export const JUNE_HOME_CONTEXT_CLOSE = "[/June home context]";

export type JuneHomeTaskRequest = {
  title: string;
  prompt: string;
  summary?: string;
  requiresCurrentResearch?: boolean;
};

export type JuneHomeConversationMessage = {
  role: "user" | "assistant";
  content: string;
  createdAt?: string;
};

export type JuneHomeConversationContext = {
  recentMessages: Array<Pick<JuneHomeConversationMessage, "role" | "content">>;
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

function homeExcerptLine(message: JuneHomeConversationMessage): string {
  const characters = Array.from(message.content);
  const excerpt = characters.slice(0, HOME_EARLIER_MESSAGE_CHARACTER_LIMIT).join("");
  const truncated =
    characters.length > HOME_EARLIER_MESSAGE_CHARACTER_LIMIT
      ? `${excerpt.trimEnd()}...`
      : excerpt.trimEnd();
  const date = /^\d{4}-\d{2}-\d{2}/.exec(message.createdAt ?? "")?.[0];
  return `${date ? `${date} ` : ""}${message.role === "user" ? "User" : "June"}: ${truncated}`;
}

function earlierHomeExcerpt(
  messages: JuneHomeConversationMessage[],
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

export function buildJuneHomeConversationContext(
  messages: ReadonlyArray<JuneHomeConversationMessage>,
): JuneHomeConversationContext {
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

export type JuneHomeCheckIn = {
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

function readStringMap(key: string): Record<string, string> {
  try {
    const raw = storageOrUndefined()?.getItem(key);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, string] => {
        return typeof entry[1] === "string";
      }),
    );
  } catch {
    return {};
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    storageOrUndefined()?.setItem(key, JSON.stringify(value));
  } catch {
    // Home remains usable for this launch when storage is unavailable.
  }
}

export function readJuneHomeStoredSessionId(profile: string): string | undefined {
  const storedSessionId = readStringMap(HOME_SESSION_IDS_STORAGE_KEY)[profile]?.trim();
  return storedSessionId || undefined;
}

export function writeJuneHomeStoredSessionId(profile: string, storedSessionId: string): void {
  const normalizedProfile = profile.trim() || "default";
  const normalizedSessionId = storedSessionId.trim();
  if (!normalizedSessionId) return;
  writeJson(HOME_SESSION_IDS_STORAGE_KEY, {
    ...readStringMap(HOME_SESSION_IDS_STORAGE_KEY),
    [normalizedProfile]: normalizedSessionId,
  });
}

export function forgetJuneHomeStoredSessionId(
  profile: string,
  expectedStoredSessionId?: string,
): void {
  const records = readStringMap(HOME_SESSION_IDS_STORAGE_KEY);
  if (expectedStoredSessionId && records[profile] !== expectedStoredSessionId) return;
  if (!(profile in records)) return;
  delete records[profile];
  writeJson(HOME_SESSION_IDS_STORAGE_KEY, records);
}

export function withJuneHomeContext(prompt: string): string {
  const visiblePrompt = stripJuneHomeContext(prompt).trim();
  return [
    JUNE_HOME_CONTEXT_OPEN,
    "This is June's persistent Home conversation with the user.",
    "Keep quick answers, conversation, clarifying questions, and preference updates in Home.",
    "When a concrete request benefits from focused work or background execution, call the june_home start_task tool exactly once with a short title and a complete standalone prompt. Do not perform that focused task in Home after handing it off.",
    "After start_task returns, stop working on that task in Home. Reply with one short handoff acknowledgement only; the Home UI adds the session button. Never include findings, progress, or a second answer from the focused task in Home.",
    JUNE_HOME_CONTEXT_CLOSE,
    "",
    visiblePrompt,
  ].join("\n");
}

export function withJuneHomeCurrentResearch(
  prompt: string,
  conversation: JuneHomeConversationContext = { recentMessages: [] },
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
        `${message.role === "user" ? "User" : "June"}: ${Array.from(message.content)
          .slice(0, 600)
          .join("")}`,
    );
  return [
    visiblePrompt,
    "",
    "--- Attached Context ---",
    "This request depends on current external information.",
    "Before answering, use June's web_search and web_fetch tools to retrieve current sources.",
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

export function stripJuneHomeContext(prompt: string): string {
  const trimmed = prompt.trimStart();
  if (!trimmed.startsWith(JUNE_HOME_CONTEXT_OPEN)) return prompt;
  const closeIndex = trimmed.indexOf(JUNE_HOME_CONTEXT_CLOSE);
  if (closeIndex < 0) return prompt;
  return trimmed.slice(closeIndex + JUNE_HOME_CONTEXT_CLOSE.length).trimStart();
}

export function stripJuneHomeContextFromPreview(preview: string | undefined): string | undefined {
  if (preview === undefined) return undefined;
  const stripped = stripJuneHomeContext(preview);
  if (stripped !== preview) return stripped;
  // Hermes may truncate the preview before the closing marker. Never expose
  // a partial hidden block in lists while the full message remains intact.
  if (preview.trimStart().startsWith(JUNE_HOME_CONTEXT_OPEN)) return "Home message";
  return preview;
}

export function isJuneHomeStartTaskTool(name: string | undefined): boolean {
  if (!name) return false;
  const normalized = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_");
  return normalized === "start_task" || normalized.endsWith("june_home_start_task");
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

export function juneHomeTaskRequestFromPayload(payload: unknown): JuneHomeTaskRequest | undefined {
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
export function juneHomeDayKey(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return localDateKey(date);
}

/** Human day-boundary label for the Home thread ("Today at 2:45 PM",
 * "Yesterday at 9:04 AM", "Monday at 8:12 AM", "March 3 at 4:20 PM"). */
export function juneHomeDayLabel(iso: string, now = new Date()): string {
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
export type JuneHomeGreetingContext = {
  displayName?: string;
  returning?: boolean;
};

function firstNameFromDisplayName(displayName: string | undefined): string | undefined {
  return displayName?.trim().split(/\s+/)[0] || undefined;
}

export function juneHomeGreetingParts(
  now = new Date(),
  context: JuneHomeGreetingContext = {},
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
 * access to context June has not actually loaded. */
export function juneHomeNudgePrompts(now = new Date()): readonly string[] {
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
  const greeting = juneHomeGreetingParts(now);
  return `${greeting.salutation}. ${greeting.question}`;
}

export function juneHomeDailyCheckIn(profile: string, now = new Date()): JuneHomeCheckIn {
  let records: Record<string, HomeCheckInRecord> = {};
  try {
    const raw = storageOrUndefined()?.getItem(HOME_CHECK_INS_STORAGE_KEY);
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
    writeJson(HOME_CHECK_INS_STORAGE_KEY, {
      ...records,
      [profile]: { date, createdAt },
    });
  }
  return { createdAt, text: checkInText(new Date(createdAt)) };
}
