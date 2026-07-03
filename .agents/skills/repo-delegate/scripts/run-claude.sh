#!/usr/bin/env bash
# Delegate a task to Claude Code (headless `claude -p`, acceptEdits).
# Usage: run-claude.sh -t <task-file> [-C <worktree>] [-g <gate>] [-c <constraints>] [-o <out>] [--dry-run]
#   Flags as in fill-prompt.sh, plus:
#   -o <out>    file for the delegate's report; default: mktemp (path is printed)
#   --dry-run   print the filled prompt instead of running Claude
#
# Enforcement is policy-level, not an OS sandbox: acceptEdits auto-approves
# file edits (anywhere the session may write, not just the worktree), and the
# gate commands are allowlisted. Only dispatch briefs you wrote yourself; use
# the Codex runner when you want OS-level write confinement.
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

out=${out:-$(mktemp "${TMPDIR:-/tmp}/repo-delegate-claude.XXXXXX")}
cd "$worktree"

# HEAD + every ref (branches, tags, stash) + staged paths. Working-tree edits
# are the delegate's job; everything else in git is off limits.
git_state() { git rev-parse HEAD; git for-each-ref; git diff --cached --name-status; }

state_before=$(git_state)
printf -- '--- report (%s) ---\n' "$out"
# Allowlist is the exact gate surface, not bare pnpm/cargo — `pnpm exec`,
# `pnpm dlx`, and `cargo run` would bypass the no-git/no-arbitrary-code
# contract. A custom -g gate outside this set will prompt-fail closed.
harness_rc=0
printf '%s\n' "$prompt" | claude -p \
  --permission-mode acceptEdits \
  --allowedTools "Bash(pnpm check:*)" "Bash(pnpm typecheck:*)" "Bash(pnpm test:*)" \
    "Bash(pnpm install:*)" "Bash(pnpm build:*)" \
    "Bash(cargo test:*)" "Bash(cargo fmt:*)" "Bash(cargo clippy:*)" "Bash(cargo check:*)" \
    "Bash(git status:*)" "Bash(git diff:*)" "Bash(git log:*)" "Bash(git show:*)" \
  | tee "$out" || harness_rc=$?
state_after=$(git_state)
if [ "$state_before" != "$state_after" ]; then
  echo "error: delegate mutated git state (HEAD/refs/index) — the no-commit contract was violated; inspect before trusting the worktree" >&2
  exit 1
fi
[ "$harness_rc" -eq 0 ] || { echo "error: harness exited $harness_rc" >&2; exit "$harness_rc"; }
