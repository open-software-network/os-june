# Agent collaboration: build, delegate, review

How coding agents (Claude Code, Codex, or any future harness) collaborate on
this repo: who orchestrates, who implements, who reviews, and what each layer
may touch. This is the map; the skills own the mechanics — never restate a
skill's commands here or anywhere else (single owner per fact).

## The skill family

`repo-build-pr` is the entry point. It orchestrates and defers to owners:

| Skill | Altitude | Git contract |
|---|---|---|
| `repo-build-pr` | the whole workflow: intake, tracker lifecycle, plan, chunking, validation, review, publish | commits and publishes |
| `repo-review` | one review axis per run (Standards / Spec / Adversarial), any harness | read-only |
| `repo-delegate` | one scoped implementation brief on another harness | edits + gate, never commits |
| `repo-orchestrate` | the whole workflow handed to another harness | commits; push/PR only with `--publish` |
| `agent-e2e-qa` | live QA process: surfaces, recording, upload, evidence format | read-only on code |
| `browser-test-tauri-fe` | browser-surface technique (fake Tauri IPC bridge, Playwright/CDP) | read-only on code |

Entry points by situation:

- Build a task in this session: `/repo-build-pr <task>`.
- Build with the other harness implementing per chunk:
  `/repo-build-pr <task> with codex` (or `with claude` from Codex).
- Hand the entire build to the other harness: `repo-orchestrate`.
- Review a branch/PR/diff: `repo-review` (sized per its Sizing section).
- Ship one precise fix prescription to an implementer: `repo-delegate`.

## Principles

1. **The reviewer is never the author** (default). The adversarial review
   axis runs on a harness that did not write the diff. This is
   evidence-based: the two harnesses' finding sets are measurably disjoint
   (`.agents/skills/repo-review/CALIBRATION.md`). Deliberate exception: the
   `with codex` build mode runs implementation and all review axes on Codex
   by convention — self-review accepted; the counterweights are
   regression-gated fixture tests per fix and the orchestrating session's
   own verification. (PR #615: Codex adversarial rounds still surfaced two
   real defects in largely Codex-written code.)
2. **Judgment stays with the orchestrator.** Plans, contracts, triage,
   go/no-go never delegate. A delegate's report is a claim; the diff and
   real gate output are the evidence.
3. **Trust is two-level and stated honestly.** Codex-side runners get OS
   sandboxes (`read-only` / `workspace-write`); Claude-side runners are
   policy-level (plan mode / acceptEdits + allowlists + detection guards).
   Policy-level runners are for branches authored in-session only — never
   unvetted third-party diffs. Escalations (publish, untracked files) are
   explicit flags, never defaults.
4. **Docs are load-bearing.** Plans are grilled against CONTEXT.md, ADRs,
   and `spec/` before the user is asked anything; doc contradictions found
   while building become doc fixes in the same PR.
5. **The battery calibrates itself.** Every review cycle ends by appending
   reviewer precision rows to CALIBRATION.md and folding new lessons into
   the skill that missed them.

## Adding a harness

Every cross-harness skill ships a `scripts/HARNESS-TEMPLATE.md` with the
runner contract (same CLI, prompt from the shared filler, strictest
confinement the harness offers, uniform output). A new harness is one runner
script per skill; nothing else changes.
