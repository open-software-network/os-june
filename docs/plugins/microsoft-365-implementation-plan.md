# Implementation plan: Microsoft 365 plugin

- **Mode:** CTO
- **Date:** 2026-07-13
- **Status:** Proposed; API and tenant spike required
- **PRD:** [microsoft-365-prd.md](microsoft-365-prd.md)

## Technical objective

Add a provider-neutral connector implementation for Microsoft Graph using
delegated authorization code + PKCE, Keychain token custody, on-device Graph
calls, explicit capability grants, and the existing trust/approval system.

## Phase 0: Graph feasibility matrix

Before defining launch parity, test a personal Microsoft account and two
Entra tenants (standard and admin-restricted):

- native desktop redirect and PKCE behavior;
- refresh and conditional-access failure behavior;
- delegated scopes for mail, calendar, OneDrive/SharePoint, and selected Teams
  reads/actions;
- tenant-admin consent requirements;
- delta-query support, pagination, throttling, and resource ids;
- file download/export bounds and sensitivity-label signals;
- shared/delegated resources as explicit out-of-scope cases.

Exit with a scope-to-tool matrix and supported account/tenant table. The UI
must be generated from that table rather than assuming all capabilities.

## Proposed servers

| Server | Tools |
| --- | --- |
| `june_outlook` | `search_mail`, `read_thread`, `list_calendars`, `list_events`, `find_meeting_times` |
| `june_outlook_actions` | `create_draft`, `send_draft`, `create_event`, `update_event` |
| `june_m365_files` | `search_files`, `get_file_metadata`, `read_file` |
| `june_m365_files_actions` | `create_file`, `update_file`, `move_file`, `share_file` |
| `june_teams` | limited read tools established by the spike |

Do not expose one kitchen-sink Graph server. Tool visibility follows granted
capabilities, account binding, runtime mode, and trust mode.

## Auth and account state

- Register June as a public native client and use the system browser, PKCE S256,
  state, nonce, and the supported loopback/custom redirect established by the
  spike.
- Store refresh/access material in a dedicated Keychain service per tenant and
  account. Persist only tenant id, account id, email, capability/scopes, status,
  cloud, and diagnostic timestamps.
- Treat `interaction_required`, admin denial, conditional-access challenge,
  tenant policy, expired refresh, and revoked grant as distinct UI states.
- V1 supports one selected Microsoft account/tenant at a time.

## Provider proxy and resource policy

All Graph calls pass through connector-token routes in Rust. Route metadata
declares scopes, capability, read/action class, account, timeout, response
bound, retry class, and redaction. Use delta queries where available for local
awake polling. Do not create Graph webhook subscriptions in local mode because
they require a public endpoint and ongoing renewal.

Imported files return workspace references. Avoid retaining bodies or files in
SQLite. Preserve Graph resource ids, web URLs, ETags/change keys, tenant ids,
and drive/site ids so updates target the exact source.

## Trust policy

- Base servers are read-only.
- Action servers park before the Graph request in `approval`.
- Autonomous mode is deferred until provider-specific idempotency and earned
  autonomy are proven.
- External recipient mail, send, event cancellation, sharing, permission
  change, move across drives/sites, and deletion remain approval-only.
- Tenant and account ids are server-bound and ignored if supplied by the model.

## Delivery slices

1. **Spike and registration (1-2 weeks).** Capability matrix, app registration,
   consent copy, tenant test fixtures.
2. **Auth shell (1 week).** Account state, Keychain, connect/reconnect/revoke,
   diagnostics.
3. **Outlook + Calendar reads (2 weeks).** Search/read, events, availability,
   delta state.
4. **Outlook + Calendar actions (1-2 weeks).** Draft/send and event updates with
   action journal.
5. **Files (2 weeks).** OneDrive/SharePoint search, read/import, bounded writes.
6. **Teams read slice (1-2 weeks).** Only verified stable delegated surface.
7. **Skills and rc (1 week).** Meeting flows, metrics, runbook, pilot.

## Verification

- OAuth/tenant matrix across personal, standard work/school, admin-restricted,
  conditional-access, revoke, and reconnect cases.
- Contract tests for Graph pagination, throttling and `Retry-After`, delta
  tokens, ETags/change keys, partial errors, and national-cloud base URLs.
- Rust account/tenant binding, route classification, result bounds, and action
  idempotency tests.
- Injection corpus across HTML mail, calendar bodies, filenames, documents,
  Teams messages, and link previews.
- Live permission tests proving June never exceeds the authorizing user's
  source permissions.
- Sandbox test that Hermes cannot read the Keychain item.

## Rollout

Internal tenant, invited design partners, rc, then stable. Expose capability
availability and admin requirements before auth. Use per-family kill switches
and content-free error/latency telemetry. Publish a supported tenant/account
matrix and conditional-access troubleshooting runbook.

## ADR threshold

Delegated tokens on-device and direct Graph calls can extend the local-mode
pattern proposed by ADR-0016 once that decision is accepted or superseded. An
ADR is required before application permissions, a public webhook relay, tenant-
wide deployment, or backend-held Microsoft credentials.
