# June P3A — opt-in, privacy-preserving product telemetry

> Read [`/CONTEXT.md`](../CONTEXT.md) first for the glossary. Terms in **bold**
> below (June, June API, OS Accounts, dictation, note transcription, note
> generation, agent session) are defined there.
>
> This PRD adapts the practices behind Brave's
> [P3A (Privacy-Preserving Product Analytics)](https://support.brave.app/hc/en-us/articles/9140465918093-What-is-P3A-in-Brave)
> to June, with one deliberate departure: **P3A in June is opt-in**
> (Brave ships it on by default with an opt-out).
>
> Companion doc: [`telemetry-p3a-implementation-plan.md`](./telemetry-p3a-implementation-plan.md).

## Problem Statement

June's core promise is privacy: recordings, transcripts, notes, and agent
sessions live on-device, and inference runs through a TEE-attested **June
API**. That promise is why users choose June — and it is also why we are
flying blind as a product team:

- We do not know which features are used at all. Is dictation a daily driver
  or a demo? Do users who record meetings ever open agent sessions? Nobody
  can answer from data; we answer from anecdote and issue reports.
- We cannot measure whether a release helped. When we ship a change to
  meeting detection or the dictation popup, the only feedback channel is
  users filing issues — a signal biased entirely toward breakage.
- We cannot size platform investment. Windows and Linux support costs real
  effort; we have no idea what share of active installs they represent.

The obvious industry answer — drop in PostHog/Amplitude with a per-user ID
and an event firehose — would torch the product's reason to exist. A single
"transcript_generated" event with a user ID attached is a betrayal of the
README's privacy narrative, and our users are exactly the people who check.

The bar: learn *aggregate* product truths ("how often do consenting users
complete dictation sessions") while making it *structurally impossible* —
not policy-impossible, structurally impossible — for prompts, responses,
transcripts, notes, or any user-identifying data to leave the device
through this channel.

## Solution

Build **June P3A**: an opt-in, question-based telemetry system modeled on
Brave's P3A.

1. **Questions, not arbitrary event streams.** The product team defines a
   small, fixed, public catalog of questions. Current action questions are
   anonymous event increments ("a dictation session completed") sent as the
   action happens. Future state questions can still use coarse buckets when
   a bucketed answer is enough.
2. **Public buckets, not payloads.** Every answer is a public bucket index,
   never an exact private value and never a string. Current event-count
   questions use one public event bucket. The wire format has no free-text
   field, so user content *cannot* be encoded even by a bug.
3. **Anonymous by construction.** Reports carry no user ID, device ID, or
   install ID. The desktop request may use the existing OS Accounts user
   token to reach June API, but that token is not part of the report schema,
   is not forwarded to OS Accounts telemetry storage, and is not stored as
   telemetry data. The ingestion server aggregates into counters and
   discards the raw report.
4. **Opt-in, default off.** Telemetry is presented once during onboarding
   as an unchecked choice, and lives permanently as a toggle in Settings
   under General. Turning it off stops sending immediately and deletes any
   locally queued answers.
5. **Radically transparent.** The full question catalog, bucket definitions,
   and wire schema are published in this repo
   ([`telemetry-questions.md`](./telemetry-questions.md), created with the
   feature) and enforced by CI: a question that isn't documented does not
   compile. Ingestion runs inside the same attested TEE as June API, so the
   "aggregate and discard" behavior is part of the verifiable build.

### What is never collected — the hard line

Under no circumstances, in any version of this system, will June P3A carry:

- Prompt text, model responses, chat messages, or agent conversation
  content — in any form, including hashes, embeddings, or excerpts.
- Transcripts, notes, note titles, audio, or derived text of any kind.
- File names, file paths, URLs visited or fetched, or search queries.
- User ID, email, OS Accounts identifiers, device ID, install ID, or any
  durable identifier in the telemetry report or aggregate storage. No
  cookies. User auth is used only transiently at the June API boundary and
  is stripped before forwarding to OS Accounts telemetry storage.
- Free-form strings of any kind. The schema is enums and small integers.
- Fine-grained timestamps. Reports are grouped by reporting week.

This list is a product commitment, not an engineering detail. Any proposal
to weaken it requires a new PRD, not a code review.

## Guiding principles (ordered)

1. Trust is the product. When telemetry value and privacy conflict,
   privacy wins, even at the cost of never answering a question.
2. Collect the minimum that changes a decision. Every question in the
   catalog must name the product decision it informs. No "nice to know."
3. Aggregate or nothing. If we cannot learn something from k-anonymous
   aggregates (k >= 50 per published cell), we do not learn it.
4. Be auditable, not just honest. Open source client, published catalog,
   attested ingestion. "Trust us" is not an acceptable answer to a user.

## User Stories

### End user — consent

1. As a **first-time June user**, I want onboarding to ask me plainly
   whether to share anonymous usage statistics, defaulting to off, so that
   nothing is sent unless I chose it.
2. As a **June user**, I want a Settings toggle that shows what is shared
   with a link to the public telemetry policy and question list, so that
   consent is inspectable and revocable at any time.
3. As a **privacy-conscious user**, I want turning the toggle off to take
   effect immediately and delete anything queued locally, so that "off"
   means off.
4. As a **skeptical user**, I want to read the complete list of questions
   and buckets in the public repo, and verify via the June API attestation
   flow that the ingestion server runs the published code, so that I don't
   have to take Open Software's word for it.

### Product team — learning

5. As a **PM**, I want aggregate counts per catalog question and bucket
   (split only by reporting week, platform, and app version series), so
   that I can see feature adoption and platform mix.
6. As a **PM**, I want to compare a question's distribution before and
   after a release, so that I can tell whether a change moved usage.
7. As a **PM**, I want cells with fewer than 50 installs suppressed in
   dashboards, so that small cohorts can never be singled out.
8. As a **PM**, I want to add or retire a question through a reviewed
   change to the public catalog, so that scope creep is impossible to do
   quietly.

### Operations

9. As an **operator**, I want raw reports discarded at ingestion after
   incrementing aggregate counters, and aggregates pruned after 12 months,
   so that retention is bounded by design.
10. As an **operator**, I want a server-side kill switch per question
    (client stops sending on HTTP 410), so that a mis-designed question can
    be retired without waiting for an app update.

## Initial question catalog (v1)

Grouped by ISO reporting week. Metadata attached to every report:
platform (`macos` / `windows` / `linux`) and app version series (e.g.
`0.0.x` minor series only). Nothing else.

| ID | Question | Buckets | Decision it informs |
|---|---|---|---|
| `general.active-days` | Days June was opened this week | 0 / 1 / 2-3 / 4-5 / 6-7 | Engagement baseline for all other ratios |
| `notes.meetings-recorded` | Meeting recording completed | event | Investment in meetings pipeline |
| `notes.audio-source` | Most-used audio source this week | none / mic only / mic + system | System-audio maintenance cost (Swift helpers) |
| `dictation.sessions` | Dictation session completed | event | Dictation as flagship vs. niche |
| `agent.sessions` | Agent session started | event | Hermes runtime investment |
| `agent.privacy-guard` | Agent privacy guard mode (sampled weekly) | off / structured | Rampart default-on decision |
| `models.privacy-mode` | Most-selected model privacy mode this week | e2ee / private / anonymous | Model catalog and TEE roadmap |
| `onboarding.completed` | Onboarding completed | completed | Onboarding funnel health |
| `onboarding.use-case.work` | Onboarding interest selected: work | selected | New-user intent and activation segmentation |
| `onboarding.use-case.personal` | Onboarding interest selected: personal | selected | New-user intent and activation segmentation |
| `onboarding.use-case.school` | Onboarding interest selected: school | selected | New-user intent and activation segmentation |
| `onboarding.use-case.creative` | Onboarding interest selected: creative projects | selected | New-user intent and activation segmentation |
| `onboarding.use-case.coding` | Onboarding interest selected: coding | selected | New-user intent and activation segmentation |
| `onboarding.use-case.meetings` | Onboarding interest selected: meetings | selected | New-user intent and activation segmentation |
| `onboarding.use-case.other` | Onboarding interest selected: other | selected | New-user intent and activation segmentation |
| `onboarding.use-case.not-sure` | Onboarding interest selected: not sure yet | selected | New-user intent and activation segmentation |

Explicitly rejected for v1: anything billing-related (balance, top-ups —
too sensitive next to OS Accounts identity), country/region (population too
small to keep k-anonymity), install week (fingerprinting surface; revisit
only if retention analysis becomes critical and k >= 50 holds).

## UX requirements

- **Onboarding step**: one screen, sentence-case copy, unchecked by
  default: "Share anonymous usage statistics". Subtext states the hard
  line in one sentence ("Never your recordings, notes, or written content.
  Only anonymous counts that help us understand feature usage.") with a
  "Learn how it works" link. Declining is one click and visually equal to
  accepting.
- **Settings > General**: the toggle, the same one-sentence explanation,
  and the link to the telemetry policy. The existing agent privacy guard
  control should remain with agent settings until a broader privacy surface
  exists.
- Copy follows repo rules: sentence case, no en/em dashes in UI strings.

## Non-goals

- Per-user analytics, funnels, session replay, cohort retention curves
  keyed to installs. Structurally excluded.
- Crash reporting and error telemetry. Different problem, different
  consent, separate future PRD.
- A/B testing infrastructure. The catalog can measure before/after a
  release; it cannot and will not assign users to experiments.
- Marketing attribution (ref codes, campaign tags).

## Success metrics

- **Opt-in rate**: >= 25% of new installs consent at onboarding after 60
  days. If materially lower, the consent copy failed and we iterate on
  copy, never on the default.
- **Zero content incidents**: no report ever observed (in tests, audits,
  or ingestion validation rejects) carrying anything outside the schema.
  A single incident triggers kill-switch-all and a public postmortem.
- **Decision usage**: at least 3 product decisions per quarter cite P3A
  aggregates; questions uncited for two consecutive quarters are retired.
- **Trust cost**: no measurable dip in installs or spike in privacy-related
  issue reports attributable to launch. Launch note published alongside.

## Risks

| Risk | Mitigation |
|---|---|
| Opt-in population is biased (power users over-consent) | Treat results as directional, compare distributions not absolutes; state the caveat on every dashboard |
| Low volume breaks k >= 50 cells early on | Start with the coarsest buckets; suppress rather than publish; widen buckets before narrowing cohorts |
| "Telemetry" headline damages the privacy brand | Ship the transparency doc and blog-style launch note in the same release as the code; opt-in framing leads all copy |
| Question creep over time | Catalog changes require PRD-linked review; CI blocks undocumented questions; quarterly retirement review |
| Server compromise | Server holds only aggregates; raw reports are never persisted; ingestion is TEE-attested |

## Rollout

1. **Release N**: consent UI + immediate anonymous event increments for
   consenting users. Publish `telemetry-questions.md` and launch note.
2. **Release N+1**: dashboards internal-only until k >= 50 holds across core
   cells.
3. **Quarterly**: publish selected aggregates back to the community
   (Brave publishes its question list; we can go one better and share
   the answers).
