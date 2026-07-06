#!/usr/bin/env bash
# Orchestrate a full build through Claude Code (headless `claude -p`).
# Usage: run-claude.sh -t <task-file> [-C <repo-root>] [-b <base>] [--publish] [-o <out>] [--dry-run]
#   Flags as in fill-prompt.sh, plus:
#   -o <out>    file for the orchestrator's report; default: mktemp (path printed)
#   --dry-run   print the filled prompt instead of running Claude
#
# Trust levels: enforcement is policy-level (acceptEdits + an allowlist wide
# enough to build: git, pnpm, cargo, make, rg, mkdir, cp). --publish adds
# `git push` and `gh pr`. There is no OS sandbox on this path — only
# orchestrate prompts you wrote yourself; prefer the Codex runner when you
# want write confinement.
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

repo_root=$(cd "$repo_root" && pwd -P)
# Skill-runner rules cover both relative invocation (PROMPT.md mandates it)
# and absolute paths as belt-and-braces — permission prefixes have no
# implicit leading wildcard.
allowed=(
  "Bash(git fetch:*)" "Bash(git worktree:*)" "Bash(git add:*)" "Bash(git commit:*)"
  "Bash(git status:*)" "Bash(git diff:*)" "Bash(git log:*)" "Bash(git show:*)"
  "Bash(git rev-parse:*)" "Bash(git merge-base:*)" "Bash(git branch:*)"
  "Bash(pnpm:*)" "Bash(cargo:*)" "Bash(make:*)" "Bash(rg:*)"
  "Bash(mkdir:*)" "Bash(cp:*)"
  "Bash(.agents/skills/repo-review/scripts/run-codex.sh:*)"
  "Bash(.agents/skills/repo-review/scripts/run-claude.sh:*)"
  "Bash(.agents/skills/repo-delegate/scripts/run-codex.sh:*)"
  "Bash(.agents/skills/repo-delegate/scripts/run-claude.sh:*)"
  "Bash($repo_root/.agents/skills/repo-review/scripts/run-codex.sh:*)"
  "Bash($repo_root/.agents/skills/repo-review/scripts/run-claude.sh:*)"
  "Bash($repo_root/.agents/skills/repo-delegate/scripts/run-codex.sh:*)"
  "Bash($repo_root/.agents/skills/repo-delegate/scripts/run-claude.sh:*)"
)
if [ "$publish" = 1 ]; then
  allowed+=("Bash(git push:*)" "Bash(gh pr:*)")
fi

out=${out:-$(mktemp "${TMPDIR:-/tmp}/repo-orchestrate-claude.XXXXXX")}
cd "$repo_root"
printf -- '--- report (%s) ---\n' "$out"
harness_rc=0
printf '%s\n' "$prompt" | claude -p \
  --permission-mode acceptEdits \
  --allowedTools "${allowed[@]}" \
  --add-dir "$repo_root/.worktrees" \
  | tee "$out" || harness_rc=$?
[ "$harness_rc" -eq 0 ] || { echo "error: harness exited $harness_rc" >&2; exit "$harness_rc"; }
