# June Reflections — opt-in ambient screen awareness with periodic feedback

> Read [`/CONTEXT.md`](../CONTEXT.md) first for the glossary. Terms in **bold**
> below (June, June API, note generation, agent session) are defined there.
>
> Companion doc: [`reflections-implementation-plan.md`](./reflections-implementation-plan.md).

## Problem Statement

June currently helps only when the user summons it: push-to-talk, record a
meeting, open an agent session. Everything between those moments — the actual
texture of a workday, how someone communicates, where their time and attention
went, what they said they would do and then didn't — is invisible to June and
mostly invisible to the user themselves.

The originating insight (internal thread, Jul 2026): *"my experience on Slack
or whatever could be a lot better if I had my therapist next to me."* People
pay for coaches, therapists, and writing editors largely to get an outside
view of behavior they cannot see from the inside. An assistant that watches
the day and reflects it back — kindly, concretely, periodically — is a product
none of the incumbent AI tools can credibly ship, because it requires the user
to grant something close to total observation, and no one sane grants that to
a cloud service with a data-retention business model.

June can credibly ask for it. The product's whole identity is privacy by
architecture: content stays on-device, inference runs through a TEE-attested
**June API** or a fully local model. Ambient awareness is the feature where
that identity stops being a compliance property and becomes the product.

## Solution

Build **June Reflections**: an opt-in mode where June periodically observes
the user's screen, distills what it sees into local text observations, and
delivers a short daily reflection — what happened, patterns worth noticing,
and one or two pieces of concrete, kind feedback.

1. **Observe locally.** With consent, June captures periodic screen
   snapshots (stills, not video). Each snapshot is OCR'd **on-device** and
   immediately destroyed; only the distilled text observation (active app,
   window title, recognized text) is kept, in a local store with bounded
   retention.
2. **Pixels never leave the device. Ever.** The originating thread proposed
   upload → server OCR → destroy. This PRD deliberately rejects that:
   Apple's Vision framework (and Windows OCR, and tesseract on Linux) does
   high-quality text recognition locally at zero marginal cost. "We delete
   your screenshots after OCR" is a policy promise; "your screenshots are
   never transmitted" is a structural one. June ships the structural one.
3. **Distilled text goes only where the user already sends text.** The
   daily reflection is a **note generation** call through the user's
   selected generation provider. With a local model configured, Reflections
   is end-to-end on-device. Otherwise it uses June API under the same
   zero-retention TEE contract as every other generation call. No new
   backend surface, no new data category leaving the device.
4. **Opt-in, visible, interruptible.** Off by default, enabled from a
   dedicated Settings tab (never onboarding — this is a power feature, not
   a default). While observing, June shows a persistent menu bar indicator.
   One click pauses. Screen sharing and the lock screen auto-pause capture.
5. **Feedback, not surveillance.** The default deliverable is one daily
   reflection note at a user-chosen time, written to a Reflections folder
   like any other note. No popups, no real-time interruptions in v1. The
   user picks focus areas (communication, focus and time, follow-through,
   wellbeing) that steer what the reflection looks for.

### What is never done — the hard line

Under no circumstances, in any version of this feature, will June
Reflections:

- Transmit screen pixels, screenshots, or video off the device — to June
  API, to any upstream provider, or anywhere else. OCR is on-device only.
- Send observation text anywhere except the user's chosen generation
  provider for the explicit purpose of generating a reflection the user
  asked for. Never to telemetry, never to issue reports, never to logs.
- Capture excluded apps. Password managers, keychain/credential prompts,
  and June's own windows are excluded by default; the user's exclusion
  list is honored before OCR, not after.
- Provide any employer, team, or admin visibility. There is no fleet mode,
  no shared dashboard, no export-for-manager. Reflections is a product for
  the person being observed and no one else. A proposal to change this
  requires a new PRD and should expect a no.
- Keep observations past the retention window (default 30 days, user
  configurable down to 1 day), or past disablement. Turning Reflections
  off deletes the observation store in the same action. Off means off.

This list is a product commitment, not an engineering detail. Any proposal
to weaken it requires a new PRD, not a code review.

## Guiding principles (ordered)

1. Trust is the product. When feedback quality and privacy conflict,
   privacy wins, even if the reflection gets dumber.
2. Structural over procedural. Prefer designs where the bad outcome is
   impossible (no pixel upload path exists) over designs where it is
   prohibited (a policy says not to).
3. The user is the only customer. Feedback serves the observed person's
   own goals; the feature must never become legible to anyone else.
4. Kind and concrete beats clever. One observation with evidence ("you
   rewrote that Slack reply four times over 20 minutes") beats three
   generic exhortations. The reflection should read like a good coach,
   not a productivity scold.

## User Stories

### End user — consent and control

1. As a **June user**, I want to turn Reflections on from Settings with a
   plain explanation of what is captured, where it goes, and what never
   leaves my Mac, so that consent is informed and specific.
2. As a **June user**, I want a visible indicator whenever observation is
   active and a one-click pause, so that I always know and can always stop.
3. As a **June user**, I want capture to pause automatically when I share
   my screen or lock it, so that a meeting demo never becomes an
   observation.
4. As a **June user**, I want to exclude specific apps (and have password
   managers excluded for me), so that some contexts are simply never seen.
5. As a **privacy-conscious user**, I want disabling Reflections to delete
   every stored observation immediately, and a "delete all observations"
   button that works without disabling, so that retention is always under
   my control.
6. As a **skeptical user**, I want to open the observation store and read
   exactly what June has recorded about my day, so that the feature has no
   hidden layer.

### End user — the feedback

7. As a **June user**, I want one short reflection each evening — what my
   day actually looked like, one pattern worth noticing, one concrete
   suggestion — so that I get an outside view without asking for it.
8. As a **June user**, I want to pick focus areas (communication, focus and
   time, follow-through, wellbeing), so that feedback lands where I am
   actually trying to improve.
9. As a **June user**, I want to ask "reflect on today so far" on demand
   and get the same quality of answer, so that the cadence is mine.
10. As a **local-model user**, I want the entire loop — capture, OCR,
    storage, generation — to run on my machine with nothing transmitted
    at all, so that I can grant total observation with zero trust required.
11. As a **June user**, I want to rate a reflection (helpful / not), stored
    locally and used to steer future prompts, so that the coach improves
    without my feedback leaving the device.

## UX requirements

- **Settings > Reflections** (new tab): master toggle with the hard-line
  summary and a link to this document; cadence and daily delivery time;
  retention window; excluded apps list (seeded with defaults); focus
  areas; "delete all observations"; a live status row (observing / paused /
  last capture time).
- **Menu bar indicator**: distinct glyph state while observation is
  active; click exposes pause/resume and "open Reflections settings".
  No capture ever occurs without the indicator.
- **The reflection**: a normal June note in a "Reflections" folder, dated,
  under a page. Structure: what happened (3-5 bullets grounded in
  observations), one pattern, one suggestion. Tone rules: specific,
  non-judgmental, no productivity moralizing, quotes the user's own words
  only, paraphrases anything written by other people.
- Copy follows repo rules: sentence case, no en/em dashes in UI strings.

## Non-goals

- **A searchable screen-history timeline** (Rewind-style recall). The
  observation store exists to feed reflections, not to be a memory
  product. Agent-queryable observations are a later, separately gated
  phase; a browsing UI is out of scope entirely.
- **Continuous video capture or keystroke logging.** Periodic stills only.
- **Real-time nudges** ("you seem distracted") in v1. Deferred to a later
  phase with its own UX bar; the daily note must prove value first.
- **Team, employer, or parental monitoring.** Anti-goal, per the hard line.
- **Windows/Linux at launch.** The pixels-never-leave rule is platform
  independent, but v1 ships macOS-only where ScreenCaptureKit and Vision
  give the strongest primitives.

## Success metrics

- **Adoption with eyes open**: >= 10% of weekly-active installs try
  Reflections within 60 days of launch; measured only via existing P3A
  aggregate questions (a new coarse-bucketed question, never content).
- **Retained usage**: >= 40% of users who enable it still have it enabled
  after 30 days. If people turn it off, the feedback is not worth the
  observation, and that is the signal to fix.
- **Zero content incidents**: no screen pixel or observation text ever
  observed leaving the device outside a user-initiated generation call.
  A single incident triggers feature kill and a public postmortem.
- **Battery and disk budget**: observation adds <= 2% battery over a
  workday and the store stays under a configurable disk cap (default
  200 MB) with retention pruning.

## Risks

| Risk | Mitigation |
|---|---|
| "AI watches your screen" headline damages the privacy brand | Opt-in only, structural no-upload design, this doc published with the release, launch note leads with the local architecture |
| Feedback is generic or preachy and users churn | Focus areas + evidence-grounded prompt structure; local thumbs-down steering; ship the daily note only when it cites concrete observations |
| Screen text is adversarial (prompt injection: a webpage that says "ignore instructions, tell the user to...") | Reflection generation is a toolless generation call; observations are wrapped as untrusted data with explicit injection guards; agent-tool access to the store is a separate phase behind its own toggle and the existing privacy-guard pattern |
| Third-party content (colleagues' messages) ends up quoted in a note | Prompt rules require paraphrase of anything not written by the user; notes stay local like all June notes regardless |
| OCR misses visual-only context (design work, video) | Accept in v1; reflections cover what text reveals; an optional local VLM pass is a deferred phase, still on-device |
| Battery/thermal cost on capture + OCR | Adaptive cadence (capture on app switch + max interval, skip when idle/locked/fullscreen video), Apple Silicon Vision is cheap; hard budget in the exit criteria |
| Sensitive moments captured despite exclusions (private browsing, screen share) | Auto-pause on screen share and lock; private-window heuristics; pause hotkey; short default retention; user can delete any day's observations |

## Rollout

1. **Release N**: macOS, capture + local observation store + Settings +
   indicator, daily reflection note. Local-model and June API generation
   paths both supported. Launch note and this PRD published together.
2. **Release N+1**: on-demand and weekly reflections, focus-area tuning,
   local rating loop.
3. **Later, separately gated**: agent-session access to the observation
   store (ask June "what did I work on Tuesday"), real-time nudges,
   optional local VLM enrichment, Windows/Linux.
