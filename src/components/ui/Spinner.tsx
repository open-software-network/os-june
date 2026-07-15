import { DotSpinner } from "../DotSpinner";
import type { JuneSpinnerSize } from "../../lib/june-spinner-grid";

// The app-wide loading indicator: the dot spinner that draws June's mark (see
// DotSpinner). This wrapper owns the accessibility contract — the glyph itself
// is decorative. "sm" (3×3) is the compact default, "md" is a slightly larger
// 3×3 option, and "lg" is the 5×5 board for standalone loading moments.
type SpinnerProps = {
  className?: string;
  size?: JuneSpinnerSize;
  "aria-hidden"?: boolean;
  "aria-label"?: string;
};

export function Spinner({
  className,
  size,
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
      <DotSpinner size={size} />
    </span>
  );
}
