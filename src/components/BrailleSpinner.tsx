import { useEffect, useState } from "react";
import spinners from "unicode-animations/braille";

// Classic braille dots — the `ora`-style default. Frame data is just
// `{ frames, interval }`, so we advance it ourselves on a timer.
const { frames, interval } = spinners.braille;

type BrailleSpinnerProps = {
  className?: string;
};

export function BrailleSpinner({ className }: BrailleSpinnerProps) {
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    const timer = setInterval(
      () => setFrame((f) => (f + 1) % frames.length),
      interval,
    );
    return () => clearInterval(timer);
  }, []);

  // The surrounding status text carries the meaning for assistive tech, so
  // the glyph is decorative.
  return (
    <span className={className} aria-hidden>
      {frames[frame]}
    </span>
  );
}
