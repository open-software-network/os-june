# Use design tokens

**Rule.** Reach for the CSS variables in `src/styles/tokens.css` before
hand-coding sizes, colors, radii, or motion values.

**Why.** Tokens keep spacing, color, and motion consistent and themeable;
hand-coded values drift and break theming / dark mode.

**How to apply.** Use `var(--token)` for spacing, color, radius, and
timing/easing. If a needed value has no token, add a token rather than a magic
number.

**Exceptions.** A genuine one-off value outside the design system (rare) — call
it out in review.
