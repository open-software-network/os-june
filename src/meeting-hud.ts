import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  createBarMeter,
  IDLE_LEVEL,
  LIVE_WAVE_OPTIONS,
  RECORDER_BAR_COUNT,
  RECORDER_BAR_HISTORY_OFFSETS,
  RECORDER_BAR_WEIGHTS,
  withWaveLayers,
} from "./lib/audio-meter";
import { meterLevelForSources, visualPeakScale } from "./lib/recorder-levels";
import type { RecordingStatusDto } from "./lib/tauri";
import "./styles/meeting-hud.css";

const appWindow = getCurrentWindow();
const pill = document.querySelector<HTMLDivElement>("#mhud");
const bars = Array.from(document.querySelectorAll<HTMLElement>(".mhud-bar"));

// Shares the dictation HUD's + recorder bar's synthesis, ballistics, and
// travelling-wave motion so all waveforms move identically.
const meter = createBarMeter(
  RECORDER_BAR_COUNT,
  RECORDER_BAR_WEIGHTS,
  RECORDER_BAR_HISTORY_OFFSETS,
  LIVE_WAVE_OPTIONS,
);

// Coalesce the freshest peaks per poll, matching the in-app recorder
// (Waveform.tsx) so transients between status pushes aren't missed.
const POLL_WINDOW_PEAKS = 6;

let recording = false;

function applyStatus(status: RecordingStatusDto) {
  const paused = status.state === "paused";
  recording = status.state === "recording";

  if (pill) {
    pill.dataset.state = paused ? "paused" : "recording";
    pill.setAttribute(
      "aria-label",
      paused
        ? "Paused — click to open Scribe"
        : "Recording — click to open Scribe",
    );
  }

  // status.level is mic-only; status.sources carries mic+system when present.
  const level = meterLevelForSources(status.level, status.sources);
  const recent = level.recentPeaks;
  const raw =
    recent.length > 0
      ? Math.max(...recent.slice(-POLL_WINDOW_PEAKS))
      : level.peak;
  meter.pushLevel(visualPeakScale(raw));
}

// Orientation triad: parked in the left or right third of the screen the pill
// stands vertical (dot above the waveform); the middle third lies flat. Rust
// owns the turn itself — a Core Animation transform on the native contentView
// that carries frost, tint, and this whole DOM in one move. Our only job is
// the counter-turn: flip `data-orient` so CSS spins the bars back the other
// way (same duration/curve) and the waveform keeps reading left-to-right.
function applyZone(payload: { vertical: boolean; animate: boolean }) {
  if (!pill) return;
  if (!payload.animate) pill.classList.add("mhud-snap");
  pill.dataset.orient = payload.vertical ? "vertical" : "horizontal";
  if (!payload.animate) {
    // Let the snapped state paint before the transition comes back.
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => pill.classList.remove("mhud-snap"));
    });
  }
}

function startBarLoop() {
  const tick = (now: number) => {
    meter.step();
    // Overall loudness = the tallest bar right now; drives the speech wave.
    let speech = 0;
    for (let i = 0; i < bars.length; i++) {
      speech = Math.max(speech, meter.displayed[i]);
    }
    for (let i = 0; i < bars.length; i++) {
      const value = recording
        ? withWaveLayers(meter.displayed[i], i, now, speech, bars.length)
        : meter.displayed[i];
      bars[i].style.setProperty("--level", value.toFixed(3));
    }
    window.requestAnimationFrame(tick);
  };
  window.requestAnimationFrame(tick);
}

function resetBars() {
  for (const bar of bars) {
    bar.style.setProperty("--level", IDLE_LEVEL.toFixed(3));
  }
}

// Focus the main window from Rust (reliable app activation — clicking a
// non-activating panel won't bring a backgrounded app forward on its own); Rust
// then emits the action React uses to land back on the recording note.
function reopenScribe() {
  void invoke("meeting_hud_reopen").catch(() => {});
}

// One surface, two gestures: a press that moves past a small threshold drags
// the window; a press that stays put is a click → reopen Scribe. Handlers live
// on the document, not the pill: the native quarter-turn rotates pixels but
// not DOM hit-testing, so when the pill stands vertical a click on it lands in
// the DOM's gutter. The window is barely bigger than the pill, so document-
// wide is the honest target.
const DRAG_THRESHOLD_PX = 4;
let pressStart: { x: number; y: number } | undefined;
let dragging = false;

document.addEventListener("pointerdown", (event) => {
  if (event.button !== 0) return;
  pressStart = { x: event.screenX, y: event.screenY };
  dragging = false;
});

document.addEventListener("pointermove", (event) => {
  if (!pressStart || dragging) return;
  const dx = event.screenX - pressStart.x;
  const dy = event.screenY - pressStart.y;
  if (Math.hypot(dx, dy) > DRAG_THRESHOLD_PX) {
    dragging = true;
    // Native drag takes over the gesture; pointerup won't fire on the element,
    // so `dragging` stays true and suppresses the click below.
    void appWindow.startDragging().catch(() => {});
  }
});

document.addEventListener("pointerup", (event) => {
  if (event.button !== 0) return;
  const wasClick = !!pressStart && !dragging;
  pressStart = undefined;
  if (wasClick) reopenScribe();
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    reopenScribe();
  }
});

void listen<RecordingStatusDto>("meeting-hud-status", (event) => {
  if (event.payload) applyStatus(event.payload);
});

void listen<{ vertical: boolean; animate: boolean }>(
  "meeting-hud-zone",
  (event) => {
    if (event.payload) applyZone(event.payload);
  },
);

resetBars();
startBarLoop();

// Paint immediately if a recording is already live when this view appears.
void invoke<RecordingStatusDto | null>("meeting_hud_latest_status")
  .then((status) => {
    if (status) applyStatus(status);
  })
  .catch(() => {});
