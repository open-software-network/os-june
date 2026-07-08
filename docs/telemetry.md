# June telemetry

June telemetry is optional product telemetry. It helps Open Software understand
which parts of June are used, without collecting recordings, notes, transcripts,
prompts, responses, or user identifiers.

Telemetry is off by default. You can turn it on during onboarding or later in
Settings > General. You can turn it off at any time.

## Current status

When telemetry is enabled, June increments counters on your device for the
public questions in [`telemetry-questions.md`](./telemetry-questions.md). June
reports a finalized weekly bucket once per question after the week completes.
The onboarding completion question is reported immediately because it is a
one-time yes/no answer. Turning telemetry off deletes the local counters and
reporting state.

The team can see aggregate counts only. Raw device counters stay local, and OS
Accounts stores only aggregate cells after June API validates and forwards a
report.

## What June never collects through telemetry

June telemetry must never collect:

- Recordings, audio, transcripts, notes, note titles, or generated note text.
- Prompts, model responses, chat messages, or anything you or June writes.
- File names, file paths, URLs, web searches, or visited pages.
- Email address, OS Accounts user id, account balance, subscription state, or
  billing activity.
- Device id, install id, cookies, advertising identifiers, or durable user
  identifiers.
- Free-form text fields, hashes of content, embeddings, excerpts, or other
  derived content.
- Fine-grained timestamps. Telemetry is grouped by reporting week.

## What June can count

Telemetry answers only a small public catalog of product questions, such as
whether onboarding completed or how many dictation sessions happened in a week.
Each answer is a coarse bucket, not an exact value.

The current catalog and buckets are documented in
[`telemetry-questions.md`](./telemetry-questions.md). The app has tests that
check the Rust question catalog against that document, so code and docs have to
change together.

## How reporting works

Each report contains one question answer:

- `schema`: telemetry schema version.
- `question_id`: one public question id.
- `bucket`: a small integer bucket index.
- `platform`: macOS, Windows, or Linux.
- `version_series`: app version series, such as `0.0.x`.
- `epoch`: ISO reporting week, such as `2026-W28`.

The desktop request to June API uses the existing OS Accounts user token so the
public June API route can reject unauthenticated writes. That token is not part
of the telemetry report, is not forwarded to OS Accounts, and is not stored as
telemetry data. Reports do not include cookies, user ids, device ids, install
ids, account balance, subscription state, or billing activity.

June API on Phala does not own telemetry storage. It validates each report
against the public catalog, discards the authenticated user identity, and
forwards valid aggregate reports to OS Accounts using a June API service token.
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
