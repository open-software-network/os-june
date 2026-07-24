# Routing to specialist skills

os-design is self-sufficient: the taste and workflow references plus the
repo's design system are enough to do the work. The skills below are
amplifiers. Before routing, check what is actually installed (skills vary by
machine and repo); if a skill is missing, do the equivalent work inline using
this skill's references.

## The filter rule

**Skills advise; the system decides.** Every suggestion from a specialist
skill passes through three gates before it lands in code:

1. **Repo specs win.** If the repo documents a rule (os-june `spec/`,
   `docs/design/conventions.md`), it overrides the skill's advice. Example:
   external skills recommend `tabular-nums` for numbers; os-june bans it
   outside live-ticking values.
2. **Tokens replace magic numbers.** A skill's duration, easing, radius,
   shadow, or color suggestion gets mapped to the repo's nearest token. If
   no token fits and the value is worth keeping, extract a token.
3. **Canonical blocks replace suggested components.** If a skill proposes
   building a tooltip/dialog/select/toggle/menu treatment and the repo has a
   canonical one, use the repo's.

## impeccable (command dispatcher, 25 sub-commands)

The broadest skill; the closest to this one in spirit. It reads
`PRODUCT.md` / `DESIGN.md` and classifies work as **brand** register (design
is the product: marketing pages, heroes) or **product** register (design
serves the product: app chrome). OS product work is almost always product
register; os-marketing-page hero moments are brand register.

| When | Command |
|---|---|
| Shape a feature's UX before code | `shape` |
| Shape + build end-to-end | `craft` |
| UX review with scoring/personas | `critique` |
| Technical audit (a11y, perf, responsive, theming) | `audit` |
| Final pass before shipping | `polish` |
| Surface reads loud, busy, decorated | `quieter` — its instincts match the house taste |
| Strip a surface to its essence | `distill` |
| Errors, i18n, edge cases, overflow | `harden` |
| First-run flows, empty states | `onboard` |
| UX copy, labels, error messages | `clarify` |
| Responsive/cross-device | `adapt` |
| UI performance | `optimize` |
| Generate DESIGN.md from existing code | `document` |
| Pull tokens/components into a system | `extract` |
| Live in-browser variant iteration | `live` (needs a dev server) |

Use `bolder`, `delight`, and `overdrive` only where design is the product
(marketing/hero moments) — never on product chrome; the house answer to
"bland" product chrome is better hierarchy and spacing, not amplification.
Note impeccable's absolute bans (gradient text, glassmorphism-by-default,
identical card grids, modal-first) are compatible with the house taste; its
"commit boldly to color" guidance is not — the house commits to restraint.

## emil-design-eng

Long-form design-engineering philosophy: when to animate (frequency
framework — never animate high-frequency/keyboard-driven actions), easing
choice (ease-out for enter/exit, never ease-in), springs, transform mastery,
gesture handling. Reach for it when deciding **whether and how** something
should move, or when building a component whose feel is the point. Its
review format (Before/After/Why table) is the house review format. Filter
its specific values through the repo's motion tokens.

## make-interfaces-feel-better

A terse 16-point polish checklist with exact numbers (concentric radii,
optical alignment, interruptible transitions, icon enter animations, hit
areas, font smoothing). Run it as the **final detail pass** over finished UI
work. Two known conflicts with the house taste: its `tabular-nums` rule
(house: proportional except live-ticking) and any suggestion that adds
decoration — the filter rule handles both.

## transitions-dev

12 drop-in, framework-agnostic CSS transitions (modal, dropdown, panel,
icon swap, success check, badge, shake...) with `reveal` / `review` /
`apply` verbs. Reach for it when a surface needs a standard transition and
you want a production-ready snippet instead of authoring from scratch.
Always re-token its `:root` variables onto the repo's `--t-*` / `--ease-*`
before landing.

## Verification and research

| Need | os-june | Elsewhere |
|---|---|---|
| Screenshot/drive the UI | `browser-test-tauri-fe` | playwriter (live Chrome tab), agentation, Playwright harness |
| Live click-through + video evidence | `agent-e2e-qa` | share-video after manual drive |
| Pattern research | mobbin MCP | reference canon in workflow.md |
| Component sourcing (web apps on shadcn) | — | shadcn skill/MCP |
| A11y + visual review | rams | rams |
| Charts/data surfaces | dataviz | dataviz |
| Loading/progress spinners | house `Spinner` primitive | unicode-animations |

## Review loop

Design PRs close out through the same loop as any PR: shepherd (Greptile
primary, Codex/Octopus advisory) plus the repo's review battery
(os-june: `repo-review`). Visual evidence attached; Andrew does the final
merge.
