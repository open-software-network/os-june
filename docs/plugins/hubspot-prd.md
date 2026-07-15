# PRD: HubSpot plugin

- **Mode:** CEO
- **Overall rank:** 11 of 20
- **Score:** 63/100
- **Date:** 2026-07-14
- **Status:** Proposed; auth and scope spike required

## Thesis

HubSpot is the strongest next integration because customer meetings naturally
produce CRM work: associate the meeting with the right company and deal,
record the outcome, create the follow-up task, and prepare a reviewed note.
June can do that work from the local meeting record without becoming another
cloud copy of the customer's CRM.

HubSpot leads the follow-on set because it has high action leverage and a more
accessible small-team footprint than enterprise CRM alternatives. It remains
outside the first ten because the published OAuth exchange uses a client
secret and some CRM read scopes can exceed the authorizing user's UI access.

## Customer and problem

Founders, consultants, and customer-facing teams finish a call with the best
context in their heads and in June, but the CRM stays stale. Manual entry loses
details and delays follow-up. Broad automation can silently write to the wrong
deal or disclose private notes.

## Product promise

Connect one HubSpot account, select the pipelines June may use, and turn a June
meeting into a reviewed CRM update with the exact records and disclosed note
content visible before commit.

## V1 experience

- Search allowed deals and the contacts, companies, owners, and recent
  engagements currently associated with them.
- Link a June note to one contact, company, and deal without copying the full
  transcript.
- Draft a meeting note, deal-stage update, next step, or follow-up task.
- Preview property changes and associations against fresh provider state.
- Approve each create or update. Autonomous CRM writes are deferred.
- Disconnect and verify that reads, polling, and action tools stop.

## Scope

### V1

- One HubSpot account and an explicit pipeline allowlist.
- Metadata-first search and bounded record reads, with non-deal records
  reachable only through a current association to an allowed deal.
- Read contact, company, deal, owner, pipeline, and engagement context.
- Create an engagement note or task and update selected deal properties.
- Stable HubSpot links in June responses.
- Live fetch plus bounded on-device polling while June is awake.

### Later

- Tickets, custom objects, marketing events, conversations, multiple portals,
  and away-mode webhook triggers.

## Non-goals

- Mirroring the CRM into June or OpenSoftware infrastructure.
- Bulk enrichment, marketing automation, or lead scoring.
- Editing unrestricted custom properties.
- Advancing deal stages autonomously at launch.
- Assuming an OAuth scope preserves the user's record-level UI restrictions.

## Packaging

- Required connector: HubSpot.
- Skills: meeting-to-CRM, deal review, customer follow-up, pipeline brief.
- Templates: post-call update, stale-next-step check, meeting prep.
- Composition: calendar identifies attendees; email drafts follow-up; June
  notes provide the user-selected source context.

## Privacy and trust

HubSpot's OAuth token and provider calls should remain on-device, but its
documented authorization and refresh exchanges require a client secret. The
auth spike must resolve that boundary before June promises local-mode token
custody. HubSpot also documents that an app's CRM scopes can provide access
beyond the authorizing user's ordinary owned-record view, so June must enforce
selected pipelines independently. Contacts, companies, and engagements are not
pipeline records; June returns them only when a live provider association
connects them to a deal currently in an allowed pipeline.

CRM text and properties are untrusted input. Every write is approval-only in
v1, with portal, object, record, changed fields, and June-originated content in
the preview.

## Business model

Local reads and approved single-record updates are Hobby if the auth design
preserves the privacy baseline. Triggered pipeline reviews and cross-plugin
sales routines are Pro. Provider API calls are not separately metered.

## Success measures

| Metric | Target |
| --- | ---: |
| Connected users linking a first meeting to a record | 70% |
| Weekly connected users completing a CRM update | 35% |
| Approved updates requiring correction within 24 hours | under 5% |
| Writes outside selected pipelines | 0 successful |
| Median connect-to-first-record-link time | under 4 minutes |

## Risks and gates

- Confidential OAuth exchange and public app review are release gates.
- CRM scopes can be broader than an individual user's UI permissions.
- Custom properties and associations vary by portal.
- Webhooks require public HTTPS and belong to away mode.
- Duplicate records and stale deal state make blind retries unsafe.

## Decision requested

Approve HubSpot as the first confidential-exchange spike and the first CRM
candidate after the original portfolio, with pipeline-bounded reads and
approval-only writes.

## Sources

- [HubSpot OAuth quickstart](https://developers.hubspot.com/docs/apps/developer-platform/build-apps/authentication/oauth/oauth-quickstart-guide)
- [HubSpot webhooks guide](https://developers.hubspot.com/docs/api-reference/latest/webhooks/guide)
- [HubSpot CRM objects guide](https://developers.hubspot.com/docs/guides/api/crm/objects/overview)
