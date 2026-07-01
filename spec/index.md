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

## Frontend — UI styling

- [icons-central-only](icons-central-only.md) — icons from `central-icons` / `central-icons-filled` only
- [design-tokens](design-tokens.md) — use the variables in `src/styles/tokens.css`
