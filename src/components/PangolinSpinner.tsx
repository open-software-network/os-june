import { useEffect, useState } from "react";

// A hand-authored braille spinner: a 3-dot arc that sweeps clockwise around a
// single cell — a curled pangolin rolling in a perfect circle. Each frame ORs
// three adjacent perimeter dots so the "curl" rotates smoothly. Conveys the
// agent working (used on running sidebar sessions).
const FRAMES = ["⠙", "⠸", "⢰", "⣠", "⣄", "⡆", "⠇", "⠋"];
const INTERVAL = 110;

type PangolinSpinnerProps = {
  className?: string;
};

export function PangolinSpinner({ className }: PangolinSpinnerProps) {
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    const timer = setInterval(
      () => setFrame((f) => (f + 1) % FRAMES.length),
      INTERVAL,
    );
    return () => clearInterval(timer);
  }, []);

  // The surrounding status text carries the meaning for assistive tech, so the
  // glyph is decorative.
  return (
    <span className={className} aria-hidden>
      {FRAMES[frame]}
    </span>
  );
}
