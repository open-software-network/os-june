# June docs index

Read first, in order: **[CONTEXT.md](../CONTEXT.md)** (domain glossary) →
**[AGENTS.md](../AGENTS.md)** (agent guide) →
**[specs/003-conversation-turns/plan.md](../specs/003-conversation-turns/plan.md)**
(tech stack + structure).

## Architecture & decisions (ADRs)

Append-only; supersede with a new number or a dated addendum, never rewrite the
decision. See "When to add an ADR" in [AGENTS.md](../AGENTS.md).

- [adr/0001](adr/0001-auto-updates-via-tauri-updater.md) — auto-updates via the Tauri updater on a separate public releases repo
- [adr/0002](adr/0002-live-transcript-preview-strategy.md) — live transcript preview as an ephemeral companion, not the source of truth
- [adr/0003](adr/0003-release-candidate-channel-and-promotion.md) — rc channel + promote-to-stable (every stable release starts as an RC)
- [adr/0004](adr/0004-out-of-process-system-audio-helper.md) — macOS system audio via an out-of-process helper (file IPC + Unix signals)
- [adr/0005](adr/0005-source-separated-audio-capture.md) — one WAV per source, re-interleaved as turns
- [adr/0006](adr/0006-embed-hermes-sandboxed-runtime.md) — embed the pinned Hermes runtime as sandboxed child processes
- [adr/0007](adr/0007-model-capability-source-of-truth.md) — model capabilities come from the live Venice catalog, not marketing traits

## Enforceable rules (spec/)

Coding rules that should fail review if violated (distinct from the `specs/`
feature specs). Full index: [spec/index.md](../spec/index.md).

- UI copy: [spec/sentence-case](../spec/sentence-case.md), [spec/no-typographic-dashes](../spec/no-typographic-dashes.md)
- UI styling: [spec/icons-central-only](../spec/icons-central-only.md), [spec/design-tokens](../spec/design-tokens.md)

## Subsystems

- [hermes-architecture.md](hermes-architecture.md) — the agent runtime: bridge, gateway, control plane, sessions, models
- [audio-pipeline.md](audio-pipeline.md) — capture → source separation → turns → transcription → note
- [june-api-prd.md](june-api-prd.md) — June API: upstream proxy + OS Accounts authorize/charge (the canonical backend spec)
- [configuration.md](configuration.md) — env + config reference (desktop client + June API)
- [development.md](development.md) — local development: quick start, local data, permissions, agent skills, verification commands
- [os-accounts-login.md](os-accounts-login.md) — Login with Open Software: PKCE, keychain, account gates
- [onboarding-design.md](onboarding-design.md) — onboarding flow design (verify against what shipped)
- ~~os-accounts-backend.md~~ — historical; superseded by `june-api-prd.md`

## Hermes runtime (pin management)

- [hermes-upgrade-checklist.md](hermes-upgrade-checklist.md) — the gate for bumping the pinned runtime
- [hermes-upstream-template.md](hermes-upstream-template.md) — per-bump pin-note template
- [hermes-upstream-v2026.6.19.md](hermes-upstream-v2026.6.19.md) — current pin note (v2026.6.19)
- [hermes-tui-debug.md](hermes-tui-debug.md) — dev-only raw-TUI debug fallback

## Release & ops runbooks

- [release-macos.md](release-macos.md) / [release-windows.md](release-windows.md) — the release runbooks
- [desktop-release-runner.md](desktop-release-runner.md) — Mac Studio self-hosted runner setup for signed desktop releases
- [reproducible-builds.md](reproducible-builds.md) — June API source → TEE trust chain (Phase A shipped)
- [github-security-readiness.md](github-security-readiness.md) — pre-public repo hardening checklist
- [settings-focus-runbook.md](settings-focus-runbook.md) — transient: settings tabs hidden while admin surfaces stabilize

## QA

- [qa/agent-driven-integration.md](qa/agent-driven-integration.md) — QA strategy (3 layers, skill-first agent-driven)
- `qa/feature-user-stories.tsv` — story → code → test traceability matrix
- `qa/agent-e2e-qa-runs/` — dated end-to-end QA run logs

## Feature specs (Spec Kit)

Each spec folder holds `spec / plan / research / data-model / quickstart /
tasks / contracts / checklists`.

- `specs/001-tauri-note-mvp` — Notes MVP (shipped)
- `specs/002-system-audio-source-mode` — audio source modes (shipped)
- `specs/003-conversation-turns` — dual-source conversation turns (current; the tech + structure entrypoint)

## Gaps (no doc yet — candidates for new docs/ADRs)

- **Roadmap / MVP scope** — no single sequenced source of truth across the active tracks (admin surfaces, reliability).
- **Dictation ADR** — the low-latency request shape + charge timing (flagged in CONTEXT.md).

## Security

- [../SECURITY.md](../SECURITY.md) — vulnerability reporting + supported versions
