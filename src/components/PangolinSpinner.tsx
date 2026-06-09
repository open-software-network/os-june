import { useEffect, useState } from "react";
import spinners from "unicode-animations/braille";

// The braille-system spinner, curled up pangolin-style: a three-dot ball
// rolling clockwise around a 2×2 square, leaving a one-dot gap that travels
// with it (⠲⠴⠦⠖). The square uses the cell's MIDDLE two rows (dots 2/5 and
// 3/6) so it sits vertically centered in the glyph box — and reads square
// rather than the tall oval the full 2×4 cell gives. Cadence keeps the
// package's braille revolution period so the roll speed matches the family.
const BRAILLE_BASE = 0x2800;
// Dot bits clockwise from the square's top-left (cell layout: 1 4 / 2 5 /
// 3 6 / 7 8 — bits 1=0x01 2=0x02 3=0x04 4=0x08 5=0x10 6=0x20 7=0x40 8=0x80).
const PERIMETER = [0x02, 0x10, 0x20, 0x04];
const BALL_DOTS = 3;
const FRAMES = PERIMETER.map((_, start) =>
  String.fromCodePoint(
    BRAILLE_BASE +
      PERIMETER.reduce(
        (mask, dot, index) =>
          (index - start + PERIMETER.length) % PERIMETER.length < BALL_DOTS
            ? mask | dot
            : mask,
        0,
      ),
  ),
);
const INTERVAL =
  (spinners.braille.frames.length * spinners.braille.interval) / FRAMES.length;
// Resting pose for prefers-reduced-motion: the fully curled ball, no rolling.
const STATIC_FRAME = String.fromCodePoint(BRAILLE_BASE + 0x36);

const prefersReducedMotion = () =>
  typeof window !== "undefined" &&
  window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

type PangolinSpinnerProps = {
  className?: string;
};

export function PangolinSpinner({ className }: PangolinSpinnerProps) {
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    if (prefersReducedMotion()) return;
    const timer = setInterval(
      () => setFrame((f) => (f + 1) % FRAMES.length),
      INTERVAL,
    );
    return () => clearInterval(timer);
  }, []);

  // The surrounding status text carries the meaning for assistive tech, so the
  // glyph is decorative.
  return (
    <span
      className={["pangolin-spinner", className].filter(Boolean).join(" ")}
      aria-hidden
    >
      {prefersReducedMotion() ? STATIC_FRAME : FRAMES[frame]}
    </span>
  );
}
