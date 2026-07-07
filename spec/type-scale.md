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

**Exceptions.** None beyond the mapping table. Display and marketing sizes are
already in the scale (`--fs-2xl`, `--fs-display`).
