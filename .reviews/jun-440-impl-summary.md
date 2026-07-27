# JUN-440 implementation summary

## What changed

- Added model-generated history summaries to both automatic pre-run compaction and manual compaction.
- Reused `RpcChatCompletionsModelProvider`, so summary inference crosses the reserved host tool and the existing metered June API route. No provider credentials or direct network path were added to the sidecar.
- Kept the bounded deterministic summary as the fallback for model errors, timeouts, and empty responses.
- Forwarded the selected model and the shared 8,192-token output reserve from Rust for manual compaction.
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
