# PRD: Notion plugin

- **Mode:** CEO
- **Rank:** 6 of 10
- **Score:** 77/100
- **Date:** 2026-07-13
- **Status:** Proposed; tracked by JUN-283

## Thesis

Notion is the strongest knowledge-base complement to June's private note graph.
The plugin should bridge ephemeral meeting context and durable team knowledge:
prepare from selected pages and databases, then publish a reviewed decision
record, project update, or action list back to the right location.

It ranks below the universal and ecosystem plugins because many users do not
use Notion and its OAuth/token exchange creates a privacy-architecture question.
It ranks above software delivery tools because its workflows apply across roles.

## Customer and problem

Teams intend Notion to be the source of truth, but meeting outcomes arrive late,
inconsistently, or not at all. Before a meeting, people search pages manually.
Afterward, they translate notes into a page or database row and lose source
traceability. Broad workspace indexing solves search by increasing data copies.

## Product promise

Choose the Notion pages June may use. Prepare and publish from those bounded
sources while local June notes remain private unless the user explicitly sends
content to Notion.

## V1 experience

- Discover Notion from Plugins, then connect through the Connectors account
  surface and use Notion's page picker to select accessible roots.
- Search selected pages/data sources and read a page on demand.
- Link a June note to a Notion page without copying the entire note.
- Draft a decision record, project update, or action database entry from a
  meeting.
- Preview the destination, parent, properties, and content before creation or
  update.
- Disconnect and remove every Notion capability from the runtime.

## Scope

### V1

- Search, page/data-source metadata, bounded page/block read, comments read.
- Create a page under an approved parent.
- Append/update a narrowly targeted block range or database properties.
- Meeting brief, decision record, and project-update skills.
- Local polling while awake for explicitly followed pages if feasible.

### Later

- Multiple workspaces, broad sync, comments/actions, files, team-wide install,
  and webhook-triggered routines through an approved away-mode relay.

## Non-goals

- Replacing Notion search or editing UI.
- Mirroring an entire workspace into June or OpenSoftware.
- Accessing pages outside the Notion authorization/page picker.
- Autonomous publishing at launch.
- Treating every database schema as a generic spreadsheet.

## Packaging

- Required connector: Notion.
- Skills: meeting-to-decision, project update, research brief, page maintenance.
- Templates: decision log, weekly project status, customer meeting recap.
- Composition: Google/Microsoft calendar and Slack context can feed a draft;
  Notion remains the explicit publication destination.

## Privacy and trust

Notion public connections use OAuth and a client secret for token exchange. A
hosted MCP prototype proved device-token custody and tool discovery through
Notion's hosted MCP endpoint, but selected-resource scoping is still unproven.
Until live probes show that search, fetch, and data-source reads cannot see
unselected pages, the PRD must not claim selected-page-only access in shipped UI.

Notion content is untrusted input. The user-selected page set and provider
permissions form a hard boundary only after the provider or a Rust-enforced
authorized-root graph proves that boundary for every read path. All creates and
updates require approval in v1, with exact destination and diff visible.

Preview note, 2026-07-16: the hosted MCP preview may expose search, approved
page creation, and narrowly targeted page updates before selected-resource
scoping is proven. Hosted Notion search may include sources connected to the
user's Notion workspace when that workspace enables them. This does not change
the product promise above: shipped UI must keep the preview caveat visible,
disclose the hosted-search scope, and the connector must not claim
selected-page-only access until the boundary is proven or enforced in Rust.

## Business model

Local reads and approved publishing are Hobby if the auth design preserves the
privacy baseline. Triggered routines and cross-plugin publishing flows are Pro.

## Success measures

| Metric | Target |
| --- | ---: |
| Connections selecting at least one page root | 85% |
| Weekly connected users reading or publishing | 30% |
| Drafts approved and published | 60% |
| Published pages requiring a manual structural repair | under 5% |
| Reads outside authorized page roots | 0 successful |

## Risks and gates

- Confidential-client OAuth is the first gate.
- Notion APIs expose block trees and evolving data-source schemas; lossless
  editing is not a credible v1 promise.
- Webhooks require a public endpoint and can arrive out of order; local v1 does
  not quietly depend on them.
- Page content can instruct the model to publish or disclose unrelated data.

## Decision requested

Approve a bounded-page Notion plugin with read-on-demand and approved publish;
require the auth spike before implementation and defer webhook routines.

## Sources

- [Notion public connection authorization](https://developers.notion.com/guides/get-started/authorization)
- [Notion public connections](https://developers.notion.com/guides/get-started/public-connections)
- [Notion webhooks](https://developers.notion.com/reference/webhooks)
