---
name: repo-build-pr
description: >-
  Use when the user invokes /repo-build-pr (or $repo-build-pr in Codex), or asks
  to build, implement, ship, or fix something in os-june from a feature prompt,
  bug report, screenshot, PR comment, tracker task id, or freeform repo task —
  optionally with a cross-harness implementer directive like
  "/repo-build-pr JUN-200 with codex": study the prompt,
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

To hand this entire workflow to a *different* harness as orchestrator (e.g. dispatch a whole build to Codex from Claude Code, or vice versa), use the `repo-orchestrate` skill instead — it wraps this workflow in a per-harness runner with a stop-before-publish default.

## Skill map

This is the repo's entry-point skill; it orchestrates and defers. Each fact lives in exactly one owner — load the owner at the step that needs it, never restate its commands here:

- `repo-review` — pre-publish review battery: axes, per-harness runners, disposition triage, convergence loop.
- `repo-delegate` — single-brief implementation dispatch to another harness (the building block of the cross-harness implementer mode).
- `repo-orchestrate` — hand this whole workflow to another harness.
- `agent-e2e-qa` — live QA process: surface decision tree, video recording/compression, os-platform upload, PASS/FAIL/BLOCKED evidence format.
- `browser-test-tauri-fe` — browser-surface technique: fake Tauri IPC bridge, Playwright/CDP driving, screenshot suites, PR-embeddable GIFs.
- `os-platform` / `os-task-prep` — tracker reads, task diagnosis and enrichment (intake step 3).

## Intake

Treat everything after `/repo-build-pr` (or `$repo-build-pr` in Codex) as the build prompt. If the user did not use the literal command but asks to build, implement, ship, or fix something in the repo, use this skill anyway.

1. Read the prompt carefully and restate the concrete objective, constraints, and likely affected surface area. A trailing implementer directive (`with codex` in Claude Code, `with claude` in Codex) selects a cross-harness implementer — see Model orchestration.
2. Read repo instructions before editing:
   - `AGENTS.md`
   - `CLAUDE.md`
   - any referenced project plan or spec relevant to the task
3. If the prompt names a tracker task (a `JUN-xxx` id or an os-platform issue reference — issues live on os-platform, org `june`, per `docs/agents/issue-tracker.md`): fetch it via the `os-platform` skill and validate it is actually implementable against the codebase (root cause, affected files, acceptance criteria — apply the `os-task-prep` diagnosis discipline if the issue is thin, and update the issue with what you learn). Then take it before writing code: assign it to the current user and set status to in-progress through the documented platform API (append-only, probe-then-verify). Include `Closes <TASK-ID>` in the eventual PR body.
4. Inspect the current checkout with `git status -sb`. A dirty checkout is fine, but never implement in it: all work happens in a worktree branched from freshly fetched `origin/main` (see Worktree strategy).
5. Fetch the target base branch. Use `origin/main` unless the user explicitly names another base.
6. Search the codebase with `rg` and read the narrowest relevant files before deciding on the implementation.

### Grill the plan against the docs

Before asking the user anything, interrogate the draft plan against the repo's own documentation. Two goals: consume questions the docs already settle, and surface where the docs are stale or silent so this build can fix them.

Sources, in order: `CONTEXT.md` (every term the plan uses must match the glossary; check the `_Avoid_` lists), `docs/adr/` for the touched area (does the plan re-litigate an accepted decision? will it need a new ADR per the AGENTS.md three-part test?), the subsystem doc via `docs/index.md`, `spec/` rules in scope, and any `specs/NNN-*/` feature spec.

For each load-bearing decision in the plan, classify:

- **Docs decide it** — adopt the documented answer and cite it in the plan; not a question.
- **Docs contradict the plan** — one of them is wrong. Decide which with evidence; if the doc is stale, queue the doc fix. If the plan is wrong, fix the plan.
- **Docs are silent** — that is a real clarifying question. Carry the "checked X, Y — silent" note into the question so the user sees why it is genuinely open.

Queue every doc delta found here into the build itself: CONTEXT.md term updates ride in the same change (AGENTS.md convention), ADR-worthy decisions get an ADR, stale subsystem-doc claims get corrected. Small doc fixes belong in this PR; large rewrites become a linked follow-up issue.

### Clarifying questions

Before writing any code, ask the questions whose answers change what gets built — the survivors of the docs grill. A wrong guess at this stage costs an entire build-review cycle; a question costs the user seconds. Ask them as ONE batch up front (AskUserQuestion in Claude Code, a single numbered list in Codex), with a recommended option per question so the user can mostly confirm.

Worth asking:

- product behavior or UX choices with more than one defensible shape (what should the user see, where does the control live, what happens on failure)
- scope boundaries: what is explicitly in and out, one PR or several, feature-complete or minimal first cut
- acceptance criteria when the prompt implies but does not state them (what makes this done, what must keep working)
- anything irreversible or outward-facing: schema migrations, API contract changes, billing, released-channel behavior, data deletion
- conflicts between the prompt and what the code or tracker Issue actually says

Not worth asking:

- anything the repo, issue, or git history already answers - the docs grill above should have consumed these
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

### Cross-harness implementer (`with codex` / `with claude`)

When the build prompt carries an implementer directive (e.g. `/repo-build-pr JUN-200 with codex`), the named harness implements every delegated brief; the session model keeps everything that determines whether the PR is right — intake, the tracker lifecycle, architecture, chunking, verification, review, and publish.

1. Plan first, as above (including clarifying questions — the session is interactive even when the implementer is not). Then split the plan into small, independently verifiable chunks: each chunk gets its own brief file written to the contract standard above, plus the narrowest gate command that proves it.
2. Dispatch each chunk to the implementer in the active worktree via `repo-delegate`:
   ```bash
   .agents/skills/repo-delegate/scripts/run-codex.sh -t <chunk-brief.md> -C <worktree> -g "<chunk gate>"
   ```
   (`run-claude.sh` when orchestrating from Codex.) The delegate edits and runs the gate but never commits, and its runners require a clean tracked tree — so verify the diff, then commit each chunk before dispatching the next. Atomic commits fall out of the loop naturally.
3. Chunks run sequentially in one worktree. Genuinely independent tracks get separate worktrees (strategy below), one delegate stream per worktree.
4. Verify every chunk yourself against the diff and real gate output; a delegate report is a claim, not evidence. Route defects back as a follow-up brief that references the original chunk.
5. In the pre-publish battery, the adversarial axis must go to a harness that did **not** write the diff: with Codex as implementer, run it on a Claude sub-agent (or `repo-review/scripts/run-claude.sh`); never send the diff back to its own author for the adversarial pass.

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

Use `$agent-e2e-qa` as the default human-like validation layer whenever the change affects a user-visible workflow or would be hard to trust from code and terminal output alone. Load that skill before running the walkthrough — it owns the surface decision tree (web preview / background browser video / native Tauri / Chrome handoff), the recording, compression, and os-platform upload pipeline, and the evidence format. For lightweight browser-only visual verification — screenshots or a PR-embeddable GIF without a full QA charter — load `$browser-test-tauri-fe` instead; it owns the technique of driving the Vite frontend in Chromium with a faked Tauri IPC bridge.

Run an agent-driven walkthrough for changes that touch:

- app UI, onboarding, settings, HUDs, trays, native windows, permissions, or visual layout
- agent conversations, prompt flows, streaming states, error states, or background runs
- auth, account, checkout, external browser handoff, file upload/download, or other integration paths
- bug fixes with a reproducible user sequence
- behavior that reviewers can understand faster by seeing it operate

Skip live walkthroughs for narrow docs-only, test-only, build config, pure refactor, or low-level utility changes when no user-visible behavior is affected. Say why it was skipped in the PR validation notes.

Pick the least invasive surface per `$agent-e2e-qa`'s decision tree. Do not perform live billing, enter credentials, record microphone audio, or expose private data without explicit user confirmation.

Treat walkthrough failures as validation failures. Fix the issue, rerun the relevant deterministic checks, and rerun the live walkthrough before asking for final review. If the live surface is blocked by permissions, credentials, hardware, or unavailable services, include `BLOCKED` evidence and the remaining risk.

What this workflow requires of the walkthrough (the commands and pipeline live in `$agent-e2e-qa`):

- Record video when human reviewers would benefit from seeing the result (visual/UI changes, native interactions, agent behavior, fixed bug repros, "the test is the demo" flows); prefer the background browser helper over foreground screen capture so the run does not fight the user's screen.
- When PR sharing was authorized, compress and upload the video to os-platform and put the remote URL or PR comment in the validation evidence — a local path is not sufficient. The upload key rides in `june-api/.env`, which fresh worktrees lack (see Worktree strategy); a missing key is a `BLOCKED` upload with the local path kept as evidence.

### Pre-publish review pass

Green checks and a passing walkthrough are necessary, not sufficient: they prove the code does what its tests say, not that the diff is free of defects the tests never imagined. For any non-trivial diff, run the `repo-review` battery locally before opening the draft PR (load `.agents/skills/repo-review/SKILL.md`; `$repo-review` in Codex):

1. Run all three axes over `origin/main...HEAD` — Standards and Spec as parallel sub-agents, and dispatch the adversarial axis to a harness that did *not* write the diff: from Claude Code with in-session implementation, `.agents/skills/repo-review/scripts/run-codex.sh -a adversarial`; from Codex, `.../run-claude.sh -a adversarial` (policy-level enforcement — for branches this session authored, never unvetted third-party diffs); with a cross-harness implementer (see Model orchestration), pick a reviewer that is not the implementer.
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
