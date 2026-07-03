#!/usr/bin/env bash
# Fill PROMPT.md with a build prompt; print the orchestrator prompt to stdout.
# Usage: fill-prompt.sh -t <task-file> [-C <repo-root>] [-b <base>] [--publish]
#   -t <task-file>  file containing the build prompt (required)
#   -C <repo-root>  main checkout root; default: git toplevel of cwd
#   -b <base>       base ref; default: origin/main
#   --publish       allow push + draft PR (default: stop before publish)
set -euo pipefail

usage() { sed -n '2,7p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }

task_file=""
repo_root=""
base="origin/main"
publish=0
while [ $# -gt 0 ]; do
  case "$1" in
    -t) task_file=$2; shift 2 ;;
    -C) repo_root=$2; shift 2 ;;
    -b) base=$2; shift 2 ;;
    --publish) publish=1; shift ;;
    -h|--help) usage ;;
    *) echo "unknown argument: $1" >&2; usage ;;
  esac
done
[ -n "$task_file" ] || { echo "error: -t <task-file> is required" >&2; usage; }
[ -f "$task_file" ] || { echo "error: task file not found: $task_file" >&2; exit 1; }
task=$(cat "$task_file")
[ -n "$task" ] || { echo "error: task file is empty: $task_file" >&2; exit 1; }

repo_root=${repo_root:-$(git rev-parse --show-toplevel)}
repo_root=$(cd "$repo_root" && pwd -P)
git -C "$repo_root" rev-parse --git-dir >/dev/null \
  || { echo "error: not a git checkout: $repo_root" >&2; exit 1; }

if [ "$publish" = 1 ]; then
  publish_instructions="You MAY publish per repo-build-pr's Publish section: push your branch and open a DRAFT PR against ${base#origin/} with the repo's PR template sections filled (validation evidence, assumptions, out of scope). Never mark it ready, never merge."
else
  publish_instructions="Do NOT push, and do NOT open a PR. Stop after the pre-publish battery converges: leave atomic commits on your worktree branch and report the branch, worktree path, and evidence. The caller publishes."
fi

# Replacements quoted: bash >= 5.2 patsub_replacement expands unquoted `&`.
template=$(awk 'body { print } /^---$/ { body = 1 }' \
  "$(cd "$(dirname "$0")" && pwd)/../PROMPT.md")
prompt=${template//'{{TASK}}'/"$task"}
prompt=${prompt//'{{REPO_ROOT}}'/"$repo_root"}
prompt=${prompt//'{{BASE}}'/"$base"}
prompt=${prompt//'{{PUBLISH_INSTRUCTIONS}}'/"$publish_instructions"}

if printf '%s' "$prompt" | grep -q '{{\(TASK\|REPO_ROOT\|BASE\|PUBLISH_INSTRUCTIONS\)}}'; then
  echo "error: unfilled placeholders remain" >&2
  exit 1
fi

printf '%s\n' "$prompt"
