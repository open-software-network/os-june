# Adding a harness runner

A runner hands one full build to one orchestrating harness. To add one,
create `scripts/run-<harness>.sh` honoring this contract:

1. **Same CLI as the existing runners**:
   `run-<harness>.sh -t <task-file> [-C <repo-root>] [-b <base>]
   [--publish] [-o <out>] [--dry-run]`.
2. **Get the prompt from `fill-prompt.sh`** — never inline your own template;
   the filler owns validation and the publish-mode contract text.
3. **Support `--dry-run`** (print the filled prompt, exit 0).
4. **Preserve the two-level trust model.** Default: the strongest write
   confinement the harness offers, network permitted for dependency install,
   no push. `--publish`: escalate only as far as pushing and opening a draft
   PR requires, and say so in the script header. An orchestrator without a
   sandbox must be labeled policy-level.
5. **Uniform output**: default `-o` to
   `mktemp "${TMPDIR:-/tmp}/repo-orchestrate-<harness>.XXXXXX"`, print a
   `--- report (<path>) ---` marker line and then the report; exit non-zero
   on harness failure.

Skeleton:

```bash
#!/usr/bin/env bash
set -euo pipefail
# ... parse the shared flags (copy from run-codex.sh) ...
fill="$(cd "$(dirname "$0")" && pwd)/fill-prompt.sh"
prompt=$("$fill" -t "$task_file" -C "$repo_root" -b "$base" ${publish_flag:+$publish_flag})
[ "$dry_run" = 1 ] && { printf '%s\n' "$prompt"; exit 0; }
out=${out:-$(mktemp "${TMPDIR:-/tmp}/repo-orchestrate-<harness>.XXXXXX")}
printf -- '--- report (%s) ---\n' "$out"
printf '%s\n' "$prompt" | <harness-cli> <confinement flags> > "$out"
cat "$out"
```
