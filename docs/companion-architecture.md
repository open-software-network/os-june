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

SwiftUI owns screens, iPhone tabs, iPad sidebar/detail layout, Dynamic Type,
VoiceOver labels, Reduce Motion presentation, light/dark appearance,
loading/error/conflict state, and typed decrypted DTOs. The application model
never receives tokens, private keys, session keys, APNs tokens, or raw
encrypted frames.

The Swift service layer owns the proof-gated pairing exchange, Keychain device
credential and identity, biometric/passcode gating, QR scanning, reachability,
WebSocket reconnect, encryption calls, APNs registration, lifecycle locking,
encrypted cache IO, and redacted errors. It never receives the desktop's OS
Accounts session.

Rust owns the shared Noise state machine, the versioned protocol, the closed
desktop allowlist, note compare-and-swap, durable linked-device metadata, and
the blind relay. June API stores a hash of the mobile device credential, never
the credential or QR secret.

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
while reconnects can land on another instance. There is no session affinity,
so durable trust state is Postgres-backed and live connection state remains
per-process. Official troubleshooting documents an outbound-connectivity test,
but does not promise APNs egress or publish a maximum WebSocket lifetime.
Production promotion therefore requires live canaries for WebSocket idle
duration, connection limits, reconnect distribution, and APNs HTTP/2 egress.

## Native UI exception

Repository web CSS token and central-icon rules cannot apply literally to
SwiftUI. Mobile follows the same sentence case, two-weight, semantic-color,
and accessibility intent using the Open Software native design system. It uses
SF Symbols and platform controls rather than importing web icon packages.
