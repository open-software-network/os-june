# Browser use runs in the user's own browser via a June extension

## Status

accepted - JUN-278. Supersedes the browsing-surface recommendation of the
JUN-229 scope proposal (PR #689, closed unmerged); that proposal's surface
inventory, consent-token pattern, and public-web policy carry forward into
this decision. (ADR 0016 is reserved by the private-connectors PR.)

## Context

June's agent web surface is read-only: `june_web` offers search and one-URL
fetch, nothing stateful. The Plugins epic (JUN-275) makes browser use and
computer use launch plugins (JUN-278). The JUN-229 scope work recommended a
June-managed ephemeral browser as the only v1 surface and made "never attach
to the user's normal profile" its core privacy boundary.

Product review overruled that boundary for attended use: the tasks users
actually want (act on my sites, on my behalf) require their signed-in
sessions, which an ephemeral profile cannot provide. Three attended
mechanisms were weighed: a June-managed pinned browser (no sign-in, heavy
packaging), attaching to the user's running browser over its debugging port
(relaunch flags, no pairing story), and a store-distributed extension
(store-enforced pairing to a native host, per-tab debugger control, visible
debugging banner).

The pinned upstream runtime was also evaluated. Its browser mode is
attach-only with no launch or policy layer, so it cannot carry June's policy.
Its computer-use toolset, in contrast, is production-shaped: background
control through cua-driver (events posted directly to the target process, no
cursor, focus, or Space theft), element-indexed captures, an
accessibility-only mode for text models, and approval hooks on every
mutating action. It lacks only packaging, consent, and TCC onboarding.

## Decision

Two tracks behind one app-owned `june_browser` MCP contract, gated by one
stored Browser access grant:

- **Attended sessions drive the user's own Chromium-family browser** through
  a June MV3 extension paired to a signed native-messaging shim inside the
  app, relaying to the Rust browser broker over an authenticated local
  socket. Actions run over per-tab debugger control in task-owned, visibly
  grouped tabs, plus tabs the user explicitly shares; pre-existing tabs are
  otherwise untouchable. Every consequential action parks in the broker for
  a chat approval card, with a per-task per-site allow; password, one-time
  code, and payment entry are never automated.
- **Unattended routines get a broker-launched managed browser**: a detected
  system Chromium-family binary run headless with a fresh ephemeral profile,
  public-web-only policy re-checked after redirects, consequential classes
  hard-blocked, per-routine opt-in.
- **Computer use (phase 2) productizes the pinned runtime's computer-use
  toolset**: a pinned, signed cua-driver bundled as an app resource (the
  upstream network installer never runs), TCC onboarding on the dictation
  helper pattern, runtime approvals surfaced as June approval cards, and a
  hard requirement for a vision-capable model.

Policy decisions are made in Rust at the broker choke point, never by
prompting the model (the connectors precedent).

## Consequences

- June's trust story changes: the agent can act inside the user's signed-in
  sessions. The compensating controls are structural, not prompt-level:
  task-tab isolation, the browser's own debugging banner as an indicator the
  model cannot suppress, and broker-parked approvals.
- Browser actions now gate coherently with connector mutations; without
  this, a signed-in browser would be an ungated bypass of the connectors'
  approval surface.
- The store listing, publisher account, and review latency join the release
  critical path, and the native-messaging protocol carries a version
  handshake because the store updates the extension independently of app
  releases.
- The routines track depends on an installed Chromium-family browser; no
  engine is bundled in v1.
- Private-system-interface risk in cua-driver is accepted for phase 2 behind
  a pinned driver version and a release self-test.
