import type { CSSProperties } from "react";
import { JUNE_SPINNER_COLS, type JuneSpinnerSize, juneSpinnerGrid } from "../lib/june-spinner-grid";

// The dot spinner, drawn rather than typeset: a full square grid of perfect
// circles with a smooth highlight that climbs diagonally from the bottom-left.
// The dots on June's mark — a stepped stroke from the squircle logo — swell
// bright and large as the wave traces up it; the rest of the grid ripples
// faintly, so the matrix reads as June's ascending stroke. The grid and each cell's sweep order
// live in lib/june-spinner-grid; the motion is pure CSS — see
// styles/dot-spinner.css — and rests as the mark under prefers-reduced-motion.
// The grid is a fixed-size square per variant — integer px, deliberately not
// font-scaled — and wrappers color it via currentColor.
//
// "sm" is the 3×3 grid for inline and small loaders; "lg" is the 5×5 grid for
// larger standalone loading moments.
type DotSpinnerProps = {
  className?: string;
  size?: JuneSpinnerSize;
};

export function DotSpinner({ className, size = "sm" }: DotSpinnerProps) {
  const cells = juneSpinnerGrid(size);
  // The surrounding status text carries the meaning for assistive tech, so the
  // glyph is decorative.
  return (
    <span
      className={["dot-spinner", className].filter(Boolean).join(" ")}
      data-size={size}
      style={{ "--june-cols": JUNE_SPINNER_COLS[size] } as CSSProperties}
      aria-hidden
    >
      {cells.map((cell, i) => (
        <span
          // Fixed-length constant grid: index is a stable key.
          // biome-ignore lint/suspicious/noArrayIndexKey: the grid is a fixed-length constant.
          key={i}
          data-mark={cell.mark ? "" : undefined}
          style={{ "--june-order": cell.order } as CSSProperties}
        />
      ))}
    </span>
  );
}
