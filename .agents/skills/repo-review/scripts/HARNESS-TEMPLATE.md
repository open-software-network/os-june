# Adding a harness runner

A runner dispatches any review axis to one agent harness. To add one, create
`scripts/run-<harness>.sh` honoring this contract:

1. **Same CLI as the existing runners**:
   `run-<harness>.sh -a <axis> [-C <worktree>] [-f <focus>] [-s <spec-path>]
   [-o <out>] [--dry-run] [<fixed-point>]`.
2. **Get the prompt from `fill-prompt.sh`** — never inline your own template
   or re-implement validation; the filler owns ref checks, the empty-diff
   guard, and placeholder substitution.
3. **Support `--dry-run`** (print the filled prompt, exit 0).
4. **Run the harness as read-only as it allows.** Prefer an OS-level sandbox
   (Codex: `-s read-only`); fall back to the harness's strictest policy mode
   (Claude: `--permission-mode plan` + disallowed edit tools). Document the
   enforcement level honestly in the script header — an allowlist is not a
   sandbox.
5. **Uniform output**: default `-o` to
   `mktemp "${TMPDIR:-/tmp}/repo-review-$axis.XXXXXX"` (trailing X's — GNU
   mktemp requires them), print a `--- verdict (<path>) ---` marker line and
   then the report, so the report is always what follows the last marker.
   Exit non-zero on harness failure.

Skeleton:

```bash
#!/usr/bin/env bash
set -euo pipefail
# ... parse the shared flags (copy from run-codex.sh) ...
fill="$(cd "$(dirname "$0")" && pwd)/fill-prompt.sh"
prompt=$("$fill" -a "$axis" -C "$worktree" -f "$focus" \
  ${spec_path:+-s "$spec_path"} ${fixed_point:+"$fixed_point"})
[ "$dry_run" = 1 ] && { printf '%s\n' "$prompt"; exit 0; }
out=${out:-$(mktemp "${TMPDIR:-/tmp}/repo-review-$axis.XXXXXX")}
printf '%s\n' "$prompt" | <harness-cli> <read-only flags> > "$out"
printf '\n--- verdict (%s) ---\n' "$out"
cat "$out"
```

Register nothing: SKILL.md's dispatch section lists runners by filename, so
add one line there and you're done.
