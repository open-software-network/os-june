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
// tip it stays put (see `sideRef`) so neither a re-hover nor a content swap
// teleports the visible card. `top`/`bottom` are the two candidate gap edges.
type TipAnchor = {
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
  /** When true, the tip is force-closed and cannot open — e.g. while the
   * trigger's own picker popover is open, so the hover callout never fights the
   * popover for the same anchor. */
  suppressed?: boolean;
  /** Keeps the callout alive while the pointer moves onto it. Use only for
   * rich, card-like tips with controls inside. */
  interactive?: boolean;
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
  suppressed = false,
  interactive = false,
  children,
  ...spanProps
}: HoverTipProps) {
  const {
    "aria-describedby": ariaDescribedBy,
    onBlur,
    onFocus,
    onKeyDown,
    onMouseEnter,
    onMouseLeave,
    ...restSpanProps
  } = spanProps;
  const anchorRef = useRef<HTMLSpanElement | null>(null);
  const tipRef = useRef<HTMLDivElement | null>(null);
  const hoverTimerRef = useRef<number | null>(null);
  const closeTimerRef = useRef<number | null>(null);
  const resizeFrameRef = useRef<number | null>(null);
  // The side committed by the first measure pass, held for the tip's whole
  // mounted lifetime: a re-hover or a content swap (e.g. "Copy message" →
  // "Copied") re-measures, and re-deciding the side then would visibly
  // teleport the open card. Cleared on unmount so a fresh open decides anew.
  const sideRef = useRef<"top" | "bottom" | undefined>(undefined);
  const tooltipId = useId();
  // The anchor geometry captured at open; drives the measure pass.
  const [anchor, setAnchor] = useState<TipAnchor>();
  // The final clamped coordinates, set after measuring the rendered tip.
  const [coords, setCoords] = useState<TipCoords>();
  const [measureVersion, setMeasureVersion] = useState(0);
  // "open" once revealed (enter animation runs), "closing" during the exit
  // fade. Absent while measuring or unmounted.
  const [phase, setPhase] = useState<"open" | "closing">();
  const mounted = anchor !== undefined;
  const portalTarget = typeof document === "undefined" ? null : document.body;
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
    sideRef.current = undefined;
    setAnchor(undefined);
    setCoords(undefined);
    setPhase(undefined);
  }, [cancelClose]);

  function show() {
    if (suppressed) return;
    cancelClose();
    const rect = anchorRef.current?.getBoundingClientRect();
    if (!rect) return;
    setAnchor({
      centerX: rect.left + rect.width / 2,
      bottom: rect.bottom + TIP_GAP,
      top: rect.top - TIP_GAP,
      spaceBelow: window.innerHeight - rect.bottom,
    });
    // A re-entry mid-fade reuses the mounted node: re-assert the open phase so
    // the render before the measure effect lands shows "open", not a stale
    // mid-fade "closing" frame.
    setPhase("open");
  }

  function showAfterHoverIntent() {
    if (suppressed) return;
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

  function hideAfterInteractiveGrace() {
    cancelHoverIntent();
    if (!mounted) return;
    cancelClose();
    closeTimerRef.current = window.setTimeout(hide, HOVER_INTENT_MS);
  }

  function elementInsideHoverTipSurface(element: EventTarget | null) {
    return element instanceof Node && Boolean(tipRef.current?.contains(element));
  }

  function elementInsideAnchor(element: EventTarget | null) {
    return element instanceof Node && Boolean(anchorRef.current?.contains(element));
  }

  function firstTipFocusable() {
    return tipRef.current?.querySelector<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    );
  }

  const cancelResizeMeasure = useCallback(() => {
    if (resizeFrameRef.current !== null) {
      window.cancelAnimationFrame(resizeFrameRef.current);
      resizeFrameRef.current = null;
    }
  }, []);

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
    // Measure at the natural (max-width-capped) size, not the previously
    // tightened one: a content swap while open re-runs this pass, and keeping
    // the old applied width would stop a longer label from growing back.
    // Restored below before React re-applies the freshly computed width.
    const appliedWidth = node?.style.width ?? "";
    if (node) node.style.width = "";
    const rect = node?.getBoundingClientRect();
    const tipHeight = rect?.height ?? 0;

    // Decide the side from the tip's real height once, on a fresh open. If the
    // tip fits below (its height plus the gap and a viewport margin), keep it
    // below; otherwise flip above. A committed side (`sideRef`) is honored so
    // neither a re-hover nor a content swap flips the visible card. Before any
    // real measurement (jsdom), fall back to the fixed threshold.
    const fitsBelow =
      tipHeight > 0
        ? anchor.spaceBelow >= tipHeight + TIP_GAP + VIEWPORT_MARGIN
        : anchor.spaceBelow >= MIN_SPACE_BELOW;
    const side = sideRef.current ?? (fitsBelow ? "bottom" : "top");
    sideRef.current = side;

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

    // Hand the width the DOM had back to React before the commit below: if the
    // computed width comes out unchanged, React skips the style write and the
    // cleared inline width would otherwise leak into the painted frame.
    if (node) node.style.width = appliedWidth;

    // Clamp the centered box to the viewport using the final (tightened) width.
    const boxWidth = width ?? rect?.width ?? 0;
    const left = Math.min(
      Math.max(anchor.centerX - boxWidth / 2, VIEWPORT_MARGIN),
      Math.max(window.innerWidth - boxWidth - VIEWPORT_MARGIN, VIEWPORT_MARGIN),
    );
    const rawTop = side === "bottom" ? anchor.bottom : anchor.top;
    let top = rawTop;
    // Vertical viewport clamp is scoped to interactive tips only: those carry
    // tall, card-like content (the model summary card) that can run off a
    // window edge. Plain tooltips keep their exact prior top so this change has
    // no blast radius on the many small tips across the app.
    if (interactive && tipHeight > 0) {
      top =
        side === "bottom"
          ? Math.min(rawTop, window.innerHeight - tipHeight - VIEWPORT_MARGIN)
          : Math.max(rawTop, tipHeight + VIEWPORT_MARGIN);
      top = Math.max(VIEWPORT_MARGIN, Math.min(top, window.innerHeight - VIEWPORT_MARGIN));
    }
    setCoords({ side, top, left, width });
  }, [anchor, tip, measureVersion, interactive]);

  useLayoutEffect(() => {
    if (!interactive || !mounted || typeof ResizeObserver === "undefined") return;
    const node = tipRef.current;
    if (!node) return;
    const observer = new ResizeObserver(() => {
      cancelResizeMeasure();
      resizeFrameRef.current = window.requestAnimationFrame(() => {
        resizeFrameRef.current = null;
        setMeasureVersion((version) => version + 1);
      });
    });
    observer.observe(node);
    return () => {
      observer.disconnect();
      cancelResizeMeasure();
    };
  }, [interactive, mounted, cancelResizeMeasure]);

  useEffect(
    () => () => {
      cancelHoverIntent();
      cancelClose();
      cancelResizeMeasure();
    },
    [cancelHoverIntent, cancelClose, cancelResizeMeasure],
  );

  // Force-close the moment suppression turns on (the picker popover opened over
  // this anchor). Cancel any pending hover-intent and tear a shown tip down at
  // once rather than fading, so the callout never overlaps the popover.
  useEffect(() => {
    if (!suppressed) return;
    cancelHoverIntent();
    if (mounted) unmount();
  }, [suppressed, mounted, cancelHoverIntent, unmount]);

  useEffect(() => {
    if (!mounted) return;
    // Scroll/resize would drift the tip off its anchor; cut it immediately
    // rather than fading in place. An interactive tip can itself hold a scroll
    // region (e.g. a capped description), so a scroll that originates inside the
    // tip must not dismiss it — only outside scrolls do.
    const onScroll = (event: Event) => {
      if (interactive && event.target instanceof Node && tipRef.current?.contains(event.target)) {
        return;
      }
      unmount();
    };
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", unmount);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", unmount);
    };
  }, [mounted, unmount, interactive]);

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
        if (interactive) hideAfterInteractiveGrace();
        else hide();
      }}
      onFocus={(event) => {
        onFocus?.(event);
        show();
      }}
      onBlur={(event) => {
        onBlur?.(event);
        if (
          interactive &&
          (elementInsideAnchor(event.relatedTarget) ||
            elementInsideHoverTipSurface(event.relatedTarget))
        ) {
          return;
        }
        hide();
      }}
      onKeyDown={(event) => {
        onKeyDown?.(event);
        if (
          event.defaultPrevented ||
          !interactive ||
          event.key !== "Tab" ||
          event.shiftKey ||
          !mounted
        ) {
          return;
        }
        const focusTarget = firstTipFocusable();
        if (!focusTarget) return;
        event.preventDefault();
        focusTarget.focus();
      }}
    >
      {children}
      {mounted && portalTarget
        ? createPortal(
            <div
              ref={tipRef}
              id={tooltipId}
              className={compact ? "hover-tip hover-tip-compact" : "hover-tip"}
              role="tooltip"
              data-interactive={interactive || undefined}
              data-side={coords?.side ?? "bottom"}
              // Hidden until measured: the enter animation runs only once the
              // final position is revealed, never while offscreen.
              data-state={coords ? phase : "measuring"}
              onTransitionEnd={(event) => {
                if (event.propertyName === "opacity" && phase === "closing") unmount();
              }}
              onMouseEnter={
                interactive
                  ? () => {
                      cancelClose();
                      setPhase("open");
                    }
                  : undefined
              }
              onMouseLeave={interactive ? hide : undefined}
              onBlur={
                interactive
                  ? (event) => {
                      if (
                        elementInsideAnchor(event.relatedTarget) ||
                        elementInsideHoverTipSurface(event.relatedTarget)
                      ) {
                        return;
                      }
                      hide();
                    }
                  : undefined
              }
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
            </div>,
            portalTarget,
          )
        : null}
    </span>
  );
}
