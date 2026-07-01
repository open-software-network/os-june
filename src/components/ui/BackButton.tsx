import { IconChevronLeftSmall } from "central-icons/IconChevronLeftSmall";
import type { ReactNode } from "react";

type Props = {
  label: string;
  onClick: () => void;
  children?: ReactNode;
  className?: string;
};

export function BackButton({ label, onClick, children, className }: Props) {
  const classes = [children ? "back-button" : "back-button back-button-icon", className]
    .filter(Boolean)
    .join(" ");

  return (
    <button type="button" className={classes} aria-label={label} title={label} onClick={onClick}>
      <IconChevronLeftSmall size={16} />
      {children ? <span className="back-button-label">{children}</span> : null}
    </button>
  );
}
