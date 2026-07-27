# JUN-440 implementation summary

## What changed

- Added model-generated history summaries to both automatic pre-run compaction and manual compaction.
- Reused `RpcChatCompletionsModelProvider`, so summary inference crosses the reserved host tool and the existing metered June API route. No provider credentials or direct network path were added to the sidecar.
- Kept the bounded deterministic summary as the fallback for model errors, timeouts, and empty responses.
- Forwarded the selected model and a context-window-clamped output reserve from Rust for manual compaction.
- Added regressions for automatic and manual summarization, the reserved model-tool route, output-token propagation, and deterministic fallback.

## Why

Production callers previously omitted `compactHistory`'s optional summarizer, so compaction always produced truncated `role: text` output. The Rust manual path also omitted the output reserve used by the normal run path.

## Files

- `agent-runtime/src/compaction.ts`
- `agent-runtime/src/sdk-engine.ts`
- `agent-runtime/src/service.ts`
- `agent-runtime/src/types.ts`
- `agent-runtime/test/compaction.test.ts`
- `agent-runtime/test/service.test.ts`
- `src-tauri/src/agent_runtime/api.rs`

## Verification

- `pnpm agent-runtime:typecheck && pnpm agent-runtime:test && pnpm agent-runtime:build` - passed; 40 runtime tests.
- `NODE_OPTIONS=--no-experimental-webstorage pnpm test` - passed; 1,514 tests across 144 files.
- `pnpm typecheck` - passed.
- `pnpm check` - passed with no errors; existing repository warnings remain.
- `pnpm test:rust` - passed; 1,224 library tests passed, 5 ignored, and all integration suites passed.
- `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` - passed.
- `git diff --check` - passed.

No visual QA was needed because this changes runtime orchestration and request routing without changing UI. No June API deploy is required; the implementation uses the existing June API model route.

## Adversarial fix round

### Architecture and lifecycle

- Restored fast `run.start` acceptance. The sidecar now registers the active run and its abort controller before scheduling compaction, then performs summarization inside the accepted run lifecycle.
- Threaded the run `AbortSignal` through summary generation and the model RPC. Cancelling while summarization is active aborts the summary, skips `engine.start`, and emits `run.cancelled` without emitting `run.started`.
- Added a repository terminal-state guard so late runtime events cannot transition completed, cancelled, failed, or interrupted runs back to a non-terminal status. A late `run.started` is ignored before any compaction state is persisted or emitted.
- Added host-owned model scopes. Control-plane timeout and dispatch failures dispose the affected scope, cancel model requests that are still opening, and drop all registered streams.
- Gave manual `history.compact` a 120-second host timeout and a unique live stream scope. The scope is always disposed before the response is applied, and the repository is changed only after a successful response.

### Summary safety and bounds

- Persisted and replayed context summaries as user-role data. Runtime replay wraps every summary in an explicit untrusted-data message and escaped `<june_context_summary>` fence; model-authored summary text is never promoted to a system message.
- Marked every summary with `metadata.fallback`, logged deterministic fallback with a sanitized error type, and retained that metadata through Rust persistence and frontend events.
- Sized summarizer input at a conservative two characters per token with 25 percent context headroom, and clamped output to 2,048 tokens, the supplied model reserve, and one quarter of the known context window.
- Changed deterministic truncation to preserve the newest removed context. Summary streams now exist only under live run or one-shot compaction scopes and are disposed at terminal lifecycle boundaries.

### Fix-round regressions

- Added cancel-during-summarize coverage proving fast acceptance, signal propagation, no engine start, no `run.started`, and exactly one `run.cancelled`.
- Added exact host control-timeout coverage proving pending-response removal plus model-scope and cancellation-registration cleanup.
- Added repository coverage proving failed and cancelled runs cannot return to running.
- Added fallback metadata/logging and newest-content truncation coverage.
- Added model-request coverage proving context summaries are fenced user messages and closing-fence text is escaped.

### Fix-round verification

- `pnpm agent-runtime:typecheck && pnpm agent-runtime:test && pnpm agent-runtime:build` - passed; 42 runtime tests.
- `NODE_OPTIONS=--no-experimental-webstorage pnpm test` - passed; 1,514 tests across 144 files.
- `pnpm typecheck` - passed.
- `pnpm check` - passed with no errors; the existing 691 warnings and 2 informational diagnostics remain.
- `pnpm test:rust` - passed; 1,231 library tests passed, 5 ignored, and all native integration suites passed.
- Focused Rust host tests - passed; 9 tests.
- Focused Rust repository tests - passed; 2 tests.
- `cargo fmt --manifest-path src-tauri/Cargo.toml --check` and `git diff --check` - passed.

No visual QA was needed because this fix round changes runtime lifecycle, persistence, and transport behavior without changing UI. No June API deploy is required.

## Greptile round 1

### Manual compaction snapshot guard

- Captured the last item sequence from the exact history snapshot sent to the summary model.
- Added a guarded repository replacement for manual compaction. Its conditional no-op session update atomically checks that the session is not queued, running, or waiting for the user; that no queued, running, or waiting run exists; and that the latest item sequence still matches the model input snapshot.
- The conditional update acquires SQLite's write lock before source items are read or deleted, so a run start or history append cannot commit between validation and replacement.
- A mismatch rolls back without deleting or inserting any items and returns `agent_compact_conflict` with retry guidance. The one-shot summary stream scope is already disposed before this persistence check.
- Automatic run-lifecycle compaction keeps its existing replacement path because it intentionally persists while that accepted run is active.

### Greptile round 1 regressions

- Added a run-start race regression: snapshot idle history, start a run during the simulated summary interval, attempt the guarded replacement, and prove it reports a conflict with history byte-for-byte unchanged.
- Added an advanced-history regression proving an item appended after the snapshot also blocks summary persistence.
- Updated the successful metadata-persistence regression to exercise the guarded idle-snapshot path.

### Greptile round 1 verification

- Focused repository tests - passed; 4 tests.
- `pnpm test:rust` - passed; 1,233 library tests passed, 5 ignored, and all native integration suites passed.
- `cargo fmt --manifest-path src-tauri/Cargo.toml --check` and `git diff --check` - passed.
- Sidecar validation was not rerun because no sidecar protocol, type, or implementation file changed.

No visual QA was needed because this round changes only the atomic Rust persistence boundary. No June API deploy is required.
