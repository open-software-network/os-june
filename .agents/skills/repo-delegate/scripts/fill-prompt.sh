#!/usr/bin/env bash
# Fill PROMPT.md with a task brief; print the delegate prompt to stdout.
# Usage: fill-prompt.sh -t <task-file> [-C <worktree>] [-g <gate>] [-c <constraints>]
#   -t <task-file>   file containing the task brief (required)
#   -C <worktree>    checkout the delegate works in; default: cwd
#   -g <gate>        validation commands; default: pnpm check && pnpm typecheck && pnpm test
#   -c <constraints> extra caller constraints; default: none
set -euo pipefail

usage() { sed -n '2,7p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }

task_file=""
worktree=$(pwd)
gate="pnpm check && pnpm typecheck && pnpm test"
constraints="none"
while [ $# -gt 0 ]; do
  case "$1" in
    -t) task_file=$2; shift 2 ;;
    -C) worktree=$2; shift 2 ;;
    -g) gate=$2; shift 2 ;;
    -c) constraints=$2; shift 2 ;;
    -h|--help) usage ;;
    *) echo "unknown argument: $1" >&2; usage ;;
  esac
done
[ -n "$task_file" ] || { echo "error: -t <task-file> is required" >&2; usage; }
[ -f "$task_file" ] || { echo "error: task file not found: $task_file" >&2; exit 1; }
task=$(cat "$task_file")
[ -n "$task" ] || { echo "error: task file is empty: $task_file" >&2; exit 1; }

worktree=$(cd "$worktree" && pwd -P)

# Template body = everything after the `---` separator in PROMPT.md.
template=$(awk 'body { print } /^---$/ { body = 1 }' \
  "$(cd "$(dirname "$0")" && pwd)/../PROMPT.md")
# Replacements quoted: bash >= 5.2 patsub_replacement expands unquoted `&`,
# and the default gate (and most briefs) contain `&&`.
prompt=${template//'{{TASK}}'/"$task"}
prompt=${prompt//'{{WORKTREE}}'/"$worktree"}
prompt=${prompt//'{{GATE}}'/"$gate"}
prompt=${prompt//'{{CONSTRAINTS}}'/"$constraints"}

if printf '%s' "$prompt" | grep -q '{{\(TASK\|WORKTREE\|GATE\|CONSTRAINTS\)}}'; then
  echo "error: unfilled placeholders remain" >&2
  exit 1
fi

printf '%s\n' "$prompt"
