#!/usr/bin/env node

// Regenerate every app icon this repo ships, from source, in one command.
//
//   pnpm icons        (or: node scripts/generate-icons.mjs)
//
// It does two jobs:
//
//   1. Base icon set. Rebuilds src-tauri/icons/*.png, icon.icns, icon.ico, and
//      the android/ + ios/ subdirs from src-tauri/icons/clovy-app-icon.svg using
//      the Tauri CLI's `tauri icon` command (a devDependency, resvg under the
//      hood). This is the set Tauri bundles into the app.
//
//   2. Themed macOS dock icons. One per accent preset. Sage keeps Clovy's
//      canonical lime material; every other preset gives the mark a luminous
//      tonal version of its own hue on a dark matching tile. All variants
//      render from a single template SVG (_src/icon.template.svg), with the
//      background and mark stops substituted per brand. The accent hexes are
//      read straight out of src/lib/brand.ts so brand.ts stays the single
//      source of truth. Output lands in
//      src-tauri/icons/themed/icon-<brand>.png at 1024x1024 (Rust's
//      theme_icon.rs embeds these).
//
// When to run it:
//   - You changed clovy-app-icon.svg (the base mark).
//   - You changed a preset's hex in src/lib/brand.ts.
//   - You added or removed a preset in src/lib/brand.ts. Stale
//     themed/icon-<brand>.png files for dropped brands are deleted for you.
//
// Note on theme_icon.rs: it keeps an "amber" legacy match arm pointing at the
// clay PNG, so clay must stay a preset. This script does not touch brand.ts,
// index.html, or theme_icon.rs.
//
// Determinism: `tauri icon` (resvg) is byte-stable for a given SVG on the same
// CLI version, so reruns produce identical PNGs.

import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(scriptDir, "..");

const BASE_SVG = join(root, "src-tauri", "icons", "clovy-app-icon.svg");
const ICONS_DIR = join(root, "src-tauri", "icons");
const THEMED_DIR = join(ICONS_DIR, "themed");
const TEMPLATE_SVG = join(THEMED_DIR, "_src", "icon.template.svg");
const BRAND_TS = join(root, "src", "lib", "brand.ts");

// Dock icons render at the SVG's native 1024x1024.
const THEMED_SIZE = 1024;

// Per-brand background stops preserve the accent hue while scaling its HSL
// lightness into the dark register.
const LIGHT_FACTOR = 0.38;
const DARK_FACTOR = 0.18;

const IDENTITY_MARK_PALETTE = Object.freeze({
  top: "#F0FF92",
  high: "#E2FF6D",
  mid: "#D7FF54",
  bottom: "#B0FA65",
  strokeTop: "#F6FFC4",
  strokeBottom: "#54D55F",
});

function tauriBinary() {
  const binary = process.platform === "win32" ? "tauri.cmd" : "tauri";
  const local = join(root, "node_modules", ".bin", binary);
  return existsSync(local) ? local : "tauri";
}

// Reads BRAND_PRESETS out of brand.ts with a simple regex. Fails loudly if the
// parse finds nothing, so a refactor of brand.ts can never silently produce an
// empty icon set.
function readBrandPresets() {
  const source = readFileSync(BRAND_TS, "utf8");
  const block = /BRAND_PRESETS\s*[^=]*=\s*\[([\s\S]*?)\]\s*;/.exec(source);
  if (!block) {
    throw new Error(`Could not find BRAND_PRESETS array in ${BRAND_TS}. Did the shape change?`);
  }
  const entryRe = /id:\s*["']([^"']+)["'][^}]*?value:\s*["'](#[0-9a-fA-F]{6})["']/g;
  const presets = [];
  for (const match of block[1].matchAll(entryRe)) {
    presets.push({ id: match[1], value: match[2].toLowerCase() });
  }
  if (presets.length === 0) {
    throw new Error(`Parsed BRAND_PRESETS but found no id/value pairs in ${BRAND_TS}.`);
  }
  return presets;
}

function hexToRgb(hex) {
  const h = hex.replace("#", "");
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
}

function rgbToHex([r, g, b]) {
  const clamp = (x) => Math.max(0, Math.min(255, Math.round(x)));
  return `#${[r, g, b].map((c) => clamp(c).toString(16).padStart(2, "0")).join("")}`;
}

function rgbToHsl([r, g, b]) {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
  }
  return [h, s, l];
}

function hslToRgb([h, s, l]) {
  if (s === 0) {
    const v = l * 255;
    return [v, v, v];
  }
  const hue2rgb = (p, q, t) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [hue2rgb(p, q, h + 1 / 3) * 255, hue2rgb(p, q, h) * 255, hue2rgb(p, q, h - 1 / 3) * 255];
}

function scaleLightness(hex, factor) {
  const [h, s, l] = rgbToHsl(hexToRgb(hex));
  const nextL = Math.max(0, Math.min(1, l * factor));
  return rgbToHex(hslToRgb([h, s, nextL]));
}

function luminousTone(hex, lightness, saturationFloor, saturationScale = 1) {
  const [h, s] = rgbToHsl(hexToRgb(hex));
  const saturation = Math.min(0.9, Math.max(s * saturationScale, saturationFloor));
  return rgbToHex(hslToRgb([h, saturation, lightness]));
}

export function clovyMarkPalette(id, value) {
  if (id === "sage") return { ...IDENTITY_MARK_PALETTE };
  return {
    top: luminousTone(value, 0.84, 0.38, 0.82),
    high: luminousTone(value, 0.76, 0.52, 0.94),
    mid: luminousTone(value, 0.69, 0.58, 1.02),
    bottom: luminousTone(value, 0.62, 0.62, 1.06),
    strokeTop: luminousTone(value, 0.9, 0.3, 0.72),
    strokeBottom: luminousTone(value, 0.54, 0.64, 1.1),
  };
}

// Render an SVG file to a single PNG at `size`, then move it into place.
// `tauri icon --png <size>` writes <size>x<size>.png into a fresh temp dir, so
// we grab that one file and copy it to the destination.
function renderSvgToPng(svgPath, destPath, size) {
  const outDir = mkdtempSync(join(tmpdir(), "clovy-icon-"));
  try {
    const result = spawnSync(
      tauriBinary(),
      ["icon", "--png", String(size), "-o", outDir, svgPath],
      { shell: process.platform === "win32", stdio: "pipe", encoding: "utf8" },
    );
    if (result.status !== 0) {
      throw new Error(`tauri icon failed for ${svgPath}:\n${result.stderr || result.stdout}`);
    }
    const rendered = join(outDir, `${size}x${size}.png`);
    if (!existsSync(rendered)) {
      throw new Error(`Expected ${rendered} but tauri icon did not write it.`);
    }
    copyFileSync(rendered, destPath);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}

function generateBaseIcons() {
  if (!existsSync(BASE_SVG)) {
    throw new Error(`Base icon source missing: ${BASE_SVG}`);
  }
  console.log(`Base icon set from ${BASE_SVG}`);
  const result = spawnSync(tauriBinary(), ["icon", "-o", ICONS_DIR, BASE_SVG], {
    shell: process.platform === "win32",
    stdio: "inherit",
  });
  if (result.status !== 0) {
    throw new Error("tauri icon failed for the base icon set.");
  }
}

function generateThemedIcons(presets) {
  if (!existsSync(TEMPLATE_SVG)) {
    throw new Error(`Themed template missing: ${TEMPLATE_SVG}`);
  }
  const template = readFileSync(TEMPLATE_SVG, "utf8");
  const written = new Set();

  for (const { id, value } of presets) {
    const light = scaleLightness(value, LIGHT_FACTOR);
    const dark = scaleLightness(value, DARK_FACTOR);
    const mark = clovyMarkPalette(id, value);
    const replacements = {
      "{{ACCENT_LIGHT}}": light,
      "{{ACCENT_DARK}}": dark,
      "{{MARK_TOP}}": mark.top,
      "{{MARK_HIGH}}": mark.high,
      "{{MARK_MID}}": mark.mid,
      "{{MARK_BOTTOM}}": mark.bottom,
      "{{MARK_STROKE_TOP}}": mark.strokeTop,
      "{{MARK_STROKE_BOTTOM}}": mark.strokeBottom,
    };
    let svg = template;
    for (const [placeholder, color] of Object.entries(replacements)) {
      svg = svg.replaceAll(placeholder, color);
    }

    const svgDir = mkdtempSync(join(tmpdir(), "clovy-themed-svg-"));
    const svgFile = join(svgDir, `icon-${id}.svg`);
    const destPng = join(THEMED_DIR, `icon-${id}.png`);
    try {
      writeFileSync(svgFile, svg);
      renderSvgToPng(svgFile, destPng, THEMED_SIZE);
      written.add(`icon-${id}.png`);
      console.log(
        `Themed dock icon: icon-${id}.png  (tile ${light} / ${dark}; mark ${mark.top} / ${mark.bottom})`,
      );
    } finally {
      rmSync(svgDir, { recursive: true, force: true });
    }
  }

  cleanStaleThemed(written);
}

// Remove themed PNGs for brands that are no longer presets, so a dropped accent
// does not leave an orphan icon behind. Only touches icon-*.png files.
function cleanStaleThemed(keep) {
  for (const name of readdirSync(THEMED_DIR)) {
    if (!/^icon-.+\.png$/.test(name)) continue;
    if (keep.has(name)) continue;
    rmSync(join(THEMED_DIR, name), { force: true });
    console.log(`Removed stale themed icon: ${name}`);
  }
}

// Verify every themed PNG is a real 1024x1024, non-empty file. Uses the PNG
// IHDR header (bytes 16-23) so we do not need an image library just to read the
// declared dimensions.
function verifyThemedIcons(presets) {
  const problems = [];
  for (const { id } of presets) {
    const png = join(THEMED_DIR, `icon-${id}.png`);
    if (!existsSync(png)) {
      problems.push(`missing: icon-${id}.png`);
      continue;
    }
    const buf = readFileSync(png);
    if (buf.length === 0) {
      problems.push(`empty: icon-${id}.png`);
      continue;
    }
    const width = buf.readUInt32BE(16);
    const height = buf.readUInt32BE(20);
    if (width !== THEMED_SIZE || height !== THEMED_SIZE) {
      problems.push(`icon-${id}.png is ${width}x${height}, want ${THEMED_SIZE}`);
      continue;
    }
    console.log(`Verified icon-${id}.png: ${width}x${height}, ${statSync(png).size} bytes`);
  }
  if (problems.length > 0) {
    throw new Error(`Themed icon verification failed:\n  ${problems.join("\n  ")}`);
  }
}

function main() {
  const presets = readBrandPresets();
  console.log(`Presets from brand.ts: ${presets.map((p) => `${p.id} ${p.value}`).join(", ")}`);
  generateBaseIcons();
  generateThemedIcons(presets);
  verifyThemedIcons(presets);
  console.log("Icons regenerated.");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
