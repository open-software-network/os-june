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
- [adr/0008](adr/0008-image-generation-and-editing-tools.md) — image generation/editing: `/image` fast path + LLM tools, via Venice
- [adr/0009](adr/0009-hermes-config-shared-ownership-merge.md) — config.yaml is shared with the Hermes dashboard; June deep-merges on spawn, never overwrites
- [adr/0010](adr/0010-note-references-in-agent-chat.md) — note references in agent chat: `@note:<id>` text token + `get_meeting_note` fetch-by-id
- [adr/0011](adr/0011-bundled-hermes-skills.md) — selected Hermes skills ship as read-only app resources when the runtime pin cannot move
- [adr/0012](adr/0012-direct-issue-report-submission.md) — issue reports submit directly (no client model turn, nothing to charge); June API generates the team-facing diagnosis
- [adr/0013](adr/0013-stream-inference-responses-through-june-api.md) — inference responses stream through June API (SSE pass-through + keep-alive heartbeats); charges settle after the stream ends
- [adr/0014](adr/0014-pinned-dictation-paste-target.md) — the dictation paste target is pinned when the recording stops, never re-resolved at paste time
- [adr/0015](adr/0015-video-generation-tools.md) — video generation: `/video` fast path + LLM tools, async job + poll, quote-priced, via Venice
- [adr/0016](adr/0016-private-connectors-local-mode.md) — private connectors (local mode): Keychain-only token custody, app-proxied MCP calls straight to Google, trust modes enforced in the Rust proxy, earned autonomy, event-trigger daemon
- [adr/0017](adr/0017-browser-use-via-june-extension.md) — browser use in the user's own browser via the June extension, two tracks behind one broker; computer use productizes the pinned toolset
- [adr/0018](adr/0018-session-model-changes-apply-at-agent-run-boundaries.md) — session model changes are staged at Send and applied only at the next idle agent-run boundary
- [adr/0019](adr/0019-windows-dictation-helper.md) — Windows dictation uses a platform-native helper process
- [adr/0020](adr/0020-windows-dictation-keyboard-hook.md) — Windows shortcuts combine `RegisterHotKey` with a narrow keyboard hook
- [adr/0021](adr/0021-june-api-v1-compatibility-policy.md) — `/v1` is additive-only for shipped app versions: per-version contract fixtures gate CI and production promotes, clients send `x-june-app-version`, error codes never renumber
- [adr/0022](adr/0022-venice-private-first-model-routing.md) — service-managed text uses Venice private zero-retention first with Phala TEE fallback; existing `/v1` provider semantics stay compatible and pricing is fallback-safe
- [adr/0023](adr/0023-attested-os-api-service-chain.md) - superseded by ADR-0024
- [adr/0024](adr/0024-independent-product-verification.md) - June, Open Software API, and Chat publish independent verification evidence without cross-product release pinning
- [adr/0025](adr/0025-notion-hosted-mcp-connect-preview.md) - consent-gated Notion hosted MCP connect-only preview, with no content or Hermes tool path

## Enforceable rules (spec/)

Coding rules that should fail review if violated (distinct from the `specs/`
feature specs). Full index: [spec/index.md](../spec/index.md).

- UI copy: [spec/sentence-case](../spec/sentence-case.md), [spec/no-typographic-dashes](../spec/no-typographic-dashes.md), [spec/no-all-caps](../spec/no-all-caps.md)
- UI styling: [spec/icons-central-only](../spec/icons-central-only.md), [spec/design-tokens](../spec/design-tokens.md), [spec/no-tabular-numerals](../spec/no-tabular-numerals.md)
- Typography: [spec/type-scale](../spec/type-scale.md), [spec/font-weights](../spec/font-weights.md), [spec/font-families](../spec/font-families.md)
- Controls: [spec/control-sizes](../spec/control-sizes.md)

## Design system

The extracted design system: tokens, primitives, and the rules around them (see
the `spec/` entries above for the enforceable versions).

- [design/foundations.md](design/foundations.md) — theming model, token roles, and the type system (scale, heading mapping, two-weight system, family roles); ends with the pass-2 deviations worklist
- [design/components.md](design/components.md) — pattern-to-canonical-answer map for the shared `src/components/ui/` primitives, the settings markup contract, and what is not yet systematized
- [design/conventions.md](design/conventions.md) — flat-namespace naming, interaction and visual rules, theming pipeline, and how to open or extend the styleguide page
- [design/taste.md](design/taste.md) — the sensibility behind the rules (quiet by default, weight as punctuation, color spent not sprayed); the portable layer for other projects

## Agent skill config (docs/agents/)

Per-repo config the engineering skills read before acting (see the
"Agent skills" section in [AGENTS.md](../AGENTS.md)).

- [agents/issue-tracker.md](agents/issue-tracker.md) — issues live on os-platform (org `june`), read via the os-platform skill, writes append-only via the API
- [agents/triage-labels.md](agents/triage-labels.md) — the five triage roles mapped to platform labels + statuses
- [agents/domain.md](agents/domain.md) — single-context layout; how skills consume CONTEXT.md and ADRs
- [agents/collaboration.md](agents/collaboration.md) — how agents build, delegate, and review across harnesses: the skill family map, reviewer-is-never-the-author, trust levels

## Subsystems

- [hermes-architecture.md](hermes-architecture.md) — the agent runtime: bridge, gateway, control plane, sessions, models
- [hermes-gateway-gotchas.md](hermes-gateway-gotchas.md) — integration gotchas: restart discipline, config contract, MCP OAuth, event types, upstream tool-schema quirks
- [browser-computer-use-prd.md](browser-computer-use-prd.md) — PRD: Browser use + Computer use plugins (JUN-278); extension in the user's browser + routines-only managed browser, phase-2 computer use
- [plugins/portfolio.md](plugins/portfolio.md) — JUN-309 portfolio: current ChatGPT plugin surface inventory, ranking rubric, June's top 10, shared product contract, sequencing, metrics, and explicit deferrals
  - [Google Workspace](plugins/google-workspace-prd.md) — [implementation plan](plugins/google-workspace-implementation-plan.md)
  - [Browser use](plugins/browser-use-prd.md) — [implementation plan](plugins/browser-use-implementation-plan.md)
  - [Slack](plugins/slack-prd.md) — [implementation plan](plugins/slack-implementation-plan.md)
  - [Microsoft 365](plugins/microsoft-365-prd.md) — [implementation plan](plugins/microsoft-365-implementation-plan.md)
  - [Computer use](plugins/computer-use-prd.md) — [implementation plan](plugins/computer-use-implementation-plan.md)
  - [Notion](plugins/notion-prd.md) — [implementation plan](plugins/notion-implementation-plan.md)
  - [GitHub](plugins/github-prd.md) — [implementation plan](plugins/github-implementation-plan.md)
  - [Linear](plugins/linear-prd.md) — [implementation plan](plugins/linear-implementation-plan.md)
  - [Documents](plugins/documents-prd.md) — [implementation plan](plugins/documents-implementation-plan.md)
  - [Spreadsheets](plugins/spreadsheets-prd.md) — [implementation plan](plugins/spreadsheets-implementation-plan.md)
- [plugins/integrations-next-ten.md](plugins/integrations-next-ten.md) - follow-on provider portfolio: ranks 11-20, auth feasibility, sequencing, and decision gates
  - [HubSpot](plugins/hubspot-prd.md) - [implementation plan](plugins/hubspot-implementation-plan.md)
  - [Salesforce](plugins/salesforce-prd.md) - [implementation plan](plugins/salesforce-implementation-plan.md)
  - [Asana](plugins/asana-prd.md) - [implementation plan](plugins/asana-implementation-plan.md)
  - [Box](plugins/box-prd.md) - [implementation plan](plugins/box-implementation-plan.md)
  - [GitLab](plugins/gitlab-prd.md) - [implementation plan](plugins/gitlab-implementation-plan.md)
  - [ClickUp](plugins/clickup-prd.md) - [implementation plan](plugins/clickup-implementation-plan.md)
  - [Dropbox](plugins/dropbox-prd.md) - [implementation plan](plugins/dropbox-implementation-plan.md)
  - [Pipedrive](plugins/pipedrive-prd.md) - [implementation plan](plugins/pipedrive-implementation-plan.md)
  - [Azure Boards](plugins/azure-boards-prd.md) - [implementation plan](plugins/azure-boards-implementation-plan.md)
  - [Canva](plugins/canva-prd.md) - [implementation plan](plugins/canva-implementation-plan.md)
- [audio-pipeline.md](audio-pipeline.md) — capture → source separation → turns → transcription → note
- [june-api-prd.md](june-api-prd.md) — June API: upstream proxy + OS Accounts authorize/charge (the canonical backend spec)
- [telemetry.md](telemetry.md) — public overview of June telemetry, current behavior, and policies
- [telemetry-p3a-prd.md](telemetry-p3a-prd.md) — June P3A: opt-in, privacy-preserving product telemetry
- [telemetry-p3a-implementation-plan.md](telemetry-p3a-implementation-plan.md) — implementation plan for June P3A phases
- [telemetry-questions.md](telemetry-questions.md) — public P3A question catalog and buckets
- [private-connectors-prd.md](private-connectors-prd.md) — private connectors & away-mode relay: an assistant that acts in email and calendar without OpenSoftware readable data (local mode shipping; away mode proposed)
- [private-connectors-implementation-plan.md](private-connectors-implementation-plan.md) — implementation plan for private connectors phases (Phases 1-2 local mode implemented; see [adr/0016](adr/0016-private-connectors-local-mode.md))
- [private-connectors-threat-model.md](private-connectors-threat-model.md) — local-mode threat model: the source of truth for all connector privacy copy (what OpenSoftware can and cannot see, the trust surface, agent protections, the known runtime limitation)
- [configuration.md](configuration.md) — env + config reference (desktop client + June API)
- [auto-model-rollout.md](auto-model-rollout.md) — canary, enablement, and rollback steps for automatic private model routing
- [development.md](development.md) — local development: quick start, running against staging or an ephemeral Phala CVM, local data, permissions, agent skills, verification commands
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
