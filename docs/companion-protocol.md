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
proof. The phone generates an opaque device credential and submits only its
encoded UTF-8 value's hash during pairing. Desktop approval activates that
hash. The phone later presents the same encoded value with the `Device` scheme;
the relay hashes that representation and compares it without retaining the
plaintext. Noise separately authenticates the device's private key and protects
all content.

During an explicit pairing, the authenticated desktop may establish its relay
socket while the pairing is still pending, but pending phones remain unable to
connect or route frames. Before the relay exposes approval to the phone, the
desktop validates and stores the proposed device identity, marks the Noise
pairing secret ready locally, and confirms that relay socket is connected. A
confirmed remote approval failure rolls back that local readiness; an unknown
network outcome preserves it so an approved phone is never stranded between
the two boundaries. The relay also refuses to start its bounded persistence
step in the final 16 seconds of the pairing window. Postgres checks the pairing
expiry in the same transaction that activates the durable device link. Only a
durably activated link may finish in memory after the wall-clock expiry passes;
an expired transaction rolls back the device and link writes together. An
approval retry recognizes an already committed matching link and reconciles the
in-memory pairing instead of treating a lost commit response as an identity
conflict.

## Capabilities

The only grants are notes read/edit, agent read/chat/cancel, safe settings
read/edit, existing-recording state/pause/resume/stop, app focus, and
self-device read/revoke. Body-to-capability equality is validated before
dispatch.

Agent session and message reads go through typed frontend intents backed by
the current Hermes session APIs. The companion receives the same sanitized
display text as June Desktop: machine context, provider routing details,
reasoning, tool calls/results, approvals, secrets, and media internals stay on
the Mac. The always-mounted app shell serves reads even when the Agent screen
is closed. Send and cancel intents wake the existing Agent workspace.

Agent transcript pagination starts with the newest page and walks backward;
items within each page remain chronological so the mobile client can prepend
older pages without reordering a conversation. Pages keep encoded results
below the frame budget. An individual oversized display message is clearly
marked as truncated. Notes
whose editable title or content cannot fit safely in one frame are rejected
with an instruction to open them on the Mac; the companion never loads a
truncated note into its editor, which prevents an edit from overwriting unseen
content.

There is no variant for arbitrary Tauri/Hermes calls, recording start, note
delete, approvals, unrestricted mode, filesystem, shell, credentials,
connectors, updates, account deletion, or adding a device.

## Idempotency and reconnect

Mutations carry stable client operation ids. The desktop persists encrypted
response results keyed by device/operation and returns the prior result on a
retry. Results expire after seven days and are capped at 1,024 per device;
revocation removes prior results. Sequence state resets only after a fresh
authenticated Noise session. The client refreshes cursor-based lists after
foreground/reconnect. No offline control request is replayed.

Note edits carry `expectedRevision`; SQLite updates atomically only at that
revision. A mismatch returns a typed conflict with the current note.
