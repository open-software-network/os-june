# Icons: central-icons only

**Rule.** Web product UI uses icons from `central-icons` (outlined) or
`central-icons-filled` (filled) only. Never use lucide-react or another web
icon set. A native product target that cannot consume the web packages may use
the platform-native symbol set when an accepted ADR records that boundary.

**Why.** One coherent icon language. lucide-react was deliberately removed from
the dependencies; re-adding it fragments the visual system and grows the bundle.

**How to apply.** Outlined icons for ambient/structural UI (sidebar, search,
lists, calendar); filled icons for primary action surfaces (recorder controls).
Search `node_modules/central-icons/` for a fitting glyph before reaching
anywhere else. Enforced in CI: Biome's `noRestrictedImports` rule (see
`biome.json`) fails `pnpm check` on any `lucide` / `lucide-react` import.

**Exceptions.** Platform-native symbols in a native target with an accepted ADR
are the only exception. If a web glyph is missing, add it to the central-icons
set rather than importing another library.
