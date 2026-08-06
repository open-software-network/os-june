# Clovy Companion threat model

## Assets

Desktop OS Accounts tokens, mobile device credentials, device private keys,
pairing secrets, session keys, note/chat/settings plaintext, recording
control authority, linked-device grants, companion attachment bytes, granted
Mac browse roots, file names and metadata, generated image/video artifacts,
and APNs signing material.

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
- Phone attachments land only in a Clovy-owned app-data staging directory.
  Upload reservations, files, chunks, names, media types, hashes, counts, and
  lifetimes are bounded. Chunks are offset-checked and a commit succeeds only
  after the declared byte count and SHA-256 digest match. The staged file is
  non-executable, is never opened automatically, and reaches an agent run only
  through Clovy's existing attachment copier.
- Mac browsing begins with a root the user selected in Clovy Desktop Settings.
  There is no implicit home-directory grant. Roots are account-scoped,
  persisted by canonical path plus filesystem device and directory identity,
  individually revocable, and represented to the phone by opaque ids and
  local display labels rather than absolute paths. A different volume or
  directory appearing at the same path fails closed as a changed root.
- Browse requests accept relative paths only. Empty, absolute, parent,
  platform-prefix, hidden, non-UTF-8, unreadable, special-file, and symlink
  entries fail closed or are omitted. Every directory listing, file stat, and
  attachment use canonicalizes again and proves the target is still inside a
  still-granted root. Revoking a root invalidates outstanding references.
- Browse v1 returns bounded directory pages and regular-file metadata. It has
  no file-content read or download variant. A file becomes readable only when
  the phone includes its short-lived opaque reference in an agent message, at
  which point the Mac copies it through the normal safety-controlled
  attachment path.
- Generated media stays behind `mediaRead`, Noise E2EE, the current
  data-partition check, a 100 MiB source cap, and 31 KiB response chunks. The
  phone receives opaque artifact ids rather than paths. Desktop resolves only
  available tool-produced image/video rows inside the owning session
  workspace, rejects symbolic links, pins the validated file identity, and
  repeats one SHA-256 digest for end-to-end assembly verification.
- Media history and fetch recheck current data-partition membership after
  awaited artifact or file work. If the user switches partitions during a
  fetch, the already-read chunk is discarded rather than released.
- `modelEdit` permits a linked phone to change the privacy and credit-price
  characteristics of the next agent run. Desktop limits that authority to Auto
  plus its live recommended generation set, returns canonical privacy and
  price labels before selection, and rejects stale or uncurated ids. The
  capability is separate from agent chat and safe-settings access and remains
  visible on the linked device grant.
- A model mutation revalidates that the stored session belongs to the active
  desktop data partition immediately before the synchronous staging write. A
  change during an active run cannot cancel or reroute that run; it applies at
  the next run boundary.
- A remote Computer use approval is additionally bound to one SDK tool-call
  id, its explicit SDK interruption-id mapping, exact verified process/window/
  app identity, stored session id, monotonic 60-second desktop deadline,
  unique operation id, and monotonic Noise sequence. The peer must advertise
  `computerUseApprove` in its authenticated handshake. The first local or
  remote decision wins. A phone approval supplies one invocation permit only;
  it cannot create the broker's task-scoped app grant or bypass a Rust policy
  denial. A durable content-free receipt attributes the decision to the
  authenticated linked-device id.
- The mobile bundle has no OS Accounts client, callback, account token, OS
  Accounts App API key, provider key, APNs signing key, relay secret, or
  prebuilt bearer token. Pairing never copies the Desktop account session.
- The desktop controller has no generic executor. The agent harness and
  Computer use driver remain behind their existing Rust control planes.

## Accepted risks

An OS-compromised endpoint can read data displayed on that endpoint. The relay
and OS Accounts observe account/device/IP/timing/size metadata. APNs observes
that a generic wake was sent. Push delivery and iOS background execution are
best effort. The MVP relay is single-replica and a restart temporarily drops
availability. Post-quantum security, traffic padding, multi-desktop routing,
horizontal relay scale, peer-to-peer anonymity, and companion attachment
malware scanning are not provided. File names and metadata disclosed from an
approved root remain sensitive even without file contents. An attacker already
able to replace files on the Mac can race metadata checks; Clovy revalidates at
agent-send time, while a fully compromised endpoint remains outside the
companion boundary.

Saving a verified result to Photos creates a durable phone-controlled copy
whose retention can outlive both the desktop artifact and Clovy Companion's
encrypted snapshot cache. A cached open desktop handle can temporarily keep a
deleted artifact's disk blocks alive for up to 30 idle minutes.

Production claims require review of the C ABI, Noise patterns, Keychain access
classes, pairing proof and device credential authorization, APNs configuration,
app signing, dependency provenance, and a penetration test.
