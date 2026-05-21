import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
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
const bars = Array.from(document.querySelectorAll<HTMLElement>(".hud-bar"));
const statusText = document.querySelector<HTMLElement>("#hud-status");
const transcriptText = document.querySelector<HTMLElement>("#hud-transcript");

let hideTimer: number | undefined;
let smoothedLevel = 0.2;

const idleLevels = [0.22, 0.38, 0.58, 0.78, 0.48, 0.34, 0.2];
const barWeights = [0.45, 0.64, 0.86, 1, 0.82, 0.58, 0.4];

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function setHud(state: string, status: string, transcript = "") {
  if (!hud || !statusText || !transcriptText) return;
  hud.dataset.state = state;
  statusText.textContent = status;
  transcriptText.textContent = transcript;
}

function setBars(levels: number[]) {
  bars.forEach((bar, index) => {
    bar.style.setProperty("--level", String(levels[index] ?? 0.2));
  });
}

function resetBars() {
  smoothedLevel = 0.2;
  setBars(idleLevels);
}

function renderAudioLevel(rawLevel: number) {
  const normalizedLevel = clamp(Math.sqrt(rawLevel * 5), 0.08, 1);
  smoothedLevel = smoothedLevel * 0.55 + normalizedLevel * 0.45;
  const tick = Date.now() / 170;
  setBars(
    barWeights.map((weight, index) => {
      const motion = Math.sin(tick + index * 0.84) * 0.055;
      return clamp(0.08 + smoothedLevel * weight + motion, 0.12, 1);
    }),
  );
}

function clearHideTimer() {
  if (hideTimer) {
    window.clearTimeout(hideTimer);
    hideTimer = undefined;
  }
}

async function hideHud() {
  clearHideTimer();
  await appWindow.hide();
}

async function showHud() {
  clearHideTimer();
  await appWindow.show();
}

function hideSoon(delay = 1400) {
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
    setHud("success", "Pasted");
    await showHud();
    hideSoon(900);
    return;
  }

  if (dictationEvent.type === "error") {
    const errorMessage = dictationEvent.payload?.message || "";
    setHud("error", errorMessage || "Dictation failed.");
    await showHud();
    hideSoon(900);
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

void listen("dictation-event", async (event) => {
  await handleDictationEventPayload(event.payload);
});

void invoke<string | undefined>("latest_dictation_event")
  .then((payload) => {
    if (payload) {
      return handleDictationEventPayload(payload);
    }
  })
  .catch(() => {});
