# Hermes dashboard profile builder and Skills Hub surfaces

## Status

accepted

## Context

June bundles Hermes and starts the upstream dashboard locally as the runtime and
API provider:

```text
hermes dashboard --no-open --host 127.0.0.1 --port <port>
```

June does not present the raw upstream dashboard as a user destination. It calls
selected dashboard APIs and then renders June-native surfaces for the agent,
skills, messaging, routines, and settings flows.

The Hermes v2026.6.19 update includes two larger upstream dashboard capabilities
that are not yet mapped into June product flows:

- A dashboard profile builder for composing agent profiles and runtime settings.
- Skills Hub browsing for discovering and installing upstream skills.

Both capabilities are useful upstream, but they overlap with choices June needs
to own directly: privacy posture, sandbox mode, local model defaults, skill
permissions, routine behavior, messaging account state, and how agent sessions
resume across app launches.

## Decision

Keep the upstream dashboard profile builder and Skills Hub browsing hidden from
June UI for now.

June should continue to treat the upstream dashboard as a local runtime and API
surface, not as a mixed product shell. When these capabilities become important
for June users, expose them as June-native surfaces backed by the relevant Hermes
APIs or file contracts.

Profiles should not be exposed through the upstream profile builder until June
has a clear product model for profile scope. A June profile must define how it
interacts with session privacy, sandboxing, model selection, routine execution,
messaging platform settings, and any `profile=default` assumptions in scheduled
jobs.

Skills Hub browsing should not be exposed until June owns a complete install and
review flow. That flow needs skill provenance, permission and tool-surface copy,
update and rollback behavior, conflict handling with locally edited skills, and
clear separation between bundled skills and user-added skills.

## Consequences

- The Hermes runtime update can ship without adding a raw dashboard entry point
  in June.
- Existing June-native skill editing, toggling, messaging settings, routines, and
  session flows remain the supported surfaces.
- Users will not see upstream profile builder or Skills Hub browsing until June
  has product-specific onboarding, safety, and recovery paths.
- Future PRs can still use Hermes APIs behind the scenes, but they should not
  route users into a generic upstream dashboard page to complete core June
  workflows.

## Revisit triggers

Revisit this decision when one or more of the following are true:

- Users need multiple persistent agent profiles for materially different June
  workflows.
- June has a settings information architecture that can explain profile scope
  without conflicting with privacy, sandbox, model, or routine settings.
- Skill discovery becomes a top user request and June has a curated install flow
  with provenance, permissions, updates, rollback, and local edit handling.
- Hermes exposes stable APIs for profile management and Skills Hub install state
  that June can consume without depending on upstream dashboard pages.
