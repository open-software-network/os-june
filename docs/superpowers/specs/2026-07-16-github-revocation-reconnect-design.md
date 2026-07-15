# GitHub revocation reconnect design

## Context

GitHub App user authorization and GitHub App installation are separate. A user
can revoke June's authorization while leaving the `june-staging` App installed
for `open-software-network/test-repo`.

Live staging QA reproduced a fail-closed recovery defect. After the user
revoked `june-staging` under **Authorized GitHub Apps**, June refreshed with the
stored device-flow credential but remained visibly `Connected` with one cached
repository and showed the generic sanitized refresh failure.

Non-secret evidence showed that SQLite remained `connected` with one
installation and one repository, and the GitHub Keychain entry remained
present. A temporary debug-only probe logged no credential, provider body, or
raw error text. It proved that GitHub returned HTTP 200 with a parsed
`incorrect_client_credentials` error. The unchanged public Client ID had
successfully rotated the same device-flow grant before revocation.

Two existing assumptions caused the visible failure:

1. The refresh protocol did not treat `incorrect_client_credentials` as an
   invalid stored grant, so it preserved the revoked credential and cached
   snapshot as if the failure were transient.
2. A terminal refresh error can mutate SQLite to `reconnect_required`, but the
   Tauri refresh command emits `june://connectors-changed` only on success. The
   open settings view can therefore retain the old connected DTO until another
   reload.

## Decision

June will treat the exact refresh error `incorrect_client_credentials` as a
terminal stored-grant failure when it arrives on the refresh protocol's
existing definitive HTTP statuses, 200 or 400.

The terminal path remains unchanged:

- best-effort delete the unusable GitHub Keychain entry;
- persist the connection status as `reconnect_required`;
- return the sanitized `github_reconnect_required` application error;
- retain non-secret installation and repository metadata in SQLite for
  recovery, but never present it as currently authorized.

The Tauri refresh command will emit the existing
`june://connectors-changed` event after a successful refresh and after a
`github_reconnect_required` failure. Event delivery remains best-effort and
cannot mask the original result. Other refresh failures do not emit because
they do not mutate connector state.

The existing settings listener reloads authoritative connector state. No new
frontend fetch, event, DTO, copy, or component state is added.

## Security boundary

The protocol continues to parse a bounded response from GitHub's fixed HTTPS
token endpoint with redirects disabled. It accepts only exact allowlisted
error codes on the existing definitive 200 or 400 statuses.

This change does not trust arbitrary provider bodies and does not broaden the
definitive status set. Redirects, 401, 429, 5xx, malformed responses, and
unknown errors remain transient and sanitized. A false positive can only
force the user to authorize again; it cannot widen repository access or expose
credentials.

Treating `incorrect_client_credentials` as terminal is appropriate for stored
device-flow custody because the current Client ID cannot refresh that grant.
This covers both the live revocation behavior and a build that intentionally
changes GitHub App registrations: tokens issued to the old client must be
replaced through a new device flow.

No token, device code, provider response body, or Keychain value is logged,
persisted in SQLite, sent through Tauri, or routed through June API.

## User experience

After revocation and the next GitHub refresh:

1. June removes the unusable local credential.
2. The settings row changes immediately to **Reconnect required**.
3. Cached repositories are no longer presented as connected or available in
   the details surface.
4. The existing **Reconnect** action starts device flow.
5. Successful authorization discovers the still-installed App and restores
   **Connected** with the repositories currently selected on GitHub.

The GitHub App installation and selected repository are not changed by the
revocation recovery path.

## Alternatives considered

### Reload connection state in the GitHub row

Rejected because it would duplicate the settings-level connector event path,
couple the row to another Tauri read command, and add a second UI race.

### Return `reconnect_required` as a successful refresh DTO

Rejected because a terminal credential failure should remain an error. Turning
it into success would weaken the refresh command contract and complicate other
callers.

### Add a webhook for authorization revocation

Rejected because Phase 0 is direct desktop-to-GitHub and intentionally has no
webhook, signer, backend GitHub secret, or June API route. The next explicit
refresh is sufficient for this local connector slice.

## Verification

Test-first coverage will prove:

1. HTTP 200 with exact `incorrect_client_credentials` returns
   `RefreshOutcome::InvalidGrant`.
2. Unknown errors and errors on redirects, 401, 429, and 5xx remain sanitized
   transient failures.
3. Discovery unauthorized followed by the live refresh response deletes
   custody, persists `reconnect_required`, and performs no second discovery.
4. The Tauri command's event decision emits for success and
   `github_reconnect_required`, but not for transient failures.
5. Existing frontend event/listener and reconnect-required row tests remain
   green without frontend changes.

Live staging QA will reuse the currently revoked authorization. Refresh must
remove the Keychain entry, persist `reconnect_required`, and change the visible
row immediately. Completing device flow must restore `Connected` with only
`open-software-network/test-repo`.

## Scope

The correction is limited to GitHub refresh classification, terminal-state
event synchronization, their tests, and QA evidence. It adds no package,
permission, GitHub write operation, repository mutation, database migration,
frontend copy, June API route, client secret, private key, installation token,
or webhook.

No ADR is needed because the change repairs an approved fail-closed behavior
inside the existing protocol and event boundaries. It introduces no
hard-to-reverse architecture or wire contract.
