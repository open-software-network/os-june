import { useRef, useState } from "react";

export type MicTestState = "idle" | "recording" | "ready" | "error";

type MicTestControlProps = {
  state: MicTestState;
  level: number;
  elapsedMs: number;
  sampleSrc?: string;
  error?: string;
  playing: boolean;
  durationSeconds: number;
  onStart: () => void;
  onStartOver: () => void;
  onPlaybackError: () => void;
  onPlayingChange: (playing: boolean) => void;
};

export function MicTestControl({
  state,
  level,
  elapsedMs,
  sampleSrc,
  error,
  playing,
  durationSeconds,
  onStart,
  onStartOver,
  onPlaybackError,
  onPlayingChange,
}: MicTestControlProps) {
  return (
    <div className="settings-row settings-row-mic-test">
      <div className="settings-row-info">
        <h3 className="settings-row-title">Mic test</h3>
        <p className="settings-row-description">{micTestDescription(state)}</p>
        {error ? <p className="settings-row-error">{error}</p> : null}
      </div>
      <div className="settings-row-control settings-mic-test-control">
        {state === "recording" ? (
          <>
            <div className="settings-mic-test-meter">
              <div
                className="settings-mic-test-meter-fill"
                role="progressbar"
                aria-label="Microphone test level"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(level * 100)}
                style={{
                  transform: `scaleX(${Math.max(0, Math.min(1, level))})`,
                }}
              />
            </div>
            <span className="settings-mic-test-time">
              {formatMicTestTime(elapsedMs, durationSeconds)} /{" "}
              {formatMicTestDuration(durationSeconds)}
            </span>
          </>
        ) : null}
        {sampleSrc && state === "ready" ? (
          <MicTestPlayer
            src={sampleSrc}
            playing={playing}
            durationSeconds={durationSeconds}
            onPlaybackError={onPlaybackError}
            onPlayingChange={onPlayingChange}
          />
        ) : null}
        {state === "ready" ? (
          <button
            type="button"
            className="btn btn-secondary"
            disabled={playing}
            onClick={onStartOver}
          >
            Start over
          </button>
        ) : null}
        {state !== "recording" && state !== "ready" ? (
          <button type="button" className="btn btn-secondary" onClick={onStart}>
            Start test
          </button>
        ) : null}
      </div>
    </div>
  );
}

function micTestDescription(state: MicTestState) {
  if (state === "recording") {
    return "Recording 5-second sample.";
  }
  if (state === "ready") {
    return "Sample ready. Check volume.";
  }
  return "Check your microphone.";
}

function formatMicTestTime(milliseconds: number, durationSeconds: number) {
  const seconds = Math.min(
    durationSeconds,
    Math.floor(Math.max(0, milliseconds) / 1000),
  );
  return formatMicTestDuration(seconds);
}

function formatMicTestDuration(seconds: number) {
  return `00:${seconds.toString().padStart(2, "0")}`;
}

function MicTestPlayer({
  src,
  playing,
  durationSeconds,
  onPlaybackError,
  onPlayingChange,
}: {
  src: string;
  playing: boolean;
  durationSeconds: number;
  onPlaybackError: () => void;
  onPlayingChange: (playing: boolean) => void;
}) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(durationSeconds);

  async function playSample() {
    const audio = audioRef.current;
    if (!audio) return;
    try {
      audio.currentTime = 0;
      setCurrentTime(0);
      await audio.play();
      onPlayingChange(true);
    } catch {
      onPlayingChange(false);
      onPlaybackError();
    }
  }

  function seek(nextValue: string) {
    const next = Number(nextValue);
    if (!Number.isFinite(next)) return;
    setCurrentTime(next);
    if (audioRef.current) {
      audioRef.current.currentTime = next;
    }
  }

  return (
    <>
      <audio
        ref={audioRef}
        className="settings-mic-test-hidden-audio"
        src={src}
        preload="metadata"
        onLoadedMetadata={(event) => {
          const nextDuration = event.currentTarget.duration;
          if (Number.isFinite(nextDuration) && nextDuration > 0) {
            setDuration(nextDuration);
          }
        }}
        onTimeUpdate={(event) =>
          setCurrentTime(event.currentTarget.currentTime)
        }
        onPause={() => onPlayingChange(false)}
        onPlay={() => onPlayingChange(true)}
        onEnded={() => {
          onPlayingChange(false);
          setCurrentTime(0);
          if (audioRef.current) audioRef.current.currentTime = 0;
        }}
        onError={onPlaybackError}
      />
      {playing ? (
        <input
          className="settings-mic-test-mini-scrubber"
          type="range"
          min={0}
          max={Math.max(duration, durationSeconds)}
          step={0.1}
          value={Math.min(currentTime, duration)}
          aria-label="Microphone test playback progress"
          onChange={(event) => seek(event.currentTarget.value)}
        />
      ) : (
        <button
          type="button"
          className="btn btn-secondary"
          aria-label="Play microphone test sample"
          onClick={() => void playSample()}
        >
          Play sample
        </button>
      )}
    </>
  );
}
