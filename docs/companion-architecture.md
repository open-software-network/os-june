# June Companion architecture

June Companion is a native SwiftUI iOS/iPadOS application in
`apps/june-companion/native-ios`. XcodeGen creates the checked-in Xcode project.
It is not a Tauri target and contains no WebView.

## Data path

```text
SwiftUI typed screens and app model
  -> Swift companion services and shared Rust Noise state machine
  -> outbound TLS WebSocket
  -> blind June API companion relay
  -> outbound TLS WebSocket
  -> typed Rust desktop companion controller
  -> June repositories, recording commands, and agent control plane
```

TLS protects each hop. Noise frames protect application data from the relay.
The relay parses only `version`, sender/recipient device ids, message id,
timestamp, and bounded ciphertext.

## Responsibility split

SwiftUI owns the composer-first chat, leading history drawer, native Notes and
Settings sheets, Dynamic Type, VoiceOver labels, Reduce Motion, light/dark appearance,
loading/error/conflict state, and typed decrypted DTOs. The application model
never receives tokens, private keys, session keys, APNs tokens, or raw
encrypted frames.

The Swift service layer owns the proof-gated pairing exchange, Keychain device
credential and identity, biometric/passcode gating, QR scanning, manual pairing
code validation, reachability, WebSocket reconnect, encryption calls, APNs
registration, lifecycle locking, encrypted cache IO, and redacted errors. It
has no OS Accounts client, callback, or token and never receives the desktop's
account session.

Rust owns the shared Noise state machine, the versioned protocol, the closed
desktop allowlist, note compare-and-swap, durable linked-device metadata, and
the blind relay. The companion generates its device credential and sends only
the hash of its encoded authorization value during pairing. June API stores
that hash; it hashes the same UTF-8 value when verifying a `Device`
authorization header and never stores the credential or QR secret.
The signed-in Desktop creates each pending pairing under its current OS Accounts
user. The short-lived QR proof authorizes one phone proposal to that pairing;
the relay takes the account only from the authenticated Desktop creation and
never from the phone.
Desktop device identities are keyed by OS Accounts user rather than a global
`current` Keychain slot, and local linked-device lists are filtered by that
same user id. Desktop sign-out disconnects the relay, revokes the user's
grants, marks local rows revoked, and removes that account's desktop identity
before tokens are cleared.

The always-mounted desktop app shell handles sanitized agent session and
message reads without changing the visible Mac view. Agent send and cancel
requests are queued briefly while the existing Agent workspace mounts, so the
consumer is advertised only after its Tauri listener is installed. The
companion reuses June's normal session, model, and transcript behavior rather
than creating a second agent control path.

## Authority and availability

The Mac is authoritative. The phone cannot run the embedded Hermes runtime,
start a recording, approve tools, read the filesystem, or use provider keys.
When the Mac is offline, control fails immediately and the UI says offline.
No control ciphertext is queued. The encrypted mobile cache only renders the
last successful snapshot while locked/offline and is not synchronization.

The first transport is relay-only. The interface leaves room for a future
Network.framework/Bonjour or ICE/TURN implementation without changing the
application protocol.

## Phala deployment finding

Phala's current networking documentation explicitly supports WebSocket ports
and states that a WebSocket stays on one instance for its connection lifetime,
while reconnects can land on another instance. There is no session affinity.
Durable trust state is Postgres-backed, while pairing and live connection state
remain per-process. The MVP must therefore run as exactly one relay replica;
multiple replicas require a shared pairing store and cross-instance ciphertext
router first. Official troubleshooting documents an outbound-connectivity
test, but does not promise APNs egress or publish a maximum WebSocket lifetime.
Production promotion requires live canaries for WebSocket idle duration,
connection limits, reconnect behavior, and APNs HTTP/2 egress.

## Native UI exception

Repository web CSS token and central-icon rules cannot apply literally to
SwiftUI. Mobile follows the same sentence case, two-weight, semantic-color,
and accessibility intent using the Open Software native design system. It uses
SF Symbols and platform controls rather than importing web icon packages.
The June shell and token implementation follow the native patterns in
`open-software-network/os-chat` at commit
`0f1cb72ac74030080cdfb426a953626e0f0a247b`: a composer-first canvas, leading
history drawer, quiet semantic surfaces, native sheets, and system light/dark
behavior. June adapts those patterns to its linked-desktop trust boundary and
does not copy Chat product features or account SDK dependencies.
