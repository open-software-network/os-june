// Dev-only console driver for the recording pill window (the "meeting-hud"
// native window, src/meeting-hud.ts): window.__recordingHud("recording"),
// __recordingHud("paused"), __recordingHud("demo"), ... Lets you park the
// pill in any state or run a scripted record-pause-resume lifecycle without
// a real recording. Mirrors lib/agent-hud-demo.ts and lib/meeting-hud-demo.ts.
// (Named __recordingHud because __meetingHud already drives the dictation
// window's meeting-detection prompt.)
//
// Two contexts, one command:
// - Main window devtools (Tauri dev app): events go out on the Tauri bus
//   only, the same channels Rust pushes status and zone changes on. CAVEAT:
//   in the real app the meeting-hud native window only shows when a recording
//   is live AND the main window is hidden/minimized — Rust decides (see
//   src-tauri/src/meeting_hud.rs). So in-app these bus events only restyle
//   the pill if Rust is already showing it; the standalone page is the
//   primary sandbox for this driver. This driver never force-shows the window.
// - The standalone page (pnpm dev, open /meeting-hud.html in a browser):
//   events dispatch locally as window events; the Tauri bridge is absent.
//
// Never bundled in production: both registration sites gate the dynamic
// import on import.meta.env.DEV.

import type { RecordingStatusDto } from "./tauri";

type RecordingHudDemoOptions = {
  /** Dispatch window events on this page instead of emitting on the Tauri
   * bus. True on the standalone meeting-hud.html page. */
  local: boolean;
};

type DemoState =
  | "recording"
  | "paused"
  | "vertical"
  | "horizontal"
  | "demo"
  | "clear";

const STATUS_EVENT = "meeting-hud-status";
const ZONE_EVENT = "meeting-hud-zone";

// Status pushes carry fresh peaks; ~90ms keeps the waveform alive without
// pinning the loop.
const STATUS_TICK_MS = 90;

const HELP = [
  "Recording pill demo states (meeting-hud window):",
  '  __recordingHud("recording")   live waveform + terracotta shimmer mark',
  '  __recordingHud("paused")      dimmed mark, no shimmer, dim bars',
  '  __recordingHud("vertical")    quarter-turn counter-rotation (left/right zone)',
  '  __recordingHud("horizontal")  flat orientation (middle zone)',
  '  __recordingHud("demo")        scripted: record, pause, resume, back to flat',
  '  __recordingHud("clear")       stop timers; park to a quiet recording state',
  "",
  "Window rotation is Rust-side: on the standalone page only the CSS",
  "counter-turn is visible — the pill content rotates without the window",
  "turning. In the real app the native window only shows when a recording",
  "is live and the main window is hidden (Rust-managed), so bus events here",
  "only restyle the pill if it is already on screen.",
].join("\n");

let timers: number[] = [];
let statusTimer: number | undefined;
let levelPhase = 0;

export function registerRecordingHudDemo({ local }: RecordingHudDemoOptions) {
  if (typeof window === "undefined") return;

  function emitStatus(status: RecordingStatusDto) {
    if (local) {
      window.dispatchEvent(new CustomEvent(STATUS_EVENT, { detail: status }));
      return;
    }
    void import("@tauri-apps/api/event")
      .then((api) => api.emit(STATUS_EVENT, status))
      .catch(() => {});
  }

  function emitZone(payload: { vertical: boolean; animate: boolean }) {
    if (local) {
      window.dispatchEvent(new CustomEvent(ZONE_EVENT, { detail: payload }));
      return;
    }
    void import("@tauri-apps/api/event")
      .then((api) => api.emit(ZONE_EVENT, payload))
      .catch(() => {});
  }

  // A slow sine carrier plus jitter reads as speech; recentPeaks feeds the
  // meter's coalescing tail (applyStatus reads the last few) so the bars move.
  function statusFor(
    state: RecordingStatusDto["state"],
    level: number,
  ): RecordingStatusDto {
    const recentPeaks = Array.from({ length: 6 }, (_, i) =>
      Math.max(0, Math.min(1, level + (Math.random() - 0.5) * 0.2 - i * 0.02)),
    );
    return {
      sessionId: "hud-demo-recording",
      sourceMode: "microphoneOnly",
      state,
      elapsedMs: levelPhase * STATUS_TICK_MS,
      level: { peak: level, rms: level * 0.7, recentPeaks },
      silenceWarning: false,
      bytesWritten: 0,
    };
  }

  function cancelTimers() {
    for (const timer of timers) window.clearTimeout(timer);
    window.clearInterval(statusTimer);
    statusTimer = undefined;
    timers = [];
  }

  function at(delayMs: number, run: () => void) {
    timers.push(window.setTimeout(run, delayMs));
  }

  function startLevels() {
    window.clearInterval(statusTimer);
    levelPhase = 0;
    statusTimer = window.setInterval(() => {
      levelPhase += 1;
      const carrier = 0.45 + 0.35 * Math.sin(levelPhase * 0.18);
      const jitter = (Math.random() - 0.5) * 0.25;
      const level = Math.max(0, Math.min(1, carrier + jitter));
      emitStatus(statusFor("recording", level));
    }, STATUS_TICK_MS);
  }

  function recording() {
    cancelTimers();
    emitStatus(statusFor("recording", 0.5));
    startLevels();
  }

  function paused() {
    cancelTimers();
    emitStatus(statusFor("paused", 0.12));
  }

  function clear() {
    cancelTimers();
    // The pill has no hidden state of its own — the native window's visibility
    // is Rust-managed. Park it on a quiet recording state so the standalone
    // page stops animating without going blank.
    emitStatus(statusFor("recording", 0.08));
  }

  function demo() {
    cancelTimers();
    emitZone({ vertical: false, animate: true });
    emitStatus(statusFor("recording", 0.5));
    startLevels();
    at(4000, () => {
      window.clearInterval(statusTimer);
      statusTimer = undefined;
      emitStatus(statusFor("paused", 0.12));
    });
    at(7000, () => recording());
    at(11000, () => emitZone({ vertical: false, animate: true }));
    return "Lifecycle running (~11s): record with levels, pause, resume, back to flat.";
  }

  (window as unknown as Record<string, unknown>).__recordingHud = (
    state?: DemoState,
  ) => {
    switch (state) {
      case "recording":
        recording();
        return 'Recording with a live waveform. __recordingHud("clear") to quiet it.';
      case "paused":
        paused();
        return 'Paused: dimmed mark, dim bars. __recordingHud("recording") to resume.';
      case "vertical":
        emitZone({ vertical: true, animate: true });
        return "Vertical zone: pill content counter-rotates (window turn is Rust-side).";
      case "horizontal":
        emitZone({ vertical: false, animate: true });
        return "Horizontal zone: flat orientation.";
      case "demo":
        return demo();
      case "clear":
        clear();
        return "Cleared to a quiet recording state.";
      default:
        return HELP;
    }
  };
}
