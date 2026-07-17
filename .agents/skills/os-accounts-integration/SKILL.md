---
name: os-accounts-integration
description: >-
  Integrate consumer apps, Tauri desktop clients, or backend services with OS
  Accounts, the Open Software identity and credit-billing platform. Use when adding
  Login with Open Software, PKCE callback handling, /me, access-token verification
  with JWKS/ES256, auth middleware for Hono/Fastify/Express/Rust, top-up links,
  credit balance reads, or metered authorize->charge usage with an osk_ App API
  key. Trigger on mentions of OS Accounts login, credits, wallet, metering,
  Action tokens, Grants, Holds, usr_/agt_/agts_/txn_ ids, osk_ keys, or token
  validation. Includes HTTP contract plus Next.js App Router BFF, backend, and
  Tauri references.
---

# OS Accounts integration

OS Accounts is the Open Software network's **identity + billing** platform: one
login and one credit wallet shared across every app. Your app **depends on** OS
Accounts (the arrow points app → accounts, never the reverse). It is the source
of truth for *who the user is* and *how many credits they have*. Your job as a
consumer is small and well-defined: **federate login**, **verify the user on your backend**, and **meter usage**.

This skill teaches the HTTP contract (works from any stack) and gives proven
**Next.js (App Router)** consumer code plus **backend auth-middleware** (Hono,
Fastify, Express, Rust). Read this file, then open the reference that matches the
task:

## Route the request first

| If the user asks for... | Open first | Non-negotiable answer |
|---|---|---|
| Next.js login, session, callback, or BFF | [auth-flow.md](references/auth-flow.md), then [bff-and-envelope.md](references/bff-and-envelope.md) | PKCE, httpOnly cookies, no tokens in client JS. |
| Paid actions, credits, metering, or top-up | [metering-and-billing.md](references/metering-and-billing.md) | `authorize` before `charge`; deterministic `idempotency_key`; top-up links to OS Accounts. |
| Backend-only auth, API middleware, AI proxy auth | [verifying-tokens.md](references/verifying-tokens.md) | Verify ES256/JWKS locally; exact `iss`/`aud`; cache JWKS. |
| Tauri, desktop, mobile, CLI, deep link, loopback | [tauri-desktop.md](references/tauri-desktop.md), then [testing-and-troubleshooting.md](references/testing-and-troubleshooting.md) | Public client: PKCE + system browser + keychain; broker metering through a backend. |
| "Can I put `osk_` in the client/binary?" | [tauri-desktop.md](references/tauri-desktop.md), [metering-and-billing.md](references/metering-and-billing.md) | No. Refuse that design and add a backend broker that holds the App API key. |
| Staging/local failure, Privy origin error, redirect allowlist, token exchange debugging | [testing-and-troubleshooting.md](references/testing-and-troubleshooting.md) | Diagnose the failing hop before changing code. |

- **[references/auth-flow.md](references/auth-flow.md)** — Login with Open Software: the redirect + PKCE + one-time-code exchange, session cookies, refresh/rotation, logout.
- **[references/metering-and-billing.md](references/metering-and-billing.md)** — `/me`, the server-to-server `authorize`→`charge` contract, idempotency, balance, and the top-up hand-off — for both a BFF and a **standalone backend** that identifies the user from a verified token (the pattern a desktop/mobile/CLI client brokers through).
- **[references/bff-and-envelope.md](references/bff-and-envelope.md)** — the same-origin BFF (httpOnly cookie → Bearer), the `node:http` forwarder, the `ApiResponse` envelope, env setup, and error codes.
- **[references/verifying-tokens.md](references/verifying-tokens.md)** — verify an OS Accounts access token in a **backend with no frontend** (AI proxy, API, microservice): JWKS + ES256, with ready-made auth middleware for Hono, Fastify, Express, and Rust (axum).
- **[references/tauri-desktop.md](references/tauri-desktop.md)** — **Tauri (v2) desktop app**: PKCE login via deep link / loopback, tokens in the OS keychain (not the webview), reading the user/balance from the Rust core, and why metering must be brokered through your backend (the App API key can't ship in a binary).
- **[references/testing-and-troubleshooting.md](references/testing-and-troubleshooting.md)** — staging/local runbook, redirect allowlist checks, Privy origin/domain checks, manual `/auth/token` exchange, and common failure diagnosis.

## Mental model: capabilities and auth modes

| Capability | Who calls | Auth | Endpoints |
|---|---|---|---|
| **Identity** — sign in, read the user | the browser, via your **BFF** | the user's **access JWT** (httpOnly cookie → `Bearer`) | `GET {ACCOUNTS}/login`, `POST /auth/token`, `POST /auth/refresh`, `POST /auth/logout`, `GET /me` |
| **Verify a token** — authenticate an incoming request in a backend (AI proxy / API) with no frontend | your **backend** | the caller's **access JWT**, verified locally against **JWKS** (ES256) | `GET {API}/.well-known/jwks.json` |
| **Metering** — gate + charge usage | your **backend**, server-to-server | your **App API key** (`osk_…`, `Bearer`) + the per-call **Action token** (`agts_…`) on `/charge` | `POST /authorize`, `POST /charge` |
| **Top-up** — add credits | the browser/system browser | none | open/link to `{ACCOUNTS}` |

Never cross the two auth modes: user JWTs never call `/authorize`/`/charge`; the
App API key never touches the browser.

## Hard secrets rules

- Never commit a real `osk_` App API key, access token, refresh token, Privy secret, GitHub test password, or copied bearer token.
- Never place `OS_ACCOUNTS_APP_API_KEY` in a Tauri `.env`, frontend `.env`, `NEXT_PUBLIC_*`, webview code, mobile app bundle, or distributed binary.
- If the user pastes a real key or token, use it only for the shortest necessary one-off backend/API probe. Do not echo it back in logs, docs, commits, PRs, or final answers.
- Before committing integration work, grep staged files for `osk_`, `access_token`, `refresh_token`, `PRIVY_APP_SECRET`, `GITHUB_TOKEN`, and known test-account passwords.
- For desktop/mobile/CLI clients, the App API key lives only in a backend broker. If no backend exists, the app can do identity-only but cannot safely meter paid actions.

## Golden rules (and why they matter)

1. **Own no platform state.** The hosted OS Accounts login page performs the actual sign-in — the upstream identity provider is OS Accounts' concern, never yours, so you never embed a login SDK or hold an upstream provider token. Don't keep your own user/credit/session tables either. If you find yourself modelling a wallet, stop — that lives in OS Accounts. Duplicating it is how balances drift.
2. **The App API key is server-only.** It authenticates *your app* and a leaked key can charge *any* user. Never expose it to the browser — no `NEXT_PUBLIC_*`, no client bundle. Read it only in server code.
3. **Tokens live in httpOnly cookies.** Never put an access/refresh token in a URL, `localStorage`, or anything JS can read. The browser talks to your BFF; the BFF attaches the `Bearer` server-side.
4. **`authorize` → `charge` is one mandatory sequence (B-shaped) with an Action token.** Always call `/authorize` first with `{user_id, action, estimate_credits, hold_ttl_seconds}` — the platform reserves `estimate_credits` as a **Hold**, mints a single-use **Action token** (`agts_…`), and returns it plus a public `grant_id` (`agt_…`), the `cap_credits`, and `expires_at`. Then call `/charge` with `{token, credits, idempotency_key}` and the App API key — both credentials are required, and `credits` must be `≤ cap_credits`. A successful settle burns the token; the unused `cap − credits` delta is released back to the wallet.
5. **`idempotency_key` must be deterministic per logical operation** — derive it from the unit of work (e.g. an order id), never from `Date.now()`/a random per-call value. The charge path dedupes on it; a time-based key defeats that and double-charges on retry. Same `(token, idempotency_key)` replays; same token, different key after settle is `409 grant_already_used`.
6. **Credits are integers. `$1 = 1000 credits` (1 credit = `$0.001`).** Never use floats for money. To show USD, read `usd_millis` from the balance and divide by 1000 — don't infer dollars from the credit count. Price actions in whole credits.
7. **`app_id` comes from your key, not the body.** The API derives it from the App API key; any `app_id` you send is ignored. Don't bother sending it.
8. **You never grant credits.** Credits are granted only by OS Accounts after a verified Stripe webhook. For top-ups, open/link the user to OS Accounts in the browser — don't build checkout, don't credit balances yourself.
9. **Check the envelope, not just the HTTP status.** Every JSON response is `{ data, success, error_code?, message? }`. `error_code` `3001` means the access token expired → refresh once and retry (the BFF does this for you).
10. **Under Bun, the BFF forwards with `node:http`, not `fetch`** (Bun streaming bug #29515). The reference forwarder handles this.
11. **Verify tokens the strict way.** A backend that authenticates requests itself must require `alg=ES256`, a known `kid`, exact `iss`/`aud`, and `exp` with small leeway, checked against **cached** JWKS — never trust the token's own `alg`, and never fetch JWKS per request. See [verifying-tokens.md](references/verifying-tokens.md).

## Integration checklist

1. **Register the App and OAuth client** in the OS Accounts Admin console. You receive an `app_id` (`app_…`), an OAuth `client_id` (`ocl_…`), and an App API key (`osk_…`). Allowlist the App origin and the OAuth redirect URI (`{APP_ORIGIN}/auth/callback`).
2. **Set env**: `OS_ACCOUNTS_URL`, `OS_ACCOUNTS_API_URL`, `APP_ORIGIN`, `OS_ACCOUNTS_CLIENT_ID`, and server-only `OS_ACCOUNTS_APP_API_KEY`. See [bff-and-envelope.md](references/bff-and-envelope.md).
3. **Add the BFF + server API client** (`node:http`, envelope-aware, refresh-on-`3001`). → [bff-and-envelope.md](references/bff-and-envelope.md)
4. **Add login**: `GET /auth/start` (redirect + PKCE + OAuth `client_id` + scopes) and `GET /auth/callback` (code exchange → httpOnly session). → [auth-flow.md](references/auth-flow.md)
5. **Read the user** via `GET /me` through the BFF.
6. **Meter paid actions server-side**: `/authorize` with `{user_id, action, estimate_credits, hold_ttl_seconds}` to reserve a Hold and mint an Action token, then `/charge` with `{token, credits, idempotency_key}` and the App API key. Workers treat the token as opaque (don't parse it) and read `cap_credits`/`expires_at` from the `/authorize` response. → [metering-and-billing.md](references/metering-and-billing.md)
7. **Send users to top up** by linking/opening `{OS_ACCOUNTS_URL}` in the browser.
8. **Verify**: login round-trips and sets httpOnly cookies; `/me` returns the `usr_` id + handle; a paid action debits the balance; repeating it with the same `idempotency_key` returns `idempotent_replay: true` and does **not** double-charge; grep the client bundle to confirm no `osk_` key and no tokens leaked.

**Backend services (no frontend)** — building an AI proxy, API, or microservice that only **receives** OS Accounts tokens? Skip the BFF and login routes: verify the incoming token (JWKS/ES256) with the middleware in [verifying-tokens.md](references/verifying-tokens.md) to get the `usr_` id, then optionally `authorize`→`charge` with your App API key.

**Desktop apps (Tauri)** — a desktop app is a **public client**: no server origin, no httpOnly cookie, and it can ship no secret. Log in with PKCE via a deep link or loopback, keep tokens in the **OS keychain** (Rust core, never the webview), and **broker metering through your backend** — the App API key must never be embedded in the binary. See [tauri-desktop.md](references/tauri-desktop.md).

## Endpoint quick reference

```
# Identity (user access JWT, via BFF) ───────────────────────────────
GET  {ACCOUNTS}/login?client_id=&redirect_uri=&scope=&state=&code_challenge=&code_challenge_method=S256
POST {API}/auth/token    { grant_type:"authorization_code", code, code_verifier, redirect_uri }
                          → { access_token, refresh_token }
POST {API}/auth/refresh  { refresh_token } → { access_token, refresh_token }   # rotates
POST {API}/auth/logout   { refresh_token }
GET  {API}/me            → { id:"usr_…", handle, email, display_name, avatar_url, avatar_seed }
PATCH {API}/me           Bearer user JWT with `profile:write`
                          { avatar_seed:"v1:<printable ASCII payload>" }  # 4..128 chars total
                          # send null to clear the stored seed
                          → updated `/me` shape

# Avatar v1 presentation ────────────────────────────────────────────
# effective seed = supported avatar_seed ?? `v1:default:${user.id}`
# seed fixes geometry; default palette is neutral gray
# host themes may supply semantic accent + bright-accent colors
# never persist a new seed during login, startup, or a theme change

# Metering (App API key, server-to-server) ──────────────────────────
POST {API}/authorize     Bearer osk_…
  { user_id:"usr_…", action, estimate_credits, hold_ttl_seconds }   # ttl: 1..=900s
                          → allowed:
                              { allowed:true,  grant_id:"agt_…", token:"agts_…",
                                action:"<slug>.<action>", cap_credits, expires_at }
                          → denied (200 OK, allowed:false):
                              { allowed:false, reason:"insufficient_available_balance"
                                | "concurrency_cap_exceeded" | "missing_spend_consent",
                                available_credits?, requested_credits? }
                          → invalid (422):
                              envelope error, message in {"invalid_action",
                              "invalid_estimate", "invalid_ttl"}
POST {API}/charge        Bearer osk_…   { token:"agts_…", credits, idempotency_key }
                          → { transaction_id:"txn_…", credits_settled, credits_released,
                              balance_credits, idempotent_replay }
                          # 422 cap_exceeded — token still alive, retry with credits ≤ cap
                          # 410 grant_expired · 409 grant_already_used / idempotency_key_collision
                          # 404 grant_not_found · 403 grant_app_mismatch

# Top-up ────────────────────────────────────────────────────────────
redirect the browser → {ACCOUNTS}
```

All non-public responses are wrapped in the `ApiResponse` envelope — the bodies
above are the `data` field. `{API}` = `OS_ACCOUNTS_API_URL`, `{ACCOUNTS}` =
`OS_ACCOUNTS_URL`.

## Common mistakes to avoid

- Putting the access token in the redirect URL or reading it in client JS. Use the BFF.
- Shipping `OS_ACCOUNTS_APP_API_KEY` to the browser (a `NEXT_PUBLIC_` prefix, a client import). Server-only.
- Calling `/charge` without first calling `/authorize`, or reusing one Action token for unrelated charges (tokens are single-use; reusing one after settle returns `409 grant_already_used`).
- Parsing the Action token to read the cap or expiry. Treat it as opaque — read `cap_credits` and `expires_at` from the `/authorize` response.
- Sending the Action token to `/charge` without the App API key, or vice versa. **Both** are required; either alone is `403 Forbidden`.
- A random or `Date.now()`-based `idempotency_key`. Make it deterministic per operation.
- Treating credits as dollars/floats, or building your own top-up/checkout UI instead of linking to OS Accounts.
- Branching on HTTP status alone and ignoring `success` / `error_code` in the envelope.
