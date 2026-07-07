# No all caps

**Rule.** No ALL CAPS in UI, ever. No `text-transform: uppercase` in CSS, and no
capsy copy in eyebrows, pre-headers, or metadata. Labels use sentence case (see
[sentence-case](sentence-case.md)).

**Why.** June's surface reads as calm and precise; shouty or CSS-uppercased text
undercuts that and hurts scannability. The stylesheet has zero
`text-transform: uppercase` today, and this rule keeps it that way, especially
for the eyebrow and metadata slots where uppercase creeps in by habit.

**How to apply.** Write labels in sentence case and render them as-is. Never add
`text-transform: uppercase`; if a design shows caps, render sentence case
instead.

**Exceptions.** Acronyms and proper nouns keep their own casing (OS Accounts,
MCP, RC).
