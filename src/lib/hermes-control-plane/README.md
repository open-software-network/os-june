# hermes-control-plane

The single layer that turns raw Hermes JSON-RPC gateway frames into **typed June
events** and **typed June commands**. Every Hermes-aware feature in the app
imports its contract from here so the wire shape lives in one place.

## What this is (and is not)

- **This layer:** classifies _live gateway events_ (`message.*`, `tool.*`,
  `clarify.request`, `subagent.*`, …) into the `JuneHermesEvent` union, and
  wraps _outbound JSON-RPC methods_ (`session.steer`, `session.branch`, …) as
  typed functions. It is the only code that reads raw Hermes payloads.
- **Not this layer:** transport. `../hermes-gateway.ts` owns the WebSocket,
  reconnects, request/response correlation, and the 4009 "session busy"
  handling. Keep it transport-only.
- **Complementary, not a competitor:** `../hermes-adapter.ts` normalizes
  _session listing_ (history, titles, scheduled-run detection). That is a
  different concern (REST-ish session metadata) from classifying the live event
  stream. Do not move or duplicate it.

## The contract

```text
raw HermesGatewayEvent ──▶ classifyHermesEvent() ──▶ JuneHermesEvent
                                                       ├─ transcript
                                                       ├─ reasoning
                                                       ├─ tool
                                                       ├─ pending_action ─▶ PendingHermesAction
                                                       │                     (clarify | approval | sudo | secret)
                                                       ├─ background_activity ─▶ BackgroundHermesActivity
                                                       ├─ lifecycle
                                                       ├─ error
                                                       └─ unsupported   (anything unknown — never dropped)

typed call ──▶ createHermesMethods(request).<method>() ──▶ gateway.request("session.…", { … })
```

- `classifyHermesEvent` is **total**: it returns exactly one `JuneHermesEvent`
  for every frame and never returns `undefined`. Consumers can `switch (e.kind)`
  exhaustively with no `default`.
- Unknown raw types become `{ kind: "unsupported", rawType, sanitizedPayload }`
  so a Hermes upgrade that adds an event is **visible**, not silently ignored.
- `HermesMode = "sandboxed" | "unrestricted"` is the canonical session-mode
  type. Derive it from a session id with `hermesModeFor(sessionId)` (absence =
  `sandboxed`, the safe default).

## Files

| File                  | Purpose                                                                                                                          |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `raw-types.ts`        | Defensive (all-optional) raw JSON-RPC + Hermes payload shapes.                                                                   |
| `events.ts`           | `JuneHermesEvent`, `PendingHermesAction`, `BackgroundHermesActivity`, `HermesMode` + mode helpers.                               |
| `event-classifier.ts` | `classifyHermesEvent` — raw frame → typed event.                                                                                 |
| `methods.ts`          | `createHermesMethods(request)` — typed wrappers over `gateway.request`.                                                          |
| `sanitize.ts`         | `sanitizePayload` redactor for `unsupported`/`error` payloads and logs.                                                          |
| `parse.ts`            | Shared defensive parse primitives (`nonEmpty`, `asRecord`, `finiteNumber`, `pickNumber`, `pickString`) for reading raw payloads. |
| `replay.ts`           | `replayFixture` / `replayFixtureFrames` — drive recorded frames through the classifier for tests.                                |
| `index.ts`            | Public barrel. Import everything from `../hermes-control-plane`.                                                                 |
| `fixtures/`           | Sample raw frames (JSON data) for replay tests.                                                                                  |
| `compatibility/`      | Hermes compatibility matrix: pinned-version support map and checks.                                                              |

## Security

- Raw payloads are **never** `JSON.stringify`ed into a normalized event. Only
  modeled fields cross the boundary.
- `unsupported` and `error` events carry payloads only after `sanitizePayload`
  masks keys matching
  `/(token|api[_-]?key|secret|password|private[_-]?key|credential|authorization)/i`
  (and credential-looking values). `secret.request` carries _metadata only_ —
  never the value.

## How to add a new event

1. Decide if June can act on it. If yes, add a branch in `event-classifier.ts`
   that returns a typed `JuneHermesEvent` kind, extending the union in
   `events.ts` if a new shape is needed. If not yet, do nothing — it already
   flows through as `unsupported` (safe and visible).
2. Add a case to `src/test/hermes-control-plane-classifier.test.ts` asserting
   the mapping (or that it is `unsupported`).
3. For a new outbound method, add a typed wrapper in `methods.ts` and a test in
   `src/test/hermes-control-plane-methods.test.ts`.

## Where tests live

**`src/test/` only.** `vite.config.ts` runs tests from `src/test/**` — a test
placed inside this module directory silently never runs. Fixture _data_ (JSON)
may live in `fixtures/` here; test files may not.

- `src/test/hermes-control-plane-classifier.test.ts`
- `src/test/hermes-control-plane-methods.test.ts`
