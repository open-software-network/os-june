// The dot spinner is a full square grid with a smooth brightness highlight that
// climbs diagonally from the bottom-left. Dots on June's mark brighten to full;
// field dots ripple faintly, so a plain matrix reads as June. One source of
// truth keeps the React spinner (components/DotSpinner.tsx) and the plain-DOM
// agent HUD (agent-hud.ts, which has no React tree) on the exact same grid.
//
// June's mark is the two stepped strokes of the squircle logo (see
// src/assets/june-agents-mark.svg), each ascending low-left → high-right. At 3×3
// the mark abstracts to one stepped stroke: the bottom-left corner, across the
// middle row, up to the top-right corner (a `_/‾` step); at 5×5 it separates
// into the full two strokes. Each cell carries a sweep order — its diagonal
// distance from the bottom-left corner — and dot-spinner.css rides a reveal keyed
// to that order, so the crest traces the stroke from bottom-left to top-right,
// settles, and takes a short breath before the next pass.

export type JuneSpinnerSize = "sm" | "md" | "lg";

// "sm" and "md" share the compact 3×3 mark at different optical sizes; "lg"
// uses the full 5×5 mark for larger standalone loading moments.
export const JUNE_SPINNER_COLS: Record<JuneSpinnerSize, number> = {
  sm: 3,
  md: 3,
  lg: 5,
};

// Row-major masks marking June's stroke(s) within the full grid. 1 = a mark dot
// (reveals at full brightness), 0 = a field dot (ripples faintly).
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
  md: SM_MARK,
  lg: LG_MARK,
};

export type JuneSpinnerCell = {
  // Sweep order: diagonal distance from the bottom-left corner, so the highlight
  // climbs from bottom-left to top-right, tracing June's ascending stroke.
  order: number;
  // Whether the cell sits on June's mark and reveals bright.
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
