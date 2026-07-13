# Implementation plan: Google Workspace plugin

- **Mode:** CTO
- **Date:** 2026-07-13
- **Status:** Proposed expansion of shipped local mode
- **PRD:** [google-workspace-prd.md](google-workspace-prd.md)

## Technical objective

Extend the shipped Gmail + Calendar connector without weakening ADR-0016.
Drive, Contacts, Docs, Sheets, and Meet calls must reuse Keychain custody, the
on-device provider proxy, the read/action MCP split, explicit account binding,
trust modes, and the approval journal.

## Existing foundation

- `src-tauri/src/connectors/` owns Google OAuth, account state, Keychain access,
  provider calls, triggers, and trust enforcement.
- `june_gmail*` and `june_gcal*` establish the base/action server convention.
- The connector approval tray, runtime config merge, restart discipline, and
  live schema fixtures already exist.
- The current local mode supports one Google account. This plan does not smuggle
  multi-account routing into the expansion.

## Proposed runtime surface

Add app-owned servers behind the connector token:

| Server | Tools |
| --- | --- |
| `june_gdrive` | `search_files`, `get_file_metadata`, `read_file`, `list_recent_files`, `get_activity` |
| `june_gdrive_actions` | `create_document`, `update_document`, `create_spreadsheet`, `update_range`, `move_file`, `share_file` |
| `june_google_people` | `search_contacts`, `get_contact` |
| `june_google_meet` | `get_meeting_space`, `list_recordings`, `list_transcripts`, `read_transcript` |

Keep one job per tool, stable provider ids in every result, compact structured
summaries, bounded pagination, and explicit MIME/export metadata. File reads
must return imported file references when content exceeds the inline bound.

## Data model

Add only provider-neutral records unless a Google field is genuinely unique:

- `connector_capability_grants`: account, capability, granted scopes, state,
  last verified timestamp.
- `connector_resource_refs`: provider, account, resource kind, provider id,
  canonical URL, display name, ETag/version, last accessed timestamp.
- Extend the existing pending action record with provider idempotency material
  for Docs/Sheets mutations.

Do not persist file bodies, email bodies, Meet transcripts, or access tokens in
SQLite. Imported artifacts follow the existing workspace file lifecycle.

## OAuth and scopes

1. Inventory the exact least-privilege scope for every launch tool.
2. Run a release-blocking spike against consumer Gmail and managed Workspace
   accounts to establish whether capability expansion can add scopes to the
   existing native grant or must reconnect the complete requested set.
3. Store the scopes actually returned, not merely those requested.
4. Render partial grants honestly and hide tools whose scopes are absent.
5. Complete Google verification and any restricted-scope assessment before
   stable rollout.

The system browser, PKCE S256, random loopback port, state validation, and
Keychain service remain unchanged.

## Provider proxy

Introduce route families under the existing connector proxy rather than new
listeners. Each route declares:

- required capability and scopes;
- read or action classification;
- accepted account binding;
- request/response size bounds;
- timeout and retry policy;
- redaction policy for logs and issue reports;
- idempotency behavior.

Export Google Docs/Sheets to bounded representations for model reads. Do not
send arbitrary Drive downloads inline through MCP. The proxy imports a file to
the agent workspace, returns a reference, and lets the existing attachment path
handle it.

## Trust and action policy

- `read_only`: only base servers are visible.
- `approval`: Drive/Docs/Sheets action calls park before the provider request.
- `autonomous`: only explicitly granted tools and account may bypass parking
  after earned autonomy.
- Sharing, deleting, moving across shared drives, and broad permission changes
  remain approval-only in v1 even under autonomous mode.
- Send/update retries resume from the stable pending action id. They never
  blindly replay a completed mutation.

## Delivery slices

### Slice 0: scope and API spike (3-5 days)

- Validate native grant expansion, Meet artifact availability, export limits,
  idempotency options, and provider quotas.
- Produce a scope-to-tool matrix and Google verification checklist.

### Slice 1: capability shell (1 week)

- Capability-grant model, plugin detail states, health checks, reconnect and
  disconnect behavior.
- No new provider tools yet.

### Slice 2: Drive read path (2 weeks)

- Metadata search, recent files, explicit read/export, imported file refs.
- Injection fixtures and large-file bounds.

### Slice 3: Meet + Contacts read path (1-2 weeks)

- Attendee resolution and available meeting artifact reads.
- Expected-unavailable states by account edition and organizer permissions.

### Slice 4: Docs/Sheets actions (2 weeks)

- Create and narrowly update operations behind the approval journal.
- Shared-drive and permission-changing operations excluded or always parked.

### Slice 5: skills, routines, and rollout (1 week)

- Meeting prep/follow-up skills, template routines, metrics, rc dogfood, and
  support runbook.

## Verification

- Rust unit tests for scope gating, account binding, route classification,
  result bounds, ETag/version handling, and idempotent action resume.
- MCP schema fixtures and pinned-runtime live smoke tests for every server.
- OAuth matrix: first connect, partial grant, reconnect, token refresh,
  `invalid_grant`, disconnect, server-side revoke, and managed-admin denial.
- Live account matrix for consumer and Workspace accounts, plus Meet artifact
  present/absent cases.
- Prompt-injection corpus in Docs, Sheets cells, filenames, comments, and Meet
  transcripts.
- Sandbox proof that the agent cannot read the Keychain item while Rust can.

## Rollout and operations

Ship behind per-capability rc flags. Drive read can reach stable before write
actions if verification permits. Add provider kill switches and quota/error
dashboards without content telemetry. Record only coarse activation, success,
latency, approval, denial, and provider error buckets.

## Dependencies and decisions

- Google OAuth verification and test Workspace tenant.
- A settled scope expansion behavior from Slice 0.
- No new ADR if the work follows ADR-0016. A new ADR is required before any
  cloud index, domain-wide delegation, or backend-held provider credential.
