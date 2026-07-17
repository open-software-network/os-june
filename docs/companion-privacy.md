# June Companion privacy and metadata

End-to-end encrypted content includes note titles/bodies, prompts, agent
messages/deltas/status payloads, safe settings, recording controls, focus
targets, operation results, and protocol errors. Device private/session keys,
device credentials, and QR secrets never enter the SwiftUI application model.
The relay receives a device credential only for verification and persists only
its SHA-256 hash; it never receives the Noise pairing secret.

June API necessarily observes the desktop's OS Accounts user id, linked device ids and
public keys, device display names, link/revocation timestamps, APNs device
token, source IP, connection times, frame timing, routing pairs, and ciphertext
sizes. It stores trust metadata, device credential hashes, and APNs tokens, but
never stores relay frames
or undelivered ciphertext. Logs contain route/error classes and aggregate
counts, never payload bytes, token values, keys, device tokens, note text, or
prompt text.

APNs receives only a content-available background payload. It contains no
visible body, title, note id, prompt, response, operation id, or account data.
Push hints are correctness-independent and rate-limited per offline device.

The iOS privacy manifest declares the generated device identifier, linked user
identifier, connection/route usage metadata, and device trust metadata used for
app functionality. It also declares the system/light/dark preference stored in
UserDefaults under required-reason category CA92.1. The companion does not use
those values for tracking and declares no tracking domains.

The phone's recent snapshot cache is AES-GCM encrypted with a random Keychain
key and complete file protection. It supports rendering only and is not
offline synchronization.
