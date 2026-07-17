# Metering & billing — authorize → charge, balance, top-up

Charging for usage is **server-to-server only**, authenticated with your **App
API key** (`osk_…`) plus a per-call **Action token** (`agts_…`). The browser is
never involved in a charge. Two endpoints form one mandatory sequence:

1. **`POST /authorize`** — gate the operation *before* you do the work. You
   supply `{user_id, action, estimate_credits, hold_ttl_seconds}`. On approval
   the platform reserves `estimate_credits` as a **Hold** against the user's
   wallet and returns a single-use **Action token** (`agts_…`) plus a public
   `grant_id` (`agt_…`), the `cap_credits`, and the `expires_at` instant. On
   denial it returns `200 OK` with `allowed: false` and a `reason`.
2. **`POST /charge`** — settle *after* the work, passing the secret `token`,
   the actual `credits` (must be `≤ cap_credits`), and a deterministic
   `idempotency_key`. **Both** the App API key (`Authorization: Bearer osk_…`)
   **and** the token are required; either alone is rejected.

This is the **B-shaped contract**: gate-at-start, charge-at-settle. Workers
treat the token as opaque pass-through — read `cap_credits`, `expires_at`, and
the fully-qualified `action` from the `/authorize` response, never by parsing
the token. A successful settle burns the token; the unused `cap − credits`
delta is released back to the wallet. Failed charges (422 cap_exceeded, 410
expired, 409 already used, 404 not found, 403 app mismatch) leave the wallet
untouched.

## Reading the user

Identity comes from the user's access JWT (via the BFF), not the App API key:

```
GET {API}/me   Authorization: Bearer <access JWT>
→ { id: "usr_…", handle, email, display_name, avatar_url, avatar_seed }
```

The `id` (`usr_…`) is the **only** user reference you pass on the charge path.
Persist your app's data against this stable id — never against the handle (it can
be renamed) and never against any internal numeric id (none is ever exposed).

## The metered action (server-side)

A paid action runs on your backend: resolve the user, `authorize`, then `charge`.
Example as a Next.js route handler (`app/api/paid-action/route.ts`):

```ts
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { appApiKey, requestApiJson } from "@/lib/api/server";
import { refreshSession } from "@/lib/auth/session";

type Me = { id: string; handle: string };
type Authorize = {
  allowed: boolean;
  grant_id?: string;
  token?: string;
  action?: string;
  cap_credits?: number;
  expires_at?: string;
  reason?: string;
  available_credits?: number;
  requested_credits?: number;
};
type Charge = {
  transaction_id: string;
  credits_settled: number;
  credits_released: number;
  balance_credits: number;
  idempotent_replay: boolean;
};

const ERR_FORBIDDEN = 3001; // access token expired

export async function POST(request: Request) {
  // 1. Identify the user from their access JWT (refresh once on 3001).
  let access = (await cookies()).get("oa_access")?.value;
  let me = access ? await requestApiJson<Me>("/me", { authorization: `Bearer ${access}` }) : null;
  if (!me?.success && (!access || me?.error_code === ERR_FORBIDDEN)) {
    const refreshed = await refreshSession(crypto.randomUUID());
    if (refreshed.ok) {
      access = refreshed.accessToken;
      me = await requestApiJson<Me>("/me", { authorization: `Bearer ${access}` });
    }
  }
  if (!me?.success || !me.data) {
    return NextResponse.json({ message: "Sign in first" }, { status: 401 });
  }

  const appAuth = `Bearer ${appApiKey()}`; // App API key — server-only

  // 2. Estimate a tight upper bound from your inputs (audio duration, prompt
  //    tokens, etc.) and mint an Action token. The platform reserves
  //    `estimate_credits` as a Hold against the wallet — overlapping ops on
  //    the same user must fit inside the available balance.
  const estimateCredits = 80;        // worker-computed; e.g. minutes × per-min rate
  const holdTtlSeconds = 300;        // bounded 1..=900
  const authorization = await requestApiJson<Authorize>("/authorize", {
    method: "POST",
    authorization: appAuth,
    body: {
      user_id: me.data.id,
      action: "transcription",       // app-supplied; ^[a-z][a-z0-9_-]{0,62}$
      estimate_credits: estimateCredits,
      hold_ttl_seconds: holdTtlSeconds,
    },
  });
  if (!authorization.success || !authorization.data?.allowed || !authorization.data.token) {
    // A denial is 200 OK with allowed:false; the reason tells the user what to do.
    // available_credits is populated on insufficient_available_balance so you can
    // surface "top up X to continue".
    return NextResponse.json(
      {
        allowed: false,
        reason: authorization.data?.reason,
        available_credits: authorization.data?.available_credits,
        requested_credits: authorization.data?.requested_credits,
      },
      { status: 402 }, // 402 = insufficient credits (error_code band 4301)
    );
  }

  // Keep the cap honest: never present the token at /charge with credits > cap.
  const cap = authorization.data.cap_credits ?? estimateCredits;
  const token = authorization.data.token;

  // ...do the actual work here (run the AI call, render the export, etc.)...
  const actualCost = 25;             // measured after the work returns
  const creditsUsed = Math.min(actualCost, cap);

  // 3. Settle. idempotency_key is deterministic per logical operation.
  //    /charge requires BOTH the App API key (header) AND the token (body).
  const charge = await requestApiJson<Charge>("/charge", {
    method: "POST",
    authorization: appAuth,
    body: {
      token,
      credits: creditsUsed,
      idempotency_key: `paid-action:${me.data.id}:${someOperationId}`,
    },
  });
  if (!charge.success || !charge.data) {
    return NextResponse.json({ message: charge.message ?? "Charge failed" }, { status: 409 });
  }

  return NextResponse.json({
    ok: true,
    balance_credits: charge.data.balance_credits,
    credits_settled: charge.data.credits_settled,
    credits_released: charge.data.credits_released, // unused Hold returned to wallet
  });
}
```

### Why these choices

- **The worker computes the estimate** because it owns the inputs (audio bytes, prompt size, etc.). Push pricing knowledge into your worker, not into a distributed client.
- **The Hold is a reservation, not just a hint** — two concurrent `/authorize` calls for the same user can't both pass when their estimates would jointly overspend. The platform serialises by user inside the gate.
- **The Action token is single-use and opaque.** Treat it as a pass-through bearer; read `cap_credits` and `expires_at` from the response, never by parsing the token. This keeps you forward-compatible with future signed-token encodings.
- **`authorize` before doing the work** so a user with no credits is stopped *before* you spend compute. **`charge` after** so you bill the *actual* amount used (e.g. real token count), capped at `cap_credits` — the platform releases the unused delta back to the wallet.
- **`idempotency_key` is deterministic** — derive it from the operation (an order id, a job id, a request id you persist), e.g. `paid-action:<usr>:<orderId>`. Retries (network blips, double-clicks, your own retry loop) then reuse the same key, and the charge replays instead of double-debiting. `idempotent_replay: true` in the response tells you a replay happened. A `Date.now()` or random key silently double-charges. Same token, *different* idempotency_key after settle is `409 grant_already_used`.
- **`credits` are whole integers.** `$1 = 1000 credits`. Decide your per-action price in credits.
- **`/charge` requires both credentials.** App API key alone (no token) fails; token alone (no API key) fails. Defence in depth: token leak alone can't bill, key leak alone can't bill an action you didn't already authorise.
- **Don't send `app_id`** — it's derived from the App API key. Sending it does nothing.
- **`hold_ttl_seconds` is mandatory** (`1..=900`). Pick a tight value: too long strands your user's wallet on a crashed worker; too short fails the legitimate settle. The 900s ceiling exists for long-running async jobs (e.g. video generation) that charge-on-complete against the original Hold after a long poll window.

## Metering from a standalone backend (user identified by a verified token)

The example above is a Next.js route that reads identity from an httpOnly
**cookie** via `/me`. A standalone backend — an API, a worker, a service that does
paid work on behalf of a signed-in user — usually doesn't have that cookie.
Instead the request arrives with the user's **access token** in
`Authorization: Bearer <jwt>`, which you've already **verified locally** to get the
`usr_` id (see [verifying-tokens.md](verifying-tokens.md)). The metering contract is
identical — only the "who is the user" step changes:

- You **already have the `usr_` id** from the verified token, so **don't call
  `/me`** again — that's a wasted round-trip.
- `authorize`→`charge` is the same B-shaped sequence, authenticated with your
  **App API key** (server-only — fine on a backend, never in a distributed client).
- For **long-running or streaming work**, `authorize` up front to gate, run the
  work, then `charge` the **actual** amount once it finishes (you now know the real
  cost — token count, rows processed, seconds of compute, whatever your unit is).

```ts
import { verifyAccessToken } from "./os-accounts/verify"; // JWKS/ES256 verifier
import { requestApiJson } from "./os-accounts/server";    // any server-to-server HTTP client

type Authorize = {
  allowed: boolean;
  grant_id?: string;
  token?: string;
  action?: string;
  cap_credits?: number;
  expires_at?: string;
  reason?: string;
  available_credits?: number;
  requested_credits?: number;
};
type Charge = {
  transaction_id: string;
  credits_settled: number;
  credits_released: number;
  balance_credits: number;
  idempotent_replay: boolean;
};

// `bearerToken` is the incoming Authorization token; `workId` is a stable id
// for this unit of work (so retries are idempotent). `appKey` is your osk_ key.
export async function runPaidWork(bearerToken: string, workId: string, appKey: string) {
  // 1. Authenticate locally — no /me call; the verified token gives the usr_ id.
  const { id: userId } = await verifyAccessToken(bearerToken); // throws → respond 401

  const appAuth = `Bearer ${appKey}`;

  // 2. Mint an Action token capped at your estimated worst-case cost.
  const estimateCredits = estimateFromInput();   // your worker computes this
  const authorization = await requestApiJson<Authorize>("/authorize", {
    method: "POST",
    authorization: appAuth,
    body: {
      user_id: userId,
      action: "transcription",
      estimate_credits: estimateCredits,
      hold_ttl_seconds: 300,                     // bounded 1..=900
    },
  });
  if (!authorization.success || !authorization.data?.allowed || !authorization.data.token) {
    return { status: 402, body: authorization.data?.reason ?? "Credit wallet needs a top-up" }; // 4301
  }
  const { token, cap_credits = estimateCredits } = authorization.data;

  // 3. Do the work. For streaming/long jobs, finish (or accumulate usage) here.
  //    Clamp to the cap so /charge cannot 422 cap_exceeded; absorb any overage in your P&L.
  const actualCost = await doTheWork();
  const creditsUsed = Math.min(actualCost, cap_credits);

  // 4. Settle the real amount, idempotent on the unit of work. /charge needs
  //    BOTH the App API key (header) AND the Action token (body).
  const charge = await requestApiJson<Charge>("/charge", {
    method: "POST",
    authorization: appAuth,
    body: {
      token,
      credits: creditsUsed,
      idempotency_key: `paid-work:${userId}:${workId}`,
    },
  });
  if (!charge.success || !charge.data) return { status: 409, body: charge.message ?? "Charge failed" };
  return { status: 200, body: { balance_credits: charge.data.balance_credits } };
}
```

This is the pattern a **client app brokers through your backend**: a desktop app,
mobile app, CLI, or any public client can't hold the App API key, so it calls
*your* backend with the user's token and your backend runs the verify→authorize→
charge sequence above (see [tauri-desktop.md](tauri-desktop.md) for the desktop
client side). Same contract whether the work is an AI call, a render, an export, or
any other metered unit.

## Showing balance

Read the balance through the BFF with the user's access JWT:

```
GET {API}/billing/balance   (via your BFF)
→ { credits: 4200, usd_millis: 4200 }   # usd display = usd_millis / 1000
```

`/charge` also returns the post-op `balance_credits` (and an `/authorize`
denial includes `available_credits`), so you usually don't need a separate
read right after a charge.

## Top-ups — hand off to OS Accounts

**You never grant credits and never build checkout.** Credits are granted only
after OS Accounts verifies a Stripe webhook. When a user needs more, send them to
OS Accounts:

```tsx
<a href={OS_ACCOUNTS_URL}>Top up credits</a>
```

OS Accounts hosts Stripe Checkout, the saved-card / auto-top-up settings, and the
transaction history. After they return, the next `authorize`/`balance` read
reflects the new balance once the webhook has settled (usually seconds). Don't
poll aggressively or try to read pending Stripe state — wait for the balance to
update.

## Error handling on the charge path

Check the envelope's `error_code`, not just HTTP status:

| `error_code` | Meaning | What to do |
|---|---|---|
| `4301` | Insufficient credits | Surface a calm "top up" prompt; link to OS Accounts |
| `3001` | Access token expired (on `/me`) | Refresh once, retry |
| `4001` | Conflict (idempotency shape mismatch) | You reused a key with different params — fix the key |
| `2001` | Bad request | Validation failed — check the payload |

See [bff-and-envelope.md](bff-and-envelope.md) for the full band table.
