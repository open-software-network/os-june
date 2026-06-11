// The dot spinner, drawn rather than typeset: a 2×2 grid of perfect
// circles with a dim spot rolling clockwise around it. (The earlier
// braille-glyph version left dot shape/spacing to the font; real circles
// stay crisp.) The mark is a fixed-size square — integer px, deliberately
// not font-scaled — and wrappers color it via currentColor. The roll is
// pure CSS — see styles/dot-spinner.css — and rests under
// prefers-reduced-motion.
type DotSpinnerProps = {
  className?: string;
};

export function DotSpinner({ className }: DotSpinnerProps) {
  // The surrounding status text carries the meaning for assistive tech, so the
  // glyph is decorative.
  return (
    <span
      className={["dot-spinner", className].filter(Boolean).join(" ")}
      aria-hidden
    >
      <span />
      <span />
      <span />
      <span />
    </span>
  );
}
