# Implementation plan: Box plugin

- **Mode:** CTO
- **Date:** 2026-07-14
- **Status:** Proposed; auth and enterprise spike required
- **PRD:** [box-prd.md](box-prd.md)

## Technical objective

Expose selected Box folders through metadata-first reads and approval-gated
artifact upload while enforcing current folder ancestry in Rust.

## Phase 0: auth and policy matrix

Test individual, Business, and enterprise-admin-restricted accounts for:

- OAuth authorization, public-client/PKCE support, refresh-token rotation,
  server revoke, app authorization, and downscoped tokens;
- app access levels, user permissions, classifications, legal holds, and shared
  versus owned folders;
- file size, range download, version, collaboration, search, and rate limits;
- V2 webhook scope, signatures, root-folder limits, and session expiry.

Exit with a desktop-safe auth path or a documented deferral, plus supported
account and policy matrices.

## Proposed servers

| Server | Tools |
| --- | --- |
| `june_box` | `search_files`, `list_folder`, `get_file_metadata`, `read_file`, `list_versions` |
| `june_box_actions` | `upload_file`, `upload_new_version` |

Read tools return metadata first. Content fetch is a separate bounded call
with byte, page, expansion, and format limits and an explicit unsupported
result.

## Folder boundary and state

- Keychain token material when Phase 0 permits local custody.
- Account/enterprise id, selected root folder ids, capabilities, cursors,
  non-secret metadata, and health in SQLite.
- No file body cache beyond task-scoped temporary artifacts that are deleted.
- Rust re-resolves parent ancestry for every file and destination. Cached paths
  are display hints, never authorization evidence.

## Upload model

- Export and inspect the local artifact before upload.
- Approval shows account, folder breadcrumb, file/version target, size, format,
  classification context, and source June note.
- Existing-name collisions require an explicit new-file or new-version choice.
- New versions preflight current version id. A mismatch is a conflict.
- Automatic retry requires provider-supported upload-session/idempotency proof;
  otherwise reconcile by folder, name, size, and content hash before replay.

## Events

Local mode polls selected folders with persisted cursors. Box V2 webhooks need
public HTTPS, cannot attach to root, and depend on active auth sessions. They
belong to away mode and require signature and replay verification.

## Delivery slices

1. Auth, folder picker, policy/capability display, revoke, and health.
2. Metadata search, folder reads, ancestry enforcement, and pagination.
3. Bounded content bridge to the artifact inspection pipeline.
4. Approved upload and new-version conflict handling.
5. Skills, local polling, enterprise pilot, and metrics.

## Verification

- Refresh rotation, revoked grant, admin disable, collaborator removal,
  classification denial, shared folder, and disconnect.
- Forged ids, moved files, renamed folders, deleted parents, shortcuts, and
  cross-enterprise collaborations.
- Large, zero-byte, encrypted, unsupported, malicious-name, and archive files.
- Upload timeout, collision, stale version, duplicate acknowledgement, and
  restart tests.
- Injection corpus in content, names, descriptions, comments, and metadata.
- Live enterprise sandbox walkthrough with restricted policy.

## ADR threshold

A backend OAuth exchange, webhook receiver, or file-content relay is a new
trust boundary and requires an ADR. Local polling and on-device Box calls can
extend the existing connector pattern after Phase 0 proof.
