# Control sizes

**Rule.** Interactive control heights come from the `--control-*` tokens in
`src/styles/tokens.css` (`--control-xs` 22px to `--control-xl` 36px). Don't
hand-code a raw `min-height` or `max-height` on buttons, inputs, or selects.

**Why.** Controls that share a row or a form need to line up. Raw pixel heights
drift apart as they get copied and tweaked, so buttons and inputs stop matching.
Tokens keep the sizes consistent and adjustable in one place.

**How to apply.** Pick the `--control-*` step that fits the control's density and
set the height from it. If a needed height has no token, add one rather than
hard-coding a pixel value.

**Exceptions.** Intrinsically sized content rows (a control whose height is
driven by wrapped content, not a fixed control size).
