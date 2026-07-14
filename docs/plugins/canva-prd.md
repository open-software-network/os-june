# PRD: Canva plugin

- **Mode:** CEO
- **Overall rank:** 20 of 20
- **Score:** 56/100
- **Date:** 2026-07-14
- **Status:** Proposed; server credential and review gates

## Thesis

Canva can turn meeting outcomes into reviewed visual work: find a relevant
design, create from an approved brand template when supported, and export a
presentation or graphic. V1 should focus on design discovery and export, not
promise arbitrary visual editing through an incomplete API.

Canva closes the follow-on set because creative output has strong leverage but
lower ICP frequency, Connect API credentials are designed for secure server
storage, and webhook features are preview-only and unavailable to public
integrations.

## Customer and problem

Small teams leave planning meetings with decks, one-pagers, and social assets to
produce. Recreating content manually is slow, while unrestricted design
automation risks brand drift and accidental publication.

## Product promise

Connect Canva, choose folders/designs, and let June prepare a bounded draft or
export job with the source note content and output format visible before action.

## V1 experience

- Connect one Canva account and choose folders/designs.
- Search/list design metadata and inspect supported comments or collaboration
  state where generally available.
- Start a reviewed export of an existing design to a supported format.
- If public APIs and review permit it, create from an approved brand template
  using explicit autofill fields.
- Download the completed export to a user-chosen local destination.

## Scope

### V1

- Design/folder metadata and explicit design selection.
- Asynchronous export jobs with supported-format discovery.
- Local download through June's artifact broker and native save approval.
- Template autofill only after Phase 0 confirms general availability and review.

### Later

- Comments, approvals, asset upload, folders, brand templates, bulk creation,
  multiple teams, and webhook-driven collaboration routines.

## Non-goals

- Arbitrary element-level editing or replacing the Canva editor.
- Silent publication, sharing, permission changes, deletion, or team admin.
- Claiming preview webhook/API capabilities can ship publicly.
- Storing Canva credentials in the desktop binary.

## Privacy and trust

Canva's Connect API security guidance treats the client secret as a credential
that must be stored securely and warns against environments that cannot protect
it. June must not embed it. The auth spike must approve a TEE exchange or defer
the integration. Selected designs/folders remain a narrower Rust-enforced
boundary after provider authorization.

Design metadata, comments, template fields, and imported text are untrusted.
Every export/create action is approval-only and displays the exact June content
sent to Canva.

## Business model

Canva is Pro because server exchange, API review, format support, and creative
quality validation create ongoing cost. Model and image-generation work uses
existing billing.

## Success measures

| Metric | Target |
| --- | ---: |
| Connected users selecting a first design/folder | 80% |
| Started export jobs completing successfully | 95% |
| Exports needing format or destination correction | under 5% |
| Actions outside selected designs/folders | 0 successful |
| Public release depending on preview APIs | 0 |

## Risks and gates

- Client-secret custody requires a new approved trust boundary.
- Public integration review rejects preview webhook use.
- Export support varies by design type and format.
- Autofill and brand-template availability may constrain the creation promise.

## Decision requested

Approve Canva research with export as the narrow v1. Do not schedule public
implementation until credential custody and API review are resolved.

## Sources

- [Canva Connect API security](https://www.canva.dev/docs/connect/guidelines/security/)
- [Canva export API](https://www.canva.dev/docs/connect/api-reference/exports/)
- [Canva webhooks](https://www.canva.dev/docs/connect/webhooks/)
- [Canva Connect APIs](https://www.canva.dev/docs/connect/)
