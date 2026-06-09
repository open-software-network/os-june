import { useEffect, useState } from "react";
import spinners from "unicode-animations/braille";

// The braille-system spinner, curled up pangolin-style: a six-dot ball rolling
// clockwise around the full 2×4 cell, leaving a two-dot gap that travels with
// it. Frames are generated over the cell's eight-dot perimeter — NOT by
// complementing the stock arc, which never touches the bottom row and so left
// dots 7+8 permanently parked there. Cadence comes from the package's braille
// spinner so the roll matches the rest of the braille family.
const BRAILLE_BASE = 0x2800;
const { interval: INTERVAL } = spinners.braille;
// Dot bits clockwise from the top-left of the cell (dot layout: 1 4 / 2 5 /
// 3 6 / 7 8 — bits 1=0x01 2=0x02 3=0x04 4=0x08 5=0x10 6=0x20 7=0x40 8=0x80).
const PERIMETER = [0x01, 0x08, 0x10, 0x20, 0x80, 0x40, 0x04, 0x02];
const BALL_DOTS = 6;
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
// Resting pose for prefers-reduced-motion: the fully curled ball, no rolling.
const STATIC_FRAME = String.fromCodePoint(BRAILLE_BASE + 0xff);

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
