/**
 * Per-session record of settled title edits. Keyed by stored session id (not
 * runtime session id) because June's session list and persistence use the
 * durable id, while live Hermes processes may resume under a different
 * runtime id. Absence means auto-titling is allowed, so sessions from before
 * this record existed fall back to the safe default.
 *
 * localStorage (not the backend) because the runtime's session store is
 * machine-local too, and the map must be readable synchronously before the
 * title suggester decides whether a loaded title is replaceable.
 */

const STORAGE_KEY = "june.agent.manuallyTitledSessions";
let volatileStore: Record<string, AgentSessionSettledTitleKind> = {};

export type AgentSessionSettledTitleKind = "manual" | "exchange" | "rejected" | "rejected-final";

const ASSISTANT_DIALOGUE_PREFIXES = [
  "i'm sorry",
  "i am sorry",
  "i'm unable",
  "i am unable",
  "i can't",
  "i cannot",
  "i won't",
  "i don't",
  "i do not",
  "i found",
  "i fixed",
  "i updated",
  "i created",
  "i completed",
  "i finished",
  "i wrote",
  "i added",
  "i removed",
  "i changed",
  "i checked",
  "i reviewed",
  "i traced",
  "sorry",
  "as an ai",
  "sure",
  "certainly",
  "of course",
  "here's",
  "here is",
  "here are",
  "unable to help",
  "unable to assist",
  "unable to comply",
] as const;

const QUESTION_WORDS = new Set(["who", "what", "when", "where", "why", "how"]);
const QUESTION_AUXILIARIES = new Set([
  "could",
  "would",
  "should",
  "do",
  "does",
  "did",
  "is",
  "are",
  "am",
  "have",
  "has",
  "was",
  "were",
  "had",
  "must",
  "shall",
  "can't",
  "couldn't",
  "wouldn't",
  "shouldn't",
  "don't",
  "doesn't",
  "didn't",
  "isn't",
  "aren't",
  "won't",
  "haven't",
  "hasn't",
  "wasn't",
  "weren't",
  "mustn't",
  "shan't",
]);
const AMBIGUOUS_QUESTION_AUXILIARIES = new Set(["can", "will", "may", "might"]);
const QUESTION_SUBJECTS = new Set([
  "i",
  "you",
  "we",
  "he",
  "she",
  "it",
  "they",
  "this",
  "that",
  "these",
  "those",
  "there",
  "the",
  "a",
  "an",
  "my",
  "your",
  "our",
  "his",
  "her",
  "their",
]);
function startsWithPhrase(value: string, phrase: string) {
  if (!value.startsWith(phrase)) return false;
  const next = value[phrase.length];
  return next === undefined || /[\s,:;.!]/.test(next);
}

export function isRefusalLikeAgentSessionTitle(value: unknown): boolean {
  if (typeof value !== "string" || !value.trim()) return false;
  const normalized = value.trim().replace(/[‘’]/g, "'").toLowerCase();
  if (ASSISTANT_DIALOGUE_PREFIXES.some((prefix) => startsWithPhrase(normalized, prefix))) {
    return true;
  }
  return /\b(?:can't|cannot)\s+(?:help|assist)\b/.test(normalized);
}

/** Whether model output is safe to use as a concise session title. */
export function isAgentSessionTitleCandidate(value: unknown): value is string {
  if (typeof value !== "string" || !value.trim()) return false;
  const normalized = value.trim().replace(/[‘’]/g, "'").toLowerCase();
  if (normalized.includes("?") || isRefusalLikeAgentSessionTitle(normalized)) return false;
  const [first = "", second = ""] = normalized.match(/[a-z']+/g) ?? [];
  const isHowToTitle = first === "how" && second === "to";
  return !(
    first === "which" ||
    (QUESTION_WORDS.has(first) && !isHowToTitle) ||
    QUESTION_AUXILIARIES.has(first) ||
    (AMBIGUOUS_QUESTION_AUXILIARIES.has(first) && QUESTION_SUBJECTS.has(second))
  );
}

function readStore(): Record<string, AgentSessionSettledTitleKind> {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...volatileStore };
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ...volatileStore };
    }
    const store: Record<string, AgentSessionSettledTitleKind> = {};
    for (const [sessionId, value] of Object.entries(parsed)) {
      if (value === true || value === "manual") {
        store[sessionId] = "manual";
      } else if (value === "exchange" || value === "rejected" || value === "rejected-final") {
        store[sessionId] = value;
      }
    }
    return { ...store, ...volatileStore };
  } catch {
    return { ...volatileStore };
  }
}

function writeStore(store: Record<string, AgentSessionSettledTitleKind>) {
  try {
    if (Object.keys(store).length === 0) {
      window.localStorage.removeItem(STORAGE_KEY);
      volatileStore = {};
      return;
    }
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
    volatileStore = {};
  } catch {
    // Keep the decision for this app process so a storage failure cannot turn
    // deterministic rejection into a repeated metered request loop.
    volatileStore = { ...store };
  }
}

/** Why this session's title is settled, or null when auto-titling is allowed. */
export function sessionSettledTitleKind(
  sessionId: string | undefined,
): AgentSessionSettledTitleKind | null {
  if (!sessionId) return null;
  return readStore()[sessionId] ?? null;
}

export function rememberSessionManuallyTitled(sessionId: string) {
  const store = readStore();
  store[sessionId] = "manual";
  writeStore(store);
}

export function rememberSessionExchangeTitled(sessionId: string) {
  const store = readStore();
  if (store[sessionId] === "manual") return;
  store[sessionId] = "exchange";
  writeStore(store);
}

export function rememberSessionTitleRejected(sessionId: string, final = false) {
  const store = readStore();
  if (store[sessionId] === "manual" || store[sessionId] === "exchange") return;
  store[sessionId] = final ? "rejected-final" : "rejected";
  writeStore(store);
}

export function resetAgentSessionTitleVolatileStoreForTest() {
  volatileStore = {};
}
