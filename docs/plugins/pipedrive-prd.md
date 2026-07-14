# PRD: Pipedrive plugin

- **Mode:** CEO
- **Overall rank:** 18 of 20
- **Score:** 59/100
- **Date:** 2026-07-14
- **Status:** Proposed; customer-demand and auth gates

## Thesis

Pipedrive offers a focused meeting-to-sales loop for smaller sales teams: find
the person and deal, record the call outcome, schedule the next activity, and
update a bounded set of deal fields.

It ties ClickUp and Dropbox on score but follows them because its current ICP is
narrower and a second CRM should not precede evidence from the HubSpot pilot.

## Customer and problem

Sales calls create follow-up activities and pipeline changes that are delayed
or lost when entered manually. Small teams need speed but still cannot afford a
wrong deal-stage update or private transcript disclosure.

## Product promise

Connect one Pipedrive company, choose pipelines, and turn a June meeting into a
reviewed note, activity, or selected deal update.

## V1 experience

- Connect and select pipelines.
- Search/read persons, organizations, deals, leads, activities, notes, stages,
  and owners.
- Link a meeting to selected records.
- Draft a note or follow-up activity and selected deal-field changes.
- Approve every mutation with destination and source disclosure visible.

## Scope

### V1

- One company account and explicit pipeline allowlist.
- Metadata-first search and bounded record reads.
- Approved note/activity create and reviewed deal updates.
- Live fetch and bounded polling while June is awake.

### Later

- Mail sync, products, files, custom app panels, multiple companies, broad
  custom fields, and webhook-triggered routines.

## Non-goals

- Marketing automation, bulk import/export, or lead enrichment.
- Admin, user, pipeline, stage, or permission configuration.
- Autonomous deal-stage movement at launch.
- Full CRM indexing.

## Privacy and trust

Pipedrive public OAuth and refresh behavior must be tested for desktop-safe
secret custody. Webhook management has dedicated scopes, but delivery still
requires public HTTPS and belongs to away mode. Pipeline and property
allowlists are enforced in Rust beyond provider permissions.

CRM content is untrusted. Approval names company, pipeline, records, field
diff, and June-originated content.

## Business model

Reads and approved updates are Hobby if auth passes. Triggered pipeline
briefings and cross-plugin sales routines are Pro.

## Success measures

| Metric | Target |
| --- | ---: |
| Connected users linking a first meeting | 70% |
| Weekly connected users completing an action | 35% |
| Updates needing record or stage correction | under 5% |
| Writes outside selected pipelines | 0 successful |
| Median post-call update time | under 2 minutes |

## Risks and gates

- Auth exchange and public marketplace requirements need verification.
- Custom fields and pipelines vary by company.
- Search has its own rate limit and broad queries can be expensive.
- Webhooks can be created for broad wildcard event sets and must stay bounded.

## Decision requested

Keep Pipedrive in the follow-on portfolio, but start only after HubSpot proves
the CRM schema and customer evidence supports a second provider.

## Sources

- [Pipedrive OAuth authorization](https://pipedrive.readme.io/docs/marketplace-oauth-authorization)
- [Pipedrive webhooks API](https://developers.pipedrive.com/docs/api/v1/Webhooks)
- [Pipedrive search rate limit](https://developers.pipedrive.com/changelog/post/announcing-search-api-rate-limit)
