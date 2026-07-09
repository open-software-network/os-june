# Scroll fades

**Rule.** A scrollable region that clips its content uses the shared scroll-fade
primitive — the `useScrollFade` hook (`src/lib/use-scroll-fade.ts`) plus the
`.scroll-fade` or `.scroll-fade-mask` CSS utility. Never hand-roll a new fade
(local `useState({ top, bottom })` + an `updateFade` callback, or bespoke
`::before`/`::after` overlays or `mask-image` rules keyed off `data-fade-*`).

**Why.** Eight components had each re-derived the same measurement logic
(`scrollHeight - clientHeight > 1`, `scrollTop <= 1`, ...) and two near-identical
CSS recipes. One primitive keeps the measurement, the WKWebView-safe overlay
technique, and the fade sizing consistent, and means a fix lands once instead of
in nine places.

**How to apply.** Point `useScrollFade(ref)` at the scroll viewport's ref. Spread
the returned `props` (`data-fade-top` / `data-fade-bottom`) onto the element the
fade paints on, and add the matching class:

- `.scroll-fade` — contained gradient overlays for popovers/menus. Put the class
  and `props` on a non-scrolling wrapper; the scroller is its child. Tune with
  `--scroll-fade-size`, `--scroll-fade-color`, `--scroll-fade-inset-right`.
- `.scroll-fade-mask` — `mask-image` fade for large panel scrollers. Put the
  class and `props` on the scroller itself. Tune with `--scroll-fade-size`.

The hook owns the scroll and resize listeners (and the initial measure), so you
do not wire an `onScroll` handler — just spread `{...fade.props}` on the fade
element and pass the `ref` to the scroller. Call `fade.update()` only from an
effect that changes the content or size without a scroll or resize (filtering a
list, opening a panel).

**Exceptions.**

- `ComposerEditor` writes `data-fade-*` directly inside its ProseMirror update
  and deliberately drops the fades during a range selection — it drives
  `.scroll-fade` without the hook. Keep that logic; don't force it onto
  `useScrollFade`.
- The sidebar notes-nav fade renders *outside* the scroller (so the scrollbar
  stays untouched), a different structural need than the shared overlay.
- Scroll-timeline-driven card-edge fades (CSS `animation-timeline: scroll(...)`)
  are a pure-CSS effect with no measurement, unrelated to this primitive.
