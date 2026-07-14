# PRD: Box plugin

- **Mode:** CEO
- **Overall rank:** 14 of 20
- **Score:** 60/100
- **Date:** 2026-07-14
- **Status:** Proposed; auth and enterprise policy spike required

## Thesis

Box gives June live access to governed enterprise content without moving that
content into OpenSoftware infrastructure. The plugin should prepare meetings
from explicitly selected folders and attach reviewed outputs to the right Box
location.

Box ranks above Dropbox in the follow-on set because enterprise governance and
collaboration metadata strengthen the privacy and meeting-prep story. It ranks
below project tools because file access produces fewer direct actions.

## Customer and problem

Teams store contracts, briefs, and project documents in Box but manually gather
them before a meeting and manually file outcomes afterward. Full indexing adds
another sensitive corpus and can bypass expected folder context.

## Product promise

Choose the Box folders June may use. June reads a file only when the task needs
it and uploads an approved local artifact only to an explicit selected folder.

## V1 experience

- Connect one Box account and choose folders.
- Search selected folders by metadata and read a supported file on demand.
- Show owner, collaborators, classification signals, version, and canonical URL.
- Export a June document or spreadsheet artifact, then approve its upload.
- Disconnect and remove access, cursors, and runtime tools.

## Scope

### V1

- Folder selection and live metadata search.
- Bounded download/read for supported text, PDF, document, and spreadsheet
  formats through the existing artifact inspection pipeline.
- File version and collaboration metadata.
- Approved upload of a new file or new version.
- On-device polling for selected-folder changes while June is awake.

### Later

- Box Notes, Sign, Relay, metadata templates, classifications policy actions,
  multiple enterprises, and webhook-triggered routines.

## Non-goals

- Full-account indexing or content cache.
- Sharing, collaborator changes, deletion, moves, or retention-policy changes.
- Admin impersonation or enterprise-wide search.
- Claiming June can bypass Box policy or classification controls.

## Privacy and trust

Box OAuth grants access only to content available to the associated user and
can be further constrained by app scopes and token downscoping. The desktop
auth spike must confirm public-client feasibility, refresh rotation, and
enterprise authorization. June's selected folders are a stricter Rust-enforced
boundary.

File names, content, comments, classifications, and collaborator labels are
untrusted. Uploads are approval-only and display destination, file name, size,
format, and the June content being disclosed.

## Business model

Local reads and approved uploads are Hobby where the account permits them.
Enterprise policy support, triggered reviews, and artifact workflows are Pro.

## Success measures

| Metric | Target |
| --- | ---: |
| Connections selecting a first folder | 85% |
| Weekly connected users reading or uploading | 30% |
| Unsupported or incorrectly rendered file reads | under 3% |
| Access outside selected folders | 0 successful |
| Uploads to an unintended folder | 0 |

## Risks and gates

- OAuth app authorization and enterprise admin policy vary.
- V2 webhooks require HTTPS and cannot target the root folder.
- Refresh-token rotation and session state affect long-lived access.
- Large, encrypted, classified, or unsupported files need explicit outcomes.

## Decision requested

Approve a selected-folder Box pilot after auth and policy validation, with
read-on-demand and approved upload/new-version actions only.

## Sources

- [Box authentication methods](https://developer.box.com/platform/authentication-methods)
- [Box token lifecycle](https://developer.box.com/guides/authentication/tokens/index)
- [Box webhooks](https://developer.box.com/guides/webhooks)
