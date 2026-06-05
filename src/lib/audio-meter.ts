// Shared waveform meter: bar synthesis + envelope ballistics used by BOTH the
// dictation HUD (hud.ts) and the note recorder (recorder/Waveform.tsx) so the
// two waveforms share one design language. Bar count/weights are per-surface
// (both are now 7-bar symmetric "lens" rows), and the per-meter options below
// let both live surfaces share the same travelling-wave motion.
//
// Inputs are already-shaped 0..1 levels (each surface shapes its own raw audio
// before pushing — the HUD from the helper's level, the recorder from peaks).

// 7-bar symmetric "lens": tapered edges, tall center (raised cosine between),
// tuned 2026-06-04 to match Wispr Flow. Shared by BOTH surfaces so the
// dictation HUD and the note recorder read as one waveform family — only their
// pixel geometry and raw-audio shaping differ. The deeper edge taper keeps loud
// speech from turning the whole row into a blunt block while the center stays
// elevated enough for whispers to read.
// Mirror of the playground's genWeights(7, centerEmphasis 0.3, edgeWeight 0.2):
// a symmetric raised-cosine lens — tall centre (0.9), edges near-flat (0.2) so
// the row reads as a calm baseline with the life concentrated in the middle.
export const LENS_BAR_WEIGHTS = [0.2, 0.375, 0.725, 0.9, 0.725, 0.375, 0.2];
export const LENS_HISTORY_OFFSETS = [1, 0, 1, 0, 1, 0, 1];

export const HUD_BAR_COUNT = 7;
export const HUD_BAR_WEIGHTS = LENS_BAR_WEIGHTS;
export const HUD_BAR_HISTORY_OFFSETS = LENS_HISTORY_OFFSETS;

export const RECORDER_BAR_COUNT = 7;
export const RECORDER_BAR_WEIGHTS = LENS_BAR_WEIGHTS;
export const RECORDER_BAR_HISTORY_OFFSETS = LENS_HISTORY_OFFSETS;

// Long enough that the HUD's per-bar propagation delays (a loud moment travels
// across the row over several pushes) have history to read back from. The
// recorder uses the same travelling wave, so both live surfaces need enough
// history for delayed bar samples.
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
  // fixed [1,0,1,0,…] one-push offset shimmer.
  propDelay?: number;
  // Where the travelling wave originates: "across" = left→right sweep,
  // "center" = ripple outward from the middle.
  propMode?: "across" | "center";
  // 0..1 neighbour blend that smooths the wave across bars instead of letting
  // single bars spike. 0 = off.
  spatial?: number;
};

// The travelling-wave motion shared by both live surfaces (HUD + recorder): a
// smearier blend plus a speaking envelope that sweeps left→right across the row,
// smoothed between neighbours, instead of center bars spiking. Pass to
// createBarMeter so both surfaces move identically.
export const LIVE_WAVE_OPTIONS: BarMeterOptions = {
  liveLevelMix: 0.45,
  propDelay: 0.4,
  propMode: "across",
  spatial: 0.22,
};

// Idle travelling pulse — at rest the row is flat and a single soft pulse sweeps
// left→right across it as a "we're listening / time passing" signifier. Layered
// UNDER the audio response (ducks away once a bar gets loud). Shared so the HUD
// and recorder read identically. Mirror of the playground's idle-pulse model.
export const IDLE_PULSE_AMP = 0.13;
export const IDLE_PULSE_SPEED = 0.5; // passes per second across the row
export const IDLE_PULSE_WIDTH = 1.0; // bars — width of the travelling pulse
export const IDLE_PULSE_GAP = 3; // empty bars before the pulse loops back
export const IDLE_PULSE_DUCKING = 0.9; // how much it recedes while speaking

// Speech wave — a very subtle shimmer that carries across WHILE speaking, its
// amplitude scaled by current loudness (so it's invisible at rest and rides on
// top of the peak). The per-bar phase gives it the left→right travel.
export const SPEECH_WAVE_AMP = 0.05;
export const SPEECH_WAVE_SPEED = 1.3; // cycles per second
export const SPEECH_WAVE_SPREAD = 1.6; // radians of phase per bar
export const SPEECH_WAVE_CURVE = 1.0; // loudness exponent (>1 = only when loud)

// Paint helper shared by both live surfaces: layer the idle pulse + speech wave
// onto a bar's displayed `level`. `speech` is the current overall loudness (the
// max displayed bar, 0..1) and `barCount` sizes the pulse travel. Mirrors the
// playground's paint() exactly so the HUD and recorder match the tuning tool.
export function withWaveLayers(
  level: number,
  index: number,
  timeMs: number,
  speech: number,
  barCount: number,
) {
  const t = timeMs / 1000;
  let lvl = level;
  if (IDLE_PULSE_AMP > 0) {
    const span = barCount - 1 + IDLE_PULSE_GAP;
    const pos = ((IDLE_PULSE_SPEED * t) % 1) * span;
    const d = index - pos;
    const bump = Math.exp(-(d * d) / (2 * IDLE_PULSE_WIDTH * IDLE_PULSE_WIDTH));
    lvl = clamp(
      lvl + IDLE_PULSE_AMP * bump * (1 - lvl * IDLE_PULSE_DUCKING),
      0,
      1,
    );
  }
  if (SPEECH_WAVE_AMP > 0) {
    const crest = Math.sin(
      2 * Math.PI * SPEECH_WAVE_SPEED * t - index * SPEECH_WAVE_SPREAD,
    );
    const drive = Math.pow(speech, SPEECH_WAVE_CURVE);
    lvl = clamp(lvl + SPEECH_WAVE_AMP * drive * crest, 0, 1);
  }
  return lvl;
}

// Ballistics, applied per rAF frame (~60fps). Fast attack on the way up, a
// quick release on the way down, and an even quicker collapse once the input
// drops into the "quiet" zone so the tail snaps back instead of lingering.
export const ATTACK_ALPHA = 0.64;
export const RELEASE_ALPHA = 0.7;
export const SILENCE_RELEASE_ALPHA = 0.96;
// Targets at/below this are treated as "going silent" → fast release. Set above
// zero so the snap-back kicks in as soon as you stop talking, not only once the
// level reaches dead silence.
export const SILENCE_TARGET = 0.14;
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
