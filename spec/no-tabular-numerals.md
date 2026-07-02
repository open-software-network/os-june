# No tabular numerals

**Rule.** UI numbers use the typeface's default proportional figures. Never set
`font-variant-numeric: tabular-nums` on a rule that styles user-facing numbers.

**Why.** Proportional figures match the app's type voice; tabular figures read
as spreadsheet styling and the design owner has explicitly rejected them.

**How to apply.** Never add `font-variant-numeric: tabular-nums` in new styles.
When you touch a rule that already has it, remove it unless it qualifies as an
exception below.

**Exceptions.** Live-ticking values where digit-width jitter causes visible
layout shake (recording timers, streaming counters). Even then, prefer a
fixed-width container first and reach for tabular figures only if that is not
enough.
