#!/usr/bin/env bash
# Run a review axis through Codex (codex exec, OS-level read-only sandbox).
# Usage: run-codex.sh -a <axis> [-C <worktree>] [-f <focus>] [-s <spec-path>] [-o <out>] [--dry-run] [<fixed-point>]
#   Flags as in fill-prompt.sh, plus:
#   -o <out>       file for the final verdict; default: mktemp (path is printed)
#   --dry-run      print the filled prompt instead of running Codex
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

out=${out:-$(mktemp "${TMPDIR:-/tmp}/repo-review-$axis.XXXXXX")}
printf '%s\n' "$prompt" | codex exec -s read-only -C "$worktree" -o "$out" -
printf '\n--- verdict (%s) ---\n' "$out"
cat "$out"
