# Companion security review checklist

- Confirm the Noise XXpsk3 and KK pattern roles, transcript identity checks,
  replay behavior, rehandshake limits, zeroization, FFI pointer contracts, and
  pinned dependency provenance/licenses/advisories.
- Confirm Keychain access classes, deletion paths, device-authentication policy,
  encrypted cache key separation, file protection, and that Curve25519 is not
  described as Secure Enclave-backed.
- Confirm the QR proof is derived from a 32-byte secret, compared in constant
  time, expires after five minutes, and gates the device proposal without
  exposing the Noise secret to the relay.
- Confirm device credentials are generated with the system random source,
  never returned by the pairing API, stored only in Keychain on-device and as a
  hash server-side, bound to one linked device id, compared without plaintext
  retention, and rejected immediately after revocation.
- Confirm the SwiftUI-to-service API is high-level and typed; tokens, private
  keys, APNs tokens, raw frames, paths, commands, and credentials never cross
  into the application model.
- Confirm relay device/link persistence, strict Desktop OS Accounts verification,
  cross-user/non-linked/revoked rejection, frame/rate/queue/connection bounds,
  bounded pairing attempts, zero offline retention, and redacted logs/metrics.
- Confirm desktop capability equality, no generic executor, note CAS, durable
  pre-dispatch mutation reservations, separate completed/pending retention
  bounds, sequence reset only after handshake, and immediate online revocation.
- Confirm APNs payload is content-free and correctness does not depend on wake.
- Confirm production runs one companion relay replica until shared pairing,
  routing, and revocation propagation have an independent review.
- Run source/archive secret scans, dependency audit, fuzz/property tests for
  protocol decoding, concurrency/load tests, and endpoint/mobile penetration
  tests before any production-ready claim.
