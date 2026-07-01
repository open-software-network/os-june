---
name: repo-build-pr
description: >-
  Use when the user invokes /repo-build-pr (or $repo-build-pr in Codex), or asks
  to build, implement, ship, or fix something in os-june from a feature prompt,
  bug report, screenshot, PR comment, or freeform repo task: study the prompt,
  work in one or more git worktrees based on complexity, validate changes with
  deterministic checks plus agent-driven live app walkthroughs when useful,
  record, upload through os-platform, and attach reviewer-friendly QA video URLs
  when the change benefits from visual evidence, open a draft PR, wait for
  Greptile and Codex review, address
  only relevant feedback, request a final review, and mark the PR ready for
  review.
---

# Repo build PR

Use this skill for the end-to-end implementation loop in `open-software-network/os-june`. The goal is not only to make code changes. The goal is to understand the prompt, isolate the work in worktrees, ship a coherent PR, and run the automated review loop with judgment.

## Intake

Treat everything after `/repo-build-pr` (or `$repo-build-pr` in Codex) as the build prompt. If the user did not use the literal command but asks to build, implement, ship, or fix something in the repo, use this skill anyway.

1. Read the prompt carefully and restate the concrete objective, constraints, and likely affected surface area.
2. Read repo instructions before editing:
   - `AGENTS.md`
   - `CLAUDE.md`
   - any referenced project plan or spec relevant to the task
3. Inspect the current checkout with `git status -sb`. Do not implement from a dirty or stale main checkout.
4. Fetch the target base branch. Use `origin/main` unless the user explicitly names another base.
5. Search the codebase with `rg` and read the narrowest relevant files before deciding on the implementation.

If the prompt is ambiguous but a conservative implementation path is clear, proceed and document the assumption. Ask the user only when the missing detail changes the product behavior or could waste substantial work.

## Worktree strategy

Always isolate implementation work from the user's active checkout.

- Create a dedicated sibling worktree from the chosen base, then copy the
  gitignored local environment files into it. Capture the main checkout path
  first, because fresh worktrees do not inherit `.env` or `june-api/.env`:
  ```bash
  MAIN="$(git rev-parse --show-toplevel)"
  git fetch origin main
  git worktree add -b codex/<short-description> ../os-june-<short-description> origin/main
  cd ../os-june-<short-description>
  cp "$MAIN/.env" .env 2>/dev/null || true
  cp "$MAIN/june-api/.env" june-api/.env 2>/dev/null || true
  ```
  These files are gitignored and exist only in the main checkout. The app, the
  local dev token, and the QA video upload all depend on them. In particular,
  `june-api/.env` holds the os-platform API key
  (`JUNE__ISSUE_REPORTS__OS_PLATFORM_API_KEY` / `OS_PLATFORM_API_KEY`) that the
  video upload step reads, so without this copy `prepare_qa_video.py --upload`
  fails inside the worktree.
- Use one worktree for simple or medium tasks.
- Use multiple worktrees or subagents only when the prompt naturally splits into independent tracks, such as frontend plus backend exploration, competing implementation strategies, or a broad bug hunt.
- Keep one final integration branch and one final PR unless the user explicitly asks for multiple PRs.
- If using subagents, give each one a narrow investigation or implementation brief. Do not let parallel agents make uncoordinated commits to the same files.

Before editing, tell the user which worktree or worktrees you are using and why.

## Implementation

Follow the repo's existing patterns first.

- Keep edits scoped to the prompt and nearby supporting tests.
- Use `apply_patch` for manual file edits.
- Do not revert unrelated user changes.
- For UI work, follow `CLAUDE.md`: sentence-case labels, design tokens from `src/styles/tokens.css`, and icons from `central-icons` or `central-icons-filled` only.
- Do not add new dependencies, abstractions, or global behavior unless they are clearly needed for the prompt.
- Commit only after reading the final diff and confirming every changed file belongs to the PR.

## Validation

Run the smallest checks that prove the change, then broaden based on blast radius.

Common checks in this repo:

```bash
pnpm run lint
pnpm test
pnpm build
pnpm test:rust
cargo test --manifest-path src-tauri/Cargo.toml --locked
cargo +1.95.0-aarch64-apple-darwin test --manifest-path june-api/Cargo.toml --all-targets --all-features --locked
```

Choose checks based on touched files. For example:

- Frontend-only change: `pnpm run lint` plus the relevant frontend test or `pnpm test`.
- Tauri Rust change: targeted `cargo test --manifest-path src-tauri/Cargo.toml --locked`, then broader checks if shared behavior changed.
- June API change: the pinned Rust toolchain command above.
- Docs or skill-only change: validate the skill structure and skip expensive app builds unless related files require them.

If a check cannot run because of local tooling, missing services, or credentials, say exactly what blocked it and what evidence still supports the PR.

### Live app walkthroughs

Use `$agent-e2e-qa` as the default human-like validation layer whenever the change affects a user-visible workflow or would be hard to trust from code and terminal output alone. Load that skill before running the walkthrough.

Run an agent-driven walkthrough for changes that touch:

- app UI, onboarding, settings, HUDs, trays, native windows, permissions, or visual layout
- agent conversations, prompt flows, streaming states, error states, or background runs
- auth, account, checkout, external browser handoff, file upload/download, or other integration paths
- bug fixes with a reproducible user sequence
- behavior that reviewers can understand faster by seeing it operate

Skip live walkthroughs for narrow docs-only, test-only, build config, pure refactor, or low-level utility changes when no user-visible behavior is affected. Say why it was skipped in the PR validation notes.

Pick the least invasive surface from `$agent-e2e-qa`: Browser or the background Playwright helper for web-reachable flows, Computer Use for native-only Tauri behavior, and Chrome only for flows that depend on the user's browser session. Do not perform live billing, enter credentials, record microphone audio, or expose private data without explicit user confirmation.

For a recorded video walkthrough, default to Playwright via the bundled background helper rather than foreground screen capture:

```bash
.agents/skills/agent-e2e-qa/scripts/run_background_agent_prompt.mjs --prompt "<walkthrough goal>"
```

It drives the Vite app in headless Chromium, records Playwright video to `.tmp/qa-recordings/*.webm`, and shims only the Tauri shell calls the web surface needs, so the run does not fight the user's screen. If `playwright-core` is missing, install it outside repo dependencies with `npm install --prefix .tmp/playwright-tools playwright-core@latest`. The resulting `.webm` feeds straight into `prepare_qa_video.py` for compression and upload. Reserve Computer Use recording for native-only Tauri behavior that Playwright cannot reach.

Treat walkthrough failures as validation failures. Fix the issue, rerun the relevant deterministic checks, and rerun the live walkthrough before asking for final review. If the live surface is blocked by permissions, credentials, hardware, or unavailable services, include `BLOCKED` evidence and the remaining risk.

Record, compress, upload the compressed video to os-platform, and attach the resulting remote URL to the PR when human reviewers would benefit from seeing the result, such as visual/UI changes, native interactions, agent behavior, fixed bug repros, or "the test is the demo" flows. Prefer `.agents/skills/agent-e2e-qa/scripts/prepare_qa_video.py --upload --confirm-public --comment-pr <pr-number>` after the user or task has authorized public PR sharing. Do not treat a local video path as sufficient PR evidence when video sharing was authorized; include the os-platform URL or PR comment in the validation evidence.

The upload reads the os-platform API key from `june-api/.env` (`JUNE__ISSUE_REPORTS__OS_PLATFORM_API_KEY` or `OS_PLATFORM_API_KEY`), falling back to that file when the env vars are unset. Because `june-api/.env` is gitignored and absent from fresh worktrees, either copy it into the worktree (see Worktree strategy) or run `prepare_qa_video.py` with the working directory set to the main checkout while passing the worktree's raw recording path as input. If the key is still missing, the upload fails with a "set OS_PLATFORM_API_KEY" error; record that as a `BLOCKED` upload and keep the local video path in the evidence.

## Publish

Use a draft PR for the first publish.

1. Review `git diff` and `git status -sb`.
2. Stage only intended files.
3. Commit with a terse message.
4. Push the branch:
   ```bash
   git push -u origin "$(git branch --show-current)"
   ```
5. Open a draft PR against the chosen base. The PR body should include:
   - task ID from the prompt or live issue data, including `Closes <TASK-ID>` when a tracker Issue exists
   - what changed
   - why it changed
   - validation run
   - live agent walkthrough evidence, os-platform video URLs or PR comments, or the reason no live walkthrough was useful
   - known gaps or skipped checks
6. Watch initial CI with:
   ```bash
   gh pr checks --watch
   ```

Do not mark the PR ready yet.

## Review loop

After the draft PR exists, wait for automated review from Greptile and Codex within the current session when practical. This can be slow. Poll for up to 30 minutes before concluding no automated review is available, unless the user asks to stop sooner or the session is otherwise blocked.

Use `gh` to inspect review state:

```bash
gh pr view <number> --comments --json comments,reviews,reviewRequests
gh pr checks <number> --watch
```

Poll about every 30 seconds so feedback is picked up quickly. Re-check both comments and reviews because Greptile often comments while Codex can appear as a review. Keep the user updated while waiting, but do not start duplicate polls or spam the PR with repeated bot pings.

For inline review threads, use GraphQL through `gh api graphql` when `gh pr view` is not enough. Inspect recent repo PRs if the current bot handles or re-trigger comments are unclear. At the time this skill was written, recent reviews used:

- Greptile summary/comment author: `greptile-apps`
- Codex review author: `chatgpt-codex-connector`
- Codex review trigger comment: `@codex review`

Classify every bot comment before acting:

- `Relevant and correct`: implement it.
- `Correct but out of scope`: reply with a concise rationale and leave it for a separate PR.
- `Incorrect`: reply with the evidence and do not change code.
- `Duplicate`: note the existing fix or prior response.

Do not apply bot feedback mechanically. The user explicitly wants judgment: address feedback only when it is relevant and good.

After fixing accepted feedback:

1. Re-run the relevant validation.
2. If the follow-up changed user-visible behavior, rerun the relevant `$agent-e2e-qa` walkthrough and refresh PR video evidence when reviewers benefit from seeing the new result.
3. Commit and push follow-up changes.
4. Re-check PR comments, review threads, and CI.
5. Request final review from Greptile and Codex using the repo's current trigger convention. For Codex, post the exact PR comment `@codex review`. If Greptile's convention is unclear, leave a clear PR comment tagging the observed Greptile identity and asking for another pass.
6. Mark the PR ready for review only after the final review request is posted and there are no known local blockers:
   ```bash
   gh pr ready <number>
   ```

Do not merge the PR unless the user explicitly asks.

## Stop conditions

Stop and ask the user for help only when progress is blocked by authentication, missing secrets, inaccessible external services, or a product decision that cannot be inferred safely.

If automated reviewers do not respond after the full 30-minute polling window, leave the PR as draft or tell the user exactly what is still pending. Do not pretend a final review happened.
