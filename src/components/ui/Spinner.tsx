import { DotSpinner } from "../DotSpinner";

// The app-wide loading indicator: the rolling dot spinner (see DotSpinner).
// This wrapper owns the accessibility contract — the glyph itself is decorative.
// The mark is a fixed-size 2×2 dot square by design (no size knob); wrappers
// only set color via currentColor.
type SpinnerProps = {
  className?: string;
  "aria-hidden"?: boolean;
  "aria-label"?: string;
};

export function Spinner({
  className,
  "aria-hidden": ariaHidden,
  "aria-label": ariaLabel,
}: SpinnerProps) {
  const classes = ["spinner", className].filter(Boolean).join(" ");
  return (
    <span
      role={ariaHidden ? undefined : "status"}
      aria-hidden={ariaHidden}
      aria-label={ariaHidden ? undefined : (ariaLabel ?? "Loading")}
      className={classes}
    >
      <DotSpinner />
    </span>
  );
}
