# OS Accounts login flow

June is an on-device **identity** client of OS Accounts (Login with Open
Software). Metering (authorize/charge) is server-side in June API, not here —
see [june-api-prd.md](june-api-prd.md). Implementation lives in
`src-tauri/src/os_accounts.rs`; env vars are in [configuration.md](configuration.md).

## Flow (production)

1. The app opens `OS_ACCOUNTS_URL/login` with the `OS_ACCOUNTS_CLIENT_ID`
   (`ocl_...`) and a **PKCE** challenge (S256).
2. The user authenticates in the portal; OS Accounts redirects to June's
   `redirect_uri`:
   - **Release:** a custom-scheme deep link `osjune://auth/callback` (registered
     via the deep-link plugin; avoids a macOS firewall prompt).
   - **Dev:** a loopback `http://127.0.0.1:<OS_ACCOUNTS_LOOPBACK_PORT>/callback`
     (default 8765; must match the registered redirect URI).
3. The app exchanges the code + PKCE verifier at `OS_ACCOUNTS_API_URL/auth/token`
   for an access + refresh token pair.
4. Tokens are stored in the macOS **Keychain** (service
   `co.opensoftware.june.accounts`), never in the webview. Debug builds may set
   `OS_JUNE_DEV_PLAINTEXT_TOKEN_STORE=1` to use a file instead and skip Keychain
   prompts.
5. The app fetches an **account snapshot** — `/me` + `/billing/balance` +
   `/billing/subscription` — surfaced to the UI as `AccountStatus`.

## Gates

- **AccountGate** — the sign-in wall, shown until there is a valid session.
- **FundingNotice** — the credits-exhausted / upgrade surface, keyed off
  `subscription.subscribed`. Not a wall: a persistent notice docked above the
  chat composers plus a sidebar chip (FundingChip); credit-consuming actions
  are individually gated while the rest of the app stays usable.

## Local dev

`OS_JUNE_LOCAL_DEV=1` (client) plus `JUNE__LOCAL_DEV__ENABLED=true` (June API)
short-circuit login to a fake signed-in account backed by a shared bearer token
(`OS_JUNE_LOCAL_DEV_BEARER_TOKEN`), so a clone runs with no OS Accounts or
billing. `OS_JUNE_USE_PROD_ACCOUNTS_TOKENS=1` opts a dev build back into real
tokens.

## Boundary

June never holds the OS Accounts App API key or any upstream provider key — those
are June API's. The desktop app only holds the user's short-lived access + refresh
tokens, in the Keychain. See the Boundaries section of [AGENTS.md](../AGENTS.md).
