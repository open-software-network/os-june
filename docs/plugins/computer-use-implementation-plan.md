# Implementation plan: Computer use plugin

- **Mode:** CTO
- **Date:** 2026-07-13
- **Status:** Implemented for review
- **PRD:** [computer-use-prd.md](computer-use-prd.md)
- **Decisions:** [ADR-0017](../adr/0017-browser-use-via-june-extension.md), [ADR-0028](../adr/0028-private-stdio-broker-for-computer-use.md)

## Technical objective

Productize the pinned upstream macOS capture/input implementation behind a
June-owned helper, native policy broker, June grant, TCC onboarding,
model-capability gating, and June-native approval cards. Hermes never receives
the upstream toolset or helper transport.

## Phase 0: sandbox spike

JUN-288 must prove on a signed app build:

- the bundled driver launches from app resources;
- private-interface lookup works under the current Seatbelt profile, or the
  broker can spawn a narrowly scoped helper outside the write jail;
- Accessibility and Screen recording attach to the intended bundle identity;
- background input does not steal cursor, focus, or Space;
- capture and action approval hooks match the pinned runtime contract;
- stop/revoke terminates the driver and invalidates pending actions.

If the driver requires a new helper trust boundary, record an ADR addendum or a
new ADR before hardening the plan.

## Packaging

- Pin the driver source/version to an exact Git commit in the repo.
- Compile the June-owned narrow helper only in controlled build tooling; never
  install or update it at runtime.
- Sign it with the app release identity and include it as a Tauri resource.
- Give each debug worktree a stable derived helper identity and reset only that
  identity's TCC grants at local dev startup. Keep the release identity fixed.
- Keep the exact helper path and fresh initialization capability inside the
  Rust broker; do not expose either as runtime overrides.
- Add SBOM/provenance and a release test that starts, handshakes, captures a
  fixture app, and exits.

## Grant and TCC state

One Computer use grant is managed from Plugins and represented in the runtime
config. June does not duplicate this control in Settings. Granting does not
fabricate macOS permission. The state machine is:

`off -> grant_on_permission_missing -> permission_prompted -> ready -> error`

Poll the OS permission state after an explanatory screen. Distinguish
Accessibility from Screen recording and provide direct System Settings help.
Revoking the June grant disables the toolset immediately even if macOS
permission remains; removing TCC access is an explicit user follow-up.

## Runtime and approvals

- Keep both upstream Computer Use toolsets disabled. Expose only June's single
  app-owned MCP tool when every native readiness gate passes.
- Route the first access to each verified target app through the Rust
  authorization registry and June approval card. The authorization lasts only
  for the active attended task.
- Instruct the agent to invoke the requested operation immediately and wait for the native
  decision. It must not ask for a textual approval or name the internal
  transport in chat.
- Allow app lifecycle only through the broker: display-name-only background
  launch, plus exact-PID/window current-stage restoration after the app
  authorization and target revalidation. Reject paths, URLs, arguments,
  environment, debug ports, and arbitrary process activation.
- Bind authorization to the verified bundle identifier and executable path,
  with a stable id and expiry. Clear it on task end, Stop, revoke, or shutdown.
- Never offer cross-task Allow always, approve-all, or autonomous mode in v1.
- Block password, one-time code, payment, permission/security settings, keychain,
  terminal privilege escalation, and destructive system actions.

## Delivery slices

1. **Driver spike (JUN-288).** Go/no-go and trust-boundary decision.
2. **Pinned bundle (JUN-293, 1-2 weeks).** Reproducible resource, handshake,
   version failure, release self-test.
3. **TCC + tile (JUN-296, 2 weeks).** State machine, education, model gate,
   grant/revoke.
4. **Approval bridge (JUN-296, 1-2 weeks).** Runtime approval events to June
   cards, stop and timeout semantics.
5. **Hardening (2 weeks).** Target-app isolation, sensitive-action denylist,
   crash recovery, signed-build matrix.

## Verification

- Unit tests for grant/TCC/model state and approval event normalization.
- Contract fixture against the pinned runtime and driver handshake.
- Signed-build tests on the oldest and newest supported macOS releases.
- Fixture applications for text fields, menus, lists, scrolling, modal dialogs,
  multiple windows, cold launch, Stage Manager restore, app quit, target
  movement, and capture change races.
- Proof that background actions do not move cursor, change focus, or switch
  Space.
- Security tests for denied apps/fields/actions and stale capture references.
- Manual walkthrough of first permission, denial, later grant, task action,
  approve, deny, stop, revoke, OS update simulation, and driver crash.

## Rollout

Developer-only, internal signed builds, rc opt-in, then Pro stable. Maintain a
remote driver kill switch keyed by June version and macOS version. The release
self-test blocks promotion if capture or background input fails. Telemetry is
content-free: OS version bucket, driver version, operation class, latency,
approval outcome, failure class.

## Exit criteria

- Two weeks of internal use with no focus theft or unapproved mutation.
- Release self-test green on the support matrix.
- Security review of capture handling and denied action classes.
- Support runbook for TCC, driver mismatch, model mismatch, and OS regression.
