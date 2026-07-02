# OS Accounts — metering backend (future work)

> **Superseded / historical.** This document specifies a *future* metering
> backend. That backend is now shipped; its canonical spec is
> [june-api-prd.md](june-api-prd.md) and `authorize`/`charge` is fully
> implemented in `june-api`. Kept for reference only — do not treat as current.

This app currently integrates OS Accounts for **identity only** (Login with Open
Software, read user + credit balance). That half runs entirely on-device in the
Rust core (`src-tauri/src/os_accounts.rs`) — no server required.

**Metering (charging OS Accounts credits for transcription / note generation)
is deliberately not implemented**, because it cannot be done safely from a
desktop binary. This document specifies the backend you'd add to enable it.

## Why a backend is mandatory

A desktop app is a **public client**: the `.app` ships to every user, so anything
compiled in is extractable. Metering needs two secrets, and **neither may live in
the binary**:

1. **The App API key (`osk_…`)** authenticates *this app* to OS Accounts and can
   charge **any** user's wallet. Leaked once → anyone drains anyone's credits.
2. **The OpenAI API key.** Today `providers/transcription.rs` and
   `providers/generation.rs` call `api.openai.com` directly with a local key. The
   moment usage is monetized, a baked-in key lets users extract it and run
   unlimited inference on *your* OpenAI bill, bypassing credits entirely.

So both the charge and the OpenAI call must move **server-side**, to a
confidential server users can't open up.

```
TODAY (identity only, unmetered)
  Rust core ──user token──▶ OS Accounts  (/me, /billing/balance)   ← implemented
  Rust core ──OpenAI key──▶ api.openai.com (transcribe, generate)  ← unchanged

METERED (this document)
  Rust core ──user token──▶ YOUR backend ──┬─ verify token (JWKS/ES256) → usr_ id
   (no osk_, no OpenAI key)                 ├─ POST /authorize  (osk_)  gate
                                            ├─ call OpenAI      (server key)
                                            └─ POST /charge     (osk_)  settle
```

## What the backend is

A small **OS Accounts resource server** holding both secrets. For each paid
request it:

1. **Verifies** the incoming OS Accounts access token locally against JWKS
   (ES256) to get the `usr_` id — no `/me` round-trip needed.
   See the skill's `references/verifying-tokens.md` (ready-made middleware for
   Hono / Fastify / Express / axum).
2. **`POST /authorize`** with the App API key + `{ user_id }` to gate before
   spending compute. On insufficient credits OS Accounts returns `error_code
   4301` → surface a "top up" prompt to the app.
3. Does the **actual work** (calls OpenAI with the server-held key).
4. **`POST /charge`** with the `authorization_id` from step 2, the **actual**
   credits used, and a **deterministic** `idempotency_key`.
   See `references/metering-and-billing.md`.

This is the standard "client brokers through your backend" pattern from the
skill's `references/tauri-desktop.md` → "Metering from a desktop app".

## Endpoints to add (suggested)

Mirror the two metered actions the app already has. Both take the user's OS
Accounts access token as `Authorization: Bearer <jwt>`.

```
POST /transcribe
  Authorization: Bearer <user access jwt>
  body: multipart audio (or a short-lived upload ref) + { title, context? }
  → 200 { text, language? }
  → 402 { error_code: 4301, message }   # insufficient credits → app shows top-up
  → 401                                  # bad/expired token → app refreshes + retries

POST /generate
  Authorization: Bearer <user access jwt>
  body: { title, transcript, manualNotes?, language?, existingGeneratedNote? }
  → 200 { content, titleSuggestion?, promptVersion }
  → 402 / 401 as above
```

### Pricing & idempotency

- **Credits are whole integers** (`$1 = 1000 credits`). Price each action in
  whole credits. Charge the **actual** amount after the OpenAI call (real audio
  seconds / token count), not an estimate.
- **`idempotency_key` must be deterministic per logical operation** — derive it
  from a stable id, e.g. `transcribe:<usr>:<sessionId>` and
  `generate:<usr>:<noteId>:<promptVersion>`. Never `Date.now()`/random, or
  retries double-charge. `idempotent_replay: true` in the response confirms a
  replay was deduped.

## What changes in this desktop app

Minimal, and isolated to the provider layer:

- `src-tauri/src/providers/transcription.rs` — replace the `transcribe_with_openai`
  path's target `https://api.openai.com/v1/audio/transcriptions` with
  `POST {BACKEND}/transcribe`, attaching the user's access token (read from the
  keychain via the existing `os_accounts` module) instead of the OpenAI key.
- `src-tauri/src/providers/generation.rs` — same swap for
  `https://api.openai.com/v1/responses` → `POST {BACKEND}/generate`.
- **Delete the OpenAI key from the client.** Drop `OPENAI_API_KEY` /
  `openai_api_key()` usage from `providers/mod.rs`; the key now lives only on the
  backend. The `mock` provider can stay for offline/dev.
- On a `402` (`4301`) response, show the existing top-up affordance
  (`os_accounts_top_up`) instead of a generic error.
- Expose a helper in `os_accounts.rs` to read the current access token for
  outbound calls (it's currently private to the module).

Everything else — recording, validation, recovery, dictation — is untouched.

## Prerequisites (registration)

Both identity (already built) and metering need the app registered with OS
Accounts (MVP: manual/admin). You receive:

- `app_id` (`app_…`) and the **App API key** (`osk_…`, server-only — never in
  this repo or the binary).
- An **allowlisted `redirect_uri`**. For the implemented loopback login that is
  `http://127.0.0.1:8765/callback` (the port is `OS_ACCOUNTS_LOOPBACK_PORT`,
  default `8765`).
- Service URLs in `OS_ACCOUNTS_URL` and `OS_ACCOUNTS_API_URL` — **required**,
  set in `.env` (there are no built-in defaults). Staging today:
  `https://os-accounts-portal-staging.up.railway.app` and
  `https://os-accounts-api-staging.up.railway.app`.

Until the redirect is allowlisted, login will fail at the OS Accounts page — that
is expected, not a client bug.

## Verification (when metering ships)

- A paid action succeeds **only** through your backend; `strings`/grep the built
  `.app` for `osk_` → **zero** matches (and no OpenAI key either).
- Insufficient credits returns `4301` → the app shows a calm top-up prompt
  linking to OS Accounts.
- Re-running the same operation reuses the `idempotency_key` →
  `idempotent_replay: true`, balance debited once.

## References (in the skill)

- `references/tauri-desktop.md` — desktop client side, "Metering from a desktop app".
- `references/verifying-tokens.md` — JWKS/ES256 token verification middleware.
- `references/metering-and-billing.md` — `authorize`→`charge`, balance, top-up.
