# Sentence case for UI labels

**Rule.** Section titles, buttons, menu items, tabs, eyebrows, and pills use
sentence case ("Notes", "Filter notes", "New note"). Never ALL CAPS or
`text-transform: uppercase`.

**Why.** June's surface reads as calm and precise; shouty or CSS-uppercased
labels undercut that and hurt scannability.

**How to apply.** Capitalize only the first word (and proper nouns). Do not add
`text-transform: uppercase` in CSS; if a design shows caps, render the text in
sentence case instead.

**Exceptions.** Proper nouns and acronyms keep their casing (OS Accounts, MCP,
RC). Code identifiers and log lines are not UI copy.
