---
name: repo-retrospect
description: >-
  Post-cycle retrospective for the os-june build pipeline: mine the finished
  session conversation, every PR review surface, and the user's corrections
  for evidence-backed lessons, then fold each lesson into the one skill or
  doc file that owns it (repo-review axes and CALIBRATION.md, repo-build-pr
  workflow, repo-delegate briefs, CONTEXT.md, AGENTS.md) as a small docs-only
  change. Use after a PR merges or a build/review loop closes, or when the
  user asks to run a retrospective, capture learnings, or improve the
  pipeline/loop from what just happened.
---

# Repo retrospect

Turn a finished build cycle into pipeline improvements. The premise: every
cycle produces calibration data — what the local battery missed, what
external reviewers caught, where the orchestrator mis-triaged, what the user
had to correct — and that data is worthless unless it lands in the file the
next cycle actually reads. This skill is the loop that closes the loop.

Run it at the end of a cycle: after the PR merges, after the review loop is
closed out, or whenever the user asks what the pipeline should learn.

## 1. Gather evidence (three sources, all of them)

- **The session conversation** — the orchestrator's own history: triage
  decisions and which later proved wrong (a "no change needed" that a later
  round reopened), permission blocks and the fallbacks used, tool/environment
  failures (ports, agents, signing), plan assumptions the code contradicted,
  and anything the docs-grill found stale.
- **PR review surfaces** — all three, via `gh` (same discipline as the
  repo-build-pr review loop): inline threads with their reply chains
  (`gh api .../pulls/<n>/comments`), review bodies (`gh pr view <n> --json
  reviews` — collapsed `<details>` tables included), and summary comments.
  For each finding record: who found it, which round, the disposition, and —
  the key question — **why the local battery did not find it first**.
- **User feedback** — explicit corrections, clarifying-question answers that
  overrode a default, mid-build scope changes, and anything the user flagged
  after the fact. User corrections outrank model judgment: a lesson the user
  taught twice is a rule, not a note.

## 2. Classify each lesson to its single owner

Each fact lives in exactly one file (the skill-map convention). Route:

| Lesson shape | Owner |
|---|---|
| Reviewer precision/recall fact, per-bot behavior, round counts | `repo-review/CALIBRATION.md` (one row per reviewer per cycle) |
| Systematic review blind spot (a failure *class*, seen once with evidence) | `repo-review/axes/<axis>.md` — extend a lens, never bolt on a new section when an existing one fits |
| Battery sizing, convergence, or dispatch lesson | `repo-review/SKILL.md` |
| Build-workflow order, chunking, validation, or publish lesson | `repo-build-pr/SKILL.md` |
| Brief-writing or delegate-verification lesson | `repo-delegate/SKILL.md` |
| Walkthrough/QA technique gotcha | `browser-test-tauri-fe` or `agent-e2e-qa` |
| Domain term sharpened or invented mid-cycle | `CONTEXT.md` (same-change rule) |
| Hard-to-reverse decision with a real trade-off | new ADR (append-only; AGENTS.md three-part test) |
| Cross-skill convention change | `AGENTS.md` or `docs/agents/collaboration.md` |

## 3. The inclusion bar

- **Evidence or it doesn't land.** A lesson needs a concrete artifact: a
  finding that survived triage, a round it cost, a commit that fixed it, a
  user correction. Speculative process tweaks are noise that dilutes the
  skills for every future agent.
- **Generalize to the class, cite the instance.** Write the rule as the
  failure class ("moved lines change downstream consumer semantics"), cite
  the PR/finding as provenance so future edits can re-check it.
- **Prefer editing over adding.** Skills are read whole by fresh agents;
  every added line taxes every future cycle. If an existing sentence can
  carry the lesson with five more words, do that.
- **Never relitigate.** Dispositions from the closed cycle stand; ADRs are
  append-only; a lesson about a wrong disposition goes to CALIBRATION.md as
  a calibration fact, not into re-arguing the PR.

## 4. Ship it

One small docs-only PR (or ride along with an open docs/skill PR from the
same cycle). Validation per the repo-build-pr matrix for skill-only diffs:
check every touched `.claude/skills/<name>` entry is still a symlink to
`../../.agents/skills/<name>`, keep `spec/index.md` and the AGENTS.md skill
list in sync if a skill was added or renamed, and skip app builds. State in
the PR body which cycle (PR numbers) the lessons came from.

## Anti-goals

- Not a blame log and not a diary — only rules the next cycle will execute.
- Not a place to grow process for its own sake: if a cycle produced no
  evidence-backed lesson, the correct retrospective output is "no changes",
  stated to the user with a one-line reason.
