import { describe, expect, it } from "vitest";
import { JUNE_SPINNER_COLS, juneSpinnerGrid } from "../lib/june-spinner-grid";
import spinnerCss from "../styles/dot-spinner.css?raw";

describe("June spinner grid", () => {
  it("is a full 3×3 grid inline and a full 5×5 grid standalone", () => {
    expect(JUNE_SPINNER_COLS.sm).toBe(3);
    expect(JUNE_SPINNER_COLS.lg).toBe(5);
    // Every cell is a dot — the grid is full, not sparse.
    expect(juneSpinnerGrid("sm")).toHaveLength(9);
    expect(juneSpinnerGrid("lg")).toHaveLength(25);
    expect(juneSpinnerGrid("sm").every((c) => typeof c.order === "number")).toBe(true);
  });

  it("marks the stepped stroke in the 3×3 and two strokes in the 5×5", () => {
    const sm = juneSpinnerGrid("sm").map((c) => c.mark);
    // Top-right corner, the whole middle row, and the bottom-left corner.
    expect(sm).toEqual([false, false, true, true, true, true, true, false, false]);
    // The 5×5 keeps two ascending strokes.
    expect(juneSpinnerGrid("lg").filter((c) => c.mark)).toHaveLength(10);
  });

  it("orders each cell by its diagonal from the bottom-left so the swell climbs", () => {
    // Diagonal distance from the bottom-left corner (row 2): bottom-left is 0,
    // top-right is 4, tracing the stroke's path up the grid.
    expect(juneSpinnerGrid("sm").map((c) => c.order)).toEqual([2, 3, 4, 1, 2, 3, 0, 1, 2]);
  });

  it("sweeps a smooth swell across the grid, mark dots swelling brighter", () => {
    expect(spinnerCss).toContain("@keyframes june-field-sweep");
    expect(spinnerCss).toContain("@keyframes june-mark-sweep");
    expect(spinnerCss).toContain("animation-name: june-mark-sweep;");
    expect(spinnerCss).toContain("transform: scale(1);");
    expect(spinnerCss).toContain("var(--june-order) * var(--june-frame)");
  });
});
