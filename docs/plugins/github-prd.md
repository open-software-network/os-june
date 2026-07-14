# PRD: GitHub plugin

- **Mode:** CEO
- **Rank:** 7 of 10
- **Score:** 73/100
- **Date:** 2026-07-13
- **Status:** Proposed; tracked by JUN-285

## Thesis

GitHub turns June's meeting memory into software delivery follow-through. The
plugin should prepare engineering meetings from repositories and pull requests,
connect decisions to code, draft issues or review comments, and summarize what
changed since the conversation.

It ranks seventh because it is extremely valuable for June's technical early
adopters but narrower than the cross-role plugins above it. It can ship with
high confidence because GitHub Apps provide fine-grained repository permissions
and short-lived tokens.

## Customer and problem

Engineering teams discuss architecture, bugs, and priorities in meetings, then
reconstruct the same context in GitHub. Product and customer decisions rarely
stay linked to the pull requests that implement them. Broad personal access
tokens are easy to create and hard to justify.

## Product promise

Choose repositories during GitHub App installation. June can read and explain
those repositories and draft bounded delivery actions, while GitHub and the
user's own permissions remain the authority.

## V1 experience

- Install the June GitHub App on selected repositories.
- Ask June to prepare a standup/review from issues, pull requests, commits, and
  relevant code.
- Link a June note to a repository, issue, or pull request.
- Draft an issue, issue comment, pull-request review, or status summary.
- Review and approve every GitHub write.
- Repositories removed from the installation disappear from June immediately.

## Scope

### V1

- Repository metadata, code/file search and bounded read, commits, issues,
  pull requests, reviews, checks, and discussions needed for the core flows.
- Draft/create issues and comments; submit review comments behind approval.
- Engineering standup, PR risk brief, release note, and decision-to-issue skills.

### Later

- Enterprise Server, organization administration, workflow dispatch, merge,
  branch/file writes, secrets, deployments, and webhook-triggered routines.

## Non-goals

- A coding agent or local git replacement.
- Repository write access at launch.
- Merge, close, delete, workflow dispatch, or release publication.
- Broad classic personal access tokens as the primary setup.
- Reading repositories outside the installation selection.

## Packaging

- Required connector: GitHub App installation.
- Skills: standup, PR risk, release notes, issue drafting, implementation trace.
- Templates: weekly engineering update, stale review queue, meeting decisions to
  issues.
- Composition: Linear and Slack are optional destinations/sources.

## Privacy and trust

Prefer a GitHub App with selected repositories and minimum permissions. User
access tokens are short-lived and refreshed from Keychain-held material; calls
originate on-device where GitHub's auth model permits. GitHub source is
untrusted input, especially issue bodies, comments, and repository instruction
files. Writes require approval in v1.

## Business model

Read and approved issue/comment flows are Hobby. Recurring cross-repository
briefings and cross-plugin routines are Pro.

## Success measures

| Metric | Target |
| --- | ---: |
| Installs selecting at least one repository | 90% |
| Weekly connected users running a delivery brief | 35% |
| Drafted GitHub actions approved | 55% |
| Writes targeting the wrong repository/object | 0 |
| Reads outside installation repository selection | 0 successful |

## Risks and gates

- GitHub App manifest, user authorization, and installation authorization are
  distinct states.
- Large repositories and diffs require strict retrieval bounds.
- Repository content can contain adversarial instructions.
- Enterprise Server needs host-specific security and is not v1 parity.

## Decision requested

Approve a selected-repository GitHub App, read-rich but write-narrow, with all
writes approved and merge/repository mutations deferred.

## Sources

- [Choosing GitHub App permissions](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app)
- [GitHub user access tokens](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app)
