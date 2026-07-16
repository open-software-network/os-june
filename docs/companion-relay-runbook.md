# Companion relay runbook

## Required production configuration

Set `JUNE__COMPANION__DATABASE_URL`. Companion endpoints are disabled outside
local development if Postgres connect, migration, or snapshot load fails. Run
the June API migration before traffic and verify active device/link counts load
without identifiers in logs.

Expose the existing June API HTTPS port with WebSocket upgrade support. The
desktop calls `/v1/companion/relay?deviceId=...` with its normal OS Accounts
bearer. A desktop-approved phone uses its opaque `Device` credential, whose
hash is stored with the linked device. Do not expose a desktop port.

## Limits

Relay JSON is 64 KiB maximum, each socket allows 120 inbound frames/minute,
has one 64-frame outbound queue, and one connection per device. Backpressure
disconnects rather than growing memory. Offline ciphertext retention is zero.
Controls expire after 30 seconds. Opaque APNs wakes have a 30-second per-device
cooldown.

## Health and canary

Use `/livez` and `/readyz`, then pair two test devices. Verify a 65 KiB frame,
cross-user route, revoked device, and duplicate socket are rejected. Hold an
idle WebSocket longer than the expected mobile/desktop heartbeat window and
force reconnects during an instance replacement. Phala has no session affinity
on reconnect, so confirm the Postgres snapshot authorizes the new instance.

Before enabling APNs, run an HTTP/2 egress canary to Apple's sandbox endpoint.
Phala documents outbound connectivity diagnostics but does not guarantee APNs
egress or a maximum WebSocket lifetime; keep both checks in deploy promotion.

## Incident response

For suspected routing/auth compromise, disable the companion database config
and redeploy to fail closed, preserve redacted request/security logs, rotate
APNs and database credentials, revoke affected device rows, and require fresh
pairing. Never turn on plaintext payload logging for diagnosis.
