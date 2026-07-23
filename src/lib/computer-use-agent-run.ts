export const COMPUTER_USE_AGENT_RUN_TOOLSETS = ["june_computer_use"] as const;

const COMPUTER_USE_PHRASE = String.raw`computer(?:\s+|-)use`;
const INFORMATIONAL_QUESTION =
  /^(?:(?:what|why|how|when|where|who|which|does|did|is|are|was|were)\b|(?:do|should|could|would|can)\s+(?:i|we)\b|tell\s+me\s+(?:how|whether|if|what|why)\b)/i;
const EXPLICIT_COMPUTER_USE_REQUEST = new RegExp(
  String.raw`(?:\buse\s+(?:the\s+)?${COMPUTER_USE_PHRASE}(?:\s+tool)?\s+(?:to|for)\b|\b(?:using|via|through)\s+(?:the\s+)?${COMPUTER_USE_PHRASE}(?:\s+tool)?\b|\bwith\s+(?:the\s+)?${COMPUTER_USE_PHRASE}(?:\s+tool)?\s*(?::|,|\bto\b)|^(?:please\s+)?${COMPUTER_USE_PHRASE}(?:\s+tool)?\s*(?::|,|-)?\s*(?:please\s+)?(?:open|launch|click|type|enter|press|select|choose|drag|scroll|close|quit|switch|move|resize|focus|inspect|look|take|capture|use)\b)`,
  "i",
);
const NEGATED_COMPUTER_USE_REQUEST = new RegExp(
  String.raw`(?:\b(?:do\s+not|don't|dont|never)\s+(?:use\s+)?(?:the\s+)?${COMPUTER_USE_PHRASE}\b|\bwithout\s+(?:the\s+)?${COMPUTER_USE_PHRASE}\b)`,
  "i",
);

/**
 * A new agent has to choose its tool snapshot before the model sees the agent run.
 * Keep the fast path deliberately explicit: descriptive questions about the
 * feature retain June's normal tools, while requests that name Computer use as
 * the execution mechanism receive only the app-owned desktop-control server.
 */
export function toolsetsForComputerUseAgentRun(prompt: string): string[] | null {
  const normalized = prompt.replace(/\s+/g, " ").trim();
  if (
    !normalized ||
    INFORMATIONAL_QUESTION.test(normalized) ||
    NEGATED_COMPUTER_USE_REQUEST.test(normalized) ||
    !EXPLICIT_COMPUTER_USE_REQUEST.test(normalized)
  ) {
    return null;
  }
  return [...COMPUTER_USE_AGENT_RUN_TOOLSETS];
}
