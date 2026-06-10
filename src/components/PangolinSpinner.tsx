// The pangolin spinner, drawn rather than typeset: a 2×2 grid of perfect
// circles with a dim spot rolling clockwise around it — the curled pangolin.
// (The earlier braille-glyph version left dot shape/spacing to the font;
// real circles stay crisp.) The mark is a fixed-size square — integer px,
// deliberately not font-scaled — and wrappers color it via currentColor.
// The roll is pure CSS — see .pangolin-spinner in app.css — and rests under
// prefers-reduced-motion.
type PangolinSpinnerProps = {
  className?: string;
};

export function PangolinSpinner({ className }: PangolinSpinnerProps) {
  // The surrounding status text carries the meaning for assistive tech, so the
  // glyph is decorative.
  return (
    <span
      className={["pangolin-spinner", className].filter(Boolean).join(" ")}
      aria-hidden
    >
      <span />
      <span />
      <span />
      <span />
    </span>
  );
}
