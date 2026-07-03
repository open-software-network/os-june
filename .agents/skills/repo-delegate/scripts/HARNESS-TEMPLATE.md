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
5. **Uniform output**: default `-o` to `mktemp`, print the report to stdout,
   end with `--- report (<path>) ---`, exit non-zero on harness failure.

Skeleton:

```bash
#!/usr/bin/env bash
set -euo pipefail
# ... parse the shared flags (copy from run-codex.sh) ...
fill="$(cd "$(dirname "$0")" && pwd)/fill-prompt.sh"
prompt=$("$fill" -t "$task_file" -C "$worktree" \
  ${gate:+-g "$gate"} ${constraints:+-c "$constraints"})
[ "$dry_run" = 1 ] && { printf '%s\n' "$prompt"; exit 0; }
out=${out:-$(mktemp -t repo-delegate-<harness>)}
printf '%s\n' "$prompt" | <harness-cli> <worktree-write flags> > "$out"
printf '\n--- report (%s) ---\n' "$out"
cat "$out"
```
