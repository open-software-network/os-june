import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { spinners } from "unicode-animations";
import {
  clamp,
  createBarMeter,
  HUD_BAR_HISTORY_OFFSETS,
  HUD_BAR_WEIGHTS,
  IDLE_LEVEL,
} from "./lib/audio-meter";
import "./styles/hud.css";

type DictationHudEvent = {
  type: string;
  payload?: {
    app?: string;
    code?: string;
    message?: string;
    level?: string;
    [key: string]: unknown;
  };
};

const appWindow = getCurrentWindow();
const hud = document.querySelector<HTMLDivElement>("#hud");
const dragHandle = document.querySelector<HTMLElement>("#hud-handle");
const bars = Array.from(document.querySelectorAll<HTMLElement>(".hud-bar"));
const brailleNode = document.querySelector<HTMLElement>("#hud-braille");
const errorText = document.querySelector<HTMLElement>("#hud-error-text");
const stopButton = document.querySelector<HTMLButtonElement>("#hud-stop");
const statusText = document.querySelector<HTMLElement>("#hud-status");

let hideTimer: number | undefined;
let brailleTimer: number | undefined;
let brailleFrame = 0;

// waverows shows multiple horizontal rows of dots flowing across — reads as a
// "thinking/processing" texture rather than a single dot bouncing.
const brailleWave = spinners.waverows;

// Matches the .hud[data-state="exiting"] transition in hud.css.
const EXIT_TRANSITION_MS = 160;

// Bar synthesis + ballistics live in the shared meter so the recorder waveform
// moves identically. The meter holds the level history and the displayed bars.
// Sized to the actual bar count so meter.displayed always matches bars.length.
const meter = createBarMeter(
  bars.length,
  HUD_BAR_WEIGHTS,
  HUD_BAR_HISTORY_OFFSETS,
);

let rafHandle: number | undefined;
let lastAudioLevelAt = 0;
const IDLE_RAF_TIMEOUT_MS = 260;
// Lowered so a whisper crosses into the "voice" regime instead of being capped
// at the ambient ceiling — quiet speech now reads on the bars. Raise back toward
// 0.012 if room ambient starts lighting them up.
const AUDIO_NOISE_GATE = 0.008;
const AUDIO_VISUAL_GAIN = 16;
const AMBIENT_VISUAL_GAIN = 4;
const AMBIENT_MAX_LEVEL = 0.11;

function setHud(state: string, status: string) {
  if (!hud || !statusText) return;
  const previous = hud.dataset.state;
  hud.dataset.state = state;
  statusText.textContent = status;
  if (errorText) {
    errorText.textContent =
      state === "silent-error" || state === "error" ? status : "";
  }
  if (state === "transcribing" || state === "pasting") {
    startBraille();
  } else if (previous === "transcribing" || previous === "pasting") {
    stopBraille();
  }
  if (state === "listening") {
    startBarLoop();
    if (previous !== "listening") {
      pushStopBoundsToNative();
    }
  } else if (previous === "listening") {
    clearStopHover();
  }
  // Pill width varies by state, so refresh the cached pill rect for native
  // click pass-through whenever the state changes.
  if (state !== previous && hud) {
    hud.offsetWidth;
    pushPillBoundsToNative();
  }
}

function startBarLoop() {
  if (rafHandle !== undefined) return;
  const tick = () => {
    const stillAnimating = meter.step();
    for (let i = 0; i < bars.length; i++) {
      bars[i].style.setProperty("--level", meter.displayed[i].toFixed(3));
    }
    const sinceAudio = performance.now() - lastAudioLevelAt;
    if (stillAnimating || sinceAudio < IDLE_RAF_TIMEOUT_MS) {
      rafHandle = window.requestAnimationFrame(tick);
    } else {
      rafHandle = undefined;
    }
  };
  rafHandle = window.requestAnimationFrame(tick);
}

function resetBars() {
  meter.reset();
  for (let i = 0; i < bars.length; i++) {
    bars[i].style.setProperty("--level", IDLE_LEVEL.toFixed(3));
  }
  lastAudioLevelAt = performance.now();
}

function renderAudioLevel(rawLevel: number) {
  const shaped =
    rawLevel <= AUDIO_NOISE_GATE
      ? clamp(Math.sqrt(rawLevel * AMBIENT_VISUAL_GAIN), 0, AMBIENT_MAX_LEVEL)
      : clamp(
          AMBIENT_MAX_LEVEL +
            Math.sqrt((rawLevel - AUDIO_NOISE_GATE) * AUDIO_VISUAL_GAIN),
          0,
          1,
        );
  lastAudioLevelAt = performance.now();
  meter.pushLevel(shaped);
  startBarLoop();
}

function startBraille() {
  if (!brailleNode || brailleTimer !== undefined) return;
  brailleFrame = 0;
  brailleNode.textContent = brailleWave.frames[0] ?? "";
  brailleTimer = window.setInterval(() => {
    brailleFrame = (brailleFrame + 1) % brailleWave.frames.length;
    if (brailleNode) {
      brailleNode.textContent = brailleWave.frames[brailleFrame] ?? "";
    }
  }, brailleWave.interval);
}

function stopBraille() {
  if (brailleTimer !== undefined) {
    window.clearInterval(brailleTimer);
    brailleTimer = undefined;
  }
}

function setStopHover(isHovered: boolean) {
  stopButton?.classList.toggle("is-hovered", isHovered);
}

// Hover + click pass-through are computed in Rust against rects we push from
// here. WebKit throttles JS timers on the non-key HUD panel, so any polling
// done in JS only fires reliably during a mouse-down.
function pushStopBoundsToNative() {
  if (!stopButton || hud?.dataset.state !== "listening") {
    void invoke("dictation_hud_set_stop_bounds", { rect: null }).catch(
      () => {},
    );
    return;
  }
  const { left, right, top, bottom } = stopButton.getBoundingClientRect();
  void invoke("dictation_hud_set_stop_bounds", {
    rect: { left, right, top, bottom },
  }).catch(() => {});
}

function pushPillBoundsToNative() {
  if (!hud) return;
  const { left, right, top, bottom } = hud.getBoundingClientRect();
  void invoke("dictation_hud_set_pill_bounds", {
    rect: { left, right, top, bottom },
  }).catch(() => {});
}

function clearPillBounds() {
  void invoke("dictation_hud_set_pill_bounds", { rect: null }).catch(() => {});
}

function clearStopHover() {
  setStopHover(false);
  void invoke("dictation_hud_set_stop_bounds", { rect: null }).catch(() => {});
}

function clearHideTimer() {
  if (hideTimer) {
    window.clearTimeout(hideTimer);
    hideTimer = undefined;
  }
}

async function hideHud() {
  clearHideTimer();
  clearStopHover();
  clearPillBounds();
  if (hud) {
    hud.dataset.state = "exiting";
    stopBraille();
    await new Promise((resolve) =>
      window.setTimeout(resolve, EXIT_TRANSITION_MS),
    );
  }
  await appWindow.hide();
}

async function showHud() {
  clearHideTimer();
  await appWindow.show();
  // Force a layout flush before reading rects.
  hud?.offsetWidth;
  pushPillBoundsToNative();
  pushStopBoundsToNative();
}

function hideSoon(delay = 900) {
  clearHideTimer();
  hideTimer = window.setTimeout(() => {
    void hideHud();
  }, delay);
}

async function handleDictationEventPayload(payload: unknown) {
  const dictationEvent = parseEvent(payload);
  if (!dictationEvent) return;

  if (dictationEvent.type === "listening_started") {
    resetBars();
    setHud("listening", "Listening");
    await showHud();
    return;
  }

  if (dictationEvent.type === "audio_level") {
    const level = Number(dictationEvent.payload?.level || 0);
    renderAudioLevel(level);
    setHud("listening", "Listening");
    return;
  }

  if (dictationEvent.type === "finalizing_transcript") {
    setHud("transcribing", "Transcribing");
    await showHud();
    return;
  }

  if (dictationEvent.type === "final_transcript") {
    setHud("pasting", "Pasting");
    await showHud();
    return;
  }

  if (dictationEvent.type === "paste_target") {
    setHud(
      "pasting",
      `Pasting into ${dictationEvent.payload?.app || "previous app"}`,
    );
    await showHud();
    return;
  }

  if (dictationEvent.type === "paste_completed") {
    void hideHud();
    return;
  }

  if (dictationEvent.type === "error") {
    // Rust pre-classifies via payload.silent so the HUD has one source of
    // truth for what counts as a "Nothing recorded" case.
    if (dictationEvent.payload?.silent === true) {
      // Silent (nothing recorded) shouldn't look like a failure — just dismiss.
      void hideHud();
      return;
    }
    const code = String(dictationEvent.payload?.code ?? "");
    if (code === "not_signed_in") {
      setHud(
        "error",
        String(dictationEvent.payload?.message ?? "Sign in to use dictation"),
      );
    } else {
      setHud("error", "Error");
    }
    await showHud();
    // Hold long enough for the shake to finish and the message to read.
    hideSoon(1800);
  }
}

function parseEvent(payload: unknown): DictationHudEvent | undefined {
  try {
    if (typeof payload === "string") {
      return JSON.parse(payload) as DictationHudEvent;
    }
    if (payload && typeof payload === "object") {
      return payload as DictationHudEvent;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

dragHandle?.addEventListener("pointerdown", (event) => {
  if (event.button !== 0) return;
  event.preventDefault();
  event.stopPropagation();
  void appWindow.startDragging().catch(() => {});
});

stopButton?.addEventListener("click", async (event) => {
  event.preventDefault();
  setStopHover(false);
  if (hud?.dataset.state === "listening") {
    setHud("transcribing", "Transcribing");
  }
  try {
    await invoke("dictation_helper_command", {
      command: { type: "stop_and_paste" },
    });
  } catch {
    void hideHud();
  }
});

void listen("dictation-event", async (event) => {
  await handleDictationEventPayload(event.payload);
});

void listen<boolean>("hud-stop-hover", (event) => {
  setStopHover(Boolean(event.payload));
});

void invoke<string | undefined>("latest_dictation_event")
  .then((payload) => {
    if (payload) {
      return handleDictationEventPayload(payload);
    }
  })
  .catch(() => {});
