# Hermes upgrade checklist

The step-by-step gate for bumping the pinned Hermes runtime. June bundles a
specific Hermes build and makes honest, tested claims about what it supports
(the compatibility matrix, feature 16). A pin bump can silently break those
claims, so every bump runs this checklist before the release ships.

Work top to bottom. Nothing flips to `supported` on the matrix until the
fixture replay and the live smoke test both pass against the new runtime.

The concrete tools this checklist drives:

- `pnpm test` runs the fixture replay (feature 05) and every other unit test,
  including the version-agreement helper (`src/lib/hermes-upgrade-check.ts`).
- `pnpm test:hermes-smoke` runs the release-gate smoke test against a live
  runtime (feature 17).
- `pnpm hermes:upgrade-check` asserts the matrix, the pin note, and this
  checklist all name the same Hermes version, and prints this checklist's
  manual gates as a reminder.
- The compatibility matrix lives in
  `src/lib/hermes-control-plane/compatibility/matrix.ts`; its
  `PINNED_HERMES_VERSION` constant is the single source of truth every doc must
  agree with (feature 16).
- The replay fixtures and their regeneration steps live in
  `src/lib/hermes-control-plane/fixtures/README.md` (its "On Hermes upgrade"
  section, feature 05).

## Version

Pinned Hermes version: `v2026.6.19`.

This is the version `PINNED_HERMES_VERSION` in
`src/lib/hermes-control-plane/compatibility/matrix.ts` records and
`docs/hermes-upstream-v2026.6.19.md` pins. `pnpm hermes:upgrade-check` fails if
these three drift apart.

On a bump, set the new version here, in the matrix constant, and in a new pin
note (copy `docs/hermes-upstream-template.md` to
`docs/hermes-upstream-v<version>.md`), then re-run `pnpm hermes:upgrade-check`.

## Runtime start command

Confirm June still launches the new build the same way (the smoke test asserts
this against a live runtime):

```text
hermes dashboard --no-open --host 127.0.0.1 --port <port>
```

If upstream changed the dashboard command or its flags, update
`src-tauri/src/hermes_bridge.rs`, the smoke test's
`buildHermesDashboardArgs` helper in `src/lib/hermes-smoke/helpers.ts`, and its
unit test together. The smoke test will fail to start otherwise.

## REST surfaces

Re-confirm every dashboard REST endpoint June consumes still exists on the new
build. The authoritative list is in the pin note's "Compatibility checked"
section (`docs/hermes-upstream-v2026.6.19.md`). For each endpoint:

- still present and unchanged: no action.
- changed shape: update the June caller and its test.
- removed: triage as a gap (see "Known gaps") and decide whether June degrades
  gracefully or the bump is blocked.

## WS / JSON-RPC surfaces

Confirm the JSON-RPC WebSocket at `/api/ws?token=...` still frames requests and
events the way June expects. The wire details June depends on (token shape, ws
url, status url, request/response framing, binary discovery) are pinned as pure
helpers in `src/lib/hermes-smoke/helpers.ts` and unit-tested in
`src/test/hermes-smoke.test.ts`. Run `pnpm test` to catch a framing change, and
`pnpm test:hermes-smoke` to catch a behavior change against the live runtime.

## New methods/events (gateway method + event catalog diff)

Diff the upstream gateway method catalog and event catalog against the previous
pin (start from the upstream changelog link in the pin note). For each new or
changed item:

- new control-plane method June might call: add a typed wrapper in the control
  plane and a matrix `methods` entry (start it `planned` or `unsupported`).
- new event family: extend `events.ts`, teach `event-classifier.ts` to classify
  it, add a matrix `events` entry, and add a replay fixture (see the fixtures
  README). An event that classifies as `unsupported` but should be modeled is a
  gap.
- removed method/event June relied on: triage as a gap and decide on graceful
  degradation.

## June compatibility matrix diff

Re-audit every entry in
`src/lib/hermes-control-plane/compatibility/matrix.ts` honestly against the new
build:

- a surface is `supported` only when June both handles it AND ships UI/flow for
  it with tests.
- newly added upstream surfaces start as `planned` or `unsupported`, never
  `supported`.
- add any new method, event, or feature key the bump introduces, with a
  rationale and a `since` of the new pin.
- update `PINNED_HERMES_VERSION` to the new pin so the matrix, the pin note, and
  this checklist agree (`pnpm hermes:upgrade-check`).

## Fixture replay status

Revisit the replay corpus first, so a wire change surfaces as a deliberate diff
instead of a silent drop. Follow the "On Hermes upgrade" steps in
`src/lib/hermes-control-plane/fixtures/README.md`:

1. Re-capture each event family against the new Hermes; update `frames` and bump
   `hermesVersion` on every touched fixture.
2. Run `pnpm test`. Any newly failing expectation is a real wire change to
   triage: model it (extend `events.ts`, update the expected kind) or accept it
   as benign and update the fixture.
3. Route any event that now classifies as `unsupported` but should be modeled to
   its owning feature, and record it under "Known gaps".
4. Add a fixture for any brand new event family the bump introduces.

Record the outcome here: `pnpm test` green against refreshed fixtures, plus any
fixture added or retired.

## Smoke test status

Run the release-gate smoke test against the NEW bundled runtime before flipping
any matrix entry to `supported`:

```text
pnpm test:hermes-smoke
```

Point `SCRIBE_HERMES_COMMAND` at the extracted binary, or run it inside the
build that bundles it. The protocol phase needs no provider key; set
`HERMES_SMOKE_MODEL=1` (with a real provider key in the runtime config) to also
run the model-costing `prompt.submit` phase. See the pin note's "Release-gate
smoke test" section for the full environment and skip behavior.

Record the outcome here: protocol phase pass, and model phase pass if it was
run.

## Security notes (secrets/auth/sandbox)

Re-check the security posture against the new build:

- secrets and auth: confirm the bearer token still gates `/api/status` and
  `/api/ws`, that secret-bearing events still classify with the value redacted,
  and that no secret leaks into the trace or React state (the replay leak
  canaries in `src/test/hermes-control-plane-replay.test.ts` cover this for the
  fixtures; re-capture them if the wire changed).
- sandbox: confirm the macOS write-jail still scopes agent writes to June's data
  directory and that home-folder skills stay read-only. Note any new upstream
  capability that could escape the sandbox.
- dependency and installer changes: note any upstream security bump or installer
  change that affects how June extracts or patches the runtime.

## Product exposure decisions (missing upstream features → planned/unsupported decision)

For each upstream feature the runtime now ships that June does not expose,
record an explicit decision and reflect it on the matrix:

- `planned`: June intends to build the surface; a later feature owns it. Note
  the rough plan.
- `unsupported`: June deliberately will not expose it. Note why.

Carry forward the pending decisions from `docs/hermes-upstream-v2026.6.19.md`
("Additional June integration work") and resolve or restate each: Photon
iMessage setup UI, Raft profile and wake-event mapping, WhatsApp Cloud
credentials, Automation Blueprints vs the Routines editor, inline rendering of
edited `image_generate` output, and whether the dashboard profile builder and
Skills Hub browsing become first-class June surfaces.

## Known gaps

List every surface that is present upstream but not honestly `supported` in
June after this bump: removed endpoints June degraded around, events that
classify as `unsupported`, and features held at `planned`/`partial`. This is the
running gap list the matrix points at. Each gap names its owning feature or a
follow-up task.

## Release note copy

Draft the user-facing release note for the runtime change. Sentence case, no
dashes, plain hyphens for ranges. Cover only what users can actually rely on
from June UI (matrix `supported`), not raw upstream capabilities June has not
exposed. Keep it short and concrete, for example:

> Updated the bundled agent runtime to Hermes v2026.6.19. Background subagents
> now show per-agent progress in the activity drawer, and you can attach an
> imported image to an agent turn.

## CI guard

A repository CI guard for this invariant is documented, not wired as a workflow
step today, to keep this process feature low-risk and self-contained (it adds no
new always-on job to every PR). The guard is the script itself.

To enforce drift in CI, add one step to the existing frontend test job that runs
after install:

```yaml
- name: Hermes version agreement
  run: pnpm hermes:upgrade-check
```

`pnpm hermes:upgrade-check` exits non-zero (with a per-doc message) when
`PINNED_HERMES_VERSION`, the pin note `docs/hermes-upstream-v<version>.md`, and
this checklist do not all name the same version, so a pin bump that forgets the
matrix, the note, or this checklist fails the build. Until that step is wired,
run `pnpm hermes:upgrade-check` locally as the last step of this checklist.
