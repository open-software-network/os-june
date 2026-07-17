# Hermes upstream v2026.6.19

## Pin

- Previous June pin: `v2026.6.5`, commit `3c231eb3979ab9c57d5cd6d02f1d577a3b718b43`
- New June pin: `v2026.6.19`, commit `2bd1977d8fad185c9b4be47884f7e87f1add0ce3`
- Archive checksum: `7a9bd367066183898831c2760f269368ab54b458a1d1b51d14ef1f484dd490cc`
- Upstream changelog: `https://github.com/NousResearch/hermes-agent/compare/v2026.6.5...v2026.6.19`

## June compatibility patch

The upstream pin remains unchanged. June applies the deterministic
`june-approval-v1` patch set before building the bundled runtime and before
finishing a managed runtime install. See
[ADR 0025](adr/0025-targeted-hermes-approval-protocol.md).

The patch preserves MCP `RequestContext.request_id`, derives an opaque stable
approval id, and coalesces a still-pending logical request retried after an MCP
transport reconnect without merging separate requests on one live transport.
It bounds queue entries, reconnect aliases, completed requests, and completed
sessions; adds targeted `approval.respond`; and emits targeted
`approval.expire` events on timeout and disconnect. Missing identity, malformed
responses, notification failure, queue overflow, timeout, and disconnect fail
closed. Existing command/code approvals derive targeted identity from their
turn/tool-call context, so non-MCP approval behavior is preserved.

The patcher in `src-tauri/src/hermes/apply_june_patches.py` accepts only these
exact source states:

| File | Upstream SHA-256 | Patched SHA-256 |
| --- | --- | --- |
| `tools/approval.py` | `e31abc88357afa28c05f3a4753ea9908b540b0dfef8dab2fa62960ae19a63c85` | `56e88034ebcac8cff8c579c56345e4cb3fe2fe597360687d40b68daefd402e3d` |
| `tools/mcp_tool.py` | `3f0aca90d076a1b0aa5daffd7bb39b0d1a4fee83265f855e68d556e5c8a29d01` | `48a2fddfee5d5a8c33723e27639907e9f2cf062c82e7beeb844f457e6a372cfa` |
| `tui_gateway/server.py` | `1743cec5c6684651d2b7cb18b7b73a37ea99538a4f56bcd8476700ce23d4f01a` | `41197c75c3aee760a05a8ecdce4daa3d0ca7f62b34486f29a21f097086a4ef4e` |

Both macOS and Windows bundlers apply the same patch, write `PATCHSET`, verify
the patched hashes after relocation, and run
`scripts/hermes-approval-patch-smoke.py`. Managed installs record the upstream
commit and patch set separately in `runtime.json`; the bridge verifies the
patched source hashes before launch.

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
- Decide whether upstream dashboard profile builder and Skills Hub browsing should remain hidden behind June-native settings or become first-class June surfaces. (Resolved for profiles in JUN-145/JUN-210: profiles are a first-class June-native settings surface — list, switch, delete, create — with new sessions following the active profile; see ADR 0028. Skills Hub browsing remains open.)

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
  `session.create`, `session.active_list`, session-scoped model `config.set`
  (4009 busy is retried, but only acceptance passes), `session.interrupt`. A local
  `/v1/models` stub validates a switch from the configured model to an alternate
  listed model; no model tokens are spent.
- Approval patch smoke (during macOS and Windows bundle self-test): duplicate
  delivery, distinct concurrent requests, targeted approval and denial,
  replay, timeout, malformed identity, bounded overflow, and disconnect drain.
- Model smoke (opt-in): set `HERMES_SMOKE_MODEL=1` and ensure the runtime config
  has a real provider key. This adds a minimal no-tool `prompt.submit` and waits
  for a completion. It costs provider tokens, so it is off by default.

Environment variables:

- `JUNE_HERMES_COMMAND`: explicit development override for an absolute path to
  a `hermes` binary. Production resolution otherwise accepts only a verified
  June-bundled or June-managed runtime and fails closed instead of using an
  unpatched user-local or `PATH` fallback. The standalone smoke still probes
  common developer-local installs when the override is unset.
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
against the new bundled runtime (point `JUNE_HERMES_COMMAND` at the extracted
binary, or run it inside the build that bundles it) BEFORE flipping any matrix
entry to `supported`. The Node version must support `--experimental-strip-types`
(Node 22.6+; CI pins Node 22).

This is a required step in the feature 20 upgrade checklist.
