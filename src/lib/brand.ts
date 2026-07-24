// Brand accent preference. The whole UI derives from the --brand token
// (src/styles/tokens.css) via var(--brand) and color-mix, so overriding that
// one custom property at runtime recolors buttons, washes, hovers, and the
// recorder accent in one shot. Five curated "dusty" presets, each pre-checked
// for white-text contrast (>= 4.5:1) so the send glyph stays legible on every
// one. The brand identity is the clay terracotta — the logo mark and the app
// icon are clay — so it's the default; rose is just another preset now. The
// native dock icon swaps to the selected accent in Tauri builds.
//
// Each preset also carries a `wash`: the accent with its oklch chroma capped at
// 0.07 (same lightness/hue). Surfaces tint from the wash, not the accent, so a
// high-chroma pick (clay) doesn't over-cream the greys while a low-chroma pick
// (rose) stays close to its accent. applyBrandVar sets both --brand and
// --brand-wash.
//
// Keep the storage key + the id->hex map in sync with the pre-paint bootstrap
// in index.html, which sets --brand and --brand-wash before the bundle runs to
// avoid a flash.

import { useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { UnlistenFn } from "@tauri-apps/api/event";

export type BrandId = "rose" | "clay" | "sage" | "ocean" | "plum";

export const BRAND_PRESETS: {
  id: BrandId;
  label: string;
  value: string;
  wash: string;
}[] = [
  { id: "clay", label: "Clay", value: "#b5551f", wash: "#976851" },
  { id: "rose", label: "Rose", value: "#a5655c", wash: "#9e6961" },
  { id: "sage", label: "Sage", value: "#527f4d", wash: "#5a7c56" },
  { id: "ocean", label: "Ocean", value: "#3d7b9a", wash: "#467a95" },
  { id: "plum", label: "Plum", value: "#965d84", wash: "#8f6380" },
];

const STORAGE_KEY = "os-june:brand";
export const DEFAULT_BRAND: BrandId = "clay";

// Stored ids that have since been renamed or dropped. "blue" became "ocean"
// (same swatch slot); "amber" was removed and maps to "clay" so anyone who
// picked either keeps a matching warm accent instead of snapping back to the
// default. Mirror any entry added here in the index.html pre-paint map and
// theme_icon.rs.
const LEGACY_BRAND_IDS: Record<string, BrandId> = { blue: "ocean", amber: "clay" };

function presetFor(id: string | null) {
  const canonical = (id && LEGACY_BRAND_IDS[id]) ?? id;
  return BRAND_PRESETS.find((preset) => preset.id === canonical) ?? BRAND_PRESETS[0];
}

export function getStoredBrand(): BrandId {
  try {
    return presetFor(localStorage.getItem(STORAGE_KEY)).id;
  } catch {
    // localStorage can throw in sandboxed contexts.
    return DEFAULT_BRAND;
  }
}

const ACCENT_EVENT = "june://accent";
// Same-window signal for JS consumers that can't read the CSS `--brand` var —
// notably the WebGL glass mark, which needs the concrete brand id to pick its
// palette and live-update (with its own color fade) when the accent changes.
// `applyBrandVar` only mutates an inline style, so there's no attribute mutation
// to observe; this CustomEvent is the runtime change signal.
const BRAND_CHANGE_EVENT = "june://brand-change";
const BRAND_TRANSITION_MS = 220;
const BRAND_TRANSITION_BUFFER_MS = 80;
let brandTransitionTimer: number | undefined;

function inTauri() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function prefersReducedMotion() {
  return (
    typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

function applyWithTransition(apply: () => void) {
  const root = document.documentElement;
  if (prefersReducedMotion()) {
    apply();
    return;
  }

  window.clearTimeout(brandTransitionTimer);
  root.setAttribute("data-brand-transition", "true");
  window.requestAnimationFrame(() => {
    apply();
    brandTransitionTimer = window.setTimeout(() => {
      root.removeAttribute("data-brand-transition");
    }, BRAND_TRANSITION_MS + BRAND_TRANSITION_BUFFER_MS);
  });
}

export function setStoredBrand(id: BrandId) {
  try {
    localStorage.setItem(STORAGE_KEY, id);
  } catch {
    // Apply still works for this session.
  }
  applyBrand(id, { animate: true });
  // Notify same-window subscribers (the glass mark) in this tick; localStorage
  // is already written above, so getStoredBrand() reads the new value.
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(BRAND_CHANGE_EVENT, { detail: id }));
  }
  // Tell the separate HUD webviews (agent/meeting/recording) to recolor too.
  if (inTauri()) {
    window.setTimeout(() => {
      void import("@tauri-apps/api/event")
        .then(({ emit }) => emit(ACCENT_EVENT, id))
        .catch(() => {});
    }, BRAND_TRANSITION_MS);
  }
}

// CSS-only apply: inline style on <html> overrides the :root defaults in
// tokens.css and cascades to every var(--brand) / var(--brand-wash) consumer.
// Fixed across light/dark, so a single pair covers both themes.
export function applyBrandVar(id: BrandId, options: { animate?: boolean } = {}) {
  const apply = () => {
    const preset = presetFor(id);
    const root = document.documentElement.style;
    root.setProperty("--brand", preset.value);
    root.setProperty("--brand-wash", preset.wash);
  };
  if (options.animate) {
    applyWithTransition(apply);
  } else {
    apply();
  }
}

// Main window: recolor + swap the native dock icon.
export function applyBrand(id: BrandId, options: { animate?: boolean } = {}) {
  applyBrandVar(id, options);
  syncDockIcon(id, options.animate ? BRAND_TRANSITION_MS : 0);
}

// Swap the native macOS dock/Cmd-Tab icon to match the accent. No-op on the
// web preview (no Tauri) and on builds that predate the command.
function syncDockIcon(id: BrandId, delayMs = 0) {
  if (!inTauri()) return;
  window.setTimeout(() => {
    void invoke("set_dock_icon", { brand: id }).catch(() => {
      // Best-effort: keep the bundled default icon if the command is absent.
    });
  }, delayMs);
}

export function initBrand() {
  applyBrand(getStoredBrand());
}

// Secondary windows (HUDs): apply the stored accent on load and keep it in
// sync when the main window changes it.
export function subscribeBrand(): Promise<UnlistenFn> {
  applyBrandVar(getStoredBrand());
  if (!inTauri()) return Promise.resolve(() => {});
  return import("@tauri-apps/api/event").then(({ listen }) =>
    listen<BrandId>(ACCENT_EVENT, (event) => applyBrandVar(event.payload, { animate: true })),
  );
}

// ---- React binding -------------------------------------------------------

function subscribeBrandChange(onChange: () => void) {
  // Another tab/window changing the stored accent fires `storage`; re-read then.
  // Scope to our key (or a full clear, key === null) so unrelated localStorage
  // writes don't trigger a needless brand re-read.
  const onStorage = (e: StorageEvent) => {
    if (e.key === STORAGE_KEY || e.key === null) onChange();
  };
  window.addEventListener(BRAND_CHANGE_EVENT, onChange);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(BRAND_CHANGE_EVENT, onChange);
    window.removeEventListener("storage", onStorage);
  };
}

/** The live selected brand id. Re-reads on setStoredBrand (same window) and on a
 *  cross-window storage change; safe to call during SSR-less client renders. */
export function useBrandId(): BrandId {
  return useSyncExternalStore(subscribeBrandChange, getStoredBrand, () => DEFAULT_BRAND);
}
