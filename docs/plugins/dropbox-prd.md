# PRD: Dropbox plugin

- **Mode:** CEO
- **Overall rank:** 17 of 20
- **Score:** 59/100
- **Date:** 2026-07-14
- **Status:** Proposed; strongest local-mode candidate in follow-on set

## Thesis

Dropbox gives June a simple, broadly used file graph for meeting preparation
and artifact delivery. The plugin should search explicit folders, read files on
demand, and upload approved outputs without creating a new cloud index.

Dropbox ranks below Box because its governance advantage is weaker for June's
confidential enterprise story, but it has the clearest desktop auth path in the
follow-on set: Dropbox explicitly recommends PKCE with refresh tokens for
desktop apps that need background access.

## Customer and problem

Consultants and small teams keep briefs, proposals, and deliverables in Dropbox.
They manually gather files before meetings and file outcomes afterward. A broad
assistant integration can expose unrelated personal or team files.

## Product promise

Choose App Folder or selected full-Dropbox folders. June reads files only when
needed and uploads a reviewed local artifact only to the chosen destination.

## V1 experience

- Connect with browser OAuth and PKCE.
- Choose an App Folder deployment or explicit folders where full access is
  justified.
- Search metadata and read supported files on demand.
- Export a June artifact and approve a new file or new revision upload.
- Disconnect and revoke the Dropbox grant.

## Scope

### V1

- One account, explicit folder roots, metadata search, and folder listing.
- Bounded download/read through the artifact inspection pipeline.
- File revisions, sharing metadata for display, and canonical links.
- Approved upload of new files and revisions.
- On-device `list_folder` cursor and long poll while June is awake.

### Later

- Dropbox Business team administration, Paper-specific editing, signatures,
  multiple accounts, shared-link creation, and webhook-triggered away mode.

## Non-goals

- Full-account indexing or persistent content cache.
- Sharing, move, delete, restore, membership, or admin operations.
- Treating provider search results as authorization outside selected roots.
- Reading unsupported, encrypted, or oversized files silently.

## Privacy and trust

Dropbox's desktop PKCE and refresh-token guidance aligns with June local mode:
token in Keychain, provider calls on-device, and no reusable secret. App Folder
is preferred where it meets the job. Full Dropbox access requires explicit
copy and a folder allowlist enforced in Rust.

File content and metadata are untrusted. Upload approval shows account,
destination, file name, size, format, collision behavior, and June source.

## Business model

Local reads and approved uploads are Hobby. Triggered file reviews and
cross-plugin artifact routines are Pro.

## Success measures

| Metric | Target |
| --- | ---: |
| Connections selecting a first folder | 90% |
| Weekly connected users reading or uploading | 30% |
| File reads ending in unsupported/render error | under 3% |
| Access outside selected roots | 0 successful |
| Duplicate uploads after retry | 0 |

## Risks and gates

- Full Dropbox scope can be much broader than the user task.
- Large initial cursors and shared folder moves need careful reconciliation.
- Webhooks notify account changes but still require a public endpoint.
- Content search capability differs by account and endpoint.

## Decision requested

Approve Dropbox as the first follow-on connector-kit implementation, using
PKCE, selected folders, metadata-first reads, and approved upload only.

## Sources

- [Dropbox OAuth guide](https://developers.dropbox.com/oauth-guide)
- [Dropbox webhooks](https://www.dropbox.com/developers/reference/webhooks)
- [Dropbox API reference](https://www.dropbox.com/developers/documentation/http/documentation)
