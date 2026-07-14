#!/usr/bin/env bash
# Delegate a task to Codex (codex exec, workspace-write sandbox).
# Usage: run-codex.sh -t <task-file> [-C <worktree>] [-g <gate>] [-c <constraints>] [-o <out>]
#                     [-m <model>] [-e <effort>] [-S <tier>] [--dry-run]
#   Flags as in fill-prompt.sh, plus:
#   -o <out>    file for the delegate's report; default: mktemp (path is printed)
#   -m <model>  Codex model: gpt-5.6-sol|gpt-5.6-terra|gpt-5.6-luna (default: config, gpt-5.6-sol)
#   -e <effort> reasoning effort: none|minimal|low|medium|high|xhigh (default: config)
#   -S <speed>  speed: fast|standard (default: standard — fast bills ~2.5x credits
#               and 5.6 runs long; reserve fast for interactive sessions)
#   --allow-untracked  proceed despite untracked files in the worktree
#   --dry-run   print the filled prompt instead of running Codex
#   The session id is printed after the run for `codex exec resume <id>`.
#
# The OS sandbox confines writes to the worktree; git mutations are forbidden
# by the prompt contract, not the sandbox — review the diff before committing.
set -euo pipefail

usage() { sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }

task_file=""
worktree=$(pwd)
gate=""
constraints=""
out=""
model=""
effort=""
speed=""
dry_run=0
allow_untracked=0
while [ $# -gt 0 ]; do
  case "$1" in
    -t|-C|-g|-c|-o|-m|-e|-S)
      [ $# -ge 2 ] || { echo "error: $1 requires a value" >&2; exit 2; }
      case "$1" in
        -t) task_file=$2 ;;
        -C) worktree=$2 ;;
        -g) gate=$2 ;;
        -c) constraints=$2 ;;
        -o) out=$2 ;;
        -m) model=$2 ;;
        -e) effort=$2 ;;
        -S) speed=$2 ;;
      esac
      shift 2 ;;
    --allow-untracked) allow_untracked=1; shift ;;
    --dry-run) dry_run=1; shift ;;
    -h|--help) usage ;;
    *) echo "unknown argument: $1" >&2; usage ;;
  esac
done

# Fail fast on bad values: the API 400s on a bad effort only after the session
# has started, and a bad service_tier is silently dropped with just a warning.
case "$effort" in ""|none|minimal|low|medium|high|xhigh) ;;
  *) echo "error: -e must be none|minimal|low|medium|high|xhigh (got: $effort)" >&2; exit 2 ;;
esac
# "fast"/"standard" are Codex's UI names; the config values are priority/default.
# Default standard: fast bills ~2.5x credits and delegations are background work
# (the user's config.toml default is priority, so this must be explicit).
tier=""
case "${speed:-standard}" in
  fast|priority) tier="priority" ;;
  standard|default) tier="default" ;;
  *) echo "error: -S must be fast|standard (got: $speed)" >&2; exit 2 ;;
esac
case "$model" in ""|gpt-5.6-sol|gpt-5.6-terra|gpt-5.6-luna) ;;
  *) echo "error: -m must be gpt-5.6-sol|gpt-5.6-terra|gpt-5.6-luna (got: $model)" >&2; exit 2 ;;
esac

fill="$(cd "$(dirname "$0")" && pwd)/fill-prompt.sh"
prompt=$("$fill" -t "$task_file" -C "$worktree" \
  ${gate:+-g "$gate"} ${constraints:+-c "$constraints"})

if [ "$dry_run" = 1 ]; then
  printf '%s\n' "$prompt"
  exit 0
fi

out=${out:-$(mktemp "${TMPDIR:-/tmp}/repo-delegate-codex.XXXXXX")}

# HEAD + every ref (branches, tags, stash) + staged paths. Working-tree edits
# are the delegate's job; everything else in git is off limits.
git_state() { git -C "$1" rev-parse HEAD; git -C "$1" for-each-ref; git -C "$1" diff --cached --name-status; }

# Clean tracked tree required (staged or unstaged): pre-existing uncommitted
# work could be silently clobbered by the delegate, and restaged content is
# invisible to a name-status guard. Clean base = the post-run diff is a
# complete record of what the delegate did.
[ -z "$(git -C "$worktree" status --porcelain --untracked-files=no)" ] \
  || { echo "error: uncommitted tracked changes in $worktree — commit or stash before delegating" >&2; exit 1; }
untracked=$(git -C "$worktree" ls-files -o --exclude-standard)
if [ -n "$untracked" ] && [ "$allow_untracked" != 1 ]; then
  echo "error: untracked files present — the delegate could overwrite them with no diff evidence (commit them or pass --allow-untracked):" >&2
  printf '%s\n' "$untracked" | head -10 >&2
  exit 1
fi

# tier is always set (defaults to standard), so the array is never empty —
# important under set -u with macOS bash 3.2, where "${empty[@]}" errors.
codex_args=(-c "service_tier=$tier")
if [ -n "$model" ]; then codex_args+=(-m "$model"); fi
if [ -n "$effort" ]; then codex_args+=(-c "model_reasoning_effort=$effort"); fi

state_before=$(git_state "$worktree")
harness_rc=0
run_log=$(mktemp "${TMPDIR:-/tmp}/repo-delegate-codex-log.XXXXXX")
trap 'rm -f "$run_log"' EXIT
printf '%s\n' "$prompt" | codex exec -s workspace-write -C "$worktree" -o "$out" \
  "${codex_args[@]}" - 2>&1 | tee "$run_log" \
  || harness_rc=$?
state_after=$(git_state "$worktree")
if [ "$state_before" != "$state_after" ]; then
  echo "error: delegate mutated git state (HEAD/refs/index) — the no-commit contract was violated; inspect before trusting the worktree" >&2
  exit 1
fi
[ "$harness_rc" -eq 0 ] || { echo "error: harness exited $harness_rc" >&2; exit "$harness_rc"; }
session_id=$(grep -m1 '^session id:' "$run_log" | awk '{print $3}') || true
if [ -n "${session_id:-}" ]; then
  printf '\n--- session %s (follow up: codex exec resume %s) ---\n' "$session_id" "$session_id"
else
  echo "warning: no session id found in codex output (format change?) — resume via codex exec resume --last" >&2
fi
printf '\n--- report (%s) ---\n' "$out"
cat "$out"
