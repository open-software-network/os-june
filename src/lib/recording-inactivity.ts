import type { AudioLevelDto, RecordingStatusDto } from "./tauri";

export const RECORDING_INACTIVITY_MIN_ELAPSED_MS = 10 * 60 * 1000;
export const RECORDING_INACTIVITY_QUIET_MS = 5 * 60 * 1000;
export const RECORDING_INACTIVITY_RESPONSE_MS = 30 * 1000;
export const RECORDING_INACTIVITY_SNOOZE_MS = 10 * 60 * 1000;
export const RECORDING_INACTIVITY_LEVEL_THRESHOLD = 0.015;

export type RecordingInactivityTracker = {
  sessionId?: string;
  quietStartedAt?: number;
  snoozedUntil?: number;
};

export type RecordingInactivityDecision = {
  tracker: RecordingInactivityTracker;
  shouldPrompt: boolean;
};

export function nextRecordingInactivityDecision(
  tracker: RecordingInactivityTracker,
  status: RecordingStatusDto | undefined,
  now: number,
): RecordingInactivityDecision {
  if (!status || status.state !== "recording") {
    return { tracker: {}, shouldPrompt: false };
  }

  const sameSession = tracker.sessionId === status.sessionId;
  const baseTracker = sameSession
    ? tracker
    : { sessionId: status.sessionId };

  if (status.elapsedMs < RECORDING_INACTIVITY_MIN_ELAPSED_MS) {
    return {
      tracker: {
        sessionId: status.sessionId,
        snoozedUntil: baseTracker.snoozedUntil,
      },
      shouldPrompt: false,
    };
  }

  if (recordingHasActivity(status)) {
    return {
      tracker: {
        sessionId: status.sessionId,
        snoozedUntil: baseTracker.snoozedUntil,
      },
      shouldPrompt: false,
    };
  }

  if (baseTracker.snoozedUntil && now < baseTracker.snoozedUntil) {
    return {
      tracker: {
        ...baseTracker,
        quietStartedAt: undefined,
      },
      shouldPrompt: false,
    };
  }

  const quietStartedAt = baseTracker.quietStartedAt ?? now;
  const nextTracker = {
    sessionId: status.sessionId,
    quietStartedAt,
    snoozedUntil: baseTracker.snoozedUntil,
  };

  return {
    tracker: nextTracker,
    shouldPrompt: now - quietStartedAt >= RECORDING_INACTIVITY_QUIET_MS,
  };
}

export function recordingHasActivity(status: RecordingStatusDto) {
  return recordingActivityLevel(status) >= RECORDING_INACTIVITY_LEVEL_THRESHOLD;
}

export function recordingActivityLevel(status: RecordingStatusDto) {
  const sourceLevels =
    status.sources && status.sources.length > 0
      ? status.sources.map((source) => source.level)
      : [status.level];
  return Math.max(0, ...sourceLevels.map(activityLevel));
}

function activityLevel(level: AudioLevelDto | undefined) {
  if (!level) return 0;
  if (level.recentPeaks.length > 0) {
    return Math.max(...level.recentPeaks);
  }
  return level.rms;
}
