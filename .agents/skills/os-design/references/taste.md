# The house taste, in full

Distilled from os-june's `docs/design/taste.md` and several months of design
sessions across os-june, os-scribe, and os-marketing-page. Where a number is
given, it is a number that survived iteration in a shipping product; treat it
as the starting value, not a law. os-june token names are used for
concreteness — map them to the local repo's equivalents.

## The governing idea

Quiet is the default. Restraint is the house move. The recurring praise words
in real sessions: subtle, quiet, refined, whisper, hairline, breathing room,
"presence without heaviness". The recurring rejection words: loud, heavy,
random, nervous, twee ("a repeating flourish would tip into twee").

Emphasis is a budget. Every weight bump, tint, shadow, and animation spends
from it. A screen that spends everywhere reads as noise; a screen that spends
once reads as designed.

## Non-negotiables

These are visceral, zero-tolerance rules, not preferences. Finding one in a
diff is a bug, not a style note:

- **No ALL CAPS, ever.** No uppercase eyebrows, pre-headers, buttons, tab
  labels, or metadata; no `text-transform: uppercase` anywhere. Sentence
  case everywhere; capitals are for proper nouns and acronyms only.
- **No tabular numerals.** No `tabular-nums` / `font-variant-numeric:
  tabular-nums`; UI numbers use the typeface's proportional figures. The
  single exception is a live-ticking value whose digits would jitter the
  layout, and even then inside a fixed-width container. External polish
  checklists recommend tabular numbers; here that advice is rejected.
- **No typographic en/em dashes in user-facing copy.** Hyphens or "to".
- **No random tinted hovers.** Generic rows, nav items, and menus hover
  with the neutral wash, never the brand tint.
- **No animated borders.** Hover changes background only.
- **No twee.** A decorative flourish that repeats gets cut.

## Type

- **The default weight is the voice.** Body, labels, nav, and chrome sit at
  regular weight. Medium is punctuation, not prose: headings, row titles,
  structural emphasis, little else. If a screen feels flat, fix hierarchy or
  spacing before reaching for weight. In one os-june pass, 205 font-weight
  declarations were normalized down to exactly two values.
- **Check the shipped faces before trusting a declared weight.** With
  `font-synthesis: none` and a limited family (os-june ships 400 + 600
  only), CSS resolves 500 DOWN to 400 but 700 UP to 600 — declarations can
  lie. Grep the `@font-face` blocks first.
- **"Presence without heaviness":** a title can match body size and regular
  weight and still lead, distinguished only by placement and a single medium
  accent where structure demands it.
- **Never all caps.** Not in eyebrows, not pre-headers, not metadata.
- **Proportional numerals.** Tabular figures read like a spreadsheet; the
  only place they belong is a live-ticking value whose digits would jitter
  layout, and even then inside a fixed-width container.
- **Family roles:** sans is the product's voice; serif appears at display
  moments (view titles, empty states, welcome) where warmth earns its place;
  mono is for code and technical identifiers only — it spreads if you let
  it. Optical trims are fair game (os-june renders its code font at 0.92em).
- **No typographic dashes in copy.** Hyphens or "to".

## Color

- **Color is spent, not sprayed.** One accent drives the whole app through
  the token pipeline, so a single deliberate touch goes a long way. Hovers,
  rows, nav, and menus stay neutral grey; brand tint appears only on
  surfaces that already carry the accent (send affordances, record controls,
  onboarding heroes). The recurring failure mode when theming anything new:
  the "random tinted hover".
- **Neutrals stay neutral.** Surfaces may take a chroma-capped wash of the
  accent so vivid and dusty presets tint the greys equally; text never takes
  the wash.
- **Earthy over electric.** The preset family (rose, clay, sage, ocean,
  plum) is dusty and warm. A new accent should feel like it belongs at that
  table. On glass/marketing surfaces the same instinct holds: dustier
  presets over saturated ones, because bright glass overpowers the page.
- **Every color is a token.** When tuning, tune the token so the whole
  system moves with one knob. When a needed value has no token, extract one
  rather than scattering `color-mix` percentages.
- **White-on-solid needs its own token** (os-june: `--on-solid`), because
  the default foreground token inverts in dark mode and silently breaks on
  fixed brand/destructive solids.

## Surfaces: shadows, rings, borders

- **Shadows are pure elevation.** Never bake a hairline ring into shared
  shadow tokens; call sites compose a ring (`--shadow-inset` or a real 1px
  border) separately, so focus states and overrides can recompose the stack.
- **Soft and layered over hard and single.** Good shadow tokens are 2-4
  layer stacks (contact + mid + ambient) that read as physical depth. A
  hard bottom blur reads as an "underline" — when that appears, step down
  (e.g. `--shadow-lg` → `--shadow-md`), don't add more layers.
- **Dark mode has its own shadow overrides.** Light-tuned black shadows
  vanish on near-black (12% black is invisible). Grep for unthemed
  `box-shadow` values before touching tokens.
- **The whisper-shadow recipe** for surfaces that should read as "in the
  page, not above it": background + hairline transparent border + the
  smallest shadow token.
- **Ring recipes that shipped:** unified surface ring
  `inset 0 0 0 1px rgb(0 0 0 / 8%)`; composer ring at rest = the subtle
  border color at 60%, focused = focus ring tinted 20% over it. A
  ring-instead-of-border surface keeps a transparent 1px border for layout
  so nothing shifts.
- **One ambient shadow per popover composite.** Stacking shadows on nested
  layers muddies the edge.
- **Family treatment:** sibling floating surfaces (tray, queue, notices)
  share one recipe (same surface token + ring-in-shadow + same radius) so
  they read as one family.

## Motion

- **Four gates before animating:** does this element change often enough
  that animation would annoy (frequent/keyboard-driven actions: don't)?
  what is the purpose? enter/exit ease-out, never ease-in; UI transitions
  under ~300ms.
- **Hover changes the background only.** Borders are static chrome;
  animating them reads as nervous.
- **Fast and eased, on the tokens** (`--t-fast/med/slow`, `--ease-*`).
  Nothing bounces for its own sake.
- **Retargeting transitions, not keyframes, for stateful controls.**
  Keyframes restart from scratch on each flip and read as buggy under rapid
  taps; transitions retarget mid-flight. Mash-test every control.
- **Atomic swaps over crossfades** when a state flips (sprite swap for an
  eye-state, icon swap): crossfades produce opacity flash.
- **Single clock:** when two transitions drive one element they drift.
  Register one animatable `@property` and derive everything from it via
  `calc()`.
- **Streaming/progressive text:** batch deltas (~80ms windows) and fade
  chunks together — a reference-matched two-stage fade (fast to ~0.3 for an
  instantly readable tail, then a graceful crawl to 1 over ~1.5s) beat
  per-word animation.
- **Hover-intent numbers that shipped:** 150ms debounce before hover cards
  open (so sweeping the pointer doesn't trigger them); ~550ms tooltip delay
  (so labels don't trail on sweep).
- **Press feedback:** a subtle scale (0.96-0.97) on press for buttons that
  earn it.
- **Hover-revealed actions are absolutely positioned** so hovering never
  shifts layout.
- **Everything honors `prefers-reduced-motion`** and degrades to the solid,
  legible state.

## Spacing and geometry

- **Concentric insets:** outer radius = inner radius + padding, even padding
  on all sides (a shipped recipe: 4px outer padding → 14px card radius −
  4px = 10px inner, then 6px content inset — all edges align).
- **Optical over geometric alignment:** center by eye, pin icons to the
  visual center of their row.
- **Chrome doesn't scale, text does.** User font-scale presets are
  quantized steps; icons and control chrome stay fixed (scaled chrome looks
  like a rendering bug).
- **Control sizes come from tokens**, not hand-rolled min/max heights.

## Affordances

- **Subtle over decorated.** The affordance corrections that recur: a "Show
  more" is muted-foreground text, no weight change, no underline, hover just
  darkens to foreground. A metadata pill that doesn't need to be a pill gets
  de-styled to plain text. Secondary buttons are the quiet grey, not a
  themed tint.
- **Make the empty state be the UI** where possible: instead of a "nothing
  here yet" card, show the real directory/list in its ready state.
- **Stable identity for transient UI:** toasts reuse a stable id so rapid
  re-fires update one toast in place instead of stacking.
