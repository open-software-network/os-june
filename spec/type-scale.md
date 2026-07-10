# Type scale

**Rule.** Font sizes come only from the `--fs-*` tokens in
`src/styles/tokens.css`. Headings follow the heading mapping table in
[docs/design/foundations.md](../docs/design/foundations.md). Never hand-code a
`font-size` in px, rem, or em.

**Why.** Three sibling contexts (view titles, dialog titles, row titles) each
drifted to their own raw value (16 / 15 / 14px), breaking the shared rhythm. A
fixed scale keeps headings aligned across surfaces and themeable.

**How to apply.** Use `var(--fs-md)` for body and pick the token that matches the
element's role in the mapping table. If a design asks for a size between two
tokens, resolve it to one of them rather than inventing an off-scale value.

Every `--fs-*` token is `base * var(--font-scale)`, and the Appearance "Text
size" preference (`src/lib/font-scale.ts`) overrides `--font-scale` on `<html>`.
So any element that reads a token scales with that preference for free; a
hand-coded `px` size silently opts out and reads wrong at the non-default sizes.
Keep sizes relative to the surrounding token where it makes sense — inline code
using `font-size: 0.9em` scales with its parent, which is fine.

Non-text elements that *represent* text — the sidebar wordmark is the one case
today — multiply their dimension by `var(--font-scale)` directly
(`height: calc(14px * var(--font-scale))`). Glyph icons, control heights, and
spacing deliberately do NOT scale; they're fixed chrome.

**Exceptions.** None beyond the mapping table. Display and marketing sizes are
already in the scale (`--fs-2xl`, `--fs-display`).
