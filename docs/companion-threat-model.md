# June Companion threat model

## Assets

Desktop OS Accounts tokens, mobile device credentials, device private keys,
pairing secrets, session keys, note/chat/settings plaintext, recording
control authority, linked-device grants, and APNs signing material.

## Trust boundaries and mitigations

- A malicious network sees TLS. A malicious relay still sees only bounded
  Noise ciphertext and routing metadata.
- A stolen unlocked phone is limited by the explicit capability allowlist;
  app backgrounding locks and disconnects, and foreground access requires
  Face ID, Touch ID, or device passcode.
- A mobile device credential is generated on-device and only its hash is
  activated by desktop approval. It is accepted only for that non-revoked
  linked device id and cannot complete a Noise handshake without the device
  private key.
- A copied QR or manually entered pairing code expires after five minutes, can
  claim only one candidate phone, and cannot complete without explicit approval
  on the signed-in Desktop. Both carry the same bootstrap capability. The
  Desktop-created pairing fixes the OS Accounts user; the phone cannot supply
  or change it. Noise XXpsk3 authenticates possession of the pairing secret and
  both device identities.
- Mobile rejects bootstrap expiries beyond five minutes plus one minute of
  clock skew, also enforces a monotonic local wait deadline, and lets the user
  cancel an in-flight pairing.
- A manually copied code can be observed by software with clipboard access.
  It may remain in clipboard history after expiry. Desktop does not read or
  automatically clear the clipboard because a non-atomic cleanup could erase
  newer content. Expiry and explicit device approval remain the authorization
  backstops.
- Replay, tampering, oversized payloads, stale controls, cross-user routes,
  duplicate connections, unbounded queues, and excessive frame rates fail
  closed.
- The mobile bundle has no OS Accounts client, callback, account token, OS
  Accounts App API key, provider key, APNs signing key, relay secret, or
  prebuilt bearer token. Pairing never copies the Desktop account session.
- The desktop controller has no generic executor. The Hermes Gateway remains
  behind the existing control plane.

## Accepted risks

An OS-compromised endpoint can read data displayed on that endpoint. The relay
and OS Accounts observe account/device/IP/timing/size metadata. APNs observes
that a generic wake was sent. Push delivery and iOS background execution are
best effort. The MVP relay is single-replica and a restart temporarily drops
availability. Post-quantum security, traffic padding, multi-desktop routing,
horizontal relay scale, and peer-to-peer anonymity are not provided.

Production claims require review of the C ABI, Noise patterns, Keychain access
classes, pairing proof and device credential authorization, APNs configuration,
app signing, dependency provenance, and a penetration test.
