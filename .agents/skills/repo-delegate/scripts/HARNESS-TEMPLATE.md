# Adding a harness runner

A runner dispatches a delegate task to one agent harness. To add one, create
`scripts/run-<harness>.sh` honoring this contract:

1. **Same CLI as the existing runners**:
   `run-<harness>.sh -t <task-file> [-C <worktree>] [-g <gate>]
   [-c <constraints>] [-o <out>] [--dry-run]`.
2. **Get the prompt from `fill-prompt.sh`** — never inline your own template;
   the filler owns brief validation and placeholder substitution.
3. **Support `--dry-run`** (print the filled prompt, exit 0).
4. **Confine writes to the worktree as strictly as the harness allows.**
   Prefer an OS-level sandbox (Codex: `-s workspace-write`); fall back to the
   harness's edit-approval mode plus a gate-command allowlist (Claude:
   `--permission-mode acceptEdits`). Document the enforcement level honestly
   in the script header. Git mutations stay forbidden by the prompt contract
   either way — the caller commits.
5. **Verify git is untouched**: snapshot `git rev-parse HEAD` before dispatch
   and fail loudly if it moved after — the no-commit contract is prompt text,
   the check is what enforces it.
6. **Uniform output**: default `-o` to
   `mktemp "${TMPDIR:-/tmp}/repo-delegate-<harness>.XXXXXX"` (trailing X's —
   GNU mktemp requires them), print a `--- report (<path>) ---` marker line
   and then the report. Exit non-zero on harness failure or a moved HEAD.

Skeleton:

```bash
#!/usr/bin/env bash
set -euo pipefail
# ... parse the shared flags (copy from run-codex.sh) ...
fill="$(cd "$(dirname "$0")" && pwd)/fill-prompt.sh"
prompt=$("$fill" -t "$task_file" -C "$worktree" \
  ${gate:+-g "$gate"} ${constraints:+-c "$constraints"})
[ "$dry_run" = 1 ] && { printf '%s\n' "$prompt"; exit 0; }
out=${out:-$(mktemp "${TMPDIR:-/tmp}/repo-delegate-<harness>.XXXXXX")}
head_before=$(git -C "$worktree" rev-parse HEAD)
printf '%s\n' "$prompt" | <harness-cli> <worktree-write flags> > "$out"
head_after=$(git -C "$worktree" rev-parse HEAD)
[ "$head_before" = "$head_after" ] \
  || { echo "error: delegate moved HEAD" >&2; exit 1; }
printf '\n--- report (%s) ---\n' "$out"
cat "$out"
```
