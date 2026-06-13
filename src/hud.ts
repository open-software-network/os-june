import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { IconCrossSmall } from "central-icons/IconCrossSmall";
import { IconExclamationCircle } from "central-icons/IconExclamationCircle";
import { IconMicrophone } from "central-icons-filled/IconMicrophone";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
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
import {
  isOnboardingComplete,
  subscribeToOnboardingComplete,
} from "./lib/onboarding";
import { installNativeContextMenuGuard } from "./lib/native-context-menu";
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

// Absent on the standalone browser page (no Tauri bridge), where the demo
// driver exercises the pill — getCurrentWindow() throws there.
const appWindow = (() => {
  try {
    return getCurrentWindow();
  } catch {
    return undefined;
  }
})();

installNativeContextMenuGuard();

const hud = document.querySelector<HTMLDivElement>("#hud");
const dragHandle = document.querySelector<HTMLElement>("#hud-handle");
const bars = Array.from(document.querySelectorAll<HTMLElement>(".hud-bar"));
const brailleNode = document.querySelector<HTMLElement>("#hud-braille");
const errorText = document.querySelector<HTMLElement>("#hud-error-text");
const errorIcon = document.querySelector<HTMLElement>(".hud-error-icon");
const errorLayer = document.querySelector<HTMLElement>(".hud-error-layer");
const stopButton = document.querySelector<HTMLButtonElement>("#hud-stop");
const meetingStartButton =
  document.querySelector<HTMLButtonElement>("#hud-meeting-start");
const meetingAppLabel = document.querySelector<HTMLElement>("#hud-meeting-app");
const meetingDismissButton = document.querySelector<HTMLButtonElement>(
  "#hud-meeting-dismiss",
);
const statusText = document.querySelector<HTMLElement>("#hud-status");

// House iconography (central-icons), injected like the agent HUD does.
if (meetingDismissButton) {
  meetingDismissButton.innerHTML = renderToStaticMarkup(
    createElement(IconCrossSmall, {
      size: 12,
      ariaHidden: true,
      focusable: false,
    }),
  );
}
if (errorIcon) {
  errorIcon.innerHTML = renderToStaticMarkup(
    createElement(IconExclamationCircle, {
      size: 16,
      ariaHidden: true,
      focusable: false,
    }),
  );
}
const meetingStartIcon = document.querySelector<HTMLElement>(
  ".hud-meeting-start-icon",
);
if (meetingStartIcon) {
  meetingStartIcon.innerHTML = renderToStaticMarkup(
    createElement(IconMicrophone, {
      size: 14,
      ariaHidden: true,
      focusable: false,
    }),
  );
}

let hideTimer: number | undefined;
let meetingPromptTimer: number | undefined;
let brailleTimer: number | undefined;
let brailleFrame = 0;
let meetingPromptSuppressed = false;
let pendingMeetingPrompt: DictationHudEvent | undefined;
let hideRequestId = 0;
let showRequestId = 0;
let showQueue: Promise<void> = Promise.resolve();

// waverows shows multiple horizontal rows of dots flowing across — reads as a
// "thinking/processing" texture rather than a single dot bouncing.
const brailleWave = spinners.waverows;

// Matches the .hud[data-state="exiting"] transition in hud.css. Long
// enough to read as a deliberate dissolve rather than a blink-out.
const EXIT_TRANSITION_MS = 240;
// Matches the .hud.is-morphing fade (60ms) plus a frame of slack.
const MORPH_FADE_MS = 80;
// Transparent, click-through margin around the frostless HUD surface. Its
// CSS shadow paints here and the meeting dismiss can overhang the card's
// edge. This is the agent HUD model: transparent native window, CSS-painted
// surface, no native vibrancy rim.
const WINDOW_GUTTER = 16;
// Gap between the error pill and the message layer that draws above/below it
// — must match the .hud-error-layer margin in hud.css.
const ERROR_LAYER_GAP = 8;
// The error message layer's reveal / retract — must track the
// .hud-error-layer grid-template-rows transition (--t-med) in hud.css.
const ERROR_REVEAL_MS = 160;
const MEETING_PROMPT_TIMEOUT_MS = 30_000;

function invokeBestEffort(command: string, args?: Record<string, unknown>) {
  try {
    void Promise.resolve(invoke(command, args)).catch(() => {});
  } catch {
    // Native HUD commands are opportunistic; the visible state still advances.
  }
}

async function invokeBestEffortAsync(
  command: string,
  args?: Record<string, unknown>,
) {
  try {
    await Promise.resolve(invoke(command, args));
  } catch {
    // Native HUD commands are opportunistic; the visible state still advances.
  }
}

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
const AUDIO_NOISE_GATE = 0.02;
const AUDIO_VISUAL_GAIN = 5;
const AMBIENT_VISUAL_GAIN = 3;
const AMBIENT_MAX_LEVEL = 0.03;
const HUD_WHISPER_FLOOR = 0.06;
// The idle pulse + speech wave live in the shared meter (IDLE_PULSE_*,
// SPEECH_WAVE_*, withWaveLayers) so the HUD and recorder move identically.

type HudTransition = {
  changed: boolean;
  previous?: string;
};

function setHud(state: string, status: string): HudTransition {
  if (!hud || !statusText) return { changed: false };
  const previous = hud.dataset.state;
  hud.dataset.state = state;
  statusText.textContent = status;
  // Keep the error message through "exiting" so it dissolves with the
  // window's native alpha fade instead of vanishing a frame early; the
  // post-hide flip to "idle" clears it.
  if (errorText && state !== "exiting") {
    errorText.textContent = state === "error" ? status : "";
  }
  // The error reveal collapse class is owned by the reveal/exit sequence.
  // Leave it alone for "error" and "exiting": the reveal removes it after
  // sizing, and error exits clear it before fading the expanded HUD in place.
  if (state !== "error" && state !== "exiting") {
    hud.classList.remove("hud-reveal-collapsed");
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
  if (state !== previous && hud) {
    if (usesFrostlessChrome(previous) !== usesFrostlessChrome(state)) {
      // Kept for compatibility with older native windows; in normal builds
      // every state is frostless and this branch does not run.
      invokeBestEffort("dictation_hud_set_chrome", {
        frostless: usesFrostlessChrome(state),
      });
    }
    if (state === "meeting") clearStopHover();
  }
  return { changed: state !== previous, previous };
}

async function updateErrorPlacement() {
  if (!hud) return;
  let placement: unknown;
  try {
    placement = await Promise.resolve(
      invoke("dictation_hud_preferred_error_placement"),
    );
  } catch {
    placement = undefined;
  }
  hud.dataset.errorPlacement = placement === "above" ? "above" : "below";
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

function setDismissHover(isHovered: boolean) {
  meetingDismissButton?.classList.toggle("is-hovered", isHovered);
}

// Meeting-card hover, computed natively against rects pushed from here —
// CSS :hover is unreliable on the non-key HUD panel, see .hud-stop.
// Hovering anywhere over the card (plus the overhanging X) reveals the
// corner dismiss; hovering the record button paints its hover wash.
function pushDismissBoundsToNative() {
  if (!hud || hud.dataset.state !== "meeting") {
    invokeBestEffort("dictation_hud_set_dismiss_bounds", { rect: null });
    invokeBestEffort("dictation_hud_set_record_bounds", { rect: null });
    return;
  }
  const card = hud.getBoundingClientRect();
  const cross = meetingDismissButton?.getBoundingClientRect();
  invokeBestEffort("dictation_hud_set_dismiss_bounds", {
    rect: {
      left: Math.min(card.left, cross?.left ?? card.left),
      top: Math.min(card.top, cross?.top ?? card.top),
      right: card.right,
      bottom: card.bottom,
    },
  });
  const record = meetingStartButton?.getBoundingClientRect();
  invokeBestEffort("dictation_hud_set_record_bounds", {
    rect: record
      ? {
          left: record.left,
          right: record.right,
          top: record.top,
          bottom: record.bottom,
        }
      : null,
  });
}

function setRecordHover(isHovered: boolean) {
  meetingStartButton?.classList.toggle("is-hovered", isHovered);
}

function clearDismissHover() {
  setDismissHover(false);
  setRecordHover(false);
  invokeBestEffort("dictation_hud_set_dismiss_bounds", { rect: null });
  invokeBestEffort("dictation_hud_set_record_bounds", { rect: null });
}

// Hover + click pass-through are computed in Rust against rects we push from
// here. WebKit throttles JS timers on the non-key HUD panel, so any polling
// done in JS only fires reliably during a mouse-down.
function pushStopBoundsToNative() {
  if (!stopButton || hud?.dataset.state !== "listening") {
    invokeBestEffort("dictation_hud_set_stop_bounds", { rect: null });
    return;
  }
  const { left, right, top, bottom } = stopButton.getBoundingClientRect();
  invokeBestEffort("dictation_hud_set_stop_bounds", {
    rect: { left, right, top, bottom },
  });
}

// The native window size the current state wants. getBoundingClientRect
// includes transforms, and the exit leaves one in play: "exiting" eases the
// pill to scale(0.94), and when the window hides mid-flight the suspended
// webview freezes that transition wherever it stood until the next show. A
// fresh show measured through the frozen scale baked a too-narrow frame
// into the window — the pill came up clipped flat at the right edge, then
// visibly snapped to full width when the settle pass healed it. Kill
// in-flight transitions for the measurement so every property sits at its
// end value.
function measureWindowSize() {
  if (!hud) return { width: 0, height: 0 };
  hud.classList.add("hud-snap");
  hud.offsetWidth;
  let { width, height } = hud.getBoundingClientRect();
  if (hud.dataset.state === "error" && errorLayer) {
    // The message layer is centered above/below the pill (.hud-snap forces
    // it to its full drawn-out height for this measurement). Mirror its slot
    // on the opposite vertical side so the center-anchored native resize
    // leaves the pill dead centre while the layer reveals vertically.
    const layer = errorLayer.getBoundingClientRect();
    width = Math.max(width, layer.width);
    height += 2 * (ERROR_LAYER_GAP + layer.height);
  }
  if (usesFrostlessChrome(hud.dataset.state)) {
    // The frostless HUD includes the transparent gutter its CSS shadow (and
    // the meeting card's overhanging dismiss) paint into. The center-anchored
    // native resize splits it evenly, so the surface stays put.
    width += WINDOW_GUTTER * 2;
    height += WINDOW_GUTTER * 2;
  }
  hud.classList.remove("hud-snap");
  return { width, height };
}

// Resize the native window to the pill's measured size (Rust re-anchors so
// the pill center stays put), then refresh the stop-button rect once layout
// has settled at the new size — the pill's client position shifts when the
// window around it changes. With `morph` the contents fade out while the
// glass eases to its new frame, then fade back in (the invoke resolves when
// the native motion finishes).
async function syncWindowToPill(options?: {
  animate?: boolean;
  morph?: boolean;
}) {
  if (!hud) return;
  // ABC Diatype may still be loading on the window's first show; measuring
  // with the fallback font bakes the wrong width into the window frame.
  if (typeof document.fonts?.ready?.then === "function") {
    if (document.fonts.status === "loading") {
      try {
        await document.fonts.ready;
      } catch {
        // Best effort; the fallback metrics are close enough to recover on
        // the next state change.
      }
    }
  }
  if (options?.morph) {
    hud.classList.add("is-morphing");
    // Let the contents finish fading before the glass starts moving: the
    // webview lays out at the final size immediately, so anything still
    // visible during the native ease paints clipped by the old frame —
    // worst on the meeting card, which changes height as well as width.
    if (!prefersReducedMotion()) {
      await new Promise((resolve) => window.setTimeout(resolve, MORPH_FADE_MS));
    }
  }
  const { width, height } = measureWindowSize();
  // Exact floats — Rust rounds at physical pixels. Ceiling here oversized
  // the window by up to a point, leaving a bright sliver of bare frost
  // around the dark card.
  await invokeBestEffortAsync("dictation_hud_set_size", {
    width,
    height,
    animate: options?.animate ?? !prefersReducedMotion(),
  });
  window.requestAnimationFrame(() => {
    window.requestAnimationFrame(() => {
      hud?.classList.remove("is-morphing");
      pushStopBoundsToNative();
      pushDismissBoundsToNative();
    });
  });
}

// The native window alpha drives the exit dissolve so the CSS surface, shadow,
// and transparent gutter fade as one unit.
function setWindowAlpha(alpha: number) {
  invokeBestEffort("dictation_hud_set_alpha", { alpha });
}

function fadeWindowAlpha(requestId: number) {
  return new Promise<void>((resolve) => {
    const start = performance.now();
    const step = (now: number) => {
      if (requestId !== hideRequestId) {
        resolve();
        return;
      }
      const t = Math.min((now - start) / EXIT_TRANSITION_MS, 1);
      setWindowAlpha(1 - t);
      if (t < 1) {
        window.requestAnimationFrame(step);
      } else {
        resolve();
      }
    };
    window.requestAnimationFrame(step);
  });
}

// Fallback entrance for the standalone browser page, where the native
// slide+fade (dictation_hud_show with enter) has no bridge to run on.
function replayCssEntrance() {
  if (!hud) return;
  hud.classList.remove("hud-enter");
  hud.offsetWidth;
  hud.classList.add("hud-enter");
}

// matchMedia is absent in the jsdom test environment.
function prefersReducedMotion() {
  return (
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

// The macOS "not allowed" wobble, done natively — the window jiggles, the
// frost moves with it (a CSS translateX would slide the tint off the
// stationary vibrancy view).
function triggerShake() {
  if (prefersReducedMotion()) return;
  invokeBestEffort("dictation_hud_shake");
}

function clearStopHover() {
  setStopHover(false);
  invokeBestEffort("dictation_hud_set_stop_bounds", { rect: null });
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
  showRequestId += 1;
  clearHideTimer();
  clearFrameSettleTimer();
  clearMeetingPromptTimer();
  clearStopHover();
  clearDismissHover();
  const exitState = hud?.dataset.state;
  const exitingError = exitState === "error";
  if (exitingError) {
    hud?.classList.remove("hud-reveal-collapsed");
  }
  let nativeExit = false;
  if (hud) {
    const meetingExit =
      hud.dataset.state === "meeting" && !prefersReducedMotion();
    hud.classList.toggle("hud-exit-up", meetingExit);
    hud.classList.toggle("hud-error-exit", exitingError);
    if (exitState) {
      hud.dataset.exitState = exitState;
    }
    setHud("exiting", statusText?.textContent || "Idle");
    stopBraille();
    if (meetingExit) {
      // The meeting card leaves the way it came in: a native slide-up +
      // fade that also hides the window (the invoke resolves once it's
      // hidden). CSS can't do the motion — see showHud.
      try {
        await invoke("dictation_hud_exit");
        nativeExit = true;
      } catch {
        // No bridge: fall through to the plain alpha fade.
      }
    }
    if (!nativeExit) {
      // CSS dissolves the content; the native alpha ramp fades the whole
      // transparent window with it. The timeout race guards against rAF
      // stalling if the window is already occluded/hidden.
      await Promise.race([
        fadeWindowAlpha(requestId),
        new Promise((resolve) =>
          window.setTimeout(resolve, EXIT_TRANSITION_MS + 60),
        ),
      ]);
    }
  }
  if (requestId !== hideRequestId) return;
  // hide() rejects on the standalone browser page (no Tauri bridge); the
  // demo driver still needs the state machine to advance.
  await appWindow?.hide().catch(() => {});
  setWindowAlpha(1);
  // Don't park on "exiting" (opacity 0, pointer-events none): if the native
  // window is ever shown again without new content, a pill stuck in that
  // state renders as a bare, undraggable gray bar.
  if (hud?.dataset.state === "exiting" && requestId === hideRequestId) {
    hud.classList.remove("hud-error-exit");
    delete hud.dataset.exitState;
    setHud("idle", "Idle");
  }
}

function shouldMorphTransition(transition: HudTransition) {
  return (
    transition.changed &&
    transition.previous !== undefined &&
    !pillIsBlank(transition.previous) &&
    !pillIsBlank(hud?.dataset.state)
  );
}

function showOptionsForTransition(transition: HudTransition) {
  const current = hud?.dataset.state;
  const processingContinuation =
    (transition.previous === "listening" && current === "transcribing") ||
    (transition.previous === "transcribing" && current === "pasting") ||
    (transition.previous === "pasting" && current === "pasting");
  const morph = !processingContinuation && shouldMorphTransition(transition);
  return {
    fresh: transition.changed && pillIsBlank(transition.previous),
    morph,
  };
}

function showHud(options?: { fresh?: boolean; morph?: boolean }) {
  const requestId = ++showRequestId;
  hideRequestId += 1;
  clearHideTimer();
  clearFrameSettleTimer();

  const run = showQueue.then(() => showHudNow(requestId, options));
  showQueue = run.catch(() => {});
  return run;
}

async function showHudNow(
  requestId: number,
  options?: { fresh?: boolean; morph?: boolean },
) {
  if (requestId !== showRequestId) return;
  if (options?.fresh) {
    setWindowAlpha(0);
  }
  // Size the window to the pill before it appears, then let Rust position
  // and show it (dictation_hud_show also restores the native alpha an
  // interrupted exit fade may have left low). Showing only after the resize
  // is what keeps the pill from flashing up as a bare gray bar, or clipped
  // at a stale width from a previous state.
  await syncWindowToPill({
    animate: options?.morph ? !prefersReducedMotion() : false,
    morph: options?.morph,
  });
  if (requestId !== showRequestId) return;
  // A fresh meeting prompt always enters at the top-center default spot,
  // and (motion permitting) slides down from the top edge while the
  // window alpha ramps up. The motion is native (the invoke resolves when
  // it settles): a CSS translate would slide the card off the stationary
  // window chrome, flashing bare edges.
  const meetingEntrance = hud?.dataset.state === "meeting";
  const animate = !prefersReducedMotion();
  try {
    await invoke("dictation_hud_show", {
      enter: meetingEntrance ? true : null,
      animate,
    });
  } catch {
    // No bridge (standalone page): fall back to the CSS entrance.
    if (meetingEntrance && animate) replayCssEntrance();
  }
  if (requestId !== showRequestId) return;
  // Force a layout flush before reading rects.
  hud?.offsetWidth;
  if (hud?.dataset.state === "meeting") {
    clearStopHover();
    pushDismissBoundsToNative();
  } else {
    pushStopBoundsToNative();
    pushDismissBoundsToNative();
  }
  assertWindowMatchesPill();
}

// One settle pass after every show. A long-hidden webview can wake with a
// stale frame: the show lands before its resize, parking the pill clipped
// with bare frost poking out — and nothing later heals it, because parked
// states (a demo-driven "listening" stream of audio levels, say) never
// trigger another resize. The webview viewport tracks the native content
// size, so a viewport/pill mismatch after layout settles means the frame
// race was lost; re-issue the resize.
const FRAME_SETTLE_DELAY_MS = 120;
let frameSettleTimer: number | undefined;

function clearFrameSettleTimer() {
  if (frameSettleTimer !== undefined) {
    window.clearTimeout(frameSettleTimer);
    frameSettleTimer = undefined;
  }
}

function assertWindowMatchesPill() {
  // Standalone browser page: the viewport is the whole tab, never the pill.
  if (!appWindow) return;
  clearFrameSettleTimer();
  frameSettleTimer = window.setTimeout(() => {
    frameSettleTimer = undefined;
    const state = hud?.dataset.state;
    if (!hud || !state || state === "idle" || state === "exiting") return;
    const expected = measureWindowSize();
    const drift = Math.max(
      Math.abs(window.innerWidth - expected.width),
      Math.abs(window.innerHeight - expected.height),
    );
    // Rust rounds the frame at physical pixels; allow a point of slack.
    // Snap, don't ease: this corrects a pill the user already sees as
    // settled, and easing it reads as the window morphing on its own.
    if (drift > 1.5) void syncWindowToPill({ animate: false });
  }, FRAME_SETTLE_DELAY_MS);
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
    const transition = setHud("listening", "Listening");
    await showHud(showOptionsForTransition(transition));
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
    const transition = setHud("transcribing", "Transcribing");
    await showHud(showOptionsForTransition(transition));
    return;
  }

  if (dictationEvent.type === "final_transcript") {
    const transition = setHud("pasting", "Pasting");
    await showHud(showOptionsForTransition(transition));
    return;
  }

  if (dictationEvent.type === "paste_target") {
    const transition = setHud(
      "pasting",
      `Pasting into ${dictationEvent.payload?.app || "previous app"}`,
    );
    await showHud(showOptionsForTransition(transition));
    return;
  }

  if (dictationEvent.type === "paste_completed") {
    void hideHud();
    return;
  }

  if (dictationEvent.type === "recording_discarded") {
    // A grazed push-to-talk key or a signed-out session: the recording was
    // dropped without transcription, so the listening HUD just goes away.
    void hideHud();
    return;
  }

  if (dictationEvent.type === "agent_session_prompt") {
    void hideHud();
    return;
  }

  if (dictationEvent.type === "error") {
    // Rust pre-classifies via payload.silent so the HUD has one source of
    // truth for what counts as a "Nothing recorded" case. When nothing was
    // recorded there's nothing to tell the user: take the normal graceful
    // exit (the same fade hideHud runs after a successful paste) and say
    // nothing. Real failures fall through to the visible error treatment
    // below: Rust's promotion logic upgrades a silent classification to a
    // real error when speech was probably detected, so those still show.
    if (dictationEvent.payload?.silent === true) {
      void hideHud();
      return;
    }
    // Stop with nothing running (a stop racing a session that already
    // ended, or the demo pill's stop button hitting the real helper): the
    // desired end state — not listening — is already true, so there is
    // nothing to tell the user. Take the quiet exit.
    if (dictationEvent.payload?.code === "not_listening") {
      void hideHud();
      return;
    }
    // Re-triggering dictation while the pill is already up listening: the
    // wobble on the live pill says "already going" without a text toast —
    // which would also replace the listening state and auto-hide while the
    // recording is still running. Listening continues untouched (the helper
    // keeps streaming audio levels, which also keeps Rust's post-error
    // window-hide timer from firing).
    if (
      dictationEvent.payload?.code === "already_listening" &&
      hud?.dataset.state === "listening"
    ) {
      triggerShake();
      return;
    }
    const message = String(
      dictationEvent.payload?.message ?? "Dictation failed.",
    ).trim();
    await updateErrorPlacement();
    const transition = setHud("error", message || "Dictation failed.");
    // Render the pill with the message layer drawn in, snap the window to
    // the full (layer-included) size with no native motion, then draw the
    // layer out in CSS — the pill never moves and nothing clips.
    hud?.classList.add("hud-reveal-collapsed");
    await showHud({ fresh: pillIsBlank(transition.previous) });
    playErrorReveal();
    triggerShake();
    // Hold long enough for the shake to finish and the message to read.
    hideSoon(1800);
  }
}

// Drop the collapse so the message layer draws out of the pill. The pill was
// rendered collapsed and the window already snapped to the full size, so
// this is a pure CSS draw-out within the still window.
function playErrorReveal() {
  if (!hud) return;
  if (prefersReducedMotion()) {
    hud.classList.remove("hud-reveal-collapsed");
    return;
  }
  requestAnimationFrame(() =>
    requestAnimationFrame(() => hud?.classList.remove("hud-reveal-collapsed")),
  );
}

async function handleMeetingDetectionEventPayload(payload: unknown) {
  const meetingEvent = parseEvent(payload);
  if (!meetingEvent) return;

  if (meetingEvent.type === "meeting_detected") {
    if (!isOnboardingComplete()) {
      pendingMeetingPrompt = meetingEvent;
      hideBlankWindowIfNeeded();
      return;
    }
    pendingMeetingPrompt = undefined;
    await showMeetingPrompt(meetingEvent);
    return;
  }

  if (meetingEvent.type === "meeting_cleared") {
    pendingMeetingPrompt = undefined;
    meetingPromptSuppressed = false;
    clearMeetingPromptTimer();
    if (hud?.dataset.state === "meeting") {
      void hideHud();
    } else if (pillIsBlank(hud?.dataset.state)) {
      // Heal a contentless window left visible by an earlier show.
      void appWindow?.hide().catch(() => {});
    }
  }
}

async function showMeetingPrompt(meetingEvent: DictationHudEvent) {
  if (meetingPromptSuppressed || !canShowMeetingPrompt(hud?.dataset.state)) {
    // Rust may have shown the native window before emitting this event.
    // When the prompt won't render and the pill has no other content, put
    // the window back down — otherwise only the frosted surface shows: a
    // gray bar that can't be dragged or dismissed.
    hideBlankWindowIfNeeded();
    return;
  }
  // Set the app line before the pill is measured so the window is sized
  // for it. Heartbeats refresh it (the mic can move between apps).
  if (meetingAppLabel) {
    meetingAppLabel.textContent = meetingAppLine(
      meetingEvent.payload?.appLabels,
    );
  }
  const transition = setHud("meeting", "Meeting detected");
  await showHud(showOptionsForTransition(transition));
  startMeetingPromptTimer();
}

function hideBlankWindowIfNeeded() {
  if (pillIsBlank(hud?.dataset.state)) {
    void appWindow?.hide().catch(() => {});
  }
}

function showPendingMeetingPromptAfterOnboarding() {
  if (!pendingMeetingPrompt || !isOnboardingComplete()) return;
  const meetingEvent = pendingMeetingPrompt;
  pendingMeetingPrompt = undefined;
  void showMeetingPrompt(meetingEvent);
}

// "Zoom" / "Zoom, Chrome" — the friendly labels Rust derives from the
// processes holding the microphone. Detection is mic-based, so when no
// label survives validation, say what we actually know.
function meetingAppLine(labels: unknown) {
  const names = Array.isArray(labels)
    ? labels.filter(
        (label): label is string =>
          typeof label === "string" && label.trim() !== "",
      )
    : [];
  return names.length > 0 ? names.join(", ") : "Microphone in use";
}

function pillIsBlank(state: string | undefined) {
  return state === undefined || state === "idle" || state === "exiting";
}

// Every state runs without native frost or native shadow. The HUD paints the
// same CSS surface and drop shadow as the agent HUD into a transparent gutter.
// Keeping idle/exiting frostless prevents any chrome swap during hide.
function usesFrostlessChrome(state: string | undefined) {
  void state;
  return true;
}

function canShowMeetingPrompt(state: string | undefined) {
  return (
    state === undefined ||
    state === "idle" ||
    state === "meeting" ||
    state === "exiting"
  );
}

function handleAgentStatusEventPayload(payload: unknown) {
  const event = parseEvent(payload) as unknown as
    | AgentSessionStatusDetail
    | undefined;
  if (event?.status !== "received") return;

  // Audible ack only: the agent HUD (top right) is the visual announcement
  // for a new session, and the dictation pill was already hidden by the
  // agent_session_prompt event. The tone covers the eyes-elsewhere voice
  // handoff without a second pill claiming the screen.
  playAgentStartTone();
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
  void appWindow?.startDragging().catch(() => {});
});

stopButton?.addEventListener("click", async (event) => {
  event.preventDefault();
  setStopHover(false);
  if (hud?.dataset.state === "listening") {
    const transition = setHud("transcribing", "Transcribing");
    void showHud(showOptionsForTransition(transition));
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

meetingDismissButton?.addEventListener("click", (event) => {
  event.preventDefault();
  event.stopPropagation();
  if (hud?.dataset.state !== "meeting") return;

  // Same semantics as letting the prompt time out: stay quiet for the rest
  // of this meeting (detection heartbeats keep arriving while the call is
  // live) and prompt again once it clears.
  meetingPromptSuppressed = true;
  clearMeetingPromptTimer();
  void hideHud();
});

void listen("dictation-event", async (event) => {
  await handleDictationEventPayload(event.payload);
}).catch(() => {});

void listen("meeting-detection-event", async (event) => {
  await handleMeetingDetectionEventPayload(event.payload);
}).catch(() => {});

void listen(AGENT_SESSION_STATUS_EVENT, async (event) => {
  await handleAgentStatusEventPayload(event.payload);
}).catch(() => {});

void listen<boolean>("hud-stop-hover", (event) => {
  setStopHover(Boolean(event.payload));
}).catch(() => {});

void listen<boolean>("hud-dismiss-hover", (event) => {
  setDismissHover(Boolean(event.payload));
}).catch(() => {});

void listen<boolean>("hud-record-hover", (event) => {
  setRecordHover(Boolean(event.payload));
}).catch(() => {});

// Cold-start companion to the await in syncWindowToPill: the Diatype load
// may only BEGIN once the prompt first paints text, after the measurement.
// When the faces land, re-fit the window to whatever is showing.
if (typeof document.fonts?.ready?.then === "function") {
  void document.fonts.ready.then(() => {
    const state = hud?.dataset.state;
    if (state && state !== "idle" && state !== "exiting") {
      void syncWindowToPill();
    }
  });
}

// Local mirrors of the Tauri listeners, same as the agent HUD page:
// only the dev-only demo drivers dispatch these window events (standalone
// page, no bridge), so production builds skip the dead listeners.
if (import.meta.env.DEV) {
  window.addEventListener("dictation-event", (event) => {
    void handleDictationEventPayload((event as CustomEvent).detail);
  });

  window.addEventListener("meeting-detection-event", (event) => {
    void handleMeetingDetectionEventPayload((event as CustomEvent).detail);
  });
}

subscribeToOnboardingComplete(showPendingMeetingPromptAfterOnboarding);

// Console drivers for this page when served standalone in a browser:
// __dictationHud("listening") drives the dictation pill, __meetingHud(
// "detected") drives the meeting-detection prompt. See lib/dictation-hud-demo.ts
// and lib/meeting-hud-demo.ts.
if (import.meta.env.DEV) {
  void import("./lib/dictation-hud-demo").then(({ registerDictationHudDemo }) =>
    registerDictationHudDemo({ local: true }),
  );
  void import("./lib/meeting-hud-demo").then(({ registerMeetingHudDemo }) =>
    registerMeetingHudDemo({ local: true }),
  );
}

void invoke<string | undefined>("latest_dictation_event")
  .then((payload) => {
    if (payload) {
      return handleDictationEventPayload(payload);
    }
  })
  .catch(() => {});
