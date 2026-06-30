import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { BRAND_PRESETS, type BrandId } from "../../lib/brand";

// Donut-wedge geometry. The presets ring the persistent 20px trigger dot;
// clicking a wedge picks that accent. Wedges sit inset on a white disc with
// genuinely rounded corners and a white gap ring around the trigger.
const VIEW = 74;
const C = VIEW / 2;
const R_DISC = 35; // white backing
const R_OUTER = 33; // wedge outer
const R_INNER = 12; // wedge inner — gap to the 20px trigger dot
const GAP_DEG = 5; // angular sliver between wedges
const CR = 4; // corner radius of each wedge

function polar(r: number, deg: number): [number, number] {
  const a = (deg * Math.PI) / 180;
  return [C + r * Math.cos(a), C + r * Math.sin(a)];
}
const pt = ([x, y]: [number, number]) => `${x.toFixed(2)} ${y.toFixed(2)}`;

// A donut wedge with all four corners rounded by CR.
function wedgePath(a0: number, a1: number): string {
  const daO = (CR / R_OUTER) * (180 / Math.PI);
  const daI = (CR / R_INNER) * (180 / Math.PI);
  const oStart = polar(R_OUTER, a0 + daO);
  const oEnd = polar(R_OUTER, a1 - daO);
  const rEndOut = polar(R_OUTER - CR, a1);
  const rEndIn = polar(R_INNER + CR, a1);
  const iEnd = polar(R_INNER, a1 - daI);
  const iStart = polar(R_INNER, a0 + daI);
  const rStartIn = polar(R_INNER + CR, a0);
  const rStartOut = polar(R_OUTER - CR, a0);
  return [
    `M ${pt(oStart)}`,
    `A ${R_OUTER} ${R_OUTER} 0 0 1 ${pt(oEnd)}`,
    `A ${CR} ${CR} 0 0 1 ${pt(rEndOut)}`,
    `L ${pt(rEndIn)}`,
    `A ${CR} ${CR} 0 0 1 ${pt(iEnd)}`,
    `A ${R_INNER} ${R_INNER} 0 0 0 ${pt(iStart)}`,
    `A ${CR} ${CR} 0 0 1 ${pt(rStartIn)}`,
    `L ${pt(rStartOut)}`,
    `A ${CR} ${CR} 0 0 1 ${pt(oStart)}`,
    "Z",
  ].join(" ");
}

const SLICE = 360 / BRAND_PRESETS.length;
const WEDGES = BRAND_PRESETS.map((preset, i) => {
  const start = -90 + i * SLICE + GAP_DEG / 2;
  const end = -90 + (i + 1) * SLICE - GAP_DEG / 2;
  const mid = -90 + i * SLICE + SLICE / 2;
  return { preset, d: wedgePath(start, end), mid };
});

const TIP_D = 39; // px from wheel center to the tooltip's anchor edge

// Place the tooltip just outside the hovered wedge, anchored by its inner edge
// in the wedge's radial direction so it points outward from the wheel. The
// anchor point uses whole pixels; the size-relative offset is applied as a
// rounded px transform in a layout effect (see below) rather than a fractional
// percentage, which would land the text off the pixel grid and look blurry.
function tipAnchor(midDeg: number): CSSProperties {
  const a = (midDeg * Math.PI) / 180;
  return {
    left: `calc(50% + ${Math.round(TIP_D * Math.cos(a))}px)`,
    top: `calc(50% + ${Math.round(TIP_D * Math.sin(a))}px)`,
  };
}

const CLOSE_MS = 300; // matches the bloom animation so the reverse plays fully
const COMMIT_AFTER_CLOSE_MS = 16; // one frame after unmount, avoiding end-frame repaint
const TIP_MS = 350;

function presetFor(id: BrandId) {
  return BRAND_PRESETS.find((preset) => preset.id === id) ?? BRAND_PRESETS[0];
}

export function AccentWheel({
  value,
  onChange,
}: {
  value: BrandId;
  onChange: (id: BrandId) => void;
}) {
  const [displayValue, setDisplayValue] = useState<BrandId>(value);
  const selected = presetFor(displayValue);
  // closed -> open -> closing -> closed, so we can play an exit animation.
  const [phase, setPhase] = useState<"closed" | "open" | "closing">("closed");
  const [ringValue, setRingValue] = useState<BrandId>(value);
  const [tip, setTip] = useState<BrandId | null>(null);
  const [tipXform, setTipXform] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const tipRef = useRef<HTMLSpanElement>(null);
  const timer = useRef<number>();
  const commitTimer = useRef<number>();
  const tipTimer = useRef<number>();
  const commitRef = useRef<BrandId | null>(null);
  const mounted = phase !== "closed";

  const close = (commit?: BrandId) => {
    window.clearTimeout(timer.current);
    window.clearTimeout(commitTimer.current);
    commitRef.current = commit ?? null;
    setTip(null);
    setPhase("closing");
    timer.current = window.setTimeout(() => {
      const next = commitRef.current;
      commitRef.current = null;
      if (next) setRingValue(next);
      setPhase("closed");
      if (next) {
        commitTimer.current = window.setTimeout(
          () => onChange(next),
          COMMIT_AFTER_CLOSE_MS,
        );
      }
    }, CLOSE_MS);
  };
  const open = () => {
    window.clearTimeout(timer.current);
    window.clearTimeout(commitTimer.current);
    commitRef.current = null;
    setDisplayValue(value);
    setRingValue(value);
    setPhase("open");
  };

  useEffect(
    () => () => {
      window.clearTimeout(timer.current);
      window.clearTimeout(commitTimer.current);
      window.clearTimeout(tipTimer.current);
    },
    [],
  );

  useEffect(() => {
    if (phase === "closing") return;
    setDisplayValue(value);
    setRingValue(value);
  }, [phase, value]);

  useEffect(() => {
    if (!mounted) return;
    function onDocDown(event: MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node)) close();
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") close();
    }
    document.addEventListener("mousedown", onDocDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [mounted]);

  const tipWedge = tip ? WEDGES.find((w) => w.preset.id === tip) : undefined;

  // Anchor the tooltip in its wedge's radial direction by offsetting it by a
  // fraction of its own measured size, but rounded to whole pixels. Done here
  // (pre-paint) instead of via a percentage transform so the text stays on the
  // pixel grid and renders crisp rather than blurred.
  useLayoutEffect(() => {
    const el = tipRef.current;
    if (!el || !tipWedge) return;
    const a = (tipWedge.mid * Math.PI) / 180;
    const dx = Math.round((-0.5 + 0.5 * Math.cos(a)) * el.offsetWidth);
    const dy = Math.round((-0.5 + 0.5 * Math.sin(a)) * el.offsetHeight);
    setTipXform(`translate(${dx}px, ${dy}px)`);
  }, [tipWedge]);

  const pick = (id: BrandId) => {
    setDisplayValue(id);
    close(id);
  };
  const hoverWedge = (id: BrandId) => {
    window.clearTimeout(tipTimer.current);
    tipTimer.current = window.setTimeout(() => setTip(id), TIP_MS);
  };
  const leaveWedge = () => {
    window.clearTimeout(tipTimer.current);
    setTip(null);
  };

  return (
    <div
      className="accent-wheel"
      ref={rootRef}
      data-open={mounted}
      data-phase={phase}
    >
      <button
        type="button"
        className="accent-wheel-trigger"
        aria-haspopup="true"
        aria-expanded={phase === "open"}
        aria-label={`Accent color: ${selected.label}. Change`}
        style={{ "--swatch": selected.value } as CSSProperties}
        onClick={() => (mounted ? close() : open())}
      />
      {mounted ? (
        <div
          className="accent-wheel-pop"
          data-phase={phase}
          role="radiogroup"
          aria-label="Accent color"
        >
          {tipWedge ? (
            <span
              ref={tipRef}
              className="accent-wheel-tip"
              role="tooltip"
              style={{ ...tipAnchor(tipWedge.mid), transform: tipXform }}
            >
              {tipWedge.preset.label}
            </span>
          ) : null}
          <svg
            className="accent-wheel-svg"
            viewBox={`0 0 ${VIEW} ${VIEW}`}
            width={VIEW}
            height={VIEW}
          >
            <defs>
              {/* Shadow lives inside the SVG (on the disc) rather than as a CSS
                  filter on the popover — a parent CSS filter + a will-change'd
                  animating child is what caused the white repaint flash. */}
              <filter
                id="accent-wheel-shadow"
                x="-40%"
                y="-40%"
                width="180%"
                height="180%"
              >
                <feDropShadow
                  dx="0"
                  dy="2.5"
                  stdDeviation="3.5"
                  floodColor="#000"
                  floodOpacity="0.22"
                />
              </filter>
            </defs>
            {/* The ring blooms out behind the trigger, which remains the center
                dot for the entire open/close cycle. */}
            <g className="accent-wheel-bloom">
              <circle
                className="accent-wheel-disc"
                cx={C}
                cy={C}
                r={R_DISC}
                filter="url(#accent-wheel-shadow)"
              />
              {WEDGES.map(({ preset, d }, i) => (
                <path
                  key={preset.id}
                  className="accent-wheel-wedge"
                  data-selected={preset.id === ringValue}
                  d={d}
                  role="radio"
                  aria-checked={preset.id === ringValue}
                  aria-label={preset.label}
                  tabIndex={0}
                  style={{ "--i": i, "--wedge": preset.value } as CSSProperties}
                  onClick={() => pick(preset.id)}
                  onMouseEnter={() => hoverWedge(preset.id)}
                  onMouseLeave={leaveWedge}
                  onFocus={() => setTip(preset.id)}
                  onBlur={() => setTip(null)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      pick(preset.id);
                    }
                  }}
                />
              ))}
            </g>
          </svg>
        </div>
      ) : null}
    </div>
  );
}
