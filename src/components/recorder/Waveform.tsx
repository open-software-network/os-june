import { useEffect, useRef } from "react";
import type { AudioLevelDto } from "../../lib/tauri";

type WaveformProps = {
  level: AudioLevelDto;
};

const BAR_COUNT = 8;
const FLOOR = 0.06;
const GAIN = 11;

export function Waveform({ level }: WaveformProps) {
  const refs = useRef<Array<HTMLSpanElement | null>>([]);
  const targets = computeTargetPeaks(level);

  useEffect(() => {
    for (let i = 0; i < BAR_COUNT; i++) {
      const el = refs.current[i];
      if (el) el.style.setProperty("--bar-fill", targets[i].toFixed(3));
    }
  });

  return (
    <div className="waveform" aria-label="Microphone activity">
      {Array.from({ length: BAR_COUNT }, (_, index) => (
        <span
          key={index}
          ref={(el) => {
            refs.current[index] = el;
          }}
        />
      ))}
    </div>
  );
}

function computeTargetPeaks(level: AudioLevelDto) {
  const source =
    level.recentPeaks.length > 0
      ? level.recentPeaks.slice(-BAR_COUNT)
      : [level.rms, level.peak, level.rms];
  return Array.from({ length: BAR_COUNT }, (_, index) => {
    const sourceIndex = Math.floor((index / BAR_COUNT) * source.length);
    const peak = source[sourceIndex] ?? level.rms;
    const neighbor = source[sourceIndex - 1] ?? peak;
    const next = source[sourceIndex + 1] ?? peak;
    const rolloff = 0.78 + Math.sin(index * 0.85) * 0.12;
    const blended = Math.max(
      0,
      (neighbor * 0.22 + peak * 0.56 + next * 0.22) * rolloff,
    );
    return visualPeakScale(blended);
  });
}

export function visualPeakScale(peak: number) {
  const normalized = Math.max(0, Math.min(1, peak));
  if (normalized <= 0.002) {
    return FLOOR;
  }
  return Math.min(1, Math.max(FLOOR, Math.sqrt(normalized * GAIN)));
}
