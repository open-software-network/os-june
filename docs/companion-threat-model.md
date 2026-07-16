# June Companion threat model

## Assets

Desktop OS Accounts tokens, mobile device credentials, device private keys, QR
provisioning secrets, session keys, note/chat/settings plaintext, recording
control authority, linked-device grants, and APNs signing material.

## Trust boundaries and mitigations

- A malicious network sees TLS. A malicious relay still sees only bounded
  Noise ciphertext and routing metadata.
- A stolen unlocked phone is limited by the explicit capability allowlist;
  app backgrounding locks and disconnects, and foreground access requires
  Face ID, Touch ID, or device passcode.
- A mobile device credential is issued only after desktop approval and is
  accepted only for that non-revoked linked device id. It cannot complete a
  Noise handshake without the device private key.
- A copied QR expires after five minutes and cannot complete without desktop
  approval. Noise XXpsk3 authenticates possession of the QR secret and both
  device identities.
- Replay, tampering, oversized payloads, stale controls, cross-user routes,
  duplicate connections, unbounded queues, and excessive frame rates fail
  closed.
- The mobile bundle has no OS Accounts token, OAuth client, OS Accounts App API
  key, provider key, APNs signing key, or relay secret.
- The desktop controller has no generic executor. The Hermes Gateway remains
  behind the existing control plane.

## Accepted risks

An OS-compromised endpoint can read data displayed on that endpoint. The relay
and OS Accounts observe account/device/IP/timing/size metadata. APNs observes
that a generic wake was sent. Push delivery and iOS background execution are
best effort. Post-quantum security, traffic padding, multi-desktop routing,
and peer-to-peer anonymity are not provided.

Production claims require review of the C ABI, Noise patterns, Keychain access
classes, pairing proof and device credential authorization, APNs configuration, app
signing, dependency provenance, and a penetration test.
