# Onboarding Survey Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the onboarding discovery-source answer to scribe-api exactly once without blocking onboarding.

**Architecture:** Add a small authenticated JSON endpoint to scribe-api, backed by a `SurveySink` trait with webhook and structured-log providers. The desktop app exposes a Tauri command that posts to the endpoint, and the frontend reports from the existing `setDiscoverySource` seam with a retry-on-launch flag.

**Tech Stack:** Rust, axum, reqwest, Tauri commands, TypeScript, React, Vitest.

---

### Task 1: scribe-api survey endpoint

**Files:**
- Modify: `scribe-api/crates/domain/src/lib.rs`
- Create: `scribe-api/crates/api/src/handlers/surveys.rs`
- Modify: `scribe-api/crates/api/src/handlers/mod.rs`
- Modify: `scribe-api/crates/api/src/lib.rs`
- Modify: `scribe-api/crates/api/src/state.rs`
- Modify: `scribe-api/crates/api/tests/http_boundary.rs`

- [x] Write failing boundary tests for auth, slug validation, and sink delivery.
- [x] Add domain `OnboardingSurvey`, `OnboardingSurveySource`, and `SurveySink`.
- [x] Add `POST /v1/onboarding-surveys` with `ApiResponse<{ received: true }>` and JSON body limit.
- [x] Wire `SurveySink` through `ApiState`.
- [x] Run `cargo test --manifest-path scribe-api/Cargo.toml -p scribe-api --test http_boundary onboarding_survey`.

### Task 2: scribe-api survey providers

**Files:**
- Modify: `scribe-api/crates/config/src/lib.rs`
- Create: `scribe-api/crates/providers/src/surveys.rs`
- Modify: `scribe-api/crates/providers/src/lib.rs`
- Modify: `scribe-api/crates/app/src/main.rs`
- Modify: `scribe-api/config.toml`

- [x] Add `[surveys] webhook_url` config with redacted debug output.
- [x] Add webhook sink that POSTs the survey JSON.
- [x] Add log sink fallback with structured `survey source=<slug> app_version=<v> user=<id>` fields.
- [x] Wire app startup to choose webhook else log sink.
- [x] Run provider tests for webhook configured, webhook success, webhook rejection, and log fallback construction.

### Task 3: desktop command and frontend reporting

**Files:**
- Modify: `src-tauri/src/domain/types.rs`
- Modify: `src-tauri/src/scribe_api.rs`
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src/lib/tauri.ts`
- Modify: `src/lib/onboarding.ts`
- Modify: `src/main.tsx`
- Modify: `src/test/onboarding.test.tsx`

- [x] Add `submit_discovery_source` Tauri command that posts `{ source, appVersion, platform }`.
- [x] Add TypeScript `submitDiscoverySource`.
- [x] Report best effort from `setDiscoverySource`, setting `june.onboarding.discoveryReported` only after success.
- [x] Retry once on launch when a source exists without the reported flag.
- [x] Preserve dev replay behavior by clearing the reported flag together with the source.
- [x] Run onboarding tests for exactly-once success and offline retry.

### Task 4: PR review accessibility fix and verification

**Files:**
- Modify: `src/components/ui/Select.tsx`

- [x] Add `role="presentation"` to `Select` list item wrappers.
- [x] Run focused frontend, scribe-api, and Rust/Tauri checks.
