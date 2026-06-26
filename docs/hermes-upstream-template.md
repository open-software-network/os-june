# Hermes upstream v<NEW_VERSION>

Copy this file to `docs/hermes-upstream-v<NEW_VERSION>.md` on a Hermes pin bump
and replace every `<...>` placeholder with the real value. Keep the section
order: `pnpm hermes:upgrade-check` and the upgrade checklist both read against
this shape. Sentence case, no dashes, plain hyphens for ranges.

The filename version and the `v<NEW_VERSION>` in the first heading MUST match
`PINNED_HERMES_VERSION` in `src/lib/hermes-control-plane/compatibility/matrix.ts`.

## Pin

- Previous June pin: `v<OLD_VERSION>`, commit `<OLD_COMMIT_SHA>`
- New June pin: `v<NEW_VERSION>`, commit `<NEW_COMMIT_SHA>`
- Archive checksum: `<SHA256_OF_BUNDLED_ARCHIVE>`
- Upstream changelog: `https://github.com/NousResearch/hermes-agent/compare/v<OLD_VERSION>...v<NEW_VERSION>`

## Compatibility checked

June still starts Hermes through:

```text
hermes dashboard --no-open --host 127.0.0.1 --port <port>
```

The upstream dashboard still exposes the API surfaces June consumes (confirm
each against the pinned build; remove any that upstream dropped and triage them
as a gap):

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

Note any installer or runtime patch June still needs after extraction (for
example, app data paths containing spaces such as `Application Support` on
macOS). State whether the patch is still required or can be dropped.

## Features included in the runtime update

List the capabilities the bundled runtime gains with this pin. June does not
necessarily expose each capability in first-party UI yet; the matrix and the
checklist record which it does.

- `<capability>`: `<one-line description from the upstream changelog>`
- ...

## Additional June integration work

Record any required app code migration found for the existing June agent,
skills, messaging settings, session list, or routines flows (or state that none
was found). Then list the upstream features that need explicit June product
integration before users can rely on them from June UI:

- `<feature>`: `<what June must build first, e.g. setup UI, credential fields, wake-event mapping>`
- ...

## Compatibility matrix

June keeps a machine-readable compatibility matrix at
`src/lib/hermes-control-plane/compatibility/`. It records, per pinned Hermes
version, which control-plane methods are wired into UI, which classified events
render, and which first-party feature surfaces exist. Query it through
`isHermesFeatureSupported(feature)` and `getFeatureStatus(feature)`.

The matrix `hermesVersion` MUST match this note's pin (`v<NEW_VERSION>`). On
every Hermes pin bump:

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

Run it against the new bundled runtime BEFORE flipping any matrix entry to
`supported`:

```text
pnpm test:hermes-smoke
```

See `docs/hermes-upstream-v2026.6.19.md` for the smoke test's two phases
(protocol vs model), its environment variables, and its skip behavior.

## Version agreement

Run the version-agreement check to confirm the matrix, this pin note, and the
upgrade checklist all name `v<NEW_VERSION>`:

```text
pnpm hermes:upgrade-check
```

It exits non-zero with a per-doc message if any of the three drift.
