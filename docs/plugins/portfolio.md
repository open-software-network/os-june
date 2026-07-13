# June plugin portfolio: top 10

- **Owner:** CEO + CTO
- **Date:** 2026-07-13
- **Status:** Proposed portfolio for JUN-309
- **Related:** JUN-275, JUN-278, JUN-283, JUN-284, JUN-285

## Executive decision

June should launch a deliberately small, first-party plugin portfolio that
turns meeting context into completed work. The first ten plugins should be:

| Rank | Plugin | Score | Portfolio role | Current state |
| ---: | --- | ---: | --- | --- |
| 1 | Google Workspace | 94 | Default personal work graph | Gmail + Calendar shipped; expansion proposed |
| 2 | Browser use | 91 | Universal fallback for web work | Accepted in JUN-278; implementation active |
| 3 | Slack | 86 | Team context and follow-through | Proposed in the connector roadmap |
| 4 | Microsoft 365 | 84 | Enterprise work graph | New proposal |
| 5 | Computer use | 81 | Universal fallback for Mac work | Accepted phase 2 in JUN-278 |
| 6 | Notion | 77 | Durable team knowledge | Tracked by JUN-283 |
| 7 | GitHub | 73 | Software delivery context and action | Tracked by JUN-285 |
| 8 | Linear | 69 | Product execution context and action | Tracked by JUN-284 |
| 9 | Documents | 67 | Local-first finished written artifacts | New proposal |
| 10 | Spreadsheets | 64 | Local-first structured analysis | New proposal |

This ordering is a portfolio priority, not an instruction to stop work already
in flight. Google remains the release baseline. Browser use can ship before
Computer use because the latter still has a driver and macOS sandbox spike.
Provider review, store review, or OAuth verification can move one workstream
around another without changing the strategic ranking.

## What changed in the benchmark

The current ChatGPT feature is not the legacy 2023 plugin manifest model. As
of 2026-07-09, OpenAI describes a plugin as a workflow package that can contain
skills, apps, and app templates. The underlying app supplies external data,
actions, interactive UI, search, sync, or deep research; installation policy
and app permission policy remain separate. The directory is available across
ChatGPT web, desktop, Work, and Codex.

That model maps cleanly to June if June keeps its own canonical terms:

- A **plugin** is the user-facing capability bundle in the Plugins area.
- A **Skill** provides reusable workflow guidance.
- A **Toolset** groups runtime tools.
- An **MCP server** exposes tools to the embedded runtime.
- A **connector** is specifically the private-by-architecture path to a
  third-party account. A connector may be one component of a plugin, but the
  words are not interchangeable.

June should adopt the useful product layering without adopting cloud indexing
as the default. A plugin can be installed while its optional connector is not
connected. Connecting an account grants only provider scopes. A plugin's
trust mode decides how June governs outward actions. None of those controls
override permissions in the source system.

## Surface inventory

The benchmark exposes six capability families:

| Family | Current benchmark behavior | June interpretation |
| --- | --- | --- |
| Workflow packaging | Skills, apps, and app templates can ship together | First-party plugin bundles with a manifest, bundled skills, toolsets, and optional connectors |
| Discovery | Directory, search, categories, featured listings, installed state | The JUN-275 Plugins area plus contextual suggestions in chat |
| Invocation | Explicit selection, `@` mention, or model discovery | Plugin chips, slash/mention entry points, and a visible suggestion card |
| Data access | Live search and optional pre-indexed sync | Live, metadata-first local connector reads; no provider corpus copied to OpenSoftware |
| Action control | Read, routine write, important write, and admin policy | Existing `read_only -> approval -> autonomous` trust modes and broker-enforced approvals |
| Administration | Role availability, app setup, action controls, domains, disconnect | Personal v1 connection controls; team policy only after June has an organization model |

Interactive third-party widgets and cloud-wide pre-indexing are not launch
requirements for June. June's local desktop surface, note graph, routines, and
approval cards already cover the higher-value parts of the job.

### Candidate census reviewed

The directory is dynamic and varies by plan, workspace, role, region, and
supported surface. This census covers every candidate family named by the
current official directory, plugin use-case guide, app help, and workspace
release notes available during the 2026-07-13 review. It is not a claim that
every account sees every listing.

| Candidate family | Named current examples reviewed | Portfolio disposition |
| --- | --- | --- |
| Google work graph | Gmail, Calendar, Drive, Docs, Sheets, Slides, Meet, Contacts, BigQuery | Google Workspace selected; BigQuery and Slides deferred |
| Microsoft work graph | Outlook Email, Outlook Calendar, OneDrive, SharePoint, Teams | Microsoft 365 selected as one capability-granular plugin |
| Team communication and knowledge | Slack, Notion, Asana, Intercom | Slack and Notion selected; Asana and Intercom deferred |
| Software delivery | GitHub, GitHub Enterprise template, Linear, Replit, Lovable | GitHub and Linear selected; hosted builders deferred |
| File stores | Dropbox, Box | Deferred behind ecosystem file access and local artifacts |
| CRM, structured data, and warehouses | HubSpot, Airtable, Databricks template, Snowflake template | Deferred for narrower ICP and admin/away-mode complexity |
| Creative work | Adobe, Canva, Figma | Deferred until the local artifact foundation proves itself |
| Consumer and lifestyle | AllTrails, Apple Music, Booking.com, Expedia, Instacart, Spotify, Target, Tripadvisor, Zillow | Outside June's private work focus |
| Agent execution | Browser interaction and computer interaction | Browser use and Computer use selected |
| Local work products | Documents, spreadsheets, PDFs, presentations, visualizations, sites | Documents and Spreadsheets selected; adjacent formats follow the shared artifact broker |

The census also reviewed the cross-cutting surfaces around each listing:
directory discovery, search and categories, explicit and model-suggested
invocation, interactive UI, live search, deep research, pre-indexed sync, write
actions, per-action confirmation, role access, domain restriction, connection,
disconnect, developer-mode custom apps, public review, and app templates. June's
shared product contract below records which of those surfaces it should adopt.

## Ranking method

Each candidate was scored out of 100. The rubric intentionally rewards June's
core loop and private architecture over directory visibility.

| Criterion | Weight | Question |
| --- | ---: | --- |
| Core-loop fit | 25 | Does it improve capture -> understand -> act? |
| ICP frequency | 20 | How often does June's confidential prosumer encounter the job? |
| Action leverage | 15 | Can June complete work, not only retrieve context? |
| Retention and composition | 15 | Does it create recurring use and combine with notes, routines, and other plugins? |
| Privacy differentiation | 15 | Does local execution make June meaningfully more trustworthy or useful? |
| Delivery confidence | 10 | Can the team ship a narrow, reliable v1 with known APIs and review paths? |

Scores reflect evidence available on 2026-07-13, not permanent market facts.
They should be revisited after 30-day activation, weekly use, approval, and
task-completion data exist.

## Sequencing

### Wave 0: finish the foundation

1. Preserve the shipped Google Gmail + Calendar path and Plugins foundation.
2. Ship Browser use v1 and finish the Computer use driver spike.
3. Extract a provider-neutral connector kit from the Google implementation:
   token custody, account index, provider proxy, read/action server split,
   trust enforcement, approval journal, and health diagnostics.

### Wave 1: cover the two work ecosystems

4. Add Slack local mode.
5. Expand Google Workspace with Drive and Meet artifacts.
6. Build Microsoft 365 on the provider-neutral connector kit.

### Wave 2: make context operational

7. Add Notion.
8. Add GitHub.
9. Add Linear.

### Wave 3: create finished local artifacts

10. Ship Documents, then Spreadsheets, on one artifact broker and shared
    render-and-verify pipeline.
11. Re-run the portfolio score before starting the next candidate.

The waves permit parallel engineering where provider registration, external
review, and local implementation have independent critical paths. They do not
permit shipping multiple one-off OAuth stacks.

## Shared product contract

Every launch plugin must satisfy the same contract:

1. The listing states what the plugin can read, what it can change, what leaves
   the device for inference, and whether OpenSoftware is in the connector data
   path.
2. Install, connect, grant, trust mode, and runtime mode are separate states.
3. The Plugins tile, Settings control, and contextual in-chat suggestion point
   to one source of truth.
4. Read tools return compact structured summaries first. Full bodies or files
   are fetched only when the task requires them.
5. Mutating tools are separate from read tools and enforced in Rust, not by
   prompting the model.
6. Disconnect revokes provider access where supported, removes Keychain
   material, disables the runtime surface, ends active leases, and verifies the
   disconnected state.
7. Provider content is untrusted input. Tool descriptions and the June soul
   carry injection warnings, while the broker remains the enforcement point.
8. Routines receive explicit toolsets and an explicit account binding. No
   routine silently selects the first account.
9. Every action has a stable idempotency key or a local action journal before
   retries are allowed.
10. No plugin introduces an upstream provider key into the desktop binary or
    routes provider content through June API unless a separately approved
    away-mode design requires it.

## Business model

The private connection itself should remain available on Hobby. Privacy is not
the upsell. Pro value comes from high-frequency automation: event-triggered
routines, multi-step cross-plugin workflows, unattended execution where the
provider permits it, and higher run limits. Computer use can remain Pro while
its cost and support burden are measured. Local Documents and Spreadsheets
should be broadly available, with model calls charged through existing agent
usage.

## Portfolio success metrics

| Metric | 90-day target | Why it matters |
| --- | ---: | --- |
| Weekly active users with at least one enabled plugin | 50% | Plugins become a core product surface |
| Enabled-plugin users completing one plugin-backed task per week | 40% | Measures work completed, not connections |
| Median time from tile open to first successful read | under 3 minutes | Setup is not the product |
| Approved actions completed without correction | at least 95% | Trust must precede autonomy |
| Connector-derived security or token incidents | 0 | Non-negotiable |
| 30-day retention lift for plugin users | at least 15 points | Validates portfolio value |

Provider-specific PRDs add activation and outcome measures without replacing
these shared metrics.

## Explicit deferrals

- **Dropbox, Box, OneDrive-only, and SharePoint-only plugins:** valuable file
  access, but Google Workspace, Microsoft 365, Notion, and local Documents cover
  the dominant jobs first. Provider-specific file stores remain candidates.
- **HubSpot and other CRMs:** strong meeting follow-through but narrower than
  the first ten and likely to need an away-mode webhook path for the best
  proactive experience.
- **Figma, Canva, and presentation creation:** compelling output, but June
  should prove the shared artifact broker with Documents and Spreadsheets
  before adding remote design surfaces or a presentation renderer.
- **Airtable and databases:** overlap with Spreadsheets, Notion, and Linear.
- **Travel, shopping, real estate, education, music, and lifestyle:** visible
  in the public app directory but outside June's private work focus.
- **A third-party plugin marketplace:** the security, signing, update, and
  policy model is a separate product. The first ten are first-party bundles.
- **Cloud sync of entire provider corpora:** conflicts with the local-mode
  trust story. Live, scoped reads come first; away mode requires its own
  accepted threat model.

## Source snapshot

The source snapshot is intentionally dated because the ecosystem changed four
days before this document was written.

- [Plugins in ChatGPT and Codex](https://help.openai.com/en/articles/20001256-plugins-in-chatgpt-and-codex) - package model, directory, installation policy, app permissions, and surfaces.
- [Apps in ChatGPT](https://help.openai.com/en/articles/11487775-connectors-in-chatgpt) - interactive UI, search, deep research, sync, write actions, and admin controls.
- [Plugin use cases and prompts](https://help.openai.com/en/articles/12084614-app-use-cases-and-prompts) - current work categories and supported app examples.
- [ChatGPT release notes](https://help.openai.com/en/articles/6825453-chatgpt-release-notes) - current Google, Microsoft, Box, Dropbox, Notion, and Linear action expansion.
- [ChatGPT Business release notes](https://help.openai.com/en/articles/11391654) - current Slack, Asana, Intercom, Google, Microsoft, and workspace plugin changes.
- [ChatGPT public app directory](https://chatgpt.com/apps/) - public featured, productivity, and lifestyle inventory.
- [Apps SDK tool design](https://developers.openai.com/apps-sdk/plan/tools) - focused tools, predictable structured output, read/write separation, and discovery metadata.
- [Apps SDK guidelines](https://developers.openai.com/apps-sdk/app-guidelines) - action annotations, data minimization, reliability, and review expectations.

## Companion documents

Each ranked plugin has a CEO-mode PRD and CTO-mode implementation plan in this
directory. These documents are proposals unless their status says an existing
June decision is already accepted. An implementation plan does not by itself
authorize a provider registration, a new permission, an external deploy, or a
change to an accepted ADR.
