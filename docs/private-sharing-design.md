# Private link sharing (JUN-308)

## Product contract

Sharing is deliberately a bearer-link flow:

1. The owner clicks **Share**.
2. They may enable **Require a passcode** and choose a passcode of at least
   eight characters.
3. **Create link** creates one encrypted snapshot, reveals its URL, and copies
   it to the clipboard.
4. **Copy** copies the URL again.
5. Once a link exists, a link action beside the current breadcrumb copies it
   without reopening the Share dialog.
6. Anyone with the link can view without an OS Accounts sign-in. A protected
   link also requires the separately shared passcode.
7. **Stop sharing** revokes the link for everyone.

The link and passcode are transferable. There is no recipient list,
per-recipient audit, or per-recipient revocation. Stopping a share cannot erase
content someone already viewed or copied.

Notes cannot be shared while recording, validating, transcribing, or
generating. Agent sessions cannot be shared until their history is hydrated.
Shares are immutable snapshots; later source edits do not update a link.

## Cryptographic model

- **Content key (CK):** random 256-bit key generated in the owner webview.
  AES-256-GCM encrypts the canonical note/session JSON under CK with a random
  96-bit IV.
- **Link key (LK), no passcode:** random 256-bit key generated in the owner
  webview. AES-256-GCM wraps CK under LK. LK travels only in the URL fragment.
- **Link key, passcode:** the viewer derives LK from the passcode and a random
  128-bit salt using PBKDF2-HMAC-SHA-256 with 600,000 iterations. The salt,
  never the passcode or LK, travels in the URL fragment.
- June API stores ciphertext, IVs, and the wrapped CK. URL fragments are not
  sent in HTTP requests, so the server never receives LK, the salt, or the
  passcode.

New fragments are versioned by shape:

```text
#link.{invite_id}.key.{base64url(LK)}
#link.{invite_id}.pass.{base64url(salt)}
```

The `invite_id` is an opaque 160-bit server-generated id. It is sent to the
anonymous link-view endpoint to select the wrapped CK. Possession of both the
opaque share id and invite id authorizes fetching ciphertext; decryption still
requires the fragment material and, when enabled, the passcode.

Passcodes protect against casual forwarding or an accidentally exposed link,
not determined offline guessing. The browser can test guesses against the
downloaded AES-GCM envelope, so weak passcodes remain weak. The UI therefore
requires eight characters and tells owners to send the passcode separately.

## Server representation and API

The existing `shares` and `share_invites` tables remain the persistence model.
New bearer links use exactly one reserved ACL row with the non-deliverable
address `link@share.invalid`. This keeps the wire/storage migration small while
making the authorization boundary explicit.

Owner endpoints remain authenticated:

- `POST /v1/shares` creates ciphertext plus the single reserved envelope.
- `GET /v1/shares/{share_id}` lets the owner reload link metadata.
- `DELETE /v1/shares/{share_id}` soft-deletes the share and immediately clears
  ciphertext.

The new public endpoint is:

- `GET /v1/shares/{share_id}/link-view?link={invite_id}`

It returns ciphertext, IV, envelope, and envelope IV only when the share is
live and the invite row is live, matches the opaque id, and has the exact
reserved address. It is rate-limited by client address and otherwise returns
the same `share_not_found` response for missing, deleted, revoked, or wrong
rows.

## Backward compatibility

Previously issued email-invite links retain their OS Accounts authentication.
The anonymous endpoint refuses every non-reserved invite row, so knowing an old
invite id cannot downgrade it to bearer access. The browser viewer recognizes
the new `link.*` fragment and uses anonymous viewing; legacy fragments continue
through the authenticated viewer flow.

The desktop surfaces an existing invite-style share as legacy and requires the
owner to stop it before creating a new simple link. It never silently converts
or broadens an existing share.

## Local owner state

The profile-scoped SQLite store retains CK and one link record so the owner can
copy or revoke the link after restart. Existing key storage is reused:

- a 32-byte link record is an unprotected LK;
- a 16-byte link record is a passcode salt.

The passcode itself is never stored. After reopening the app, June can copy the
protected link again but cannot recover or display its passcode. Changing or
removing a passcode requires stopping the share and creating a new link.

Deleting a shared note/session revokes its remote share first and then removes
local keys. `share_not_found` is accepted as already absent for deletion so a
stale mapping cannot make local content permanently undeletable; other errors
fail closed.

## Viewer

The static `/s/{share_id}` shell has a strict self-only CSP and no analytics.
Production links use `https://june.link/s/{share_id}#…`. That hostname is served
by an isolated viewer-only June API CVM with its own ingress and certificate;
it reads the same encrypted-share database but cannot create or mutate shares
or invoke product APIs. `https://june-api.opensoftware.co` remains on its own
CVM and ingress. Staging and local builds keep the viewer on their configured
API origin. This preserves the viewer's self-only network policy while keeping
production links short and branded, and makes a june.link DNS/certificate
failure incapable of taking the primary API off port 443.

For a new link it:

1. parses the fragment;
2. fetches the ciphertext/envelope through `link-view`;
3. either reads LK from the fragment or asks for a passcode and derives LK;
4. unwraps CK and decrypts the canonical payload in WebCrypto;
5. renders a small escaped Markdown subset or session transcript.

No plaintext, content key, link key, or passcode is sent to June API.

## Required validation

- no-passcode link round-trip decrypts the exact payload;
- passcode derivation is deterministic for the same passcode/salt;
- anonymous link-view serves only the reserved ACL row;
- legacy email invites still require authenticated viewer access;
- stopped/deleted/wrong links are indistinguishable;
- local persistence failure rolls a newly-created remote share back;
- all close paths are blocked while link creation is in flight;
- note/session deletion revokes before removing the source.
