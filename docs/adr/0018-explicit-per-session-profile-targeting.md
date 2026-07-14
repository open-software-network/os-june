# ADR 0018: Hermes profile switching is explicit per-session targeting, not runtime state

Date: 2026-07-07
Status: accepted

## Context

JUN-210 asks for setting up and switching between profiles in June, like the
profiles the embedded Hermes runtime supports natively. The Profile builder
surface (spec 20, hidden since PR #453) already creates profiles through the
documented Hermes admin REST endpoints, but nothing in June listed, switched,
or deleted them, and no June chat could run under a non-default profile.

Two mechanisms exist in the pinned Hermes build for "the profile a session
runs under":

1. **The sticky active profile** — a file (`active_profile`) under the Hermes
   home, written by `POST /api/profiles/active` (the same primitive the
   builder's test-session flow already used). It changes which profile *new
   CLI invocations and gateways* pick up. It does NOT retarget the running
   dashboard/gateway process, and the gateway's `session.create` does not
   consult it.
2. **Per-session targeting** — `session.create` accepts an optional
   `profile` param; the session's agent is built and persisted against that
   profile's home and state db, re-bound per turn. Absent the param, the
   session runs under the gateway's launch profile (June's default).

June keeps exactly one Hermes runtime per mode (sandboxed / unrestricted),
both sharing one Hermes home, so a per-profile process model was also
conceivable: spawn a gateway per profile and route sessions by process.

## Decision

Switching profiles in June writes the sticky active profile via
`POST /api/profiles/active` AND June threads the active profile name
explicitly as `session.create`'s `profile` param for every new chat session
(omitted when the active profile is `default`, keeping the default path
byte-identical to before).

June holds the last-known active profile in an app-global store, populated
from `GET /api/profiles/active` when the gateway becomes ready and updated
synchronously by the switcher. Existing sessions keep the profile they were
created under; only new sessions follow a switch. The settings admin
surfaces (skills, MCP, toolsets, ...) thread the same value into their
existing per-hook `profile` param.

No per-profile Hermes process is spawned; profiles remain a runtime concept
inside the single gateway per mode.

## Consequences

- Two chats can run under different profiles concurrently; a switch never
  yanks a live session to another profile. This is the behavior the per-turn
  `HERMES_HOME` re-binding in the gateway is built for.
- The sticky file and June's threaded value can only drift if something
  outside June writes the file mid-session; June re-reads it on gateway
  ready, and the explicit param means a drifted sticky value never silently
  retargets a June chat.
- Writing the sticky file keeps June consistent with the Hermes CLI and
  dashboard (`hermes profile use`), so terminal debug sessions and CLI
  invocations agree with what June shows as active.
- Deleting the active profile would strand the sticky pointer, so June
  refuses to delete the active profile client-side (switch first); Hermes
  itself refuses to delete `default`.
- A per-profile process model was rejected: it multiplies memory and spawn
  cost per profile, breaks the one-gateway-per-mode invariant June's
  sandboxing model relies on, and the runtime already supports per-session
  profile binding inside one process.

## Addendum (2026-07-08): per-profile voice and image models

A profile's text (agent) model is Hermes state (`ProfileCreate.model`,
`PUT /api/profiles/{name}/model`). Hermes has no concept of June's
transcription (voice) or image models, so those are June-side per-profile
overrides: `profile_overrides` in `provider-settings.json`, written through
the `set_profile_model_overrides` Tauri command and resolved by the model
accessor functions (`transcription_model()`, `image_model()`) that every
real call already goes through.

Resolution is **call-time against the sticky active profile** (the
`active_profile` file June's switcher writes), not per-session: transcription
is not session-bound at all, and the image tool's requests do not carry a
session's profile. A profile with no override follows June's global model
settings. The `default` profile never carries overrides. Deleting a profile
best-effort removes its overrides.

The wizard's "Create and start test session" flow (which opened a terminal
via `POST /api/profiles/{name}/open-terminal`) was replaced by
"Create and make active": activation plus June's own chat is the in-app way
to try a profile, and no June UI path opens a terminal.

## Addendum (2026-07-14): cold-start resolution reads the sticky file directly

The frontend's active-profile store confirmed only through
`GET /api/profiles/active`, which requires the Hermes web server. On a cold
start under a named profile the server is not up yet, the one
subscribe-triggered refresh short-circuited, and the store sat unconfirmed at
`default` — so every session-list surface filtered against the wrong profile
until the first new session forced a re-read (meeting notes were unaffected:
Rust reads the sticky file per query). Since the endpoint itself just reads
the sticky `active_profile` file, June now exposes that read as the
`sticky_active_profile` Tauri command and the store falls back to it whenever
the admin target is unavailable or the request fails. The REST path stays
preferred when the server is up (it normalizes and reflects gateway state);
the file read is the bridge-independent equivalent, not a second source of
truth.
