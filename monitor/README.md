# June health monitor

A private Next.js dashboard for June service health. It probes:

- `GET {JUNE_API_URL}/livez` for process liveness
- `GET {JUNE_API_URL}/readyz` for traffic readiness
- `GET {JUNE_API_URL}/healthz` for service and build metadata
- `POST {JUNE_API_URL}/v1/dictate/cleanup` for the dictation route and auth contract
- `POST {JUNE_API_URL}/v1/notes/generate` for the notes route and auth contract
- `POST {JUNE_API_URL}/v1/chat/completions` for the agent route and auth contract
- `GET {OS_ACCOUNTS_API_URL}/ready` for the login dependency

The page refreshes every 30 seconds and keeps the latest 24 probe cycles in the browser for a short latency timeline.

The product API checks use valid minimal request shapes without a bearer token and require the expected `401` / `missing_bearer_token` response. This verifies route wiring and the authentication boundary without invoking an AI provider, mutating user data, or consuming credits.

## Access control

The monitor uses OS Accounts OAuth with authorization code and PKCE. Access and refresh tokens are stored only in httpOnly cookies. The browser never receives either token.

Every protected page load and every `GET /api/health` request resolves the current user through OS Accounts `GET /me`, then matches the returned `usr_...` id against the server-only `HEALTH_DASHBOARD_AUTHORIZED_USER_IDS` deployment secret. Matching is exact and case-sensitive. An unset, empty, or malformed value fails closed.

Store the secret as a comma-separated list. Do not add the real value to `.env.example`, source control, container build arguments, or any `NEXT_PUBLIC_*` variable.

## Configure OS Accounts

Create an App and OAuth client in the OS Accounts Admin console. Register:

- App origin: the exact `APP_ORIGIN`
- Redirect URI: `{APP_ORIGIN}/auth/callback`
- Allowed scope: `profile:read`

Copy the OAuth client id into `OS_ACCOUNTS_CLIENT_ID`. This monitor does not need an App API key because it performs identity reads only.

## Run locally

```sh
cp .env.example .env.local
npm install
npm run dev
```

Open `http://localhost:3010`. For local OAuth, register `http://localhost:3010/auth/callback` on the selected OS Accounts client.

## Verify

```sh
npm test
npm run typecheck
npm run build
```

## Deploy

Set the required variables from `.env.example` in the deployment environment. Use the exact public HTTPS origin for `APP_ORIGIN`, update the OAuth client's registered origin and callback, and configure `HEALTH_DASHBOARD_AUTHORIZED_USER_IDS` as a server-only runtime secret. The included Dockerfile produces a Next.js standalone image on port `3010`.
