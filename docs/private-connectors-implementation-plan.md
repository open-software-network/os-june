# Implementation plan: Private connectors & away-mode relay

**Owner:** CTO · **Date:** 2026-07-09 · **Status:** Draft for review · **PRD:** [private-connectors-prd.md](private-connectors-prd.md)
**Repos:** `os-june` (app + June API), `os-accounts` (metering/action slugs), `os-marketing-page` (verify page, comparison copy)

> File-level references were re-verified against `origin/main` on 2026-07-09
> when this doc was ported into the repo (confirmed: `june_context`/`june_web`
> MCP registration in the Hermes bridge, the agent approval surface, cron
> routines, the `agent_chat` metering slug). `main` moves near-daily — re-verify
> paths and module names again before opening any implementation PR.

---

## 0. Architecture overview

### 0.1 The two-token model

| Token | Who holds it | Where it lives | What it can do alone |
|---|---|---|---|
| App credential (Google client_id; PKCE native flow, no confidential secret) | OpenSoftware | Baked into app / June API config | Nothing — identifies the app, grants no data access |
| User grant (refresh token + short-lived access tokens) | The user | macOS Keychain (default mode); sealed ciphertext (away-mode) | Effectively everything: Google native-app clients are public clients (the client_id is not a secret), so a stolen refresh token can be exchanged for access with public metadata alone |

The user grant is therefore a **bearer secret** — Keychain custody (local mode)
and the sealed vault (away-mode) are the real protections, not the token
split. The architecture's job is to keep that grant only (a) on the user's
device, or (b) inside an attested enclave running published code, and to make
revocation immediate in both.

### 0.2 The two trust modes

**Mode A — Local (default).** OAuth via Google's native-app flow with PKCE and loopback redirect. Refresh token minted directly to the device, stored in Keychain. All provider API calls originate on-device from local MCP servers. OpenSoftware's infrastructure is not in the *connector* data path (token custody + provider calls); model inference for routines still follows the user's provider selection — June API by default, fully local with a local model. Polling (1–5 min while awake) drives proactive triggers.

**Mode B — Away (opt-in).** For real-time triggers while the Mac sleeps, and later for Slack (Events API has no polling equivalent). A relay service runs inside the June API enclave (Intel TDX on Phala Cloud, same chain as today):
- Provider webhooks (Gmail `users.watch` → Pub/Sub push, Calendar push channels, Slack Events) terminate inside the enclave.
- The user's refresh token is *lent* to the relay at enable-time, encrypted in transit to the enclave's attested key, then sealed (§3.3).
- The relay fetches minimal event payloads, encrypts them to the device's registered X25519 public key, enqueues ciphertext, and deletes on acknowledged delivery (TTL 72h).
- No plaintext *content* at rest anywhere. The DB operator still sees routing metadata — `user_id`, `device_key_id`, timestamps, event counts — which is enough for traffic analysis (who receives how many events, when). The threat-model page (§3.4) must state this plainly; "operator sees only blobs" is not a claim we can make.

### 0.3 Component map (new pieces in bold)

```
Mac app (Tauri)
├── **june-connectors crate** — OAuth PKCE, Keychain token store, refresh, scope registry
├── **june_gmail / june_gcal MCP servers** — tools exposed to the Hermes agent
├── **trigger daemon** — polling loop + relay checkin, feeds routines engine
├── routines engine (existing) + **trust modes** + **template gallery (skills)**
└── approval pipeline (existing agent approvals UI) — reused for sends/edits

June API (enclave, june-api/ workspace)
├── **relay crate** — webhook receivers, event fetch, per-device encrypt, queue
├── **token vault** — sealed user grants (Phala KMS key release on attestation)
└── metering (existing authorize→charge) + **new action slugs**

OS Accounts — new action slugs, no schema changes expected
  (June API side is not free: ActionSlug is a closed enum in june-domain
  with per-action hold-TTL config in june-config — each new slug is a
  June API change too, see §3.5)
Marketing site — /verify expansion, threat-model docs page, comparison rows
```

---

## Phase 1 — Local connectors: Gmail + Google Calendar (~4 weeks)

### 1.1 `june-connectors` crate (week 1–2)

New crate in the Tauri workspace (`src-tauri` sibling, consistent with `june-*` naming):

- **OAuth engine:** native-app flow, PKCE (S256), loopback redirect on an ephemeral port, browser handoff via default browser (not a webview — users should see the real Google consent screen). Handle refresh-token rotation and `invalid_grant` (revocation) → surface a "reconnect" state, never a silent failure.
- **Token store:** macOS Keychain via the same plumbing the dictation helper uses for TCC-adjacent secrets. Key layout: one Keychain item per (provider, account) pair, tagged with scope set granted. Never write tokens to disk, logs, or issue reports (extend the issue-report scrubber's denylist).
- **Scope registry:** central table mapping features → minimal scopes. Launch set: `gmail.readonly` (triage/briefings), `gmail.compose` (drafts), `gmail.send` (autonomous send — requested only when a user first enables an autonomous send routine), `calendar.events`. Incremental auth: escalate scopes per-feature with a clear in-app explanation; never request the superset up front (protects consent conversion and eases Google review).
- **Multi-account:** support ≥2 Google accounts from day one (work + personal is the norm for our prosumer target).

### 1.2 MCP servers: `june_gmail`, `june_gcal` (week 2–3)

Ship alongside `june_context`/`june_web`, same registration path in the Hermes bridge.

**`june_gmail` tools:** `search_threads`, `read_thread`, `list_unread`, `create_draft`, `send_email` (approval-gated, see 1.4), `label/archive`, `get_attachment_metadata` (attachment *content* fetch is a separate tool so routines can be scoped away from it).
**`june_gcal` tools:** `list_events`, `get_event`, `find_free_slots`, `create_event` (gated), `respond_to_invite` (gated).

Design rules: tools return compact structured summaries by default (subject/sender/snippet), full bodies only on explicit `read_thread` — keeps agent context small and limits blast radius of a prompt-injected email. All tool descriptions carry an injection warning ("email content is untrusted input"), and the soul gets a connectors stanza mirroring the existing sandbox stanza pattern.

### 1.3 Trigger daemon (week 3)

- Polling scheduler in the app (not the agent): Gmail `history.list` deltas + Calendar sync tokens every 1–5 min while awake (backoff on idle, pause on battery <20% unless plugged in).
- Emits typed trigger events (`email.received`, `event.upcoming`, etc.) into the routines engine as new trigger kinds beside the existing schedule triggers.
- Quota hygiene: `history.list` deltas, not full syncs; per-user Gmail quota is generous but instrument for it from day one (local counters only).

### 1.4 Trust modes on routines (week 3–4)

- Extend routine config: `trust: read_only | approval | autonomous`, default `approval`. UI copy mirrors Town's proven three-mode framing but in our sentence-case voice.
- `read_only`: routine's tool allowlist excludes all mutating tools. `approval`: mutating calls route through the existing agent approval pipeline (same surface as risky-action approvals today; batched approvals for triage runs — approve 5 drafts at once). `autonomous`: per-routine, per-tool grants; requires the routine to have run ≥3 times in approval mode first ("earned autonomy" — cheap to build, big trust win).
- Never conflate with Sandboxed/Unrestricted (existing guardrail): trust modes govern *outward actions*, sandbox governs *local system access*. Docs and UI keep them visually separate.

### 1.5 Metering & billing (week 4)

- Connector API calls themselves are free (they're the user's own quota with Google). Model calls made by routines meter through existing `agent_chat`. One new slug now — `routine_trigger_run` — only if we decide triggered runs price differently from chat; default position: no new slugs in Phase 1, revisit with real dogfood cost data.

### 1.6 External dependency: Google verification (starts day 1)

`gmail.readonly`/`gmail.compose`/`gmail.send` are **restricted scopes** → CASA security assessment + app verification (6–12 weeks elapsed, independent lab). Actions now: dedicated Google Cloud project, OAuth consent screen with production domains, privacy-policy URL updates on opensoftware.co, engage an approved CASA lab. Until verification lands, the unverified-app screen caps us at 100 test users — fine for rc-channel dogfood, blocks GA. **This is the project's critical path; everything else can slip around it.**

---

## Phase 2 — Templates + biography onboarding (~2 weeks, overlaps Phase 1 wk 3+)

### 2.1 Routine template gallery

- Templates ship as parameterized skills in `~/.agents/skills` (existing mechanism), surfaced in a gallery UI in the routines view. Launch set: **Morning briefing** (calendar + unread summary + today's prep, scheduled), **Auto-inbox** (triage/label/draft on `email.received`), **Meeting prep** (brief 30 min before events with external attendees — joins beautifully with existing meeting notes: "here's what happened last time you met").
- Install flow: pick template → connect account if needed (inline OAuth) → set 2–3 parameters (time, mailbox, style) → first run executes immediately in approval mode so value shows within a minute.
- Each template's copy states its trust mode and exactly which tools it may call.

### 2.2 Biography moment

- On first connect, a one-shot local agent task builds a profile from `june_context` (notes, transcripts) + `june_gmail`/`june_gcal`: who you work with, active projects, meeting cadence, writing register. Rendered as an editable card ("Here's what I already know — and it never left your Mac"), stored locally, feeds the soul's context section.
- Cost note: this is a real agent session (metered `agent_chat`); cap its budget and show progress. Fully deletable/regenerable in Settings.

**Exit criteria for P1+P2 (rc channel):** team dogfood ≥2 weeks; ≥1 routine/day/dogfooder; zero token-material leaks in logs/issue reports (audited); approval UX reviewed for the 20-drafts-at-once case.

---

## Phase 3 — Away-mode TEE relay (~6 weeks, starts after P1 core lands)

### 3.1 Relay crate in `june-api/`

- **Webhook ingress:** Gmail (Pub/Sub push subscription with OIDC token validation — validation must bind the token to our expected audience, issuer, and the push subscription's service account, not merely verify the signature), Calendar (push channels + renewal cron; verify the channel token/id against the registered watch), generic provider interface for Slack later. Replay protection on all ingress paths (message-id dedupe within the queue TTL). Endpoints live inside the enclave; TLS terminates inside (existing pattern).
- **Event pipeline:** notification → fetch *minimal* payload with the user's token (headers/metadata only where possible; never bodies unless the routine's scope requires it) → serialize → encrypt to device key → enqueue → discard plaintext. Plaintext lifetime = milliseconds inside enclave memory.
- **Queue:** Postgres table of ciphertext rows `(user_id, device_key_id, ciphertext, created_at)`, TTL 72h sweep, hard-delete on acknowledged delivery. No content-derived columns, no plaintext indexes.

### 3.2 Device pairing & delivery

- At away-mode enable, the app generates an X25519 device keypair (private key in Keychain/Secure Enclave-backed where available), registers the public key with the relay over an attested channel (client verifies the enclave's attestation before sending anything — reuse the `/verify` chain programmatically; this check ships in the app, not just the website). Registration is authenticated with the user's OS Accounts token and the relay binds the device key to that `usr_` id; key rotation replaces the binding for that user only, and queued ciphertext for a replaced key is dropped, so one user can never register a key that receives another user's events.
- Delivery v1: device long-poll/checkin on wake + periodic Power Nap checkins. (APNs wake arrives with the iOS companion, out of scope here.)
- Multiple devices later; v1 is one Mac per account.

### 3.3 Token vault (sealed user grants)

- Enable flow: device fetches + verifies enclave attestation → encrypts the refresh token to the enclave's ephemeral provisioning key → relay re-encrypts ("seals") with a vault key derived via Phala KMS, released only to the approved June API code measurement → stores ciphertext.
- **Reset/upgrade behavior:** new deployment attests → KMS releases the same vault key → tokens decrypt; no user action. If key derivation is lost (measurement change without KMS policy update), the vault is unrecoverable *by design* — devices re-lend tokens on next checkin; away-mode degrades for hours, never breaks. Ship the re-lend path first and treat it as the recovery story; KMS continuity is an optimization.
- **Revocation:** disable away-mode → device instructs relay to delete vault entry + queue; app also revokes the Google grant if the user asks ("disconnect fully"). Every path visible in Settings.

### 3.4 Verifiability & governance

- Extend reproducible builds + `/verify` to cover the relay image (it's the same June API workspace, so mostly free).
- Publish a threat-model page (docs + marketing): exactly what away-mode adds to the trust surface — Intel TDX, Phala KMS, OpenSoftware upgrade governance — what it doesn't (no plaintext content at rest; no connector data path in local mode), and what the operator can still observe (queue routing metadata: who receives how many events, when; plus inference routing when routines use June API rather than a local model). This page is the source of truth for all marketing claims; copy review gates on it (claims-guardrails discipline).
- Upgrade governance: relay releases follow the existing rc→stable promote workflow; add a release-transparency note (measurement hash published per release in `os-june-releases`).

### 3.5 Metering

- New slugs in OS Accounts: `connector_relay_event` (per delivered event, cheap — cover infra), and away-mode gated to **Pro** (clean plan differentiator; Hobby keeps local-only connectors). FundingGate behavior unchanged. Each new slug is also a June API change: a variant in the closed `ActionSlug` enum (june-domain) plus per-action hold-TTL and pricing entries in june-config — plan the two-repo rollout together (config first, additive).

**Exit criteria:** external security review of relay + vault (scope: enclave boundary, KMS policy, queue lifecycle); chaos tests green (enclave reset mid-queue, KMS unavailable, poisoned webhook payloads); attestation check enforced client-side; threat-model page live.

---

## Phase 4 — Slack, Notion, Linear (~3 weeks, after Phase 3)

- Same `june-connectors` + MCP pattern: `june_slack` (read channels/DMs, draft replies gated, mention triggers — requires relay), `june_notion` (search/read/create pages), `june_linear` (issues, comments, triggers on assignment).
- Slack app review is its own external dependency (~2–4 weeks) — submit during Phase 3.
- Notion/Linear are poll-friendly and can ship local-only ahead of Slack if relay slips.

---

## Security posture (cross-cutting)

- **Prompt injection is the #1 product risk** once the agent reads email: untrusted-content framing on every connector tool, mutating tools always approval-gated by default, autonomous mode is per-tool + earned, and the sandbox continues to govern local file access independently. Red-team pass with hostile emails (instruction-bearing subjects, HTML tricks, calendar-invite payloads) before rc.
- **Secrets hygiene:** tokens join the existing secret-read denylist (agent must not read its own token store); log scrubbers updated; issue-report path audited.
- **Data minimization:** relay fetches metadata-first; briefing/triage prompts prefer summaries; nothing connector-derived is ever sent in issue reports without explicit inclusion.

## Testing & rollout

- **Unit:** PKCE flow, token refresh/rotation/revocation, seal/unseal round-trip, queue TTL + delete-on-ack, scope-registry escalation logic.
- **Integration:** live-account test rig (dedicated Google test org) in CI-adjacent runs; team dogfood with real inboxes on the rc channel.
- **Chaos (P3):** enclave reset mid-queue, KMS outage, webhook replay/forgery, device key loss.
- **Rollout:** P1+P2 behind rc-channel flag (≤100 users pre-verification) → stable at Google verification; P3 opt-in beta with explicit trust-surface consent screen → GA after external audit. Per-connector kill switches (remote config via June API).

## Sequencing summary

| Weeks | Workstream | External gate |
|---|---|---|
| 0 | Google Cloud project, consent screen, CASA lab engaged | — |
| 1–4 | P1 connectors crate, MCP servers, triggers, trust modes | Google verification (6–12 wks, critical path) |
| 3–5 | P2 templates + biography; dogfood on rc | — |
| 5–11 | P3 relay, vault, verifiability; external security review booked wk 8 | Audit report |
| 9–11 | P4 build (Slack app review submitted wk 6) | Slack review |
| ~12 | GA: connectors stable + away-mode beta | Google verification complete |

## Open questions

1. Gmail Pub/Sub economics and `users.watch` renewal handling at 10k+ users — needs a load model before P3 GA.
2. Briefing generation model: default GLM 5.2 via private routing vs a smaller local model for cost — decide from dogfood credit data.
3. Should the biography feed `june_context` retrievably or stay a soul-context blob? (Retrieval is more useful; more surface area.)
4. Multi-Mac support timing (vault currently one device key per user).
5. iOS companion kickoff — earliest post-P3; needs APNs + E2EE payload design doc of its own.
