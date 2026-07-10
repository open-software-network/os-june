// Text-size preference. The whole app's type derives from the --fs-* tokens
// (src/styles/tokens.css), and each of those is `base * var(--font-scale)`, so
// overriding that one custom property at runtime rescales every label, body,
// and heading in one shot — the same override-one-var trick the brand accent
// uses. Line-heights are unitless and spacing/control heights stay fixed, so
// text grows within the existing chrome instead of reflowing the shell.
//
// Persisted like the theme/brand preferences: localStorage only, plus a
// pre-paint bootstrap in index.html that sets --font-scale before the bundle
// runs so a non-default size doesn't flash the base scale first. Keep the
// storage key and the id->multiplier map in sync with that bootstrap.

export type FontScaleId = "default" | "large" | "larger";

// Up-only ladder: June is a reading app, so there's no "denser" step — the two
// larger stops cover "comfortable" and "big" without crowding the fixed chrome
// (spacing, control heights, and icon sizes stay put at these deltas).
export const FONT_SCALE_PRESETS: {
  id: FontScaleId;
  label: string;
  value: number;
}[] = [
  { id: "default", label: "Default", value: 1 },
  { id: "large", label: "Large", value: 1.1 },
  { id: "larger", label: "Larger", value: 1.2 },
];

const STORAGE_KEY = "os-june:font-scale";
export const DEFAULT_FONT_SCALE: FontScaleId = "default";

function presetFor(id: string | null) {
  // Unknown ids (including a stored "small" from the dropped preset) resolve
  // to the default scale.
  return (
    FONT_SCALE_PRESETS.find((preset) => preset.id === id) ??
    FONT_SCALE_PRESETS.find((preset) => preset.id === DEFAULT_FONT_SCALE) ??
    FONT_SCALE_PRESETS[0]
  );
}

export function getStoredFontScale(): FontScaleId {
  try {
    return presetFor(localStorage.getItem(STORAGE_KEY)).id;
  } catch {
    // localStorage can throw in sandboxed contexts.
    return DEFAULT_FONT_SCALE;
  }
}

export function applyFontScale(id: FontScaleId) {
  document.documentElement.style.setProperty("--font-scale", String(presetFor(id).value));
}

export function setStoredFontScale(id: FontScaleId) {
  try {
    localStorage.setItem(STORAGE_KEY, id);
  } catch {
    // Apply still works for this session.
  }
  applyFontScale(id);
}

export function initFontScale() {
  applyFontScale(getStoredFontScale());
}
