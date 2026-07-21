# Hermes upstream v2026.7.20

## Pin

- Previous June pin: `v2026.6.19`, commit `2bd1977d8fad185c9b4be47884f7e87f1add0ce3`
- New June pin: `v2026.7.20`, commit `3ef6bbd201263d354fd83ec55b3c306ded2eb72a`
- Archive checksum: `335c2249b6b2e58be397e12d542788f3315ede84394c0082b339a4ddde6a27d0`
- Upstream changelog: `https://github.com/NousResearch/hermes-agent/compare/v2026.6.19...v2026.7.20`
- Upstream release: Hermes Agent v0.19.0, the Quicksilver Release

## Compatibility checked

June still starts Hermes through:

```text
hermes dashboard --no-open --host 127.0.0.1 --port <port>
```

The upstream dashboard still exposes the API surfaces June consumes:

- `GET /api/status`
- `GET /api/sessions`
- `POST /api/sessions` as a legacy fallback
- `PATCH /api/sessions/{session_id}`
- `GET /api/sessions/{session_id}/messages`
- `DELETE /api/sessions/{session_id}`
- `GET /api/skills`
- `PUT /api/skills/toggle`
- `GET /api/messaging/platforms`
- `PUT /api/messaging/platforms/{platform_id}`
- `GET /api/cron/jobs`
- `POST /api/cron/jobs`
- `PUT /api/cron/jobs/{job_id}`
- `POST /api/cron/jobs/{job_id}/pause`
- `POST /api/cron/jobs/{job_id}/resume`
- `POST /api/cron/jobs/{job_id}/trigger`
- `DELETE /api/cron/jobs/{job_id}`
- `GET /api/tools/toolsets`
- `PUT /api/tools/toolsets/{name}`
- `WS /api/ws`

The session messages endpoint now accepts `limit` and `offset` and returns a
`pagination` object. Omitting `limit` still returns the complete message list,
so June's request and response normalization remain compatible.

The `sessions` and `messages` tables and the fields June reads directly from
`state.db` remain compatible. Hermes 0.19 consolidates additional gateway
routing metadata into the same database without removing those fields.

The upstream installer still has bare `$UV_CMD` calls in its venv, sync, and
pip installation stages. June's post-extract quoting patch remains required for
app data paths containing spaces, such as `Application Support` on macOS.

## Gateway catalog diff

Hermes 0.19 keeps every JSON-RPC method June calls. It adds learning, project,
pet, subscription, usage, verification, one-shot LLM, and
`session.context_breakdown` methods. June tracks the context breakdown as
planned and deliberately leaves Nous subscription methods unsupported because
June uses Open Software accounts.

Hermes 0.19 also adds `message.interim`, `moa.reference`, `moa.aggregating`,
`tool.output_risk`, `reaction`, `terminal.close`, `turn.start`, and `turn.error`
events. June classifies and renders `message.interim` as a sealed assistant
segment so later completion text cannot overwrite mid-turn commentary. The
other new families are recorded in the compatibility matrix as planned or
unsupported and continue through the sanitized unsupported-event path.

## Features included in the runtime update

These capabilities are present in the bundled runtime after the pin bump. June
does not necessarily expose each capability in first-party UI yet.

- Faster first turns and streaming: upstream reports about an 80 percent cold first-token latency reduction and streams reasoning by default.
- Durable background delegation: subagent transcripts can be watched live and background completion delivery survives process restarts.
- Smart approvals and deny rules: model-reviewed approvals are enabled upstream by default, with user-defined hard deny rules.
- Password manager secret sources: Bitwarden and 1Password can supply runtime secrets without plaintext environment files.
- Session data tools: export supports Markdown, Quarto, HTML, prompt-only, and trace formats with optional secret redaction.
- Model controls: Fireworks AI and DeepInfra are first-class providers, new frontier models are cataloged, and reasoning effort adds max and ultra tiers with per-model overrides.
- Subscription controls: Nous users can inspect and change plans from Hermes interfaces.
- Gateway reliability: final messaging responses use a durable delivery ledger, and one multiplexed gateway can route channels to isolated profiles.
- Security hardening: credential scoping, shared guarded media reads, webhook body limits, token redaction, and CI input hardening landed upstream.

## Additional June integration work

One required app migration was found and implemented: June now handles the new
default `message.interim` event as a typed, sealed transcript segment. No other
required code migration was found for the existing skills, messaging settings,
session list, session hydration, or routines flows.

The following upstream surfaces need explicit June product integration before
users can rely on them from June UI:

- Add context inspection UI before exposing `session.context_breakdown`.
- Decide whether tool risk dispositions and smart approvals belong in June's explicit approval flow. June currently keeps human approval cards.
- Add vault connection, unlock, and provenance UI before exposing Bitwarden or 1Password secret sources.
- Add export format, scope, and redaction controls before exposing session export.
- Add Mixture of Agents transcript treatment before rendering `moa.*` events.
- Add reasoning effort controls before advertising max, ultra, or per-model overrides.
- Keep Nous subscription controls hidden because June uses Open Software billing.
- Carry forward the 0.17 decisions for Photon iMessage, Raft, WhatsApp Cloud, Automation Blueprints, inline edited-image output, the profile builder, and Skills Hub browsing.

## Compatibility matrix

June keeps a machine-readable compatibility matrix at
`src/lib/hermes-control-plane/compatibility/`. It records, per pinned Hermes
version, which control-plane methods are wired into UI, which classified events
render, and which first-party feature surfaces exist. Query it through
`isHermesFeatureSupported(feature)` and `getFeatureStatus(feature)`.

The matrix `hermesVersion` matches this note's pin (`v2026.7.20`). New 0.19
surfaces begin as planned or unsupported unless June already handles them with
shipping UI and tests.

## Fixture replay

The existing sanitized replay corpus remains labeled `v2026.6.19` because it
was captured from that runtime. It is intentionally not relabeled without a
new live capture. Unit replay verifies those frames still classify under the
0.19 adapter, and focused tests cover the new `message.interim` wire shape.
The live merge QA also confirmed Hermes emits `reasoning.available` as a
complete fallback reasoning payload. June classifies it and replaces any
partial streamed reasoning, matching Hermes' first-party clients.

Verification result: `pnpm test` passed all 1,258 tests (2 skipped).

## Release-gate smoke test

Run the protocol phase against the newly installed bundled runtime:

```text
JUNE_HERMES_COMMAND=/absolute/path/to/hermes pnpm test:hermes-smoke
```

The protocol phase verifies dashboard startup, authenticated status, WebSocket
connection, `session.create`, `session.active_list`, model dispatch behavior,
and `session.interrupt`. The optional model phase remains gated behind
`HERMES_SMOKE_MODEL=1` because it requires a configured provider and spends
tokens.

Verification result: the protocol phase passed against a throwaway install of
the exact pinned archive. The provider-backed model phase was not run because
that isolated runtime had no provider credentials.

## Release note copy

> Updated June's bundled agent runtime to Hermes 0.19. Agent responses start
> faster, and mid-task updates now stay visible while June verifies its work.
