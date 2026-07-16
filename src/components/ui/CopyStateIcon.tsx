import { IconCheckmark2Medium } from "central-icons/IconCheckmark2Medium";
import { IconSquareBehindSquare1 } from "central-icons/IconSquareBehindSquare1";
import type { ReactNode } from "react";

export function CopyStateIcon({ copied, idleIcon }: { copied: boolean; idleIcon?: ReactNode }) {
  return (
    <span className="t-icon-swap" data-state={copied ? "b" : "a"} aria-hidden>
      <span className="t-icon" data-icon="a">
        {idleIcon ?? <IconSquareBehindSquare1 size={14} />}
      </span>
      <span className="t-icon" data-icon="b">
        <IconCheckmark2Medium size={14} />
      </span>
    </span>
  );
}
