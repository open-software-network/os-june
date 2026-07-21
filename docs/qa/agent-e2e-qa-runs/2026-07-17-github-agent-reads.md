# Agent E2E QA run: GitHub agent reads

Environment:

- Date: 2026-07-21
- Worktree/branch: `/Users/sarascahya/.codex/worktrees/25ef/os-june`, `codex/github-connector-phase-0`
- Commit at QA start: `2575e6c7`
- Command: `OS_JUNE_LOCAL_DEV=1 OS_JUNE_LOCAL_DEV_BEARER_TOKEN=local-dev-token OS_JUNE_LOCAL_DEV_USER_ID=usr_local_dev JUNE__SERVER__HOST=127.0.0.1 JUNE__LOCAL_DEV__ENABLED=true JUNE__LOCAL_DEV__BEARER_TOKEN=local-dev-token JUNE__LOCAL_DEV__USER_ID=usr_local_dev GITHUB_APP_CLIENT_ID=Iv23lihKGi1yIb8QZm9L GITHUB_APP_SLUG=june-staging node scripts/tauri-dev.mjs`
- Surface: native Tauri worktree app
- Data mode: local June API configuration with the documented public GitHub App configuration

Checks:

- PASS - Managed installer alias regression coverage - the focused production-installer test proved the verified uv CPython alias is removed before relocation and a mismatched alias is retained while installation fails.
- BLOCKED - Native connector walkthrough - the worktree app did not start because the host is missing the pinned pnpm 11.9.0 executable at `/Users/sarascahya/Library/pnpm/.tools/@pnpm+macos-arm64/11.9.0/bin/pnpm` (`ENOENT`). Therefore the existing GitHub connection, sandboxed repository list, issue read, pull request read, integrity files, and absence of broken aliases could not be inspected live.

Artifacts:

- No recording or screenshots: June did not reach an app window.
- Terminal launch output recorded the pinned-pnpm `ENOENT` before `beforeDevCommand` completed.

Gaps:

- Live native QA remains pending a host repair that restores the repository-pinned pnpm CLI. No connector write action, token, device code, provider payload, or repository content was accessed or recorded.
