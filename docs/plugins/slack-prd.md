# PRD: Slack plugin

- **Mode:** CEO
- **Rank:** 3 of 10
- **Score:** 86/100
- **Date:** 2026-07-13
- **Status:** Proposed; anticipated by the connector roadmap

## Thesis

Slack is where meeting decisions become team commitments and where those
commitments are later lost. A June Slack plugin should let users prepare from
relevant conversations, publish a reviewed meeting recap, answer follow-up
questions from the local note graph, and turn messages into routines without
copying the workspace into OpenSoftware infrastructure.

Slack ranks third because it adds team distribution to June's private local
context. The combination is more valuable than a generic chat bot: June can
connect a channel thread to the actual meeting note and transcript on the
user's Mac.

## Customer and problem

Small teams use Slack as their operating memory, but important context is split
between channels, DMs, meeting notes, and individual recollection. People
rewrite status updates, lose decisions, and answer questions without the
source meeting in view. Cloud assistants often solve retrieval by ingesting the
workspace. June's customer wants the utility without creating another copy.

## Product promise

Connect one Slack workspace, choose the channels June may read, and let June
prepare or publish bounded team updates with every outward action visible and
governed.

## V1 experience

- Connect from the plugin tile in the system browser.
- Choose a small allowlist of channels. DMs and private channels are excluded
  until explicitly added and supported by the granted scopes.
- Ask June to summarize a thread, prepare for a meeting, or find prior context.
- From a June note, draft a channel recap with decisions, owners, and links.
- Review and approve every post or reply before it leaves the Mac.
- Use templates for daily standup, meeting recap, unanswered mentions, and
  promised follow-ups.
- Disconnect and verify that reads, posts, triggers, and cached metadata stop.

## Scope

### V1

- Workspace identity and channel picker.
- Search/read messages and threads only within selected channels.
- Read mentions involving the connected user where scopes permit it.
- Draft and post a message or thread reply behind approval.
- Stable Slack links in June responses and notes.
- On-device polling while awake for mentions and selected-channel changes.

### Later

- Slack Connect edge cases, multiple workspaces, file upload, reactions,
  canvases, workflow steps, and an app users can message from inside Slack.
- Away-mode mention triggers after the relay threat model is accepted.

## Non-goals

- Full-workspace indexing or retention in June.
- Reading every channel the authorizing user can see by default.
- Posting as if June were the human without visible attribution.
- Autonomous posting at launch.
- Making Slack identity the source of June identity or team membership.

## Packaging

- Required connector: Slack.
- Skills: meeting recap, standup synthesis, decision follow-up, thread brief.
- Templates: morning mentions, daily team recap, post-meeting actions.
- Optional composition: Google/Microsoft calendar, GitHub, Linear, and local
  June notes.

## Privacy and trust

The OAuth token belongs in the Keychain and provider calls should originate
on-device. Slack's OAuth token exchange requires an app client secret, so the
technical spike must prove a distributable desktop pattern that does not embed
a reusable secret. If Slack requires a confidential backend for public app
installation, the plugin cannot claim the same local-mode credential boundary
as Google until a separately approved design exists.

Messages are untrusted input. Channel selection is an enforced provider-proxy
allowlist. Posts and replies are `approval` only in v1.

## Business model

Local Slack read and approved posting are available on Hobby. Triggered team
briefings and cross-plugin routines are Pro. Slack API calls are not separately
metered; model work uses existing agent billing.

## Success measures

| Metric | Target |
| --- | ---: |
| Connectors selecting at least one channel | 80% |
| Weekly connected users producing a recap or brief | 35% |
| Approved posts requiring an edit after publication | under 3% |
| Read attempts outside the selected channel set | 0 successful |
| Median connect-to-first-thread-summary time | under 3 minutes |

## Risks and gates

- OAuth client-secret custody and marketplace distribution must be resolved
  before product copy promises local mode.
- Slack scopes, workspace-admin approval, retention policy, and enterprise
  restrictions vary.
- Channel messages are a high-risk prompt-injection surface.
- Polling provides local privacy but not true away-mode responsiveness.

## Decision requested

Approve Slack as the first new provider after the shared connector kit, with a
channel allowlist, approved posting only, and an auth feasibility gate before
implementation hardens.

## Sources

- [Slack OAuth v2](https://api.slack.com/authentication/oauth-v2)
- [Slack Events API](https://api.slack.com/apis/connections/events-api)
