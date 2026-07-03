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
