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
   would be longer than the diff, don't delegate. For a defect fix, make the
   gate fail first: encode the bug as a failing regression check (test or
   fixture assertion) before dispatch and say so in the brief — the
   delegate's "gate passed" is then proof the defect died, not a claim.

   **State invariants, not failure-path branches.** A brief that dictates what
   to do when something goes wrong ships the orchestrator's unexamined premise
   straight into the code, and the delegate will implement it faithfully. Say
   "never type into an unintended app"; do not say "on timeout post the
   keystroke anyway so text is not lost". Before writing any "or else X is
   lost" rationale, verify X can actually be lost. In PR #676 it could not —
   the transcript was already on the clipboard and in history — so the brief's
   own safety clause recreated the exact bug the PR existed to fix, and only a
   cross-harness adversarial run caught it.

   **Mutation-check any fixture the delegate authored.** A test written by the
   same agent that wrote the fix can pass for reasons unrelated to the fix.
   Revert the fix, confirm the test goes red, restore. PR #676: a delegate's
   "notice does not fire" test asserted the absence of a label in a state where
   an unrelated guard already prevented it — green with the fix removed. PR #677
   is the harder version: a delegate rewrote an existing test so its own
   regression would pass.
2. **Fill and dispatch** (`-t` is the brief file; gate defaults to
   `pnpm check && pnpm typecheck && pnpm test`):

   ```bash
   scripts/run-codex.sh  -t <brief.md> [-C <worktree>] [-g "<gate>"] [-c "<extra constraints>"] [-o <out>] \
                         [-m <model>] [-e <effort>] [-S <tier>]
   scripts/run-claude.sh -t <brief.md> [same flags, minus -S; -m takes
                         sonnet|opus|haiku (default opus), -e takes
                         low|medium|high|xhigh|max (default medium — the
                         brief carries the hard thinking; bump for subtle
                         defect fixes)]
   ```

   **Codex model/effort/speed** (defaults come from `~/.codex/config.toml`;
   only pass a flag when the user asked for something specific):

   Allowed models (for now): `gpt-5.6-sol` (config default; main work),
   `gpt-5.6-terra` (quick review/feedback passes), `gpt-5.6-luna` (cheap fast
   bulk; not a primary pick) — the script rejects anything else.

   | User says | Flag |
   |---|---|
   | "sol" / "terra" / "luna" | `-m gpt-5.6-sol` / `-m gpt-5.6-terra` / `-m gpt-5.6-luna` |
   | "think hard" | `-e high` |
   | "max effort" | `-e xhigh` (rarely needed — high covers almost everything) |
   | "quick pass" / "low effort" | `-e low` (or `minimal`/`none`) |
   | "fast" | `-S fast` (bills ~2.5x credits — see below) |
   | "standard speed" | `-S standard` (the script's default) |

   Effort is `none|minimal|low|medium|high|xhigh` (validated client-side; the
   API only rejects a bad value after the session has started). Calibration:
   medium is the workhorse, high for genuinely hard briefs, xhigh almost
   never — 5.6 at medium/high already runs long and completes tasks
   end-to-end.

   Speed maps to Codex's `service_tier` config: fast = `priority`, standard =
   `default` — the only two tiers the gpt-5.6 models advertise; anything else
   is silently dropped by Codex, so the script fails closed on other values.
   **The script defaults to standard**, overriding the user config's
   `priority`: fast bills ~2.5x credits, and 5.6's long autonomous runs make
   the burn unpredictable. Delegations are background work; only pass
   `-S fast` when the user explicitly asks.

   After the run the script prints the Codex **session id**; follow up in the
   same session with `codex exec resume <id> "<prompt>"`. Sessions cannot be
   named at dispatch (`/rename` is TUI-only as of codex 0.144) — the id is
   the handle. Resume only for short follow-ups: gpt-5.6 input past ~272k
   tokens bills 2x, so a fresh scoped brief beats resuming a long session.

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
- Fresh worktrees need `pnpm install --frozen-lockfile` before the gate can
  pass; say so in the brief or run it first.
- `codex exec` is synchronous — no job babysitting. If dispatching many
  briefs, run them as background shell tasks and read the `-o` files.
- The delegate reports what it *claims* it did; the diff is the truth.

## Extending

Add `scripts/run-<harness>.sh` per
[scripts/HARNESS-TEMPLATE.md](scripts/HARNESS-TEMPLATE.md): same CLI, prompt
from `fill-prompt.sh`, write access confined to the worktree, no git
mutations, uniform report output.
