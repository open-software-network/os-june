---
name: repo-orchestrate
description: >-
  Hand the entire repo-build-pr workflow to a harness of your choice (Claude
  Code headless or Codex): the chosen harness acts as orchestrator and
  validator — it creates its own worktree, implements (sub-delegating via
  repo-delegate where useful), runs the gate, runs the repo-review battery
  with cross-harness adversarial dispatch, and either stops ready-to-publish
  (default) or pushes and opens the draft PR (--publish). Use when the user
  wants to pick which harness orchestrates a build end to end, delegate a
  whole task AFK, or run the same build prompt under a different orchestrator
  for comparison.
---

# Repo orchestrate

Full-workflow delegation. `repo-delegate` hands off one scoped brief;
this hands off the whole loop — the chosen harness *is* the orchestrator
and validator, following `repo-build-pr` end to end. Same structure as the
sibling skills: one prompt template ([PROMPT.md](PROMPT.md)), one runner per
harness, a template for adding more.

## Trust model — read before dispatching

The orchestrator commits on a branch it creates, runs your toolchain, and in
publish mode pushes with your credentials and opens a PR. Two levels:

- **Default (no `--publish`)**: build + validate + review, stop before any
  push. Codex runs in a `workspace-write` sandbox (network enabled for
  `pnpm install`); Claude runs `acceptEdits` with a git/pnpm/cargo allowlist.
  The caller inspects the worktree and publishes.
- **`--publish`**: the orchestrator may `git push` and `gh pr create --draft`
  (never mark ready, never merge). On Codex this requires
  `danger-full-access` (the workspace sandbox cannot reach your ssh agent);
  on Claude the allowlist gains `git push` and `gh pr`. Only use on tasks
  and prompts you wrote yourself.

Either way the orchestrator's report is a claim; the worktree diff, gate
output, and battery verdicts are the evidence.

## How

1. **Write the build prompt to a file** — exactly what you would type after
   `/repo-build-pr`: objective, constraints, acceptance criteria, scope
   boundaries. Headless orchestrators cannot ask clarifying questions, so
   answer the obvious ones in the prompt; anything left open is taken
   conservatively and recorded as an assumption in the report/PR body.
2. **Pick the orchestrator harness and dispatch** (from the repo root of the
   main checkout):

   ```bash
   scripts/run-codex.sh  -t <build-prompt.md> [-C <repo-root>] [-b <base>] [--publish] [-o <out>]
   scripts/run-claude.sh -t <build-prompt.md> [same flags]
   ```

   `--dry-run` prints the filled orchestrator prompt. Runs take long —
   dispatch in the background and read the `-o` report file.
3. **Verify**: read the report, then the worktree diff and battery verdicts
   yourself. Default mode: publish with your own hands. Publish mode: check
   the draft PR before requesting reviews.

## Gotchas

- Worktrees go under `<repo>/.claude/worktrees/<branch>` — inside the
  workspace so the Codex sandbox can write them (sibling `../` paths are
  outside the sandbox), matching this repo's existing convention.
- The orchestrator must copy `.env` + `june-api/.env` from the main checkout
  into its worktree (repo-build-pr worktree strategy) — gitignored, so the
  sandbox can read them; keep secrets you can't lose out of delegated repos.
- Cross-harness review still applies one level down: the orchestrator
  dispatches the adversarial axis to a harness other than itself via
  `repo-review/scripts/run-*.sh`.
- Fresh worktrees need `pnpm install`; the prompt says so, but budget for it
  in runtime expectations.

## Extending

Add `scripts/run-<harness>.sh` per
[scripts/HARNESS-TEMPLATE.md](scripts/HARNESS-TEMPLATE.md): same CLI, prompt
from `fill-prompt.sh`, the two-level trust model preserved (sandboxed
default, explicit escalation for publish), report to a file.
