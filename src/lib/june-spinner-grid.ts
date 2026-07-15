// The dot spinner is a full square grid of dots with a smooth highlight that
// sweeps left to right across it. Every cell is a dot; the dots on June's mark
// swell bright and large as the wave passes, while the rest of the grid ripples
// faintly, so a plain dot matrix reads as June. One source of truth so the React
// spinner (components/DotSpinner.tsx) and the plain-DOM agent HUD (agent-hud.ts,
// which has no React tree) build the exact same grid.
//
// June's mark is the two stepped strokes of the squircle logo (see
// src/assets/june-agents-mark.svg), each ascending low-left → high-right. At 3×3
// the mark abstracts to one stepped stroke: the bottom-left corner, across the
// middle row, up to the top-right corner (a `_/‾` step); at 5×5 it separates
// into the full two strokes. Each cell carries a sweep order — its diagonal
// distance from the bottom-left corner — and dot-spinner.css rides a swell keyed
// to that order, so the crest climbs from bottom-left to top-right, tracing the
// stroke's path, and loops.

export type JuneSpinnerSize = "sm" | "lg";

// "sm" is the 3×3 grid for inline and small loaders; "lg" is the 5×5 grid for
// larger standalone loading moments.
export const JUNE_SPINNER_COLS: Record<JuneSpinnerSize, number> = {
  sm: 3,
  lg: 5,
};

// Row-major masks marking June's stroke(s) within the full grid. 1 = a mark dot
// (swells bright), 0 = a field dot (ripples faintly).
// 3×3: one stepped stroke — bottom-left corner, across the middle row, up to the
// top-right corner.
// biome-ignore format: the grid layout is the documentation.
const SM_MARK: readonly number[] = [
  0, 0, 1,
  1, 1, 1,
  1, 0, 0,
];

// 5×5: the two ascending strokes, traced 1:1 from the rasterized logo.
// biome-ignore format: the grid layout is the documentation.
const LG_MARK: readonly number[] = [
  0, 0, 0, 0, 1,
  0, 1, 1, 1, 0,
  1, 0, 0, 0, 1,
  0, 1, 1, 1, 0,
  1, 0, 0, 0, 0,
];

const JUNE_SPINNER_MARK: Record<JuneSpinnerSize, readonly number[]> = {
  sm: SM_MARK,
  lg: LG_MARK,
};

export type JuneSpinnerCell = {
  // Sweep order: diagonal distance from the bottom-left corner, so the highlight
  // climbs from bottom-left to top-right, tracing June's ascending stroke.
  order: number;
  // Whether the cell sits on June's mark and swells bright.
  mark: boolean;
};

// The full grid for a variant: every cell, in row-major order, with its sweep
// order and whether it lands on June's mark.
export function juneSpinnerGrid(size: JuneSpinnerSize): JuneSpinnerCell[] {
  const cols = JUNE_SPINNER_COLS[size];
  return JUNE_SPINNER_MARK[size].map((lit, i) => {
    const row = Math.floor(i / cols);
    const col = i % cols;
    // Diagonal distance from the bottom-left corner (row = cols - 1).
    return { order: col + (cols - 1 - row), mark: lit === 1 };
  });
}
