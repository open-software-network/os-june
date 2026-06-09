import { PangolinSpinner } from "../PangolinSpinner";

// The app-wide loading indicator: the rolling pangolin (see PangolinSpinner).
// This wrapper owns the accessibility contract — the glyph itself is decorative.
type SpinnerProps = {
  className?: string;
  size?: number;
  "aria-hidden"?: boolean;
  "aria-label"?: string;
};

export function Spinner({
  className,
  size = 16,
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
      style={{ fontSize: size }}
    >
      <PangolinSpinner />
    </span>
  );
}
