import type { CSSProperties } from "react";
import { JUNE_SPINNER_ORDER, type JuneSpinnerSize } from "../lib/june-spinner-grid";

// The dot spinner, drawn rather than typeset: a matrix of perfect circles that
// draws June's sparkle mark stroke by stroke, holds it, and redraws — a
// flip-dot board writing the brand mark. (The earlier version was a 2×2 square
// with a spot rolling around it.) The lit dots and their draw order live in
// lib/june-spinner-grid; the roll is pure CSS — see styles/dot-spinner.css — and
// rests under prefers-reduced-motion. The mark is a fixed-size square per
// variant — integer px, deliberately not font-scaled — and wrappers color it via
// currentColor.
//
// "sm" is the 5×5 mark for inline and small loaders; "lg" is the 7×7 board for
// larger standalone loading moments.
type DotSpinnerProps = {
  className?: string;
  size?: JuneSpinnerSize;
};

export function DotSpinner({ className, size = "sm" }: DotSpinnerProps) {
  const order = JUNE_SPINNER_ORDER[size];
  // The surrounding status text carries the meaning for assistive tech, so the
  // glyph is decorative.
  return (
    <span
      className={["dot-spinner", className].filter(Boolean).join(" ")}
      data-size={size}
      aria-hidden
    >
      {order.map((step, i) => (
        <span
          // Fixed-length constant grid: index is a stable key.
          // biome-ignore lint/suspicious/noArrayIndexKey: the grid is a fixed-length constant.
          key={i}
          data-lit={step === null ? undefined : ""}
          style={step === null ? undefined : ({ "--june-order": step } as CSSProperties)}
        />
      ))}
    </span>
  );
}
