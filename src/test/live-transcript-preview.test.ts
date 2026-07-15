import { describe, expect, it } from "vitest";
import {
  clearTerminalLiveTranscriptEvents,
  coalesceLiveTranscriptEventsForDisplay,
  reconcileLiveTranscriptEvents,
  upsertLiveTranscriptEvent,
} from "../lib/live-transcript-preview";
import type { LiveTranscriptEventDto, TranscriptDto } from "../lib/tauri";

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

function persistedTurn(overrides: Partial<TranscriptDto> = {}): TranscriptDto {
  return {
    id: "turn-1",
    text: "Authoritative saved-audio words",
    recordingSessionId: "session-1",
    spanId: "span-1",
    sourceMode: "microphonePlusSystem",
    source: "microphone",
    startMs: 0,
    endMs: 8000,
    status: "succeeded",
    ...overrides,
  };
}

describe("live transcript preview", () => {
  it("preserves segment identity in state and only coalesces adjacent chunks for display", () => {
    const events = [
      liveEvent(),
      liveEvent({
        segmentId: "microphone-1",
        startMs: 8000,
        endMs: 16_000,
        text: "Second chunk",
      }),
    ].reduce(upsertLiveTranscriptEvent, [] as LiveTranscriptEventDto[]);

    expect(events.map((event) => event.segmentId)).toEqual(["microphone-0", "microphone-1"]);
    expect(coalesceLiveTranscriptEventsForDisplay(events)).toEqual([
      expect.objectContaining({
        source: "microphone",
        segmentId: "microphone-0",
        startMs: 0,
        endMs: 16_000,
        text: "First chunk Second chunk",
      }),
    ]);
  });

  it("does not truncate a long meeting's provisional segments", () => {
    const events = Array.from({ length: 300 }, (_, index) =>
      liveEvent({
        segmentId: `microphone-${index}`,
        startMs: index * 8000,
        endMs: (index + 1) * 8000,
        text: `Chunk ${index}`,
      }),
    ).reduce(upsertLiveTranscriptEvent, [] as LiveTranscriptEventDto[]);

    expect(events).toHaveLength(300);
    expect(events.at(0)?.segmentId).toBe("microphone-0");
    expect(events.at(-1)?.segmentId).toBe("microphone-299");
  });

  it("keeps same-source chunks separated across a material time gap", () => {
    const events = [
      liveEvent({ endMs: 4000, text: "Before pause" }),
      liveEvent({
        segmentId: "microphone-1",
        startMs: 6000,
        endMs: 8000,
        text: "After pause",
      }),
    ].reduce(upsertLiveTranscriptEvent, [] as LiveTranscriptEventDto[]);

    expect(coalesceLiveTranscriptEventsForDisplay(events).map((event) => event.text)).toEqual([
      "Before pause",
      "After pause",
    ]);
  });

  it("starts a new display turn when the source changes", () => {
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

    const displayed = coalesceLiveTranscriptEventsForDisplay(events);
    expect(displayed.map((event) => event.text)).toEqual([
      "Mic one",
      "System one System two",
      "Mic two",
    ]);
    expect(displayed.map((event) => event.source)).toEqual(["microphone", "system", "microphone"]);
  });

  it("orders out-of-order chunks for display without destroying their ids", () => {
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

    expect(events).toHaveLength(2);
    expect(coalesceLiveTranscriptEventsForDisplay(events)[0]).toEqual(
      expect.objectContaining({
        text: "First chunk Second chunk",
        startMs: 0,
        endMs: 16_000,
      }),
    );
  });

  it("lets an overlapping saved-audio row replace different preview text", () => {
    const events = [liveEvent({ text: "Provider guessed this text" })];

    expect(reconcileLiveTranscriptEvents(events, [persistedTurn()])).toEqual([]);
  });

  it("never reconciles a preview against another recording session", () => {
    const sessionA = liveEvent({ sessionId: "session-a", text: "Session A preview" });
    const sessionB = liveEvent({ sessionId: "session-b", text: "Session B preview" });

    expect(
      reconcileLiveTranscriptEvents(
        [sessionA, sessionB],
        [persistedTurn({ recordingSessionId: "session-a" })],
      ),
    ).toEqual([sessionB]);
  });

  it("never lets legacy unscoped rows erase a preview", () => {
    const legacy = persistedTurn({ recordingSessionId: undefined });
    expect(reconcileLiveTranscriptEvents([liveEvent()], [legacy])).toHaveLength(1);
  });

  it("never lets a failed or empty saved-audio row erase a preview", () => {
    const failed = persistedTurn({ status: "failed", text: "" });
    const empty = persistedTurn({ text: "   " });

    expect(reconcileLiveTranscriptEvents([liveEvent()], [failed])).toHaveLength(1);
    expect(reconcileLiveTranscriptEvents([liveEvent()], [empty])).toHaveLength(1);
  });

  it("clears only replaced terminal previews and preserves unmatched or active spans", () => {
    const inactive = liveEvent({ sessionId: "session-a" });
    const active = liveEvent({ sessionId: "session-b", segmentId: "microphone-b" });
    const otherNote = liveEvent({ noteId: "note-2", sessionId: "session-c" });
    const replaced = persistedTurn({ recordingSessionId: "session-a" });

    expect(
      clearTerminalLiveTranscriptEvents(
        [inactive, active, otherNote],
        "note-1",
        [replaced],
        ["session-b"],
      ),
    ).toEqual([active, otherNote]);
    expect(clearTerminalLiveTranscriptEvents([inactive, otherNote], "note-1", [])).toEqual([
      inactive,
      otherNote,
    ]);
  });

  it("preserves the event array when reconciliation removes nothing", () => {
    const events = [liveEvent()];

    expect(reconcileLiveTranscriptEvents(events, [])).toBe(events);
    expect(clearTerminalLiveTranscriptEvents(events, "note-1", [])).toBe(events);
  });
});
