import { useEffect, useRef } from "react";
import type { AudioLevelDto } from "../../lib/tauri";
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
    <div className="waveform" aria-label="Microphone activity">
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
