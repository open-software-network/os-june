# GitHub installation return refresh design

## Context

GitHub device authorization and GitHub App installation are separate steps. A
user can authorize June successfully, receive a Keychain token, and still have
no visible App installation or selected repository. June represents that state
as `setup_incomplete`.

Live staging QA reproduced a recovery gap: after the user selected **Install
GitHub App**, installed `june-staging` for
`open-software-network/test-repo`, and returned to June, the row remained
`setup_incomplete` with zero installations and repositories. The row offered no
read-only refresh action, so the new installation could not be discovered
without disconnecting and authorizing again. The same gap would prevent the
documented remove-and-restore lifecycle check from recovering after repository
access is restored.

## Decision

June will perform one read-only GitHub installation refresh when the app regains
focus after a successful installation-management browser handoff.

The behavior applies to both browser actions:

- **Install GitHub App**, which opens the App installation page without an
  installation ID.
- **Manage repositories**, which opens the settings page for one stable
  installation ID.

The browser handoff arms a component-local one-shot return refresh only after
`githubInstallationOpen` resolves successfully. The next `window` focus event
consumes that armed state before starting `githubInstallationsRefresh`. Later
focus events do nothing until another installation-management handoff succeeds.
There is no polling and no provider request on unrelated app focus.

## State and race safety

`GitHubConnectorRow` continues to own only transient UI state. A ref records
whether a browser-return refresh is armed. The existing lifecycle generation
remains authoritative for refresh results:

- disconnect and unmount invalidate an outstanding refresh;
- a late success, failure, or cleanup cannot update the row after invalidation;
- the one-shot marker is cleared before invoking refresh, preventing duplicate
  focus events from starting duplicate requests;
- an installation-open failure does not arm refresh and uses the existing
  sanitized GitHub error copy;
- a refresh failure keeps the current connection state and shows sanitized
  retry guidance.

The existing Rust refresh operation replaces the complete connection snapshot,
so repository removal still fails closed and repository restoration can change
`setup_incomplete` back to `connected`.

## User experience

The visible button labels do not change. The user completes GitHub installation
or repository selection in the browser and returns to June. The GitHub row
briefly uses its existing refreshing busy state, then renders the replacement
status, installation owners, and selected repositories.

If the user returns without completing a GitHub-side change, the one read-only
refresh returns the same state. They can select **Install GitHub App** or
**Manage repositories** again to retry.

## Alternatives considered

### Refresh on every app focus

Rejected because it would make provider requests after unrelated window
switches and obscure which user action caused the refresh.

### Poll while the browser is open

Rejected because June cannot reliably know browser completion, polling creates
unnecessary provider traffic, and the existing focus signal is sufficient.

### Add only a manual Refresh button to `setup_incomplete`

Rejected by user preference. It would be predictable, but it adds an extra step
after the browser flow and does not automatically reconcile repository changes
made through **Manage repositories**.

## Verification

Component tests will prove:

1. A successful install handoff arms one refresh and the next focus replaces a
   `setup_incomplete` DTO with the connected DTO returned by Rust.
2. A successful manage handoff does the same while passing only the stable
   installation ID to Rust.
3. Repeated focus events consume the marker once and do not duplicate refresh.
4. An installation-open failure does not arm refresh and remains sanitized.
5. Disconnect or unmount prevents a late return refresh from updating state.
6. Existing cancel, refresh, disconnect, provider-isolation, Google, typecheck,
   and formatting gates remain green.

Live staging QA will then return to the already installed `june-staging` App,
verify automatic discovery of `open-software-network/test-repo`, and continue
the storage, refresh, lifecycle, revoke, reconnect, and disconnect checks.

## Scope

Implementation is limited to `GitHubConnectorRow` and its component tests unless
verification proves a directly related defect. No Rust command, database
schema, token custody, CSP, June API route, GitHub permission, or GitHub write
operation changes.

No ADR is needed because this is a reversible UI recovery behavior over the
existing approved refresh contract and does not change an architectural or
credential boundary.
