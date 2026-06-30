<!-- SPECKIT START -->

For additional context about technologies to be used, project structure,
shell commands, and other important information, read
`specs/003-conversation-turns/plan.md`.

<!-- SPECKIT END -->

## UI conventions

See the "UI conventions" section in [CLAUDE.md](CLAUDE.md) — sentence-case
labels, **no en-dashes (–) or em-dashes (—) in user-facing copy** (hyphen
or "to" for ranges; rewrite asides with a period, comma, colon, or
parentheses), design tokens from
`src/styles/tokens.css`, and **icons from `central-icons` /
`central-icons-filled` only (never lucide-react or any other icon set;
lucide was deliberately removed from the dependencies)**.

## PR and description conventions

When drafting PR titles, PR descriptions, issue summaries, release notes, or
other project descriptions, avoid naming or comparing against other products
unless the user explicitly asks for that context or the reference is required
for a concrete integration, compatibility note, migration, or legal
attribution. Prefer describing the behavior, workflow, or category generically.
