import type { AgentChatPart, AgentChatTurn } from "../../lib/agent-chat-runtime";
import { getCurrentDataPartitionName } from "../../lib/data-partition";
import {
  buildClovyHomeConversationContext,
  dispatchClovyHomeThreadChanged,
  forgetClovyHomeStoredSessionId,
  isClovyHomeStartTaskTool,
  CLOVY_HOME_DIRECT_TURNS_STORAGE_KEY,
  CLOVY_HOME_TASK_HANDOFFS_STORAGE_KEY,
  LEGACY_CLOVY_HOME_DIRECT_TURNS_STORAGE_KEY,
  LEGACY_CLOVY_HOME_TASK_HANDOFFS_STORAGE_KEY,
  readClovyHomeStoredSessionId,
  resolveClovyHomeThreadSessionId,
  stripClovyHomeContextFromPreview,
  type ClovyHomeConversationContext,
  type ClovyHomeTaskRequest,
  writeClovyHomeStoredSessionId,
} from "../../lib/clovy-home";
import type { ClovyHomeChatResponse } from "../../lib/tauri";

export type HomeTaskHandoff = ClovyHomeTaskRequest & {
  id: string;
  status: "starting" | "running" | "failed";
  storedSessionId?: string;
  sourceUserTurnId?: string;
  error?: string;
  profile?: string;
  attachments?: string[];
};

export const HOME_DEMO_SEEDED_EVENT = "clovy:agent:home-demo-seeded";
const HOME_DEMO_BACKUP_STORAGE_KEY = "clovy:home:demo-backup:v3";
const LEGACY_HOME_DEMO_BACKUP_STORAGE_KEY = "clovy.home.demoBackup.v3";

const LEGACY_HOME_STORAGE_KEYS: Partial<Record<string, string>> = {
  [CLOVY_HOME_TASK_HANDOFFS_STORAGE_KEY]: LEGACY_CLOVY_HOME_TASK_HANDOFFS_STORAGE_KEY,
  [CLOVY_HOME_DIRECT_TURNS_STORAGE_KEY]: LEGACY_CLOVY_HOME_DIRECT_TURNS_STORAGE_KEY,
  [HOME_DEMO_BACKUP_STORAGE_KEY]: LEGACY_HOME_DEMO_BACKUP_STORAGE_KEY,
};

const activeHomeTaskHandoffs = new Set<string>();

function activeHomeTaskHandoffKey(storedSessionId: string, handoffId: string): string {
  return `${resolveClovyHomeThreadSessionId(storedSessionId) ?? storedSessionId}:${handoffId}`;
}

export function markHomeTaskHandoffActive(storedSessionId: string, handoffId: string) {
  activeHomeTaskHandoffs.add(activeHomeTaskHandoffKey(storedSessionId, handoffId));
}

export function clearHomeTaskHandoffActive(storedSessionId: string, handoffId: string) {
  activeHomeTaskHandoffs.delete(activeHomeTaskHandoffKey(storedSessionId, handoffId));
}

function parseRecord(value: string | null): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value ?? "{}") as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function readRecord(storageKey: string): Record<string, unknown> {
  const current = parseRecord(window.localStorage.getItem(storageKey));
  const legacyStorageKey = LEGACY_HOME_STORAGE_KEYS[storageKey];
  if (!legacyStorageKey) return current;
  const legacy = parseRecord(window.localStorage.getItem(legacyStorageKey));
  if (Object.keys(legacy).length === 0) return current;
  const migrated = { ...legacy, ...current };
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(migrated));
    window.localStorage.removeItem(legacyStorageKey);
  } catch {
    // Keep reading the merged value for this launch if migration cannot persist.
  }
  return migrated;
}

function writeRecord(storageKey: string, value: Record<string, unknown>) {
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(value));
  } catch {
    // Home stays usable for this launch when browser storage is unavailable.
  }
}

function validHomeTurn(value: unknown): value is AgentChatTurn {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const turn = value as AgentChatTurn;
  return (
    typeof turn.id === "string" &&
    (turn.role === "user" || turn.role === "assistant") &&
    typeof turn.createdAt === "string" &&
    Array.isArray(turn.parts)
  );
}

export function readHomeDirectTurns(storedSessionId: string | undefined): AgentChatTurn[] {
  const activeSessionId = storedSessionId
    ? resolveClovyHomeThreadSessionId(storedSessionId)
    : undefined;
  if (!activeSessionId) return [];
  const turns = readRecord(CLOVY_HOME_DIRECT_TURNS_STORAGE_KEY)[activeSessionId];
  return Array.isArray(turns) ? turns.filter(validHomeTurn) : [];
}

export function persistHomeDirectTurns(storedSessionId: string, turns: AgentChatTurn[]) {
  const activeSessionId = resolveClovyHomeThreadSessionId(storedSessionId);
  if (!activeSessionId) return;
  const records = readRecord(CLOVY_HOME_DIRECT_TURNS_STORAGE_KEY);
  // The relationship thread is intentionally long-lived. Keep all turns while
  // storage permits it, then retain the deepest viable recent tail.
  const candidates = [turns, turns.slice(-2000), turns.slice(-1000), turns.slice(-400)];
  const attemptedLengths = new Set<number>();
  for (const candidate of candidates) {
    if (attemptedLengths.has(candidate.length)) continue;
    attemptedLengths.add(candidate.length);
    try {
      window.localStorage.setItem(
        CLOVY_HOME_DIRECT_TURNS_STORAGE_KEY,
        JSON.stringify({ ...records, [activeSessionId]: candidate }),
      );
      dispatchClovyHomeThreadChanged(activeSessionId);
      return;
    } catch {
      // Try the next smaller durable tail.
    }
  }
}

export function insertHomeDirectReply(
  storedSessionId: string,
  userTurnId: string,
  assistantTurn: AgentChatTurn,
): AgentChatTurn[] {
  const turns = readHomeDirectTurns(storedSessionId);
  const userIndex = turns.findIndex((turn) => turn.id === userTurnId);
  const next =
    userIndex < 0
      ? [...turns, assistantTurn]
      : [...turns.slice(0, userIndex + 1), assistantTurn, ...turns.slice(userIndex + 1)];
  persistHomeDirectTurns(storedSessionId, next);
  return next;
}

export function readHomeTaskHandoffs(storedSessionId: string | undefined): HomeTaskHandoff[] {
  const activeSessionId = storedSessionId
    ? resolveClovyHomeThreadSessionId(storedSessionId)
    : undefined;
  if (!activeSessionId) return [];
  const values = readRecord(CLOVY_HOME_TASK_HANDOFFS_STORAGE_KEY)[activeSessionId];
  if (!Array.isArray(values)) return [];
  return values
    .map((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return value;
      const legacy = value as Record<string, unknown>;
      if (typeof legacy.sessionId !== "string" || typeof legacy.storedSessionId === "string") {
        return value;
      }
      const { sessionId, ...rest } = legacy;
      return { ...rest, storedSessionId: sessionId };
    })
    .filter((value): value is HomeTaskHandoff => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return false;
      const handoff = value as HomeTaskHandoff;
      return (
        typeof handoff.id === "string" &&
        typeof handoff.title === "string" &&
        typeof handoff.prompt === "string" &&
        (handoff.status === "starting" ||
          handoff.status === "running" ||
          handoff.status === "failed") &&
        (handoff.profile === undefined || typeof handoff.profile === "string") &&
        (handoff.sourceUserTurnId === undefined || typeof handoff.sourceUserTurnId === "string") &&
        (handoff.attachments === undefined ||
          (Array.isArray(handoff.attachments) &&
            handoff.attachments.every((path) => typeof path === "string"))) &&
        (handoff.status !== "running" || typeof handoff.storedSessionId === "string")
      );
    });
}

export function readAllHomeTaskHandoffAttachments(): string[] {
  const attachments: string[] = [];
  for (const handoffs of Object.values(readRecord(CLOVY_HOME_TASK_HANDOFFS_STORAGE_KEY))) {
    if (!Array.isArray(handoffs)) continue;
    for (const value of handoffs) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const handoff = value as Record<string, unknown>;
      if (handoff.status !== "starting" && handoff.status !== "failed") continue;
      const paths = handoff.attachments;
      if (!Array.isArray(paths)) continue;
      attachments.push(...paths.filter((path): path is string => typeof path === "string"));
    }
  }
  return attachments;
}

export function persistHomeTaskHandoffs(storedSessionId: string, handoffs: HomeTaskHandoff[]) {
  const activeSessionId = resolveClovyHomeThreadSessionId(storedSessionId);
  if (!activeSessionId) return;
  const records = readRecord(CLOVY_HOME_TASK_HANDOFFS_STORAGE_KEY);
  // Handoffs back every visible task card in the long-lived transcript. Keep
  // the full set when storage permits, then degrade in lockstep-sized tails
  // instead of silently dropping every card after the newest 24.
  const candidates = [handoffs, handoffs.slice(-2000), handoffs.slice(-1000), handoffs.slice(-400)];
  const attemptedLengths = new Set<number>();
  for (const candidate of candidates) {
    if (attemptedLengths.has(candidate.length)) continue;
    attemptedLengths.add(candidate.length);
    try {
      window.localStorage.setItem(
        CLOVY_HOME_TASK_HANDOFFS_STORAGE_KEY,
        JSON.stringify({ ...records, [activeSessionId]: candidate }),
      );
      dispatchClovyHomeThreadChanged(activeSessionId);
      return;
    } catch {
      // Try the next smaller durable tail.
    }
  }
}

export function recoverInterruptedHomeTaskHandoffs(storedSessionId: string): HomeTaskHandoff[] {
  const handoffs = readHomeTaskHandoffs(storedSessionId);
  let changed = false;
  const recovered = handoffs.map((handoff) => {
    if (
      handoff.status !== "starting" ||
      activeHomeTaskHandoffs.has(activeHomeTaskHandoffKey(storedSessionId, handoff.id))
    ) {
      return handoff;
    }
    changed = true;
    return {
      ...handoff,
      status: "failed" as const,
      error: "Session creation was interrupted. Try again.",
    };
  });
  if (changed) persistHomeTaskHandoffs(storedSessionId, recovered);
  return recovered;
}

const HOME_HANDOFF_ACKNOWLEDGEMENTS = new Set([
  "all good",
  "cool",
  "got it",
  "great",
  "k",
  "nice",
  "ok",
  "okay",
  "perfect",
  "sounds good",
  "thank you",
  "thanks",
  "understood",
  "yep",
  "yes",
  "yup",
]);

const HOME_CONVERSATION_GREETING =
  /^(?:(?:hi|hey|hello)(?: there| again)?|(?:good )?(?:morning|afternoon|evening)|greetings|good to see you)(?: (?:clovy|june))?$/u;
const HOME_CONVERSATION_HELLO_FROM = /^hello\s+from\s+(.+?)[\p{P}\p{S}\s]*$/iu;
const HOME_CONVERSATION_LOCATION_CONNECTORS = new Set([
  "da",
  "de",
  "del",
  "do",
  "dos",
  "la",
  "las",
  "le",
  "of",
  "the",
  "van",
  "von",
]);

function isHomeConversationLocationWord(word: string): boolean {
  if (!/^[\p{L}\p{N}'’-]+$/u.test(word)) return false;
  if (!/[\p{Ll}\p{Lu}]/u.test(word)) return true;
  return /^\p{Lu}/u.test(word);
}

function isHomeConversationHelloFrom(message: string): boolean {
  const match = HOME_CONVERSATION_HELLO_FROM.exec(message);
  if (!match?.[1]) return false;
  const words = match[1].trim().split(/\s+/);
  if (words.length === 0 || words.length > 3) return false;
  return words.every(
    (word, index) =>
      isHomeConversationLocationWord(word) ||
      (index > 0 &&
        index < words.length - 1 &&
        HOME_CONVERSATION_LOCATION_CONNECTORS.has(word.toLocaleLowerCase())),
  );
}

function normalizedHomeAcknowledgement(message: string): string {
  return message
    .trim()
    .toLocaleLowerCase()
    .replace(/[.!?,;:]+$/g, "")
    .replace(/\s+/g, " ");
}

export function homeConversationGreetingReply(message: string): string | undefined {
  const visibleMessage = message.normalize("NFKC").trim();
  const normalized = message
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
  return HOME_CONVERSATION_GREETING.test(normalized) || isHomeConversationHelloFrom(visibleMessage)
    ? "Hey! What can I help with?"
    : undefined;
}

const HOME_TASK_GROUNDING_STOP_WORDS = new Set([
  "a",
  "afternoon",
  "about",
  "agent",
  "again",
  "an",
  "analyze",
  "analyse",
  "and",
  "are",
  "build",
  "check",
  "compare",
  "create",
  "day",
  "do",
  "draft",
  "edit",
  "email",
  "explore",
  "find",
  "fix",
  "generate",
  "help",
  "investigate",
  "in",
  "is",
  "it",
  "look",
  "evening",
  "focused",
  "for",
  "from",
  "good",
  "greetings",
  "hello",
  "hey",
  "hiya",
  "howdy",
  "june",
  "clovy",
  "morning",
  "make",
  "me",
  "plan",
  "prepare",
  "please",
  "research",
  "review",
  "schedule",
  "search",
  "summarize",
  "summarise",
  "update",
  "write",
  "see",
  "session",
  "start",
  "task",
  "that",
  "the",
  "them",
  "there",
  "this",
  "those",
  "to",
  "what",
  "when",
  "where",
  "which",
  "who",
  "with",
  "you",
  "your",
]);

const HOME_TASK_ACTION_NEGATION =
  /\b(?:(?:do not|don't|never)(?!\s+forget\s+to\b)|stop)\b|\bwithout\s+(?:\w+\s+){0,3}\w+ing\b/i;
const HOME_TASK_REPEAT_NEGATION =
  /\b(?:do not|don't|never|stop|without)\s+(?:\w+\s+){0,8}(?:again|continue|redo|repeat|resume)\b/i;
const HOME_TASK_CONTEXTUAL_NEGATION =
  /\b(?:do not|don't|never|stop|without)\s+(?:\w+\s+){0,5}(?:do (?:it|that|this|the same)|one more|same for|(?:first|second|third|next) one)\b/i;
const HOME_TASK_POSITIVE_NEGATION_EXCEPTION = /\b(?:do not|don't|never)\s+forget\s+to\b/i;
const HOME_TASK_REPEAT_REQUEST = /\b(?:again|continue|redo|repeat|resume)\b/i;
const HOME_TASK_CONTEXTUAL_REQUEST =
  /\b(?:do (?:it|that|this|the same)|one more|same for|start (?:it|that|this)|(?:first|second|third|next) one)\b/i;
const HOME_TASK_REPLACEMENT_LEADING_WORDS = new Set([
  "a",
  "also",
  "an",
  "and",
  "can",
  "could",
  "instead",
  "it",
  "just",
  "please",
  "that",
  "the",
  "them",
  "these",
  "then",
  "this",
  "those",
  "will",
  "would",
  "you",
]);

function normalizedHomeTaskWord(word: string): string {
  return word.length > 3 && word.endsWith("s") && !word.endsWith("ss") ? word.slice(0, -1) : word;
}

function homeTaskGroundingTokens(value: string): Set<string> {
  return new Set(
    value
      .normalize("NFKC")
      .toLocaleLowerCase()
      .match(/[\p{L}\p{N}]+/gu)
      ?.map(normalizedHomeTaskWord)
      .filter((token) => token.length >= 2 && !HOME_TASK_GROUNDING_STOP_WORDS.has(token)) ?? [],
  );
}

function normalizedHomeTaskIntent(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[’‘]/g, "'")
    .replace(/\bdon't\b/gi, "do not")
    .replace(/'/g, "")
    .replace(/[^\p{L}\p{N}']+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function homeTaskSimilarity(left: ClovyHomeTaskRequest, right: ClovyHomeTaskRequest): number {
  const normalizedLeftTitle = normalizedHomeTaskIntent(left.title).toLocaleLowerCase();
  const normalizedRightTitle = normalizedHomeTaskIntent(right.title).toLocaleLowerCase();
  if (normalizedLeftTitle && normalizedLeftTitle === normalizedRightTitle) return 1;
  const leftTokens = homeTaskGroundingTokens(`${left.title} ${left.prompt}`);
  const rightTokens = homeTaskGroundingTokens(`${right.title} ${right.prompt}`);
  if (leftTokens.size === 0 || rightTokens.size === 0) return 0;
  const shared = [...leftTokens].filter((leftToken) => rightTokens.has(leftToken)).length;
  return shared / Math.max(leftTokens.size, rightTokens.size);
}

function matchingPriorHomeTaskHandoffs(
  task: ClovyHomeTaskRequest,
  handoffs: HomeTaskHandoff[],
): HomeTaskHandoff[] {
  return handoffs.filter((handoff) => homeTaskSimilarity(task, handoff) >= 0.6);
}

function latestHomeTaskNovelGrounding(
  task: ClovyHomeTaskRequest,
  latestMessage: string,
  matchingHandoffs: HomeTaskHandoff[],
): { hasNovelGrounding: boolean; taskUsesNovelGrounding: boolean } {
  const latestTokens = homeTaskGroundingTokens(latestMessage);
  const taskTokens = homeTaskGroundingTokens(`${task.title} ${task.prompt}`);
  const priorTokens = matchingHandoffs.map((handoff) =>
    homeTaskGroundingTokens(`${handoff.title} ${handoff.prompt}`),
  );
  const novelGrounding = [...latestTokens].filter((token) =>
    priorTokens.every((tokens) => !tokens.has(token)),
  );
  return {
    hasNovelGrounding: novelGrounding.length > 0,
    taskUsesNovelGrounding: novelGrounding.some((token) => taskTokens.has(token)),
  };
}

function homeTaskSharesLatestGrounding(task: ClovyHomeTaskRequest, latestMessage: string): boolean {
  const taskTokens = homeTaskGroundingTokens(`${task.title} ${task.prompt}`);
  return [...homeTaskGroundingTokens(latestMessage)].some((token) => taskTokens.has(token));
}

function homeTaskHasPositiveReplacementAfterNegation(
  task: ClovyHomeTaskRequest,
  latestMessage: string,
  matchingHandoffs: HomeTaskHandoff[],
): boolean {
  const taskWords = new Set(
    normalizedHomeTaskIntent(`${task.title} ${task.prompt}`)
      .toLocaleLowerCase()
      .split(" ")
      .map(normalizedHomeTaskWord),
  );
  const priorGrounding = matchingHandoffs.map((handoff) =>
    homeTaskGroundingTokens(`${handoff.title} ${handoff.prompt}`),
  );
  const clauses = latestMessage
    .normalize("NFKC")
    .replace(/[’‘]/g, "'")
    .replace(/\b(do not|don't|never),\s*please,\s*/giu, "$1 ")
    .split(/(?:[;,]|\bbut\b|\binstead\b|\bthen\b)/iu);
  let sawNegatedClause = false;

  for (const clause of clauses) {
    const intentText = normalizedHomeTaskIntent(clause).toLocaleLowerCase();
    if (!intentText) continue;
    if (
      HOME_TASK_REPEAT_NEGATION.test(intentText) ||
      HOME_TASK_CONTEXTUAL_NEGATION.test(intentText) ||
      HOME_TASK_ACTION_NEGATION.test(intentText)
    ) {
      sawNegatedClause = true;
      continue;
    }
    if (!sawNegatedClause) continue;
    const leadingWordCandidate = intentText
      .split(" ")
      .find((word) => !HOME_TASK_REPLACEMENT_LEADING_WORDS.has(word));
    const leadingWord = leadingWordCandidate
      ? normalizedHomeTaskWord(leadingWordCandidate)
      : undefined;
    if (
      leadingWord &&
      taskWords.has(leadingWord) &&
      priorGrounding.every((tokens) => !tokens.has(leadingWord))
    ) {
      return true;
    }
  }

  return false;
}

export function isHomeTaskReplayWithoutNewIntent(
  task: ClovyHomeTaskRequest,
  latestMessage: string,
  handoffs: HomeTaskHandoff[],
): boolean {
  const intentText = normalizedHomeTaskIntent(latestMessage);
  const negatesRepeat = HOME_TASK_REPEAT_NEGATION.test(intentText);
  const negatesAction = HOME_TASK_ACTION_NEGATION.test(intentText);
  const negatesContext = HOME_TASK_CONTEXTUAL_NEGATION.test(intentText);
  const matchingHandoffs = matchingPriorHomeTaskHandoffs(task, handoffs);
  if (matchingHandoffs.length === 0) return false;
  if (homeConversationGreetingReply(latestMessage)) return true;
  const grounding = latestHomeTaskNovelGrounding(task, latestMessage, matchingHandoffs);
  if (grounding.taskUsesNovelGrounding) return false;
  if (HOME_TASK_POSITIVE_NEGATION_EXCEPTION.test(intentText)) return false;
  if (homeTaskHasPositiveReplacementAfterNegation(task, latestMessage, matchingHandoffs)) {
    return false;
  }
  if (negatesRepeat || negatesContext || negatesAction) return true;
  if (grounding.hasNovelGrounding) return true;
  if (HOME_TASK_REPEAT_REQUEST.test(intentText) || HOME_TASK_CONTEXTUAL_REQUEST.test(intentText)) {
    return false;
  }
  return !homeTaskSharesLatestGrounding(task, latestMessage);
}

export function compareHomeTurnOrder(left: AgentChatTurn, right: AgentChatTurn): number {
  // Array.sort is stable. Equal timestamps therefore retain persisted causal
  // order instead of letting role-prefixed ids put an assistant before its user.
  return left.createdAt.localeCompare(right.createdAt);
}

export function isHomeTaskHandoffAcknowledgement(
  message: string,
  priorTurns: AgentChatTurn[],
  handoffs: HomeTaskHandoff[],
): boolean {
  if (!HOME_HANDOFF_ACKNOWLEDGEMENTS.has(normalizedHomeAcknowledgement(message))) return false;
  const priorTurn = [...priorTurns].sort(compareHomeTurnOrder).at(-1);
  if (priorTurn?.role !== "assistant") return false;
  const taskTool = priorTurn.parts.find(
    (part) => part.type === "tool" && isClovyHomeStartTaskTool(part.name),
  );
  if (taskTool?.type !== "tool") return false;
  return handoffs.some(
    (handoff) => handoff.id === `home-task-${taskTool.id}` && handoff.status !== "failed",
  );
}

export function existingHomeTaskHandoffForSourceTurn(
  handoffs: HomeTaskHandoff[],
  sourceUserTurnId: string | undefined,
): HomeTaskHandoff | undefined {
  if (!sourceUserTurnId) return undefined;
  return handoffs.find(
    (handoff) => handoff.sourceUserTurnId === sourceUserTurnId && handoff.status !== "failed",
  );
}

function textForTurn(turn: AgentChatTurn): string {
  return turn.parts
    .filter((part): part is Extract<AgentChatPart, { type: "text" }> => part.type === "text")
    .map((part) => part.text.trim())
    .filter(Boolean)
    .join("\n\n");
}

export function homeConversationContextFromTurns(
  turns: AgentChatTurn[],
): ClovyHomeConversationContext {
  const messages = [...turns]
    .sort(compareHomeTurnOrder)
    .filter(
      (turn): turn is AgentChatTurn & { role: "user" | "assistant" } =>
        turn.role === "user" || turn.role === "assistant",
    )
    .map((turn) => {
      const rawText = textForTurn(turn);
      const text =
        turn.role === "user" ? (stripClovyHomeContextFromPreview(rawText) ?? rawText) : rawText;
      const delegated = turn.parts.some(
        (part) => part.type === "tool" && isClovyHomeStartTaskTool(part.name),
      );
      return {
        role: turn.role,
        content:
          text ||
          (delegated
            ? "I created a focused session for that task. A brief acknowledgement does not request another session."
            : ""),
        createdAt: turn.createdAt,
      };
    })
    .filter((message) => message.content);
  return buildClovyHomeConversationContext(messages);
}

const homeDirectChatChains = new Map<string, Promise<void>>();

export function enqueueHomeDirectChat(storedSessionId: string, operation: () => Promise<void>) {
  const previous = homeDirectChatChains.get(storedSessionId) ?? Promise.resolve();
  const request = previous.catch(() => undefined).then(operation);
  const tail = request.catch(() => undefined);
  homeDirectChatChains.set(storedSessionId, tail);
  void tail.finally(() => {
    if (homeDirectChatChains.get(storedSessionId) === tail) {
      homeDirectChatChains.delete(storedSessionId);
    }
  });
  return request;
}

type HomeDemoSnapshot = {
  profile: string;
  sessionId?: string;
  demoSessionId: string;
  directTurns: unknown;
  handoffs: unknown;
};

function readDemoSnapshot(): HomeDemoSnapshot | undefined {
  if (!import.meta.env.DEV || typeof window === "undefined") return undefined;
  try {
    const current = window.localStorage.getItem(HOME_DEMO_BACKUP_STORAGE_KEY);
    const legacy = window.localStorage.getItem(LEGACY_HOME_DEMO_BACKUP_STORAGE_KEY);
    const value = JSON.parse(current ?? legacy ?? "null") as HomeDemoSnapshot | null;
    if (!current && legacy) {
      window.localStorage.setItem(HOME_DEMO_BACKUP_STORAGE_KEY, legacy);
      window.localStorage.removeItem(LEGACY_HOME_DEMO_BACKUP_STORAGE_KEY);
    }
    return value && typeof value.profile === "string" && typeof value.demoSessionId === "string"
      ? value
      : undefined;
  } catch {
    return undefined;
  }
}

let homeDemoSnapshot = readDemoSnapshot();
let homeDemoReplyIndex = 0;

export function homeDemoEnabled(profile: string) {
  return Boolean(homeDemoSnapshot?.profile === profile);
}

export async function homeDemoReply(
  profile: string,
  onDelta: (content: string) => void,
): Promise<ClovyHomeChatResponse | undefined> {
  if (!homeDemoEnabled(profile)) return undefined;
  const replies = [
    "That makes sense. What would help you move it forward?",
    "I’m with you. We can talk it through here, or open a focused session if it needs deeper work.",
    "Got it. I’ll stay with what you’ve shared here and won’t fill in missing context.",
  ];
  await new Promise((resolve) => window.setTimeout(resolve, 450));
  const content = replies[homeDemoReplyIndex % replies.length];
  homeDemoReplyIndex += 1;
  for (const chunk of content.match(/.{1,18}(?:\s|$)/g) ?? [content]) {
    onDelta(chunk);
    await new Promise((resolve) => window.setTimeout(resolve, 90));
  }
  return { content };
}

function demoTurn(
  id: string,
  role: "user" | "assistant",
  text: string,
  createdAt: string,
): AgentChatTurn {
  return {
    id: `home-demo-${id}`,
    role,
    createdAt,
    status: "complete",
    parts: [{ type: "text", text, status: "complete" }],
  };
}

function demoTaskTurn(id: string, createdAt: string): AgentChatTurn {
  return {
    id: `home-demo-${id}`,
    role: "assistant",
    createdAt,
    status: "complete",
    parts: [
      {
        type: "tool",
        id,
        name: "mcp_clovy_home_start_task",
        text: "",
        status: "complete",
      },
    ],
  };
}

function seedHomeDemo(storedSessionId: string) {
  const now = Date.now();
  const at = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString();
  persistHomeDirectTurns(storedSessionId, [
    demoTurn(
      "preference-user",
      "user",
      "I do my best writing before noon. Can we keep that in mind when we plan my days?",
      at(4 * 24 * 60 + 90),
    ),
    demoTurn(
      "preference-assistant",
      "assistant",
      "That’s useful context. I’ll treat mornings as your preferred writing window.",
      at(4 * 24 * 60 + 89),
    ),
    demoTurn(
      "rich-user",
      "user",
      "Give me a quick launch snapshot and show me how you’d structure it.",
      at(2 * 24 * 60 + 40),
    ),
    demoTurn(
      "rich-assistant",
      "assistant",
      `## Launch snapshot

The migration is **complete**, the staging cron is *still open*, and \`release/verify\` is next.

- Production tokens are healthy
- ~~Re-run the migration~~ is no longer needed
- The [release notes](https://example.com) need a final pass

| Area | State | Next step |
| --- | --- | --- |
| Migration | Complete | Monitor |
| Staging cron | Open | Fix audience |
| Release | Ready | Verify |

\`\`\`ts
const nextStep = "verify staging cron";
\`\`\`

Anything after a table or code block keeps rendering in the same response.`,
      at(2 * 24 * 60 + 39),
    ),
    demoTurn(
      "today-user",
      "user",
      "Morning. I want to protect my writing time, but the staging cron is nagging at me.",
      at(170),
    ),
    demoTurn(
      "today-assistant",
      "assistant",
      "Keep the morning for writing. Give the cron one contained slot after lunch; if it turns out deeper, I can open a focused session.",
      at(169),
    ),
    demoTurn(
      "starting-user",
      "user",
      "Create a focused session to draft the launch brief.",
      at(150),
    ),
    demoTaskTurn("demo-starting", at(149)),
    demoTurn("running-user", "user", "Open a focused session to review the launch risks.", at(135)),
    demoTaskTurn("demo-running", at(134)),
    demoTurn("failed-user", "user", "Start another session for the rollout checklist.", at(120)),
    demoTaskTurn("demo-failed", at(119)),
  ]);
  const handoffs: HomeTaskHandoff[] = [
    {
      id: "home-task-demo-starting",
      title: "Draft launch brief",
      prompt: "Draft the launch brief.",
      status: "starting",
    },
    {
      id: "home-task-demo-running",
      title: "Review launch risks",
      prompt: "Research and summarize the launch risks.",
      status: "running",
      storedSessionId: "home-demo-focused-session",
    },
    {
      id: "home-task-demo-failed",
      title: "Build rollout checklist",
      prompt: "Build the rollout checklist.",
      status: "failed",
      error: "The session could not be created. Please try again.",
    },
  ];
  writeRecord(CLOVY_HOME_TASK_HANDOFFS_STORAGE_KEY, {
    ...readRecord(CLOVY_HOME_TASK_HANDOFFS_STORAGE_KEY),
    [storedSessionId]: handoffs,
  });
  window.dispatchEvent(new CustomEvent(HOME_DEMO_SEEDED_EVENT));
}

if (import.meta.env.DEV && typeof window !== "undefined") {
  (window as unknown as Record<string, unknown>).__homeDemo = (mode: boolean | "empty" = true) => {
    if (mode === false) {
      const snapshot = homeDemoSnapshot ?? readDemoSnapshot();
      if (!snapshot) return "Home demo is already off.";
      const direct = readRecord(CLOVY_HOME_DIRECT_TURNS_STORAGE_KEY);
      const handoffs = readRecord(CLOVY_HOME_TASK_HANDOFFS_STORAGE_KEY);
      if (snapshot.directTurns === undefined) delete direct[snapshot.demoSessionId];
      else direct[snapshot.demoSessionId] = snapshot.directTurns;
      if (snapshot.handoffs === undefined) delete handoffs[snapshot.demoSessionId];
      else handoffs[snapshot.demoSessionId] = snapshot.handoffs;
      writeRecord(CLOVY_HOME_DIRECT_TURNS_STORAGE_KEY, direct);
      writeRecord(CLOVY_HOME_TASK_HANDOFFS_STORAGE_KEY, handoffs);
      if (snapshot.sessionId) {
        writeClovyHomeStoredSessionId(snapshot.profile, snapshot.sessionId);
      } else {
        forgetClovyHomeStoredSessionId(snapshot.profile, snapshot.demoSessionId);
      }
      window.localStorage.removeItem(HOME_DEMO_BACKUP_STORAGE_KEY);
      window.localStorage.removeItem(LEGACY_HOME_DEMO_BACKUP_STORAGE_KEY);
      homeDemoSnapshot = undefined;
      window.dispatchEvent(new CustomEvent(HOME_DEMO_SEEDED_EVENT));
      return "Home demo off; your previous Home thread is restored.";
    }

    const profile = getCurrentDataPartitionName();
    if (homeDemoSnapshot && homeDemoSnapshot.profile !== profile) {
      return `Home demo is active for ${homeDemoSnapshot.profile}. Run __homeDemo(false) first.`;
    }
    if (!homeDemoSnapshot) {
      const sessionId = readClovyHomeStoredSessionId(profile);
      const demoSessionId = sessionId ?? "home-demo-session";
      homeDemoSnapshot = {
        profile,
        sessionId,
        demoSessionId,
        directTurns: readRecord(CLOVY_HOME_DIRECT_TURNS_STORAGE_KEY)[demoSessionId],
        handoffs: readRecord(CLOVY_HOME_TASK_HANDOFFS_STORAGE_KEY)[demoSessionId],
      };
      window.localStorage.setItem(HOME_DEMO_BACKUP_STORAGE_KEY, JSON.stringify(homeDemoSnapshot));
    }
    const storedSessionId = readClovyHomeStoredSessionId(profile) ?? homeDemoSnapshot.demoSessionId;
    writeClovyHomeStoredSessionId(profile, storedSessionId);
    if (mode === "empty") {
      persistHomeDirectTurns(storedSessionId, []);
      persistHomeTaskHandoffs(storedSessionId, []);
      window.dispatchEvent(new CustomEvent(HOME_DEMO_SEEDED_EVENT));
      return "Home demo is showing the empty first-open state.";
    }
    seedHomeDemo(storedSessionId);
    return 'Home demo seeded. Use __homeDemo("empty") for first-open and __homeDemo(false) to restore your thread.';
  };
}
