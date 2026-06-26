# Hermes replay fixtures

Recorded raw Hermes gateway frames, one family per file, that pin the behavior of
`classifyHermesEvent` (the control plane's only raw-to-typed boundary). They are
the regression net for the whole control plane: `src/test/hermes-control-plane-replay.test.ts`
replays every frame of every fixture and asserts that nothing is dropped,
misclassified, or leaks a secret.

## Fixture shape

Each file is one JSON object:

```json
{
  "name": "tool-call-success",
  "hermesVersion": "v2026.6.19",
  "recordedFrom": "tui-gateway",
  "sanitized": true,
  "frames": [
    { "type": "tool.start", "session_id": "s", "payload": { "...": "..." } }
  ]
}
```

| Field           | Meaning                                                                                                                                                           |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`          | Stable id for the family; matches the filename.                                                                                                                   |
| `hermesVersion` | The Hermes release these frames were captured against. Ties the fixture to a row on the compatibility matrix (feature 16) and the upgrade checklist (feature 20). |
| `recordedFrom`  | Where the frames came from (`tui-gateway`).                                                                                                                       |
| `sanitized`     | Asserts the committed frames have already been redacted (see below). Always `true` for committed fixtures.                                                        |
| `frames`        | The raw `HermesGatewayEvent[]`, in arrival order.                                                                                                                 |
| `_note`, `_*`   | Optional human annotations (and leak canaries). Ignored by the replay helper.                                                                                     |

The `frames` are consumed by `replayFixture` / `replayFixtureFrames` in
`../replay.ts`; the rest is provenance the test asserts on.

## What the corpus covers

One file per event family (some combine a request with its response, or several
related bespoke types):

`normal-message`, `tool-call-success`, `tool-call-failure`,
`approval-request-response`, `clarify-request-response`, `sudo-request-response`,
`secret-request-response`, `subagent-lifecycle`,
`subagent-background-completion`, `image-attachment`, `model-switch`,
`interrupt`, `branch`, `gateway-disconnect-reconnect`, `session-busy-4009`,
`provider-account-error`, `reasoning-and-status`, `future-unknown-event`.

`raw-events.sample.json` is the original feature-01 seed (one frame per known
family); the files above extend it into the full replay corpus. Both are safe to
commit.

## Recording and sanitizing a new fixture

1. **Capture** the raw frames off the `tui-gateway` for the scenario (the
   classifier reads `HermesGatewayEvent = { type, session_id?, payload? }`).
2. **Sanitize before committing.** Replace every real secret, token, API key,
   bearer header, account id, file path, or PII with an OBVIOUSLY FAKE
   placeholder (e.g. `sk-FAKE-...-0000`). Run the payloads through the same
   redaction the runtime uses (`sanitizePayload` in `../sanitize.ts`) if in
   doubt. Never commit a real credential.
3. **Prove redaction where it matters.** For any secret-bearing family, include
   a sensitive key with a fake value in the payload and add a leak-canary
   assertion in the replay test (see the `secret-request-response` and
   `provider-account-error` fixtures): assert the fake value is absent from
   `JSON.stringify(classifiedEvent)`.
4. **Set provenance:** `hermesVersion` to the captured release, `recordedFrom`,
   and `sanitized: true`.
5. **Register it** in `src/test/hermes-control-plane-replay.test.ts`: import the
   JSON, add a `CASES` entry with one expected kind per frame. Expectations must
   reflect the classifier's ACTUAL current behavior. If a frame classifies as
   `unsupported` today (an unmodeled family), lock that honestly and note the
   gap, rather than asserting an aspirational kind.
6. `pnpm test` and `pnpm lint` (imports are type-checked via `resolveJsonModule`).

## On Hermes upgrade (feature 20 checklist)

When the pinned Hermes version changes, this corpus is the first thing to
revisit so a wire change surfaces as a deliberate diff, not a silent drop:

1. Re-capture each family against the new Hermes; update `frames` and bump
   `hermesVersion` on every touched fixture.
2. Re-run `pnpm test`. Any newly failing expectation is a real wire change to
   triage: either the classifier needs a branch (model it, extend `events.ts`,
   update the expected kind here) or the change is benign (update the fixture).
3. Any event that now classifies as `unsupported` but should be modeled is a
   gap; route it to the owning feature (the gap list lives with feature 16's
   compatibility matrix).
4. Add a fixture for any brand-new event family the upgrade introduces.
