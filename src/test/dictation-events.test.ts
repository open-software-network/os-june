import { describe, expect, it } from "vitest";
import { nextDictationWorkflowActive, parseDictationHelperEvent } from "../lib/dictation-events";

describe("parseDictationHelperEvent", () => {
  it("parses valid JSON helper events", () => {
    expect(
      parseDictationHelperEvent(
        JSON.stringify({
          type: "final_transcript",
          payload: { message: "Done" },
        }),
      ),
    ).toEqual({
      type: "final_transcript",
      payload: { message: "Done" },
    });
  });

  it("accepts object helper events", () => {
    expect(parseDictationHelperEvent({ type: "permission_status" })?.type).toBe(
      "permission_status",
    );
  });

  it("parses helper_unavailable events with a reason", () => {
    expect(
      parseDictationHelperEvent({
        type: "helper_unavailable",
        payload: { reason: "restarting", message: "Dictation stopped and is restarting." },
      }),
    ).toEqual({
      type: "helper_unavailable",
      payload: { reason: "restarting", message: "Dictation stopped and is restarting." },
    });
  });

  it("ignores malformed payloads and events without a string type", () => {
    expect(parseDictationHelperEvent("{")).toBeUndefined();
    expect(parseDictationHelperEvent({ payload: {} })).toBeUndefined();
    expect(parseDictationHelperEvent({ type: "" })).toBeUndefined();
  });
});

describe("dictation workflow activity", () => {
  it.each([
    "recording_ready",
    "listening_started",
    "audio_level",
    "finalizing_transcript",
    "paste_target",
  ])("treats %s as active", (eventType) => {
    expect(nextDictationWorkflowActive(false, eventType)).toBe(true);
  });

  it.each([
    "recording_discarded",
    "final_transcript",
    "paste_completed",
    "agent_session_prompt",
    "error",
    "helper_unavailable",
    "shutdown_ack",
  ])("treats %s as finished", (eventType) => {
    expect(nextDictationWorkflowActive(true, eventType)).toBe(false);
  });

  it("preserves state for unrelated helper events", () => {
    expect(nextDictationWorkflowActive(true, "permission_status")).toBe(true);
    expect(nextDictationWorkflowActive(false, "dictation_diagnostics")).toBe(false);
  });
});
