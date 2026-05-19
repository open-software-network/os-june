import type { AudioLevelDto } from "../../lib/tauri";

type WaveformProps = {
  level: AudioLevelDto;
};

export function Waveform({ level }: WaveformProps) {
  const peaks =
    level.recentPeaks.length > 0
      ? level.recentPeaks
      : [level.peak, level.rms, level.peak];

  return (
    <div className="waveform" aria-label="Microphone activity">
      {peaks.slice(-24).map((peak, index) => (
        <span
          key={`${index}-${peak}`}
          style={{ transform: `scaleY(${visualPeakScale(peak)})` }}
        />
      ))}
    </div>
  );
}

export function visualPeakScale(peak: number) {
  const normalized = Math.max(0, Math.min(1, peak));
  if (normalized <= 0.002) {
    return 0.08;
  }
  return Math.min(1, Math.max(0.08, Math.sqrt(normalized * 10)));
}
