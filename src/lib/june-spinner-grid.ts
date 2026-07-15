// The shape the dot spinner draws: June's sparkle mark on a dot matrix (see
// src/assets/june-mark.svg for the mark it echoes). One source of truth so the
// React spinner (components/DotSpinner.tsx) and the plain-DOM agent HUD
// (agent-hud.ts, which has no React tree) light the exact same dots.
//
// The mark is not lit all at once — it is *drawn*, one stroke at a time, the way
// a flip-dot board fills in: bottom-left accent, then the top bar left to right,
// the top-right accent, the lower-left accent, the bottom bar, and finally the
// right accent. Each lit cell therefore carries a draw ORDER (0 first); the
// timing in dot-spinner.css staggers each dot's fade-in by that order, so the
// mark keeps drawing itself, holding, and redrawing. Off cells (null) stay as
// dim resting dots so the whole matrix reads like a flip-dot board.
//
// Two variants share one mark: "lg" is the 7×7 board; "sm" is the same drawing
// with the 1-dot border cropped to 5×5 (the mark already lives in the interior
// 5×5, so the two are the same strokes at two scales). "sm" is for inline and
// small loaders, "lg" for larger standalone loading moments.

export type JuneSpinnerSize = "sm" | "lg";

export const JUNE_SPINNER_COLS: Record<JuneSpinnerSize, number> = {
  sm: 5,
  lg: 7,
};

// Row-major grids. null = off (dim resting dot); 0..9 = the dot's draw order.
// biome-ignore format: the grid layout is the documentation.
const SM_ORDER: readonly (number | null)[] = [
  // . . . . X          . . . . 4
  // . X X X .          . 1 2 3 .
  // X . . . X          0 . . . 9
  // . X X X .          . 6 7 8 .
  // X . . . .          5 . . . .
  null, null, null, null,    4,
  null,    1,    2,    3, null,
     0, null, null, null,    9,
  null,    6,    7,    8, null,
     5, null, null, null, null,
];

// The 7×7 board: the SM mark inset by one dot on every side. Same strokes,
// same order, decoded straight from the reference frames.
// biome-ignore format: the grid layout is the documentation.
const LG_ORDER: readonly (number | null)[] = [
  null, null, null, null, null, null, null,
  null, null, null, null, null,    4, null,
  null, null,    1,    2,    3, null, null,
  null,    0, null, null, null,    9, null,
  null, null,    6,    7,    8, null, null,
  null,    5, null, null, null, null, null,
  null, null, null, null, null, null, null,
];

export const JUNE_SPINNER_ORDER: Record<JuneSpinnerSize, readonly (number | null)[]> = {
  sm: SM_ORDER,
  lg: LG_ORDER,
};
