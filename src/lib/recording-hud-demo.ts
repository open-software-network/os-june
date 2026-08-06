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
//   is live AND Clovy is backgrounded/minimized/hidden — Rust decides (see
//   src-tauri/src/meeting_hud.rs). So in-app these bus events only restyle
//   the pill if Rust is already showing it; the standalone page is the
//   primary sandbox for this driver. This driver never force-shows the window.
// - The standalone page (pnpm dev, open /meeting-hud.html in a browser):
//   events dispatch locally as window events; the Tauri bridge is absent.
//
// Never bundled in production: both registration sites gate the dynamic
// import on import.meta.env.DEV.

import { MEETING_END_STATE_EVENT } from "./events";
import type { MeetingEndStatus, RecordingStatusDto } from "./tauri";

type RecordingHudDemoOptions = {
  /** Dispatch window events on this page instead of emitting on the Tauri
   * bus. True on the standalone meeting-hud.html page. */
  local: boolean;
};

type DemoState = "recording" | "paused" | "vertical" | "horizontal" | "end" | "demo" | "clear";

const STATUS_EVENT = "meeting-hud-status";
const ZONE_EVENT = "meeting-hud-zone";

// Match the real active telemetry cadence so the standalone HUD has production
// waveform timing during visual review.
const STATUS_TICK_MS = 50;

const HELP = [
  "Recording pill demo states (meeting-hud window):",
  '  __recordingHud("recording")   live waveform + terracotta shimmer mark',
  '  __recordingHud("paused")      dimmed mark, no shimmer, dim bars',
  '  __recordingHud("vertical")    quarter-turn counter-rotation (left/right zone)',
  '  __recordingHud("horizontal")  flat orientation (middle zone)',
  '  __recordingHud("end", secs?)  meeting-end countdown card (default 15s)',
  '  __recordingHud("demo")        scripted: record, pause, resume, meeting ends',
  '  __recordingHud("clear")       stop timers; park to a quiet recording state',
  "",
  "Window rotation is Rust-side: on the standalone page only the CSS",
  "counter-turn is visible — the pill content rotates without the window",
  "turning. In the real app the native window only shows when a recording",
  "is live and Clovy is backgrounded/minimized/hidden (Rust-managed), so bus events here",
  "only restyle the pill if it is already on screen.",
  "",
  '"end" in the dev app arms the REAL meeting-end countdown on the live',
  "recording (start one first): the record dock shows the draining notice",
  "while Clovy is frontmost, and backgrounding Clovy pops the native card",
  "top-center; Keep/Stop/expiry drive the actual session — Stop now and the",
  '15s lapse genuinely finish the recording; "clear" suppresses it like Keep',
  "recording. On the standalone page the same card is faked in place and the",
  "seconds arg works.",
].join("\n");

export function registerRecordingHudDemo({ local }: RecordingHudDemoOptions) {
  if (typeof window === "undefined") return { dispose() {} };

  let timers: number[] = [];
  let statusTimer: number | undefined;
  let levelPhase = 0;

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
  function statusFor(state: RecordingStatusDto["state"], level: number): RecordingStatusDto {
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

  function emitMeetingEnd(payload: MeetingEndStatus | null) {
    if (local) {
      window.dispatchEvent(new CustomEvent(MEETING_END_STATE_EVENT, { detail: payload }));
      return;
    }
    void import("@tauri-apps/api/event")
      .then((api) => api.emit(MEETING_END_STATE_EVENT, payload))
      .catch(() => {});
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

  function end(seconds = 15) {
    cancelTimers();
    if (!local) {
      // Dev app: arm the REAL countdown on the live recording (debug-build
      // Rust command). Everything downstream is production behavior — the
      // native card force-shows bottom-center, the record dock ticks, and
      // Keep/Stop/expiry drive the actual session. No fake bus events here:
      // they would fight the real detector state.
      void import("@tauri-apps/api/core")
        .then((api) => api.invoke("debug_force_meeting_end_countdown"))
        .catch((error) => {
          console.warn('__recordingHud("end"):', error);
        });
      return;
    }
    // Standalone page: fake the state event locally. Recording continues
    // through the grace period — keep the levels alive behind the card so
    // collapsing back lands on a live pill.
    emitStatus(statusFor("recording", 0.5));
    startLevels();
    emitMeetingEnd({
      sessionId: "hud-demo-recording",
      phase: "countdown",
      expiresAtMs: Date.now() + seconds * 1000,
    });
    // When the countdown lapses the real detector finishes the recording and
    // the HUD window hides; here the card just collapses back to the pill.
    at(seconds * 1000, () => emitMeetingEnd(null));
  }

  function clear() {
    cancelTimers();
    if (local) {
      emitMeetingEnd(null);
    } else {
      // A REAL countdown may be live — suppress it the same way the Keep
      // recording button does, rather than faking a null state event that
      // would desync the UI from the detector.
      void import("@tauri-apps/api/core")
        .then(async (api) => {
          const status = await api.invoke<MeetingEndStatus | null>("pending_meeting_end_status");
          if (status?.phase === "countdown") {
            await api.invoke("keep_meeting_recording", { sessionId: status.sessionId });
          }
        })
        .catch(() => {});
    }
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
    at(13000, () => end(10));
    return "Lifecycle running (~23s): record, pause, resume, meeting ends, countdown lapses.";
  }

  // Standalone page only: the card's buttons invoke Tauri commands that don't
  // exist without the bridge, so mirror their outcome locally — either action
  // collapses the card back to the live pill.
  const localMeetingEndButtons = local
    ? ["mhud-end-keep", "mhud-end-stop"]
        .map((id) => document.getElementById(id))
        .filter((button): button is HTMLElement => button !== null)
    : [];
  const collapseLocalMeetingEnd = () => {
    cancelTimers();
    emitMeetingEnd(null);
    recording();
  };
  for (const button of localMeetingEndButtons) {
    button.addEventListener("click", collapseLocalMeetingEnd);
  }

  const hook = (state?: DemoState, seconds?: number) => {
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
      case "end":
        end(seconds);
        return 'Meeting-end countdown card. Keep/Stop or __recordingHud("clear") to collapse it.';
      case "demo":
        return demo();
      case "clear":
        clear();
        return "Cleared to a quiet recording state.";
      default:
        return HELP;
    }
  };

  const demoWindow = window as unknown as Record<string, unknown>;
  demoWindow.__recordingHud = hook;

  function dispose() {
    cancelTimers();
    for (const button of localMeetingEndButtons) {
      button.removeEventListener("click", collapseLocalMeetingEnd);
    }
    if (demoWindow.__recordingHud === hook) {
      delete demoWindow.__recordingHud;
    }
  }

  return { dispose };
}
