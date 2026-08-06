# OS Accounts login flow

Clovy is an on-device **identity** client of OS Accounts (Login with Open
Software). Metering (authorize/charge) is server-side in Clovy API, not here —
see [clovy-api-prd.md](clovy-api-prd.md). Implementation lives in
`src-tauri/src/os_accounts.rs`; env vars are in [configuration.md](configuration.md).

## Flow (production)

1. The app opens `OS_ACCOUNTS_URL/login` with the `OS_ACCOUNTS_CLIENT_ID`
   (`ocl_...`) and a **PKCE** challenge (S256).
2. The user authenticates in the portal; OS Accounts redirects to Clovy's
   `redirect_uri`:
   - **Release:** a custom-scheme deep link `osjune://auth/callback` (registered
     via the deep-link plugin; avoids a macOS firewall prompt).
   - **Dev:** a loopback `http://127.0.0.1:<OS_ACCOUNTS_LOOPBACK_PORT>/callback`
     (default 8765; must match the registered redirect URI).
3. The app exchanges the code + PKCE verifier at `OS_ACCOUNTS_API_URL/auth/token`
   for an access + refresh token pair.
4. Tokens are stored in the macOS **Keychain** (service
   `co.opensoftware.june.accounts`), never in the webview. Debug builds may set
   `OS_CLOVY_DEV_PLAINTEXT_TOKEN_STORE=1` to use a file instead and skip Keychain
   prompts.
5. The app fetches an **account snapshot** — `/me` + `/billing/balance` +
   `/billing/subscription` — surfaced to the UI as `AccountStatus`. `/me`
   includes the optional renderer-versioned `avatar_seed` used to keep the
   User's Avatar geometry stable across Apps and devices.

Clovy requests `profile:write` in addition to `profile:read` so the User can
explicitly choose a new Avatar from General settings. Avatar v1 seeds use
`v1:<payload>` with 1 to 125 printable ASCII payload characters. Clovy renders a
supported saved seed; if the seed is absent or uses a future unsupported
version, Clovy derives `v1:default:<User.id>` without changing OS Accounts. The
seed fixes geometry and Clovy supplies the active theme's palette. Existing
sessions minted without the write scope remain signed in but must sign out and
sign in again before a new selection can sync.

**Release prerequisite:** the target environment's Clovy OAuth client must
allow `profile:write` before a build requesting this scope is released. OS
Accounts rejects an authorization request containing a scope outside the
client allowlist, which would block a fresh sign-in rather than only disable
Avatar sync.

## Gates

- **AccountGate** — the sign-in wall, shown until there is a valid session.
- **FundingNotice** — the credits-exhausted / upgrade surface, keyed off
  `subscription.subscribed`. Not a wall: a persistent notice docked above the
  chat composers plus a sidebar chip (FundingChip); credit-consuming actions
  are individually gated while the rest of the app stays usable.

## Local dev

`OS_CLOVY_LOCAL_DEV=1` (client) plus `CLOVY__LOCAL_DEV__ENABLED=true` (Clovy API)
short-circuit login to a fake signed-in account backed by a shared bearer token
(`OS_CLOVY_LOCAL_DEV_BEARER_TOKEN`), so a clone runs with no OS Accounts or
billing. `OS_CLOVY_USE_PROD_ACCOUNTS_TOKENS=1` opts a dev build back into real
tokens.

## Boundary

Clovy never holds the OS Accounts App API key or any upstream provider key — those
are Clovy API's. The desktop app only holds the user's short-lived access + refresh
tokens, in the Keychain. See the Boundaries section of [AGENTS.md](../AGENTS.md).
