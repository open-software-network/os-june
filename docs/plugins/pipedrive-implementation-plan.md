# Implementation plan: Pipedrive plugin

- **Mode:** CTO
- **Date:** 2026-07-14
- **Status:** Proposed; auth and demand gate
- **PRD:** [pipedrive-prd.md](pipedrive-prd.md)

## Technical objective

Adapt the CRM connector schema to Pipedrive's company, pipeline, deal, person,
organization, activity, and note model while keeping native ids and custom
fields explicit.

## Phase 0: auth and schema spike

1. Verify public OAuth, client-secret requirements, refresh rotation, revoke,
   app review, and scope-change behavior.
2. Test user permissions against persons, organizations, deals, activities,
   notes, and custom fields.
3. Map API v2 availability and any required v1 endpoints.
4. Exercise search budgets, pagination, merged records, deleted records, and
   provider webhook signing/replay controls.
5. Reuse HubSpot pilot evidence for shared CRM primitives, but independently
   prove Pipedrive's token and permission boundary.

Exit with approved auth, supported endpoint/version table, and customer demand.

## Proposed servers

| Server | Tools |
| --- | --- |
| `june_pipedrive` | `search_crm`, `get_person`, `get_organization`, `get_deal`, `list_activities`, `get_pipeline` |
| `june_pipedrive_actions` | `create_note`, `create_activity`, `update_deal_fields` |

Results preserve company, pipeline/stage, object id, update time, owner, custom
field type, associations, canonical URL, and pagination metadata.

## Boundary and state

- Keychain token if Phase 0 permits local custody.
- Company/user id, selected pipeline ids, field registry, endpoint versions,
  rate-limit budget, capabilities, and health in SQLite.
- No CRM record corpus at rest.
- Rust re-resolves the deal's current pipeline before read or mutation.

## Write model

- Note/activity creation requires explicit associated ids.
- Deal updates use a reviewed field allowlist; stage changes are separately
  labeled and cannot be batch-approved.
- Preflight checks update time, current fields, stage, and owner.
- Approval shows before/after values and June note excerpt.
- Ambiguous creates reconcile against recent activities/notes by stable
  fingerprint; uncertain results require confirmation.

## Events and quotas

Local v1 polls recently updated selected-pipeline objects. Public webhooks and
`webhooks:full` stay in away mode. Search calls have a distinct budget and are
debounced/cached as metadata only.

## Delivery slices after gates

1. Connection, pipeline picker, schema, revoke, and health.
2. Search and bounded CRM reads.
3. Approved note and activity creation.
4. Approved deal-field updates with conflict handling.
5. Skills, polling, pilot, metrics, and kill switch.

## Verification

- OAuth, refresh, revoke, permission denial, company removal, user disable,
  scope change, and disconnect.
- Forged ids, moved deals, custom-field changes, merged contacts, deleted
  records, v1/v2 response differences, and search throttling.
- Duplicate activity/note, stale deal, timeout, ambiguous result, and restart.
- Injection corpus in every text/property/URL surface.
- Live pilot walkthrough with restricted and administrator users.

## ADR threshold

Any confidential exchange, backend token store, webhook receiver, or provider
content relay requires an ADR. A second CRM does not inherit HubSpot's decision
without proving the Pipedrive-specific boundary.
