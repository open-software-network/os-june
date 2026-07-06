# Reviewer calibration log

Append-only. One row per reviewer per review cycle, added when the cycle
closes (SKILL.md step 5). "True" counts findings that survived verification
(fix-now or deliberate-with-amendment); restatements of already-documented
trade-offs count as true but note them. Use this to make triage skip-rules
data-driven: discount reviewer patterns with a bad true/findings ratio
(e.g. hedged "verify that..." phrasing), trust patterns with a good one.

| PR | Reviewer | Findings | True | Notes |
|---|---|---|---|---|
| #604 | 27-agent /code-review workflow | 10 | 10 | verify pass pre-refuted 1 of 22 candidates; the verify stage is what made it trustworthy |
| #604 | Codex-connector (bot) | 2 | 2 | quiet best bot, inline |
| #604 | Greptile (bot) | 1 | 1 | perfect precision, low recall; caught a copy regression everything else missed |
| #604 | Octopus (bot) | 3 | ~0-1 | hedged "verify that..." phrasing, 2 false positives, stale reviewed-SHA; summary layer, weak bug-finder |
| #604 | Adversarial loop r1-r2 (codex) | 4 | 3.5 | several PR-comment findings were main-parity, not regressions — parity-check everything |
| #612 | Standards (codex) | 0 | — | clean verdict but missed the 2 real findings claude-standards caught: recall gap |
| #612 | Standards (claude) | 2 | 2 | full-gate mislabel + citation to a nonexistent rule; grep-verified |
| #612 | Spec (codex, r1+final) | 3 | 3 | marker-order drift, template-skeleton drift, allowlist-vs-spec wording (1 amended as deliberate) |
| #612 | Spec (claude) | 0 | — | clean verdict, verified all 11 amendments individually, but missed the marker drift codex caught |
| #612 | Adversarial (codex, 6 rounds) | 9 | 8 | steady 1-2/round narrowing; r6 was a restatement of a documented trade-off (loop exit); high precision, incremental depth |
| #612 | Adversarial (claude, 1 round) | 4 | 4 | best single run of the cycle: bash 5.2 patsub, allowlist≠sandbox, git --output writes, sink drift; also reproduced the bash 3.2 crash live |
| #615 | Standards (claude, r1+final) | 0 | — | clean twice; pre-cleared the get_meeting_note "meeting" naming call with entity-scoped reasoning |
| #615 | Spec (claude, r1+final) | 0 | — | clean twice; individually verified amendments A1-A12 incl. the superseded-constraint trail |
| #615 | Adversarial (claude, r1-r4) | 8 | 7 | found transcript scan-order + WHERE-divergence + draft-degrade chain; 1 deliberate (token-is-reference, ADR'd); r4 approve |
| #615 | Adversarial (codex, r4-r6) | 2 | 2 | both high-value and missed by 4 claude rounds (search predicate on suppressed rows; cleared note body resurrection) — disjoint-blind-spots confirmed again; r6 approve |
| #615 | Browser walkthrough (playwright) | 1 | 1 | @-trigger prefix bug invisible to jsdom (needed composed state); walkthroughs earn their cost on composer features |
| #633 | Codex PR bot (r1-r6) | 9 | 7 | found real bugs EVERY round after the local battery approved: try_lock race dup-confirm, stored-bit drift, zero-callback stall, moved-clock-anchor regression, muted-mic false positive (2 rounds), transient-stall trace loss, stale waveform peaks; 1 duplicate, all 7 map to the adversarial lenses added after this cycle |
| #633 | Octopus (bot, 5 passes) | 3 | 1.5 | saw the clock-anchor symptom first but framed it diagnostic-only (severity misjudged, orchestrator mis-triaged on that framing); 0 findings x4 after r1 — weak recall, decent summarizer |
| #633 | Greptile (bot) | 1 | 1 | predicate/constant duplication with a concrete drift story; precision-over-recall profile holds (#604 pattern) |
| #633 | Local battery vs remote bots | — | — | LESSON: local adversarial (codex CLI) approved at r2; codex BOT then found 7 real defects in 6 rounds — same model family, disjoint lenses. Drove: lens checklist in axes/adversarial.md, two-consecutive-clean rule for delegate diffs, per-chunk adversarial in repo-build-pr, alternation overriding the single-harness convention for re-runs |
| JUN-213 | Standards (codex) | 4 | 3.5 | design-token literals (half-true: tokenized 1, rest are precedented one-offs) + 3 real glossary-vocabulary hits incl. in the ADR the orchestrator wrote |
| JUN-213 | Spec (codex) | 1 | 0.5 | flagged missing splitter-shape validation; delivery pipeline degrades gracefully by design — prompt-level guarantee was the intent, spec wording was the drift |
| JUN-213 | Adversarial (codex, r1-r3) | 5 | 4.5 | r1 drop-import race (real, incl. late-append leak); r2 unmetered June-funded diagnosis + cross-intent stale attachments (both real); r3 ships-disabled deploy gap (real); only the restored-chip-draft finding was a documented deliberate |
| JUN-213 | Browser walkthrough (playwright) | 1 | 1 | pointer-events click-dead + attach menu in docked composer — invisible to jsdom (no hit-testing), shipped bug; walkthroughs pay off again on composer surfaces |
