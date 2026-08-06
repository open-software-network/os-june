# Clovy telemetry

Clovy telemetry is optional product telemetry. It helps Open Software understand
which parts of Clovy are used, without collecting recordings, notes, transcripts,
prompts, responses, or user identifiers.

Telemetry is off by default. You can turn it on during onboarding or later in
Settings > General. You can turn it off at any time.

## Current status

When telemetry is enabled, Clovy increments counters on your device for the
public questions in [`telemetry-questions.md`](./telemetry-questions.md). Clovy
uploads anonymous event increments as those actions happen. Reports are grouped
by ISO reporting week, but the report does not include a precise event
timestamp. Turning telemetry off deletes the local counters and reporting
state.

The team can see aggregate counts only. Raw device counters stay local, and OS
Accounts stores only aggregate cells after Clovy API validates and forwards a
report. The local counter includes a retry cursor so failed uploads can be
retried without sending successful increments again.

## What Clovy never collects through telemetry

Clovy telemetry must never collect:

- Recordings, audio, transcripts, notes, note titles, or generated note text.
- Prompts, model responses, chat messages, or anything you or Clovy writes.
- File names, file paths, URLs, web searches, or visited pages.
- Email address, OS Accounts user id, account balance, subscription state, or
  billing activity.
- Device id, install id, cookies, advertising identifiers, or durable user
  identifiers.
- Free-form text fields, hashes of content, embeddings, excerpts, or other
  derived content.
- Fine-grained timestamps. Reports are grouped by reporting week.

## What Clovy can count

Telemetry answers only a small public catalog of product questions. The current
shipping questions count events such as onboarding completion, dictation
sessions, agent sessions, and meeting recordings. Future state questions may use
coarse buckets instead of exact values when a bucketed answer is enough.

The current catalog and buckets are documented in
[`telemetry-questions.md`](./telemetry-questions.md). The app has tests that
check the Rust question catalog against that document, so code and docs have to
change together.

## How reporting works

Each report contains one question answer:

- `schema`: telemetry schema version.
- `question_id`: one public question id.
- `bucket`: a small integer bucket index. Current event-count questions use the
  public event bucket.
- `platform`: macOS, Windows, or Linux.
- `version_series`: app version series, such as `0.0.x`.
- `epoch`: ISO reporting week, such as `2026-W28`.

The desktop request to Clovy API uses the existing OS Accounts user token so the
public Clovy API route can reject unauthenticated writes. That token is not part
of the telemetry report, is not forwarded to OS Accounts, and is not stored as
telemetry data. Reports do not include cookies, user ids, device ids, install
ids, account balance, subscription state, or billing activity.

Clovy API on Phala does not own telemetry storage. It validates each report
against the public catalog, discards the authenticated user identity, and
forwards valid aggregate reports to OS Accounts using a Clovy API service token.
OS Accounts increments aggregate counters in its database and does not attach
reports to OS Accounts users, emails, wallets, balances, subscriptions, OAuth
clients, or app records. Published or shared aggregate views must suppress small
cells so tiny cohorts are not exposed.

## Change policy

- Telemetry remains opt-in and off by default.
- New questions must be added to the public catalog before they can be counted.
- Each question must name the product decision it informs.
- Buckets must be coarse enough to avoid exact behavior tracking.
- Content, identifiers, free-form fields, billing data, and account data stay out
  of telemetry.
- If a question is wrong or too sensitive, it must be retired rather than hidden
  in implementation details.

## Related docs

- [`telemetry-questions.md`](./telemetry-questions.md): exact question catalog
  and buckets.
- [`telemetry-p3a-prd.md`](./telemetry-p3a-prd.md): product requirements.
  Written for maintainers.
- [`telemetry-p3a-implementation-plan.md`](./telemetry-p3a-implementation-plan.md):
  engineering implementation plan. Written for maintainers.
