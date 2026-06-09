import type { DictationHelperEvent } from "./tauri";

export function parseDictationHelperEvent(
  payload: unknown,
): DictationHelperEvent | undefined {
  try {
    const value = typeof payload === "string" ? JSON.parse(payload) : payload;
    if (!value || typeof value !== "object") return undefined;
    const event = value as { type?: unknown };
    if (typeof event.type !== "string" || event.type.trim() === "") {
      return undefined;
    }
    return value as DictationHelperEvent;
  } catch {
    return undefined;
  }
}
