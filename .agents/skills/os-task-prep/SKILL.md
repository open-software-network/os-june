---
name: os-task-prep
description: >-
  Use when the user wants to turn open Open Software Issues into AFK-ready,
  agent-implementable tasks: find ready-to-code Issues for an org/project,
  diagnose each against the local codebase (root cause, files, code fragments,
  dependencies, blockers, acceptance, verify), enrich the Issue description on
  the platform, optionally assign them to the current user, and emit a table of
  one-line `repo-build-pr` prompts to dispatch to autonomous agents. Triggers on "prep tasks", "get
  issues ready to implement", "enrich issues with diagnosis", "prepare build
  prompts", "ready-to-code tasks for agents".
---

# os-task-prep

Productizes the loop: **find open Issues -> diagnose against the code -> map
cross-Issue dependencies and blockers -> enrich the Issue on the platform ->
(optionally) assign -> emit `repo-build-pr` prompts** so autonomous ("AFK")
agents can pick them up with full context.

It composes two existing skills and adds the one capability they lack:

- **`os-platform`** (read-only + `issues take`): list/show Issues, and assign.
- **`repo-build-pr`**: the per-Issue implementation loop the emitted prompts
  target. Invoke it directly (`/repo-build-pr`); the old `/build` alias is
  deprecated -- do not emit it.
- **`scripts/enrich_issue.py`** (this skill): the only mutation `os-platform`
  does not provide -- `PATCH /v1/orgs/{org}/bounties/{number}` to append
  diagnosis notes to `body_markdown`, idempotently and append-only.

## Prerequisites

- `OS_PLATFORM_API_KEY` must be set in the environment (see the `os-platform`
  skill). Never ask the user to paste it into chat; never echo it.
- Run from a checkout of `open-software-network/os-june` so the diagnosis step
  can read the real code.
- The default org/project come from `os-platform.json` (`org`, `limit`).

## Workflow

### 1. Find ready-to-code Issues

Use the `os-platform` skill. Default to the narrowest actionable queue:

```bash
python3 .claude/skills/os-platform/scripts/os_platform.py issues list <org> --status todo --limit 30
```

Pick candidates that are genuinely **ready to code**, not just `status: todo`:

- Prefer `creator.kind: "integration"` / well-specified reports with clear
  expected behavior over raw `creator.kind: "user"` reports that need triage.
- Prefer tight, self-contained scope. Flag overlap: Issues that touch the same
  large file (e.g. `AgentWorkspace.tsx`) will conflict if run in parallel
  worktrees -- note which to serialize.
- Skip design-only / question / vague Issues unless asked.
- Honor assignment hints: surface unassigned or already-yours first.

State how many you selected and why; `log` anything you dropped.

### 2. Diagnose each against the codebase (parallel, read-only)

Spawn one `Explore` subagent per Issue. Give each the Issue title + body and ask
for **Files (file:line), Root cause / site, Implementation sketch, Acceptance
criteria, Verify**. Demand real `file_path:line` references and an explicit
"evidence thin" note when unsure. These agents must not edit anything.

This diagnosis is what makes the Issue AFK-ready: a fresh agent that has never
seen the repo gets the root cause and the exact edit site for free.

### 3. Map dependencies and blockers (cross-Issue pass)

After diagnosing, look across the selected Issues -- not just within each one.
This is the difference between "five tickets" and "a plan": an agent that knows
it shares a file with another in-flight Issue can rebase deliberately instead of
producing a doomed parallel diff.

- **Shared-file conflicts.** Build a file-overlap matrix from the diagnoses.
  Issues that edit the same file (e.g. several touching `AgentWorkspace.tsx`)
  collide if run as parallel worktrees. Mark them to **serialize** and pick an
  order (smallest / most-foundational change first).
- **Logical dependencies.** Does one fix need another to land first -- a shared
  helper, a refactor that must precede the rest? Record `depends-on: JUN-XXX`.
- **External blockers.** Anything that stops an agent finishing autonomously: a
  needed design decision, a product question, an API/backend change, a missing
  fixture. Record `blocked-by: <what>` so it is not dispatched blind.

Carry these findings into both the enrichment (step 4) and the dispatch order
(step 6). When nothing applies, say so explicitly ("independent, parallel-safe").

### 4. Enrich the Issue description on the platform

For each Issue, distill the diagnosis into a markdown block beginning with the
marker line, then append it with the bundled script:

```bash
# notes.md starts with: ## Implementation notes (investigated by agent for @<handle>)
python3 .claude/skills/os-task-prep/scripts/enrich_issue.py \
  --org <org> --number <n> --notes-file notes.md
```

Rules baked into the script (do not work around them):

- **Append-only** under a `---` rule; the reporter's original text is preserved.
- **Idempotent**: re-runs skip if the marker is present. Use `--replace` to
  regenerate the section after a better diagnosis.
- Sets `User-Agent: os-platform-agent-skill/1.0` -- the default urllib UA is
  Cloudflare-blocked (HTTP 403, "error code: 1010").
- Verifies the marker is present after PATCH and reports the new length.

Include a **Dependencies / blockers** line carrying the step 3 findings, e.g.
`**Dependencies / blockers:** serialize with JUN-114/116/117 (shared
AgentWorkspace.tsx); depends-on: none; blocked-by: none.` Write
"none -- independent" when the Issue is genuinely standalone.

Keep notes tight and end with a drift caveat, e.g.
`_Investigated against os-june @ <sha>. Line refs may drift; confirm before editing._`

Use plain hyphens, not en/em dashes, per repo copy conventions.

### 5. Optionally assign to the current user

Only when the user asks ("assign me"). Use the `os-platform` skill -- it is the
blessed mutation path and also moves `todo -> in_progress`, which prevents a
teammate double-claiming an Issue an agent is about to work:

```bash
python3 .claude/skills/os-platform/scripts/os_platform.py issues take <org> <n> --yes
```

`--yes` only when the user has already confirmed in chat. `issues take` refuses
non-`todo` Issues, so enrich first (enriching does not change status). Tell the
user assignment also flips status to `in_progress` and is reversible.

### 6. Emit the dispatch table

Output a table the user can copy, one row per Issue, carrying (a) the dispatch
**order / deps** from step 3 and (b) a one-line prompt that invokes the build
skill, references `os-platform` for Issue context, and states the root cause.
**Match the skill-trigger prefix to the runtime the agents run in:**

- Claude Code triggers skills with `/`:  `/repo-build-pr /os-platform JUN-113 ...`
- Codex CLI triggers skills with `$`:    `$repo-build-pr $os-platform JUN-113 ...`

The user dispatches AFK agents via Codex, so the `$` form is usually operative;
the Claude `/` form is the same line with the prefix swapped. Lead with the
parallel-safe rows; group serialized rows and number their order.

```
| Issue | Order / deps                                | Codex ($)                                                                 |
| ---   | ---                                         | ---                                                                       |
| JUN-114 | parallel-safe (CSS only)                  | $repo-build-pr $os-platform JUN-114 trim action-control padding to tokens |
| JUN-113 | serialize 1/3 -- shares AgentWorkspace.tsx | $repo-build-pr $os-platform JUN-113 onBranch ignores part.sessionId ...   |
```

Format: `<prefix>repo-build-pr <prefix>os-platform <ISSUE-ID> <one-line root cause / fix direction>`,
where `<prefix>` is `/` for Claude Code and `$` for Codex. The one-liner is the
single most useful sentence from the diagnosis -- the same sentence a reviewer
would want at the top of the PR. (`/build` is the deprecated alias for
`repo-build-pr`; never emit it.)

## Safety

- Enrichment mutates a shared production tracker. Append, never overwrite;
  confirm the PATCH path on one Issue before fanning out if unsure.
- Assignment is optional and user-gated.
- Do not print or persist `OS_PLATFORM_API_KEY`.
- The `enrich_issue.py` PATCH is intentionally the only write here beyond
  `os-platform`'s `issues take`. Do not add more mutations without being asked.
