# No en-dashes or em-dashes in user-facing copy

**Rule.** User-facing strings never use en-dashes (–) or em-dashes (—). Ranges
use a plain hyphen ("5-10 min", "Mon-Fri") or the word "to". Where an em-dash
would join clauses, rewrite with a period, comma, colon, or parentheses.

**Why.** A consistent plain-hyphen house style; typographic dashes render
inconsistently across surfaces and are easy to get subtly wrong.

**How to apply.** Applies across the board: labels, titles, body copy, tooltips,
aria-labels, notifications, empty states, error messages, and HTML pages. Grep
your changed strings for `–` / `—` before review.

Not CI-enforced (unlike [icons-central-only](icons-central-only.md), which Biome
checks). A repo-wide grep can't tell user-facing copy from the en/em dashes used
freely in code comments (the exception below), test `describe`/`it` names, and
dev demo strings, so an automated gate would be all false positives. This stays
a human review step.

**Exceptions.** Code comments (they are not copy). Third-party or legal text
quoted verbatim.
