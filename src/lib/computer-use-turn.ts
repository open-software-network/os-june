export const COMPUTER_USE_TURN_TOOLSETS = ["june_computer_use"] as const;

const COMPUTER_USE_PHRASE = String.raw`computer(?:\s+|-)use`;
const EXPLICIT_COMPUTER_USE_REQUEST = new RegExp(
  String.raw`(?:\b(?:use|using|via|with|through)\s+(?:the\s+)?${COMPUTER_USE_PHRASE}\b|\b${COMPUTER_USE_PHRASE}\b\s*(?::|to\b))`,
  "i",
);
const NEGATED_COMPUTER_USE_REQUEST = new RegExp(
  String.raw`(?:\b(?:do\s+not|don't|dont|never)\s+(?:use\s+)?(?:the\s+)?${COMPUTER_USE_PHRASE}\b|\bwithout\s+(?:the\s+)?${COMPUTER_USE_PHRASE}\b)`,
  "i",
);

/**
 * A new agent has to choose its tool snapshot before the model sees the turn.
 * Keep the fast path deliberately explicit: descriptive questions about the
 * feature retain June's normal tools, while requests that name Computer use as
 * the execution mechanism receive only the app-owned desktop-control server.
 */
export function toolsetsForComputerUseTurn(prompt: string): string[] | null {
  const normalized = prompt.replace(/\s+/g, " ").trim();
  if (
    !normalized ||
    NEGATED_COMPUTER_USE_REQUEST.test(normalized) ||
    !EXPLICIT_COMPUTER_USE_REQUEST.test(normalized)
  ) {
    return null;
  }
  return [...COMPUTER_USE_TURN_TOOLSETS];
}
