# Implementation plan: GitLab Issues plugin

- **Mode:** CTO
- **Date:** 2026-07-14
- **Status:** Proposed; GitLab.com-first
- **PRD:** [gitlab-prd.md](gitlab-prd.md)

## Technical objective

Implement a host-pinned, project-bounded GitLab Issues connector using OAuth
PKCE and approval-gated issue/comment actions. Preserve GitLab resource ids and
version differences rather than forcing GitHub response shapes.

## Phase 0: API and host matrix

1. Verify GitLab.com PKCE, refresh, revoke, scope minimization, and app review.
2. Test REST versus GraphQL coverage for issues, comments, labels, milestones,
   and projects, then choose one canonical read path per object.
3. Capture rate-limit, pagination, tier, confidential-resource, and partial
   permission behavior.
4. Build a deferred self-managed matrix for supported versions, URL base paths,
   TLS, OAuth registration, and API differences.

Exit with GitLab.com scope/tool fixtures and no self-managed promise.

## Proposed servers

| Server | Tools |
| --- | --- |
| `june_gitlab_issues` | `list_projects`, `search_issues`, `get_issue`, `list_issue_comments`, `list_labels`, `get_milestone` |
| `june_gitlab_issues_actions` | `create_issue`, `add_issue_comment` |

Results include host, namespace/project id, visibility, iid and global id,
updated time, state, labels, assignees, canonical URL, and pagination metadata.

## Boundary and state

- Keychain token and a fixed provider origin.
- User id, selected group/project ids, capabilities, cursors, rate-limit state,
  and health in SQLite.
- No issue, discussion, code, or job-log corpus at rest.
- Rust resolves namespace/project identity from the provider response before
  returning data. Tool input cannot supply an arbitrary API base URL.

## Write model

- Issue create requires exact project, title, description, labels, and
  assignees validated against current project capabilities.
- Comment actions require a current issue and display confidentiality.
- Approval includes host, project, target, visibility, labels, and note excerpt.
- Reconcile ambiguous creates using a stable hidden marker only if acceptable
  in issue text; otherwise search recent matching issues and require confirmation
  when uniqueness is not certain.
- Comments reconcile by recent-note fingerprint before replay.

## Events and limits

V1 polls selected projects for updated issues while awake.
Project/group webhooks require a public endpoint and permissions, so they stay
in away mode. Respect deployment-specific `429`, `Retry-After`, and rate-limit
headers without assuming GitLab.com and self-managed parity.

## Delivery slices

1. PKCE, project picker, origin pinning, revoke, and health.
2. Issue/comment reads, labels, milestones, and search.
3. Approved issue and comment actions with reconciliation.
4. Issue-focused skills and bounded polling.
5. GitLab.com pilot and self-managed research backlog.

## Verification

- PKCE connect, refresh, revoke, scope denial, project removal, confidential
  issue denial, suspended user, and disconnect.
- Forged host/project ids, redirects, namespaces moves, archived projects,
  pagination, tier differences, and `429` fixtures.
- Duplicate issue/comment, timeout, stale target, and restart tests.
- Injection corpus in issue text, comments, labels, milestone text, project
  metadata, user names, and URLs.
- Live GitLab.com walkthrough across public, private, and confidential objects.

## ADR threshold

GitLab.com PKCE with on-device REST extends local mode after verification.
Self-managed arbitrary-host access, backend token exchange, or webhook intake
adds trust boundaries and requires an ADR before shipping.
