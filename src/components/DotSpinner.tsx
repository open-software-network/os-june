import type { CSSProperties } from "react";
import { JUNE_SPINNER_COLS, type JuneSpinnerSize, juneSpinnerGrid } from "../lib/june-spinner-grid";

// The dot spinner, drawn rather than typeset: a full square grid of perfect
// circles with a smooth highlight that climbs diagonally from the bottom-left.
// June's stepped mark swells bright as the crest traces it; field dots ripple
// faintly. The grid and sweep order live in lib/june-spinner-grid, while the
// bounded motion lives in styles/dot-spinner.css and rests as the mark under
// prefers-reduced-motion. Each variant is a fixed-size, integer-px square rather
// than a font-scaled glyph, with a neutral gray default that contextual classes
// can override through currentColor.
//
// "sm" and "md" are compact 3×3 grids; "lg" is the 5×5 board for larger
// standalone loading moments.
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
