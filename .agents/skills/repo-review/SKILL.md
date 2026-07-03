---
name: repo-review
description: >-
  Run the os-june review battery over the diff between HEAD and a fixed point:
  a two-axis review (Standards — does the code follow this repo's documented
  rules; Spec — does it faithfully implement the originating issue/design) in
  parallel sub-agents, plus an adversarial review that attacks the change's
  assumptions using the shared model-agnostic prompt. Use when the user asks to
  review a branch, PR, or diff, run the review battery, re-run reviews until
  clean, or verify a change is aligned with its spec and repo standards.
---

# Repo review battery

Three independent review axes over `git diff <fixed-point>...HEAD`. Each axis
runs as its own sub-agent so findings don't contaminate each other; the caller
aggregates without reranking across axes.

- **Standards** — does the diff conform to this repo's documented rules?
- **Spec** — does the diff faithfully implement what was asked?
- **Adversarial** — actively try to break confidence in the change.

A change can pass one axis and fail another (right thing built wrong, wrong
thing built right, correct-looking thing that fails under stress). Keeping the
axes separate stops one from masking another — never merge or rerank findings
across axes.

## 1. Pin the fixed point

The fixed point is whatever the user names (`main`, a SHA, `HEAD~5`). For a PR
branch it defaults to `main`. Before spawning anything:

```bash
git rev-parse <fixed-point>          # must resolve
git log <fixed-point>..HEAD --oneline
git diff <fixed-point>...HEAD --stat # must be non-empty (three-dot: merge-base)
```

A bad ref or empty diff fails here — not inside three parallel sub-agents.

## 2. Resolve the axis inputs

**Standards sources** (this repo, in scope-of-diff order):

- `spec/index.md` and every rule file it lists (sentence-case,
  no-typographic-dashes, icons-central-only, design-tokens, ...) — violations
  fail review.
- `CONTEXT.md` — the glossary's `_Avoid_` lists are binding; "stored vs runtime
  session id" must always be qualified; watch control plane vs gateway vs
  adapter drift.
- `AGENTS.md` conventions (comment idiom: constraints not narration; naming;
  boundaries).
- Skip anything tooling already enforces (Biome, tsc).

**Spec source** (first match wins):

1. Issue/PR references in the commit messages — fetch the PR body via `gh`.
2. A path the user passed (design doc, scratchpad spec, session notes).
3. A Spec Kit feature spec under `specs/NNN-*/` or a PRD under `docs/`
   matching the branch/feature.
4. Nothing found → ask the user; if there is no spec, the Spec axis reports
   "no spec available" and is skipped.

If the spec lives outside the repo (a conversation, a plan), write it to a
scratch file first and hand the sub-agent the path — including an
**Amendments** section for decisions made after the original spec, so
deliberate deviations aren't re-flagged as drift.

**Adversarial prompt**: [ADVERSARIAL-PROMPT.md](ADVERSARIAL-PROMPT.md). Fill
the placeholders and pass it verbatim. It is model-agnostic by design: run it
on a general-purpose sub-agent by default, or dispatch it to any external
reviewer that accepts a prompt. Same prompt, any model.

**Cross-runner dispatch** — prefer sending the adversarial axis to the *other*
agent, so the review never comes from the model that wrote the change. One
bundled runner script per harness, same interface
(`[-C <worktree>] [-f "<focus>"] [-o <out.md>] [--dry-run] [<fixed-point>]`,
fixed point defaults to `main`, `--dry-run` prints the filled prompt):

- **→ Codex**: `.agents/skills/repo-review/scripts/adversarial-codex.sh` —
  `codex exec` in a read-only sandbox; needs the `codex` CLI logged in, no
  plugin required.
- **→ Claude Code**: `.agents/skills/repo-review/scripts/adversarial-claude.sh`
  — headless `claude -p`, read-only via a git-history allowlist plus
  disallowed edit tools.

Both are thin wrappers over `scripts/fill-adversarial-prompt.sh` (validates
the ref, fails on an empty diff, fills the template). To support another
harness, add one more runner that pipes the filled prompt in read-only mode.

Either direction, the caller still triages the verdict per step 4 — external
reviewers are adversarial, not verified.

## 3. Spawn all axes in parallel

One message, three sub-agent calls (general-purpose, read-only briefs). Every
brief includes: the exact diff command, the commit list, the worktree path, and
"make no edits".

- **Standards brief**: "Report — per file/hunk — every place the diff violates
  a documented standard. Cite the standard (file + rule). Distinguish hard
  violations from judgement calls. Skip tooling-enforced items. Under 400
  words."
- **Spec brief**: "Report: (a) requirements missing or partial; (b) behaviour
  not asked for (scope creep — check the spec's explicit non-goals); (c)
  requirements that look implemented but are subtly wrong. Quote the spec line
  per finding. Amendments are in spec; do not flag them. Under 400 words."
- **Adversarial brief**: the filled ADVERSARIAL-PROMPT.md, verbatim.

## 4. Aggregate

Present the three reports under `## Standards`, `## Spec`, `## Adversarial`
headings, verbatim or lightly cleaned. End with a one-line summary per axis
(finding count + worst item). Do not pick a single winner across axes.

Triage adversarial findings before acting: verify each against the code (they
are adversarial, not verified), and check whether a "regression" is actually
pre-existing on the fixed point — parity gaps carried over deliberately get
dispositioned, not silently fixed.

## 5. Convergence loop (when the goal is "review until clean")

1. Fix the findings worth fixing (verify each first); commit; run the full
   gate (`pnpm typecheck && pnpm check && pnpm test` — judge vitest by failure
   count, not exit code).
2. Re-run the **adversarial** axis only.
3. Repeat until it returns `approve` / no material findings. Adversarial
   reviewers rarely return zero forever — findings that are hedged
   ("verify that..."), pre-existing parity, or restatements of documented
   trade-offs count as "nothing worth fixing"; say so explicitly with
   evidence.
4. Finish with one last Standards + Spec pass (update the spec file's
   Amendments with every deliberate decision made during the loop first).
