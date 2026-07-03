#!/usr/bin/env bash
# Run a review axis through Claude Code (headless `claude -p`).
# Usage: run-claude.sh -a <axis> [-C <worktree>] [-f <focus>] [-s <spec-path>] [-o <out>] [--dry-run] [<fixed-point>]
#   Flags as in fill-prompt.sh, plus:
#   -o <out>       file for the final verdict; default: mktemp (path is printed)
#   --dry-run      print the filled prompt instead of running Claude
#
# Enforcement is policy-level, not an OS sandbox: plan mode blocks side-effect
# tools, edit tools are disallowed outright, and only git history commands are
# allowlisted. Caveats: the caller's own settings.json grants still apply, and
# an allowlist authorizes the subcommand, not its arguments (e.g. `git diff
# --output=<path>` can write). Fine for this repo's own branches; do not point
# it at untrusted third-party diffs — use the Codex runner's OS sandbox there.
set -euo pipefail

usage() { sed -n '2,7p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }

axis=""
worktree=$(pwd)
focus="none"
spec_path=""
out=""
dry_run=0
fixed_point=""
while [ $# -gt 0 ]; do
  case "$1" in
    -a) axis=$2; shift 2 ;;
    -C) worktree=$2; shift 2 ;;
    -f) focus=$2; shift 2 ;;
    -s) spec_path=$2; shift 2 ;;
    -o) out=$2; shift 2 ;;
    --dry-run) dry_run=1; shift ;;
    -h|--help) usage ;;
    -*) echo "unknown flag: $1" >&2; usage ;;
    *) fixed_point=$1; shift ;;
  esac
done

fill="$(cd "$(dirname "$0")" && pwd)/fill-prompt.sh"
prompt=$("$fill" -a "$axis" -C "$worktree" -f "$focus" \
  ${spec_path:+-s "$spec_path"} ${fixed_point:+"$fixed_point"})

if [ "$dry_run" = 1 ]; then
  printf '%s\n' "$prompt"
  exit 0
fi

add_dir_args=()
if [ -n "$spec_path" ]; then
  add_dir_args=(--add-dir "$(cd "$(dirname "$spec_path")" && pwd)")
fi

out=${out:-$(mktemp "${TMPDIR:-/tmp}/repo-review-$axis.XXXXXX")}
cd "$worktree"

# Detection guard: policy-level enforcement cannot prevent an allowlisted
# write (e.g. `git diff --output`), but a worktree that changed during a
# read-only review invalidates the review — fail loudly instead of silently.
review_state() { git rev-parse HEAD; git status --porcelain; }

state_before=$(review_state)
printf -- '--- verdict (%s) ---\n' "$out"
harness_rc=0
printf '%s\n' "$prompt" | claude -p \
  --permission-mode plan \
  --allowedTools "Bash(git diff:*)" "Bash(git log:*)" "Bash(git show:*)" "Bash(git status:*)" \
  --disallowedTools "Edit" "Write" "NotebookEdit" \
  ${add_dir_args[@]+"${add_dir_args[@]}"} \
  | tee "$out" || harness_rc=$?
state_after=$(review_state)
if [ "$state_before" != "$state_after" ]; then
  echo "error: worktree changed during a read-only review — the report at $out is invalid" >&2
  exit 1
fi
[ "$harness_rc" -eq 0 ] || { echo "error: harness exited $harness_rc" >&2; exit "$harness_rc"; }
