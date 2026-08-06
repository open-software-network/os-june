// The dot spinner is a neutral square grid with a smooth brightness highlight
// that climbs diagonally from the bottom-left. One source of
// truth keeps the React spinner (components/DotSpinner.tsx) and the plain-DOM
// agent HUD (agent-hud.ts, which has no React tree) on the exact same grid.
//
// Each cell carries a sweep order — its diagonal
// distance from the bottom-left corner — and dot-spinner.css rides a reveal keyed
// to that order, so the crest traces the stroke from bottom-left to top-right,
// settles, and takes a short breath before the next pass.

export type SpinnerSize = "sm" | "md" | "lg";

// "sm" and "md" share the compact 3×3 mark at different optical sizes; "lg"
// uses the full 5×5 mark for larger standalone loading moments.
export const SPINNER_GRID_COLS: Record<SpinnerSize, number> = {
  sm: 3,
  md: 3,
  lg: 5,
};

// Every cell participates equally so the loader remains deliberately neutral,
// independent of the product logo.
// biome-ignore format: the grid layout is the documentation.
const SM_MARK: readonly number[] = [
  1, 1, 1,
  1, 1, 1,
  1, 1, 1,
];

// biome-ignore format: the grid layout is the documentation.
const LG_MARK: readonly number[] = [
  1, 1, 1, 1, 1,
  1, 1, 1, 1, 1,
  1, 1, 1, 1, 1,
  1, 1, 1, 1, 1,
  1, 1, 1, 1, 1,
];

const SPINNER_GRID_ACTIVE: Record<SpinnerSize, readonly number[]> = {
  sm: SM_MARK,
  md: SM_MARK,
  lg: LG_MARK,
};

export type SpinnerCell = {
  // Sweep order: diagonal distance from the bottom-left corner, so the highlight
  // climbs from bottom-left to top-right.
  order: number;
  // Whether the cell participates in the bright sweep.
  mark: boolean;
};

// The full grid for a variant: every cell, in row-major order, with its sweep
// order and whether it participates in the bright sweep.
export function spinnerGrid(size: SpinnerSize): SpinnerCell[] {
  const cols = SPINNER_GRID_COLS[size];
  return SPINNER_GRID_ACTIVE[size].map((lit, i) => {
    const row = Math.floor(i / cols);
    const col = i % cols;
    // Diagonal distance from the bottom-left corner (row = cols - 1).
    return { order: col + (cols - 1 - row), mark: lit === 1 };
  });
}
