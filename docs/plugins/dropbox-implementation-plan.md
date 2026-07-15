# Implementation plan: Dropbox plugin

- **Mode:** CTO
- **Date:** 2026-07-14
- **Status:** Proposed; public-client path documented
- **PRD:** [dropbox-prd.md](dropbox-prd.md)

## Technical objective

Implement a selected-folder Dropbox connector with OAuth PKCE, refresh tokens
in Keychain, on-device long polling, bounded content reads, and approved upload.

## Phase 0: permission and content matrix

The auth path is documented, but implementation still begins with proof:

1. Test App Folder and Full Dropbox registration, PKCE S256, offline refresh,
   rotation, revoke, and app review.
2. Measure personal, shared, team, mounted, moved, and deleted folders.
3. Test search, `list_folder` cursors/long poll, revisions, range download,
   temporary links, and rate limits.
4. Define supported formats and byte/page limits with the artifact engine.

Exit with selected permission type, scope-to-tool matrix, and live fixtures.

## Proposed servers

| Server | Tools |
| --- | --- |
| `june_dropbox` | `search_files`, `list_folder`, `get_file_metadata`, `read_file`, `list_revisions` |
| `june_dropbox_actions` | `upload_file`, `upload_revision` |

Use stable ids and revisions for identity. Display paths are not authorization
keys because files and folders can move.

## Boundary and state

- Refresh token in Keychain; short-lived access token in memory.
- Account id, permission type, selected folder ids, cursors, capabilities,
  rate-limit state, and health in SQLite.
- Task-scoped temporary downloads only, deleted after inspection.
- Every result and mutation resolves stable id ancestry against selected roots.

## Upload model

- Render and verify the artifact locally before provider access.
- Approval shows destination, name, size, format, write mode, and source note.
- New revision requires the current provider revision.
- Upload-session offset and commit behavior are journaled for large files.
- Reconcile ambiguous commits by stable id, revision, path, size, and content
  hash before any retry.

## Events and quotas

Use `list_folder` plus on-device long poll while June is running. Persist the
cursor, handle reset correctly, and avoid treating a large initial enumeration
as an event stream. Public webhooks are deferred to away mode. Honor `429` and
provider retry headers.

## Delivery slices

1. PKCE, permission choice, folder picker, revoke, and health.
2. Metadata search/list, cursor management, and boundary enforcement.
3. Bounded content read through artifact inspection.
4. Approved file/revision upload with session reconciliation.
5. Skills, long polling, pilot, metrics, and kill switch.

## Verification

- PKCE, refresh, revoke, App Folder/full access, account unlink, and disconnect.
- Forged ids, folder/file moves, shared-folder removal, cursor reset, deleted
  items, name collisions, pagination, and rate limits.
- Large, encrypted, package, zero-byte, unsupported, and malicious files.
- Upload-session interruption, stale revision, duplicate commit, ambiguous
  timeout, and restart tests.
- Injection corpus in content, names, paths, sharing metadata, and links.
- Live personal and team-account walkthrough.

## ADR posture

The documented public-client PKCE path can extend ADR-0016 local mode after
proof. A webhook receiver or provider-content relay remains a separate ADR.
