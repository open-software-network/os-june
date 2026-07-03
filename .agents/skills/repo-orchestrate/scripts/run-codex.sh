#!/usr/bin/env bash
# Orchestrate a full build through Codex.
# Usage: run-codex.sh -t <task-file> [-C <repo-root>] [-b <base>] [--publish] [-o <out>] [--dry-run]
#   Flags as in fill-prompt.sh, plus:
#   -o <out>    file for the orchestrator's report; default: mktemp (path printed)
#   --dry-run   print the filled prompt instead of running Codex
#
# Trust levels: default runs `codex exec -s workspace-write` with network
# enabled (pnpm install needs it) — writes confined to the repo tree.
# --publish switches to `-s danger-full-access` because pushing needs your
# ssh agent and gh auth; only use on prompts you wrote yourself.
set -euo pipefail

usage() { sed -n '2,7p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }

task_file=""
repo_root=""
base="origin/main"
publish=0
out=""
dry_run=0
while [ $# -gt 0 ]; do
  case "$1" in
    -t) task_file=$2; shift 2 ;;
    -C) repo_root=$2; shift 2 ;;
    -b) base=$2; shift 2 ;;
    --publish) publish=1; shift ;;
    -o) out=$2; shift 2 ;;
    --dry-run) dry_run=1; shift ;;
    -h|--help) usage ;;
    *) echo "unknown argument: $1" >&2; usage ;;
  esac
done

repo_root=${repo_root:-$(git rev-parse --show-toplevel)}
fill="$(cd "$(dirname "$0")" && pwd)/fill-prompt.sh"
publish_flag=""
[ "$publish" = 1 ] && publish_flag="--publish"
prompt=$("$fill" -t "$task_file" -C "$repo_root" -b "$base" ${publish_flag:+$publish_flag})

if [ "$dry_run" = 1 ]; then
  printf '%s\n' "$prompt"
  exit 0
fi

sandbox_args=(-s workspace-write -c 'sandbox_workspace_write.network_access=true')
[ "$publish" = 1 ] && sandbox_args=(-s danger-full-access)

out=${out:-$(mktemp "${TMPDIR:-/tmp}/repo-orchestrate-codex.XXXXXX")}
printf -- '--- report (%s) ---\n' "$out"
printf '%s\n' "$prompt" | codex exec "${sandbox_args[@]}" -C "$repo_root" -o "$out" -
cat "$out"
