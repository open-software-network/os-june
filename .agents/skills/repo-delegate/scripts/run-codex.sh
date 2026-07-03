#!/usr/bin/env bash
# Delegate a task to Codex (codex exec, workspace-write sandbox).
# Usage: run-codex.sh -t <task-file> [-C <worktree>] [-g <gate>] [-c <constraints>] [-o <out>] [--dry-run]
#   Flags as in fill-prompt.sh, plus:
#   -o <out>    file for the delegate's report; default: mktemp (path is printed)
#   --dry-run   print the filled prompt instead of running Codex
#
# The OS sandbox confines writes to the worktree; git mutations are forbidden
# by the prompt contract, not the sandbox — review the diff before committing.
set -euo pipefail

usage() { sed -n '2,7p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }

task_file=""
worktree=$(pwd)
gate=""
constraints=""
out=""
dry_run=0
while [ $# -gt 0 ]; do
  case "$1" in
    -t) task_file=$2; shift 2 ;;
    -C) worktree=$2; shift 2 ;;
    -g) gate=$2; shift 2 ;;
    -c) constraints=$2; shift 2 ;;
    -o) out=$2; shift 2 ;;
    --dry-run) dry_run=1; shift ;;
    -h|--help) usage ;;
    *) echo "unknown argument: $1" >&2; usage ;;
  esac
done

fill="$(cd "$(dirname "$0")" && pwd)/fill-prompt.sh"
prompt=$("$fill" -t "$task_file" -C "$worktree" \
  ${gate:+-g "$gate"} ${constraints:+-c "$constraints"})

if [ "$dry_run" = 1 ]; then
  printf '%s\n' "$prompt"
  exit 0
fi

out=${out:-$(mktemp -t repo-delegate-codex)}
printf '%s\n' "$prompt" | codex exec -s workspace-write -C "$worktree" -o "$out" -
printf '\n--- report (%s) ---\n' "$out"
cat "$out"
