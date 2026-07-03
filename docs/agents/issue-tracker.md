# Issue tracker: os-platform

Issues for this repo live on the Open Software platform (os-platform), org
`june` — NOT GitHub Issues. GitHub Issues exist on the repo but are a
legacy/watchdog surface, not the triage queue.

All reads go through the vendored `os-platform` skill
(`.agents/skills/os-platform/`). Run its script from that directory; it needs
`OS_PLATFORM_API_KEY` in the environment (never paste keys into chat).
Defaults (org `june`, limit 20) come from `os-platform.json` at the repo root.

## Read conventions

- **List issues**: `python3 scripts/os_platform.py issues list june --status todo`
  (filters: `--status todo,in_progress,in_review,completed,cancelled`,
  `--labels`, `--assignee`, `--priority`, `--project`, `--q`)
- **Search**: `python3 scripts/os_platform.py issues search june "<query>"`
- **Read an issue**: `python3 scripts/os_platform.py issues show june <number>`
  (comments: `comments list issue june <number>`)
- **Take an issue** (todo → in_progress, assigns you): `issues take june <number>`
  — confirm with the user before passing `--yes`.

## Write conventions (direct API)

Writes beyond `issues take` go straight to the platform API
(`https://app.opensoftware.co/api`, `Authorization: Bearer $OS_PLATFORM_API_KEY`),
following the precedent set by `os-task-prep/scripts/enrich_issue.py`.

Documented endpoints (safe to use):

- **Update an issue** (body, assignee):
  `PATCH /v1/orgs/june/bounties/{number}` with e.g.
  `{"body_markdown": "..."}` or `{"assignee_user_id": "usr_xxx"}`.
  Body edits are **append-only** — fetch the current body first, append, never
  overwrite. Prefer `enrich_issue.py` for diagnosis notes.
- **Change status**: `POST /v1/orgs/june/bounties/{number}/status` with
  `{"status": "todo|in_progress|in_review|completed|cancelled"}`.

Undocumented mutations (issue create, comment create, label set): probe on a
single Issue first, verify the result with a GET, then proceed. If the
endpoint 404s/405s or the write doesn't stick, fall back to drafting the
content for the user to apply in the platform UI. Confirm any fan-out
mutation on one Issue before applying it to many — this is a shared
production tracker.

## Language

User-facing product language says **Issue** (internal API paths say
`bounties`). The platform is **Open Software**; statuses are
`todo | in_progress | in_review | completed | cancelled`.

## When a skill says "publish to the issue tracker"

Create the Issue via the API (probe-then-verify, above); fall back to
drafting it for the user if creation isn't supported.

## When a skill says "fetch the relevant ticket"

`python3 scripts/os_platform.py issues show june <number>` from the skill dir.

## Pull requests as a triage surface

No. PRs live on GitHub (`gh` CLI) and are not a request surface for triage.
