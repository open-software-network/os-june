---
status: accepted
date: 2026-08-05
---

# Clovy presentation retains June-era technical identities

## Context

The product is changing its user-facing name from June to Clovy. The name is
visible in app copy, artwork, documentation, legal notices, release messaging,
and the identity asserted by the agent.

Several June-era identifiers have already shipped and now bind durable user
data, operating-system permissions, credentials, updates, automation, and
external integrations. Renaming those identifiers as if they were presentation
copy could strand data, prompt for permissions again, break upgrades, invalidate
credentials, or disconnect existing clients. A literal `june` string therefore
does not necessarily represent stale branding.

## Decision

### Current product language

The current product terms are **Clovy**, **Clovy API**, and **Clovy Companion**.
User-facing app copy, artwork, notifications, helper labels, public and legal
prose, current documentation, and agent identity use those terms. New visual
assets use the Clovy wordmark and app icon.

### Compatibility identities stay stable

The first Clovy release retains shipped June-era technical identities wherever
renaming could affect compatibility. This includes, without limitation:

- the `os-june` repository, Rust package, desktop binary, release repository,
  and package-manager coordinates;
- the `june-api/` source path, `june-*` backend crates, `june` server binary,
  service hostnames, container coordinates, and API routes;
- bundle identifiers, installed application bundle paths, extension and
  native-host identifiers, Keychain service names, operating-system permission
  identities, installer paths, and registered URL schemes;
- environment variables such as `JUNE_API_*`, `JUNE__*`, and `OS_JUNE_*`;
- headers such as `x-june-app-version` and `x-june-macos-version`;
- persisted database names, tables, migration markers, local-storage keys,
  file names, command names, error codes, protocol fields, and `june_*` tool
  namespaces;
- updater endpoints, signing keys, release artifact names, and compatibility
  fixtures; and
- the OS Platform product handle `june` and issue prefix `JUN`.

The installed macOS bundle path is retained for DMG installs, not because the
updater depends on the archive name. The updater strips the archive's top-level
path component and writes the result back to the running app's existing path. A
fresh DMG named `Clovy.app`, however, would install beside an existing
`June.app`; because both copies share a bundle identifier and updater feed, the
user would have two independently updating installations.

Clovy Companion is the presentation name. Existing companion crate, target,
scheme, FFI, protocol, credential, and bundle identities remain stable unless a
separate pre-release provisioning decision proves that a rename is safe.

New public artifacts may use Clovy names while keeping aliases or redirects for
already published June-era entry points. A legacy identifier may be retired
only through an explicit migration plan and, when the change is architectural,
a superseding ADR.

### Documentation and verification

Current explanatory documentation calls the product Clovy and identifies a
retained June-era value as a compatibility identifier where that distinction
matters. Historical ADR bodies, shipped feature specifications, QA evidence,
release records, and contract fixtures remain unchanged so they continue to
describe and prove the releases for which they were written.

The Clovy release candidate must be tested as an upgrade from a released June
build. Release proof covers notes, recordings, memories, agent sessions,
OS Accounts sign-in, Keychain-backed connectors, microphone and accessibility
permissions, deep links, updates, browser-extension connectivity, autostart,
and the equivalent Windows upgrade path. Existing API contract fixtures remain
valid.

## Consequences

- People see and interact with Clovy consistently, while installed versions
  continue to upgrade without discarding June-era state or trust grants.
- Engineers must distinguish presentation strings from compatibility
  identities during rebrand searches. Not every `june` occurrence is a bug.
- New persisted or wire identifiers require an explicit compatibility judgment;
  new user-facing names use Clovy by default.
- The codebase will intentionally contain legacy identifiers until each can be
  migrated with evidence that installed clients and user data remain safe.

## Alternatives considered

- **Rename every identifier in one pass.** Rejected because bundle identity,
  storage, credentials, permissions, updater metadata, and integrations are
  compatibility contracts rather than presentation details.
- **Change only the app artwork and UI.** Rejected because current public,
  legal, support, and operational prose would conflict with the product users
  see.
- **Ship Clovy as a separate application identity beside June.** Rejected for
  the initial rebrand because it would split upgrades, state, permissions, and
  support between two installations.
