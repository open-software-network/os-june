# App icons

Everything in this directory is generated. Do not hand-edit the PNGs, `.icns`,
or `.ico`. Edit the SVG sources, then regenerate:

```bash
pnpm icons
```

That runs `scripts/generate-icons.mjs`, which produces two things:

- **Base icon set** (`*.png`, `icon.icns`, `icon.ico`, `android/`, `ios/`) from
  `clovy-app-icon.svg` via the Tauri CLI's `tauri icon`.
- **Themed dock icons** (`themed/icon-<brand>.png`, one per accent) from the
  single template `themed/_src/icon.template.svg`. Sage keeps the canonical
  bright lime Clovy; Rose, Clay, Ocean, and Plum use a luminous mark in the
  selected hue on a dark matching backdrop. The per-brand accent hexes come
  straight from `BRAND_PRESETS` in `src/lib/brand.ts`, which is the single
  source of truth.

## When to run it

- You changed `clovy-app-icon.svg` (the base mark).
- You changed a preset hex in `src/lib/brand.ts`.
- You added or removed a preset in `src/lib/brand.ts`. Themed PNGs for dropped
  brands are deleted automatically.

## Notes

- `src-tauri/src/theme_icon.rs` embeds the themed PNGs and keeps an `"amber"`
  legacy alias pointing at `icon-clay.png`, so the clay preset must stay.
- `tauri icon` output is deterministic for a given CLI version, so reruns are
  byte-stable.
