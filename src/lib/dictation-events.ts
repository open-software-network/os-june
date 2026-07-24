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

// These two sets are mirrored in Rust by `indicator_action_for_event`
// (src-tauri/src/dictation.rs) which drives the native menu-bar dictation
// indicator. Keep the two in step, or the menu bar and the in-app state
// disagree about whether a take is running. (No automated parity test yet.)
const DICTATION_ACTIVE_EVENTS = new Set([
  "recording_ready",
  "listening_started",
  "audio_level",
  "finalizing_transcript",
  "paste_target",
]);

const DICTATION_FINISHED_EVENTS = new Set([
  "recording_discarded",
  "final_transcript",
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
