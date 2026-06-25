# Hermes admin fixtures and fake dashboard server

Test infrastructure for June's Hermes admin surfaces (Skills, Toolsets, Skills
Hub, MCP, gateway lifecycle, env). None of these files are test suites
(`vite.config.ts` only collects `src/test/**/*.{test,spec}.*`); they are
imported by the admin tests so those run against the real REST surface without
launching the pinned Hermes runtime.

## Files

| File                        | Purpose                                                                                                   |
| --------------------------- | --------------------------------------------------------------------------------------------------------- |
| `fake-hermes-server.ts`     | Stateful, `fetch`-shaped fake of the dashboard admin API. Mutations mutate in-memory state; actions poll. |
| `hermes-admin-scenarios.ts` | Named scenario factories (empty, rich, security warning, MCP variants, restart, profile isolation, ...).  |
| `hermes-admin-harness.ts`   | Wires a fake server to a real `createHermesAdminClient` + cache + lifecycle, capturing redacted logs.     |

## How a test uses it

```ts
import {
  makeAdminHarness,
  instantSleep,
} from "./fixtures/hermes-admin-harness";
import { richInstallScenario } from "./fixtures/hermes-admin-scenarios";

const { client, cache, server } = makeAdminHarness(richInstallScenario());
const skills = await client.skills.list(); // real request -> fake server
```

The fake enforces the dashboard's auth (`X-Hermes-Session-Token`), so a wrong
token gets a real 401. It strips secret-bearing config (`env`, `headers`) from
GET responses, mirroring the real dashboard, so "no secret in a response body"
assertions hold.

## Security rules for fixtures

- Every secret-shaped value MUST be obviously fake: `sk-FAKE-...`,
  `Bearer FAKE-...`. The redaction-leak tests assert these fake values never
  reach a log line, so they need a concrete (fake) token to look for.
- Never commit a real credential, token, or PII.

## Updating fixtures when the Hermes pin changes

June pins one Hermes version (`PINNED_HERMES_VERSION`, currently `v2026.6.19`).
When the pin bumps, the contract these fixtures encode must be re-verified
against the new runtime so a wire change surfaces as a deliberate diff, not a
silent break for users:

1. **Record real responses.** Against a locally-running pinned Hermes dashboard,
   capture the JSON for each admin route the fake simulates (see the route list
   at the top of `fake-hermes-server.ts`):
   - `curl -s -H "X-Hermes-Session-Token: $TOKEN" http://127.0.0.1:$PORT/api/skills`
   - ...and the same for toolsets, `mcp/servers`, `mcp/catalog`, `status`, and a
     representative `actions/{name}/status`.
2. **Sanitize before committing.** Replace every real token, key, header value,
   path, account id, or PII with an obviously fake placeholder. Run anything you
   are unsure about through `redactForLog` from `src/lib/hermes-admin`.
3. **Diff against the parsers.** If a captured shape no longer parses into the
   normalized type (`src/lib/hermes-admin/schemas.ts`), that is a real contract
   change: either extend the parser (add the new key to the `pick*` lists) or
   adjust the fixture, and note it in the upgrade checklist (feature 20 /
   `compatibility/matrix.ts`).
4. **Update the fake.** If a route's response envelope changed (e.g. a list moved
   under a new key), update `fake-hermes-server.ts` to emit the new shape and the
   scenario factories if a field was added/removed.
5. **Re-run** `pnpm exec tsc --noEmit` and the admin test files. A newly failing
   contract test is the signal to triage, exactly as intended.

## Real-Hermes smoke tests

The fixtures above let every admin test run with no runtime. A separate, optional
smoke test that drives the real pinned Hermes runtime (gated for CI that can
install it) belongs alongside the existing `src/test/hermes-smoke.test.ts`
pattern and is intentionally NOT part of the default fixture-backed suite.
