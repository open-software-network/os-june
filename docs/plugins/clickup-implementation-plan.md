# Implementation plan: ClickUp plugin

- **Mode:** CTO
- **Date:** 2026-07-14
- **Status:** Proposed; blocked on auth posture
- **PRD:** [clickup-prd.md](clickup-prd.md)

## Technical objective

Map ClickUp's hierarchy onto the shared project connector schema while keeping
native ids, status/custom-field types, and Workspace-plan limits explicit.

## Phase 0: token and hierarchy spike

1. Test OAuth authorization, client-secret requirement, token revocation,
   Workspace selection changes, and app distribution.
2. Confirm the current non-expiring access-token behavior and provider roadmap
   for refresh/rotation.
3. Test least-privilege controls and whether selected Workspace authorization
   can be narrowed below the provider grant.
4. Exercise Free, Business, and Enterprise rate limits, hierarchy moves,
   custom fields, and removed users.
5. Reject an embedded secret or permanent token without verified revocation.

Exit with an approved token lifecycle or a deferral decision.

## Proposed servers

| Server | Tools |
| --- | --- |
| `june_clickup` | `list_locations`, `search_tasks`, `get_task`, `list_task_comments`, `get_list_schema` |
| `june_clickup_actions` | `create_task`, `update_task`, `add_task_comment` |

Normalize common project fields but preserve native hierarchy, status type,
custom-field type, and canonical URL in every result.

## Boundary and state

- Keychain token only after Phase 0 approval.
- Workspace id, selected Space/Folder/List roots, schema metadata, rate-limit
  budget, capabilities, and health in SQLite.
- No task/comment corpus at rest.
- Rust resolves current task location and rejects operations outside selected
  roots, including tasks moved after they were linked.

## Write model

- Create requires an exact selected List and current status schema.
- Update is an explicit patch with current task update time.
- Custom fields validate type and option ids from fresh schema.
- Approval displays full hierarchy, owner, dates, status, field diff, and note
  excerpt.
- Reconcile creates/comments by stable action fingerprint. Provider webhook
  idempotency keys apply to inbound events, not outbound task mutations.

## Events and quotas

Use bounded polling in local mode. ClickUp webhooks provide HMAC signatures and
inbound idempotency material, but still require a public endpoint and belong to
away mode. Backoff uses plan-specific response headers.

## Delivery slices after Phase 0

1. Workspace/location picker, token health, revoke, and disconnect.
2. Hierarchy/schema normalization and read tools.
3. Approved create and comment.
4. Approved selected-field update and conflict handling.
5. Skills, polling, plan matrix, rc pilot, and metrics.

## Verification

- Auth, Workspace selection changes, revoke, user disable, token compromise
  response, and disconnect.
- Forged location ids, moved tasks, archived Lists, hierarchy deletion,
  custom-field changes, and plan-specific `429` behavior.
- Stale update, duplicate create, timeout, ambiguous result, and restart tests.
- Injection corpus in every task, comment, custom field, status, user, and URL.
- Live walkthrough in two Workspace plans.

## Architecture decision gate

No implementation ships with a reusable client secret in the app or an
indefinite token whose revoke path is unproven. A backend exchange or webhook
receiver requires an ADR and updated privacy copy.
