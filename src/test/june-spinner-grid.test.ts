import { describe, expect, it } from "vitest";
import { JUNE_SPINNER_COLS, juneSpinnerGrid } from "../lib/june-spinner-grid";
import agentHudCss from "../styles/agent-hud.css?raw";
import appCss from "../styles/app.css?raw";
import spinnerCss from "../styles/dot-spinner.css?raw";
import tokensCss from "../styles/tokens.css?raw";

describe("June spinner grid", () => {
  it("uses full 3×3 grids for sm and md, and a full 5×5 grid for lg", () => {
    expect(JUNE_SPINNER_COLS.sm).toBe(3);
    expect(JUNE_SPINNER_COLS.md).toBe(3);
    expect(JUNE_SPINNER_COLS.lg).toBe(5);
    // Every cell is a dot — the grid is full, not sparse.
    expect(juneSpinnerGrid("sm")).toHaveLength(9);
    expect(juneSpinnerGrid("md")).toHaveLength(9);
    expect(juneSpinnerGrid("lg")).toHaveLength(25);
    expect(juneSpinnerGrid("sm").every((c) => typeof c.order === "number")).toBe(true);
  });

  it("marks the stepped stroke in the 3×3 and two strokes in the 5×5", () => {
    const sm = juneSpinnerGrid("sm").map((c) => c.mark);
    // Top-right corner, the whole middle row, and the bottom-left corner.
    expect(sm).toEqual([false, false, true, true, true, true, true, false, false]);
    expect(juneSpinnerGrid("md").map((c) => c.mark)).toEqual(sm);
    // The 5×5 keeps the exact two ascending strokes, not only the same dot
    // count with a different silhouette.
    const lg = juneSpinnerGrid("lg").map((c) => c.mark);
    // biome-ignore format: the grid layout is the assertion.
    expect(lg.map(Number)).toEqual([
      0, 0, 0, 0, 1,
      0, 1, 1, 1, 0,
      1, 0, 0, 0, 1,
      0, 1, 1, 1, 0,
      1, 0, 0, 0, 0,
    ]);
    expect(lg.filter(Boolean)).toHaveLength(10);
  });

  it("orders each cell by its diagonal from the bottom-left so the reveal climbs", () => {
    // Diagonal distance from the bottom-left corner (row 2): bottom-left is 0,
    // top-right is 4, tracing the stroke's path up the grid.
    expect(juneSpinnerGrid("sm").map((c) => c.order)).toEqual([2, 3, 4, 1, 2, 3, 0, 1, 2]);
    expect(juneSpinnerGrid("lg").map((c) => c.order)).toEqual([
      4, 5, 6, 7, 8, 3, 4, 5, 6, 7, 2, 3, 4, 5, 6, 1, 2, 3, 4, 5, 0, 1, 2, 3, 4,
    ]);
  });

  it("sweeps brightness while revealing mark dots up to their base size", () => {
    const normalizedCss = spinnerCss.replace(/\s+/g, " ");
    const pulseMs = 100 + 160 + 240;
    const pauseMs = 100;
    const smMaxOrder = Math.max(...juneSpinnerGrid("sm").map((c) => c.order));
    const mdMaxOrder = Math.max(...juneSpinnerGrid("md").map((c) => c.order));
    const lgMaxOrder = Math.max(...juneSpinnerGrid("lg").map((c) => c.order));
    const spanRule = spinnerCss.slice(
      spinnerCss.indexOf(".dot-spinner > span {"),
      spinnerCss.indexOf(".dot-spinner > span[data-mark]"),
    );
    const markRule = spinnerCss.slice(
      spinnerCss.indexOf(".dot-spinner > span[data-mark]"),
      spinnerCss.indexOf('.dot-spinner[data-size="lg"] > span'),
    );
    const smSweep = spinnerCss.slice(
      spinnerCss.indexOf("@keyframes june-sweep-sm"),
      spinnerCss.indexOf("@keyframes june-sweep-lg"),
    );
    const lgSweep = spinnerCss.slice(
      spinnerCss.indexOf("@keyframes june-sweep-lg"),
      spinnerCss.indexOf("@keyframes june-scale-sm"),
    );
    const smScale = spinnerCss.slice(
      spinnerCss.indexOf("@keyframes june-scale-sm"),
      spinnerCss.indexOf("@keyframes june-scale-lg"),
    );
    const lgScale = spinnerCss.slice(
      spinnerCss.indexOf("@keyframes june-scale-lg"),
      spinnerCss.indexOf("@media (prefers-reduced-motion: reduce)"),
    );

    // Each cycle covers its full traversal, the shared 500ms brightening, and a
    // 100ms all-rest pause before the next head begins.
    expect(smMaxOrder * 130 + pulseMs + pauseMs).toBe(1120);
    expect(mdMaxOrder * 130 + pulseMs + pauseMs).toBe(1120);
    expect(lgMaxOrder * 80 + pulseMs + pauseMs).toBe(1240);
    expect(spinnerCss).toContain(
      "--june-pulse: calc(var(--t-fast) + var(--t-med) + var(--t-slow));",
    );
    expect(spinnerCss).toContain("--june-pause: var(--t-fast);");
    expect(spinnerCss).toContain("--june-max-order: 4;");
    expect(spinnerCss).toContain("--june-max-order: 8;");
    expect(normalizedCss).toContain(
      "--june-dur: calc( var(--june-frame) * var(--june-max-order) + var(--june-pulse) + var(--june-pause) );",
    );
    expect(spinnerCss).toContain("--june-frame: calc((var(--t-fast) + var(--t-med)) / 2);");
    expect(spinnerCss).toContain("--june-frame: calc(var(--t-med) / 2);");
    // Field dots stay at their base size. Mark dots reveal quickly from a
    // smaller rest state to exactly scale 1, never beyond their designed size.
    expect(spanRule).toContain("box-sizing: border-box;");
    expect(spanRule).toContain("width: var(--june-dot);");
    expect(spanRule).toContain("height: var(--june-dot);");
    expect(spanRule).toContain("aspect-ratio: 1 / 1;");
    expect(spanRule).toContain("border-radius: 50%;");
    expect(spanRule).toContain("transform: scale(1);");
    expect(spanRule).toContain(
      "animation: june-sweep-sm var(--june-dur) var(--ease-in-out) infinite;",
    );
    expect(spanRule).not.toContain("june-scale-sm");
    expect(spanRule).toContain("will-change: opacity;");
    expect(markRule).toContain("--june-cell-rest-scale: var(--june-rest-scale);");
    expect(markRule).toContain("animation-name: june-sweep-sm, june-scale-sm;");
    expect(markRule).toContain("animation-timing-function: var(--ease-in-out), linear;");
    expect(markRule).toContain("will-change: opacity, transform;");
    expect(spinnerCss).toContain("--june-rest-scale: 0.8;");
    expect(spinnerCss).not.toContain("--june-swell");
    expect(spinnerCss).not.toContain("--june-field-swell");
    // The mark must always outrank the field: field peak stays below mark rest.
    expect(spinnerCss).toContain("--june-off: 0.44;");
    expect(spinnerCss).toContain("--june-field-peak: 0.26;");
    // The brightness envelope rests at the loop boundary and peaks once at the
    // midpoint — a smooth bell, not a plateau, so the crest glides.
    expect(smSweep).toMatch(/0%,\s*44\.643%,\s*100%\s*{[^}]*opacity: var\(--june-cell-opacity\)/s);
    expect(smSweep).toMatch(/22\.321%\s*{[^}]*opacity: var\(--june-cell-peak-opacity\)/s);
    expect(lgSweep).toMatch(/0%,\s*40\.323%,\s*100%\s*{[^}]*opacity: var\(--june-cell-opacity\)/s);
    expect(lgSweep).toMatch(/20\.161%\s*{[^}]*opacity: var\(--june-cell-peak-opacity\)/s);
    // Scale arrives at the base diameter in 100ms, holds through the crest,
    // and returns to the smaller rest state by the end of the 500ms pulse.
    expect(smScale).toMatch(
      /0%\s*{[^}]*scale\(var\(--june-cell-rest-scale\)\)[^}]*cubic-bezier\(0\.22, 1, 0\.36, 1\)/s,
    );
    expect(smScale).toMatch(/8\.929%\s*{[^}]*transform: scale\(1\)/s);
    expect(smScale).toMatch(/33\.929%\s*{[^}]*scale\(1\)[^}]*cubic-bezier\(0\.65, 0, 0\.35, 1\)/s);
    expect(smScale).toMatch(/44\.643%,\s*100%\s*{[^}]*scale\(var\(--june-cell-rest-scale\)\)/s);
    expect(lgScale).toMatch(/8\.065%\s*{[^}]*transform: scale\(1\)/s);
    expect(lgScale).toMatch(/30\.645%\s*{[^}]*scale\(1\)[^}]*cubic-bezier\(0\.65, 0, 0\.35, 1\)/s);
    expect(lgScale).toMatch(/40\.323%,\s*100%\s*{[^}]*scale\(var\(--june-cell-rest-scale\)\)/s);
    expect(spinnerCss).not.toMatch(/scale\(1\.\d+\)/);
    expect(spinnerCss).toContain("animation-name: june-sweep-lg;");
    expect(spinnerCss).toContain("animation-name: june-sweep-lg, june-scale-lg;");
    expect(spinnerCss).toContain("var(--june-order) * var(--june-frame)");
    expect(spinnerCss).toContain('.dot-spinner[data-size="md"]');
    expect(spinnerCss).toContain("--june-dot: 3px;");
    expect(spinnerCss).toContain("color: var(--spinner-color, var(--spinner-neutral));");
    // Light mode leans toward the foreground for contrast on bright surfaces;
    // the dark theme re-mixes a softer muted-leaning neutral.
    expect(tokensCss).toMatch(
      /--spinner-neutral:\s*color-mix\([^;]*var\(--muted-foreground\) 45%,\s*var\(--foreground\)/s,
    );
    expect(tokensCss).toMatch(
      /--spinner-neutral:\s*color-mix\([^;]*var\(--muted-foreground\) 72%,\s*var\(--foreground\)/s,
    );
    // In-flow chat spinners stay on the neutral default — no themed override.
    expect(appCss).not.toMatch(/\.agent-tool-spinner[^{]*{[^}]*--spinner-color/s);
    expect(appCss).not.toMatch(/\.agent-tool-spinner\s*{[^}]*color:/s);
    expect(agentHudCss).toMatch(
      /\.agent-hud-status \.dot-spinner\s*{[^}]*--spinner-color: currentColor;/s,
    );
  });
});
