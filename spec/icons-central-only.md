# Icons: central-icons only

**Rule.** Use icons from `central-icons` (outlined) or `central-icons-filled`
(filled) only. Never lucide-react or any other icon set.

**Why.** One coherent icon language. lucide-react was deliberately removed from
the dependencies; re-adding it fragments the visual system and grows the bundle.

**How to apply.** Outlined icons for ambient/structural UI (sidebar, search,
lists, calendar); filled icons for primary action surfaces (recorder controls).
Search `node_modules/central-icons/` for a fitting glyph before reaching
anywhere else.

**Exceptions.** None for product UI. If a needed glyph is missing, add it to the
central-icons set rather than importing another library.
