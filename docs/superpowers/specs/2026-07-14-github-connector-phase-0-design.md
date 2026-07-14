# GitHub connector Phase 0 design

- **Date:** 2026-07-14
- **Status:** Approved
- **Issue:** JUN-285
- **Scope:** GitHub App authentication, token custody, installation discovery, and selected-repository binding
- **Related:** [GitHub plugin PRD](../../plugins/github-prd.md), [GitHub implementation plan](../../plugins/github-implementation-plan.md), [ADR 0016](../../adr/0016-private-connectors-local-mode.md)

## Summary

Phase 0 proves that June can connect an organization-owned GitHub App from the desktop without shipping or operating a reusable GitHub secret. It implements GitHub device flow, stores rotating user tokens in the OS Keychain, discovers the user's authorized App installations, and records the repositories selected for each installation.

The spike ends at the credential and repository boundary. It does not expose GitHub MCP tools, perform GitHub writes, add routines, or generalize the complete Google connector implementation. Those follow only after the live staging contract is proven.

## Goals

- Connect June to the `june-staging` GitHub App with device flow.
- Keep the GitHub Client ID as the only value June sends to GitHub's device and token endpoints.
- Store access and refresh tokens only in the OS Keychain.
- Discover the authorized GitHub user, installations, granted permissions, and selected repositories.
- Bind repository access to stable GitHub installation and repository IDs rather than model-provided owner/name strings.
- Prove token refresh, revoke handling, repository removal, cancellation, and reconnect behavior.
- Confirm that June API is not in the GitHub credential or repository-data path.
- Preserve the existing Google connector behavior throughout the spike.

## Non-goals

- GitHub MCP read or action servers.
- Issue, comment, review, merge, branch, file, workflow, release, deployment, secret, or administration actions.
- Note-to-repository, issue, or pull-request links.
- GitHub routines, triggers, or autonomous actions.
- GitHub Enterprise Server.
- Webhook delivery or a June API GitHub signer.
- A production GitHub App registration.
- A broad provider-neutral connector refactor.

## Approaches considered

### 1. GitHub-specific Phase 0 alongside Google

Add a narrow GitHub auth and installation slice next to the existing Google connector. Prove the external contract before changing shared connector abstractions.

**Chosen.** This isolates the highest-risk unknowns, avoids destabilizing the shipped Google connector, and leaves a clear seam for later provider-neutral extraction.

### 2. Generalize the connector framework first

Replace the Google-shaped account, OAuth, scope, bridge, and routine structures before connecting GitHub.

**Rejected for Phase 0.** It creates a large internal migration before the GitHub credential and installation model has been proven live.

### 3. Mint installation tokens through June API

Store a GitHub App private key in June API and mint installation tokens for the desktop.

**Rejected.** GitHub App user access tokens obtained by device flow cover the proposed V1 operations. A backend signer would introduce an unnecessary credential capable of minting repository-reading tokens and would change June's privacy boundary.

## Staging fixture

| Field | Value |
| --- | --- |
| GitHub App owner | `open-software-network` |
| GitHub App name | `June Staging` |
| App ID | `4296474` |
| Client ID | `Iv23lihKGi1yIb8QZm9L` |
| App slug | `june-staging` |
| Installation URL | `https://github.com/apps/june-staging/installations/new` |
| Selected repository | `open-software-network/test-repo` |

These values are public identifiers, not credentials. The operational values are supplied through environment and build configuration so staging and production registrations remain separate. No private key or client secret is required, committed, logged, or shipped.

## Configuration

June reads two environment values, with runtime values overriding build-time values as in the current Google connector configuration:

```text
GITHUB_APP_CLIENT_ID
GITHUB_APP_SLUG
```

Both values are required for the connection flow. The App ID remains fixture metadata because device flow and user-token API calls do not use it. `.env.example` and the configuration documentation list the keys without environment-specific values. Staging build configuration supplies the approved values.

Changing any of these build-time values causes the Tauri build script to rerun.

## Architecture

### Rust modules

`src-tauri/src/connectors/github_auth.rs` owns:

- device-code creation;
- provider-directed polling and `slow_down` handling;
- cancellation and expiry;
- access-token refresh with single-flight coalescing;
- GitHub user lookup;
- installation and selected-repository discovery;
- provider error classification without token disclosure.

`src-tauri/src/connectors/github_store.rs` owns GitHub token custody. It mirrors the proven Google storage mechanics but uses a GitHub-specific token schema and Keychain service:

- release: `co.opensoftware.june.github`;
- debug: `co.opensoftware.june-dev.github`;
- Keychain account key: the stable numeric GitHub user ID as a string;
- debug plaintext fixture: separate from the Google fixture and available only behind the existing explicit development switch.

The stored zeroizing token value contains the access token, refresh token, access expiry, refresh expiry, and stable GitHub user ID. No token value is stored in SQLite.

### Tauri commands

Phase 0 adds GitHub-specific commands instead of stretching the Google-shaped `connectors_connect` request:

- `github_connect_start` requests a device code, stores the secret device code in managed Rust state, opens the verification URL, and returns only the user code, verification URL, and expiry.
- `github_connect_wait` polls according to GitHub's interval, stores successful tokens, resolves the GitHub user, refreshes installations and repositories, and returns the non-secret connection snapshot.
- `github_connect_cancel` cancels and clears the pending device flow.
- `github_connection_get` returns the cached non-secret connection snapshot.
- `github_installations_refresh` refreshes installations, permissions, and selected repositories from GitHub.
- `github_installation_open` opens the App installation-management URL in the system browser.
- `github_disconnect` removes local tokens and cached installation state. Provider-side authorization revoke is not required for local disconnect in Phase 0.

Only one device-flow attempt may be active at a time. A newer attempt replaces and cancels the older attempt.

Phase 0 supports one connected GitHub user per June profile. That user may have multiple GitHub App installations and selected repositories. Connecting a different GitHub user replaces the prior connection and its cached installation state after the new authorization succeeds.

### Frontend

The existing Plugins and connector settings surface adds a GitHub provider card without changing the Google card's behavior.

The connection UI shows:

- the GitHub-generated short user code;
- a copy action;
- the verification URL and browser-open action;
- pending, expired, canceled, denied, connected, setup-incomplete, and reconnect-required states;
- the connected GitHub login and avatar;
- installations and selected repositories;
- a manage-repositories action that opens the GitHub installation page;
- a disconnect action.

The user code is transient and must not appear in logs, telemetry, crash diagnostics, or persisted frontend state.

## Data model

Phase 0 uses GitHub-specific tables so the existing Google `connector_accounts.email NOT NULL` contract remains unchanged.

### `github_connections`

- `github_user_id` - stable numeric GitHub user ID, primary key;
- `login`;
- `avatar_url`;
- `status` - `connected`, `setup_incomplete`, or `reconnect_required`;
- `created_at`;
- `updated_at`.

### `github_installations`

- `installation_id` - stable GitHub installation ID, primary key;
- `github_user_id`;
- `owner_id`;
- `owner_login`;
- `owner_type`;
- `repository_selection` - `all` or `selected`;
- `permissions_json`;
- `suspended_at`;
- `last_refreshed_at`.

### `github_repositories`

- `repository_id` - stable GitHub repository ID, primary key;
- `installation_id`;
- `owner_login`;
- `name`;
- `full_name`;
- `is_private`;
- `is_archived`;
- `permissions_json`;
- `updated_at`.

These rows are a non-secret discovery cache, not an independent authorization grant. Later provider routes must bind to the current installation/repository intersection and fail closed when GitHub reports removal, suspension, revoke, or insufficient permission.

## Connection flow

1. The user selects Connect on the GitHub provider card.
2. Rust sends the public Client ID to GitHub's device-code endpoint.
3. June displays the returned short user code and opens GitHub's verification page.
4. Rust polls no faster than GitHub's returned interval.
5. On authorization, Rust stores the rotating access and refresh tokens in Keychain.
6. Rust resolves `GET /user`, `GET /user/installations`, and each installation's repository list.
7. SQLite receives only non-secret identity, installation, permission, and repository metadata.
8. The connection is `connected` when at least one accessible repository exists, including the staging `open-software-network/test-repo` fixture.
9. The connection is `setup_incomplete` when user authorization succeeds but no accessible installation/repository exists. June offers the installation URL rather than pretending the connection failed.

## Token lifecycle

- Access tokens within the existing expiry buffer are refreshed before use.
- Concurrent refresh requests coalesce behind one in-flight refresh.
- A refresh atomically replaces both rotated token values in Keychain.
- A provider `401` permits one refresh and one retry. A second `401` clears usable credentials and marks the connection `reconnect_required`.
- Device-flow denial, expiry, cancellation, and malformed responses never create a connected row.
- Local disconnect removes the Keychain entry and all cached GitHub rows.
- No access token, refresh token, or device code is included in `Debug`, error text, tracing fields, Tauri payloads, SQLite, or telemetry.

## Error handling

Phase 0 maps provider failures to stable application errors:

- `github_not_configured`;
- `github_connect_pending`;
- `github_connect_slow_down`;
- `github_connect_denied`;
- `github_connect_expired`;
- `github_connect_canceled`;
- `github_token_exchange_failed`;
- `github_refresh_failed`;
- `github_reconnect_required`;
- `github_installation_required`;
- `github_installation_suspended`;
- `github_repository_access_removed`;
- `github_rate_limited`.

Provider messages are sanitized. Rate-limit responses preserve only safe timing metadata such as retry-after or reset time.

## Security and privacy

- GitHub calls originate in June on the device.
- June API receives no GitHub token, installation token, repository content, issue content, pull-request content, or diff.
- The Client ID, App ID, and slug are public configuration.
- The GitHub MCP process does not exist in Phase 0 and therefore cannot receive any token.
- The staging App is installed only on explicitly selected repositories.
- Repository IDs and installation IDs are authoritative; owner/name strings are display metadata.
- A stale SQLite row never widens access after GitHub reports removal or revoke.
- The app ships no GitHub client secret or private key.

If live testing shows that a reusable App private key or a June API signer is required, Phase 0 stops. That new credential boundary requires a new ADR, a GitHub-specific threat-model update, and revised privacy copy before implementation continues.

## Verification

### Deterministic tests

- Device-flow pending, success, denial, expiry, cancellation, malformed response, and `slow_down` behavior.
- Polling never runs faster than the provider interval.
- Concurrent connection attempts replace the older attempt safely.
- Token serialization, zeroization shape, Keychain service separation, load, rotation, and deletion.
- Refresh fast path, expiry buffer, single-flight coalescing, atomic rotation, one-retry limit, and reconnect classification.
- Installation and repository persistence keyed by stable numeric IDs.
- Selected repository removal, suspension, revoke, and permission downgrade clear or disable stale state.
- No token or device code appears in errors, tracing, SQLite, or frontend DTOs.
- Existing Google connector tests remain unchanged and green.

### Live staging tests

- Connect a fresh June development build to `june-staging` with device flow.
- Discover `open-software-network/test-repo` and no unselected private sibling repository.
- Cancel, deny, and let a device code expire without leaving connected state.
- Refresh an expiring token and prove rotated token replacement.
- Remove `test-repo` from the installation and confirm it disappears on the next provider refresh and cannot be treated as connected.
- Re-add the repository and recover through explicit refresh.
- Suspend, unsuspend, uninstall, and reinstall the App.
- Disconnect locally and confirm the Keychain entry and cached GitHub rows are removed.
- Capture redacted logs and confirm June API receives no GitHub traffic or repository content.

## Acceptance criteria

- A user can complete device authorization from June and see the connected GitHub identity.
- June discovers the staging App installation and `open-software-network/test-repo` by stable IDs.
- Access and refresh tokens exist only in the GitHub Keychain entry.
- Token refresh works without a client secret or private key.
- Revoked, suspended, removed, expired, and canceled states fail closed with a recoverable UI state.
- No GitHub MCP server or write action is exposed.
- The existing Google connector remains behaviorally unchanged.
- Deterministic tests and the live staging walkthrough pass.
- No June API deployment is required.
