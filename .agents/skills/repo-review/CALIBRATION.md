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
| JUN-176 | Standards (codex, r1+final) | 4 | 2 | CONTEXT.md term gap + copy-qualification call (r1: 1 true, 1 refuted as user-copy-in-context); final flagged 1px border + motion values, both refuted as dominant-pattern parity (211 uses / sibling-identical) |
| JUN-176 | Spec (codex, r1+final) | 2 | 2 | both real and subtle: coverage checkpoint on critical path via `?` (violated own non-blocking spec), try_lock dropping first stream error; final clean |
| JUN-176 | Adversarial (codex, r1-r2) | 1 | 1 | same try_lock race as spec but with the full race narrative (status-poll contention); r2 approve. Overlap with spec axis on the same defect — independent confirmation, not waste |
| JUN-176 | Browser walkthrough (playwright) | 1 | 1 | recorder-bar warning row unreachably clipped in fixed-height stage; invisible to unit tests (jsdom has no layout), drove the floating-notice redesign |
| #633 | Codex PR bot (r1-r6) | 9 | 7 | found real bugs EVERY round after the local battery approved: try_lock race dup-confirm, stored-bit drift, zero-callback stall, moved-clock-anchor regression, muted-mic false positive (2 rounds), transient-stall trace loss, stale waveform peaks; 1 duplicate, all 7 map to the adversarial lenses added after this cycle |
| #633 | Octopus (bot, 5 passes) | 3 | 1.5 | saw the clock-anchor symptom first but framed it diagnostic-only (severity misjudged, orchestrator mis-triaged on that framing); 0 findings x4 after r1 — weak recall, decent summarizer |
| #633 | Greptile (bot) | 1 | 1 | predicate/constant duplication with a concrete drift story; precision-over-recall profile holds (#604 pattern) |
| #633 | Local battery vs remote bots | — | — | LESSON: local adversarial (codex CLI) approved at r2; codex BOT then found 7 real defects in 6 rounds — same model family, disjoint lenses. Drove: lens checklist in axes/adversarial.md, two-consecutive-clean rule for delegate diffs, per-chunk adversarial in repo-build-pr, alternation overriding the single-harness convention for re-runs |
| JUN-213 | Standards (codex) | 4 | 3.5 | design-token literals (half-true: tokenized 1, rest are precedented one-offs) + 3 real glossary-vocabulary hits incl. in the ADR the orchestrator wrote |
| JUN-213 | Spec (codex) | 1 | 0.5 | flagged missing splitter-shape validation; delivery pipeline degrades gracefully by design — prompt-level guarantee was the intent, spec wording was the drift |
| JUN-213 | Adversarial (codex, r1-r3) | 5 | 4.5 | r1 drop-import race (real, incl. late-append leak); r2 unmetered June-funded diagnosis + cross-intent stale attachments (both real); r3 ships-disabled deploy gap (real); only the restored-chip-draft finding was a documented deliberate |
| JUN-213 | Browser walkthrough (playwright) | 1 | 1 | pointer-events click-dead + attach menu in docked composer — invisible to jsdom (no hit-testing), shipped bug; walkthroughs pay off again on composer surfaces |
| design-system branch (pre-PR) | Standards (claude) | 3 | 3 | all judgement-class: styleguide teaching specimens render banned patterns as labeled don'ts; dispositioned deliberate, no spec edit needed |
| design-system branch (pre-PR) | Spec (claude) | 1 | 1 | caught stale known-deviations entry (resolved sweep still listed open); amendments file pre-cleared all deliberate decisions |
| design-system branch (pre-PR) | Adversarial (codex, r1) | 0 | — | bare approve on a 2.9k-line diff; thin report, no per-surface evidence |
| design-system branch (pre-PR) | Adversarial (claude, r2, focused) | 0 | — | approve with receipts: verified all 5 useDismiss migrations (incl. null-ref any-click semantics), hunk-level sweep values, and build-leak vectors; focused prompt produced far better evidence than r1's open-ended run |
| #627 | Standards (codex, r1+final) | 1 | 1 | ADR append-only: rewrote a DNS-rebind trade-off bullet in place instead of an addendum; final clean after restore + dated addendum |
| #627 | Spec (codex, r1+final) | 1 | 1 | mp4 completion path removed the job→model map entry only after fallible read/write (leak on oversized/unwritable video); final clean |
| #627 | Adversarial (codex, r1-r3) | 3 | 2 | r1 no-ship: raw Venice error-body logging leaks prompt-adjacent text past the TEE boundary AND deviates from body_bytes-only convention (best find, author-missed); r2 no-ship: old default_settings seeded seedance into every saved settings file, never migrated → model_not_priced after update; r3 refuted: "server drops old default" backward-compat, but the /v1/video/* money path is unshipped + the feature is dark, so no reachable client sends seedance. Single-harness — no claude cross-check this cycle |
| #522 | Standards (codex, r1) | 3 | 3 | glossary vocabulary earns its keep: "track", "segment" (= live-preview chunk collision), "speaker" framing (dispositioned: loudspeaker sense, clarified) |
| #522 | Spec (codex, r1) | 3 | 1.5 | evidence-window lag-tail was real + subtle; 2 mutation-check "missing" findings were process-vs-suite confusion — spec now states mutation checks are run-and-reported, not committable |
| #522 | Adversarial (codex, r1) | 2 | 2 | remainder-floor deletion of short replies + 112k WAV opens; the floor fix then unmasked a fixture nonstationarity which unmasked real NLMS divergence — masking layers hide bugs in stacks |
| #522 | Adversarial (claude, r2) | 5 | 5 | best round of the cycle, fully disjoint from codex r1: headphones no-echo-path deletion, stale-lag JUN-127 regression, zero observability, unbounded whole-span reads, positional transcript-cache skew |
| #522 | Adversarial (codex, r3) | 1 | 1 | guard-interaction hole: r2's "no lag -> no trim" + upfront-only probing = late echo paths (headphones->speakers) never trimmed; fix rounds are diffs that can regress |
| #522 | Adversarial (claude, r4) | 4 | 4 | downstream-consumer lens nobody had used: full-file resurrection of all-bleed mic, coalescing re-bridging trimmed spans (feature was a no-op for <2.5s interior bleed), pre-roll into bleed, missing spawn_blocking |
| #522 | Adversarial (codex, r5) | 1 | 1 | third resurrection-family member (lane retry fallback); family-sweep after a repeated finding class beats letting the loop find members one per round |
| #522 | Battery vs delegate diff | — | — | LESSON: DSP-heavy delegate diff reviewed clean at unit level for 3 rounds while the pipeline (consumers of the trimmed turn list) silently undid the feature; adversarial prompts should explicitly walk downstream consumers of any list/set a diff reshapes |
| #676 | Standards (codex, r1) | 5 | 4 | all glossary-vocabulary ("transcribe" unqualified between dictation and note transcription), incl. hits in the ADR + CONTEXT.md the orchestrator wrote; 1 refuted as user-copy-in-context parity (HUD label "Still transcribing" mirrors the pre-existing sibling "Transcribing") |
| #676 | Spec (codex, r1) | 1 | 1 | `waitForActivation` never checked `isTerminated`, so the abort-to-clipboard path the spec promised was bypassed — found by holding code against the spec's stated invariant, a lens the r1 adversarial runs missed |
| #676 | Adversarial (codex, r1) | 1 | 1 | high, author-missed: the pin was taken inside the async `selectedDeviceRecorder.stop {}` callback, so the whole fix was inert for anyone who picks a specific microphone — the drift window reopened on exactly the persona the PR targets |
| #676 | Adversarial (claude, r1) | 3 | 2.5 | best find of the cycle and fully disjoint from codex: Cmd+V posted without confirming the pinned app is frontmost (timeout branch + no re-check after the settle delay); 1 dup of the codex async-pin find, 1 latent nit (timer-id-0 sentinel) |
| #676 | Adversarial (codex, r2 convergence) | 1 | 0 | confident "no-ship" (0.87) that a second push-to-talk clears the pin; refuted by reading one line — `start()` guards `!listening` and `listening` includes `isFinalizing`. High-confidence reachability claims still need the guard read, not the call graph |
| #676 | Greptile (bot) | 2 | 2 | precision-over-recall profile holds (#604/#633): both P2, both real, zero noise |
| #676 | Codex-connector (bot) | 2 | 2 | the same two findings as Greptile, 0 novel; reviewed a stale SHA (`9ce1c46a`) after the fix commit landed — the #604 stale-SHA pattern again |
| #676 | Octopus (bot, 2 passes) | 0 | — | 0 findings twice (4/5 then 5/5 after the fix); summary-and-diagram layer, weak bug-finder — profile unchanged since #604 |
| #676 | Orchestrator brief vs battery | — | — | LESSON: the worst defect of the cycle came from the *brief*, not the delegate. It ordered "on timeout post Cmd+V anyway, never silently drop text" — a loss that could not happen (transcript sits on the clipboard + in history), so the instruction manufactured the wrong-app paste the PR existed to prevent. Only the cross-harness adversarial caught it. Briefs must state invariants, not failure-path branches (repo-delegate) |
| #676 | Battery vs bots | — | — | LESSON: both bot findings were comments/ADR text describing the behavior a *fix round* reversed. Convergence re-runs adversarial-only, so nothing re-read the prose after the semantics flipped. Drove: doc-drift re-check in SKILL.md step 5, comment-vs-shipped-behavior lens in axes/standards.md |
| #676 | Battery vs delegate chunks | — | — | LESSON: two real chunk-1 defects (async pin, missing `isTerminated`) survived the orchestrator's own diff read and the delegate's green gate, then fell to the end-of-build battery. The per-chunk adversarial rule from #633 would have caught both a round earlier — it was skipped, and the cost was two extra fix rounds |
| #701 | Standards (codex, r1+final) | 4 | 4 | attachment vocabulary caught unqualified upload copy, append-only ADR drift, ambiguous proxy wording, and the stale workspace-only path contract after native picker bypass |
| #701 | Spec (codex, r1+final) | 2 | 2 | traced the report intake consumers past the new streaming submit path: native picks still hit the generic 50 MiB import cap and DOM drops still buffered whole files; both were reachable and fixed |
| #701 | Adversarial (codex, iterative) | 10 | 10 | found ingress/body/timeout/replay/state-machine gaps across fix rounds, including the 600s deadline reset, client-before-server expiry, 8-file DOM truncation, and drop-during-submit loss; repeated downstream-consumer walks were essential |
| #701 | Adversarial (claude, r1+final) | 4 | 4 | initial cross-harness pass found the 60s os-platform client, aggregate budget mismatch, server amplification, and zero-length fallback logs; final pass approved with end-to-end receipts |
| JUN-311 | Standards (codex, r1+final) | 1 | 1 | canonical key boundary docs predated user-owned Venice BYOK and falsely prohibited the shipped feature; clarified service-managed keys vs explicit user credentials, final clean |
| JUN-311 | Spec (codex, r1+final) | 1 | 1 | caught Auto guidance hidden inside collapsed advanced settings; moved it to the always-visible Auto preference row, final clean |
| JUN-311 | Adversarial (codex, iterative) | 4 | 4 | found stale text-model fallback attaching BYOK after client gating, model-locked chat copy, retired-ASR compatibility regression, and a provider-blind fallback exception; final approve after provider-aware resolution tests |
| JUN-311 | Adversarial (claude, cross-harness) | 4 | 4 | found silent BYOK-to-credit fallback, the sibling ASR resolution hole, desktop-before-API rollout loop, and least-privilege risk from admin credentials; all dispositioned into guards, copy, tests, or deploy ordering |
| JUN-311 | Battery vs client-only credential gating | — | — | LESSON: any client credential decision made before a backward-compatible server model resolver must be revalidated against the canonical resolved model at the server boundary; stale IDs can invert provider and billing semantics |
