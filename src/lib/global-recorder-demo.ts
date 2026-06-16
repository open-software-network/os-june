// Dev-only console driver for the in-app recorder presence (sidebar header when
// available, floating fallback when the sidebar is collapsed).
//
//   window.__globalRecorderPill("recording")  contained live waveform
//   window.__globalRecorderPill("paused")     dimmed contained waveform
//   window.__globalRecorderPill("clear")      dismiss the demo indicator
//
// Unlike the native HUD drivers (recording-hud-demo.ts et al.), this pill is
// React state inside the main window, so the driver pushes synthetic status
// objects straight into a React setter rather than onto the Tauri bus. It
// force-shows the presence regardless of which view/note you're on, so you can
// park it and inspect the styling without a real recording. Never bundled in
// production: App gates the dynamic import on import.meta.env.DEV.

import type { RecordingStatusDto } from "./tauri";

export type GlobalRecorderDemoApi = {
  /** Tear down timers and remove the window hook. */
  dispose: () => void;
  /** Drive the demo from callers that still need to script the state. */
  pause: () => void;
  resume: () => void;
  stop: () => void;
};

// Push cadence: a fresh synthetic level a touch faster than the real 50ms-ish
// poll, enough to keep the coalescing waveform alive without pinning a core.
const TICK_MS = 90;

const HELP = [
  "Global recorder presence demo (sidebar header or floating fallback):",
  '  __globalRecorderPill("recording")  contained live waveform',
  '  __globalRecorderPill("paused")     dimmed contained waveform',
  '  __globalRecorderPill("clear")      dismiss the demo indicator',
  "",
  "Force-shows the recorder presence on any view, no real recording needed.",
  "Dev only.",
].join("\n");

export function registerGlobalRecorderDemo({
  setStatus,
}: {
  setStatus: (status: RecordingStatusDto | null) => void;
}): GlobalRecorderDemoApi {
  let timer: number | undefined;
  let phase = 0;
  let elapsedMs = 0;

  function buildStatus(
    state: RecordingStatusDto["state"],
    level: number,
  ): RecordingStatusDto {
    // recentPeaks feeds the waveform's coalescing tail; a slight per-entry
    // falloff reads as a freshest-first window like the real poll.
    const recentPeaks = Array.from({ length: 6 }, (_, i) =>
      Math.max(0, Math.min(1, level + (Math.random() - 0.5) * 0.2 - i * 0.02)),
    );
    return {
      sessionId: "global-recorder-demo",
      sourceMode: "microphonePlusSystem",
      state,
      elapsedMs,
      level: { peak: level, rms: level * 0.7, recentPeaks },
      silenceWarning: false,
      bytesWritten: 0,
    };
  }

  function stopTimer() {
    if (timer !== undefined) {
      window.clearInterval(timer);
      timer = undefined;
    }
  }

  // A slow sine carrier plus jitter reads as speech; the timer also advances
  // only while live, so pausing freezes the elapsed clock like the real one.
  function startLevels() {
    stopTimer();
    timer = window.setInterval(() => {
      phase += 1;
      elapsedMs += TICK_MS;
      const carrier = 0.45 + 0.35 * Math.sin(phase * 0.18);
      const jitter = (Math.random() - 0.5) * 0.25;
      const level = Math.max(0, Math.min(1, carrier + jitter));
      setStatus(buildStatus("recording", level));
    }, TICK_MS);
  }

  function recording() {
    setStatus(buildStatus("recording", 0.5));
    startLevels();
  }

  function paused() {
    stopTimer();
    setStatus(buildStatus("paused", 0.12));
  }

  function stop() {
    stopTimer();
    phase = 0;
    elapsedMs = 0;
    setStatus(null);
  }

  const hook = (state?: string) => {
    switch (state) {
      case "recording":
        recording();
        return 'Recording indicator with a live waveform. __globalRecorderPill("clear") to dismiss.';
      case "paused":
        paused();
        return 'Paused: dimmed waveform. __globalRecorderPill("recording") to resume.';
      case "clear":
      case "stop":
        stop();
        return "Demo indicator dismissed.";
      default:
        return HELP;
    }
  };

  (window as unknown as Record<string, unknown>).__globalRecorderPill = hook;

  function dispose() {
    stopTimer();
    delete (window as unknown as Record<string, unknown>).__globalRecorderPill;
  }

  return { dispose, pause: paused, resume: recording, stop };
}
