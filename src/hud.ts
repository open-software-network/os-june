import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { spinners } from "unicode-animations";
import {
  clamp,
  createBarMeter,
  HUD_BAR_HISTORY_OFFSETS,
  HUD_BAR_WEIGHTS,
  IDLE_PULSE_AMP,
  IDLE_LEVEL,
  LIVE_WAVE_OPTIONS,
  withWaveLayers,
} from "./lib/audio-meter";
import {
  AGENT_SESSION_STATUS_EVENT,
  type AgentSessionStatusDetail,
} from "./lib/agent-events";
import { MEETING_START_TRANSCRIPTION_EVENT } from "./lib/events";
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
const agentLabel = document.querySelector<HTMLElement>("#hud-agent-label");
const stopButton = document.querySelector<HTMLButtonElement>("#hud-stop");
const meetingStartButton =
  document.querySelector<HTMLButtonElement>("#hud-meeting-start");
const statusText = document.querySelector<HTMLElement>("#hud-status");

let hideTimer: number | undefined;
let meetingPromptTimer: number | undefined;
let brailleTimer: number | undefined;
let brailleFrame = 0;
let meetingPromptSuppressed = false;
let hideRequestId = 0;

// waverows shows multiple horizontal rows of dots flowing across — reads as a
// "thinking/processing" texture rather than a single dot bouncing.
const brailleWave = spinners.waverows;

// Matches the .hud[data-state="exiting"] transition in hud.css.
const EXIT_TRANSITION_MS = 160;
const MEETING_PROMPT_TIMEOUT_MS = 30_000;
const AGENT_HANDOFF_TIMEOUT_MS = 4_000;

// Bar synthesis + ballistics live in the shared meter so the recorder waveform
// moves identically. The meter holds the level history and the displayed bars.
// Sized to the actual bar count so meter.displayed always matches bars.length.
const meter = createBarMeter(
  bars.length,
  HUD_BAR_WEIGHTS,
  HUD_BAR_HISTORY_OFFSETS,
  LIVE_WAVE_OPTIONS,
);

let rafHandle: number | undefined;
let shimmerTimer: number | undefined;
let lastAudioLevelAt = 0;
const IDLE_RAF_TIMEOUT_MS = 260;
// Once the bars have settled and no fresh audio is arriving, the only thing
// left to animate is the slow idle carrier. Pace it at ~30fps via a timer
// instead of painting every rAF, so a long listening session doesn't pin the
// CPU at 60fps compositing — the carrier (a 0.45Hz sine) reads smooth either
// way. Full rAF resumes the moment audio or bar motion returns.
const SHIMMER_FRAME_MS = 33;
// The helper ships a peak-biased level (0.8·peak + 0.2·avg). These shaping
// constants mirror the playground's TUNED set exactly (AUDIO source "blend") so
// the HUD reads identically to the tuning tool.
const AUDIO_NOISE_GATE = 0.02;
// Gain 5 leaves dynamic range in the curve so the centre bounces between quiet
// and loud instead of slamming the ceiling. Whisper visibility comes from the
// (low) HUD_WHISPER_FLOOR below, not from the gain.
const AUDIO_VISUAL_GAIN = 5;
// Ambient floor damped hard (gain 4→3, ceiling 0.11→0.03) so a quiet room rests
// the bars near zero — the carrier wave, not room tone, is the idle "we're
// listening" signal. The old 0.11 ceiling pegged the baseline and buried the
// shimmer in ambient jitter, since the real HUD always has a live mic (unlike
// the silent playground idle where the carrier was tuned).
const AMBIENT_VISUAL_GAIN = 3;
const AMBIENT_MAX_LEVEL = 0.03;

// Whisper floor: once voice clears the gate, lift it off the baseline so even
// quiet speech reads. Voice-gated (see renderAudioLevel) — ambient/silence stays
// below the gate and still collapses the bars to zero. Kept low (0.06, matching
// the playground) so the centre drops back toward flat between syllables and
// bounces, instead of pegging continuously tall.
const HUD_WHISPER_FLOOR = 0.06;
// The idle pulse + speech wave live in the shared meter (IDLE_PULSE_*,
// SPEECH_WAVE_*, withWaveLayers) so the HUD and recorder move identically.

function setHud(state: string, status: string) {
  if (!hud || !statusText) return;
  const previous = hud.dataset.state;
  hud.dataset.state = state;
  statusText.textContent = status;
  if (agentLabel) {
    agentLabel.textContent = state === "agent-received" ? status : "";
  }
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
    if (state === "meeting") clearStopHover();
    pushPillBoundsToNative();
  }
}

function startBarLoop() {
  if (rafHandle !== undefined) return;
  // Audio arriving mid-shimmer cancels the throttled tick so we snap back to
  // full-rate rAF immediately instead of waiting out the timer.
  if (shimmerTimer !== undefined) {
    window.clearTimeout(shimmerTimer);
    shimmerTimer = undefined;
  }
  const tick = (now: number) => {
    rafHandle = undefined;
    const stillAnimating = meter.step();
    // Overall loudness = the tallest bar right now; drives the speech wave.
    let speech = 0;
    for (let i = 0; i < bars.length; i++) {
      speech = Math.max(speech, meter.displayed[i]);
    }
    for (let i = 0; i < bars.length; i++) {
      const level = withWaveLayers(
        meter.displayed[i],
        i,
        now,
        speech,
        bars.length,
      );
      bars[i].style.setProperty("--level", level.toFixed(3));
    }
    const sinceAudio = performance.now() - lastAudioLevelAt;
    const reactive = stillAnimating || sinceAudio < IDLE_RAF_TIMEOUT_MS;
    // Once the idle pulse is on, keep animating for as long as we're listening
    // so the travelling pulse never freezes.
    const keepShimmering =
      IDLE_PULSE_AMP > 0 && hud?.dataset.state === "listening";
    if (reactive) {
      // Bars moving or audio recent → paint every frame for responsiveness.
      rafHandle = window.requestAnimationFrame(tick);
    } else if (keepShimmering) {
      // Idle but listening → throttle the carrier so the CPU can idle between ticks.
      shimmerTimer = window.setTimeout(() => {
        shimmerTimer = undefined;
        rafHandle = window.requestAnimationFrame(tick);
      }, SHIMMER_FRAME_MS);
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
  let shaped =
    rawLevel <= AUDIO_NOISE_GATE
      ? clamp(Math.sqrt(rawLevel * AMBIENT_VISUAL_GAIN), 0, AMBIENT_MAX_LEVEL)
      : clamp(
          AMBIENT_MAX_LEVEL +
            Math.sqrt((rawLevel - AUDIO_NOISE_GATE) * AUDIO_VISUAL_GAIN),
          0,
          1,
        );
  // Voice-gated whisper floor — only lifts once real voice clears the gate, so
  // ambient room hiss stays pinned to zero (bars collapse) while any actual
  // speech, however quiet, reads tall.
  if (rawLevel > AUDIO_NOISE_GATE && shaped > 0.0001 && HUD_WHISPER_FLOOR > 0) {
    shaped = HUD_WHISPER_FLOOR + (1 - HUD_WHISPER_FLOOR) * shaped;
  }
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

function playAgentStartTone() {
  const AudioContextCtor =
    window.AudioContext ??
    (window as typeof window & { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext;
  if (!AudioContextCtor) return;
  try {
    const context = new AudioContextCtor();
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    const now = context.currentTime;
    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(520, now);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.045, now + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.16);
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start(now);
    oscillator.stop(now + 0.18);
    oscillator.addEventListener("ended", () => void context.close());
  } catch {
    // The visual handoff cue is the source of truth; sound is opportunistic.
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

function clearMeetingPromptTimer() {
  if (meetingPromptTimer) {
    window.clearTimeout(meetingPromptTimer);
    meetingPromptTimer = undefined;
  }
}

function startMeetingPromptTimer() {
  if (meetingPromptTimer !== undefined) return;
  meetingPromptTimer = window.setTimeout(() => {
    meetingPromptTimer = undefined;
    if (hud?.dataset.state !== "meeting") return;
    meetingPromptSuppressed = true;
    void hideHud();
  }, MEETING_PROMPT_TIMEOUT_MS);
}

async function hideHud() {
  const requestId = ++hideRequestId;
  clearHideTimer();
  clearMeetingPromptTimer();
  clearStopHover();
  clearPillBounds();
  if (hud) {
    hud.dataset.state = "exiting";
    stopBraille();
    await new Promise((resolve) =>
      window.setTimeout(resolve, EXIT_TRANSITION_MS),
    );
  }
  if (requestId !== hideRequestId) return;
  await appWindow.hide();
}

async function showHud() {
  hideRequestId += 1;
  clearHideTimer();
  await appWindow.show();
  // Force a layout flush before reading rects.
  hud?.offsetWidth;
  if (hud?.dataset.state === "meeting") {
    clearStopHover();
    pushPillBoundsToNative();
  } else {
    pushPillBoundsToNative();
    pushStopBoundsToNative();
  }
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
    // The helper flushes a final coalesced level when the recorder stops, which
    // arrives AFTER finalizing_transcript. Once we've moved past listening, that
    // stray level must NOT pull the HUD back to "listening" — otherwise it kills
    // the transcribing braille and the pill looks stuck until the paste lands.
    const state = hud?.dataset.state;
    if (
      state === "idle" ||
      state === "transcribing" ||
      state === "pasting" ||
      state === "error" ||
      state === "silent-error" ||
      state === "exiting"
    ) {
      return;
    }
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

  if (dictationEvent.type === "agent_session_prompt") {
    void hideHud();
    return;
  }

  if (dictationEvent.type === "error") {
    // Rust pre-classifies via payload.silent so the HUD has one source of
    // truth for what counts as a "Nothing recorded" case.
    if (dictationEvent.payload?.silent === true) {
      setHud("silent-error", "Nothing recorded");
      await showHud();
      hideSoon(900);
      return;
    }
    const message = String(
      dictationEvent.payload?.message ?? "Dictation failed.",
    ).trim();
    setHud("error", message || "Dictation failed.");
    await showHud();
    // Hold long enough for the shake to finish and the message to read.
    hideSoon(1800);
  }
}

async function handleMeetingDetectionEventPayload(payload: unknown) {
  const meetingEvent = parseEvent(payload);
  if (!meetingEvent) return;

  if (meetingEvent.type === "meeting_detected") {
    if (meetingPromptSuppressed) return;
    if (!canShowMeetingPrompt(hud?.dataset.state)) return;
    setHud("meeting", "Meeting detected");
    await showHud();
    startMeetingPromptTimer();
    return;
  }

  if (meetingEvent.type === "meeting_cleared") {
    meetingPromptSuppressed = false;
    clearMeetingPromptTimer();
    if (hud?.dataset.state === "meeting") {
      void hideHud();
    }
  }
}

function canShowMeetingPrompt(state: string | undefined) {
  return (
    state === undefined ||
    state === "idle" ||
    state === "meeting" ||
    state === "exiting"
  );
}

async function handleAgentStatusEventPayload(payload: unknown) {
  const event = parseEvent(payload) as unknown as
    | AgentSessionStatusDetail
    | undefined;
  if (event?.status !== "received") return;

  clearMeetingPromptTimer();
  clearHideTimer();
  playAgentStartTone();
  setHud("agent-received", event.summary || "June is starting");
  await showHud();
  hideSoon(AGENT_HANDOFF_TIMEOUT_MS);
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

meetingStartButton?.addEventListener("click", async (event) => {
  event.preventDefault();
  event.stopPropagation();
  if (hud?.dataset.state !== "meeting") return;

  meetingPromptSuppressed = true;
  clearMeetingPromptTimer();
  meetingStartButton.disabled = true;
  try {
    await emit(MEETING_START_TRANSCRIPTION_EVENT);
  } catch {
    // The main window owns recording errors; the HUD should never block clicks.
  }
  void hideHud().finally(() => {
    meetingStartButton.disabled = false;
  });
});

void listen("dictation-event", async (event) => {
  await handleDictationEventPayload(event.payload);
});

void listen("meeting-detection-event", async (event) => {
  await handleMeetingDetectionEventPayload(event.payload);
});

void listen(AGENT_SESSION_STATUS_EVENT, async (event) => {
  await handleAgentStatusEventPayload(event.payload);
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
