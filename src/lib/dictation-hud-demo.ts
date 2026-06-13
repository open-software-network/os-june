// Dev-only console driver for the dictation pill in the HUD window:
// window.__dictationHud("listening"), __dictationHud("error"),
// __dictationHud("demo"), ... Lets you park the pill in any state or run a
// scripted listen-transcribe-paste lifecycle without a real dictation
// session. Mirrors lib/agent-hud-demo.ts and lib/meeting-hud-demo.ts.
//
// Two contexts, one command:
// - Main window devtools (Tauri dev app): events go out on the Tauri bus
//   only, driving the real dictation HUD window — the same channel the Rust
//   helper emits on.
// - The standalone page (pnpm dev, open /hud.html in a browser): events
//   dispatch locally as window events; the Tauri bridge is absent.
//
// The meeting-detection prompt that lives in this same window has its own
// driver: __meetingHud("detected"). See lib/meeting-hud-demo.ts.
//
// Never bundled in production: both registration sites gate the dynamic
// import on import.meta.env.DEV.

type DictationHudDemoOptions = {
  /** Dispatch window events on this page instead of emitting on the Tauri
   * bus. True on the standalone hud.html page. */
  local: boolean;
};

type DemoState =
  | "listening"
  | "transcribing"
  | "pasting"
  | "error"
  | "silent"
  | "demo"
  | "clear";

const DICTATION_EVENT = "dictation-event";

// Audio levels arrive on a tight cadence from the Rust helper; ~90ms reads as
// a live meter without pinning the loop.
const LEVEL_TICK_MS = 90;

const HELP = [
  "Dictation pill demo states (HUD window):",
  '  __dictationHud("listening")     pill listens with a live waveform',
  '  __dictationHud("transcribing")  stopped, braille processing texture',
  '  __dictationHud("pasting")       pasting into the previous app',
  '  __dictationHud("error")         a visible failure (shakes, lingers ~1.8s)',
  '  __dictationHud("silent")        nothing recorded — pill just dissolves',
  '  __dictationHud("demo")          scripted lifecycle: listen, transcribe, paste',
  '  __dictationHud("clear")         stop timers and dismiss the pill',
  "",
  "The meeting-detection prompt in this same window has its own driver:",
  '  __meetingHud("detected")',
].join("\n");

let timers: number[] = [];

export function registerDictationHudDemo({ local }: DictationHudDemoOptions) {
  if (typeof window === "undefined") return;

  function emitDictation(type: string, payload?: Record<string, unknown>) {
    const envelope = { type, payload };
    if (local) {
      window.dispatchEvent(
        new CustomEvent(DICTATION_EVENT, { detail: envelope }),
      );
      return;
    }
    void import("@tauri-apps/api/event")
      .then((api) => api.emit(DICTATION_EVENT, envelope))
      .catch(() => {});
  }

  function cancelTimers() {
    for (const timer of timers) window.clearTimeout(timer);
    window.clearInterval(levelTimer);
    levelTimer = undefined;
    timers = [];
  }

  function at(delayMs: number, run: () => void) {
    timers.push(window.setTimeout(run, delayMs));
  }

  // A slow sine carrier plus a touch of jitter reads as speech far better than
  // a flat level or pure noise; phase advances with each tick.
  let levelTimer: number | undefined;
  let levelPhase = 0;
  function startLevels() {
    window.clearInterval(levelTimer);
    levelPhase = 0;
    levelTimer = window.setInterval(() => {
      levelPhase += 1;
      const carrier = 0.45 + 0.35 * Math.sin(levelPhase * 0.18);
      const jitter = (Math.random() - 0.5) * 0.25;
      const level = Math.max(0, Math.min(1, carrier + jitter));
      emitDictation("audio_level", { level: level.toFixed(3) });
    }, LEVEL_TICK_MS);
  }

  function listening() {
    cancelTimers();
    emitDictation("listening_started");
    startLevels();
  }

  function transcribing() {
    cancelTimers();
    emitDictation("finalizing_transcript");
  }

  function pasting() {
    cancelTimers();
    emitDictation("paste_target", { app: "Notes" });
  }

  function error() {
    cancelTimers();
    // A real-world message long enough to exercise the expanded error card.
    emitDictation("error", {
      message: "Dictation recorded no text. Try again.",
    });
  }

  function silent() {
    cancelTimers();
    // The silent-classified end: Rust marks payload.silent so the HUD takes
    // the graceful exit and says nothing.
    emitDictation("error", { silent: true });
  }

  function clear() {
    cancelTimers();
    // recording_discarded is the clean "ended without a result" path — it runs
    // the same hideHud dissolve the helper uses when a recording is dropped.
    emitDictation("recording_discarded");
  }

  function demo() {
    cancelTimers();
    emitDictation("listening_started");
    startLevels();
    at(3500, () => {
      window.clearInterval(levelTimer);
      levelTimer = undefined;
      emitDictation("finalizing_transcript");
    });
    at(5500, () => emitDictation("paste_target", { app: "Notes" }));
    at(7000, () => emitDictation("paste_completed"));
    return "Lifecycle running (~7s): listen with live levels, transcribe, paste, done.";
  }

  (window as unknown as Record<string, unknown>).__dictationHud = (
    state?: DemoState,
  ) => {
    switch (state) {
      case "listening":
        listening();
        return 'Listening with a live waveform. __dictationHud("clear") to dismiss.';
      case "transcribing":
        transcribing();
        return 'Transcribing. __dictationHud("clear") to dismiss.';
      case "pasting":
        pasting();
        return 'Pasting into Notes. __dictationHud("clear") to dismiss.';
      case "error":
        error();
        return "Error: shakes, then fades after ~1.8s.";
      case "silent":
        silent();
        return "Silent end: the pill dissolves with no message.";
      case "demo":
        return demo();
      case "clear":
        clear();
        return "Cleared.";
      default:
        return HELP;
    }
  };
}
