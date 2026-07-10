---
name: os-platform
description: Query and update live Open Software os-platform production data through the platform API. Use when an agent needs current Issues/Bounties, Orgs, Projects, Submissions, Comments, Activity, Contributors, or API status, or needs to create, assign, move, or comment on tracked work.
---

# os-platform

Use this skill when the user asks about current Open Software / os-platform state or an agent needs to keep tracked work current: Issues, Bounties, Projects, Orgs, Submissions, Comments, Activity, Contributors, or whether API endpoints are real-backed. Prefer the bundled script over reading code, seed data, frontend fixtures, or docs when the question is about production data.

## Quick Start

Run commands from this skill directory:

```bash
python3 scripts/os_platform.py status
python3 scripts/os_platform.py issues list open-software --q "wallet" --limit 10
python3 scripts/os_platform.py issues list open-software --assignee me --status todo,in_progress
python3 scripts/os_platform.py issues search open-software "wallet bug" --status todo
python3 scripts/os_platform.py issues show open-software 123
python3 scripts/os_platform.py issues create open-software --title "Fix wallet sync" --body "Issue details" --type bug --priority urgent
python3 scripts/os_platform.py issues assign open-software 123
python3 scripts/os_platform.py issues status open-software 123 in_review
python3 scripts/os_platform.py issues take open-software 123 --yes
python3 scripts/os_platform.py files upload ./evidence.mp4 --purpose attachment
python3 scripts/os_platform.py issues attach open-software 123 --path ./evidence.mp4 --public
python3 scripts/os_platform.py comments add open-software 123 --body "Opened PR #456."
```

Configuration:

- The default API base URL is `https://app.opensoftware.co/api`.
- `OS_PLATFORM_API_BASE_URL` can override the default unless `--base-url` is passed.
- `OS_PLATFORM_API_KEY` is required unless `--api-key` is passed. The script sends it as `Authorization: Bearer ...`.
- `OS_PLATFORM_USER_AGENT` can override the default `os-platform-cli/2.0 (+https://opensoftware.co)` User-Agent.
- Optional project defaults can be stored in `os-platform.json` in the workspace root or a parent directory. Supported fields are `org` and `limit`; both are optional.
- Never ask the user to paste an API key into chat. Ask them to set the environment variable in their shell or agent runtime.
- The installer does not prompt for or write environment values. If the API key is missing, tell the user to set it first.

## Routing Rules

The script is deterministic. Read commands do not mutate platform state. Write commands create Issues, assign the authenticated user, update status, add comments, upload files, or attach uploaded files. `issues take` remains the confirmed shortcut that moves a `todo` Issue to `in_progress`; if the Issue has no assignee, it first assigns it to the authenticated API user. Do not rely on the script to decide user intent. Route the request before calling it, and verify writes with a read.

Use the user prompt first, then `os-platform.json`, then ask the user for missing required parameters. Do not guess an org, issue number, project, or contributor when the prompt and config do not provide one.

- Org state or details: use `org get <org>`.
- Project lists or details: use `projects list <org>` or `project get <org> <project>`.
- Issue lists, filters, or work queues: use `issues list <org>` with the narrowest filters.
- Issue searches by rough user phrasing: use `issues search <org> "<query>"` with narrow filters when useful.
- A specific Issue/Bounty by number: use `issues show <org> <number>`.
- Creating an Issue for new work: use `issues create <org> --title <title> --body <body>` with `--type` and `--priority` when known. Contract types are `feature`, `bug`, `improvement`, `design`, `docs`, `refactor`, and `other`; priorities are `none`, `low`, `med`, `high`, and `urgent`. The CLI passes both values through for platform validation.
- Assigning yourself on an Issue you already own: use `issues assign <org> <number>`; `--to me` is accepted but optional. The command refuses to replace another assignee unless `--force` is passed deliberately, then re-reads the Issue to catch a concurrent assignment race.
- Keeping an owned Issue current: use `issues status <org> <number> <status>` with `proposed`, `todo`, `in_progress`, `in_review`, `completed`, or `cancelled`. It refuses another user's Issue unless `--force` is deliberate; terminal `completed` and `cancelled` transitions require `--yes`.
- Taking a todo Issue: after the user confirms they want to work on it, use `issues take <org> <number>`; use `--yes` only when confirmation already happened in chat or another trusted workflow.
- Uploading a file: use `files upload <path>` for a private attachment, add `--public` only when public download access is intended, and use `--purpose attachment|avatar` when the default `attachment` is not appropriate.
- Attaching a file to an Issue: the platform only attaches PUBLIC files (error 2015 otherwise, verified live). Use `issues attach <org> <number> --file-id <fil_xxx>` with a public upload, or `--path <path> --public` to upload-then-attach; `--public` is required with `--path` and acknowledges that anyone with the URL can download the file. The command preserves all existing attachments.
- Adding an Issue comment: use `comments add <org> <number> --body <body>`.
- Reading Issue submissions, activity, or comments: use the scoped command with `<org>` and `<issue-number>`.
- Contributors: use `contributors list <org>` or `contributors show <org> <user-handle>`.

If the user asks for issues and omits org, read `os-platform.json`; if it has `org`, use it. If no org is available, ask the user which org to use before running the script.

When the user asks for their own tasks or issues assigned to them, pass `--assignee me` (the script resolves `me`/`@me` to the authenticated API user via `GET /v1/users/me`, so no handle lookup is needed). When the user asks for issues to work on generally, prioritize todo issues assigned to the user or with no assignee before other todo issues. If the user identity is unclear, prefer unassigned todo issues.

## Agent status lifecycle

Use the platform as the source of truth for tracked work whenever it is available.

- For a pre-existing Issue, read it before starting, assign yourself when you take ownership, and move it to `in_progress`.
- For an ad hoc request with no Issue, create one first, then assign yourself and move it to `in_progress`.
- Route taking ownership through `issues take`; its `todo` check and confirmation discipline are authoritative. Use separate `issues assign` and `issues status` commands only for Issues you already own.
- Keep the Issue current while work advances: use `in_review` when the PR opens, `completed` after it merges, and `cancelled` when the work is deliberately abandoned or will not be done.
- Reference the Issue id in the PR, for example `JUN-123` or a `Closes JUN-123` line. The Org's GitHub `pr-links` webhook integration creates the platform PR link automatically; there is no CLI PR-link write command. If the integration does not link it, add the PR URL with `comments add`.
- Add comments for durable progress or handoff context when useful. Do not replace or rewrite the Issue body to record progress.
- Read the Issue after each write to verify the platform applied it. A write response alone is not durable evidence.

## Specific Issue Triage

When the user asks about a specific issue, fetch the live issue first, then inspect the current local codebase before suggesting implementation work.

1. Use `issues show <org> <number>` to get the live issue title, body, labels, project, and status.
2. Search the local codebase for terms from the issue title/body, related route names, component names, API paths, labels, and project handles.
3. Compare the issue request with the current implementation, tests, and nearby patterns before recommending work.
4. Ground suggestions in both the issue data and code references; say when the codebase does not provide enough evidence.
5. If the issue is actionable, suggest a concise implementation path and likely test or verification commands. If it is not actionable, explain what information is missing.

## Available Script

`scripts/os_platform.py` is an API helper for platform reads and controlled Issue workflow writes. It uses only Python standard library modules; file uploads invoke `curl` for streaming multipart transfer.

Core commands:

```bash
python3 scripts/os_platform.py status
python3 scripts/os_platform.py org get <org>
python3 scripts/os_platform.py projects list <org>
python3 scripts/os_platform.py project get <org> <project>
python3 scripts/os_platform.py issues list <org>
python3 scripts/os_platform.py issues search <org> "<query>"
python3 scripts/os_platform.py issues show <org> <number>
python3 scripts/os_platform.py issues create <org> --title <title> --body <body>
python3 scripts/os_platform.py issues assign <org> <number>
python3 scripts/os_platform.py issues status <org> <number> <status>
python3 scripts/os_platform.py issues attach <org> <number> --file-id <fil_xxx>
python3 scripts/os_platform.py issues take <org> <number>
python3 scripts/os_platform.py files upload <path>
python3 scripts/os_platform.py submissions list <org> <issue-number>
python3 scripts/os_platform.py activity list <org> <issue-number>
python3 scripts/os_platform.py comments list issue <org> <issue-number>
python3 scripts/os_platform.py comments add <org> <issue-number> --body <body>
python3 scripts/os_platform.py contributors list <org>
python3 scripts/os_platform.py contributors show <org> <user-handle>
python3 scripts/os_platform.py raw GET /v1/...
```

Common flags:

- `--limit N` caps list output.
- `--json` prints the unwrapped `data` payload.
- `--full` prints the full unwrapped data without compact summarization. `issues show` always does this, so its `--full` flag is a backward-compatible no-op.
- `--base-url URL` overrides `OS_PLATFORM_API_BASE_URL` and the default base URL.

`issues take`:

- Fetches the Issue first.
- Refuses to update unless the current status is `todo`.
- Assigns the Issue to the authenticated API user first when the Issue has no assignee.
- Prompts before moving the Issue to `in_progress`, unless `--yes` is passed.

Other writes:

- `issues create` creates an Org-scoped Issue with a required title and body plus optional contract type and priority values. The metadata flags remain pass-through values and do not use client-side choices.
- `issues assign` fetches the Issue and resolves the authenticated user before assigning. `assignee_user_id` is the authoritative identity: a missing or empty value is unassigned, even if a sparse `assignee` display object exists. It is a no-op when already self-assigned, refuses another current assignee, and accepts `--force` for a deliberate replacement. After a PATCH, it re-reads and fails if another writer won the assignment race.
- `issues status` fetches the Issue and authenticated user first, prints its external id, title, and current status, and accepts `proposed`, `todo`, `in_progress`, `in_review`, `completed`, or `cancelled`. It refuses another user's Issue unless `--force` is passed. `completed` and `cancelled` require `--yes`; without it, the command prints what would change and exits without writing.
- `files upload` sends multipart `file`, `is_public`, and `purpose` fields to `POST /v1/files`; purpose is `attachment` or `avatar` and defaults to `attachment`.
- `issues attach` reads the Issue's existing `files[].id` values and sends the complete list plus the new id as `file_ids` through the Issue PATCH. `--path` uploads first with private attachment defaults.
- `comments add` adds a Markdown comment to an Issue.

`scripts/install.sh` installs this skill into a local agent skills directory. It defaults to `~/.codex/skills`, supports `--dest`, `--source`, `--repo`, `--ref`, `--path`, and `--force`, and never stores credentials.

## Workflow

1. Decide whether the question is about current production state. If yes, use this skill.
2. If the target route is unclear, read `references/api-map.md`.
3. Run the narrowest script command that answers the question.
4. Use default compact output for summaries. `issues show` always returns the full Issue; use `--json` or `--full` on other reads when exact fields matter.
5. Cite the live API result in your answer, and mention if a route appears fixture-backed or unreachable.

## Language Rules

- User-facing product language says **Issue**.
- Internal tables/code may say **Bounty**.
- The product is **Open Software** and the platform/repo is **os-platform**.
- If the API path says `bounties`, explain results to users as Issues unless discussing internal implementation.

## Safety

- Run write commands only when the user or a trusted workflow has established the intended platform mutation. Verify each write with a read before any fan-out.
- The script does not retry writes internally. The platform contract has no idempotency support, so re-running `issues create` or `comments add` after a timeout or other ambiguous failure can duplicate the write. Read before retrying.
- Issue body edits remain append-only: fetch the full current body first, append, and never overwrite existing content. The script does not expose body editing.
- Do not print or persist `OS_PLATFORM_API_KEY`.
- Do not infer private data from missing public data. A 404 on private/member-only resources can mean hidden, missing, or inaccessible.
- Treat production data as current at request time, not as a durable local fact.

## Reference

Read `references/api-map.md` for endpoint mappings, useful filters, and real-vs-fixture guidance.
