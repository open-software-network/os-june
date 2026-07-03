# Triage Labels

The skills speak in terms of five canonical triage roles. os-platform Issues
have both **statuses** and **labels**; this repo maps roles across both axes.

| Role in mattpocock/skills | In our tracker | Meaning |
| --- | --- | --- |
| `needs-triage` | label `needs-triage` | Maintainer needs to evaluate |
| `needs-info` | label `needs-info` | Waiting on reporter |
| `ready-for-agent` | status `todo` + description enriched by `os-task-prep` (diagnosis, files, acceptance, verify) | Fully specified, AFK-ready |
| `ready-for-human` | label `ready-for-human` (status `todo`) | Requires human implementation |
| `wontfix` | status `cancelled` | Will not be actioned |

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), use
this table. Status changes go through the documented status endpoint (or
`issues take` for todo → in_progress); label writes are undocumented — follow
the probe-then-verify rule in `issue-tracker.md`.
