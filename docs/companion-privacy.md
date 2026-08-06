# Clovy Companion privacy and metadata

End-to-end encrypted content includes note titles/bodies, prompts, agent
messages/deltas/status payloads, curated model metadata, per-session model
selections, safe settings, recording controls, focus targets, phone attachment
bytes and metadata, granted-root labels, Mac file names and metadata, opaque
attachment references, generated-media references and chunks, bounded Computer
use approval descriptions/targets/decisions/status, operation results, and
protocol errors. Absolute Mac paths do not cross the protocol. Model metadata
includes the canonical provider, privacy class, and price label that Desktop
uses to explain the routing choice; the blind relay sees only ciphertext and
routing metadata. Device private/session keys and device credentials never
enter the SwiftUI application model. Pairing secrets are held only as transient
QR or manual-code input during bootstrap and are never published in a snapshot
or persisted by the application model. The explicit copy action places the
short-lived bootstrap capability on the system clipboard, where it may remain
in clipboard history after it expires. Desktop does not read the clipboard or
risk erasing newer content. The relay receives a device credential only for
verification and persists only the SHA-256 hash of its encoded authorization
value; it never receives the Noise pairing secret.

Clovy API necessarily observes the desktop's OS Accounts user id, linked device ids and
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
key. Both the key and cache file use after-first-unlock device-only protection
so a content-free background push can refresh the cache while the screen is
locked. Clovy still requires device-owner authentication before rendering it.
The cache supports rendering only and is not offline synchronization.

Selecting a model may change which upstream provider receives the next agent
request, the provider privacy class, and the credit price. The phone receives
those labels before selection, while Desktop remains responsible for applying
the provider and billing policy at run start. No service-managed provider key,
request content, account token, or raw model catalog is added to companion
traffic.

Generated-media references contain an opaque artifact id, media type,
dimensions or duration when available, and byte size. Full artifact bytes
cross only in bounded E2EE chunks and are verified against the repeated
SHA-256 digest. Desktop retains no companion-specific byte copy: its bounded
memory cache holds validated file handles only. If the user saves a verified
result to the system photo library, Photos owns that additional copy and its
retention; removing the desktop artifact or Clovy Companion cache does not
remove it.
