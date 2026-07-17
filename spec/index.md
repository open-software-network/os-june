# June enforceable coding rules

Read every spec in your scope before writing code; **violations should fail
review.** When you add, rename, or remove a spec, update this index in the same
commit — it is the single source of truth for what rules exist. Each spec is
**Rule / Why / How to apply / Exceptions**.

These rules are summarized in [AGENTS.md](../AGENTS.md); the files here are the
authoritative, reviewable version.

## Frontend — UI copy

- [sentence-case](sentence-case.md) — sentence case for all UI labels
- [no-typographic-dashes](no-typographic-dashes.md) — no en/em dashes in user-facing copy
- [no-all-caps](no-all-caps.md) — no ALL CAPS in UI, no `text-transform: uppercase`

## Frontend — UI styling

- [icons-central-only](icons-central-only.md) — central icons on web; ADR-recorded platform symbols in native targets
- [design-tokens](design-tokens.md) — use the variables in `src/styles/tokens.css`
- [no-tabular-numerals](no-tabular-numerals.md) — UI numbers use proportional figures, never `tabular-nums`
- [scroll-fade](scroll-fade.md) — clipped scrollers use the shared `useScrollFade` + `.scroll-fade` / `.scroll-fade-mask` primitive

## Frontend — typography

- [type-scale](type-scale.md) — font sizes only from `--fs-*`; headings follow the mapping table
- [font-weights](font-weights.md) — only 400 and `var(--fw-medium)`, never raw 500/600/700
- [font-families](font-families.md) — sans is the voice; serif for headings/display, mono for code

## Frontend — controls

- [control-sizes](control-sizes.md) — control heights from `--control-*`, no raw min/max-heights

## Tooling — dependencies

- [package-install-security](package-install-security.md) — pnpm-only; new package installs go through `sfw`; 7-day `minimumReleaseAge` cooldown
