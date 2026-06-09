import type { AudioLevelDto, RecordingSource, SourceStatusDto } from "./tauri";
import { clamp, scaleLiveInputPeak } from "./audio-meter";

// Shaping + source-mixing for the recorder waveform. Lives here (rather than in
// the React Waveform component) so both the in-app recorder bar and the
// vanilla-TS meeting HUD can share one source of truth. The peak shaping math
// itself (noise floor, whisper lift, soft knee) lives in audio-meter as
// scaleLiveInputPeak.

export function visualPeakScale(peak: number) {
  return scaleLiveInputPeak(peak);
}

export function combineAudioLevels(
  levels: Array<AudioLevelDto | undefined>,
): AudioLevelDto {
  const present = levels.filter((l): l is AudioLevelDto => !!l);
  if (present.length === 0) {
    return { peak: 0, rms: 0, recentPeaks: [] };
  }
  if (present.length === 1) {
    return present[0];
  }
  const peak = Math.max(...present.map((l) => l.peak));
  const rms = Math.max(...present.map((l) => l.rms));
  // The meter reads the newest sample from the tail, so align histories there.
  const maxLen = Math.max(...present.map((l) => l.recentPeaks.length));
  const recentPeaks = new Array<number>(maxLen).fill(0);
  for (const level of present) {
    const offset = maxLen - level.recentPeaks.length;
    for (let i = 0; i < level.recentPeaks.length; i++) {
      recentPeaks[offset + i] = Math.max(
        recentPeaks[offset + i],
        level.recentPeaks[i],
      );
    }
  }
  return { peak, rms, recentPeaks };
}

export function combineSourceAudioLevels(
  sources: SourceStatusDto[],
): AudioLevelDto {
  return combineAudioLevels(
    sources.map((source) =>
      scaleAudioLevel(source.level, SOURCE_VISUAL_GAIN[source.source]),
    ),
  );
}

// System audio arrives as boosted RMS from the macOS helper; keep this visual
// only so capture, validation, and silence detection continue using raw levels.
export const SOURCE_VISUAL_GAIN: Record<RecordingSource, number> = {
  microphone: 1,
  system: 0.15,
};

export function scaleAudioLevel(
  level: AudioLevelDto,
  gain: number,
): AudioLevelDto {
  if (gain === 1) {
    return level;
  }
  const scale = (value: number) => clamp(value * gain, 0, 1);
  return {
    peak: scale(level.peak),
    rms: scale(level.rms),
    recentPeaks: level.recentPeaks.map(scale),
  };
}

// Convenience for callers that have a RecordingStatus-shaped object: prefer the
// per-source mix when both mic + system are present, else the mic-only level.
export function meterLevelForSources(
  level: AudioLevelDto,
  sources?: SourceStatusDto[],
): AudioLevelDto {
  return sources && sources.length > 0
    ? combineSourceAudioLevels(sources)
    : level;
}
