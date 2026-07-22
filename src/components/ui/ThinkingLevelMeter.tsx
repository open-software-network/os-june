import type { ThinkingLevel } from "../../lib/thinking-level";

const ACTIVE_SEGMENTS: Record<ThinkingLevel, 1 | 2 | 3> = {
  instant: 1,
  medium: 2,
  hard: 3,
};

/** Bottom-aligned ascending bars: 2.5px wide, 2px apart, caps squared off
 * (rx well under half the bar width). Drawn inline rather than pulled from
 * central-icons because each segment dims independently to show the level. */
const BARS = [
  { x: 1.25, y: 8, height: 5 },
  { x: 5.75, y: 5.25, height: 7.75 },
  { x: 10.25, y: 2.5, height: 10.5 },
];

/** A stable three-bar silhouette whose active segments communicate thinking
 * effort without changing glyphs between levels. The level's name stays the
 * accessible source of truth: the trigger's description and the menu's
 * Effort row both spell it out. */
export function ThinkingLevelMeter({ level }: { level: ThinkingLevel }) {
  const segments = ACTIVE_SEGMENTS[level];

  return (
    <svg
      className="thinking-level-meter"
      data-segments={segments}
      viewBox="0 0 14 14"
      width={14}
      height={14}
      fill="currentColor"
      aria-hidden
    >
      {BARS.map((bar) => (
        <rect key={bar.x} x={bar.x} y={bar.y} width={2.5} height={bar.height} rx={0.8} />
      ))}
    </svg>
  );
}
