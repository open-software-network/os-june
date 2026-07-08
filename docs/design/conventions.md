# Design conventions

Naming, interaction, and theming rules for working in June's stylesheet and UI.
Companion docs: [foundations.md](foundations.md) (tokens and type),
[components.md](components.md) (the shared primitives), and
[taste.md](taste.md) (the sensibility behind the rules).

Live values render in the styleguide: run `pnpm dev`, then open
`http://localhost:1421/styleguide.html`.

## Flat CSS namespace

`src/styles/app.css` is one flat, global stylesheet (~22k lines) with no CSS
modules or scoping. That has consequences:

- **Prefix classes by feature** (`settings-row-title`, `agent-rail-header`) so a
  name signals where it belongs.
- **Grep app.css before coining a class name.** A clash is silent, and with
  equal specificity the rule that appears **later** in the file wins.
- Keep specificity flat; don't win a battle with `!important` or deep selector
  chains that the next author can't reason about.

## Interaction and visual rules

- **Hover changes background only.** Never transition `border-color` on hover.
- **Default hover is neutral.** Rows, nav items, icon buttons, and other
  generic surfaces hover with `var(--sidebar-accent)` (the app's quiet grey
  wash). The brand-tinted hover `var(--brand-tint)` is a deliberate accent
  touch, spent sparingly on surfaces that already carry the accent (today: the
  chat scroll-to-latest pill and the agent hero chips). Never put it on a
  generic list row, nav item, or menu just to feel themed.
- **Shadows never carry rings.** `--shadow-sm/md/lg` are pure elevation; a call
  site composes a ring or border with `--shadow-inset` or a real 1px border.
  A ring-instead-of-border surface keeps a transparent 1px border for layout and
  adds the ring as a separate variable.
- **Dark mode has its own shadow overrides.** Light-tuned black shadows vanish on
  near-black, so `data-theme="dark"` re-tunes them.
- **One ambient shadow per popover composite.** Stacking shadows on nested
  popover layers muddies the edge.
- **Scroll edge fades use the shared primitive.** A clipped scroller melts its
  hidden edge via `useScrollFade` + `.scroll-fade` (contained gradient overlays,
  WKWebView-safe for popovers) or `.scroll-fade-mask` (`mask-image`, for large
  in-window panel scrollers only). Never hand-roll the measurement or the CSS.
  See [spec/scroll-fade](../../spec/scroll-fade.md). Note: a `mask-image` fade on
  a composited popover scroller triggers WKWebView compositing bugs — reach for
  the `.scroll-fade` overlay flavor there.
- **Icons are explicitly sized.** Use `central-icons` / `central-icons-filled`
  only (see [spec/icons-central-only](../../spec/icons-central-only.md)), always
  with the `size` prop.
- **Radius follows the element's tier, not its pixel size.** The `--r-*` scale
  maps to element classes, so pick by what the element _is_:
  - `--r-xs` (4px) — keycaps, badges, chips, pills' inner rows, and other small
    inline decorations.
  - `--r-sm` (6px) — **square icon buttons** (`.icon-button`,
    `.agent-icon-button`) and small interactive controls. A clickable icon
    square is `--r-sm`, even at 22px; don't drop it to `--r-xs` just because it
    is small — that reads as a badge, not a button.
  - `--r-md` (8px) and up — cards, inputs, popovers, dialogs, and larger
    surfaces.
  A new button should copy the radius token of the nearest existing button of
  its kind rather than eyeballing a value.

## Theming implementation

- Light and dark cascade off the `data-theme` attribute; the accent applies by
  setting the `--brand` variables. `--brand` and the chroma-capped
  `--brand-wash` are `@property`-registered so they animate; derived tokens
  (`--brand-tint`, `--brand-line`, `--warm-*`) re-mix from `--brand`
  automatically.
- Five presets (rose, clay, sage, ocean, plum; clay default) live in
  `src/lib/brand.ts` as an id-to-hex map.
- **Sync warning:** that id-to-hex map is **duplicated** in the pre-paint
  scripts of `index.html` and `styleguide.html` (so the first paint is correct
  before React boots). Change one and change the others, or the initial paint
  flashes a stale accent.

See [foundations.md](foundations.md) for the token roles the theme drives.

## The styleguide page

A dev-only living styleguide. To open it, run `pnpm dev` and visit
`http://localhost:1421/styleguide.html?section=<id>`. Foundations sections:
`color`, `type`, `spacing`, `radius`, `elevation`, `motion`, `controls`.
Components: `buttons`, `selection-controls`, `feedback`, `inputs`, `overlays`.
Patterns: `settings-pattern`, `chat-pattern`. `?theme=` and `?brand=` pick a
theme and accent per URL.

To add a section: create a new section file under `src/styleguide/sections/` and
register it in the `SECTIONS` array in `src/styleguide/sections/index.ts`. The
`?section=<id>` query parameter selects which one renders.
