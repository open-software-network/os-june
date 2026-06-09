import { useEffect, useState } from "react";
import spinners from "unicode-animations/braille";

// The braille-system spinner, curled up pangolin-style: each frame is the
// bitwise complement of the stock `braille` arc (⠋⠙⠹…), so instead of three
// dots sweeping an empty cell we get a dense ball with a one-dot gap rolling
// around it (⣴⣦⣆…) — a curled pangolin. Deriving from the package keeps us on
// the canonical frame order/interval; the inversion is the only house touch.
const BRAILLE_BASE = 0x2800;
const { frames: ARC_FRAMES, interval: INTERVAL } = spinners.braille;
const FRAMES = ARC_FRAMES.map((frame) =>
  String.fromCodePoint(
    BRAILLE_BASE +
      (0xff ^ ((frame.codePointAt(0) ?? BRAILLE_BASE) - BRAILLE_BASE)),
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
