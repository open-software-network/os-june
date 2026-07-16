# June Companion protocol

The shared crate is `crates/june-companion-protocol`; desktop and iOS crypto
use `crates/june-companion-crypto`.

## Envelope and bounds

Protocol version 1 frames carry an operation id, monotonic per-session
sequence, issue and expiry times, required capability, and one typed body.
Control TTL is 30 seconds. Encoded plaintext is capped at 44 KiB, ciphertext
at 45 KiB, relay JSON at 64 KiB, text at 32 KiB, and pages at 100 items.
Unknown versions fail closed. Additive optional fields or new variants require
a version-aware compatibility test before shipping.

The relay envelope contains only routing metadata and base64 ciphertext. It
cannot express a desktop command or application payload.

## Crypto sessions

Pairing uses `Noise_XXpsk3_25519_ChaChaPoly_BLAKE2s`; the QR contributes a
32-byte single-use PSK and the transcript authenticates both static identities.
Linked reconnects use `Noise_KK_25519_ChaChaPoly_BLAKE2s` with the approved
static keys. Noise nonces reject replay and reordering/tampering. A fresh
handshake is required after 2^20 messages or 24 hours.

The relay pairing API receives only SHA-256 of the QR secret as a five-minute
proof. Desktop approval issues the phone an opaque device credential; the relay
stores only its hash. The credential authorizes one linked device at the relay,
while Noise authenticates that device's private key and protects all content.

## Capabilities

The only grants are notes read/edit, agent read/chat/cancel, safe settings
read/edit, existing-recording pause/resume/stop, app focus, and self-device
read/revoke. Body-to-capability equality is validated before dispatch.

There is no variant for arbitrary Tauri/Hermes calls, recording start, note
delete, approvals, unrestricted mode, filesystem, shell, credentials,
connectors, updates, account deletion, or adding a device.

## Idempotency and reconnect

Mutations carry stable client operation ids. The desktop persists encrypted
response results keyed by device/operation and returns the prior result on a
retry. Sequence state resets only after a fresh authenticated Noise session.
The client refreshes cursor-based lists after foreground/reconnect. No offline
control request is replayed.

Note edits carry `expectedRevision`; SQLite updates atomically only at that
revision. A mismatch returns a typed conflict with the current note.
