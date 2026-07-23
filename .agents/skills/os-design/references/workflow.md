# Standing up and iterating design work

The loop that design-featuring work follows at Open Software, from first
reference to handoff. It assumes you have already grounded in the repo's
design system (SKILL.md, "Before any pixels").

## 1. Study references, then commit

Design decisions start from pattern consensus, not invention.

- **With Mobbin** (MCP tools `search_flows` / `search_screens` /
  `search_sections`): look for how several best-in-class products solve the
  same flow, and design to the consensus, not to one screenshot. Real
  examples of the method: a trial gate designed from Mobbin patterns; an
  invite entry placed "matching Mobbin's consensus across Gopuff / PayPal /
  Vivid"; profile-switching split into identity vs workspace switching
  because "Mobbin shows the split (Confluence, Discord vs Figma, Slack)".
- **Without Mobbin**, use the house reference canon — the products whose
  patterns have repeatedly been the target in past work: **Linear** (visual
  weight, icon weight, density), **Arc** and **Figma** (chrome, switchers),
  **Claude / ChatGPT** (chat and streaming behaviors), **Codex** (developer
  surfaces), **Apple HIG** (motion physics, materials), **shadcn**
  (component anatomy). Open the real product, screenshot the pattern, and
  design against that. A reference you can screenshot beats a reference you
  remember: when a streaming-text animation felt wrong, the fix came from
  watching the reference and matching its actual batching (whole chunks
  faded together over ~1.5s), not from tweaking blind.
- Then **commit to one direction** before coding. If the shape of the
  feature is genuinely open, run a shaping pass first (impeccable `shape`,
  or a written mini-brief: what the moment is, what register it is in,
  what it must not become).

## 2. Build from blocks

- Use the canonical primitive for every covered pattern; compose new
  surfaces from tokens. Match implementation complexity to what the moment
  earns: product chrome is quiet and conventional; hero/marketing moments
  may earn more.
- Prefer adopting a primitive from the system over hand-rolling even
  mid-build — sessions repeatedly replaced hand-rolled copies with the
  shared hook/utility and deleted net lines (`useScrollFade` replaced 7
  copies; `useDismiss` deduped 5 sites).
- Classify every change as **zero-visual by construction** (renaming a value
  to the token that already renders it — lands freely) or a **visual dial to
  eyeball** (anything that changes pixels — ships small and gets looked at).
  State the classification in the handoff.

## 3. Park the state and look at it

Never judge UI from code. Get the change on screen, in both themes, in the
real rendering engine.

- **Screenshot loop:** os-june has `browser-test-tauri-fe` (drives the
  Vite frontend in a real browser, fakes the Tauri IPC bridge) and
  `agent-e2e-qa` (live click-through with video). Elsewhere use playwriter
  (the user's live Chrome tab), agentation, or a small Playwright script
  that captures light + dark snapshots.
- **State-parking drivers:** for hard-to-reach states (update cards,
  recording HUDs, empty states, image-gen progress, onboarding), add a
  dev-only console hook that seeds the state on demand —
  `window.__updateCard()`, `__seedDemo()`, `__emptyStates()`,
  `__recordingHud()` are shipped examples. Follow the existing driver
  pattern in the repo; never bundle drivers into production.
- **Preview pages** (`*-preview.html`) and the styleguide are legitimate
  parking lots for component-level work; a disposable bisect page with one
  strategy per row beats theorizing (this is how the iOS haptics question
  was settled — on device).
- Check both themes every time: dark mode shadow/contrast bugs are the most
  common visual regression.
- On mobile-reviewed repos (os-marketing-page), the review surface is the
  deployed preview on a phone: commit, push, wait for the preview check to
  pass, then ask for eyes. Mash-test interactive controls on the phone —
  rapid taps expose transition bugs that a single click never will.

## 4. Tune one dial per round

Visual weight (shadows, borders, rings, tints, weights, sizes) converges
through small iterations:

- Change **one** visual variable per round.
- **Name the dial and its next step** in the handoff: "shrunk the notch
  chin from 10px to 6px — one dial; can go to 4px if still too tall."
- Judge each round in the running app against the reference, not in the
  diff.
- A change that moves three dials at once cannot be judged at all; if a
  round accumulated multiple dials, split them.

## 5. Hand off with evidence

Handoff is where this skill ends. Do not commit, push, or open a PR unless
the user explicitly asks — the diff stays in the working tree for the user
to eyeball first, and publishing is their call. When the user does ask for a
PR, hand the tending to the repo's review loop (shepherd) and follow the
repo's PR conventions:

- Screenshots or a short recording, light and dark, attached to the PR (UI
  PRs state that the change was tested visually — os-june's PR template has
  a section for it).
- Say which dials are open to eyeball and what the next notch on each would
  be; flag "one potential nudge" if you see one.
- List deliberate deviations from the system (with why) rather than letting
  a reviewer discover them; if you voiced or learned a new taste rule
  during the work, fold it into the repo's taste doc (os-june:
  `docs/design/taste.md`) in the same change.
- Leave the work as one clean diff that can be eyeballed as a whole.
