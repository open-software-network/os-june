# Implementation plan: Linear plugin

- **Mode:** CTO
- **Date:** 2026-07-13
- **Status:** Proposed; Phase 0 documentation spike complete, see
  [linear-oauth-spike.md](linear-oauth-spike.md) (live verification pending
  OAuth app registration)
- **PRD:** [linear-prd.md](linear-prd.md)
- **Issue:** JUN-284

## Technical objective

Build a first-party Linear connector with selected-team enforcement, bounded
GraphQL operations, rotated refresh tokens in Keychain, and approval-journaled
mutations.

## Phase 0: OAuth and API spike

- Confirm whether Linear's public OAuth authorization-code flow supports PKCE
  and a public desktop client without an embedded client secret.
- Verify current refresh-token rotation, revoke, workspace/app actor behavior,
  and scope semantics.
- Compare user actor versus app actor. Use user actor for V1 unless app actor is
  necessary and its visible attribution is product-approved.
- Record an ADR if a confidential exchange or backend credential is required.
- Establish GraphQL complexity, pagination, rate-limit, and idempotency behavior
  for the exact launch operations.

## Proposed servers

| Server | Tools |
| --- | --- |
| `june_linear` | `list_teams`, `list_users`, `list_projects`, `list_cycles`, `list_initiatives`, `search_issues`, `get_issue`, `list_issue_comments`, `list_project_updates` |
| `june_linear_actions` | `create_issue`, `update_issue`, `add_comment`, `create_project_update` |

Generate fixed GraphQL documents in Rust. Do not accept arbitrary GraphQL from
the model. Return stable ids, identifiers, URLs, team/project/cycle ids, status,
priority, assignee, timestamps, and bounded text.

## State and binding

- Keychain rotated refresh/access material if Phase 0 proves local custody.
- Workspace id, user/app actor id, selected team ids, scopes, health, and cursors
  in SQLite.
- Provider proxy overwrites/validates workspace and team from the bound account.
- No issue corpus or GraphQL response cache beyond an active task.

## Action safety

- `create_issue`: exact team and optional project preview; stable local action
  id and response journal. If Linear does not accept a provider idempotency
  key, an ambiguous timeout blocks automatic replay until a recent-object
  fingerprint reconciles the mutation or the user approves another attempt.
- `update_issue`: allow only title, description, status, priority, assignee,
  project, and cycle in V1; approval shows field diff.
- `add_comment` and `create_project_update`: rendered content preview.
- Re-read target and updated-at value before commit; stale changes conflict.
- Delete/archive/admin mutations do not exist. Autonomous mode is deferred.

## Events

Use live reads and bounded local polling for followed issues/projects while the
Mac is awake. Linear webhooks require public HTTPS and are reserved for an
away-mode relay. If later added, verify HMAC signature and timestamp, dedupe by
delivery id, then fetch current state rather than trusting payload content.

## Delivery slices after Phase 0

1. **Connection + teams (1 week).** OAuth, Keychain, selected teams, health,
   revoke.
2. **Planning reads (1-2 weeks).** Users, projects, cycles, initiatives, issue
   search/detail/comments, and project updates.
3. **Approved issue flow (1 week).** Create/update/comment with conflict and
   idempotency handling.
4. **Project updates (1 week).** Read/create status updates.
5. **Skills + rc (1 week).** Planning, standup, weekly status, GitHub composition.

## Verification

- OAuth rotation/reuse/revoke, workspace removal, selected-team change, missing
  scopes, and actor attribution.
- GraphQL fixtures for pagination, partial errors, deprecated fields, rate
  limits, schema drift, and bounded selection sets.
- Rust tests that forged workspace/team ids cannot escape the grant.
- Action conflict, timeout, retry, batch partial-success, and idempotency tests.
- Injection corpus in issues, comments, project updates, documents, labels, and
  user/team names.
- Live workspace walkthrough across two teams with different access.

## Rollout

Internal workspace, design partners, rc, stable. Use provider kill switch and
content-free telemetry. Monitor schema deprecations and pin contract fixtures
to the current provider API.

## ADR threshold

Local token custody/direct API calls can extend the local-mode pattern proposed
by ADR-0016 once that decision is accepted or superseded. A confidential token
exchange, app credential, or webhook relay requires an explicit ADR.
