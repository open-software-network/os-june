import {
  type HTMLAttributes,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

const DEFAULT_TIP_WIDTH = 300;
const TIP_GAP = 6;
const VIEWPORT_MARGIN = 8;
// Fallback flip threshold used only before the tip's real height is known (it
// never is, since the side is decided in the measure pass from the measured
// height — this just keeps a sane default if measurement ever yields nothing).
const MIN_SPACE_BELOW = 200;
// Hover-intent delay before the card opens — a pointer sweeping across the
// anchor should not flash it. Matches the model popover's flyout debounce;
// keyboard focus stays immediate.
const HOVER_INTENT_MS = 150;
// Exit fade duration. The unmount timer must outlast the CSS transition so a
// missed transitionend (interrupted paint) still tears the tip down.
const EXIT_MS = 140;

type TipCoords = {
  side: "top" | "bottom";
  top: number;
  left: number;
  // The tightened width in px once the wrapped line boxes are measured, so a
  // two-line tip hugs its text instead of keeping the full cap. Undefined when
  // measurement can't run (jsdom) — the tip keeps its natural capped width.
  width?: number;
};

// The widest rendered line box of a wrapped element, via a Range over its text.
// Returns 0 when the platform can't measure (jsdom returns no client rects),
// which the caller reads as "leave the natural width alone".
function widestLineWidth(element: HTMLElement): number {
  const range = document.createRange();
  range.selectNodeContents(element);
  // One rect per inline fragment, not per visual line: inline markup (a
  // <strong>, a link) splits a single line into adjacent rects. Rebuild each
  // line by grouping fragments that overlap vertically (rects arrive in
  // document order) and read its width as the group's horizontal span.
  const rects = range.getClientRects();
  let widest = 0;
  let line: { bottom: number; left: number; right: number } | null = null;
  for (let index = 0; index < rects.length; index += 1) {
    const rect = rects[index];
    if (rect.width === 0) continue;
    if (line && (rect.top + rect.bottom) / 2 < line.bottom) {
      line.left = Math.min(line.left, rect.left);
      line.right = Math.max(line.right, rect.right);
      line.bottom = Math.max(line.bottom, rect.bottom);
    } else {
      if (line) widest = Math.max(widest, line.right - line.left);
      line = { bottom: rect.bottom, left: rect.left, right: rect.right };
    }
  }
  if (line) widest = Math.max(widest, line.right - line.left);
  return widest;
}

// The anchor geometry captured at open time. The side is decided later, in the
// measure pass, from the tip's real height — but once decided for a mounted
// tip it stays put (see `side` below) so a re-hover never teleports the visible
// card from bottom to top. `top`/`bottom` are the two candidate gap edges.
type TipAnchor = {
  // The already-committed side for a still-mounted tip. Undefined on a fresh
  // open, which lets the measure pass pick the side from the measured height.
  side?: "top" | "bottom";
  centerX: number;
  // Y of the tip's leading edge for each side: below the anchor, or above it.
  bottom: number;
  top: number;
  // Room from the anchor's bottom to the viewport floor — the measure pass
  // compares this against the measured tip height to decide the side.
  spaceBelow: number;
};

type HoverTipProps = HTMLAttributes<HTMLSpanElement> & {
  /** Callout body shown on hover/focus of the wrapped content. */
  tip: ReactNode;
  /** Max card width in px. The tip sizes to its content and only wraps past
   * this cap. Defaults to the wide explainer cap; pass a small value for
   * compact shortcut-style tips. */
  width?: number;
  /** Tightens padding and centers content for a small one-line tip. */
  compact?: boolean;
  /** Hover-intent delay (ms) before the tip opens. Defaults to the shared
   * hover-intent debounce; pass a larger value for a more deliberate tooltip. */
  delay?: number;
  children: ReactNode;
};

/**
 * Hover/focus callout card — the rich replacement for a native `title`
 * tooltip (styled, multi-line, hover-intent debounced). The card renders into
 * a body portal at a fixed position, so it never clips inside scroll
 * containers or dialog cards; scrolling anywhere dismisses it rather than
 * letting it drift off its anchor.
 *
 * The tip sizes to its content: it renders once hidden to measure its actual
 * width, then clamps its centered position to the viewport and reveals — so
 * the enter animation runs from the revealed state and never plays offscreen.
 */
export function HoverTip({
  tip,
  width = DEFAULT_TIP_WIDTH,
  compact = false,
  delay = HOVER_INTENT_MS,
  children,
  ...spanProps
}: HoverTipProps) {
  const {
    "aria-describedby": ariaDescribedBy,
    onBlur,
    onFocus,
    onMouseEnter,
    onMouseLeave,
    ...restSpanProps
  } = spanProps;
  const anchorRef = useRef<HTMLSpanElement | null>(null);
  const tipRef = useRef<HTMLSpanElement | null>(null);
  const hoverTimerRef = useRef<number | null>(null);
  const closeTimerRef = useRef<number | null>(null);
  const tooltipId = useId();
  // The anchor geometry captured at open; drives the measure pass.
  const [anchor, setAnchor] = useState<TipAnchor>();
  // The final clamped coordinates, set after measuring the rendered tip.
  const [coords, setCoords] = useState<TipCoords>();
  // "open" once revealed (enter animation runs), "closing" during the exit
  // fade. Absent while measuring or unmounted.
  const [phase, setPhase] = useState<"open" | "closing">();
  const mounted = anchor !== undefined;
  const describedBy = [ariaDescribedBy, mounted ? tooltipId : null].filter(Boolean).join(" ");

  const cancelHoverIntent = useCallback(() => {
    if (hoverTimerRef.current !== null) {
      window.clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
  }, []);

  const cancelClose = useCallback(() => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }, []);

  const unmount = useCallback(() => {
    cancelClose();
    setAnchor(undefined);
    setCoords(undefined);
    setPhase(undefined);
  }, [cancelClose]);

  function show() {
    cancelClose();
    const rect = anchorRef.current?.getBoundingClientRect();
    if (!rect) return;
    setAnchor((current) => ({
      // A re-hover while the tip is still mounted (open or mid-fade) keeps the
      // side it already committed to: recomputing it here is what made the
      // visible card teleport bottom→top. Only a fresh open (no current
      // anchor) leaves `side` undefined so the measure pass can decide it.
      side: current?.side ?? coords?.side,
      centerX: rect.left + rect.width / 2,
      bottom: rect.bottom + TIP_GAP,
      top: rect.top - TIP_GAP,
      spaceBelow: window.innerHeight - rect.bottom,
    }));
    // A re-entry mid-fade reuses the mounted node: re-assert the open phase so
    // the render before the measure effect lands shows "open", not a stale
    // mid-fade "closing" frame.
    setPhase("open");
  }

  function showAfterHoverIntent() {
    cancelHoverIntent();
    hoverTimerRef.current = window.setTimeout(show, delay);
  }

  function hide() {
    cancelHoverIntent();
    if (!mounted) return;
    setPhase("closing");
    cancelClose();
    closeTimerRef.current = window.setTimeout(unmount, EXIT_MS);
  }

  // Measure the rendered tip and clamp its centered position to the viewport,
  // all before paint, so the reveal never jumps. jsdom reports a zero-width
  // rect (no layout); that still resolves to a positioned, visible tip.
  // `tip` is a deliberate extra dependency: a content swap while open (e.g.
  // "Copy message" → "Copied") resizes the chip, and the re-measure recenters
  // it without re-triggering the enter animation.
  // biome-ignore lint/correctness/useExhaustiveDependencies(tip): re-measure on content change
  useLayoutEffect(() => {
    if (!anchor) return;
    const node = tipRef.current;
    const rect = node?.getBoundingClientRect();
    const tipHeight = rect?.height ?? 0;

    // Decide the side from the tip's real height once, on a fresh open. If the
    // tip fits below (its height plus the gap and a viewport margin), keep it
    // below; otherwise flip above. A committed side (`anchor.side`) is honored
    // so a re-hover on a mounted tip never flips the visible card. Before any
    // real measurement (jsdom), fall back to the fixed threshold.
    const fitsBelow =
      tipHeight > 0
        ? anchor.spaceBelow >= tipHeight + TIP_GAP + VIEWPORT_MARGIN
        : anchor.spaceBelow >= MIN_SPACE_BELOW;
    const side = anchor.side ?? (fitsBelow ? "bottom" : "top");

    // Tighten the width to the widest wrapped line (plus horizontal padding) so
    // a two-line tip hugs its text instead of keeping the full cap. `text-wrap:
    // balance` in CSS has already split the lines evenly by the time we measure.
    let width: number | undefined;
    if (node) {
      const widest = widestLineWidth(node);
      if (widest > 0) {
        const style = window.getComputedStyle(node);
        const hPadding =
          Number.parseFloat(style.paddingLeft) + Number.parseFloat(style.paddingRight);
        const borders =
          Number.parseFloat(style.borderLeftWidth) + Number.parseFloat(style.borderRightWidth);
        const naturalWidth = rect?.width ?? 0;
        const tightened = Math.ceil(widest + hPadding + borders);
        // Never widen past the natural (capped) width — only pull in. Skip if
        // padding/border couldn't be resolved (NaN) rather than set a bad width.
        if (Number.isFinite(tightened)) {
          width = naturalWidth > 0 ? Math.min(tightened, naturalWidth) : tightened;
        }
      }
    }

    // Clamp the centered box to the viewport using the final (tightened) width.
    const boxWidth = width ?? rect?.width ?? 0;
    const left = Math.min(
      Math.max(anchor.centerX - boxWidth / 2, VIEWPORT_MARGIN),
      Math.max(window.innerWidth - boxWidth - VIEWPORT_MARGIN, VIEWPORT_MARGIN),
    );
    setCoords({ side, top: side === "bottom" ? anchor.bottom : anchor.top, left, width });
  }, [anchor, tip]);

  useEffect(
    () => () => {
      cancelHoverIntent();
      cancelClose();
    },
    [cancelHoverIntent, cancelClose],
  );

  useEffect(() => {
    if (!mounted) return;
    // Scroll/resize would drift the tip off its anchor; cut it immediately
    // rather than fading in place.
    window.addEventListener("scroll", unmount, true);
    window.addEventListener("resize", unmount);
    return () => {
      window.removeEventListener("scroll", unmount, true);
      window.removeEventListener("resize", unmount);
    };
  }, [mounted, unmount]);

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
      {mounted
        ? createPortal(
            <span
              ref={tipRef}
              id={tooltipId}
              className={compact ? "hover-tip hover-tip-compact" : "hover-tip"}
              role="tooltip"
              data-side={coords?.side ?? anchor.side ?? "bottom"}
              // Hidden until measured: the enter animation runs only once the
              // final position is revealed, never while offscreen.
              data-state={coords ? phase : "measuring"}
              onTransitionEnd={(event) => {
                if (event.propertyName === "opacity" && phase === "closing") unmount();
              }}
              style={{
                top: coords?.top ?? anchor.bottom,
                left: coords?.left ?? 0,
                maxWidth: width,
                // Applied only after the tighten pass; while measuring the tip
                // renders at its natural capped width so the wrap is real.
                width: coords?.width,
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
