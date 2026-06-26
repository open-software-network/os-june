# Hermes upstream v2026.6.19

## Pin

- Previous June pin: `v2026.6.5`, commit `3c231eb3979ab9c57d5cd6d02f1d577a3b718b43`
- New June pin: `v2026.6.19`, commit `2bd1977d8fad185c9b4be47884f7e87f1add0ce3`
- Archive checksum: `7a9bd367066183898831c2760f269368ab54b458a1d1b51d14ef1f484dd490cc`
- Upstream changelog: `https://github.com/NousResearch/hermes-agent/compare/v2026.6.5...v2026.6.19`

## Compatibility checked

June still starts Hermes through:

```text
hermes dashboard --no-open --host 127.0.0.1 --port <port>
```

The upstream dashboard still exposes the API surfaces June consumes:

- `GET /api/sessions`
- `POST /api/sessions`
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

The upstream installer still leaves bare `$UV_CMD` invocations in a few install stages. June's post-extract patch remains required for app data paths containing spaces, such as `Application Support` on macOS.

## Features included in the runtime update

These capabilities are present in the bundled Hermes runtime after the pin bump. June does not necessarily expose each capability in first-party UI yet.

- Background subagents: `delegate_task(background=true)` can return a handle immediately and let work re-enter the conversation later.
- Image editing: `image_generate` supports image-to-image and editing flows in addition to text-to-image generation.
- Memory batch writes: the memory tool supports atomic operation batches through an `operations` array.
- Messaging expansion: upstream adds Photon Spectrum iMessage support, an official WhatsApp Business Cloud API adapter, richer Telegram Bot API 10.1 messages, and Raft agent network gateway support.
- Automation Blueprints: upstream adds guided, parameterized routine setup so users do not need to write cron syntax directly.
- Model and dashboard improvements: upstream adds dashboard profile builder flows, stronger dashboard auth, a composer model selector, xAI Grok Composer model support, Skills Hub browser updates, subagent watch windows, per-thread drafts, resizable terminal improvements, and desktop notification improvements.
- Reliability and security: upstream includes dashboard auth hardening, fail-closed policy fixes, secret redaction, environment sanitization for cron subprocesses, Windows ConPTY and PowerShell installer fixes, and dependency security bumps.
- Cost behavior: upstream changes curator defaults to reduce auxiliary model spend for routine background curation unless extra consolidation is explicitly enabled.

## Additional June integration work

No required app code migration was found for the existing June agent, skills, messaging settings, session list, or routines flows. The following upstream features need explicit June product integration before users can rely on them from June UI:

- Expose Photon iMessage only after adding setup UI for `hermes photon login`, device-code auth, and any account state or failure recovery copy.
- Expose Raft only after mapping `RAFT_PROFILE`, bridge lifecycle, and metadata-only wake events into June's session and notification model.
- Expose WhatsApp Cloud only after adding app-scoped credential fields and validating webhook or send-message setup paths.
- Expose Automation Blueprints by deciding how they fit with June's Routines editor instead of routing users to raw cron fields.
- Expose image editing by wiring existing file/image attachments into the upstream `image_generate` edit inputs.
- Expose background subagent watch handles by adding UI for pending work, completion events, and reopened sessions.
- Decide whether upstream dashboard profile builder and Skills Hub browsing should remain hidden behind June-native settings or become first-class June surfaces.

## Compatibility matrix

June keeps a machine-readable compatibility matrix at
`src/lib/hermes-control-plane/compatibility/`. It records, per pinned Hermes
version, which control-plane methods are wired into UI, which classified events
render, and which first-party feature surfaces exist. Query it through
`isHermesFeatureSupported(feature)` and `getFeatureStatus(feature)`.

The matrix `hermesVersion` MUST match this note's pin (`v2026.6.19`). On every
Hermes pin bump:

1. Update `PINNED_HERMES_VERSION` in `compatibility/matrix.ts` to the new pin.
2. Re-audit every entry honestly: a surface is `supported` only when June both
   handles it and ships UI/flow for it with tests. Newly added upstream surfaces
   start as `planned` or `unsupported`, never `supported`.
3. Add any new method, event, or feature key the bump introduces.

## Release-gate smoke test

The static matrix above records what June claims to support. The smoke test
proves the claim against a live runtime. It launches Hermes exactly as the app
does (`hermes dashboard --no-open --host 127.0.0.1 --port <port>`), polls
`/api/status` with the bearer token, connects `/api/ws?token=...`, and runs a
minimal JSON-RPC checklist.

Run it locally or in release CI:

```text
pnpm test:hermes-smoke
```

Two phases, gated independently:

- Protocol smoke (default; no provider key): start, status, ws connect,
  `session.create`, `session.active_list`, `command.dispatch /model` (accepted
  or a known controlled error), `session.interrupt`. No model tokens are spent.
- Model smoke (opt-in): set `HERMES_SMOKE_MODEL=1` and ensure the runtime config
  has a real provider key. This adds a minimal no-tool `prompt.submit` and waits
  for a completion. It costs provider tokens, so it is off by default.

Environment variables:

- `SCRIBE_HERMES_COMMAND`: absolute path to a `hermes` binary. Highest priority
  (mirrors the Rust override). When unset, the script probes the same
  user-local venv locations the bridge falls back to.
- `HERMES_SMOKE_MODEL=1`: also run the model-costing `prompt.submit` phase.
- `HERMES_SMOKE_TIMEOUT_MS`: per-step RPC timeout (default 120000).
- `HERMES_SMOKE_READY_MS`: readiness-wait budget (default 45000, matches the
  bridge `READY_TIMEOUT`).
- `HERMES_SMOKE_KEEP_HOME`: keep the throwaway `HERMES_HOME` for inspection.

Skip behavior: when no Hermes binary is found, the script prints
"Hermes runtime not found, skipping." and exits 0. That keeps it safe on
developer machines and on PR CI (which has no bundled runtime). A failed phase
exits 1 and writes a `hermes-smoke-failure-<timestamp>.log` artifact.

The pure helpers it relies on (token shape, ws-url and status-url construction,
the dashboard arg vector, JSON-RPC request/response framing, binary discovery)
live in `src/lib/hermes-smoke/helpers.ts` and are unit-tested in
`src/test/hermes-smoke.test.ts`, so `pnpm test` stays green with no runtime.

On a Hermes pin bump (feature 20 checklist), run `pnpm test:hermes-smoke`
against the new bundled runtime (point `SCRIBE_HERMES_COMMAND` at the extracted
binary, or run it inside the build that bundles it) BEFORE flipping any matrix
entry to `supported`. The Node version must support `--experimental-strip-types`
(Node 22.6+; CI pins Node 22).

This is a required step in the feature 20 upgrade checklist.
