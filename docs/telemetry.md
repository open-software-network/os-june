# June telemetry

June telemetry is optional product telemetry. It helps Open Software understand
which parts of June are used, without collecting recordings, notes, transcripts,
prompts, responses, or user identifiers.

Telemetry is off by default. You can turn it on during onboarding or later in
Settings > Privacy. You can turn it off at any time.

## Current status

This release only adds consent, local settings, and local counters. No telemetry
reports are sent by this release.

When telemetry is enabled today, June can increment counters on your device for
the public questions in [`telemetry-questions.md`](./telemetry-questions.md).
Those counters stay local. Turning telemetry off deletes the local counters.

Network reporting requires a future June API ingestion release and will keep
the policies below.

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

## How reporting will work

When network reporting ships, each report will contain one question answer:

- `schema`: telemetry schema version.
- `question`: one public question id.
- `bucket`: a small integer bucket index.
- `platform`: macOS, Windows, or Linux.
- `version_series`: app version series, such as `0.0.x`.
- `epoch`: ISO reporting week, such as `2026-W28`.

Reports will not use OS Accounts authentication, cookies, user ids, device ids,
or install ids. Each question answer is sent separately so the server does not
receive a full per-install profile in one request.

June API validates each report against the public catalog. The ingestion path is
designed to increment aggregate counters and discard the raw report. Published
or shared aggregate views must suppress small cells so tiny cohorts are not
exposed.

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
