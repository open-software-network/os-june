// Shared waveform meter: bar synthesis + envelope ballistics used by BOTH the
// dictation HUD (hud.ts) and the note recorder (recorder/Waveform.tsx) so the
// two waveforms move and look identically. The HUD is the canonical design;
// the recorder is brought over to match it.
//
// Inputs are already-shaped 0..1 levels (each surface shapes its own raw audio
// before pushing — the HUD from the helper's level, the recorder from peaks).

export const BAR_COUNT = 5;
// Per-bar weight + history offset so each bar samples slightly different recent
// audio — keeps the shape coherent without every bar moving identically.
export const BAR_WEIGHTS = [0.64, 0.86, 0.7, 0.84, 0.58];
export const BAR_HISTORY_OFFSETS = [1, 0, 1, 0, 1];
export const LEVEL_HISTORY_LENGTH = 8;
export const LIVE_LEVEL_MIX = 0.7;
export const IDLE_LEVEL = 0;

// Ballistics, applied per rAF frame (~60fps). Fast attack on the way up, a
// smooth release on the way down, and a quicker collapse to zero once the input
// goes silent so the tail snaps back instead of lingering.
export const ATTACK_ALPHA = 0.7;
export const RELEASE_ALPHA = 0.7;
export const SILENCE_RELEASE_ALPHA = 0.9;
export const IDLE_SNAP_DELTA = 0.004;

export function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

// Stateful meter: push shaped 0..1 levels in, step the displayed bars toward
// their targets once per frame. Both surfaces drive this from their own rAF.
export function createBarMeter() {
  const history = new Array<number>(LEVEL_HISTORY_LENGTH).fill(IDLE_LEVEL);
  const targets = new Array<number>(BAR_COUNT).fill(IDLE_LEVEL);
  const displayed = new Array<number>(BAR_COUNT).fill(IDLE_LEVEL);
  let head = 0;

  function pushLevel(level: number) {
    head = (head + 1) % LEVEL_HISTORY_LENGTH;
    history[head] = level;
    for (let i = 0; i < BAR_COUNT; i++) {
      const weight = BAR_WEIGHTS[i] ?? 0.5;
      const offset = BAR_HISTORY_OFFSETS[i] ?? 0;
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
    for (let i = 0; i < BAR_COUNT; i++) {
      const diff = targets[i] - displayed[i];
      const goingSilent = targets[i] <= IDLE_LEVEL + IDLE_SNAP_DELTA;
      const alpha =
        diff > 0
          ? ATTACK_ALPHA
          : goingSilent
            ? SILENCE_RELEASE_ALPHA
            : RELEASE_ALPHA;
      let next = clamp(displayed[i] + diff * alpha, 0, 1);
      if (goingSilent && Math.abs(next - IDLE_LEVEL) < IDLE_SNAP_DELTA) {
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
