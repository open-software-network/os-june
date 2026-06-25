const OVERFLOW_TEXT_PATTERNS = [
  /prompt_too_long/i,
  /maximum context/i,
  /context length/i,
  /context window/i,
];

export function isContextOverflowError(value: unknown) {
  let matchedErrorCode = false;
  let matchedText = false;

  visitContextOverflowValue(value, new Set(), (item) => {
    if (typeof item === "string") {
      if (OVERFLOW_TEXT_PATTERNS.some((pattern) => pattern.test(item))) {
        matchedText = true;
      }
      const parsed = parseJsonString(item);
      if (parsed !== undefined) {
        visitContextOverflowValue(parsed, new Set(), (parsedItem) => {
          if (
            typeof parsedItem === "string" &&
            OVERFLOW_TEXT_PATTERNS.some((pattern) => pattern.test(parsedItem))
          ) {
            matchedText = true;
          }
          if (parsedItem === 2001 || parsedItem === "2001") {
            matchedErrorCode = true;
          }
        });
      }
      return;
    }
    if (item === 2001 || item === "2001") {
      matchedErrorCode = true;
    }
  });

  return matchedErrorCode || matchedText;
}

function visitContextOverflowValue(
  value: unknown,
  seen: Set<object>,
  visitor: (value: unknown) => void,
) {
  visitor(value);
  if (!value || typeof value !== "object") return;
  if (seen.has(value)) return;
  seen.add(value);

  if (value instanceof Error) {
    visitor(value.name);
    visitor(value.message);
    visitContextOverflowValue(value.cause, seen, visitor);
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      visitContextOverflowValue(item, seen, visitor);
    }
    return;
  }

  for (const [key, nested] of Object.entries(value)) {
    visitor(key);
    visitContextOverflowValue(nested, seen, visitor);
  }
}

function parseJsonString(value: string) {
  const trimmed = value.trim();
  if (!trimmed || (trimmed[0] !== "{" && trimmed[0] !== "[")) {
    return undefined;
  }
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
}
