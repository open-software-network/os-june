import { useEffect, useRef } from "react";
import type {
  AudioLevelDto,
  RecordingSource,
  SourceStatusDto,
} from "../../lib/tauri";
import {
  clamp,
  createBarMeter,
  IDLE_LEVEL,
  RECORDER_BAR_COUNT,
  RECORDER_BAR_HISTORY_OFFSETS,
  RECORDER_BAR_WEIGHTS,
} from "../../lib/audio-meter";

type WaveformProps = {
  level: AudioLevelDto;
};

// Below this the input reads as silence — a soft downward expander that keeps
// room/ambient hiss pinned to zero (bars collapse to the base dot). Whispers
// sit just above it. Raise if ambient creeps in; lower if whispers don't show.
const NOISE_FLOOR = 0.004;
// Sub-1 power that lifts quiet input (whispers) toward visibility before the
// knee. Lower = more low-end lift.
const LOW_LIFT = 0.6;
// Soft-knee steepness — loud speech approaches the ceiling asymptotically
// instead of slamming flat. Higher reaches the ceiling sooner.
const KNEE = 6;

export function Waveform({ level }: WaveformProps) {
  const refs = useRef<Array<HTMLSpanElement | null>>([]);
  // Shares the dictation HUD's synthesis + ballistics, with the recorder's own
  // taller 7-bar layout.
  const meterRef = useRef(
    createBarMeter(
      RECORDER_BAR_COUNT,
      RECORDER_BAR_WEIGHTS,
      RECORDER_BAR_HISTORY_OFFSETS,
    ),
  );

  // Feed a sample into the meter on every poll (keyed on the level prop, not the
  // shaped value — silence collapses to a constant 0, and we still want the
  // history ring to advance each poll). The rAF loop animates the bars toward
  // it (fast attack, smooth release, snap-to-zero on silence).
  useEffect(() => {
    const raw =
      level.recentPeaks.length > 0
        ? level.recentPeaks[level.recentPeaks.length - 1]
        : level.peak;
    meterRef.current.pushLevel(visualPeakScale(raw));
  }, [level]);

  useEffect(() => {
    const meter = meterRef.current;
    let raf = 0;
    const tick = () => {
      meter.step();
      for (let i = 0; i < RECORDER_BAR_COUNT; i++) {
        const el = refs.current[i];
        if (el) el.style.setProperty("--level", meter.displayed[i].toFixed(3));
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div className="waveform" aria-label="Audio activity">
      {Array.from({ length: RECORDER_BAR_COUNT }, (_, index) => (
        <span
          key={index}
          style={{ ["--level" as string]: IDLE_LEVEL }}
          ref={(el) => {
            refs.current[index] = el;
          }}
        />
      ))}
    </div>
  );
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

export function visualPeakScale(peak: number) {
  const normalized = clamp(peak, 0, 1);
  // Downward expander: anything at/below the noise floor reads as silence so
  // the bars can collapse to zero (the base dot) instead of shimmering.
  const gated = (normalized - NOISE_FLOOR) / (1 - NOISE_FLOOR);
  if (gated <= 0) {
    return 0;
  }
  // Lift whispers with a sub-1 power, then soft-knee the top so loud speech
  // approaches the ceiling without ever slamming flat against it.
  const shaped = 1 - Math.exp(-KNEE * Math.pow(gated, LOW_LIFT));
  return clamp(shaped, 0, 1);
}
