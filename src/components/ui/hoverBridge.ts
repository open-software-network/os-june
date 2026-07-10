export type HoverBridgeSide = "left" | "right";

export type HoverBridgePoint = {
  x: number;
  y: number;
};

export type HoverBridgeRect = {
  top: number;
  right: number;
  bottom: number;
  left: number;
};

export function rectFromElement(element: Element): HoverBridgeRect {
  const rect = element.getBoundingClientRect();
  return {
    top: rect.top,
    right: rect.right,
    bottom: rect.bottom,
    left: rect.left,
  };
}

export function pointInRect(point: HoverBridgePoint, rect: HoverBridgeRect, padding = 0): boolean {
  return (
    point.x >= rect.left - padding &&
    point.x <= rect.right + padding &&
    point.y >= rect.top - padding &&
    point.y <= rect.bottom + padding
  );
}

function pointInPolygon(point: HoverBridgePoint, polygon: HoverBridgePoint[]): boolean {
  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index++) {
    const currentPoint = polygon[index];
    const previousPoint = polygon[previous];
    const crossesY = currentPoint.y > point.y !== previousPoint.y > point.y;
    if (!crossesY) continue;
    const slopeX =
      ((previousPoint.x - currentPoint.x) * (point.y - currentPoint.y)) /
        (previousPoint.y - currentPoint.y) +
      currentPoint.x;
    if (point.x < slopeX) inside = !inside;
  }
  return inside;
}

// Half-height of the row-edge slice that forms the polygon's apex. The safe
// area is anchored at the pointer's exit position (not the whole row), so it is
// a narrow wedge at the row edge that fans out to the card's near edge — a true
// safe triangle/trapezoid rather than a slab covering the menu.
const SAFE_APEX_HALF = 8;

function buildSafePolygon(
  exit: HoverBridgePoint,
  trigger: HoverBridgeRect,
  floating: HoverBridgeRect,
  side: HoverBridgeSide,
  padding: number,
): HoverBridgePoint[] {
  const top = floating.top - padding;
  const bottom = floating.bottom + padding;
  const apexHigh = exit.y - SAFE_APEX_HALF;
  const apexLow = exit.y + SAFE_APEX_HALF;
  if (side === "right") {
    // Card sits to the right of the row: apex on the row's right edge, base on
    // the card's left edge.
    const nearX = trigger.right;
    const farX = floating.left;
    return [
      { x: nearX, y: apexHigh },
      { x: farX, y: top },
      { x: farX, y: bottom },
      { x: nearX, y: apexLow },
    ];
  }
  // Card sits to the left of the row: apex on the row's left edge, base on the
  // card's right edge.
  const nearX = trigger.left;
  const farX = floating.right;
  return [
    { x: farX, y: top },
    { x: nearX, y: apexHigh },
    { x: nearX, y: apexLow },
    { x: farX, y: bottom },
  ];
}

export type HoverBridgeTracker = {
  /** Anchor a fresh safe polygon at the pointer's exit from the trigger row. */
  begin(
    exit: HoverBridgePoint,
    trigger: HoverBridgeRect,
    floating: HoverBridgeRect,
    side: HoverBridgeSide,
  ): void;
  /** Feed a pointer position; returns false once the bridge should be dropped. */
  update(point: HoverBridgePoint): boolean;
  /** True while a bridge is anchored. */
  isActive(): boolean;
  /** Tear the bridge down and cancel any pending stall expiry. */
  stop(): void;
};

/**
 * A floating-ui `safePolygon`-style tracker. Once the pointer leaves the
 * trigger row heading for the card it consumes pointermove points and answers
 * "still bridging?":
 *
 * - the safe area is a wedge anchored at the exit point, widening to the card's
 *   near edge, so it never covers unrelated rows;
 * - progress toward the card (its near edge getting closer) restarts a stall
 *   clock; a point outside the wedge drops the bridge immediately;
 * - if the pointer stalls inside the wedge without making progress for
 *   `stallMs`, `onExpire` fires with the last point so the caller can hand hover
 *   to whatever row now sits under the pointer.
 */
export function createHoverBridgeTracker(options?: {
  stallMs?: number;
  padding?: number;
  onExpire?: (lastPoint: HoverBridgePoint) => void;
}): HoverBridgeTracker {
  const stallMs = options?.stallMs ?? 280;
  const padding = options?.padding ?? 6;
  const onExpire = options?.onExpire;
  // A point must close this many px on the card's near edge to count as
  // meaningful progress; anything less is treated as a stall.
  const progressEpsilon = 1;

  let polygon: HoverBridgePoint[] | null = null;
  let floating: HoverBridgeRect | null = null;
  let trigger: HoverBridgeRect | null = null;
  let side: HoverBridgeSide = "right";
  let bestGap = Number.POSITIVE_INFINITY;
  let lastPoint: HoverBridgePoint | null = null;
  let stallTimer: number | null = null;

  function clearStall() {
    if (stallTimer !== null) {
      window.clearTimeout(stallTimer);
      stallTimer = null;
    }
  }

  function armStall() {
    clearStall();
    stallTimer = window.setTimeout(() => {
      stallTimer = null;
      const at = lastPoint;
      stop();
      if (at) onExpire?.(at);
    }, stallMs);
  }

  function stop() {
    clearStall();
    polygon = null;
    floating = null;
    trigger = null;
    bestGap = Number.POSITIVE_INFINITY;
    lastPoint = null;
  }

  // Horizontal distance from the pointer to the card's near edge; shrinking
  // means the pointer is closing on the card.
  function gapTo(point: HoverBridgePoint): number {
    if (!floating) return Number.POSITIVE_INFINITY;
    return side === "right" ? floating.left - point.x : point.x - floating.right;
  }

  function begin(
    exit: HoverBridgePoint,
    triggerRect: HoverBridgeRect,
    floatingRect: HoverBridgeRect,
    nextSide: HoverBridgeSide,
  ) {
    trigger = triggerRect;
    floating = floatingRect;
    side = nextSide;
    polygon = buildSafePolygon(exit, triggerRect, floatingRect, nextSide, padding);
    lastPoint = exit;
    bestGap = gapTo(exit);
    armStall();
  }

  function update(point: HoverBridgePoint): boolean {
    if (!polygon || !floating || !trigger) return false;
    lastPoint = point;
    // Back over the card or the trigger row: unambiguously safe, so hold the
    // bridge open and let progress restart from here.
    if (pointInRect(point, floating, padding) || pointInRect(point, trigger, padding)) {
      clearStall();
      bestGap = Math.min(bestGap, gapTo(point));
      return true;
    }
    if (!pointInPolygon(point, polygon)) {
      stop();
      return false;
    }
    const gap = gapTo(point);
    if (gap <= bestGap - progressEpsilon) {
      bestGap = gap;
      armStall();
    } else if (stallTimer === null) {
      armStall();
    }
    return true;
  }

  return {
    begin,
    update,
    isActive: () => polygon !== null,
    stop,
  };
}
