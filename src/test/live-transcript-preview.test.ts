import { describe, expect, it } from "vitest";
import { upsertLiveTranscriptEvent } from "../lib/live-transcript-preview";
import type { LiveTranscriptEventDto } from "../lib/tauri";

function liveEvent(overrides: Partial<LiveTranscriptEventDto> = {}): LiveTranscriptEventDto {
  return {
    noteId: "note-1",
    sessionId: "session-1",
    sourceMode: "microphonePlusSystem",
    source: "microphone",
    segmentId: "microphone-0",
    startMs: 0,
    endMs: 8000,
    text: "First chunk",
    language: "en",
    stability: "final",
    ...overrides,
  };
}

describe("upsertLiveTranscriptEvent", () => {
  it("appends adjacent same-source preview chunks into one running turn", () => {
    const events = [
      liveEvent(),
      liveEvent({
        segmentId: "microphone-1",
        startMs: 8000,
        endMs: 16_000,
        text: "Second chunk",
      }),
    ].reduce(upsertLiveTranscriptEvent, [] as LiveTranscriptEventDto[]);

    expect(events).toEqual([
      expect.objectContaining({
        source: "microphone",
        segmentId: "microphone-0",
        startMs: 0,
        endMs: 16_000,
        text: "First chunk Second chunk",
      }),
    ]);
  });

  it("starts a new live turn when the source changes", () => {
    const events = [
      liveEvent({ segmentId: "microphone-0", text: "Mic one" }),
      liveEvent({
        source: "system",
        segmentId: "system-0",
        startMs: 8000,
        endMs: 16_000,
        text: "System one",
      }),
      liveEvent({
        source: "system",
        segmentId: "system-1",
        startMs: 16_000,
        endMs: 24_000,
        text: "System two",
      }),
      liveEvent({
        segmentId: "microphone-1",
        startMs: 24_000,
        endMs: 32_000,
        text: "Mic two",
      }),
    ].reduce(upsertLiveTranscriptEvent, [] as LiveTranscriptEventDto[]);

    expect(events.map((event) => event.text)).toEqual([
      "Mic one",
      "System one System two",
      "Mic two",
    ]);
    expect(events.map((event) => event.source)).toEqual(["microphone", "system", "microphone"]);
    expect(events.map((event) => [event.startMs, event.endMs])).toEqual([
      [0, 8000],
      [8000, 24_000],
      [24_000, 32_000],
    ]);
  });

  it("orders same-source chunks before appending them", () => {
    const events = [
      liveEvent({
        segmentId: "microphone-1",
        startMs: 8000,
        endMs: 16_000,
        text: "Second chunk",
      }),
      liveEvent({
        segmentId: "microphone-0",
        startMs: 0,
        endMs: 8000,
        text: "First chunk",
      }),
    ].reduce(upsertLiveTranscriptEvent, [] as LiveTranscriptEventDto[]);

    expect(events).toHaveLength(1);
    expect(events[0]?.text).toBe("First chunk Second chunk");
    expect(events[0]?.startMs).toBe(0);
    expect(events[0]?.endMs).toBe(16_000);
  });
});
