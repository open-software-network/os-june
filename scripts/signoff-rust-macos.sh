#!/usr/bin/env bash
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "signoff/rust-macos must be created from macOS, matching the skipped PR runner." >&2
  exit 1
fi

if ! command -v gh >/dev/null 2>&1; then
  echo "GitHub CLI is required. Install it from https://cli.github.com/." >&2
  exit 1
fi

if ! gh auth status -h github.com >/dev/null 2>&1; then
  echo "GitHub CLI is not authenticated. Run: gh auth login" >&2
  exit 1
fi

if ! gh extension list | awk '{print $1}' | grep -qx 'basecamp/gh-signoff'; then
  echo "gh-signoff is required. Run: gh extension install basecamp/gh-signoff" >&2
  exit 1
fi

if ! git rev-parse --abbrev-ref '@{push}' >/dev/null 2>&1; then
  echo "The current branch is not tracking a remote branch. Push it first:" >&2
  echo "  git push -u origin HEAD" >&2
  exit 1
fi

if [[ -n "$(git status --porcelain)" ]]; then
  echo "Commit or stash local changes before signing off. The signoff is tied to HEAD." >&2
  exit 1
fi

if [[ -n "$(git log '@{push}'..)" ]]; then
  echo "Push the current HEAD before signing off. The signoff status is posted to the pushed commit." >&2
  echo "  git push" >&2
  exit 1
fi

make tauri-fmt-check
make tauri-lint
make tauri-test

gh signoff rust-macos
