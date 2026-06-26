---
name: repo-build-pr
description: >-
  Use when the user invokes /repo-build-pr (or $repo-build-pr in Codex), or asks
  to build, implement, ship, or fix something in os-june from a feature prompt,
  bug report, screenshot, PR comment, or freeform repo task: study the prompt,
  work in one or more git worktrees based on complexity, open a draft PR, wait
  for Greptile and Codex review, address only relevant feedback, request a final
  review, and mark the PR ready for review.
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

- Create a dedicated sibling worktree from the chosen base:
  ```bash
  git fetch origin main
  git worktree add -b codex/<short-description> ../os-june-<short-description> origin/main
  ```
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
cargo +1.95.0-aarch64-apple-darwin test --manifest-path scribe-api/Cargo.toml --all-targets --all-features --locked
```

Choose checks based on touched files. For example:

- Frontend-only change: `pnpm run lint` plus the relevant frontend test or `pnpm test`.
- Tauri Rust change: targeted `cargo test --manifest-path src-tauri/Cargo.toml --locked`, then broader checks if shared behavior changed.
- Scribe API change: the pinned Rust toolchain command above.
- Docs or skill-only change: validate the skill structure and skip expensive app builds unless related files require them.

If a check cannot run because of local tooling, missing services, or credentials, say exactly what blocked it and what evidence still supports the PR.

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
2. Commit and push follow-up changes.
3. Re-check PR comments, review threads, and CI.
4. Request final review from Greptile and Codex using the repo's current trigger convention. For Codex, post the exact PR comment `@codex review`. If Greptile's convention is unclear, leave a clear PR comment tagging the observed Greptile identity and asking for another pass.
5. Mark the PR ready for review only after the final review request is posted and there are no known local blockers:
   ```bash
   gh pr ready <number>
   ```

Do not merge the PR unless the user explicitly asks.

## Stop conditions

Stop and ask the user for help only when progress is blocked by authentication, missing secrets, inaccessible external services, or a product decision that cannot be inferred safely.

If automated reviewers do not respond after the full 30-minute polling window, leave the PR as draft or tell the user exactly what is still pending. Do not pretend a final review happened.
