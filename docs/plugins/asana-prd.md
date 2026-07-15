# PRD: Asana plugin

- **Mode:** CEO
- **Overall rank:** 13 of 20
- **Score:** 61/100
- **Date:** 2026-07-14
- **Status:** Proposed; auth spike required

## Thesis

Asana extends June's meeting-to-action loop beyond product engineering. It
should prepare from selected projects, then turn approved meeting outcomes into
tasks, comments, owners, and dates without indexing a workspace.

Asana ranks above the other follow-on project tools because its cross-functional
usage broadens June beyond Linear while retaining a reasonably bounded task
model. Confidential OAuth exchange keeps delivery confidence below the first
portfolio.

## Customer and problem

Teams leave meetings with actions that are manually retyped into Asana, often
without source context or clear ownership. Broad project access makes a wrong
destination or duplicate task especially costly.

## Product promise

Select the Asana projects June may use. Prepare from live project context and
create or update explicit tasks only after the destination and field diff are
approved.

## V1 experience

- Connect one Asana account and choose a workspace plus projects.
- Search/read selected projects, tasks, subtasks, comments, sections, and users.
- Draft tasks from meeting action items with owner, due date, and source link.
- Draft a comment or selected field update on an existing task.
- Preview and approve every write.
- Disconnect and remove all Asana runtime capabilities.

## Scope

### V1

- One workspace and project allowlist.
- Metadata-first task search and bounded task/comment reads.
- Create task, add comment, and update name, description, assignee, due date,
  completion, section, and reviewed custom fields.
- Local polling of linked tasks while June is awake.

### Later

- Portfolios, goals, rules, forms, broad custom-field support, multiple
  workspaces, attachments, and webhook-triggered routines.

## Non-goals

- Full-workspace sync or replacement project UI.
- Creating rules or changing workspace/project administration.
- Autonomous task completion, reassignment, or due-date changes at launch.
- Assuming a custom-field schema is stable across projects.

## Privacy and trust

Asana documents authorization code with PKCE, but its token exchange and revoke
examples also require the app's client secret. June must prove a supported
desktop-safe flow or choose an approved credential boundary before making a
local-mode claim. Project selection is enforced in Rust in addition to Asana's
own permissions.

Task names, descriptions, comments, custom fields, and attachments are
untrusted. Every create and update is approval-only in v1.

## Business model

Local reads and approved actions are Hobby if auth preserves the privacy
baseline. Triggered project digests and multi-plugin routines are Pro.

## Success measures

| Metric | Target |
| --- | ---: |
| Connections selecting a first project | 85% |
| Weekly connected users creating or updating a task | 35% |
| Created tasks needing destination or owner correction | under 5% |
| Access outside selected projects | 0 successful |
| Median note-to-approved-task time | under 90 seconds |

## Risks and gates

- Confidential OAuth exchange is the first gate.
- Custom fields, memberships, and permissions vary by workspace and project.
- Webhook creation requires a reachable endpoint and handshake.
- Task creation lacks value if duplicate reconciliation is unreliable.

## Decision requested

Approve Asana as the shared project-schema reference after Linear, limited to
selected projects and approval-only task/comment actions.

## Sources

- [Asana OAuth](https://developers.asana.com/docs/oauth)
- [Asana webhooks](https://developers.asana.com/reference/createwebhook)
- [Asana rate limits](https://developers.asana.com/docs/rate-limits)
