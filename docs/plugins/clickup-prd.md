# PRD: ClickUp plugin

- **Mode:** CEO
- **Overall rank:** 16 of 20
- **Score:** 59/100
- **Date:** 2026-07-14
- **Status:** Proposed; auth posture blocks scheduling

## Thesis

ClickUp can extend June's meeting-to-action flow to teams that consolidate
projects, docs, goals, and time tracking in one workspace. V1 should stay
narrow: selected Spaces/Lists, task context, and reviewed task/comment actions.

ClickUp follows Asana because the jobs overlap, its API authentication uses a
client secret, and current OAuth access tokens do not expire. Those properties
need resolution before June can make a credible local-mode security claim.

## Customer and problem

Teams leave meetings with tasks that must be mapped into ClickUp's hierarchy,
custom fields, and statuses. Manual entry is slow; generic automation easily
chooses the wrong Workspace, Space, Folder, or List.

## Product promise

Select the exact ClickUp locations June may use. June reads current task
context and proposes actions with the full hierarchy, field diff, and note
content visible before approval.

## V1 experience

- Connect one Workspace and choose Spaces/Folders/Lists.
- Search/read tasks, subtasks, comments, statuses, users, and custom fields.
- Create a task or add a comment from a June meeting.
- Update a bounded set of task fields after approval.
- Disconnect and verify the long-lived token is invalidated or unusable.

## Scope

### V1

- One Workspace and selected location roots.
- Metadata-first task search and bounded detail/comment reads.
- Approved task create, comment, and selected-field update.
- Live fetch and bounded polling while June is awake.

### Later

- Docs, Goals, time tracking, dependencies, multiple Workspaces, attachments,
  broad custom-field support, and webhook-triggered routines.

## Non-goals

- Full Workspace indexing.
- Admin, member, automation, template, billing, or permission changes.
- Autonomous task changes at launch.
- Treating a non-expiring token as acceptable without revocation proof.

## Privacy and trust

ClickUp's documented OAuth code exchange uses a client secret, and current
access tokens do not expire. The auth spike must prove supported revocation,
rotation, storage, and a desktop-safe exchange. Until then the integration is
research-approved but not schedule-ready.

Task content and hierarchy labels are untrusted. Every write is approval-only,
with selected location enforcement in Rust.

## Business model

Local reads and approved actions are Hobby if auth passes. Triggered workspace
briefs and cross-plugin project routines are Pro.

## Success measures

| Metric | Target |
| --- | ---: |
| Connections selecting at least one List | 85% |
| Weekly connected users completing a task action | 30% |
| Actions needing hierarchy or status correction | under 5% |
| Access outside selected locations | 0 successful |
| Orphaned valid tokens after disconnect | 0 |

## Risks and gates

- Confidential OAuth exchange and non-expiring tokens are release blockers.
- Workspace-plan rate limits range materially by plan.
- Hierarchy and custom fields create high schema variance.
- Webhooks require public HTTPS, although payloads are signed.

## Decision requested

Approve ClickUp research and shared project-schema work, but do not schedule
implementation until token lifecycle and confidential exchange are resolved.

## Sources

- [ClickUp authentication](https://developer.clickup.com/docs/authentication)
- [ClickUp webhooks](https://developer.clickup.com/docs/webhooks)
- [ClickUp webhook signatures](https://developer.clickup.com/docs/webhooksignature)
- [ClickUp rate limits](https://developer.clickup.com/docs/rate-limits)
