const HOME_SESSION_IDS_STORAGE_KEY = "june:home:session-ids:v1";
const HOME_CHECK_INS_STORAGE_KEY = "june:home:check-ins:v1";

export const JUNE_HOME_CONTEXT_OPEN = "[June home context]";
export const JUNE_HOME_CONTEXT_CLOSE = "[/June home context]";

export type JuneHomeTaskRequest = {
  title: string;
  prompt: string;
  summary?: string;
};

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

export function readJuneHomeSessionId(profile: string): string | undefined {
  const sessionId = readStringMap(HOME_SESSION_IDS_STORAGE_KEY)[profile]?.trim();
  return sessionId || undefined;
}

export function writeJuneHomeSessionId(profile: string, sessionId: string): void {
  const normalizedProfile = profile.trim() || "default";
  const normalizedSessionId = sessionId.trim();
  if (!normalizedSessionId) return;
  writeJson(HOME_SESSION_IDS_STORAGE_KEY, {
    ...readStringMap(HOME_SESSION_IDS_STORAGE_KEY),
    [normalizedProfile]: normalizedSessionId,
  });
}

export function forgetJuneHomeSessionId(profile: string, expectedSessionId?: string): void {
  const records = readStringMap(HOME_SESSION_IDS_STORAGE_KEY);
  if (expectedSessionId && records[profile] !== expectedSessionId) return;
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
    JUNE_HOME_CONTEXT_CLOSE,
    "",
    visiblePrompt,
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
  const normalized = name.trim().toLowerCase().replace(/[.:/]/g, "_");
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

function checkInText(now: Date): string {
  const hour = now.getHours();
  if (hour < 12) return "Good morning. What would make today feel lighter?";
  if (hour < 18) return "Good afternoon. Is there anything you want me to take off your plate?";
  return "Good evening. Want to wrap anything up before the day ends?";
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
