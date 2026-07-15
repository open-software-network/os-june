# Implementation plan: Asana plugin

- **Mode:** CTO
- **Date:** 2026-07-14
- **Status:** Proposed; auth spike required
- **PRD:** [asana-prd.md](asana-prd.md)

## Technical objective

Implement project-bounded Asana reads and approved task actions on a reusable
project connector schema while preserving provider ids and custom-field types.

## Phase 0: auth and schema spike

1. Test OAuth authorization, PKCE, token exchange, refresh, revoke, and app
   distribution with a native loopback redirect.
2. Confirm whether the client secret is mandatory when PKCE is used.
3. Map endpoints to current granular scopes and the full-permissions fallback.
4. Exercise public/private projects, guests, removed membership, custom fields,
   and multi-home tasks.
5. Reject an embedded secret and record any backend exchange in an ADR.

Exit with an approved token path, scope matrix, and supported object contract.

## Proposed servers

| Server | Tools |
| --- | --- |
| `june_asana` | `list_projects`, `search_tasks`, `get_task`, `list_task_comments`, `get_project_schema` |
| `june_asana_actions` | `create_task`, `update_task`, `add_task_comment` |

All results preserve workspace, project, task, parent, section, assignee,
modified time, custom-field type, canonical URL, and pagination metadata.

## Boundary and state

- Keychain token if the auth design allows device custody.
- Workspace id, selected project ids, scope/capability set, schema metadata,
  polling cursors, and health in SQLite.
- No task or comment corpus at rest.
- Rust resolves multi-home task memberships and permits a read or write only
  when at least one current selected project supplies the intended context.

## Write model

- Create requires an exact selected project and section.
- Update uses an explicit field patch and fresh modified time.
- Custom-field writes validate current type, enum option, and project schema.
- Approval shows destination breadcrumb, owner, dates, field diff, and the
  June-originated action text.
- Create retries reconcile by a stable fingerprint against recent tasks in the
  same project. If uniqueness cannot be established, replay is blocked.

## Events and quotas

Local v1 uses bounded polling with `modified_since` where supported. Asana
webhooks require a public endpoint and handshake, so they belong to away mode.
Respect quota headers and retry guidance with token-scoped backoff.

## Delivery slices

1. Connection, project picker, capabilities, revoke, and health.
2. Project/task/comment reads and schema normalization.
3. Approved task creation and duplicate reconciliation.
4. Approved targeted updates and comments.
5. Skills, local polling, rc dogfood, and metrics.

## Verification

- OAuth, refresh, revoke, denied scope, guest access, removed membership, and
  disconnect.
- Forged project/task ids, multi-home tasks, archived projects, pagination,
  deleted users, and custom-field schema changes.
- Stale update, duplicate create, timeout, rate-limit, and restart tests.
- Prompt-injection corpus in task text, comments, custom fields, user names,
  project descriptions, and attachment metadata.
- Live workspace walkthrough with private and guest-visible projects.

## ADR threshold

Any confidential exchange, backend token custody, or webhook content path
changes the connector trust boundary and requires an ADR before shipping.
