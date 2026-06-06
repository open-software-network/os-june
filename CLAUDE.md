<!-- SPECKIT START -->

For additional context about technologies to be used, project structure,
shell commands, and other important information, read
`specs/003-conversation-turns/plan.md`.

<!-- SPECKIT END -->

## UI conventions

- **Sentence case for UI labels.** Section titles, button text, menu items, and
  tabs use sentence case ("Notes", "Filter notes", "New note") — never
  ALL CAPS / `text-transform: uppercase`. Eyebrows and pill labels included.
- **Design tokens live in `src/styles/tokens.css`.** Reach for the variables
  there before adding hand-coded sizes, colors, radii, or motion values.
- **Iconography:** outlined icons (`central-icons`) for ambient/structural UI
  (sidebar, search, calendar, list rows). Filled icons
  (`central-icons-filled`) for primary action surfaces (recorder controls).
