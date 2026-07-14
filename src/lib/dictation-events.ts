import type { DictationHelperEvent } from "./tauri";

export function parseDictationHelperEvent(payload: unknown): DictationHelperEvent | undefined {
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

const DICTATION_ACTIVE_EVENTS = new Set([
  "recording_ready",
  "listening_started",
  "audio_level",
  "finalizing_transcript",
  "final_transcript",
  "paste_target",
]);

const DICTATION_FINISHED_EVENTS = new Set([
  "recording_discarded",
  "paste_completed",
  "agent_session_prompt",
  "error",
  "helper_unavailable",
  "shutdown_ack",
]);

export function nextDictationWorkflowActive(current: boolean, eventType: string) {
  if (DICTATION_ACTIVE_EVENTS.has(eventType)) return true;
  if (DICTATION_FINISHED_EVENTS.has(eventType)) return false;
  return current;
}
