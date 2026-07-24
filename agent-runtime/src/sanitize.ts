import type { JsonValue } from "./types.js";

const SENSITIVE_KEY = /authorization|api[-_]?key|cookie|password|secret|token/i;
const BEARER_VALUE = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const KEY_VALUE = /\b(?:sk|osk)_[A-Za-z0-9_-]{12,}\b/g;

export function sanitizeForLog(value: unknown, depth = 0): JsonValue {
  if (depth > 8) return "[truncated]";
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") {
    return value.replace(BEARER_VALUE, "Bearer [redacted]").replace(KEY_VALUE, "[redacted]");
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
