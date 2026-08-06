import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { clovyMarkPalette } from "../../scripts/generate-icons.mjs";

const template = readFileSync(
  resolve(process.cwd(), "src-tauri/icons/themed/_src/icon.template.svg"),
  "utf8",
);

describe("Clovy themed icon generation", () => {
  it("keeps the canonical lime material for Sage", () => {
    expect(clovyMarkPalette("sage", "#3f812f")).toEqual({
      top: "#F0FF92",
      high: "#E2FF6D",
      mid: "#D7FF54",
      bottom: "#B0FA65",
      strokeTop: "#F6FFC4",
      strokeBottom: "#54D55F",
    });
  });

  it("gives every other preset a distinct luminous Clovy material", () => {
    const palettes = [
      clovyMarkPalette("rose", "#a5655c"),
      clovyMarkPalette("clay", "#b5551f"),
      clovyMarkPalette("ocean", "#3d7b9a"),
      clovyMarkPalette("plum", "#965d84"),
    ];

    expect(new Set(palettes.map((palette) => palette.bottom)).size).toBe(4);
    for (const palette of palettes) {
      expect(Object.values(palette).every((color) => /^#[0-9a-f]{6}$/i.test(color))).toBe(true);
      expect(palette.bottom).not.toBe("#B0FA65");
    }
  });

  it("routes every mark material stop through the generator", () => {
    for (const placeholder of [
      "{{MARK_TOP}}",
      "{{MARK_HIGH}}",
      "{{MARK_MID}}",
      "{{MARK_BOTTOM}}",
      "{{MARK_STROKE_TOP}}",
      "{{MARK_STROKE_BOTTOM}}",
    ]) {
      expect(template).toContain(placeholder);
    }
  });
});
