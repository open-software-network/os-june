# Implementation plan: Notion plugin

- **Mode:** CTO
- **Date:** 2026-07-13
- **Status:** Proposed; auth spike required
- **PRD:** [notion-prd.md](notion-prd.md)
- **Issue:** JUN-283

## Technical objective

Expose selected Notion content through read and action MCP servers, with the
authorized page graph enforced in Rust and all writes parked for approval.

## Phase 0: auth boundary

Notion's documented public OAuth flow requires HTTP Basic authentication with
a client id and client secret during code exchange. A desktop binary cannot
protect that secret. Before implementation:

1. Confirm whether Notion supports PKCE or another public-client flow for
   distributed desktop apps.
2. Confirm whether the authorized access token can be returned to and stored
   only on the device after a narrowly scoped confidential exchange.
3. Reject an embedded secret and a generic OpenSoftware token vault.
4. If a TEE exchange, user-created internal connection, or other compromise is
   chosen, document the credential/data boundary in an ADR and consent copy.

Exit with a supported auth design, revoke flow, Marketplace/review requirements,
and an honest privacy claim.

## Proposed servers

| Server | Tools |
| --- | --- |
| `june_notion` | `search_pages`, `get_page`, `list_data_source`, `query_data_source`, `list_comments` |
| `june_notion_actions` | `create_page`, `update_page_properties`, `append_blocks`, `update_block` |

Tool results preserve page/block/data-source ids, parent ids, canonical URLs,
last-edited time, property schema, pagination cursor, and a compact content
representation. Full block trees are bounded by depth, count, and bytes.

## Authorization boundary

Notion's page picker and API permissions determine the maximum accessible
graph. Rust keeps a non-secret index of authorized root ids returned at connect
time and treats provider 403/404 as permission outcomes. It never infers access
from a cached path alone. Writes additionally require an approved parent within
the current accessible graph.

## State and events

- Keychain token if the Phase 0 design preserves device custody.
- Workspace/account id, bot id, authorized roots, capabilities, and health in
  SQLite.
- No page bodies or database row corpus at rest.
- V1 freshness is live fetch plus optional bounded polling of user-followed
  pages. Provider webhooks require public HTTPS and belong to away mode.

## Write model

- Create is preferred over broad in-place transformation.
- Updates operate on explicit page/block ids and include last-edited/version
  material where available.
- Approval shows workspace, destination breadcrumb, operation, property diff,
  and rendered content preview.
- A preflight re-reads destination state before commit. Stale state returns a
  conflict instead of overwriting.
- Autonomous mode is deferred.

## Delivery slices after Phase 0

1. **Connection shell (1 week):** workspace state, authorized roots, revoke,
   health, plugin detail.
2. **Read path (2 weeks):** search, page/block read, data-source query, comments,
   limits and pagination.
3. **Approved create (1 week):** create page with exact-parent approval.
4. **Targeted update (1-2 weeks):** properties and bounded block operations with
   conflict preflight.
5. **Skills and rc (1 week):** decision/project templates, metrics, runbook.

## Verification

- Auth, reconnect, revoke, removed-page-access, workspace removal, and partial
  capability matrix.
- Block-tree property tests for depth, pagination, unsupported types, mentions,
  embeds, equations, and files.
- Boundary tests that forged page/parent ids cannot escape authorized access.
- Conflict/idempotency tests for create and update around retries and restarts.
- Injection corpus in page title, rich text, comments, URLs, code blocks,
  database properties, and embedded content.
- Live workspace walkthrough with private/shared pages and schema changes.

## Rollout

Internal workspace, selected external workspaces, rc, stable. Use a provider
kill switch and content-free telemetry. Publish supported block/property types
and render unsupported content explicitly instead of dropping it.

## ADR threshold

Any backend-held secret or token, public webhook intake, or provider content
relay is a new trust boundary and requires an ADR before shipping.
