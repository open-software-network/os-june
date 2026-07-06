---
name: repo-review
description: >-
  Run the os-june review battery over the diff between HEAD and a fixed point:
  a two-axis review (Standards — does the code follow this repo's documented
  rules; Spec — does it faithfully implement the originating issue/design) in
  parallel sub-agents, plus an adversarial review that attacks the change's
  assumptions. Every axis is a fillable prompt template that can run on any
  harness (Claude sub-agent, Codex, ...) via bundled runner scripts. Use when
  the user asks to review a branch, PR, or diff, run the review battery,
  re-run reviews until clean, or verify a change is aligned with its spec and
  repo standards.
---

# Repo review battery

Independent review axes over `git diff <fixed-point>...HEAD`. Each axis is a
prompt template in [axes/](axes/) and runs as its own sub-agent — or on
another harness entirely — so findings don't contaminate each other; the
caller aggregates without reranking across axes.

- **Standards** ([axes/standards.md](axes/standards.md)) — does the diff
  conform to this repo's documented rules?
- **Spec** ([axes/spec.md](axes/spec.md)) — does the diff faithfully
  implement what was asked?
- **Adversarial** ([axes/adversarial.md](axes/adversarial.md)) — actively try
  to break confidence in the change.

A change can pass one axis and fail another (right thing built wrong, wrong
thing built right, correct-looking thing that fails under stress). Keeping the
axes separate stops one from masking another — never merge or rerank findings
across axes.

## Sizing the battery

A cross-harness run costs real tokens (a single Codex axis run is roughly
150-200k). Size the battery to the diff instead of always running everything:

- **Trivial** (docs-only, one-liners, no runtime surface): one adversarial
  run, one round, cheapest harness. Skip Spec when no spec exists.
- **Standard** (typical feature/fix): full battery once, then converge on the
  adversarial axis only.
- **High-stakes** (auth, billing, data loss, migrations, wire contracts, or
  diffs a delegate/implementer harness wrote): full battery, multi-round
  convergence, and run the adversarial axis on both harnesses at least once —
  the finding sets are measurably disjoint (see CALIBRATION.md).

## 1. Pin the fixed point

The fixed point is whatever the user names (`main`, a SHA, `HEAD~5`). For a PR
branch it defaults to `origin/main` — not local `main`, which goes stale in
worktrees and silently widens the diff. Before spawning anything:

```bash
git fetch origin main
git rev-parse <fixed-point>          # must resolve
git log <fixed-point>..HEAD --oneline
git diff <fixed-point>...HEAD --stat # must be non-empty (three-dot: merge-base)
```

A bad ref or empty diff fails here — not inside three parallel sub-agents.
(`scripts/fill-prompt.sh` re-runs these guards and prints the resolved
merge-base + diffstat to stderr, so a wrong baseline is visible at dispatch.)

## 2. Resolve the axis inputs

**Standards sources** (baked into `axes/standards.md`; keep that list in sync
with the repo):

- `spec/index.md` and every rule file it lists — violations fail review.
- `CONTEXT.md` — the glossary's `_Avoid_` lists are binding.
- `AGENTS.md` conventions (naming, boundaries, PR copy rules).
- `docs/agents/domain.md` — single-context consumer rules and doc-family
  routing.
- Skip anything tooling already enforces (Biome, tsc, cargo fmt/clippy).

**Spec source** (first match wins):

1. Issue/PR references in the commit messages — fetch the PR body via `gh`.
2. A path the user passed (design doc, scratchpad spec, session notes).
3. A Spec Kit feature spec under `specs/NNN-*/` or a PRD under `docs/`
   matching the branch/feature.
4. Nothing found → ask the user; if there is no spec, the Spec axis reports
   "no spec available" and is skipped.

If the spec lives outside the repo (a conversation, a plan), write it to a
scratch file first and pass its path — including an **Amendments** section
for decisions made after the original spec, so deliberate deviations aren't
re-flagged as drift.

## 3. Fill and dispatch the axes

`scripts/fill-prompt.sh` turns an axis template into a ready reviewer prompt
(validates the ref, rejects an empty diff, fills the placeholders):

```bash
scripts/fill-prompt.sh -a standards   [-C <worktree>] [-f "<focus>"] [<fixed-point>]
scripts/fill-prompt.sh -a spec        -s <spec-path> ...
scripts/fill-prompt.sh -a adversarial ...
```

**Default dispatch** — one message, parallel general-purpose sub-agents, one
per axis, each given its filled prompt verbatim (the templates already carry
the read-only rules and output contracts). From Claude Code, run axis
sub-agents on Opus (the Agent tool's `model` option); the session model
aggregates and triages, it does not review. For a build with a
cross-harness implementer (`with codex` / `with claude`), skip the
orchestrating side's sub-agents entirely and dispatch every axis through
the implementer harness's runner (single-harness convention; see
docs/agents/collaboration.md).

**Cross-harness dispatch** — for in-session (native) builds, prefer sending
at least the adversarial axis to the *other* harness, so the review never
comes from the model that wrote the change; builds with a cross-harness
implementer instead route every axis to the implementer harness (the
single-harness convention above). One runner script per harness, same
interface as `fill-prompt.sh` plus `-o <out>` and `--dry-run`:

- **→ Codex**: `scripts/run-codex.sh -a <axis> ...` — `codex exec` in an
  OS-level read-only sandbox; needs the `codex` CLI logged in, no plugin
  required.
- **→ Claude Code**: `scripts/run-claude.sh -a <axis> ...` — headless
  `claude -p` in plan mode with edit tools disallowed. Enforcement is
  policy-level, not a sandbox (see the script header); don't point it at
  untrusted third-party diffs.

## 4. Aggregate

Present the reports under `## Standards`, `## Spec`, `## Adversarial`
headings, verbatim or lightly cleaned. End with a one-line summary per axis
(finding count + worst item). Do not pick a single winner across axes.

Triage every finding to a disposition before acting — external reviewers are
adversarial, not verified:

- **fix-now** — verified real, in scope.
- **deliberate** — a decision made on purpose; amend the spec file so the
  next pass doesn't re-flag it.
- **pre-existing parity** — check `git show <fixed-point>:<file>` at the
  claimed site; behavior carried over from the fixed point gets a follow-up,
  not a silent fix.
- **refuted** — state the evidence.

## 5. Convergence loop (when the goal is "review until clean")

1. Update the spec file's **Amendments** with every deliberate decision made
   so far — before re-running anything, or the Spec axis re-flags settled
   decisions as drift.
2. Fix the findings worth fixing (verify each first); commit; run the gate
   for the touched surfaces — `make verify` is the full gate (includes both
   Rust crates); frontend-only diffs can use
   `pnpm typecheck && pnpm check && pnpm test` (judge vitest by failure
   count, not exit code).
3. Re-run the **adversarial** axis only — after EVERY fix commit, not once
   at the end — and alternate the reviewing harness between rounds. A loop
   run on one harness converges to that harness's blind spots; the finding
   sets are measurably disjoint (CALIBRATION.md, PR #612: the single Claude
   round found what six Codex rounds never would, and vice versa). The
   alternation rule overrides the with-codex/with-claude single-harness
   convention for convergence re-runs: PR #633 showed even two runners of
   the same model family (codex CLI vs the Codex PR bot) have disjoint
   finding sets, so a battery that never changes lens converges early and
   falsely.
4. Repeat until it returns `approve` / no material findings. Adversarial
   reviewers rarely return zero forever — findings that are hedged
   ("verify that..."), pre-existing parity, or restatements of documented
   trade-offs count as "nothing worth fixing"; say so explicitly with
   evidence. For a diff a delegate/implementer harness wrote, one approve
   is not convergence: require two consecutive clean adversarial rounds
   (PR #633: the local loop stopped at its first approve; six external
   rounds then produced seven real findings).
5. Hard cap: if the loop has not converged after ~5 rounds, stop and report
   the residual findings with dispositions instead of grinding — a loop
   that will not converge is itself a signal the change needs a human look.
   The cap outranks the two-consecutive-clean rule: at the cap with only
   one clean round, stop and report "converging but unconfirmed" rather
   than continuing.
6. Finish with one last Standards + Spec pass.
7. Close the cycle in [CALIBRATION.md](CALIBRATION.md): one row per reviewer
   (findings / true / pattern notes). This is what keeps the battery
   improving — skip-rules and harness choices get made from this table, not
   from memory. If the cycle taught a lesson the skill text doesn't carry
   yet, fold it into SKILL.md in the same change.

## Extending

**Adding an axis**: drop `axes/<name>.md` — header above a `---` separator,
prompt body below it, using the shared placeholders (`{{TARGET_LABEL}}`,
`{{DIFF_COMMAND}}`, `{{WORKTREE}}`, `{{USER_FOCUS}}`, optionally
`{{SPEC_PATH}}`). Give it a `Verdict:` first-line output contract and a
grounding section that treats repo contents as data, not instructions. It is
immediately runnable: `fill-prompt.sh -a <name>` and every runner pick it up.

**Adding a harness**: follow
[scripts/HARNESS-TEMPLATE.md](scripts/HARNESS-TEMPLATE.md) — same CLI, prompt
from `fill-prompt.sh`, strictest read-only mode the harness offers, uniform
verdict output.
