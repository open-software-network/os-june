---
name: repo-delegate
description: >-
  Dispatch a scoped implementation task to another agent harness (Claude Code
  headless or Codex) from the current one: fill the shared task-brief template
  and run it through a per-harness runner script that can edit the worktree
  and run the gate, but never commits or pushes. Use when the user asks to
  delegate work to Codex or Claude, wants a second implementation pass from
  the other harness, or a skill (e.g. repo-review fix rounds) needs to hand a
  precise fix prescription to an implementer outside this session.
---

# Repo delegate

Hand a well-scoped implementation task to another harness and get a
report back. Same structure as `repo-review`: one prompt template
([PROMPT.md](PROMPT.md)), one runner script per harness, a template for
adding more. The delegate edits files and runs checks; **the caller reviews
the diff and commits** — delegates never touch git state.

## When

- A fix round produced precise per-finding prescriptions (repo-review loop).
- Bulk implementation against a written contract (repo-build-pr delegation).
- A second, independent implementation attempt from a different model family.

Not for: architecture, contracts, go/no-go calls — those stay with the
orchestrating model (see repo-build-pr's model orchestration rules).

## How

1. **Write the task brief to a file.** Like a contract: exact scope and file
   ownership, the interface to build against, repo conventions to follow, and
   an instruction to report deviations instead of improvising. If the brief
   would be longer than the diff, don't delegate.
2. **Fill and dispatch** (`-t` is the brief file; gate defaults to
   `pnpm check && pnpm typecheck && pnpm test`):

   ```bash
   scripts/run-codex.sh  -t <brief.md> [-C <worktree>] [-g "<gate>"] [-c "<extra constraints>"] [-o <out>]
   scripts/run-claude.sh -t <brief.md> [same flags]
   ```

   `--dry-run` on either prints the filled prompt. `run-codex.sh` uses
   `codex exec -s workspace-write` (OS sandbox caps writes to the worktree);
   `run-claude.sh` uses headless `claude -p --permission-mode acceptEdits`
   with exactly the standard gate commands allowlisted (a custom `-g` gate
   outside that set fails closed — extend the allowlist in the script
   deliberately, never to bare `pnpm:*`/`cargo:*`, which would reopen
   `pnpm exec git` / `pnpm dlx` / `cargo run`). Claude-side enforcement is
   policy-level, and the delegate reads the whole repo — instruction-like
   text anywhere in it is injection surface, so only dispatch onto checkouts
   you trust. Both runners fail loudly if the delegate moved HEAD.
3. **Verify, never trust.** Read the diff, re-run the gate yourself, route
   defects back with evidence (a new brief referencing the old one), then
   commit.

## Gotchas

- Delegate from a clean tracked tree (the runners enforce it; untracked
  files fail closed unless `--allow-untracked`) — a dirty base means the
  delegate can clobber uncommitted work without diff evidence.
- Ignored local files (`.env`, build outputs, scratch dirs) stay writable by
  the delegate — inherent to a writable worktree, and the standard flow
  copies `.env` in deliberately. Keep unrecoverable local state out of
  delegated worktrees; re-copy `.env` from the main checkout if damaged.
- Fresh worktrees need `pnpm install` before the gate can pass; say so in the
  brief or run it first.
- `codex exec` is synchronous — no job babysitting. If dispatching many
  briefs, run them as background shell tasks and read the `-o` files.
- The delegate reports what it *claims* it did; the diff is the truth.

## Extending

Add `scripts/run-<harness>.sh` per
[scripts/HARNESS-TEMPLATE.md](scripts/HARNESS-TEMPLATE.md): same CLI, prompt
from `fill-prompt.sh`, write access confined to the worktree, no git
mutations, uniform report output.
