# Open Software health

A private production health dashboard and durable alert worker for Open Software. The dashboard uses OS Accounts login and an exact server-side user id allowlist. The worker runs independently, probes production every five minutes, retries failures before alerting, and posts only new or changed active outages to Slack.

The shared check catalog covers:

- June API liveness, readiness, deployment metadata, and non-billable authentication contract probes for dictation, notes, and agent routes
- OS API liveness and readiness
- OS Accounts API readiness
- OS Chat API, inference, and sync readiness
- Open Software, OS Accounts, OS Chat, and health portals

The June product API probes send valid minimal request shapes without a bearer token and require the expected `401` and `error_code: 3001` response. They verify route wiring and the authentication boundary without invoking an upstream provider, mutating user data, or consuming credits.

## Access control

The dashboard uses OS Accounts OAuth with authorization code and PKCE. Access and refresh tokens are stored only in httpOnly cookies. The browser never receives either token.

Every protected page load and every `GET /api/health` request resolves the current user through OS Accounts `GET /me`, then matches the returned `usr_...` id against the server-only `HEALTH_DASHBOARD_AUTHORIZED_USER_IDS` deployment secret. Matching is exact and case-sensitive. An unset, empty, or malformed value fails closed.

Store the secret as a comma-separated list. Do not add the real value to `.env.example`, source control, container build arguments, or any `NEXT_PUBLIC_*` variable.

## Configure OS Accounts

Create an App and OAuth client in the OS Accounts Admin console. Register:

- App origin: the exact `APP_ORIGIN`
- Redirect URI: `{APP_ORIGIN}/auth/callback`
- Allowed scope: `profile:read`

Copy the OAuth client id into `OS_ACCOUNTS_CLIENT_ID`. The dashboard does not need an App API key because it performs identity reads only.

## Run locally

```sh
cp .env.example .env.local
npm install
npm run dev
```

Open `http://localhost:3010`. For local OAuth, register `http://localhost:3010/auth/callback` on the selected OS Accounts client.

Run the worker separately with a test Slack webhook and writable state path:

```sh
SLACK_HEALTH_WEBHOOK_URL=... HEALTH_MONITOR_STATE_PATH=/tmp/os-health-state.json node worker/worker.mjs
```

## Verify

```sh
npm test
npm run typecheck
npm run build
```

## Deploy

Deploy the Docker image twice:

- Web service: use the image default command and expose port `3010` at `health.opensoftware.co`.
- Worker service: build with `Dockerfile.worker`, keep one replica, set `SLACK_HEALTH_WEBHOOK_URL` as a secret, and mount a persistent volume at `/data`.

The old June-specific hostname may remain temporarily as a compatibility alias, but `APP_ORIGIN` and all Slack links should use `https://health.opensoftware.co`.
