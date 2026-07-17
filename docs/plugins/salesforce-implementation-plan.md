# Implementation plan: Salesforce plugin

- **Mode:** CTO
- **Date:** 2026-07-14
- **Status:** Proposed; auth, packaging, and schema spike required
- **PRD:** [salesforce-prd.md](salesforce-prd.md)

## Technical objective

Build a metadata-driven Salesforce connector that uses public-client PKCE if
supported for the required REST scopes, enforces org/object/field selection in
Rust, and parks every mutation for approval.

## Phase 0: org matrix

Test a Developer Edition org, sandbox, and administrator-restricted production
pilot:

- External Client App creation, packaged distribution, admin approval, PKCE,
  refresh, revoke, My Domain, and sandbox login;
- REST API availability by edition and user permission;
- field-level security, record types, validation rules, sharing rules, and
  custom fields;
- supported API-version negotiation and deprecation behavior;
- `api`, `refresh_token`, and narrower scope options;
- hosted MCP versus direct REST as separate, measured alternatives.

Exit with a no-secret token flow for direct REST or an explicit deferral. Do
not inherit the hosted MCP auth result without testing the REST contract.

## Proposed servers

| Server | Tools |
| --- | --- |
| `june_salesforce` | `search_records`, `get_account`, `get_contact`, `get_opportunity`, `list_activities`, `describe_supported_schema` |
| `june_salesforce_actions` | `create_task`, `create_event`, `update_opportunity_fields` |

The model never sends SOQL. Rust builds parameterized queries from reviewed
filters and field registries. Results include org id, object, record id,
modification time, selected fields, access signals, and canonical URL.

## State and authorization

- Keychain refresh token and instance URL.
- Org id, user id, API version, selected objects/records, field registry,
  capabilities, and health in SQLite.
- Schema metadata cache only, invalidated by age, permission errors, and org
  change. No record corpus at rest.
- Every request binds and revalidates the instance host to prevent token or
  query forwarding to an attacker-controlled domain.

## Write and conflict model

- Preflight re-reads the record and relevant fields.
- Updates use explicit field maps and reject fields absent from the current
  allowlist or field-level access response.
- Approval renders validation-rule failures without encouraging a broader
  permission grant.
- Composite calls are used only when their rollback semantics are tested and
  required. Partial results are journaled individually.
- Ambiguous creates reconcile by a stable action fingerprint stored in a
  dedicated external-id field only when the org administrator approves that
  schema addition. Otherwise replay requires user confirmation.

## Events

V1 is live fetch and bounded polling of linked records. Platform Events,
Change Data Capture, and webhook-style relays are separate enterprise and
away-mode decisions. No public event endpoint is required for local v1.

## Delivery slices

1. External Client App, org connection, schema discovery, and health.
2. Safe query builder and standard-object reads.
3. Activity create with approval and reconciliation.
4. Opportunity field update with validation and conflict handling.
5. Enterprise pilot, admin guide, metrics, kill switch, and rc decision.

## Verification

- Production/sandbox auth, My Domain, admin denial, token expiry, revoke, user
  disable, permission removal, and disconnect.
- Injection and query-boundary tests for every model-facing filter.
- Standard/custom fields, record types, validation rules, sharing denial,
  deleted records, pagination, and API-version fixtures.
- Composite partial failure, stale state, ambiguous timeout, and restart tests.
- Prompt-injection corpus in names, descriptions, notes, URLs, and formulas.
- Live walkthrough with restricted seller and administrator profiles.

## Architecture decision gate

Public-client PKCE plus on-device REST can extend the existing local-mode
decision after proof. Hosted MCP, a backend-held Salesforce credential,
provider event intake, or record relay creates a different boundary and needs
its own ADR before implementation.
