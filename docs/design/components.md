# Design components

The shared UI primitives and the canonical answer for each recurring pattern.
Companion docs: [foundations.md](foundations.md) (tokens and type),
[conventions.md](conventions.md) (naming and interaction rules), and
[taste.md](taste.md) (the sensibility behind the rules).

Live examples render in the styleguide: run `pnpm dev`, then open
`http://localhost:1421/styleguide.html` (sections `buttons`,
`selection-controls`, `feedback`, `inputs`, `overlays`, `settings-pattern`,
`chat-pattern`).

## Pattern to canonical answer

| Pattern | Canonical | Avoid |
|---|---|---|
| Primary / secondary action | `primary-action` family | `btn btn-primary` (legacy) |
| Icon-only action | `icon-button` | hand-rolled 28px buttons |
| Text input | `dialog-input` in `DialogField` | bespoke input classes |
| Toggle | `Switch` | bespoke toggle CSS |
| Select / dropdown picker | `Select` | native `<select>`, hand-rolled |
| Chip / badge | `ModelPrivacyChip` recipe | ad-hoc badge markup |
| Tooltip | `HoverTip` | native `title` |
| Modal | `Dialog` / `ConfirmDialog` | hand-rolled overlays |
| Exclusive option switch | `SegmentedControl` | ad-hoc tab rows |
| Back / breadcrumb navigation | `BackButton`, `BreadcrumbBar` | bespoke back affordances |
| Empty state | `EmptyState` | inline "nothing here" markup |
| Inline warning | `InlineNotice` | ad-hoc warning rows |
| Loading | `Spinner` | raw dot markup |
| Shimmering "working" text | `.shimmer` + a semantic class | hand-rolled `color: transparent` gradients |

Primitives live in `src/components/ui/*.tsx`.

## Buttons

`primary-action` is the canonical family, used by the `Dialog` and
`ConfirmDialog` footers: `primary-solid` is the filled variant and
`primary-destructive` the destructive one. `icon-button` (and
`icon-button-destructive`) covers 28px icon-only actions. `BrandPrimaryButton`
(`src/components/ui/BrandPrimaryButton.tsx`) is reserved for onboarding hero
moments.

- Don't copy the legacy `btn btn-primary` / `btn-secondary` / `btn-ghost`
  family into new work; it is a parallel legacy set.
- There is no `Button` React component yet, only the CSS families. A shared
  abstraction is pass-2 work (see below).

## Text inputs

The closest thing to canon is `dialog-input` used inside `DialogField` (label +
hint), from `src/components/ui/Dialog.tsx`. The scattered bespoke input classes
(`settings-secret-input`, `mcp-add-input`, ...) are deviations pending a shared
field treatment (pass-2 work).

## Toggles

Always the `Switch` component (`src/components/ui/Switch.tsx`). Never hand-roll
toggle CSS.

## Selects and dropdown pickers

The `Select` component (`src/components/ui/Select.tsx`): smart placement and
keyboard navigation come with it.

## Chips and badges

`ModelPrivacyChip` (`src/components/ui/ModelPrivacyChip.tsx`) is the reference
recipe: a `variant` prop paired with a `HoverTip`. The TipTap composer chips
(category, note reference) are their own thing and not covered here.

## Tooltips

`HoverTip` (`src/components/ui/HoverTip.tsx`), never the native `title`
attribute.

## Modals and drawers

`Dialog` and `ConfirmDialog` (`src/components/ui/Dialog.tsx`,
`ConfirmDialog.tsx`): both portal out and trap focus. Drawers (agent activity,
skills hub) are bespoke slide-ins and are fine as-is.

## Menus and popovers

Hand-rolled today (sidebar identity menu, context menus, composer `@` / slash
menus). Dismiss behavior (close on outside pointer press or Escape, listeners
gated on open) is standardized in `src/lib/use-dismiss.ts`; positioning is still
hand-rolled and a shared positioning helper is flagged future work. Rule of
thumb: one ambient shadow per popover composite (see
[conventions.md](conventions.md)).

## Empty and loading states

`EmptyState` (`src/components/ui/EmptyState.tsx`) for empty views. `Spinner`
(`src/components/ui/Spinner.tsx`, wraps `DotSpinner`) for loading. Inline
warnings use `InlineNotice` (`src/components/ui/InlineNotice.tsx`) with
`data-tone="warning"` or `"destructive"`; full-width banners are a separate
treatment.

## Shimmer

`.shimmer` (`src/styles/shimmer.css`, imported by `app.css`) is the canonical
sweep for "this text is working" states: thinking labels, image-generation and
transcription progress, first-load skeleton bars. It is a vendored plain-CSS
port of the shadcn shimmer utility, kept API-compatible with upstream, so its
knobs (`--shimmer-duration`, `--shimmer-spread`, `--shimmer-angle`,
`--shimmer-color`) tune per call site.

- **Pair it with a semantic class**, don't use it alone. `.shimmer` owns only
  the sweep; the semantic class owns color, layout, and typography, e.g.
  `<span className="text-shimmer shimmer">Thinking…</span>` or
  `transcript-processing-label shimmer`.
- **The base is `currentColor`**: the element must carry a real `color` (call
  sites use `var(--muted-foreground)`). Never set `color: transparent`; the old
  hand-rolled shimmers did, and that makes this recipe paint nothing.
- **It degrades gracefully.** The paint is gated behind
  `@supports (color: oklch(from red l c h))` and honors
  `prefers-reduced-motion`, so unsupported engines and reduced-motion users keep
  the solid, legible label. Dark mode brightens the highlight via
  `[data-theme="dark"] .shimmer`.
- **The HUD shimmers are separate.** `hud.css`, `agent-hud.css`, and
  `meeting-hud.css` mirror the same geometry as their own bands rather than
  importing `.shimmer`; keep them visually in step with `shimmer.css` if you
  retune it.

## Settings surface contract

The settings markup nests like this:

```
settings-group                       (section)
  settings-group-heading             (h2, muted; + optional settings-group-description)
  settings-card
    settings-rows
      settings-row                    (settings-row-compact for the dense variant)
        settings-row-info
          settings-row-title          (h3)
          settings-row-description     (optional p)
        settings-row-control
      settings-row-error              (p below the row, for errors)
```

## Not yet systematized

Pass-2 work, tracked here honestly so new code doesn't over-fit to the current
state:

- A shared `Button` React component (only CSS families exist today).
- A shared text-input / field component (bespoke input classes remain).
- A shared menu / popover positioning helper (menus are hand-rolled).
