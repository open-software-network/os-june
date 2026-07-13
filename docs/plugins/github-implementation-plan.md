# Implementation plan: GitHub plugin

- **Mode:** CTO
- **Date:** 2026-07-13
- **Status:** Proposed
- **PRD:** [github-prd.md](github-prd.md)
- **Issue:** JUN-285

## Technical objective

Replace personal-token-style setup with a first-party GitHub App path that
binds every tool call to an installation, selected repositories, the connected
user, and the existing approval broker.

## Phase 0: app/auth spike

- Register a development GitHub App with read-only repository metadata,
  contents, issues, pull requests, and checks; narrowly scoped issue/comment
  writes for the action phase.
- Verify the desktop user authorization flow with PKCE or device flow, GitHub
  App installation selection, short-lived token refresh, revoke events, and
  selected-repository changes.
- Determine whether any app private key is required for the user-scoped V1
  flows and where it can safely live. A reusable private key cannot ship in the
  desktop binary.
- Decide whether installation-token minting requires a TEE signer. If it does,
  record that credential boundary in an ADR while keeping provider content
  calls on-device.

## Proposed servers

| Server | Tools |
| --- | --- |
| `june_github` | `list_repositories`, `search_code`, `read_file`, `list_commits`, `list_issues`, `get_issue`, `list_pull_requests`, `get_pull_request`, `get_pull_request_diff`, `list_checks` |
| `june_github_actions` | `create_issue`, `comment_on_issue`, `comment_on_pull_request`, `submit_review` |

Each result includes owner, repository, stable node/database id, number or SHA,
URL, and permission/installation context. Diffs and files are byte/line bounded
and support explicit continuation.

## State and binding

- Keychain user refresh/access material where applicable.
- Non-secret GitHub user id, installation id, selected repositories, granted
  permissions, health, and last refresh in SQLite.
- Server-side route resolves installation and repository from the bound grant;
  model-supplied owner/repo is validated against it.
- No repository clone or source index in v1. Reads are live and bounded.

## Action safety

- Every write parks with exact repository, object, title/body or review diff,
  and source note references.
- Issue/comment creation uses a stable local action id and provider response
  journal to avoid duplicates.
- Review submission revalidates pull-request head SHA before commit.
- Merge, close, branch, content, workflow, release, secret, and administration
  operations do not exist in the server schema.
- Autonomous mode is deferred.

## Delivery slices

1. **App registration spike (1 week):** credential boundary, permission matrix,
   selected-repository lifecycle.
2. **Connection shell (1 week):** installation state, Keychain, health,
   repository selection updates, revoke.
3. **Delivery reads (2 weeks):** issues, PRs, diffs, commits, checks.
4. **Code reads (1 week):** search/file content bounds and binary handling.
5. **Approved writes (1 week):** issue, comment, review with journal/preflight.
6. **Skills and rc (1 week):** standup, risk, release notes, pilot.

## Verification

- Auth/install matrix: personal/org repository, all/selected repositories,
  owner denial, SSO, selection change, suspension, revoke, token refresh.
- Rust tests for installation and repository binding on every route.
- Pagination, secondary rate limits, diff truncation, renamed/deleted refs,
  force-push/stale SHA, and partial permission fixtures.
- Injection corpus in repository instructions, source, issues, PR bodies,
  comments, review threads, check output, and filenames.
- Action retry/idempotency and approval preflight tests.
- Live walkthrough on a dedicated organization and private repository.

## Rollout

Developer org, internal repos, selected open-source pilot, rc, stable. Content-
free telemetry and per-operation kill switches. Document exact GitHub App
permissions and why each is needed.

## ADR threshold

If a backend signer holds a GitHub App private key, that is a hard-to-reverse
credential boundary and requires an ADR. Provider repository content should
still travel device to GitHub unless a separately accepted design says otherwise.
