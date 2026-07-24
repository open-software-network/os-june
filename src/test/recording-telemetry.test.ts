import { describe, expect, it } from "vitest";
import { mergeRecordingTelemetry, sameRecordingSemantics } from "../lib/recording-telemetry";
import type { RecordingStatusDto, RecordingTelemetryDto } from "../lib/tauri";

function status(): RecordingStatusDto {
  return {
    sessionId: "session-1",
    noteId: "note-1",
    sourceMode: "microphonePlusSystem",
    state: "recording",
    elapsedMs: 100,
    level: { peak: 0.1, rms: 0.05, recentPeaks: [0.1] },
    silenceWarning: false,
    bytesWritten: 4096,
    livePreviewEnabled: true,
    sources: [
      {
        source: "microphone",
        state: "recording",
        elapsedMs: 100,
        bytesWritten: 4096,
        level: { peak: 0.1, rms: 0.05, recentPeaks: [0.1] },
        silenceWarning: false,
        pathFinalized: false,
      },
    ],
    warnings: [],
  };
}

function telemetry(overrides: Partial<RecordingTelemetryDto> = {}): RecordingTelemetryDto {
  return {
    sessionId: "session-1",
    state: "recording",
    elapsedMs: 250,
    level: { peak: 0.7, rms: 0.4, recentPeaks: [0.5, 0.7] },
    silenceWarning: true,
    sources: [
      {
        source: "microphone",
        state: "recording",
        elapsedMs: 250,
        level: { peak: 0.7, rms: 0.4, recentPeaks: [0.5, 0.7] },
        silenceWarning: true,
      },
    ],
    warnings: [
      {
        source: "microphone",
        code: "microphone_stream_stalled",
        message: "Microphone input stopped unexpectedly.",
      },
    ],
    ...overrides,
  };
}

describe("recording telemetry", () => {
  it("updates dynamic fields while preserving stable command metadata", () => {
    const merged = mergeRecordingTelemetry(status(), telemetry());

    expect(merged).toEqual(
      expect.objectContaining({
        sessionId: "session-1",
        noteId: "note-1",
        sourceMode: "microphonePlusSystem",
        elapsedMs: 250,
        silenceWarning: true,
        bytesWritten: 4096,
        livePreviewEnabled: true,
      }),
    );
    expect(merged?.sources?.[0]).toEqual(
      expect.objectContaining({
        elapsedMs: 250,
        bytesWritten: 4096,
        pathFinalized: false,
        silenceWarning: true,
      }),
    );
    expect(merged?.warnings).toHaveLength(1);
  });

  it("clears only the matching session when native capture becomes idle", () => {
    expect(mergeRecordingTelemetry(status(), telemetry({ state: "idle" }))).toBeUndefined();

    const current = status();
    expect(
      mergeRecordingTelemetry(current, telemetry({ sessionId: "newer-session", state: "idle" })),
    ).toBe(current);
  });
});

describe("same recording semantics", () => {
  it("ignores elapsed time and level-only changes", () => {
    const current = status();
    const currentSource = current.sources?.[0];
    if (!currentSource) throw new Error("expected microphone Source");

    expect(
      sameRecordingSemantics(current, {
        ...current,
        elapsedMs: 900,
        level: { peak: 0.8, rms: 0.5, recentPeaks: [0.7, 0.8] },
        sources: [
          {
            ...currentSource,
            elapsedMs: 900,
            level: { peak: 0.8, rms: 0.5, recentPeaks: [0.7, 0.8] },
          },
        ],
      }),
    ).toBe(true);
  });

  it("detects per-Source state and silence warnings plus warning-set changes", () => {
    const current = status();
    const currentSource = current.sources?.[0];
    if (!currentSource) throw new Error("expected microphone Source");

    expect(
      sameRecordingSemantics(current, {
        ...current,
        sources: [{ ...currentSource, state: "paused" }],
      }),
    ).toBe(false);
    expect(
      sameRecordingSemantics(current, {
        ...current,
        sources: [{ ...currentSource, silenceWarning: true }],
      }),
    ).toBe(false);
    expect(
      sameRecordingSemantics(current, {
        ...current,
        warnings: [
          {
            source: "microphone",
            code: "microphone_stream_stalled",
            message: "Microphone input stopped unexpectedly.",
          },
        ],
      }),
    ).toBe(false);
  });
});
