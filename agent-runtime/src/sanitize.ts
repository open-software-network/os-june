import type { JsonValue } from "./types.js";

const SENSITIVE_KEY = /authorization|api[-_]?key|cookie|password|secret|token/i;
const BEARER_VALUE = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const KEY_VALUE = /\b(?:sk|osk)_[A-Za-z0-9_-]{12,}\b/g;
const NAMED_SECRET_QUOTED =
  /((?:["']?(?:authorization|api[-_]?key|cookie|password|secret|[a-z0-9_-]*token[a-z0-9_-]*)["']?)\s*[:=]\s*)(["'])[^"'\r\n]*\2/gi;
const NAMED_SECRET_BARE =
  /\b((?:authorization|api[-_]?key|cookie|password|secret|[a-z0-9_-]*token[a-z0-9_-]*)\s*[:=]\s*)[^\s,;}\]]+/gi;

export function sanitizeForLog(value: unknown, depth = 0): JsonValue {
  if (depth > 8) return "[truncated]";
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") {
    return value
      .replace(BEARER_VALUE, "Bearer [redacted]")
      .replace(KEY_VALUE, "[redacted]")
      .replace(NAMED_SECRET_QUOTED, (_match, prefix: string, quote: string) =>
        `${prefix}${quote}[redacted]${quote}`,
      )
      .replace(NAMED_SECRET_BARE, "$1[redacted]");
  }
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => sanitizeForLog(item, depth + 1));
  if (typeof value === "object") {
    const result: Record<string, JsonValue> = {};
    for (const [key, item] of Object.entries(value).slice(0, 100)) {
      result[key] = SENSITIVE_KEY.test(key) ? "[redacted]" : sanitizeForLog(item, depth + 1);
    }
    return result;
  }
  return String(value);
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return String(sanitizeForLog(error.message));
  return String(sanitizeForLog(error));
}

export type RuntimeFailureCategory = "tool" | "provider" | "runtime" | "context" | "credits";

export type RuntimeFailureDetails = {
  message: string;
  category: RuntimeFailureCategory;
  code: string;
  retryable: boolean;
};

export function runtimeFailureDetails(error: unknown): RuntimeFailureDetails {
  const message = errorMessage(error);
  const tagged = error as { failureCategory?: unknown; failureCode?: unknown } | null;
  if (tagged?.failureCategory === "tool") {
    return {
      message,
      category: "tool",
      code: typeof tagged.failureCode === "string" ? tagged.failureCode : "agent_tool_failed",
      retryable: true,
    };
  }

  const normalized = message.toLowerCase();
  if (/context (?:length|window)|maximum context|too many tokens|token limit/.test(normalized)) {
    return { message, category: "context", code: "agent_context_exceeded", retryable: false };
  }
  if (/\b402\b|insufficient credits|credit balance|more credits/.test(normalized)) {
    return { message, category: "credits", code: "agent_credits_required", retryable: false };
  }
  if (
    /provider|upstream|agent_chat|model (?:gateway|route|host)|chat completions|openai|venice|fetch failed|network|econn|timed? out|timeout|\b429\b|\b5\d\d\b/.test(
      normalized,
    )
  ) {
    return { message, category: "provider", code: "agent_provider_failed", retryable: true };
  }
  return { message, category: "runtime", code: "agent_runtime_failed", retryable: true };
}
