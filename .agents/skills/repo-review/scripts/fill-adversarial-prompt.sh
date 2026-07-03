#!/usr/bin/env bash
# Fill ADVERSARIAL-PROMPT.md for a diff against a fixed point; print to stdout.
# Shared by the per-harness runners (adversarial-codex.sh, adversarial-claude.sh).
# Usage: fill-adversarial-prompt.sh [-C <worktree>] [-f <focus>] [<fixed-point>]
#   <fixed-point>  ref to diff against (three-dot, merge-base); default: main
#   -C <worktree>  checkout to review; default: cwd
#   -f <focus>     user focus text passed to the reviewer; default: none
set -euo pipefail

usage() { sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }

worktree=$(pwd)
focus="none"
fixed_point=""
while [ $# -gt 0 ]; do
  case "$1" in
    -C) worktree=$2; shift 2 ;;
    -f) focus=$2; shift 2 ;;
    -h|--help) usage ;;
    -*) echo "unknown flag: $1" >&2; usage ;;
    *) fixed_point=$1; shift ;;
  esac
done
fixed_point=${fixed_point:-main}

cd "$worktree"
worktree=$(pwd -P)
git rev-parse --verify --quiet "${fixed_point}^{commit}" >/dev/null \
  || { echo "error: ref does not resolve: $fixed_point" >&2; exit 1; }
diff_cmd="git diff $fixed_point...HEAD"
[ -n "$(git diff "$fixed_point...HEAD" --stat)" ] \
  || { echo "error: empty diff: $diff_cmd" >&2; exit 1; }

# Template body = everything after the `---` separator in ADVERSARIAL-PROMPT.md.
template=$(awk 'body { print } /^---$/ { body = 1 }' \
  "$(dirname "$0")/../ADVERSARIAL-PROMPT.md")
prompt=${template//'{{TARGET_LABEL}}'/branch diff against $fixed_point}
prompt=${prompt//'{{DIFF_COMMAND}}'/$diff_cmd}
prompt=${prompt//'{{WORKTREE}}'/$worktree}
prompt=${prompt//'{{USER_FOCUS}}'/$focus}

printf '%s\n' "$prompt"
