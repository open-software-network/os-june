# PRD: Linear plugin

- **Mode:** CEO
- **Rank:** 8 of 10
- **Score:** 69/100
- **Date:** 2026-07-13
- **Status:** Proposed; tracked by JUN-284

## Thesis

Linear is the cleanest bridge from meeting decisions to product execution.
June should prepare reviews from projects and issues, then draft the concrete
issues, updates, and comments a team needs after the meeting.

It ranks below GitHub because the audience is narrower and much of the value
composes with GitHub, but it has a well-defined GraphQL/OAuth surface and a
high-value action loop.

## Customer and problem

Product and engineering teams discuss work in meetings, then manually recreate
decisions in Linear. Issues lack the rationale in the note; notes lack the live
delivery state in Linear. Status reporting becomes repeated synthesis.

## Product promise

Connect a Linear workspace and let June turn selected meeting outcomes into
reviewed issues and updates, with the workspace, team, project, and exact change
visible before anything is written.

## V1 experience

- Connect a workspace and select allowed teams.
- Prepare a planning or status meeting from projects, cycles, issues, and recent
  updates.
- Turn action items into draft issues with team/project, title, description,
  assignee suggestion, and source note reference.
- Approve issue creation, comments, and project updates individually or as a
  clearly previewed batch.
- Link June notes to Linear objects and refresh status on demand.

## Scope

### V1

- Read teams, users, projects, cycles, initiatives, issues, comments, and project
  updates within selected teams.
- Create issue, update a narrow issue field set, add comment, create project
  update behind approval.
- Planning brief, standup, issue drafting, and weekly project-status skills.

### Later

- Customers, customer requests, releases, SLA, documents, agent sessions,
  webhook routines, and autonomous triage.

## Non-goals

- Replacing Linear's planning UI.
- Bulk reprioritization, deletion, archive, workspace administration, or team
  configuration.
- Full workspace indexing.
- Autonomous issue mutation at launch.

## Privacy and trust

Use Linear OAuth with refresh-token rotation and store token material in the
Keychain if the public client flow supports a desktop-safe exchange. Calls
originate on-device. Team selection is enforced in Rust. Issue/comment content
is untrusted. Every write is approved in v1.

## Business model

Local reads and approved writes are Hobby. Recurring status routines and
cross-plugin GitHub/Slack workflows are Pro.

## Success measures

| Metric | Target |
| --- | ---: |
| Connections selecting at least one team | 90% |
| Weekly connected users running a planning/status brief | 35% |
| Draft issues approved | 60% |
| Created issues needing team/project correction | under 2% |
| Reads/writes outside selected teams | 0 successful |

## Risks and gates

- OAuth flow and refresh-token rotation changed in 2026; implementation must
  follow current provider behavior.
- Webhooks require public HTTPS and therefore away mode.
- GraphQL makes over-fetching easy; every operation needs bounded selections.
- Model-generated priority/assignee choices can look authoritative when they
  are suggestions.

## Decision requested

Approve selected-team read access and approved narrow writes; pair the product
launch with GitHub composition but do not block either plugin on the other.

## Sources

- [Linear OAuth 2.0](https://linear.app/developers/oauth-2-0-authentication)
- [Linear webhooks](https://linear.app/developers/webhooks)
- [Linear developer platform](https://linear.app/developers)
