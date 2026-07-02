import { IconPause } from "central-icons-filled/IconPause";
import { IconPlay } from "central-icons-filled/IconPlay";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  localAudioFileSrc,
  type RecordingTrimPreviewDto,
  type TrimRangeDto,
} from "../../lib/tauri";
import { Dialog } from "../ui/Dialog";
import { Spinner } from "../ui/Spinner";
import { formatElapsed } from "./RecorderBar";

type TrimRecordingDialogProps = {
  open: boolean;
  /** The waveform + duration, once `prepare_recording_trim` resolves. */
  preview?: RecordingTrimPreviewDto;
  /** True while the preview is still being computed in the backend. */
  preparing: boolean;
  /** True while the finalize (trim + transcribe) call is in flight. */
  busy: boolean;
  /**
   * Finalize the recording. `null` keeps the full clip; a range trims to it.
   * Dismissing the dialog (Esc / close button) finalizes the full clip so a
   * stopped recording is never left unprocessed.
   */
  onConfirm: (trim: TrimRangeDto | null) => void;
};

// Don't let the selection collapse to nothing — keep at least a sliver of audio
// so a fumbled drag can't produce an empty recording.
const MIN_SELECTION_MS = 500;
// A bound within this distance of the clip edge counts as "not trimmed" on that
// side, so a near-but-not-exact handle still sends the full clip.
const EDGE_EPSILON_MS = 60;

type Edge = "start" | "end";

export function TrimRecordingDialog({
  open,
  preview,
  preparing,
  busy,
  onConfirm,
}: TrimRecordingDialogProps) {
  const duration = preview?.durationMs ?? 0;
  const [startMs, setStartMs] = useState(0);
  const [endMs, setEndMs] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [playheadMs, setPlayheadMs] = useState(0);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const draggingRef = useRef<Edge | null>(null);
  const scrubbingRef = useRef(false);
  // Mic + system are captured to separate WAVs aligned on the same wall clock,
  // so we play them together (the browser mixes their output) to reproduce what
  // the user heard. The playhead follows the furthest-along element (see
  // handleTimeUpdate) so an early-ending source doesn't freeze it.
  const audioEls = useRef<(HTMLAudioElement | null)[]>([]);
  const sources = useMemo(() => preview?.sources ?? [], [preview]);

  // Reset the handles to span the whole clip whenever a new preview arrives.
  useEffect(() => {
    if (!preview) return;
    setStartMs(0);
    setEndMs(preview.durationMs);
    setPlayheadMs(0);
    setPlaying(false);
  }, [preview]);

  const forEachAudio = useCallback((fn: (el: HTMLAudioElement) => void) => {
    for (const el of audioEls.current) {
      if (el) fn(el);
    }
  }, []);

  const pausePlayback = useCallback(() => {
    forEachAudio((el) => el.pause());
    setPlaying(false);
  }, [forEachAudio]);

  const seekMs = useCallback(
    (ms: number) => {
      const clamped = Math.min(Math.max(0, ms), duration);
      forEachAudio((el) => {
        // Guard: jsdom and unloaded media can throw on currentTime assignment.
        try {
          el.currentTime = clamped / 1000;
        } catch {
          /* ignore */
        }
      });
      setPlayheadMs(clamped);
    },
    [duration, forEachAudio],
  );

  // Stop playback whenever the dialog closes or the finalize spinner takes over.
  useEffect(() => {
    if (!open || busy) pausePlayback();
  }, [open, busy, pausePlayback]);

  const togglePlay = useCallback(() => {
    if (busy || duration <= 0 || sources.length === 0) return;
    if (playing) {
      pausePlayback();
      return;
    }
    // Auditioning the kept region: start at the head unless it's outside the
    // selection, in which case begin at the start handle.
    if (playheadMs < startMs || playheadMs >= endMs) {
      seekMs(startMs);
    }
    forEachAudio((el) => {
      void el.play?.()?.catch(() => {
        /* autoplay/format errors shouldn't wedge the modal */
      });
    });
    setPlaying(true);
  }, [
    busy,
    duration,
    sources.length,
    playing,
    playheadMs,
    startMs,
    endMs,
    seekMs,
    pausePlayback,
    forEachAudio,
  ]);

  function handleTimeUpdate() {
    // Don't fight an active scrub: seekMs already set the playhead there.
    if (scrubbingRef.current) return;
    // Drive the playhead from the furthest-along source. Sources can differ in
    // length (mic vs system) and `duration` is their max, so keying off a single
    // (possibly shorter) element would freeze the playhead before endMs.
    const ms = Math.max(0, ...audioEls.current.map((el) => el?.currentTime ?? 0)) * 1000;
    // Stop at the end handle so playback previews exactly the kept audio.
    if (playing && ms >= endMs) {
      pausePlayback();
      seekMs(endMs);
      return;
    }
    setPlayheadMs(ms);
  }

  // Natural end: only stop once every source has finished, so the longer source
  // isn't cut off when a shorter one ends first.
  function handleEnded() {
    if (audioEls.current.every((el) => !el || el.ended || el.paused)) {
      pausePlayback();
      seekMs(endMs);
    }
  }

  // Clamp the min-selection offsets to [0, duration] too, so a clip shorter than
  // MIN_SELECTION_MS can't invert the bounds into a negative start or an end past
  // the clip (the handles just stop moving instead).
  const clampStart = useCallback(
    (value: number) => Math.min(Math.max(0, value), Math.max(0, endMs - MIN_SELECTION_MS)),
    [endMs],
  );
  const clampEnd = useCallback(
    (value: number) =>
      Math.max(Math.min(duration, value), Math.min(duration, startMs + MIN_SELECTION_MS)),
    [duration, startMs],
  );

  const msFromClientX = useCallback(
    (clientX: number) => {
      const track = trackRef.current;
      if (!track || duration <= 0) return 0;
      const rect = track.getBoundingClientRect();
      const fraction = (clientX - rect.left) / rect.width;
      return Math.round(Math.min(1, Math.max(0, fraction)) * duration);
    },
    [duration],
  );

  useEffect(() => {
    if (!open) return;
    function onMove(event: PointerEvent) {
      const edge = draggingRef.current;
      if (edge) {
        const value = msFromClientX(event.clientX);
        if (edge === "start") setStartMs(clampStart(value));
        else setEndMs(clampEnd(value));
      } else if (scrubbingRef.current) {
        seekMs(msFromClientX(event.clientX));
      }
    }
    function onUp() {
      draggingRef.current = null;
      scrubbingRef.current = false;
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [open, msFromClientX, clampStart, clampEnd, seekMs]);

  function beginDrag(edge: Edge, event: React.PointerEvent) {
    if (busy) return;
    event.preventDefault();
    draggingRef.current = edge;
  }

  // Click or drag anywhere on the track (but not on a handle) moves the playhead
  // so the user can scrub to a spot and hear it.
  function beginScrub(event: React.PointerEvent) {
    if (busy || duration <= 0) return;
    if ((event.target as HTMLElement).closest(".trim-handle")) return;
    scrubbingRef.current = true;
    seekMs(msFromClientX(event.clientX));
  }

  function nudge(edge: Edge, deltaMs: number) {
    if (edge === "start") setStartMs((value) => clampStart(value + deltaMs));
    else setEndMs((value) => clampEnd(value + deltaMs));
  }

  function onHandleKeyDown(edge: Edge, event: React.KeyboardEvent) {
    // ~1% of the clip per press (min 250ms), Shift for a coarser jump.
    const step = Math.max(250, Math.round(duration / 100));
    const coarse = event.shiftKey ? step * 5 : step;
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      nudge(edge, -coarse);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      nudge(edge, coarse);
    }
  }

  const trimmed = startMs > EDGE_EPSILON_MS || endMs < duration - EDGE_EPSILON_MS;
  const selectedMs = Math.max(0, endMs - startMs);

  const startPct = duration > 0 ? (startMs / duration) * 100 : 0;
  const endPct = duration > 0 ? (endMs / duration) * 100 : 100;
  const playheadPct = duration > 0 ? Math.min(100, Math.max(0, (playheadMs / duration) * 100)) : 0;

  const peaks = preview?.peaks ?? [];
  const bars = useMemo(
    () =>
      peaks.map((peak, index) => {
        const position = peaks.length > 1 ? index / (peaks.length - 1) : 0;
        const ms = position * duration;
        const inside = ms >= startMs && ms <= endMs;
        // Floor the height so silent stretches still read as a faint baseline.
        const height = Math.max(0.06, Math.min(1, peak));
        return { height, inside, key: index };
      }),
    [peaks, duration, startMs, endMs],
  );

  function handleClose() {
    if (preparing || busy) return;
    onConfirm(null);
  }

  return (
    <Dialog
      open={open}
      onClose={handleClose}
      title="Trim recording"
      description="Play it back and drag the handles to cut silence or off-topic audio from the start or end before it's transcribed."
      width={640}
      className="trim-recording-dialog"
      disableBackdropClose
      footer={
        <>
          <button
            type="button"
            className="primary-action"
            onClick={() => onConfirm(null)}
            disabled={busy || preparing}
          >
            Use full recording
          </button>
          <button
            type="button"
            className="primary-action primary-solid"
            onClick={() =>
              onConfirm(trimmed ? { startMs: Math.round(startMs), endMs: Math.round(endMs) } : null)
            }
            disabled={busy || preparing || duration <= 0}
          >
            {busy ? "Saving…" : trimmed ? "Trim and transcribe" : "Save and transcribe"}
          </button>
        </>
      }
    >
      {preparing || !preview ? (
        <div className="trim-loading">
          <Spinner />
          <p>Preparing waveform…</p>
        </div>
      ) : (
        <div className="trim-body">
          {sources.map((source, index) => (
            <audio
              key={source.path}
              ref={(el) => {
                audioEls.current[index] = el;
              }}
              src={localAudioFileSrc(source.path)}
              preload="auto"
              onTimeUpdate={handleTimeUpdate}
              onEnded={handleEnded}
            />
          ))}
          <div
            className="trim-track"
            ref={trackRef}
            data-busy={busy ? "true" : undefined}
            onPointerDown={beginScrub}
          >
            <div className="trim-waveform" aria-hidden="true">
              {bars.map((bar) => (
                <span
                  key={bar.key}
                  className={`trim-bar${bar.inside ? "" : " trim-bar-muted"}`}
                  style={{ height: `${bar.height * 100}%` }}
                />
              ))}
            </div>
            <div
              className="trim-shade trim-shade-start"
              style={{ width: `${startPct}%` }}
              aria-hidden="true"
            />
            <div
              className="trim-shade trim-shade-end"
              style={{ width: `${100 - endPct}%` }}
              aria-hidden="true"
            />
            <div className="trim-playhead" style={{ left: `${playheadPct}%` }} aria-hidden="true" />
            <button
              type="button"
              className="trim-handle trim-handle-start"
              style={{ left: `${startPct}%` }}
              onPointerDown={(event) => beginDrag("start", event)}
              onKeyDown={(event) => onHandleKeyDown("start", event)}
              role="slider"
              aria-label="Trim start"
              aria-valuemin={0}
              aria-valuemax={Math.round(duration)}
              aria-valuenow={Math.round(startMs)}
              aria-valuetext={formatElapsed(startMs)}
              disabled={busy}
            />
            <button
              type="button"
              className="trim-handle trim-handle-end"
              style={{ left: `${endPct}%` }}
              onPointerDown={(event) => beginDrag("end", event)}
              onKeyDown={(event) => onHandleKeyDown("end", event)}
              role="slider"
              aria-label="Trim end"
              aria-valuemin={0}
              aria-valuemax={Math.round(duration)}
              aria-valuenow={Math.round(endMs)}
              aria-valuetext={formatElapsed(endMs)}
              disabled={busy}
            />
          </div>
          <div className="trim-transport">
            <button
              type="button"
              className="trim-play"
              onClick={togglePlay}
              disabled={busy || duration <= 0 || sources.length === 0}
              aria-label={playing ? "Pause" : "Play"}
              aria-pressed={playing}
            >
              {playing ? <IconPause size={18} /> : <IconPlay size={18} />}
            </button>
            <span className="trim-playhead-time">{formatElapsed(playheadMs)}</span>
          </div>
          <div className="trim-readout">
            <span className="trim-time">{formatElapsed(startMs)}</span>
            <span className="trim-duration">
              {trimmed
                ? `Keeping ${formatElapsed(selectedMs)} of ${formatElapsed(duration)}`
                : `Full recording, ${formatElapsed(duration)}`}
            </span>
            <span className="trim-time">{formatElapsed(endMs)}</span>
          </div>
        </div>
      )}
    </Dialog>
  );
}
