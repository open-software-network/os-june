import {
  type HTMLAttributes,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

const TIP_WIDTH = 300;
const TIP_GAP = 6;
const VIEWPORT_MARGIN = 8;
// Flip above the anchor when less than this remains below — enough for the
// longest privacy explainer at TIP_WIDTH without clipping.
const MIN_SPACE_BELOW = 200;

type TipPosition = {
  side: "top" | "bottom";
  top: number;
  left: number;
};

type HoverTipProps = HTMLAttributes<HTMLSpanElement> & {
  /** Callout body shown on hover/focus of the wrapped content. */
  tip: ReactNode;
  children: ReactNode;
};

/**
 * Hover/focus callout card — the rich replacement for a native `title`
 * tooltip (instant, styled, multi-line). The card renders into a body portal
 * at a fixed position, so it never clips inside scroll containers or dialog
 * cards; scrolling anywhere dismisses it rather than letting it drift off its
 * anchor.
 */
export function HoverTip({ tip, children, ...spanProps }: HoverTipProps) {
  const anchorRef = useRef<HTMLSpanElement | null>(null);
  const [position, setPosition] = useState<TipPosition>();

  function show() {
    const rect = anchorRef.current?.getBoundingClientRect();
    if (!rect) return;
    const left = Math.min(
      Math.max(rect.left + rect.width / 2 - TIP_WIDTH / 2, VIEWPORT_MARGIN),
      window.innerWidth - TIP_WIDTH - VIEWPORT_MARGIN,
    );
    const side =
      window.innerHeight - rect.bottom < MIN_SPACE_BELOW ? "top" : "bottom";
    setPosition({
      side,
      left,
      top: side === "bottom" ? rect.bottom + TIP_GAP : rect.top - TIP_GAP,
    });
  }

  function hide() {
    setPosition(undefined);
  }

  useEffect(() => {
    if (!position) return;
    function dismiss() {
      setPosition(undefined);
    }
    window.addEventListener("scroll", dismiss, true);
    window.addEventListener("resize", dismiss);
    return () => {
      window.removeEventListener("scroll", dismiss, true);
      window.removeEventListener("resize", dismiss);
    };
  }, [position]);

  return (
    <span
      ref={anchorRef}
      {...spanProps}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
    >
      {children}
      {position
        ? createPortal(
            <span
              className="hover-tip"
              role="tooltip"
              data-side={position.side}
              style={{
                top: position.top,
                left: position.left,
                width: TIP_WIDTH,
              }}
            >
              {tip}
            </span>,
            document.body,
          )
        : null}
    </span>
  );
}
