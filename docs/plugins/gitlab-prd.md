# PRD: GitLab Issues plugin

- **Mode:** CEO
- **Overall rank:** 15 of 20
- **Score:** 60/100
- **Date:** 2026-07-14
- **Status:** Proposed; GitLab.com-first pilot

## Thesis

GitLab Issues brings June's meeting context into software delivery for teams
outside GitHub. The plugin should prepare from selected issues and issue
comments, then create reviewed issues or comments with source traceability.

GitLab Issues ties Box on score but follows it because the software-team
segment is narrower and self-managed deployments add host, version, and policy
variance. Its documented PKCE support makes device-local auth credible.

## Customer and problem

Engineering decisions are split between meetings and GitLab. Teams retype
issues, lose rationale, and prepare status updates by searching projects and
pipelines manually. A broad token or model-selected host would create serious
code and metadata exposure.

## Product promise

Connect GitLab.com, choose groups and projects, and let June read live delivery
context or propose bounded issue/comment actions under approval.

## V1 experience

- Authorize with PKCE and select groups/projects.
- Search/read issues, issue comments, labels, milestones, and project metadata.
- Create an issue or add a comment from a June meeting.
- Preview destination, visibility, labels, assignees, and disclosed note text.
- Disconnect and verify provider access and tools are gone.

## Scope

### V1

- GitLab.com only, one account, explicit project allowlist.
- Metadata-first search and bounded issue/comment reads.
- Approved issue creation and issue comment.
- Local polling while June is awake.

### Later

- Tested self-managed versions, group-wide install, merge requests, pipelines,
  releases, code/file reads, issue updates, and webhook-triggered routines.

## Non-goals

- Repository clone, code write, branch push, merge, pipeline retry, deployment,
  secret, variable, runner, or membership administration.
- Sending tokens to model-selected GitLab hosts.
- Claiming compatibility with untested self-managed versions.

## Privacy and trust

GitLab recommends authorization code with PKCE for public clients. Tokens stay
in Keychain and calls go from the Mac to a pinned GitLab.com origin in v1.
Project selection is enforced in Rust. Self-managed support requires explicit
host trust, TLS policy, version discovery, and separate test coverage.

Issues, comments, labels, milestone text, project metadata, and links are
untrusted. Writes are approval-only.

## Business model

GitLab.com reads and approved actions are Hobby. Self-managed support, status
routines, and cross-plugin engineering workflows are Pro.

## Success measures

| Metric | Target |
| --- | ---: |
| Connections selecting a first project | 85% |
| Weekly connected users completing a GitLab-backed task | 30% |
| Created issues needing project or scope correction | under 4% |
| Access outside selected projects or pinned hosts | 0 successful |
| Median project status brief latency | under 20 seconds |

## Risks and gates

- Self-managed versions, base paths, TLS, and administrator limits vary.
- API scopes can be broad relative to the intended read/action surface.
- Webhooks need public endpoints and project/group administration.
- Search and webhook limits differ by deployment.

## Decision requested

Approve a GitLab.com-first plugin using PKCE, project-bounded reads, and
approval-only issue/comment actions. Defer self-managed support to a matrix.

## Sources

- [GitLab OAuth 2.0 provider API](https://docs.gitlab.com/api/oauth2/)
- [GitLab issues API](https://docs.gitlab.com/api/issues/)
- [GitLab project webhooks API](https://docs.gitlab.com/api/project_webhooks/)
- [GitLab rate limits](https://docs.gitlab.com/security/rate_limits/)
