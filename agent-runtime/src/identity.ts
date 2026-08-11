import type { EngineResult, RunStartParams } from "./types.js";

export const CLOVY_IDENTITY_REPLY = "I'm Clovy, your personal AI assistant.";

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

const TRAILING_FILLERS = new Set(["clovy", "june", "please"]);

export function clovyIdentityResult(params: RunStartParams): EngineResult | undefined {
  if ((params.attachments?.length ?? 0) > 0 || !isGeneralIdentityQuestion(params.input)) {
    return undefined;
  }
  return {
    finalOutput: CLOVY_IDENTITY_REPLY,
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
        text: CLOVY_IDENTITY_REPLY,
      },
    ],
    usage: {},
    interruptions: [],
  };
}

function isGeneralIdentityQuestion(input: string): boolean {
  const normalized = input
    .normalize("NFKC")
    .toLowerCase()
    .replaceAll("'", "")
    .replaceAll("’", "");
  const words = normalized.match(/[a-z0-9]+/g) ?? [];
  let start = 0;
  let end = words.length;
  while (start < end && LEADING_FILLERS.has(words[start] ?? "")) start += 1;
  while (end > start && TRAILING_FILLERS.has(words[end - 1] ?? "")) end -= 1;
  return GENERAL_IDENTITY_QUESTIONS.has(words.slice(start, end).join(" "));
}
