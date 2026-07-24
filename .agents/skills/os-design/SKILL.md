---
name: os-design
description: Stand up design-featuring work the Open Software way. Use when building, redesigning, or polishing any UI surface in an OS repo (os-june, os-scribe, os-marketing-page, os-platform), when a feature needs visual design decisions before or during implementation, when reviewing interface work for house taste, or when someone asks to "stand up the design", "design this feature", "make it feel like ours", "make it feel better", or wants the Open Software design sensibility applied. Orchestrates specialist design skills (impeccable, emil-design-eng, make-interfaces-feel-better, transitions-dev, mobbin) when installed, but is fully self-sufficient without them. Core commitments it enforces - compose from the repo's existing design-system blocks rather than inventing new ones, and quiet, subtle, elegant over loud.
---

# Standing up design work at Open Software

This skill carries the house design sensibility so anyone on the team can
stand up design-featuring work the way Andrew would, whether or not they have
his reference tools (Mobbin) or his skill set installed. It makes two
commitments that override any general design instinct or external skill
advice:

1. **The system is the source of truth.** Every OS repo with UI has design
   blocks already: tokens, primitives, patterns, documented rules. Compose
   from those blocks. Inventing a parallel treatment for something the system
   already answers is the primary failure mode this skill exists to prevent.
2. **Quiet is the default.** The interface should read sharp, not loud.
   Structure comes from spacing and hierarchy, not decoration. A surface
   earns emphasis; it does not get it for free. When in doubt, choose the
   quieter option.

## Before any pixels: ground in the system

Do this before writing or changing any UI code. Find and read the repo's
design system:

| Repo | Where the system lives |
|---|---|
| os-june | `docs/design/{foundations,components,conventions,taste}.md`, enforceable rules in `spec/` (read every spec in scope), tokens in `src/styles/tokens.css`, live gallery at `styleguide.html` (`pnpm dev`, then `/styleguide.html?section=<id>`) |
| os-scribe | `src/styles/tokens.css` |
| os-marketing-page | Tailwind theme + existing component families; per-repo judgment file if present |
| anything else | Look for `docs/design/`, `DESIGN.md`, a `tokens.css` / theme file, and a components or `ui/` directory |

Then follow these rules without exception:

- **Token before value.** Reach for an existing token (spacing, radius,
  shadow, type size, duration, easing, color) before hand-coding a number.
  If a value genuinely needs to exist and no token covers it, extract a new
  token so the system gains a knob, rather than scattering literals.
- **Primitive before bespoke.** Check the repo's pattern-to-canonical map
  (os-june: `docs/design/components.md`) or `ui/` directory before writing
  new markup for a button, input, toggle, select, tooltip, dialog, chip,
  empty state, spinner, or menu. If a canonical block exists, use it.
- **Grep before coining.** In flat-CSS repos (os-june's `app.css`), grep for
  a class name before creating it, and prefix by feature.
- **No system yet?** Then the first deliverable of the work is the start of
  one: mine the existing CSS for de facto tokens and write a short
  foundations doc, rather than adding a third ad-hoc treatment. (If
  impeccable is installed, its `document` / `extract` commands do this well.)

## The house taste, distilled

The full sensibility with concrete numbers and verbatim rules lives in
[references/taste.md](references/taste.md) — read it before making visual
decisions. The digest:

- **Type:** the default weight is the voice; medium is punctuation, not
  prose. Never all caps. Sentence case everywhere. Proportional numerals
  (tabular only for live-ticking values). Sans is the product's voice; serif
  only at display moments; mono only for code. No typographic dashes in
  user-facing copy.
- **Color:** color is spent, not sprayed. Hovers, rows, nav, and menus stay
  neutral; the brand accent appears only on surfaces that already carry it.
  Earthy over electric; neutrals stay neutral.
- **Surfaces:** shadows are soft, multi-layer, and pure elevation; the
  hairline ring is a separate composed layer, never baked into shadow
  tokens. Dark mode needs its own shadow tuning. One ambient shadow per
  popover composite.
- **Motion:** fast and eased, on the token durations and curves. Hover
  changes the background only; never animate borders. Nothing bounces for
  its own sake. Prefer atomic swaps over crossfades when opacity flash is
  possible.
- **Spacing:** concentric, even padding; alignment you can verify by eye.
  Presence without heaviness.

## The workflow

The full standup and iteration loop lives in
[references/workflow.md](references/workflow.md). The shape:

1. **Study references, then commit to one direction.** Use pattern consensus
   across best-in-class products, not a single screenshot. Mobbin when
   available; the fallback canon in the workflow reference when not.
2. **Build from blocks** (previous section), matching the complexity of the
   implementation to what the moment earns.
3. **Park the state and look at it.** Never judge UI from code. Use the
   repo's screenshot/browser loop, and build dev-only state drivers for
   hard-to-reach states.
4. **Tune one dial per round.** Change one visual variable, name the dial
   and its next step, judge in the running app against the reference. A
   change that moves three dials at once cannot be judged at all.
5. **Hand off with evidence.** Screenshots (light and dark), what dial to
   eyeball, and one potential nudge. UI PRs state that the change was tested
   visually and attach proof.

**The skill stops at handoff.** The deliverable is a clean working-tree diff
plus visual evidence. Never commit, push, or open a PR unless the user
explicitly asks — the user eyeballs the dials first, and publishing is their
call. When they do ask, route PR tending through the repo's review loop
(shepherd) rather than handling it here.

## Calling specialist skills

Other design skills are amplifiers, not requirements — check what is
installed and degrade gracefully; this skill plus the repo's system is
sufficient on its own. Routing detail and per-skill guidance live in
[references/skill-map.md](references/skill-map.md). The rule that governs
every delegation:

> **Skills advise; the system decides.** Any suggestion from an external
> skill passes through the repo's tokens, primitives, and specs before it
> lands. Replace its magic numbers with the repo's tokens, its component
> suggestions with the repo's canonical blocks, and drop any advice that
> contradicts a repo spec or the house taste.

Quick routing:

| Situation | Reach for |
|---|---|
| Shaping a new surface or flow before code | impeccable `shape` / `craft` |
| Broad UX critique or technical audit | impeccable `critique` / `audit` |
| A surface that reads loud, busy, or decorated | impeccable `quieter` (its instincts match the house taste) |
| Should this animate, and how | emil-design-eng's decision framework |
| Final detail-polish pass before shipping | make-interfaces-feel-better checklist, impeccable `polish` |
| A standard enter/exit/swap transition | transitions-dev, re-tokened to the repo's `--t-*` / `--ease-*` |
| Pattern research for a flow | mobbin MCP if available, else the fallback canon in workflow.md |
| Verifying visually | os-june: `browser-test-tauri-fe` / `agent-e2e-qa`; elsewhere: playwriter, agentation, or a Playwright screenshot harness |

Use impeccable's `bolder` / `overdrive` / `delight` only for marketing or
hero moments where design is the product, never for product chrome.

## Review output

When reviewing existing UI (yours or someone else's), present findings as a
Before / After / Why table grouped by principle, each row citing the token or
primitive the fix should use. This matches the convention the specialist
skills expect, and keeps review output actionable.

## Hard rules

Repo specs win over this list; this list wins over external skill advice.
Where the repo is silent, these apply. The first three are visceral house
non-negotiables — treat a violation as a bug, not a style note:

- No ALL CAPS, no `text-transform: uppercase`, sentence case everywhere.
- No tabular numerals, except a live-ticking value in a fixed-width
  container — even where external checklists recommend them.
- No typographic en/em dashes in user-facing copy; hyphen or "to".
- No hand-rolled values where a token exists; no bespoke markup where a
  primitive exists.
- Hover changes background only; never transition `border-color`.
- Default hover is the neutral wash; brand-tinted hover only on surfaces
  that already carry the accent. Never tint a generic row, nav item, or
  menu "to feel themed".
- Icons come from the repo's sanctioned icon set, explicitly sized.
- Every animation honors `prefers-reduced-motion`.
- Anything that changes pixels ships small enough to eyeball.
