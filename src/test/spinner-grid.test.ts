import { describe, expect, it } from "vitest";
import { SPINNER_GRID_COLS, spinnerGrid } from "../lib/spinner-grid";
import agentHudCss from "../styles/agent-hud.css?raw";
import appCss from "../styles/app.css?raw";
import spinnerCss from "../styles/dot-spinner.css?raw";
import hudCss from "../styles/hud.css?raw";
import tokensCss from "../styles/tokens.css?raw";

describe("neutral spinner grid", () => {
  it("uses full 3×3 grids for sm and md, and a full 5×5 grid for lg", () => {
    expect(SPINNER_GRID_COLS.sm).toBe(3);
    expect(SPINNER_GRID_COLS.md).toBe(3);
    expect(SPINNER_GRID_COLS.lg).toBe(5);
    // Every cell is a dot — the grid is full, not sparse.
    expect(spinnerGrid("sm")).toHaveLength(9);
    expect(spinnerGrid("md")).toHaveLength(9);
    expect(spinnerGrid("lg")).toHaveLength(25);
    expect(spinnerGrid("sm").every((c) => typeof c.order === "number")).toBe(true);
  });

  it("lets every dot participate without drawing a logo", () => {
    const sm = spinnerGrid("sm").map((c) => c.mark);
    expect(sm).toEqual(Array.from({ length: 9 }, () => true));
    expect(spinnerGrid("md").map((c) => c.mark)).toEqual(sm);
    const lg = spinnerGrid("lg").map((c) => c.mark);
    expect(lg).toEqual(Array.from({ length: 25 }, () => true));
  });

  it("orders each cell by its diagonal from the bottom-left so the reveal climbs", () => {
    // Diagonal distance from the bottom-left corner (row 2): bottom-left is 0,
    // top-right is 4, tracing the stroke's path up the grid.
    expect(spinnerGrid("sm").map((c) => c.order)).toEqual([2, 3, 4, 1, 2, 3, 0, 1, 2]);
    expect(spinnerGrid("lg").map((c) => c.order)).toEqual([
      4, 5, 6, 7, 8, 3, 4, 5, 6, 7, 2, 3, 4, 5, 6, 1, 2, 3, 4, 5, 0, 1, 2, 3, 4,
    ]);
  });

  it("sweeps brightness while revealing dots up to their base size", () => {
    const normalizedCss = spinnerCss.replace(/\s+/g, " ");
    const pulseMs = 100 + 160 + 240;
    const pauseMs = 100;
    const smMaxOrder = Math.max(...spinnerGrid("sm").map((c) => c.order));
    const mdMaxOrder = Math.max(...spinnerGrid("md").map((c) => c.order));
    const lgMaxOrder = Math.max(...spinnerGrid("lg").map((c) => c.order));
    const spanRule = spinnerCss.slice(
      spinnerCss.indexOf(".dot-spinner > span {"),
      spinnerCss.indexOf(".dot-spinner > span[data-mark]"),
    );
    const markRule = spinnerCss.slice(
      spinnerCss.indexOf(".dot-spinner > span[data-mark]"),
      spinnerCss.indexOf('.dot-spinner[data-size="lg"] > span'),
    );
    const smSweep = spinnerCss.slice(
      spinnerCss.indexOf("@keyframes spinner-sweep-sm"),
      spinnerCss.indexOf("@keyframes spinner-sweep-lg"),
    );
    const lgSweep = spinnerCss.slice(
      spinnerCss.indexOf("@keyframes spinner-sweep-lg"),
      spinnerCss.indexOf("@keyframes spinner-scale-sm"),
    );
    const smScale = spinnerCss.slice(
      spinnerCss.indexOf("@keyframes spinner-scale-sm"),
      spinnerCss.indexOf("@keyframes spinner-scale-lg"),
    );
    const lgScale = spinnerCss.slice(
      spinnerCss.indexOf("@keyframes spinner-scale-lg"),
      spinnerCss.indexOf("@media (prefers-reduced-motion: reduce)"),
    );

    // Each cycle covers its full traversal, the shared 500ms brightening, and a
    // 100ms all-rest pause before the next head begins.
    expect(smMaxOrder * 130 + pulseMs + pauseMs).toBe(1120);
    expect(mdMaxOrder * 130 + pulseMs + pauseMs).toBe(1120);
    expect(lgMaxOrder * 80 + pulseMs + pauseMs).toBe(1240);
    expect(spinnerCss).toContain(
      "--spinner-pulse: calc(var(--t-fast) + var(--t-med) + var(--t-slow));",
    );
    expect(spinnerCss).toContain("--spinner-pause: var(--t-fast);");
    expect(spinnerCss).toContain("--spinner-max-order: 4;");
    expect(spinnerCss).toContain("--spinner-max-order: 8;");
    expect(normalizedCss).toContain(
      "--spinner-dur: calc( var(--spinner-frame) * var(--spinner-max-order) + var(--spinner-pulse) + var(--spinner-pause) );",
    );
    expect(spinnerCss).toContain("--spinner-frame: calc((var(--t-fast) + var(--t-med)) / 2);");
    expect(spinnerCss).toContain("--spinner-frame: calc(var(--t-med) / 2);");
    // Dots reveal quickly from a smaller rest state to exactly scale 1,
    // never beyond their designed size.
    expect(spanRule).toContain("box-sizing: border-box;");
    expect(spanRule).toContain("width: var(--spinner-dot);");
    expect(spanRule).toContain("height: var(--spinner-dot);");
    expect(spanRule).toContain("aspect-ratio: 1 / 1;");
    expect(spanRule).toContain("border-radius: 50%;");
    expect(spanRule).toContain("transform: scale(1);");
    expect(spanRule).toContain(
      "animation: spinner-sweep-sm var(--spinner-dur) var(--ease-in-out) infinite;",
    );
    expect(spanRule).not.toContain("spinner-scale-sm");
    expect(spanRule).toContain("will-change: opacity;");
    expect(markRule).toContain("--spinner-cell-rest-scale: var(--spinner-rest-scale);");
    expect(markRule).toContain("animation-name: spinner-sweep-sm, spinner-scale-sm;");
    expect(markRule).toContain("animation-timing-function: var(--ease-in-out), linear;");
    expect(markRule).toContain("will-change: opacity, transform;");
    expect(spinnerCss).toContain("--spinner-rest-scale: 0.8;");
    expect(spinnerCss).not.toContain("--spinner-swell");
    expect(spinnerCss).not.toContain("--spinner-field-swell");
    // The active sweep stays legible against the resting field.
    expect(spinnerCss).toContain("--spinner-off: 0.44;");
    expect(spinnerCss).toContain("--spinner-field-peak: 0.26;");
    // The brightness envelope rests at the loop boundary and peaks once at the
    // midpoint — a smooth bell, not a plateau, so the crest glides.
    expect(smSweep).toMatch(
      /0%,\s*44\.643%,\s*100%\s*{[^}]*opacity: var\(--spinner-cell-opacity\)/s,
    );
    expect(smSweep).toMatch(/22\.321%\s*{[^}]*opacity: var\(--spinner-cell-peak-opacity\)/s);
    expect(lgSweep).toMatch(
      /0%,\s*40\.323%,\s*100%\s*{[^}]*opacity: var\(--spinner-cell-opacity\)/s,
    );
    expect(lgSweep).toMatch(/20\.161%\s*{[^}]*opacity: var\(--spinner-cell-peak-opacity\)/s);
    // Scale arrives at the base diameter in 100ms, holds through the crest,
    // and returns to the smaller rest state by the end of the 500ms pulse.
    expect(smScale).toMatch(
      /0%\s*{[^}]*scale\(var\(--spinner-cell-rest-scale\)\)[^}]*cubic-bezier\(0\.22, 1, 0\.36, 1\)/s,
    );
    expect(smScale).toMatch(/8\.929%\s*{[^}]*transform: scale\(1\)/s);
    expect(smScale).toMatch(/33\.929%\s*{[^}]*scale\(1\)[^}]*cubic-bezier\(0\.65, 0, 0\.35, 1\)/s);
    expect(smScale).toMatch(/44\.643%,\s*100%\s*{[^}]*scale\(var\(--spinner-cell-rest-scale\)\)/s);
    expect(lgScale).toMatch(/8\.065%\s*{[^}]*transform: scale\(1\)/s);
    expect(lgScale).toMatch(/30\.645%\s*{[^}]*scale\(1\)[^}]*cubic-bezier\(0\.65, 0, 0\.35, 1\)/s);
    expect(lgScale).toMatch(/40\.323%,\s*100%\s*{[^}]*scale\(var\(--spinner-cell-rest-scale\)\)/s);
    expect(spinnerCss).not.toMatch(/scale\(1\.\d+\)/);
    expect(spinnerCss).toContain("animation-name: spinner-sweep-lg;");
    expect(spinnerCss).toContain("animation-name: spinner-sweep-lg, spinner-scale-lg;");
    expect(normalizedCss).toContain(
      "var(--spinner-order) * var(--spinner-frame) - var(--spinner-dur) - var(--spinner-phase, 0ms)",
    );
    expect(hudCss).toMatch(
      /\.hud-spinner \.dot-spinner\s*{[^}]*--spinner-phase:\s*var\(--t-med\)/s,
    );
    expect(hudCss).toMatch(
      /\.hud-spinner\.hud-spinner-reset \.dot-spinner > span\s*{[^}]*animation:\s*none/s,
    );
    expect(spinnerCss).toContain('.dot-spinner[data-size="md"]');
    expect(spinnerCss).toContain("--spinner-dot: 3px;");
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
