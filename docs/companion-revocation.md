# June Companion revocation

Desktop revocation first persists the relay revocation, deletes all links for
that device, closes its active relay socket, then marks the local desktop
record revoked. Future WebSocket authorization and routing return not found so
the endpoint cannot enumerate another user's device.

Self-revocation sends the encrypted allowlisted request when possible, calls
the device-credential-authenticated relay revocation endpoint, disconnects,
deletes the linked configuration, device credential, and device identity from
Keychain, and clears render state.

Revocation is per device. It does not sign out or revoke other devices. A
revoked device cannot reconnect, route/receive frames, or register a push token.
Relinking creates fresh device identity state through a new desktop-approved QR
pairing.

If the relay database is unavailable, production companion endpoints fail
closed. The desktop must not report successful revocation until the relay
write succeeds.
