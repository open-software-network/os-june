// Shared waveform meter: bar synthesis + envelope ballistics used by BOTH the
// dictation HUD (hud.ts) and the note recorder (recorder/Waveform.tsx) so the
// two waveforms share one design language. Bar count/weights are per-surface
// (both are now 7-bar symmetric "lens" rows), and the per-meter options below
// let the HUD layer on its travelling-wave motion without touching the recorder.
//
// Inputs are already-shaped 0..1 levels (each surface shapes its own raw audio
// before pushing — the HUD from the helper's level, the recorder from peaks).

// HUD: 7 bars, a symmetric lens (low edges, tall center) tuned 2026-06-04 to
// match Wispr Flow's waveform. The center stays elevated while speaking; the
// HUD drives motion via the travelling-wave options rather than these offsets.
export const HUD_BAR_COUNT = 7;
export const HUD_BAR_WEIGHTS = [0.55, 0.633, 0.797, 0.88, 0.797, 0.633, 0.55];
export const HUD_BAR_HISTORY_OFFSETS = [1, 0, 1, 0, 1, 0, 1];

// Recorder: 7 bars, symmetric with a taller center, to fill its wider/taller
// meter area.
export const RECORDER_BAR_COUNT = 7;
export const RECORDER_BAR_WEIGHTS = [0.6, 0.84, 0.72, 0.9, 0.72, 0.84, 0.6];
export const RECORDER_BAR_HISTORY_OFFSETS = [1, 0, 1, 0, 1, 0, 1];

// Long enough that the HUD's per-bar propagation delays (a loud moment travels
// across the row over several pushes) have history to read back from. The
// recorder only reads the freshest one/two samples, so the extra length is free.
export const LEVEL_HISTORY_LENGTH = 32;
export const LIVE_LEVEL_MIX = 0.7;
export const IDLE_LEVEL = 0;

export type BarMeterOptions = {
  // Blend of the freshest sample vs a slightly older one. Lower = more
  // smear/lag (smoother), higher = more reactive. Default = LIVE_LEVEL_MIX.
  liveLevelMix?: number;
  // >0 makes the speaking envelope travel across the row: each bar reads the
  // history delayed by its distance × propDelay (in pushes), so a loud moment
  // sweeps across instead of every center bar spiking at once. 0 = the original
  // fixed [1,0,1,0,…] one-push offset shimmer (what the recorder uses).
  propDelay?: number;
  // Where the travelling wave originates: "across" = left→right sweep,
  // "center" = ripple outward from the middle.
  propMode?: "across" | "center";
  // 0..1 neighbour blend that smooths the wave across bars instead of letting
  // single bars spike. 0 = off.
  spatial?: number;
};

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
  options: BarMeterOptions = {},
) {
  const liveLevelMix = options.liveLevelMix ?? LIVE_LEVEL_MIX;
  const propDelay = options.propDelay ?? 0;
  const propMode = options.propMode ?? "across";
  const spatial = options.spatial ?? 0;

  const history = new Array<number>(LEVEL_HISTORY_LENGTH).fill(IDLE_LEVEL);
  const targets = new Array<number>(barCount).fill(IDLE_LEVEL);
  const displayed = new Array<number>(barCount).fill(IDLE_LEVEL);
  let head = 0;
  const len = LEVEL_HISTORY_LENGTH;
  const mid = (barCount - 1) / 2;

  // Read the envelope `d` pushes back, interpolating between the two nearest
  // ring samples so a fractional propagation delay reads smoothly.
  function sampleAt(d: number) {
    d = clamp(d, 0, len - 1);
    const base = Math.floor(d);
    const frac = d - base;
    const i0 = (((head - base) % len) + len) % len;
    const i1 = (((head - base - 1) % len) + len) % len;
    return history[i0] * (1 - frac) + history[i1] * frac;
  }

  function pushLevel(level: number) {
    head = (head + 1) % len;
    history[head] = level;
    const raw = new Array<number>(barCount);
    for (let i = 0; i < barCount; i++) {
      let sample: number;
      if (propDelay > 0) {
        // Spatial delay per bar → the speaking envelope travels across the row.
        const dist = propMode === "center" ? Math.abs(i - mid) : i;
        const delayed = sampleAt(dist * propDelay);
        sample = history[head] * liveLevelMix + delayed * (1 - liveLevelMix);
      } else {
        // Original path: a fixed [1,0,1,0,…] one-push offset shimmer.
        const offset = historyOffsets[i] ?? 0;
        const historyIndex = (((head - offset) % len) + len) % len;
        sample =
          history[head] * liveLevelMix +
          history[historyIndex] * (1 - liveLevelMix);
      }
      raw[i] = (weights[i] ?? 0.5) * sample;
    }
    // Spatial smoothing: blend each bar toward its neighbours so the wave
    // spreads smoothly across the row instead of spiking on single bars.
    for (let i = 0; i < barCount; i++) {
      let value = raw[i];
      if (spatial > 0) {
        const left = raw[i - 1] ?? raw[i];
        const right = raw[i + 1] ?? raw[i];
        value = raw[i] * (1 - spatial) + ((left + right) / 2) * spatial;
      }
      targets[i] = clamp(IDLE_LEVEL + value, IDLE_LEVEL, 1);
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
