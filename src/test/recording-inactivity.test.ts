import { describe, expect, it } from "vitest";
import {
  RECORDING_INACTIVITY_MIN_ELAPSED_MS,
  RECORDING_INACTIVITY_QUIET_MS,
  RECORDING_INACTIVITY_SNOOZE_MS,
  nextRecordingInactivityDecision,
  recordingActivityLevel,
  recordingHasActivity,
  type RecordingInactivityTracker,
} from "../lib/recording-inactivity";
import type { RecordingStatusDto } from "../lib/tauri";

function status(overrides: Partial<RecordingStatusDto> = {}): RecordingStatusDto {
  return {
    sessionId: "session-1",
    state: "recording",
    elapsedMs: RECORDING_INACTIVITY_MIN_ELAPSED_MS,
    level: { peak: 0, rms: 0, recentPeaks: [0] },
    silenceWarning: false,
    bytesWritten: 1024,
    ...overrides,
  };
}

describe("recording inactivity", () => {
  it("waits until a recording is old enough before tracking quiet time", () => {
    const decision = nextRecordingInactivityDecision(
      {},
      status({ elapsedMs: RECORDING_INACTIVITY_MIN_ELAPSED_MS - 1 }),
      1_000,
    );

    expect(decision.shouldPrompt).toBe(false);
    expect(decision.tracker.quietStartedAt).toBeUndefined();
  });

  it("opens the prompt after a continuous quiet stretch", () => {
    const first = nextRecordingInactivityDecision({}, status(), 1_000);
    const second = nextRecordingInactivityDecision(
      first.tracker,
      status(),
      1_000 + RECORDING_INACTIVITY_QUIET_MS,
    );

    expect(first.shouldPrompt).toBe(false);
    expect(second.shouldPrompt).toBe(true);
  });

  it("uses recent audio instead of all-time peak for quiet detection", () => {
    const quietAfterSpeech = status({
      level: { peak: 0.8, rms: 0.05, recentPeaks: [0, 0] },
    });

    expect(recordingActivityLevel(quietAfterSpeech)).toBe(0);
    expect(recordingHasActivity(quietAfterSpeech)).toBe(false);
  });

  it("keeps source activity from opening the prompt", () => {
    const activeSystemAudio = status({
      level: { peak: 0.001, rms: 0.001, recentPeaks: [0.001] },
      sources: [
        {
          source: "microphone",
          state: "recording",
          elapsedMs: RECORDING_INACTIVITY_MIN_ELAPSED_MS,
          bytesWritten: 1024,
          level: { peak: 0.001, rms: 0.001, recentPeaks: [0.001] },
          silenceWarning: false,
          pathFinalized: false,
        },
        {
          source: "system",
          state: "recording",
          elapsedMs: RECORDING_INACTIVITY_MIN_ELAPSED_MS,
          bytesWritten: 1024,
          level: { peak: 0.7, rms: 0.1, recentPeaks: [0.05] },
          silenceWarning: false,
          pathFinalized: false,
        },
      ],
    });
    const tracker: RecordingInactivityTracker = {
      sessionId: "session-1",
      quietStartedAt: 1_000,
    };

    const decision = nextRecordingInactivityDecision(
      tracker,
      activeSystemAudio,
      1_000 + RECORDING_INACTIVITY_QUIET_MS,
    );

    expect(decision.shouldPrompt).toBe(false);
    expect(decision.tracker.quietStartedAt).toBeUndefined();
  });

  it("snoozes quiet prompts after the user keeps recording", () => {
    const tracker: RecordingInactivityTracker = {
      sessionId: "session-1",
      quietStartedAt: 1_000,
      snoozedUntil: 1_000 + RECORDING_INACTIVITY_SNOOZE_MS,
    };

    const decision = nextRecordingInactivityDecision(
      tracker,
      status(),
      1_000 + RECORDING_INACTIVITY_QUIET_MS,
    );

    expect(decision.shouldPrompt).toBe(false);
    expect(decision.tracker.quietStartedAt).toBe(1_000);
  });

  it("prompts immediately after the snooze expires when audio stayed quiet", () => {
    const tracker: RecordingInactivityTracker = {
      sessionId: "session-1",
      quietStartedAt: 1_000,
      snoozedUntil: 1_000 + RECORDING_INACTIVITY_SNOOZE_MS,
    };

    const decision = nextRecordingInactivityDecision(
      tracker,
      status(),
      1_000 + RECORDING_INACTIVITY_SNOOZE_MS,
    );

    expect(decision.shouldPrompt).toBe(true);
  });

  it("resets when the recording is no longer active", () => {
    const decision = nextRecordingInactivityDecision(
      { sessionId: "session-1", quietStartedAt: 1_000 },
      status({ state: "paused" }),
      1_000 + RECORDING_INACTIVITY_QUIET_MS,
    );

    expect(decision).toEqual({ tracker: {}, shouldPrompt: false });
  });
});
