# June API — proxy all upstream AI traffic and fully integrate OS Accounts authorize/charge

> Read [`/CONTEXT.md`](../CONTEXT.md) first for the glossary. Terms in **bold**
> below (June, June API, OS Accounts, upstream provider, dictation, note
> transcription, note generation, credit price) are defined there.
>
> Read [`/docs/os-accounts-backend.md`](./os-accounts-backend.md) for the
> historical sketch of this work — this PRD supersedes it.

## Problem Statement

A user installing June today can record meetings, get transcripts, and
generate notes — but only if **they** supply their own OpenAI and Venice API
keys in a local `.env`. The moment June is distributed as a `.app` to anyone
who isn't a developer:

- The user has no way to acquire or configure provider keys.
- Any keys we baked into the binary would be extractable — anyone running
  `strings` on the `.app` could siphon our OpenAI / Venice budget and run
  unlimited inference on our bill.
- We have **OS Accounts credits** wired up for identity and balance display
  (`os_accounts.rs`), but nothing actually charges the credits — the wallet
  reads correctly and never decrements.

The result: June cannot be shipped publicly as a paid product because there
is no safe way to bill metered AI usage from a public client. It also cannot
be used by anyone without the technical knowledge to register their own
upstream provider accounts.

## Solution

Build **June API**, a confidential backend service that:

1. Holds the OpenAI and Venice API keys (which June no longer ships).
2. Holds the OS Accounts App API key (`osk_…`) that authenticates June to OS
   Accounts as a billing-capable app.
3. Verifies every incoming request's OS Accounts access token locally
   (JWKS / ES256), extracting the **user ID** (`usr_…`).
4. For each metered call, runs the B-shaped contract: `POST /authorize` →
   call the upstream provider → `POST /charge`, deterministic
   `idempotency_key` per logical operation.
5. Returns the work result (transcript, note, cleaned text, model list) to
   June.

After this lands, June ships with **zero upstream provider keys**, every AI
call is billed against the signed-in user's OS Accounts wallet at the
configured **credit price** for the chosen **upstream model**, and the
existing "Top up credits" affordance in the Account settings becomes the only
way to fund usage. Users see "Insufficient credits → Top up" instead of a
generic provider error when they run dry. Usage credit prices pass through
upstream cost without an additional June markup.

## User Stories

### End user — first run and sign-in

1. As a **first-time June user**, I want to install the app without
   configuring any third-party API keys, so that I can get to recording within
   one minute of double-clicking the `.app`.
2. As a **first-time June user**, I want to **sign in with Open Software**
   directly from the Account settings, so that my identity and credit balance
   are tied to my OS Accounts wallet from the start.
3. As a **signed-in June user**, I want to see my current credit balance in
   the Account settings, so that I know what I can spend before recording.
4. As a **signed-in June user**, I want a one-click "Top up" button that
   opens the OS Accounts portal in my browser, so that I can buy more credits
   without leaving June's flow.
5. As a **signed-in June user**, I want my balance in the Account settings
   to refresh automatically after a successful top-up returns me to the app,
   so that I don't have to manually check whether the purchase went through.

### End user — note transcription and generation

6. As a **June user with sufficient credits**, I want to record a meeting,
   stop, and have the **note transcription** appear without seeing any error
   about provider keys, so that the recording-to-note flow feels seamless.
7. As a **June user with sufficient credits**, I want the cost of each
   transcription to be deducted from my OS Accounts balance after it
   completes, so that I pay for what I used and not for upload failures.
8. As a **June user**, I want **note generation** (turning the transcript
   into structured markdown) to also debit the same OS Accounts wallet, so
   that there is one place to see all my AI spend.
9. As a **June user with insufficient credits**, I want to see a clear
   "You're out of credits — top up to continue" message instead of a generic
   error when I try to transcribe or generate, so that I know exactly what to
   do.
10. As a **June user with insufficient credits**, the "Top up" affordance
    from the error message should take me straight to the OS Accounts portal,
    so that I'm not hunting through settings.
11. As a **June user retrying a failed network call**, I want my second
    attempt to bill me only once, so that flaky wifi doesn't double-charge me.

### End user — dictation

12. As a **June user with sufficient credits**, I want **dictation**
    (push-to-talk → cleaned-up text) to work without me supplying any
    provider key, so that dictation is usable on a fresh install.
13. As a **June user using dictation**, I want each dictation event to
    debit my OS Accounts balance, so that dictation is metered the same way
    as note transcription.
14. As a **June user using dictation**, I want the latency of dictation to
    stay tight (text appears within a fraction of a second of release), so
    that the new billing pipeline doesn't make the feature feel sluggish.
15. As a **June user**, I want to choose between OpenAI and Venice models
    for transcription in Settings exactly as today, so that the model picker
    UX is preserved.
16. As a **June user**, I want models that June hasn't priced to NOT
    appear in the picker, so that I never select an option that will fail at
    request time.

### Developer — running and contributing to June

17. As a **June developer running the app locally**, I want to point at
    either a local June API or a staging deployment via a single env var,
    so that I can test against production-shape infra without rebuilding.
18. As a **June developer**, I want to clone the repo and build both the
    Tauri client and June API from the same `git clone`, so that
    end-to-end changes are one PR.
19. As a **June developer**, I want no upstream provider keys (`OPENAI_API_KEY`,
    `VENICE_API_KEY`) anywhere in the Tauri-side `.env` or codebase, so that
    a leaked June build cannot drain our provider budgets.

### Developer — June API backend

20. As a **June API maintainer**, I want every paid request to atomically
    `authorize → upstream → charge` with a deterministic idempotency key, so
    that retries are safe and concurrent requests for the same user respect
    the wallet.
21. As a **June API maintainer**, I want the JWKS for OS Accounts cached
    in-process and refreshed only on `kid` miss, so that every request
    doesn't hammer OS Accounts.
22. As a **June API maintainer**, I want each upstream provider sitting
    behind a `Transcriber` / `Generator` / `Cleaner` trait, so that I can
    swap or add a provider without changing the orchestration code.
23. As a **June API maintainer**, I want a typed pricing table loaded from
    config, so that adding or repricing an upstream model is a config diff
    not a code change. Usage prices pass through upstream cost without an
    additional June markup.
24. As a **June API maintainer**, I want unknown models (no credit price)
    to be rejected at the API boundary with a clear error code, so that we
    never silently charge $0 or absorb unpriced usage.
25. As a **June API maintainer**, I want structured `tracing` logs with
    `usr_…`, action, model, and credits charged on every settled request, so
    that I can investigate billing disputes without re-deriving anything.

### Developer — CI and deployment

26. As a **June API maintainer**, I want PRs that touch only the Tauri
    side to NOT trigger Rust CI, so that a UI tweak doesn't run a 5-minute
    cargo build.
27. As a **June API maintainer**, I want pushes to `main` that touch
    `june-api/**` to build and publish a `:<short-sha>` image to GHCR plus
    update a `:staging` tag, so that staging always reflects what's on
    `main`.
28. As a **June API maintainer**, I want a manual workflow to re-tag an
    existing image to `:production`, so that promotion never rebuilds and
    rollback is "promote a previous SHA".
29. As an **on-call engineer**, I want June API's `/livez` to return 200
    when the process is alive and 5xx when it's not, so that Railway's
    health probe can restart a wedged container.

### OS Accounts perspective (for completeness)

30. As an **OS Accounts admin**, I want each metered call from June to
    include an action slug that distinguishes dictation from note flows
    (`dictate_transcribe`, `dictate_cleanup`, `note_transcribe`,
    `note_generate`), so that per-action billing analytics are legible.
31. As an **OS Accounts platform**, I expect June API to never call
    `/charge` without a preceding `/authorize`, to use a deterministic
    `idempotency_key` per logical operation, and to send both the App API
    key (header) and the Action token (body) on every charge, so that the
    contract holds and replays are deduped correctly.

## Implementation Decisions

### Repo layout and crate split

- **June API lives in this repo**, not a separate repo. Cargo workspace
  rooted at `june-api/` (sibling of `src-tauri/` and `src/`). One `git
  clone` for client + backend; CI workflows in the monorepo gate on
  `paths: june-api/**`.
- **Six crates, not seven.** The `june-persistence` crate from the
  `os-rust-backend` recipe is deliberately omitted — June API is
  stateless v1. If persistence is ever added, it goes in a new
  `june-persistence` crate at that time. Crates: `june-domain`,
  `june-services`, `june-providers`, `june-config`, `june-api`,
  `june-app`. Binary is named `june`.
- **Service-prefix `june`.** All library crate names start with `june-`.
  Match the convention used by `accounts-*` (`os-accounts`) and
  `fellow-*` (`os-platform`).
- **Follow `os-rust-backend` recipe** for everything not explicitly
  overridden: edition 2024, pinned toolchain `1.95.0`, workspace deps,
  workspace lints (`-D warnings`, no `unwrap`/`expect`/`panic`/`dbg`,
  `unsafe_code = forbid`), `ApiResponse<T>` envelope on every endpoint,
  `tracing` only with structured fields, no `std::env::var` outside
  `june-config`, error code bands per the standard table.

### Deep modules and their interfaces (no file paths)

- **`Transcriber` (trait, `june-domain`)** — `transcribe(audio, model) ->
  Result<Transcript, DomainError>`. Two impls in `june-providers`:
  OpenAI and Venice. Interface unchanged across upstreams.
- **`Generator` (trait, `june-domain`)** — `generate(prompt_inputs, model)
  -> Result<GeneratedNote, DomainError>`. One impl (Venice) for now.
- **`Cleaner` (trait, `june-domain`)** — `cleanup(text, context, style,
  model) -> Result<String, DomainError>`. One impl (Venice).
- **`OsAccountsClient` (trait, `june-domain`)** — `authorize(user, action,
  estimate, hold_ttl) -> Result<Authorization, _>` and `charge(token,
  credits, idempotency_key) -> Result<Receipt, _>`. One impl
  (`OsAccountsHttpClient` in `june-providers`) — HTTP, App API key
  bearer, envelope-aware, no retries beyond what the platform guarantees.
- **`TokenVerifier` (trait, `june-domain`)** — `verify(jwt) ->
  Result<UserId, AuthError>`. One impl (`JwksTokenVerifier` in
  `june-providers`) — caches JWKS in-process, refreshes on `kid` miss,
  ES256-only, strict `iss`/`aud`, `exp` with small leeway. Never trust
  the token's `alg` header; never fetch JWKS per request.
- **`PricingTable` (`june-services`)** — `price_credits(model_id, units)
  -> Result<Credits, NotPriced>`. Pure function over the config table.
  Single source of truth for credit cost. Loaded from `june-config`.
- **`WavDurationProbe` (`june-providers`)** — `probe(bytes) ->
  Result<Duration, ProbeError>`. Pure, uses the `hound` crate (already a
  workspace dep in `src-tauri`; should be added to the June API
  workspace too).
- **`NoteTranscribeService`, `NoteGenerateService`, `DictateService`
  (`june-services`)** — orchestrators. Each takes a `UserId` (from the
  verified token), resolves the **credit price** via `PricingTable`,
  computes `estimate_credits`, calls `OsAccountsClient::authorize`, calls
  the relevant `Transcriber` / `Generator` / `Cleaner`, then
  `OsAccountsClient::charge` with the actual credits and a deterministic
  `idempotency_key` derived from the logical operation. **`DictateService`
  owns both dictate transcribe and dictate cleanup** (decision: merge what
  would have been two services into one — same domain, same UX).
- **Tauri-side `june_api`** — single module exposing `transcribe`,
  `generate`, `dictate`, `dictate_cleanup`, `list_models`. Each function
  reads the OS Accounts access token from the macOS Keychain (helpers
  promoted out of `os_accounts.rs` into a shared submodule), builds a
  `Bearer <jwt>` request to `{JUNE_API_URL}/v1/…`, on `401` refreshes
  tokens via the existing refresh path and retries once, on `402` with
  `error_code: 4301` returns a typed `AppError::InsufficientCredits` the
  UI maps to the existing top-up affordance.

### Public HTTP surface

All routes prefixed with `/v1/`. All non-public responses wrapped in
`ApiResponse<T>`. All metered routes require `Authorization: Bearer
<access_jwt>`.

| Method | Path | Action slug | Body / Query | Notes |
|---|---|---|---|---|
| `POST` | `/v1/transcribe` | `note_transcribe` | multipart audio + `{title, context?, model?}` | Server probes WAV duration → authorize → upstream → charge. |
| `POST` | `/v1/generate` | `note_generate` | JSON `{title, transcript, manualNotes?, language?, existingGeneratedNote?, model?}` | Charge based on actual `prompt_tokens + completion_tokens` from upstream `usage`. |
| `POST` | `/v1/dictate` | `dictate_transcribe` | multipart audio + `{model}` | Latency-sensitive; same shape as `/v1/transcribe` but separate action slug for OS Accounts analytics. |
| `POST` | `/v1/dictate/cleanup` | `dictate_cleanup` | JSON `{text, dictionaryContext?, style, model}` | Mirrors today's `cleanup_dictation_text`. |
| `GET` | `/v1/models?type=asr\|text` | *(unmetered)* | — | Union of OpenAI + Venice models filtered to those with a configured credit price. Settings UI's source of truth. |
| `GET` | `/livez` | *(unmetered)* | — | Health for Railway. |

### Estimate strategy (server-side only)

- **Audio (`/v1/transcribe`, `/v1/dictate`):** probe WAV duration from the
  uploaded bytes via `WavDurationProbe`. `estimate = ceil(seconds ×
  credits_per_second_for(model))`. Same number for `charge` (transcription
  cost is duration-bound).
- **Text (`/v1/generate`, `/v1/dictate/cleanup`):** `estimate =
  ceil((chars/4 + max_output_tokens) × credits_per_token_for(model))`. On
  `charge`, settle with actual `prompt_tokens + completion_tokens` from
  the upstream's `usage` block.
- **Never trust a client-supplied estimate.** Lying on the estimate
  defeats the wallet hold's concurrency protection.

### Error mapping (envelope `error_code` → HTTP)

Follow the standard `os-rust-backend` bands. Notable specifics:

- OS Accounts `4301` (insufficient credits) → `402` with `error_code: 4301`.
- JWKS verify failure / missing token → `401` with `error_code: 3001`.
- Unknown model (no credit price configured) → `422` with `error_code:
  4201` (or similar in the validation band) and `message:
  "model_not_priced"`.
- Upstream provider failure (5xx, timeout, malformed body) → `502` with
  `error_code: 5001` and a redacted message — never leak the upstream's
  body verbatim.

### Idempotency key shape

Deterministic, derived from a stable per-operation identifier in June:

- `/v1/transcribe`: `note_transcribe:<usr_>:<noteId>`
- `/v1/generate`: `note_generate:<usr_>:<noteId>:<promptVersion>`
- `/v1/dictate`: `dictate_transcribe:<usr_>:<sessionId>:<utteranceId>`
- `/v1/dictate/cleanup`: `dictate_cleanup:<usr_>:<sessionId>:<utteranceId>`

The June client passes the stable identifier in the request (`noteId` /
`sessionId+utteranceId`); June API constructs the full key
server-side from the verified `usr_` + the client-supplied operation id.
Clients never compose the full key themselves.

### Configuration

June API (typed `AppConfig` in `june-config`, figment-merged from
defaults + `config.toml` + env, no `std::env::var` calls outside):

- `[server]` — `port` (Railway injects `PORT`), `request_timeout_secs`.
- `[os_accounts]` — `api_url`, `app_api_key` (`osk_…`, env-only), `iss`,
  `aud`, `jwks_refresh_secs`.
- `[upstreams.openai]` — `api_key` (env-only), `base_url`.
- `[upstreams.venice]` — `api_key` (env-only), `base_url`.
- `[pricing]` — table keyed by `model_id`, each entry `{ unit: "seconds" |
  "tokens", credits_per_unit: u64 }`. Values pass through upstream cost
  without an additional June markup. Loaded from
  `config.toml` baked into the image; `JUNE__PRICING__…` env overrides
  supported via figment for per-env tweaking.

June (Tauri client):

- `JUNE_API_URL` — baked production default in a constant; `.env`
  override supported (same model recommended for `OS_ACCOUNTS_URL` /
  `OS_ACCOUNTS_API_URL` going forward).
- `OPENAI_API_KEY`, `VENICE_API_KEY`, `OPENAI_API_BASE_URL`,
  `VENICE_API_BASE_URL`, `VENICE_DICTATION_CLEANUP_MODEL` — **removed**
  from `.env.example` and from `providers/mod.rs` accessors.

### CI (per `os-rust-backend-ci`, monorepo-adapted)

Three workflows under `.github/workflows/`:

- `june-api.yml` — PR + push to `main`, gated on `paths:
  june-api/**`. fmt, clippy, tests, OpenAPI drift (if a doc is derived).
  Never publishes.
- `build-june-api.yml` — push to `main` touching `june-api/**`, or
  manual dispatch. Builds and pushes `ghcr.io/open-software-network/june-api:<short-sha>`
  + updates `:staging`. Stops at GHCR.
- `promote-june-api.yml` — manual dispatch. Verifies an existing image,
  re-tags `:<short-sha>` to `:production`. Never rebuilds.

The two composite actions (`setup-rust`, `changed-paths`) from the skill
get added under `.github/actions/`, with `setup-rust` pointed at
`june-api/rust-toolchain.toml` and `changed-paths` configured for the
`june-api/` subdirectory.

### Tauri-side refactor

- Add `src-tauri/src/june_api.rs` with the functions listed above.
- Extract `load_tokens()` / `refresh()` out of the private API of
  `os_accounts.rs` into a shared submodule (e.g. `os_accounts::tokens`)
  so both modules use the same token storage.
- Delete `src-tauri/src/providers/transcription.rs`,
  `src-tauri/src/providers/generation.rs`, and the upstream-key accessors
  in `providers/mod.rs` (`openai_api_key`, `venice_api_key`,
  `openai_api_base_url`, `venice_api_base_url`,
  `dictation_cleanup_model`). Move the model-list shape used by
  Settings into `june_api::list_models` (or a small `model_picker.rs`
  cache if a separate cache is wanted).
- Update callers in `commands.rs` and `dictation.rs` to import from
  `june_api` instead of `providers::*`.
- Map June API `error_code: 4301` to whatever existing "insufficient
  credits" UI affordance the Account/Note flows already use (or add one
  if missing) — should open the system browser at OS Accounts via the
  existing `os_accounts_top_up` command.

### Out-of-repo prerequisites

These block all of the above:

1. Register June in the OS Accounts admin console for staging and
   production. Yields `app_id`, App API key `osk_…`, OAuth client ID
   `ocl_…` per env. Allowlist `http://127.0.0.1:8765/callback` (already
   matches `os_accounts.rs`).
2. Create Railway projects for June API staging + production.
3. Confirm GHCR `packages: write` on the GitHub Actions token for
   `ghcr.io/open-software-network/june-api`.

## Testing Decisions

### What makes a good test for this work

- **Test external behavior, not implementation details.** For June API,
  that means HTTP request/response shape, envelope contents, error codes,
  the sequence of OS Accounts calls observed at a wiremock — never "this
  function called that function".
- **No I/O in unit tests.** If a test needs HTTP, it's an integration
  test and lives in `crates/<x>/tests/`.
- **Mock externals with `wiremock`, not hand-rolled fakes.** Verifies the
  real HTTP shape, not our mental model of it.
- **Tests assert on the envelope, not just the HTTP status.** A
  successful response is `{ success: true, data: ... }`; a known failure
  is `{ success: false, error_code: 4301, message: "..." }`. Tests
  should match the same `error_code` June will branch on.

### Modules with tests in scope

- **`PricingTable` (unit, `june-services`)** — pure function over the
  config table. Cases: known model returns expected credits for a given
  unit count; unknown model returns `NotPriced`; integer overflow / very
  large unit counts handled cleanly; per-second and per-token tables
  resolved correctly when both are configured.
- **`OsAccountsHttpClient` (integration vs `wiremock`, `june-providers`)** —
  exercises the real HTTP shape against a wiremock OS Accounts. Cases:
  successful `authorize` returns a parsed `Authorization` with the
  Action token; `authorize` with insufficient balance returns
  `Authorization { allowed: false, reason: "insufficient_available_balance" }`;
  successful `charge` returns `Receipt` with `idempotent_replay: false`;
  same `charge` replayed with same key returns `idempotent_replay:
  true`; missing App API key on `charge` returns the expected error
  envelope; expired hold returns the expected error.

All other modules ship without dedicated tests at v1 — the wiremock'd
`OsAccountsHttpClient` integration covers the most error-prone
boundary, and the `PricingTable` unit tests cover the only pure logic
that materially affects user bills. Handler-level end-to-end tests can
be added incrementally as bugs surface.

### Prior art

- This repo has no Rust backend yet — no prior art in-repo for the test
  shape.
- The `os-accounts` and `os-platform` (`fellow`) repos use the same
  test stack: `rstest` for parametrization, `wiremock` for HTTP mocks,
  `pretty_assertions` for diff output, integration tests in
  `crates/<x>/tests/` per the `os-rust-backend` recipe (see
  `testing.md` in that skill). Mirror that style.

## Out of Scope

- **Streaming responses** (SSE / chunked) for `/v1/generate`. Current
  June UX is non-streaming; add later as its own feature.
- **Postgres / persistence in June API.** No DB v1; `june-persistence`
  crate not created. Idempotency dedup is provided by OS Accounts; the
  rare network-retry-causes-duplicate-upstream-call cost is accepted.
- **In-memory result cache.** Out of scope v1; consider only if observed
  retry rates make wasted upstream calls material.
- **Splitting `june-api/` into its own repo.** Monorepo is the decision
  for v1; can be hoisted out later if the repos want independent
  versioning.
- **ADRs for the architectural deviations from the `os-rust-backend`
  recipe** (no persistence crate, monorepo, baked URL defaults). User
  explicitly declined to write ADRs.
- **Async-charge optimisation for dictation.** The latency cost of two
  OS Accounts round-trips per dictation is real but tolerable; an
  optimisation (return result first, charge in the background) is a
  separate enhancement once we have telemetry to justify it.
- **Building any kind of top-up / checkout UI in June or June API.**
  Credits are granted only by OS Accounts after a verified Stripe
  webhook. Top-ups always hand off to the OS Accounts portal in the
  system browser.
- **Migrating identity off OS Accounts / supporting alternative IdPs.**
  Out of scope forever — owning identity is OS Accounts' job.
- **Resolving the `bun.lock` vs `pnpm-lock.yaml` divergence** in this
  repo. Unrelated cleanup, worth picking one source of truth but not
  blocking on it. _(Since resolved: `bun.lock` was removed and pnpm is
  the only package manager - see `spec/package-install-security.md`.)_

## Further Notes

- **Glossary alignment.** Throughout the implementation, prefer the
  vocabulary from `CONTEXT.md`: **June** (the app), **June API**
  (the backend), **OS Accounts** (the platform), **upstream provider**
  (OpenAI / Venice), **dictation** vs **note transcription** vs **note
  generation** (never "transcribe" or "generate" alone), **credit
  price** (per upstream model). Avoid: "proxy" (overloaded with
  HTTP-CONNECT), "transcribe" without qualifier, "credits" referring to
  upstream cost.
- **The seven-crate vs six-crate decision is a real deviation from house
  style** (`os-rust-backend` mandates seven). It is intentional and
  documented here; a maintainer who needs persistence later should add
  the missing crate at that time rather than wedging persistence into
  `june-services` or `june-providers`.
- **Hosting target is Railway**, alongside OS Accounts but in a separate
  Railway project for blast-radius isolation. Image is built and pushed
  by `build-june-api.yml`; deployment (how Railway picks up the new
  image) is out of scope of `os-rust-backend-ci` and owned by whoever
  configures the Railway side.
- **The June binary will bake `JUNE_API_URL` as a production
  default**, env-overridable for dev/staging. This is a small but real
  deviation from the current `os_accounts.rs` pattern (which requires
  env config and fails closed). The same change should eventually be
  made to `OS_ACCOUNTS_URL` / `OS_ACCOUNTS_API_URL` for the same reason
  — the moment June is distributed to non-developers, env-only
  configuration breaks.
- **`docs/os-accounts-backend.md` should be updated or removed** once
  this work lands; it predates this PRD and sketches what is now being
  built. Pointing it at `june-api/` and this PRD is enough.
- **The `model_picker` / Settings UI does not need server changes
  beyond the new `/v1/models` endpoint.** The existing TypeScript shape
  in `AppSettings.tsx` already iterates a flat list of model DTOs.
