import { LoaderIcon } from "lucide-react";
import type { ComponentProps } from "react";

type SpinnerProps = ComponentProps<typeof LoaderIcon>;

export function Spinner({
  className,
  "aria-hidden": ariaHidden,
  "aria-label": ariaLabel,
  ...props
}: SpinnerProps) {
  const classes = ["spinner", className].filter(Boolean).join(" ");
  return (
    <LoaderIcon
      role={ariaHidden ? undefined : "status"}
      aria-hidden={ariaHidden}
      aria-label={ariaHidden ? undefined : (ariaLabel ?? "Loading")}
      className={classes}
      {...props}
    />
  );
}
