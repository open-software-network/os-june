# Implementation plan: Azure Boards plugin

- **Mode:** CTO
- **Date:** 2026-07-14
- **Status:** Proposed; Entra migration spike required
- **PRD:** [azure-boards-prd.md](azure-boards-prd.md)

## Technical objective

Build an Entra-authenticated Azure DevOps Services connector for selected
projects and work items. Generate bounded WIQL and JSON Patch in Rust and park
every write for approval.

## Phase 0: identity and project matrix

Test Entra work and school accounts across standard and admin-restricted
organizations:

- public-client authorization code with PKCE, redirect behavior, delegated
  Azure DevOps audience/scopes, refresh, tenant consent, and revoke;
- explicit rejection and clear reconnect copy for Microsoft personal accounts
  until Entra adds native Azure DevOps resource support;
- organization discovery and membership versus Entra tenant identity;
- work item process types, field metadata, rules, area/iteration permissions,
  comments, queries, and boards;
- Azure DevOps OAuth deprecation and removal of any legacy assumptions;
- service-hook permissions and public endpoint requirements as an away-mode
  input only.

Exit with an Entra-only auth contract and supported account/tenant table.

## Proposed servers

| Server | Tools |
| --- | --- |
| `june_azure_boards` | `list_projects`, `search_work_items`, `get_work_item`, `list_comments`, `get_project_schema`, `get_iteration` |
| `june_azure_boards_actions` | `create_work_item`, `update_work_item`, `add_work_item_comment` |

The model never emits raw WIQL or JSON Patch. Rust constructs both from typed,
allowlisted filters and fields.

## Boundary and state

- Refresh token in Keychain; access token in memory with strict audience check.
- Tenant/account, organization, selected project ids, process/schema metadata,
  capabilities, cursors, and health in SQLite.
- No work-item/comment corpus at rest.
- Rust validates organization host, project identity, area path, and iteration
  against the current selected project.

## Write model

- Create requires current work item type and required-field schema.
- Update is an explicit typed field patch using current revision number.
- Relations are display-only in v1 unless an exact supported relation is
  separately approved.
- Approval shows organization, project, type, area, iteration, owner, field
  diff, and June note excerpt.
- Revision conflicts return to draft. Ambiguous creates reconcile by recent
  project/type/title plus a stable fingerprint or require confirmation.

## Events and limits

Local mode polls saved queries or recently changed work items with bounded
WIQL. Service hooks require a public receiver and belong to away mode. Apply
Azure DevOps retry headers and per-resource request budgets.

## Delivery slices

1. Entra auth, organization/project picker, revoke, and health.
2. Schema discovery and safe WIQL read path.
3. Approved work-item creation.
4. Revision-safe update and comment.
5. Skills, polling, enterprise pilot, admin guide, and metrics.

## Verification

- Work/school auth, personal-account rejection, admin consent denial, tenant
  switch, organization removal, audience mismatch, token expiry, revoke, and
  disconnect.
- Forged organization/project ids, area/iteration permissions, process changes,
  required/custom fields, deleted users, and revision conflicts.
- WIQL and JSON Patch injection tests.
- Duplicate create, timeout, partial error, rate limit, and restart tests.
- Prompt-injection corpus in fields, comments, identities, links, and relations.
- Live Azure DevOps Services walkthrough with two process templates.

## Architecture decision gate

Entra public-client auth and on-device REST may reuse the Microsoft connector
foundation after proof. A PAT fallback, legacy OAuth, backend token exchange,
service-hook receiver, or Azure DevOps Server path requires a separate decision.
