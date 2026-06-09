# Making the Agent feel like Notes

_A vibes audit and a prioritized plan to converge the agent surfaces on the
calm, simple visual language of Notes. Written to steer T2–T4._

## Why Notes feels calm

Notes was built iteratively, and the git history reads like a series of small
"make it quieter" passes (`UI pass: sidebar hide/resize, all-notes parity…`,
`Restyle dictation page, add reusable empty state…`, `Add recording consent
reminder`). The result is a surface with a handful of deliberate properties:

1. **One card, no nesting.** The whole reading/writing area lives in a single
   inset card — `.main-panel` (`src/styles/app.css:2267`) — that floats inside
   the native window with `--r-window`, `--shadow-sm` + `--shadow-inset`, and a
   margin that matches the traffic-light strip. There is no card-inside-a-card.

2. **A centred reading column.** Everything lines up on the shared
   `--content-max` (760px, stepping up on large displays). The note editor
   (`.note-editor`, `app.css:2395`) is `max-width: var(--content-max)` and
   `margin: 0 auto` with generous `--sp-10` top padding. Content is never
   stranded edge-to-edge.

3. **The writing surface is borderless and ring-free.** `.note-title` /
   `.note-body` explicitly kill focus outlines and box-shadows
   (`app.css:90-101`). Typing feels like paper, not a form. The one piece of
   chrome — the overline — is "quiet metadata": plain date text, a single
   actionable folder chip, a 2px dot separator (`app.css:2418-2436`).

4. **Soft edges instead of hard rules.** Long content dissolves behind top/
   bottom gradient fades (`.main-panel::before/::after`, `app.css:2307`) rather
   than hitting a hard scroll boundary or a divider line.

5. **Reusable empty states, sentence case, tokens.** A shared `EmptyState`
   component, sentence-case labels everywhere (CLAUDE.md), and sizes/colours/
   motion drawn from `tokens.css`. Nothing hand-coded.

6. **Structural icons are outlined `central-icons`.** Per CLAUDE.md, ambient/
   structural UI uses the outlined set; filled icons are reserved for primary
   action surfaces (the recorder).

The throughline: **low chrome, one surface, centred column, quiet metadata,
soft edges, shared tokens.**

## Where the Agent diverges

The agent (`src/components/agent/AgentWorkspace.tsx`, `.agent-*` rules from
`app.css:218`) was built feature-first — Hermes bridge, sessions, tool events,
skills/messaging panels — and the chrome accreted along the way. Concretely:

1. **Card-in-a-card.** `.agent-workspace` already sits inside `.main-panel`,
   then re-wraps its content in `.agent-main` / `.agent-task-rail`, each with
   its _own_ `border`, `--r-md`, and `background: var(--card)`
   (`app.css:232-238`). A bordered box inside the floating card reads busier
   and heavier than any Notes view.

2. **Its own width, not the shared column.** `.agent-workspace` is
   `width: min(100%, 1120px)` with `padding: var(--sp-8) var(--sp-6)`
   (`app.css:220-230`) instead of `--content-max`. Chat lines run much wider
   than note text, so the two views don't line up and the agent feels more
   "dashboard" than "document".

3. **Chat-app bubbles.** User turns are filled primary bubbles pinned right
   (`.agent-message[data-role="user"]`, `app.css:1008`); assistant turns are
   bordered cards. Notes has no bubbles — it's a single editorial column. The
   bubble metaphor imports a messaging-app feel that clashes with the calm
   document feel.

4. **A persistent safety banner.** `SafetyPanel` (`AgentWorkspace.tsx:1429`)
   renders a bordered "Autonomous private mode" card at the _top of every
   timeline, every session_. It's a card with an icon and two lines of body
   copy that never changes — exactly the kind of standing chrome Notes avoids.

5. **Leaky technical status.** The empty/idle header shows
   `Hermes bridge running on ${port}` and "Setting up the local agent
   runtime…" (`AgentWorkspace.tsx:1130-1135`). Notes never surfaces transport
   detail. This is engineer-facing text on a user surface.

6. **Hard dividers and pill tabs.** `.agent-detail-header` and
   `.agent-composer` use solid `1px` `border-bottom`/`border-top`
   (`app.css:246-253`, `1452-1458`); the panel switcher is a bordered pill
   (`.agent-panel-tabs`). Notes leans on fades and whitespace instead of rules.

7. **`lucide-react`, not `central-icons`.** The agent imports `BotIcon`,
   `WrenchIcon`, `SendIcon`, etc. from `lucide-react`
   (`AgentWorkspace.tsx:1-15`). The rest of the app's structural UI uses the
   outlined `central-icons` set (CLAUDE.md). Two icon families in one app is a
   subtle but real divergence.

8. **A thinner empty state.** The idle state is an `EmptyState` buried below a
   header that already says "Agent", so the screen says "Agent" twice and the
   call-to-action ("Use New Session in the sidebar…") points the user
   _elsewhere_ instead of letting them just start typing — unlike "New note",
   which drops you straight onto a blank page.

## Prioritized changes to converge them

Ordered by calm-per-effort. Each is a small, reversible slice.

### P0 — remove standing chrome (cheapest, biggest calm win)

- **Drop the inner card borders/backgrounds.** Let `.agent-main` inherit the
  `.main-panel` surface instead of drawing its own box. Removes the
  card-in-a-card. _(T2)_
- **Demote the SafetyPanel.** Don't render a full bordered card at the top of
  every timeline. Options, most→least reversible: collapse to a single quiet
  one-line affordance shown once per session / move it behind an info icon in
  the header / show it only in the empty state. Start with the one-liner.
  _(T2)_
- **Replace leaky status text** ("Hermes bridge running on port…", "Setting up
  the local agent runtime…") with calm, user-facing copy or nothing. _(T2/T4)_

### P1 — match the reading column and writing surface

- **Adopt `--content-max`** for the chat column so agent text lines up with
  note text, and swap the bespoke `1120px`/`--sp-8 --sp-6` for the note
  editor's centred, generously-padded rhythm. _(T2)_
- **Soften the user turn.** Drop the filled right-pinned bubble for a quieter
  treatment that reads as one column (a subtle label + plain text, or a very
  soft `--surface-subtle` fill, no hard border). _(T2)_
- **Trade hard dividers for fades/whitespace** on the header and composer to
  match `.main-panel`'s gradient edges. _(T2)_

### P2 — entry/empty state and status, the Notes way

- **Make "new session" feel like "New note":** land on a calm, single-surface
  empty state whose primary affordance is _the composer itself_ (start
  typing), not a pointer to a sidebar button. Don't say "Agent" twice. _(T4)_
- **Sidebar run status:** show the existing `BrailleSpinner`
  (`src/components/BrailleSpinner.tsx`) only on running sessions, idle shows
  nothing; keep the spinner `aria-hidden` with the real status in text. This
  mirrors how Notes keeps ambient indicators quiet. _(T3)_

### P3 — polish, only if time allows

- **Unify iconography** toward outlined `central-icons` for the agent's
  structural UI (rails, headers, file tree), reserving any filled icons for
  genuine primary actions. Lower priority because it's broad and mechanical;
  do it behind the higher-value calm wins. _(later)_

## Guardrails while converging

- Reuse `tokens.css` and existing Notes classes/components before inventing.
- Keep `agent-chat-runtime`, `agent-workspace`, `app-settings`,
  `dictionary-settings`, and `style-settings` tests green.
- Sentence case for every label touched.
- Small, atomic commits — one calm idea each.
