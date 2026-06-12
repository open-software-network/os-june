import {
  type HTMLAttributes,
  type ReactNode,
  useEffect,
  useId,
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
// Hover-intent delay before the card opens — a pointer sweeping across the
// anchor should not flash it. Matches the model popover's flyout debounce;
// keyboard focus stays immediate.
const HOVER_INTENT_MS = 150;

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
 * tooltip (styled, multi-line, hover-intent debounced). The card renders into
 * a body portal at a fixed position, so it never clips inside scroll
 * containers or dialog cards; scrolling anywhere dismisses it rather than
 * letting it drift off its anchor.
 */
export function HoverTip({ tip, children, ...spanProps }: HoverTipProps) {
  const {
    "aria-describedby": ariaDescribedBy,
    onBlur,
    onFocus,
    onMouseEnter,
    onMouseLeave,
    ...restSpanProps
  } = spanProps;
  const anchorRef = useRef<HTMLSpanElement | null>(null);
  const hoverTimerRef = useRef<number | null>(null);
  const tooltipId = useId();
  const [position, setPosition] = useState<TipPosition>();
  const describedBy = [ariaDescribedBy, position ? tooltipId : null]
    .filter(Boolean)
    .join(" ");

  function cancelHoverIntent() {
    if (hoverTimerRef.current !== null) {
      window.clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
  }

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

  function showAfterHoverIntent() {
    cancelHoverIntent();
    hoverTimerRef.current = window.setTimeout(show, HOVER_INTENT_MS);
  }

  function hide() {
    cancelHoverIntent();
    setPosition(undefined);
  }

  useEffect(() => cancelHoverIntent, []);

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
      {...restSpanProps}
      aria-describedby={describedBy}
      onMouseEnter={(event) => {
        onMouseEnter?.(event);
        showAfterHoverIntent();
      }}
      onMouseLeave={(event) => {
        onMouseLeave?.(event);
        hide();
      }}
      onFocus={(event) => {
        onFocus?.(event);
        show();
      }}
      onBlur={(event) => {
        onBlur?.(event);
        hide();
      }}
    >
      {children}
      {position
        ? createPortal(
            <span
              id={tooltipId}
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
