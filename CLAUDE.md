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
- **Iconography:** `central-icons` ONLY — never lucide-react or any other
  icon set (lucide was removed from the dependencies on purpose; do not add
  it back). Outlined icons (`central-icons`) for ambient/structural UI
  (sidebar, search, calendar, list rows). Filled icons
  (`central-icons-filled`) for primary action surfaces (recorder controls).
  The set ships ~2000 glyphs (24×24 grid, 2px stroke) — search
  `node_modules/central-icons/` for a fitting name before reaching anywhere
  else. House picks: download = `IconArrowInbox`, close = `IconCrossSmall`/
  `IconCrossMedium`, retry = `IconArrowRotateClockwise`, generic file =
  `IconFileText`.
