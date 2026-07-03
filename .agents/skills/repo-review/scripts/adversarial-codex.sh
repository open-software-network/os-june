#!/usr/bin/env bash
# Run the adversarial review through Codex (codex exec, read-only sandbox).
# Usage: adversarial-codex.sh [-C <worktree>] [-f <focus>] [-o <out.md>] [--dry-run] [<fixed-point>]
#   <fixed-point>  ref to diff against (three-dot, merge-base); default: main
#   -C <worktree>  checkout to review; default: cwd
#   -f <focus>     user focus text passed to the reviewer; default: none
#   -o <out.md>    file for the final verdict; default: mktemp
#   --dry-run      print the filled prompt instead of running Codex
set -euo pipefail

usage() { sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }

worktree=$(pwd)
focus="none"
out=""
dry_run=0
fixed_point=""
while [ $# -gt 0 ]; do
  case "$1" in
    -C) worktree=$2; shift 2 ;;
    -f) focus=$2; shift 2 ;;
    -o) out=$2; shift 2 ;;
    --dry-run) dry_run=1; shift ;;
    -h|--help) usage ;;
    -*) echo "unknown flag: $1" >&2; usage ;;
    *) fixed_point=$1; shift ;;
  esac
done

prompt=$("$(dirname "$0")/fill-adversarial-prompt.sh" -C "$worktree" -f "$focus" ${fixed_point:+"$fixed_point"})

if [ "$dry_run" = 1 ]; then
  printf '%s\n' "$prompt"
  exit 0
fi

out=${out:-$(mktemp -t adversarial-review).md}
printf '%s\n' "$prompt" | codex exec -s read-only -C "$worktree" -o "$out" -
printf '\n--- verdict (%s) ---\n' "$out"
cat "$out"
