import { IconPause } from "central-icons-filled/IconPause";
import { IconPlay } from "central-icons-filled/IconPlay";
import { IconStop } from "central-icons-filled/IconStop";
import type { RecordingStatusDto } from "../../lib/tauri";
import { combineSourceAudioLevels, Waveform } from "./Waveform";

type RecorderBarProps = {
  status: RecordingStatusDto;
  onPause: (sessionId: string) => void;
  onResume: (sessionId: string) => void;
  onDone: (sessionId: string) => void;
};

export function RecorderBar({
  status,
  onPause,
  onResume,
  onDone,
}: RecorderBarProps) {
  const paused = status.state === "paused";
  const controlsEnabled =
    status.state === "recording" || status.state === "paused";
  // status.level is mic-only; status.sources carries mic+system when available.
  const meterLevel =
    status.sources && status.sources.length > 0
      ? combineSourceAudioLevels(status.sources)
      : status.level;
  const pauseLabel = paused
    ? "Resume"
    : status.state === "recording"
      ? "Pause"
      : status.state === "starting"
        ? "Starting"
        : "Finalizing";

  return (
    <div className="recorder-bar" data-state={status.state}>
      <button
        type="button"
        className="recorder-icon-button"
        disabled={!controlsEnabled}
        onClick={() =>
          paused ? onResume(status.sessionId) : onPause(status.sessionId)
        }
        aria-label={pauseLabel}
        title={pauseLabel}
      >
        {paused ? <IconPlay size={14} /> : <IconPause size={14} />}
      </button>
      <div className="recorder-meter">
        <span className="elapsed">{formatElapsed(status.elapsedMs)}</span>
        <Waveform level={meterLevel} active={status.state === "recording"} />
      </div>
      <button
        type="button"
        className="recorder-stop"
        disabled={!controlsEnabled}
        onClick={() => onDone(status.sessionId)}
        aria-label={controlsEnabled ? "Done" : "Working"}
        title={controlsEnabled ? "Done" : "Working"}
      >
        <IconStop size={14} />
      </button>
      {status.warnings?.map((warning) => (
        <p className="recorder-warning" role="status" key={warning.code}>
          {warning.message}
        </p>
      ))}
    </div>
  );
}

export function formatElapsed(ms: number) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
}
