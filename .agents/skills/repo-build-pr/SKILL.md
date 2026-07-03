---
name: repo-build-pr
description: >-
  Use when the user invokes /repo-build-pr (or $repo-build-pr in Codex), or asks
  to build, implement, ship, or fix something in os-june from a feature prompt,
  bug report, screenshot, PR comment, or freeform repo task: study the prompt,
  ask the clarifying questions that change what gets built up front,
  plan and architect on the most capable model while delegating bulk
  implementation to cheaper strong models,
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
3. Inspect the current checkout with `git status -sb`. A dirty checkout is fine, but never implement in it: all work happens in a worktree branched from freshly fetched `origin/main` (see Worktree strategy).
4. Fetch the target base branch. Use `origin/main` unless the user explicitly names another base.
5. Search the codebase with `rg` and read the narrowest relevant files before deciding on the implementation.

### Clarifying questions

Before writing any code, ask the questions whose answers change what gets built. A wrong guess at this stage costs an entire build-review cycle; a question costs the user seconds. Ask them as ONE batch up front (AskUserQuestion in Claude Code, a single numbered list in Codex), with a recommended option per question so the user can mostly confirm.

Worth asking:

- product behavior or UX choices with more than one defensible shape (what should the user see, where does the control live, what happens on failure)
- scope boundaries: what is explicitly in and out, one PR or several, feature-complete or minimal first cut
- acceptance criteria when the prompt implies but does not state them (what makes this done, what must keep working)
- anything irreversible or outward-facing: schema migrations, API contract changes, billing, released-channel behavior, data deletion
- conflicts between the prompt and what the code or tracker Issue actually says

Not worth asking:

- anything the repo, issue, or git history already answers - look first
- choices with an obvious conventional default - pick it and note it in the PR
- details that do not change the diff

Do not trickle questions throughout the build; front-load them. If answers do not come or the task is explicitly AFK, take the conservative path, state each assumption prominently in the PR body, and flag the ones a reviewer should double-check.

## Model orchestration

Assume the session is running on the most capable model available (for example Fable 5 in Claude Code, GPT-5.6 in Codex). That model is expensive, so spend it where capability compounds and delegate everything else.

The top model keeps the work that determines whether the PR is right:

- intake, scoping, and the implementation plan
- architecture and the contracts between parallel tracks (command names, request/response shapes, file ownership)
- judgment calls: review-feedback triage, tradeoffs, anything ambiguous or irreversible
- verification: reading delegated diffs, adversarially re-checking claimed results, deciding what is actually done

Delegate the bulk of the implementation to strong but cheaper models (for example Opus 4.8 subagents via the Agent tool's `model` option in Claude Code, GPT-5.5 in Codex): writing code against a specified contract, test authoring, mechanical refactors, merge-conflict resolution with clear instructions, QA recording, and PR housekeeping.

Delegation rules:

- Write each brief like a contract: exact scope and file ownership, the interface to build against, validation commands that must pass, repo conventions to follow, and an instruction to report deviations instead of improvising around them.
- Run implementers in parallel only when their file ownership does not overlap; define shared contracts up front so independently built halves meet.
- Never trust a delegated report on its own. Verify against the diff and test output, and route confirmed defects back to the agent that owns that code with the evidence.
- Right-size the overhead: if the brief would be longer than the diff, skip delegation and do the work directly on the top model.
- Expect subagents to die on transient failures (API overload, timeouts). Resume the same agent so it keeps its context instead of respawning from scratch; the same applies when sending follow-up scope or defect reports to an agent that already knows the code.
- Do not delegate the plan, the contracts, or the final go/no-go. If the orchestrating model finds itself writing bulk code, delegate; if a subagent starts making architectural decisions, pull them back up.

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
pnpm check
pnpm typecheck
pnpm test
pnpm build
pnpm test:rust
cargo test --manifest-path src-tauri/Cargo.toml --locked
cargo +1.95.0-aarch64-apple-darwin test --manifest-path june-api/Cargo.toml --all-targets --all-features --locked
```

Choose checks based on touched files. For example:

- Frontend-only change: `pnpm check` and `pnpm typecheck` plus the relevant frontend test or `pnpm test`.
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

### Pre-publish review pass

Green checks and a passing walkthrough are necessary, not sufficient: they prove the code does what its tests say, not that the diff is free of defects the tests never imagined. For any non-trivial diff, run the `repo-review` battery locally before opening the draft PR (load `.agents/skills/repo-review/SKILL.md`; `$repo-review` in Codex):

1. Run all three axes over `origin/main...HEAD` — Standards and Spec as parallel sub-agents, and dispatch the adversarial axis to the *other* harness so the reviewer is not the model that wrote the change: from Claude Code, `.agents/skills/repo-review/scripts/run-codex.sh -a adversarial`; from Codex, `.../run-claude.sh -a adversarial` (policy-level enforcement — for branches this session authored, never unvetted third-party diffs).
2. Triage every finding to a disposition per the battery's aggregate step — fix-now, deliberate (amend the spec file), pre-existing parity (follow-up, checked against the fixed point), or refuted (with evidence). Verify before fixing; plausible-sounding findings that cannot name a failure scenario are noise.
3. Route confirmed defects back to the implementer agent that owns the code, with the evidence, re-run the relevant validation, then re-run the adversarial axis until it approves (the battery's convergence loop).

Skip this only for trivial diffs (docs, one-line fixes) and say so in the PR validation notes.

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
   - assumptions taken on clarifying questions that went unanswered, flagged for reviewer attention
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
