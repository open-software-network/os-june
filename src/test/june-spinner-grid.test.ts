import { describe, expect, it } from "vitest";
import { JUNE_SPINNER_COLS, juneSpinnerGrid } from "../lib/june-spinner-grid";
import spinnerCss from "../styles/dot-spinner.css?raw";

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
    // The 5×5 keeps two ascending strokes.
    expect(juneSpinnerGrid("lg").filter((c) => c.mark)).toHaveLength(10);
  });

  it("orders each cell by its diagonal from the bottom-left so the swell climbs", () => {
    // Diagonal distance from the bottom-left corner (row 2): bottom-left is 0,
    // top-right is 4, tracing the stroke's path up the grid.
    expect(juneSpinnerGrid("sm").map((c) => c.order)).toEqual([2, 3, 4, 1, 2, 3, 0, 1, 2]);
  });

  it("sweeps brightness across fixed-size dots with a settled reset for each pass", () => {
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
    // The grid rests at full size (scale 1) and only swells lightly with the
    // sweep — a large scale excursion shimmers at this dot size.
    expect(spanRule).toContain("transform: scale(1);");
    expect(spanRule).toContain("june-sweep-sm var(--june-dur) var(--ease-in-out) infinite,");
    expect(spanRule).toContain("june-scale-sm var(--june-dur) var(--ease-in-out) infinite;");
    expect(spinnerCss).toContain("--june-swell: 1.16;");
    expect(spinnerCss).toContain("--june-field-swell: 1;");
    // The mark must always outrank the field: field peak stays below mark rest.
    expect(spinnerCss).toContain("--june-off: 0.44;");
    expect(spinnerCss).toContain("--june-field-peak: 0.26;");
    // The brightness envelope rests at the loop boundary and holds a broad peak.
    expect(smSweep).toMatch(/0%,\s*44\.643%,\s*100%\s*{[^}]*opacity: var\(--june-cell-opacity\)/s);
    expect(smSweep).toMatch(
      /13\.393%,\s*31\.25%\s*{[^}]*opacity: var\(--june-cell-peak-opacity\)/s,
    );
    expect(lgSweep).toMatch(/0%,\s*40\.323%,\s*100%\s*{[^}]*opacity: var\(--june-cell-opacity\)/s);
    expect(lgSweep).toMatch(
      /12\.097%,\s*28\.226%\s*{[^}]*opacity: var\(--june-cell-peak-opacity\)/s,
    );
    // The swell rides the same window and returns to a steady scale 1 at rest.
    expect(smScale).toMatch(/0%,\s*44\.643%,\s*100%\s*{[^}]*transform: scale\(1\)/s);
    expect(smScale).toMatch(
      /13\.393%,\s*31\.25%\s*{[^}]*transform: scale\(var\(--june-cell-swell\)\)/s,
    );
    expect(lgScale).toMatch(/0%,\s*40\.323%,\s*100%\s*{[^}]*transform: scale\(1\)/s);
    expect(lgScale).toMatch(
      /12\.097%,\s*28\.226%\s*{[^}]*transform: scale\(var\(--june-cell-swell\)\)/s,
    );
    expect(spinnerCss).toContain("animation-name: june-sweep-lg, june-scale-lg;");
    expect(spinnerCss).toContain("var(--june-order) * var(--june-frame)");
    expect(spinnerCss).toContain('.dot-spinner[data-size="md"]');
    expect(spinnerCss).toContain("--june-dot: 3px;");
    expect(spinnerCss).toContain("color: var(--muted-foreground);");
  });
});
