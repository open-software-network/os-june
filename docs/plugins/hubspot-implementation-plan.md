# Implementation plan: HubSpot plugin

- **Mode:** CTO
- **Date:** 2026-07-14
- **Status:** Proposed; auth and permission spike required
- **PRD:** [hubspot-prd.md](hubspot-prd.md)

## Technical objective

Add pipeline-bounded HubSpot reads and approved CRM actions through the
provider-neutral connector kit. Keep record selection, property allowlists,
stale-state checks, and approval enforcement in Rust.

## Phase 0: auth and access matrix

Before implementation:

1. Verify public app OAuth, refresh, revoke, app review, and scope-change flows.
2. Confirm that HubSpot still requires a client secret for authorization and
   refresh exchanges, and test whether it offers a supported public-client
   alternative.
3. Measure each proposed scope against Free, Starter, Professional, and
   Enterprise accounts and user permission variants.
4. Demonstrate the documented gap between CRM scope access and owned-record UI
   permissions with test users.
5. Reject an embedded secret. If a TEE exchange or user-created app is chosen,
   record the credential boundary in an ADR and user copy.

Exit with an approved token path, scope-to-tool table, supported account matrix,
and server-side revoke behavior.

## Proposed servers

| Server | Tools |
| --- | --- |
| `june_hubspot` | `search_crm`, `get_contact`, `get_company`, `get_deal`, `list_engagements`, `get_pipeline` |
| `june_hubspot_actions` | `create_note`, `create_task`, `update_deal_properties` |

Search returns compact ids, labels, associations, modified time, pipeline and
stage, owner, canonical URL, and an explicit list of omitted fields. Full
record reads accept bounded property lists from a reviewed registry.

## Authorization and state

- Keychain token material if Phase 0 preserves device custody.
- Portal id, user id, granted scopes, selected pipeline ids, property registry,
  capabilities, and health in SQLite.
- No CRM record bodies or engagement corpus at rest.
- Rust checks the resolved record's current pipeline before returning content
  or accepting a mutation.

## Write model

- Notes and tasks require an explicit associated record set.
- Deal updates are limited to a reviewed property allowlist. Stage changes are
  separately labeled in approval and excluded from batch approval.
- Preflight re-reads object modification time and current property values.
- Approval shows before/after fields, associations, destination links, and the
  June note excerpt leaving the device.
- Creation retries use a provider-supported idempotency mechanism if available.
  Otherwise June reconciles recent engagements by a stable local fingerprint
  and blocks replay when the outcome is ambiguous.

## Events and rate limits

V1 uses bounded polling of linked records and recent updates while June is
awake. The provider's webhook API is app-level and requires a public HTTPS
endpoint, so it is reserved for an accepted away-mode relay. Handle `429` and
provider retry guidance with account-scoped backoff and a request budget.

## Delivery slices after Phase 0

1. Connection, portal state, pipeline picker, revoke, and health.
2. Search and bounded reads with scope and permission fixtures.
3. Approved engagement note and follow-up task creation.
4. Approved deal-property updates with preflight conflicts.
5. Meeting-to-CRM skills, rc dogfood, metrics, and kill switch.

## Verification

- OAuth connect, refresh, denied scope, portal removal, provider revoke, and
  June disconnect.
- Cross-pipeline forged-id and broad-scope regression tests.
- Default and custom schema fixtures, archived stages, duplicate contacts,
  merged records, paging, partial responses, and rate limits.
- Action-journal tests for stale state, timeout, duplicate acknowledgement,
  ambiguous create, and restart.
- Prompt-injection corpus in names, notes, properties, associations, and URLs.
- Live portal walkthrough with restricted and administrator users.

## Rollout and decision gate

Use an internal test portal, a small founder-led sales pilot, then rc. No
backend credential exchange, webhook intake, or provider content relay ships
without an ADR because each changes the local-mode trust boundary.
