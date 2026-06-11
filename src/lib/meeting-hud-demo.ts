// Dev-only console driver for the meeting-detection prompt in the dictation
// HUD window: window.__meetingHud("detected"), __meetingHud("detected",
// "Teams"), __meetingHud("demo"), ... Lets you park the prompt in any state
// or run a scripted detect-and-clear lifecycle without joining a real call.
// Mirrors lib/agent-hud-demo.ts.
//
// Two contexts, one command:
// - Main window devtools (Tauri dev app): events go out on the Tauri bus
//   only, driving the real overlay window — the same channel the Rust
//   detector emits on.
// - The standalone page (pnpm dev, open /hud.html in a browser): events
//   dispatch locally as window events; the Tauri bridge is absent.
//
// Never bundled in production: both registration sites gate the dynamic
// import on import.meta.env.DEV.

type MeetingHudDemoOptions = {
  /** Dispatch window events on this page instead of emitting on the Tauri
   * bus. True on the standalone hud.html page. */
  local: boolean;
};

type DemoState = "detected" | "multi" | "cleared" | "demo" | "clear";

const MEETING_DETECTION_EVENT = "meeting-detection-event";

const HELP = [
  "Meeting prompt demo states (dictation HUD window):",
  '  __meetingHud("detected", app?)  prompt shows (default app "Zoom")',
  '  __meetingHud("multi")           two apps hold the mic',
  '  __meetingHud("cleared")         meeting ends — prompt exits',
  '  __meetingHud("demo")            scripted lifecycle: detect, mic moves, clear',
  '  __meetingHud("clear")           alias of "cleared"; also resets timers',
  "",
  "Dismissing (X or the 30s timeout) suppresses the prompt until the",
  'meeting clears — run __meetingHud("cleared") first to prompt again.',
].join("\n");

let timers: number[] = [];

export function registerMeetingHudDemo({ local }: MeetingHudDemoOptions) {
  if (typeof window === "undefined") return;

  function emitDetection(type: string, appLabels: string[]) {
    const envelope = {
      type,
      payload: { activeProcessCount: appLabels.length, appLabels },
    };
    if (local) {
      window.dispatchEvent(
        new CustomEvent(MEETING_DETECTION_EVENT, { detail: envelope }),
      );
      return;
    }
    void import("@tauri-apps/api/event")
      .then((api) => api.emit(MEETING_DETECTION_EVENT, envelope))
      .catch(() => {});
  }

  function cancelTimers() {
    for (const timer of timers) window.clearTimeout(timer);
    timers = [];
  }

  function at(delayMs: number, run: () => void) {
    timers.push(window.setTimeout(run, delayMs));
  }

  function detected(appLabels: string[]) {
    cancelTimers();
    emitDetection("meeting_detected", appLabels);
  }

  function cleared() {
    cancelTimers();
    emitDetection("meeting_cleared", []);
  }

  function demo() {
    cleared();
    at(400, () => emitDetection("meeting_detected", ["Zoom"]));
    at(6000, () => emitDetection("meeting_detected", ["Zoom", "Chrome"]));
    at(12000, () => emitDetection("meeting_cleared", []));
    return "Lifecycle running (~12s): detect Zoom, Chrome joins the mic, meeting clears.";
  }

  (window as unknown as Record<string, unknown>).__meetingHud = (
    state?: DemoState,
    app = "Zoom",
  ) => {
    switch (state) {
      case "detected":
        detected([app]);
        return `Meeting detected in ${app}. __meetingHud("cleared") to end it.`;
      case "multi":
        detected(["Zoom", "Chrome"]);
        return 'Two apps on the mic. __meetingHud("cleared") to end it.';
      case "cleared":
      case "clear":
        cleared();
        return "Meeting cleared; the prompt can show again.";
      case "demo":
        return demo();
      default:
        return HELP;
    }
  };
}
