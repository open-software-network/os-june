import type { CSSProperties } from "react";
import { SPINNER_GRID_COLS, type SpinnerSize, spinnerGrid } from "../lib/spinner-grid";

// The dot spinner, drawn rather than typeset: a full square grid of perfect
// circles with a smooth highlight that climbs diagonally from the bottom-left.
// Every dot participates equally, so the loader is neutral rather than
// logo-shaped. The grid and sweep order live in lib/spinner-grid, while the
// bounded motion lives in styles/dot-spinner.css and rests as a grid under
// prefers-reduced-motion. Each variant is a fixed-size, integer-px square rather
// than a font-scaled glyph. Its theme-aware neutral default is exposed through
// --spinner-neutral; contextual wrappers can override --spinner-color.
//
// "sm" and "md" are compact 3×3 grids; "lg" is the 5×5 board for larger
// standalone loading moments.
type DotSpinnerProps = {
  className?: string;
  size?: SpinnerSize;
};

export function DotSpinner({ className, size = "sm" }: DotSpinnerProps) {
  const cells = spinnerGrid(size);
  // The surrounding status text carries the meaning for assistive tech, so the
  // glyph is decorative.
  return (
    <span
      className={["dot-spinner", className].filter(Boolean).join(" ")}
      data-size={size}
      style={{ "--spinner-cols": SPINNER_GRID_COLS[size] } as CSSProperties}
      aria-hidden
    >
      {cells.map((cell, i) => (
        <span
          // Fixed-length constant grid: index is a stable key.
          // biome-ignore lint/suspicious/noArrayIndexKey: the grid is a fixed-length constant.
          key={i}
          data-mark={cell.mark ? "" : undefined}
          style={{ "--spinner-order": cell.order } as CSSProperties}
        />
      ))}
    </span>
  );
}
