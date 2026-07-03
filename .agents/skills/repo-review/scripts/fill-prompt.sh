#!/usr/bin/env bash
# Fill an axis prompt template for a diff against a fixed point; print to stdout.
# Usage: fill-prompt.sh -a <axis> [-C <worktree>] [-f <focus>] [-s <spec-path>] [<fixed-point>]
#   -a <axis>      axis template at axes/<axis>.md (adversarial | standards | spec | ...)
#   <fixed-point>  ref to diff against (three-dot, merge-base);
#                  default: origin/main if it resolves, else main
#   -C <worktree>  checkout to review; default: cwd
#   -f <focus>     user focus text passed to the reviewer; default: none
#   -s <spec-path> spec file for axes that use {{SPEC_PATH}}
set -euo pipefail

usage() { sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }

axis=""
worktree=$(pwd)
focus="none"
spec_path=""
fixed_point=""
while [ $# -gt 0 ]; do
  case "$1" in
    -a) axis=$2; shift 2 ;;
    -C) worktree=$2; shift 2 ;;
    -f) focus=$2; shift 2 ;;
    -s) spec_path=$2; shift 2 ;;
    -h|--help) usage ;;
    -*) echo "unknown flag: $1" >&2; usage ;;
    *) fixed_point=$1; shift ;;
  esac
done
[ -n "$axis" ] || { echo "error: -a <axis> is required" >&2; usage; }

template_file="$(cd "$(dirname "$0")" && pwd)/../axes/$axis.md"
[ -f "$template_file" ] \
  || { echo "error: unknown axis '$axis' (no $template_file)" >&2; exit 1; }

if [ -n "$spec_path" ]; then
  [ -f "$spec_path" ] || { echo "error: spec file not found: $spec_path" >&2; exit 1; }
  spec_path="$(cd "$(dirname "$spec_path")" && pwd)/$(basename "$spec_path")"
fi

cd "$worktree"
worktree=$(pwd -P)
if [ -z "$fixed_point" ]; then
  # Local main goes stale in worktrees; prefer the remote ref.
  if git rev-parse --verify --quiet origin/main >/dev/null; then
    fixed_point=origin/main
  else
    fixed_point=main
  fi
fi
case "$fixed_point" in
  origin/*)
    # Remote-tracking refs go stale too; refresh before pinning the baseline.
    git fetch --quiet origin "${fixed_point#origin/}" 2>/dev/null \
      || echo "warning: fetch failed; $fixed_point may be stale" >&2 ;;
esac
git rev-parse --verify --quiet "${fixed_point}^{commit}" >/dev/null \
  || { echo "error: ref does not resolve: $fixed_point" >&2; exit 1; }
diff_cmd="git diff $fixed_point...HEAD"
[ -n "$(git diff "$fixed_point...HEAD" --stat)" ] \
  || { echo "error: empty diff: $diff_cmd" >&2; exit 1; }
{
  echo "axis: $axis"
  echo "fixed point: $fixed_point (merge-base $(git merge-base "$fixed_point" HEAD))"
  git diff "$fixed_point...HEAD" --stat | tail -1
} >&2

# Template body = everything after the `---` separator in the axis file.
template=$(awk 'body { print } /^---$/ { body = 1 }' "$template_file")
# Replacements quoted: bash >= 5.2 patsub_replacement expands unquoted `&`.
prompt=${template//'{{TARGET_LABEL}}'/"branch diff against $fixed_point"}
prompt=${prompt//'{{DIFF_COMMAND}}'/"$diff_cmd"}
prompt=${prompt//'{{WORKTREE}}'/"$worktree"}
prompt=${prompt//'{{USER_FOCUS}}'/"$focus"}
[ -n "$spec_path" ] && prompt=${prompt//'{{SPEC_PATH}}'/"$spec_path"}

if leftover=$(printf '%s' "$prompt" | grep -o '{{[A-Z_]*}}' | sort -u); [ -n "$leftover" ]; then
  echo "error: unfilled placeholders (missing a flag for this axis?):" >&2
  echo "$leftover" >&2
  exit 1
fi

printf '%s\n' "$prompt"
