import { describe, expect, it } from "vitest";
import { parseDictationHelperEvent } from "../lib/dictation-events";

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
