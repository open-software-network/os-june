# June P3A — implementation plan

> Engineering companion to [`telemetry-p3a-prd.md`](./telemetry-p3a-prd.md).
> Read the PRD first; its "What is never collected" section is a hard
> constraint on every design choice below.

## Architecture at a glance

```
┌──────────────── desktop (os-june) ────────────────┐
│ feature code ──► p3a::record(Question::…)         │
│                    │ (no-op unless consented)     │
│                    ▼                              │
│   local counters (sqlite, never leaves device)    │
│                    │ weekly epoch rollover        │
│                    ▼                              │
│   bucketize ──► one POST per question, jittered,  │
│                 NO auth header, no cookies        │
└────────────────────┬──────────────────────────────┘
                     ▼
        June API  POST /v1/p3a/reports   (TEE, attested)
          validate against catalog, reject unknown/extra
                     │ forward, never persist
                     ▼
        os-platform  p3a_aggregates (Postgres)
          UPSERT counter++, raw report discarded
          k>=50 suppression at read; 12-month prune
                     ▼
              Grafana dashboards (iac/ stack)
```

Three properties fall out of this shape:

- **Content firewall is type-level.** The report struct contains only a
  question enum, a bucket index (`u8`), a platform enum, a version-series
  string matched against `^\d+\.\d+\.x$`, and an ISO-week string. There is
  no field a transcript could travel in. `#[serde(deny_unknown_fields)]`
  on the server closes the other direction.
- **Unlinkability by transport.** One question per request, randomized
  send times across the epoch, no auth, no cookies. The server cannot
  reassemble an install's answer set. (This mirrors Brave, which submits
  each answer separately for exactly this reason.)
- **Nothing durable exists but aggregates.** June API is already a
  stateless proxy; os-platform stores only `(question, epoch, platform,
  version, bucket) -> count`.

### Why this trust model and not client-side crypto (STAR/Constellation)

Brave layers STAR/Constellation threshold encryption on top so that even
their server can't read an answer unless >= 50 identical answers exist.
That is the right end state, but it needs a randomness server, threshold
aggregator, and epoch key infrastructure — disproportionate at June's
scale. Our interim equivalent: ingestion runs inside the same Intel TDX
TEE as June API, so "validate, aggregate, discard" is part of the attested
image users can already verify via `/verify`. Constellation-style
encryption is Phase 4, gated on volume that makes k >= 50 routine.

## Phase 0 — consent + catalog (no network)

Ships the PRD's "Release N". Nothing is sent; everything is inspectable.

### Desktop: consent flag (Rust-side, durable)

Copy the `providers/mod.rs` persisted-settings pattern exactly:

- New `src-tauri/src/p3a/mod.rs`:
  - `P3aSettings { enabled: bool, consent_version: u32, consented_at_week: Option<String> }`
    persisted to `p3a-settings.json` in `app_config_dir()`.
  - Managed `Mutex<P3aSettings>` registered in `lib.rs` `setup(app)`.
  - Commands `p3a_settings()` and `set_p3a_enabled(bool)` in
    `commands.rs`. Disabling deletes local counters in the same call —
    "off means off" is one transaction, not two steps.
- Consent lives Rust-side (not localStorage) because the sender is Rust
  and must not depend on a webview being open; frontend mirrors it via the
  command + a `june:p3a` CustomEvent, same pattern as
  `src/lib/rampart-privacy.ts`.

### Desktop: question catalog as code

- `src-tauri/src/p3a/questions.rs`: a `Question` enum with, per variant:
  stable wire id (`general.active-days`), bucket boundaries, cadence,
  and a doc link. Bucketization is a pure function
  `fn bucket(q: Question, raw: u64) -> u8` — trivially unit-testable.
- CI parity test: walks the enum and asserts every variant appears in
  `docs/telemetry-questions.md` with matching id and bucket labels (same
  spirit as the icon/dash lint rules — conventions enforced, not hoped).

### Desktop: UI

- `src/components/settings/PrivacySettingsSection.tsx`, new `privacy` tab
  in `SETTINGS_TABS` (`AppSettings.tsx:172`). Toggle + explanation + link.
  Model the section on `AgentSettingsSection.tsx` (rampart toggle is the
  house precedent for a privacy control).
- Onboarding: one new step in `src/components/onboarding/`, unchecked by
  default, per PRD copy rules.

### Docs

- `docs/telemetry-questions.md` (public catalog, human-readable).
- `PRIVACY.md` at repo root (currently missing) summarizing the device-local
  contract and linking the catalog.

**Exit criteria:** toggle persists across restarts; disabled state
verified to make zero network calls (wiremock test asserting no requests);
catalog CI test green.

## Phase 1 — record, report, aggregate

### Desktop: local counters

- sqlite migration `src-tauri/migrations/010_p3a_counters.sql`:
  `p3a_counters (question_id TEXT, epoch TEXT, raw_value INTEGER, PRIMARY
  KEY (question_id, epoch))` + repository in `src-tauri/src/db/repositories.rs`.
  Raw values stay local forever; only bucket indexes go on the wire.
- `p3a::record(question)` / `p3a::record_value(question, v)`: cheap, sync
  signature, internally fire-and-forget; **no-op before consent check**.
  Call sites (all Rust, where the events already flow):
  - dictation session completed → `dictation.rs`
  - recording completed + audio source mode → recording finalize path in
    `commands.rs` / `audio/`
  - agent session started → `hermes_bridge.rs`
  - model/privacy-mode selection → `providers/mod.rs`
  - app foreground day → `lib.rs` setup / focus handler
  - Frontend-originated signals (onboarding completed) go through one
    tauri command `p3a_record(question_id: String)` that hard-validates
    the id against the enum and accepts **no value argument** — the
    webview can only tick predefined counters, never send content.

### Desktop: scheduler + transport

- Background task (tokio, spawned in `setup`): on launch and every ~4h,
  compute current ISO week; for any completed epoch with counters, build
  reports, then send each with an independent random delay spread over
  the following hours. Send-once bookkeeping per (question, epoch);
  failures retry next wake with cap, then drop (data loss is acceptable,
  linkability is not).
- Dedicated `reqwest::Client` in `p3a/transport.rs`, **separate from
  `june_api.rs`'s client**: no auth header, no cookie store, no custom
  UA beyond the default. Keeping it a different module makes "telemetry
  must never borrow the authenticated client" reviewable at a glance.
- Wire format:

```json
POST {JUNE_API_URL}/v1/p3a/reports
{ "schema": 1, "question": "dictation.sessions", "bucket": 2,
  "platform": "macos", "version_series": "0.0.x", "epoch": "2026-W28" }
```

- Kill switches: HTTP 410 per question → mark retired locally; global
  `p3a.enabled=false` served from June API config → client stops sending
  entirely (checked once per epoch).

### June API: ingestion (mirrors the issue-reports pipeline end to end)

Per house style (seven-crate split, `ApiResponse<T>` envelope, figment
config, no breaking `/v1/*` changes — additive only):

- `crates/domain`: `P3aReport`, `P3aQuestionDef`, catalog with bucket
  arity per question (shared source of truth for validation).
- `crates/api/src/handlers/p3a.rs`: `POST /v1/p3a/reports`, wired in
  `crates/api/src/lib.rs` `router()`. **Unauthenticated** (an OS Accounts
  bearer would deanonymize the report — the absence of `authenticated_user`
  here is load-bearing; comment it). `#[serde(deny_unknown_fields)]`,
  1 KiB body limit, reject unknown question / out-of-range bucket with
  422. Returns 202 with empty body.
- Rate limiting by IP in-memory (tower layer), and the tracing layer for
  this route configured to log **no IP and no body** — audit
  `tracing-subscriber` setup in `crates/app`.
- `crates/services`: `P3aSink` trait; `crates/providers/src/p3a.rs`:
  `OsPlatformP3aSink` forwarding to os-platform with the app key,
  best-effort with drop-on-failure (copy `issue_reports.rs` shape,
  including the structured-log fallback).
- `crates/config`: `[p3a]` figment section (`enabled`, `sink_url`,
  killed question ids) in `config.toml`, env-overridable via `JUNE__P3A__*`
  so kill switches need no rebuild (config is part of the attested chain —
  a privacy plus).

### os-platform: storage + dashboards

- Migration: `p3a_aggregates (question_id TEXT, epoch TEXT, platform TEXT,
  version_series TEXT, bucket SMALLINT, count BIGINT, PRIMARY KEY (...))`
  with snake_case + CHECK constraints per house style.
- Ingest endpoint (app-key auth, June API is the only caller):
  `INSERT ... ON CONFLICT ... SET count = count + 1`. The request is the
  entire retention of the raw report.
- Read API / Grafana datasource applies `HAVING count >= 50` (published
  views) and a nightly prune of epochs older than 12 months.

**Exit criteria:** end-to-end rstest + wiremock integration tests (house
style: real Postgres for os-platform, wiremock for June API's sink);
manual verification that a consenting debug build produces exactly one
request per question per epoch and a non-consenting build produces zero.

## Phase 2 — remote question catalog

Question definitions graduate from compiled-in constants to a served
catalog, following the `/v1/models` pattern (server definitions override
local defaults at boot):

- `GET /v1/p3a/questions` on June API, defined in `config.toml`, figment-typed.
- Client fetches at startup, intersects with its compiled enum: the server
  can **retire or re-bucket** questions without a desktop release, but can
  never introduce a question the shipped binary doesn't know — new
  questions still require an app update and a catalog-doc PR. This keeps
  "the code you can read is the ceiling of what's collected" true, which
  matters more than remote-add convenience. (Also required practically:
  the updater endpoint is immutable per build, ADR 0001.)

## Phase 3 — publish aggregates

Quarterly public roll-up (PRD success metric): a small generator in
os-platform exporting suppressed aggregates to a public JSON/markdown
artifact. No new collection.

## Phase 4 (deferred) — cryptographic aggregation

Adopt STAR/Constellation-style threshold encryption (or randomized
response for any future sensitive boolean) once volume sustains k >= 50
per cell organically. Tracked as a design doc, explicitly out of scope
now; the wire format's `schema` field exists so this can version cleanly.

## Test plan summary

| Layer | Test |
|---|---|
| Bucketization / epoch math | pure-fn unit tests, `src-tauri` |
| Consent gating | wiremock: zero requests when disabled; counters wiped on disable |
| Content firewall | type-level (struct has no string content fields) + serde reject tests for extra fields |
| Catalog/doc parity | CI test: enum ⇄ `telemetry-questions.md` |
| June API handler | rstest: 202 happy path; 422 unknown question, bad bucket, extra field; 410 for killed ids; body-limit |
| Sink | wiremock os-platform: forward shape, drop-on-failure, no retry storm |
| os-platform | real-Postgres repo tests: upsert increment, prune job, k-suppression view |
| Release gate | debug-build manual run: observe requests with mitmproxy; confirm no auth header, no cookies, one request per question |

## Sequencing and estimate

| Phase | Scope | Estimate |
|---|---|---|
| 0 | consent flag + UI + catalog + docs | ~3-4 days |
| 1 | client pipeline + June API endpoint + os-platform aggregates + dashboards | ~1.5-2 weeks |
| 2 | remote catalog | ~2-3 days |
| 3 | public roll-up | ~2 days, quarterly thereafter |

Phases 0 and 1 can land as separate PRs per the repo's additive-`/v1/*`
rule; nothing here blocks or is blocked by other in-flight work.

## Review checklist for every future P3A change

- [ ] New question has a PRD-linked decision it informs
- [ ] Buckets are the coarsest that still answer the question
- [ ] `telemetry-questions.md` updated in the same PR (CI enforces)
- [ ] No new wire fields; if unavoidable, schema version bumped + PRD amended
- [ ] Grafana cell suppression still >= 50 for the new dimension
