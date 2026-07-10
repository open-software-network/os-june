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
- **Take an issue** (todo → in_progress, assigns you):
  `python3 scripts/os_platform.py issues take june <number>`
  — confirm with the user before passing `--yes`.

## Write conventions

The `os-platform` script owns routine workflow writes. Run it from
`.agents/skills/os-platform/` and verify each write with a read before any
fan-out:

- **Create an issue**:
  `python3 scripts/os_platform.py issues create june --title "..." --body "..."`
  (optional: `--type feature|bug|other`, `--priority low|med|high`).
- **Assign yourself**:
  `python3 scripts/os_platform.py issues assign june <number>`.
- **Change status**:
  `python3 scripts/os_platform.py issues status june <number> <status>` where
  status is `todo|in_progress|in_review|completed|cancelled`.
- **Add a comment**:
  `python3 scripts/os_platform.py comments add june <number> --body "..."`.

`issues take` remains the confirmed shortcut that assigns an unassigned todo
Issue to the authenticated user and moves it to `in_progress`.

Issue body edits are still **append-only** and are not exposed by
`os_platform.py`: fetch the full current body first, append, and never
overwrite. The direct endpoint remains
`PATCH /v1/orgs/june/bounties/{number}` with the combined body as
`{"body_markdown": "..."}`. Prefer `os-task-prep/scripts/enrich_issue.py` for
diagnosis notes. Other mutations not owned by the script, such as body or
label updates, keep the direct API probe-then-verify discipline. Confirm any
fan-out mutation on one Issue before applying it to many — this is a shared
production tracker.

## Language

User-facing product language says **Issue** (internal API paths say
`bounties`). The platform is **Open Software**; statuses are
`todo | in_progress | in_review | completed | cancelled`.

## When a skill says "publish to the issue tracker"

Create the Issue with `python3 scripts/os_platform.py issues create ...`, then
verify it with `issues show`.

## When a skill says "fetch the relevant ticket"

`python3 scripts/os_platform.py issues show june <number>` from the skill dir.

## Pull requests as a triage surface

No. PRs live on GitHub (`gh` CLI) and are not a request surface for triage.
