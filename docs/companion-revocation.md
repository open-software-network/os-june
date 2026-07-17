# June Companion revocation

Desktop revocation first persists the relay revocation, deletes all links for
that device, closes its active relay socket, then marks the local desktop
record revoked. Future WebSocket authorization and routing return not found so
the endpoint cannot enumerate another user's device. The live socket uses a
policy-violation close frame with the non-sensitive reason `revoked`; the native
client treats only that exact close as revocation and treats other closes as
ordinary offline transitions.

Self-revocation sends the encrypted allowlisted request when possible, calls
the device-credential-authenticated relay revocation endpoint, disconnects,
deletes the linked configuration, device credential, and device identity from
Keychain, and clears render state. A live desktop revocation event performs the
same native cleanup immediately, including deletion of the encrypted cache and
its Keychain key, even if no SwiftUI screen is observing the connection.
The companion records self-revocation before asking the desktop to mirror it,
so an interrupted relay call is retried independently even after the desktop
has disabled the encrypted local path.

Before proposing a pairing, the companion records the relay address and device
id in Keychain. If any later pairing step fails, it keeps that record, the
device identity, and the credential until the relay confirms revocation. An
unavailable or ambiguous relay response retries at launch, foreground, refresh,
or before another pairing. Only a successful revocation, or a relay response
confirming that the credential is already unauthorized, deletes the local
authorization material.

Revocation is per device. It does not sign out or revoke other devices. A
revoked device cannot reconnect, route/receive frames, or register a push token.
Relinking creates fresh device identity state through a new desktop-approved QR
pairing.

Desktop OS Accounts sign-out is the account boundary: June first stops the
relay transport and waits for the active account-operation barrier, including
pairing creation and approval. Pairing insertion is synchronized with the
logout boundary so an in-flight relay response cannot recreate QR state after
the map is cleared. June then marks that account's local rows revoked and
removes its Keychain identity without requiring a token refresh or network
access. It then
best-effort revokes every locally known companion plus the account-scoped
desktop identity before clearing account tokens. Another user on the same Mac
receives a different desktop device id and cannot see the prior user's local
companion rows. Relay I/O and reconnect backoff are cancellation-aware; the
transport is force-joined within a bounded shutdown window. Pairing or other
account work that cannot stop makes sign-out fail safely without clearing the
account tokens.

If the relay database is unavailable, production companion endpoints fail
closed. The desktop must not report successful revocation until the relay
write succeeds.
