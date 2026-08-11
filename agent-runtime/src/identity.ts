import type { EngineResult, RunStartParams } from "./types.js";

export const CLOVY_IDENTITY_REPLY = "I'm Clovy, your personal AI assistant.";

const LEGACY_NAME_QUESTIONS = new Set([
  "are you june",
  "is june your name",
  "is your name june",
  "what is june",
  "whats june",
  "who is june",
  "whos june",
]);

const CLOVY_NAME_QUESTIONS = new Set([
  "are you clovy",
  "is clovy your name",
  "is your name clovy",
  "what is clovy",
  "whats clovy",
  "who is clovy",
  "whos clovy",
]);

const GENERAL_IDENTITY_QUESTIONS = new Set([
  "are you chatgpt",
  "are you clovy",
  "are you openai",
  "can you tell me who you are",
  "identify yourself",
  "tell me who you are",
  "what are you",
  "what is your name",
  "what r u",
  "what r you",
  "what should i call you",
  "whats your name",
  "who am i talking to",
  "who are you",
  "who is this",
  "who r u",
  "who r you",
]);

const LEADING_FILLERS = new Set([
  "clovy",
  "hello",
  "hey",
  "hi",
  "june",
  "ok",
  "okay",
  "please",
  "so",
  "there",
  "uh",
  "um",
  "well",
  "yo",
]);

const LEADING_CONVERSATIONAL_FILLERS = new Set([
  "hello",
  "hey",
  "hi",
  "ok",
  "okay",
  "please",
  "so",
  "uh",
  "um",
  "well",
  "yo",
]);

const TRAILING_FILLERS = new Set(["clovy", "june", "please"]);

export function clovyIdentityResult(params: RunStartParams): EngineResult | undefined {
  const reply = identityReply(params.input);
  if ((params.attachments?.length ?? 0) > 0 || !reply) {
    return undefined;
  }
  return {
    finalOutput: reply,
    history: [
      ...params.history,
      {
        id: `clovy-identity-user-${crypto.randomUUID()}`,
        kind: "message",
        role: "user",
        text: params.input,
      },
      {
        id: `clovy-identity-assistant-${crypto.randomUUID()}`,
        kind: "message",
        role: "assistant",
        text: reply,
      },
    ],
    usage: {},
    interruptions: [],
  };
}

function identityReply(input: string): string | undefined {
  const normalized = input
    .normalize("NFKC")
    .toLowerCase()
    .replaceAll("'", "")
    .replaceAll("’", "");
  const words = normalized.match(/[a-z0-9]+/g) ?? [];
  let namedStart = 0;
  let namedEnd = words.length;
  while (namedStart < namedEnd && LEADING_CONVERSATIONAL_FILLERS.has(words[namedStart] ?? "")) {
    namedStart += 1;
  }
  if (namedStart < namedEnd && ["clovy", "june"].includes(words[namedStart] ?? "")) {
    namedStart += 1;
  }
  while (namedEnd > namedStart && words[namedEnd - 1] === "please") namedEnd -= 1;
  const namedQuestion = words.slice(namedStart, namedEnd).join(" ");
  if (LEGACY_NAME_QUESTIONS.has(namedQuestion)) return CLOVY_IDENTITY_REPLY;
  if (CLOVY_NAME_QUESTIONS.has(namedQuestion)) return CLOVY_IDENTITY_REPLY;

  let start = 0;
  let end = words.length;
  while (start < end && LEADING_FILLERS.has(words[start] ?? "")) start += 1;
  while (end > start && TRAILING_FILLERS.has(words[end - 1] ?? "")) end -= 1;
  return GENERAL_IDENTITY_QUESTIONS.has(words.slice(start, end).join(" "))
    ? CLOVY_IDENTITY_REPLY
    : undefined;
}
