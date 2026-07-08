# Design taste

The sensibility behind the rules. [foundations.md](foundations.md),
[components.md](components.md), and [conventions.md](conventions.md) say what
to do; this file says why the system leans the way it does, so the same taste
can be carried to other projects even where the tokens differ.

## Quiet is the default

The interface should read sharp, not loud. Restraint is the house move: when
in doubt, use the quieter option and let structure come from spacing and
hierarchy rather than decoration. A surface earns emphasis; it does not get it
for free.

## Type

- **The default weight is the voice.** Body, labels, nav, and most chrome sit
  at regular weight. Medium is punctuation, not prose: headings, row titles,
  structural emphasis, and little else. If a screen feels flat, fix the
  hierarchy or spacing before reaching for weight.
- **Never all caps.** Not in eyebrows, not in pre-headers, not in metadata.
  Sentence case everywhere; capitals are for proper nouns and acronyms.
- **Proportional numerals.** Tabular figures read like a spreadsheet; the only
  place they belong is a live-ticking value whose digits would jitter the
  layout, and even then inside a fixed-width container.
- **Sans is the voice of the product.** Serif appears at display moments
  (view titles, empty states, welcome) where a touch of warmth earns its
  place. Mono is for code and technical identifiers only; it spreads if you
  let it.
- **No typographic dashes in copy.** Hyphens or "to".

## Color

- **Color is spent, not sprayed.** The brand accent recolors the whole app
  through the token pipeline, so a single deliberate touch goes a long way.
  Hovers, rows, nav, and menus stay neutral grey; the brand tint appears only
  on surfaces that already carry the accent (the chat send affordances, the
  record controls, onboarding heroes).
- **Neutrals stay neutral.** Surfaces take a chroma-capped wash of the accent
  so a vivid preset tints the greys exactly as much as a dusty one. Text never
  takes the wash.
- **Earthy over electric.** The preset family (rose, clay, sage, ocean, plum)
  is dusty and warm; a new accent should feel like it belongs at that table.
- **Semantic colors stay in the earthy chroma register.** Danger/success/
  warning live near the palette's saturation (`--brand` ~0.13, `--success`
  0.12), not above it. `--destructive` was dechromatized from 0.22 to a brick
  0.15 because a neon red was the one element that fought the low-chroma
  surfaces around it; keep new status colors in that band.

## Motion and feedback

- **Hover changes the background only.** Borders are static chrome; animating
  them reads as nervous.
- **Elevation is composed, not baked.** Shadows are pure elevation; the
  hairline ring is a separate layer added at the call site. One ambient shadow
  per popover composite; stacking shadows muddies the edge.
- **Fast and eased.** Transitions run on the token durations and curves;
  nothing bounces for its own sake.

## How we tune

Visual weight (shadows, borders, rings, tints, weights) converges through
small iterations: change one dial per round, name the dial, and judge it in
the running app against the reference. A change that moves three dials at
once cannot be judged at all. Zero-visual-change refactors (renaming a value
to the token that already renders it) land freely; anything that changes
pixels ships small enough to eyeball.
