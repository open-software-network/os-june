// Per-preset WebGL palettes for the extruded-glass June mark on the sign-in /
// welcome surfaces. three.js needs concrete colors at render time (it can't read
// the CSS `--brand` var), so each brand id carries its own hand-tuned set of
// glass colors here, keyed to BRAND_PRESETS in src/lib/brand.ts.
//
// TUNING SOURCE OF TRUTH: these values are copied VERBATIM from the marketing
// site's lib/brand.ts (os-marketing-page, `GlassPalette` per preset). They were
// hand-graded there against the live glass rig — the cool accents (sage/ocean/
// plum) are deliberately grayed well below their derived chroma so they don't
// read neon under the high-intensity lighting, while Clay stays the one vivid,
// full-chroma jewel. Do NOT re-derive by hue rotation; re-sync from the
// marketing repo if the look is retuned there.

import type { BrandId } from "./brand";

export type GlassPalette = {
  bodyColor: string; // diffuse body
  bodyTint: string; // attenuationColor — what the light warms to
  backdrop: string; // refracted backdrop (keeps the body from going dark)
  edgeColor: string; // side-light → bevel/edge glow
  topColor: string; // top/bottom light
  streakColor: string; // window-reflection streaks
  envLight: string; // reflection-environment backdrop, light theme
  envDark: string; // reflection-environment backdrop, dark theme
};

export const GLASS_PALETTES: Record<BrandId, GlassPalette> = {
  clay: {
    // The flagship jewel — still the fullest-chroma palette, but pulled back one
    // notch from the original vivid set (S ×0.82, L −2%) so it reads as a dusty
    // terracotta rather than a hot neon orange. The edge/top lights had been
    // fully saturated and drove most of the brightness; they come down the most.
    // streakColor stays a crisp white specular highlight.
    bodyColor: "#e79e70",
    bodyTint: "#d1885a",
    backdrop: "#e5b396",
    edgeColor: "#ef975f",
    topColor: "#f4b98c",
    streakColor: "#fff2e8",
    envLight: "#f7ece1",
    envDark: "#2a1a12",
  },
  rose: {
    // bodyTint is the attenuationColor (hue light turns as it travels through
    // the glass, saturating in the THICK lower bars), so it's the deepest value.
    bodyColor: "#d49a8a",
    bodyTint: "#ba8172",
    backdrop: "#d5ada2",
    edgeColor: "#db9483",
    topColor: "#e5b2a0",
    streakColor: "#f9ece8",
    envLight: "#f2e7e2",
    envDark: "#241917",
  },
  plum: {
    // True PLUM — a deeper red-violet matched to the brand plum's own lean.
    bodyColor: "#a985b3",
    bodyTint: "#8f6c99",
    backdrop: "#b8a2bf",
    edgeColor: "#a682b1",
    topColor: "#c2aac9",
    streakColor: "#f4eef5",
    envLight: "#ede7ee",
    envDark: "#1e1621",
  },
  ocean: {
    // Sea-glass blue, pulled a touch toward the brand ocean's teal lean so it
    // reads coastal water rather than slate.
    bodyColor: "#84a9ba",
    bodyTint: "#6c93a6",
    backdrop: "#a0bcc9",
    edgeColor: "#7aa5b9",
    topColor: "#a8c6d2",
    streakColor: "#ecf3f5",
    envLight: "#e6edef",
    envDark: "#141c20",
  },
  sage: {
    // Grayed toward actual SAGE — chroma well down so the glass reads dusty herb,
    // not lime.
    bodyColor: "#a4bda7",
    bodyTint: "#8da891",
    backdrop: "#bccabd",
    edgeColor: "#9db8a0",
    topColor: "#c1d3c3",
    streakColor: "#f1f5f1",
    envLight: "#eaf0ea",
    envDark: "#1a201a",
  },
};
