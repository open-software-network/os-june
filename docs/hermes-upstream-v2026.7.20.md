# Hermes upstream v2026.7.20

## Pin

- Previous June pin: `v2026.6.19`, commit `2bd1977d8fad185c9b4be47884f7e87f1add0ce3`
- New June pin: `v2026.7.20`, commit `3ef6bbd201263d354fd83ec55b3c306ded2eb72a`
- Archive checksum: `335c2249b6b2e58be397e12d542788f3315ede84394c0082b339a4ddde6a27d0`
- Upstream release: Hermes Agent v0.19.0, the Quicksilver Release
- Comparison: `https://github.com/NousResearch/hermes-agent/compare/v2026.6.19...v2026.7.20`

## Compatibility checked

June still starts Hermes through:

```text
hermes dashboard --no-open --host 127.0.0.1 --port <port>
```

The dashboard still exposes the API surfaces June consumes, including status,
sessions, messages, skills, messaging platforms, routines, toolsets, and the
authenticated `/api/ws` gateway. Session message pagination is additive:
omitting `limit` still returns the complete list June expects. The `sessions`
and `messages` database fields June reads remain compatible.

The upstream installer still has bare `$UV_CMD` calls. June's quoting patch
remains required for app data paths containing spaces.

The dashboard now imports the `@hermes/shared` workspace from `apps/shared`.
June's macOS and Windows bundlers retain that workspace until the dashboard
assets are compiled, then prune the rest of `apps/` from the shipped runtime.

## Sealed June patch set

Hermes 0.19 moved Telegram into `plugins/platforms/telegram/adapter.py` and
incorporated June's prompt image-batch ownership and atomic Telegram config
write fixes upstream. Patch set `june-approval-memory-v16` retires those
redundant transforms while preserving the remaining checksum-gated changes:

- targeted approval request identity, deduplication, expiry, and fail-closed queues
- immediate byte-image attachment and reset/build race protection
- global Memory deny propagation across interactive, background, and cron agents
- cross-process config writer locking and final disabled-toolset subtraction
- manual-only interactive approvals with fail-closed cron denial
- agent-run-scoped tool narrowing that can only subtract from June's process allowlist
  and defers the broad slash-command child until it is used

Every upstream and patched source hash was refreshed for the exact 0.19 tree.
The patch state machine accepts only the audited upstream or patched bytes and
rejects tampering. The complete compatibility smoke passes against both the
fresh upstream tree and the resulting patched tree.

| Source | Sealed patched or policy SHA-256 |
| --- | --- |
| `agent/agent_init.py` | `a3f6f64cc7932df2de66c4a93bcaef3cfe1cccd20a927e48e023c2185c8da5a5` |
| `tools/approval.py` | `c0d941fd952b578739afff0096b8896f4d7f742d66518aefef0a9c9b3b344900` |
| `tools/mcp_tool.py` | `764758773737bc1c1c46d244857198eea83dfbf52c0a1460ed0bc3418c1ceb7a` |
| `tui_gateway/server.py` | `a0d57103021a758507299b95d816038aea3bfc5b7d013a4032bfd4273aa0c33b` |
| `utils.py` | `0795233ec93398fe0f13e785d8b7c66768f60ee83b29d853c24009e1558e0174` |
| `plugins/platforms/telegram/adapter.py` | `b4fab048d4986ab49615a1b5abb0dafeade4a25196578bf93cb065b793d67c8b` |
| `cron/scheduler.py` | `ea54407dddebec57a184f1dbdf1076f8abe94f132da1e619c476cbf1266ed239` |
| `model_tools.py` | `30a2dcb33685783935f66abef6839d06736c90196a89dd034c91c4e6eb65c2db` |

## Gateway catalog diff

Hermes 0.19 keeps every JSON-RPC method June calls. It adds learning, project,
pet, subscription, usage, verification, one-shot LLM, and
`session.context_breakdown` methods.

It also adds `message.interim`, `moa.reference`, `moa.aggregating`,
`tool.output_risk`, `reaction`, `terminal.close`, `turn.start`, and `turn.error`
events. June classifies and renders `message.interim` as a sealed assistant
segment so later completion text cannot overwrite mid-turn commentary. Other
new families remain planned or deliberately unsupported in the compatibility
matrix and flow through June's sanitized unsupported-event path.

## Runtime capabilities

- Faster cold first-token latency and reasoning streaming by default
- Durable background delegation and completion delivery
- Smart approvals and explicit hard deny rules
- Bitwarden and 1Password secret sources
- Multi-format session export with optional secret redaction
- Fireworks AI and DeepInfra providers
- Max and ultra reasoning tiers with per-model overrides
- Multiplexed gateway profile routing and durable messaging delivery

These are runtime capabilities. June only advertises surfaces marked supported
in its compatibility matrix.

## Additional June integration work

- Add context inspection UI before exposing `session.context_breakdown`.
- Reconcile tool risk and smart approvals with June's human approval cards.
- Add vault connection and provenance UI before exposing secret sources.
- Add export format, scope, and redaction controls.
- Add Mixture of Agents transcript treatment.
- Add reasoning effort controls before advertising max or ultra.
- Keep Nous subscription controls hidden because June uses Open Software billing.

The existing replay corpus remains labeled `v2026.6.19` because it is a
historical capture. Focused tests cover the new `message.interim` shape and
preview settlement behavior.

## Release-gate smoke test

Run the protocol phase against the patched exact runtime:

```text
JUNE_HERMES_COMMAND=/absolute/path/to/hermes pnpm test:hermes-smoke
```

The optional provider-backed phase remains gated behind `HERMES_SMOKE_MODEL=1`.

## Release note copy

> Updated June's bundled agent runtime to Hermes 0.19. Agent responses start
> faster, and mid-task updates stay visible while June verifies its work.
