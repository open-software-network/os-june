# Font weights

**Rule.** Use only the default weight 400 and `var(--fw-medium)`. Never write a
raw `font-weight: 500`, `600`, `700`, or `bold`.

**Why.** ABC Diatype ships only two faces (Regular 400 and Medium 600) with
`font-synthesis: none`, so any other value silently remaps: `500` renders 400 and
`700` renders 600. The declaration then lies about what you see. Writing raw 600
also hides the `--fw-medium` token, so the "medium" intent stops being greppable.

**How to apply.** Leave body copy at the inherited 400. Reach for
`var(--fw-medium)` only for headings, row titles, and structural emphasis (see
the heading mapping in
[docs/design/foundations.md](../docs/design/foundations.md)). Serif text never
goes above 400.

**Exceptions.** None.
