# Font families

**Rule.** Sans (`--font-sans`, ABC Diatype) is the voice for nearly all UI. Serif
(`--font-serif`, Martina Plantijn) is for headings and display moments only. Mono
(`--font-mono`, Berkeley Mono) is only for code and technical identifiers.

**Why.** The sans face carries June's calm, precise voice. Letting serif or mono
leak into body copy dilutes that voice and makes the surface read as inconsistent
rather than intentional.

**How to apply.** Default to `--font-sans`. Reach for `--font-serif` only on a
heading or display element where the moment earns it; reach for `--font-mono`
only where the content is literally code or a technical identifier the user is
meant to read as such.

**Exceptions.** The existing serif empty-state titles
(`.empty-state-title`) are canon, not a violation. So is June's voice on the
Home relationship thread: her replies there (and the daily greeting) render in
`--font-serif` at `--fs-xl`, deliberately separating the person she is from
the UI chrome around her. Sent messages and every focused-session surface stay
sans.
