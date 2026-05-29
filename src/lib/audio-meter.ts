// Shared waveform meter: bar synthesis + envelope ballistics used by BOTH the
// dictation HUD (hud.ts) and the note recorder (recorder/Waveform.tsx) so the
// two waveforms share one design language. Bar count/weights are per-surface
// (the HUD is a compact 5-bar pill; the recorder is a taller 7-bar meter), but
// the motion is identical.
//
// Inputs are already-shaped 0..1 levels (each surface shapes its own raw audio
// before pushing — the HUD from the helper's level, the recorder from peaks).

// HUD: compact 5 bars. Hand-tuned organic weights + history offsets so each bar
// samples slightly different recent audio (coherent shape, not a uniform block).
export const HUD_BAR_COUNT = 5;
export const HUD_BAR_WEIGHTS = [0.64, 0.86, 0.7, 0.84, 0.58];
export const HUD_BAR_HISTORY_OFFSETS = [1, 0, 1, 0, 1];

// Recorder: 7 bars, symmetric with a taller center, to fill its wider/taller
// meter area.
export const RECORDER_BAR_COUNT = 7;
export const RECORDER_BAR_WEIGHTS = [0.6, 0.84, 0.72, 0.9, 0.72, 0.84, 0.6];
export const RECORDER_BAR_HISTORY_OFFSETS = [1, 0, 1, 0, 1, 0, 1];

export const LEVEL_HISTORY_LENGTH = 8;
export const LIVE_LEVEL_MIX = 0.7;
export const IDLE_LEVEL = 0;

// Ballistics, applied per rAF frame (~60fps). Fast attack on the way up, a
// quick release on the way down, and an even quicker collapse once the input
// drops into the "quiet" zone so the tail snaps back instead of lingering.
export const ATTACK_ALPHA = 0.7;
export const RELEASE_ALPHA = 0.78;
export const SILENCE_RELEASE_ALPHA = 0.92;
// Targets at/below this are treated as "going silent" → fast release. Set above
// zero so the snap-back kicks in as soon as you stop talking, not only once the
// level reaches dead silence.
export const SILENCE_TARGET = 0.08;
export const IDLE_SNAP_DELTA = 0.004;

export function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

// Stateful meter: push shaped 0..1 levels in, step the displayed bars toward
// their targets once per frame. Both surfaces drive this from their own rAF.
export function createBarMeter(
  barCount = HUD_BAR_COUNT,
  weights: number[] = HUD_BAR_WEIGHTS,
  historyOffsets: number[] = HUD_BAR_HISTORY_OFFSETS,
) {
  const history = new Array<number>(LEVEL_HISTORY_LENGTH).fill(IDLE_LEVEL);
  const targets = new Array<number>(barCount).fill(IDLE_LEVEL);
  const displayed = new Array<number>(barCount).fill(IDLE_LEVEL);
  let head = 0;

  function pushLevel(level: number) {
    head = (head + 1) % LEVEL_HISTORY_LENGTH;
    history[head] = level;
    for (let i = 0; i < barCount; i++) {
      const weight = weights[i] ?? 0.5;
      const offset = historyOffsets[i] ?? 0;
      const historyIndex =
        (head - offset + LEVEL_HISTORY_LENGTH) % LEVEL_HISTORY_LENGTH;
      const blended =
        history[head] * LIVE_LEVEL_MIX +
        history[historyIndex] * (1 - LIVE_LEVEL_MIX);
      targets[i] = clamp(IDLE_LEVEL + blended * weight, IDLE_LEVEL, 1);
    }
  }

  // Advance the displayed bars one frame toward their targets. Returns true
  // while anything is still moving.
  function step() {
    let animating = false;
    for (let i = 0; i < barCount; i++) {
      const diff = targets[i] - displayed[i];
      const goingSilent = targets[i] <= SILENCE_TARGET;
      const alpha =
        diff > 0
          ? ATTACK_ALPHA
          : goingSilent
            ? SILENCE_RELEASE_ALPHA
            : RELEASE_ALPHA;
      let next = clamp(displayed[i] + diff * alpha, 0, 1);
      if (
        targets[i] <= IDLE_LEVEL + IDLE_SNAP_DELTA &&
        Math.abs(next - IDLE_LEVEL) < IDLE_SNAP_DELTA
      ) {
        next = IDLE_LEVEL;
      }
      displayed[i] = next;
      if (Math.abs(targets[i] - displayed[i]) > IDLE_SNAP_DELTA) {
        animating = true;
      }
    }
    return animating;
  }

  function reset() {
    history.fill(IDLE_LEVEL);
    targets.fill(IDLE_LEVEL);
    displayed.fill(IDLE_LEVEL);
    head = 0;
  }

  return { targets, displayed, pushLevel, step, reset };
}
