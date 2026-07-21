# Agent E2E QA run: GitHub agent reads

Environment:

- Date: 2026-07-21
- Worktree/branch: `/Users/sarascahya/.codex/worktrees/25ef/os-june`, `codex/github-connector-phase-0`
- Commit at QA start: `2575e6c7`
- Command: `OS_JUNE_LOCAL_DEV=1 OS_JUNE_LOCAL_DEV_BEARER_TOKEN=local-dev-token OS_JUNE_LOCAL_DEV_USER_ID=usr_local_dev JUNE__SERVER__HOST=127.0.0.1 JUNE__LOCAL_DEV__ENABLED=true JUNE__LOCAL_DEV__BEARER_TOKEN=local-dev-token JUNE__LOCAL_DEV__USER_ID=usr_local_dev GITHUB_APP_CLIENT_ID=Iv23lihKGi1yIb8QZm9L GITHUB_APP_SLUG=june-staging node scripts/tauri-dev.mjs`
- Surface: native Tauri worktree app
- Data mode: local June API configuration with the documented public GitHub App configuration

Checks:

- PASS - Managed installer alias regression coverage - production-command fixtures cover the expected, missing, duplicate, and mismatched uv CPython aliases. Missing and duplicate aliases exit unsuccessfully before `python/current` is created; the duplicate fixture retains both aliases and the selected versioned CPython directory.
- PASS - Full repository gate - `make verify` ran with the supplied pinned pnpm shim. Frontend tests reported 194 files passed, 3,086 tests passed, and 2 skipped; June API tests reported 145 passed with no failures.
- BLOCKED - Native connector walkthrough - the worktree app, isolated local June API, and Vite server launched successfully. The native UI automation session was intentionally stopped before an authenticated repository, issue, or pull-request read could be performed. No GitHub write action, token, device code, provider payload, or repository content was accessed or recorded.

Artifacts:

- No recording or screenshots: the live walkthrough was stopped before interaction.
- Terminal launch output recorded the isolated June API, Vite at `127.0.0.1:1422`, and Hermes spawning under the macOS Seatbelt write-jail.

Gaps:

- The running worktree app remains open for a manual, signed-in read-only repository, issue, and pull-request walkthrough. The automated run did not prove the managed runtime seal's visible success state or the GitHub read UI.
