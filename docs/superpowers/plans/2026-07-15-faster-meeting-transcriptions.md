# Faster Meeting Transcriptions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce the time from pressing Done to the first saved meeting transcript turn and to transcription completion, with reproducible before/after evidence and no transcription-quality or fallback regression.

**Architecture:** Keep the existing saved-audio, source-separated pipeline and provider concurrency of two. Replace eager full-source fallback normalization and the prepare-everything wall with lightweight turn descriptors, one ordered blocking preparation producer, a capacity-two channel, and a context-preserving async consumer; record Done-relative events without putting database writes on the provider-request critical path. A command-layer ignored benchmark exercises real WAV DSP and SQLite persistence against a loopback June API and is overlaid unchanged on the production baseline before any production refactor.

**Tech Stack:** Rust 2021, Tokio (`spawn_blocking`, `mpsc`, `JoinSet`), hound WAV fixtures, SQLx SQLite, Tauri command layer, React 18, Vitest, Testing Library, pnpm.

## Global Constraints

- Optimize the normal Done path for microphone-plus-system meetings; keep microphone-only as a measured control.
- Final transcription must continue to use finalized, validated saved audio. Never promote live preview text.
- Keep microphone and system sources separate and preserve chronological final output.
- Keep provider concurrency at exactly `DEFAULT_TURN_TRANSCRIPTION_CONCURRENCY == 2`.
- Keep the prepared-turn channel capacity at exactly two.
- Keep retries, cleanup inference, dictionary and completed-turn context, operation IDs, source attribution, partial persistence, coverage, billing, and generation inputs semantically unchanged.
- A source touched by echo trimming must never use its raw complete-source fallback.
- Bounds-matched cached successful turns must continue to suppress duplicate transcription and fallback.
- Do not add a dependency, migration, June API endpoint, API field, model change, or ADR.
- Do not change production React components; the current one-second poll and partial-turn UI are correct and need regression coverage only.
- Never log transcript text, audio bytes, note titles, generated content, bearer tokens, or other user content in latency telemetry.
- New latency checkpoints are diagnostic and best-effort: a checkpoint write failure must log a warning and must not fail transcription.
- The benchmark begins at post-finalization handoff. Production telemetry begins at the actual `finish_recording` command entry. Never present those origins as the same measurement.
- The production refactor is blocked unless the five-minute baseline median `turn_wav_extraction.durationMs` is at least 20% of median handoff-to-first-request time.
- After the refactor, the five-minute median handoff-to-first-committed-turn must improve by at least 20% and median handoff-to-transcription-complete must improve by at least 10%; the microphone-only control must not regress by more than 5%.
- Do not weaken those thresholds after measuring.

---

## File responsibility map

- Modify `src-tauri/src/domain/processing.rs`: own Done-relative timing values, descriptor and fallback-plan types, preparation functions, the blocking producer, the context-preserving streaming scheduler, lazy fallback, temp-directory lifetime, native deterministic tests, and processing checkpoints.
- Modify `src-tauri/src/commands.rs`: capture the real Done origin before repository lookup, preserve the existing three-argument benchmark seam, propagate tracked or untracked timing, record queue acquisition, and declare the test-only benchmark child module.
- Create `src-tauri/src/commands/transcription_benchmark.rs`: own synthetic WAV generation, isolated SQLite setup, loopback June API, command-layer ignored benchmark, sample collection, medians, and JSON output. This file must compile against both the feature branch and `06f4925e` when applied as a test-only overlay.
- Create `src-tauri/src/commands/transcription_timing_tests.rs`: own the non-ignored command-layer test that proves actual Done-relative checkpoints are single-shot and monotonic without changing the baseline benchmark module after its overlay commit.
- Modify `src/test/app-notes-reliability.test.tsx`: prove the one-second selected-note poll renders a newly persisted source turn while the note remains Transcribing.
- Modify `Makefile`: expose the exact release benchmark invocation as `benchmark-transcription-latency`.
- Create `docs/qa/jun-334-transcription-latency.md`: record baseline identity, overlay identity, machine context, raw benchmark JSON, medians, gate calculations, structural proof, UI bound, and after results.
- Modify `docs/index.md`: index the new QA evidence document.
- Do not modify `src-tauri/src/audio/turns.rs`, `src/components/note-editor/NoteEditor.tsx`, `src/app/App.tsx`, or `june-api/`; existing primitives and contracts are sufficient.

## Mandatory execution gates

1. Commit this plan and complete an independent applicability audit before Task 1.
2. Task 1 creates only test/benchmark/docs plumbing. Run it on `06f4925e` plus that exact test-only commit.
3. Stop before Task 2 if the five-minute preparation-wall ratio is below 20%. Revise the approved design around the measured bottleneck instead of continuing.
4. Do not claim success or open the PR until Task 7 meets the locked post-change thresholds and Task 8 is green.

---

### Task 1: Add the unchanged command-layer benchmark and capture the baseline

**Files:**

- Create: `src-tauri/src/commands/transcription_benchmark.rs`
- Modify: `src-tauri/src/commands.rs` (immediately before the existing `#[cfg(test)] mod tests`)
- Modify: `Makefile` (next to other Rust test targets)

**Interfaces:**

- Consumes: existing private `finish_recording_session(&Repositories, FinishedRecording, Instant) -> Result<FinishRecordingResponse, AppError>`.
- Produces: ignored test `commands::transcription_benchmark::benchmark_post_finalization_meeting_latency` and lines prefixed `JUN334_BENCHMARK ` containing serialized `BenchmarkSample` values.
- Produces: Make target `benchmark-transcription-latency`.

- [ ] **Step 1: Declare the child benchmark module and verify the empty module fails**

Add this immediately before `#[cfg(test)] mod tests` in `src-tauri/src/commands.rs`:

```rust
#[cfg(test)]
mod transcription_benchmark;
```

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml --locked --no-run
```

Expected: FAIL with Rust error `file not found for module transcription_benchmark`.

- [ ] **Step 2: Create the benchmark data contract and isolated test environment**

Create `src-tauri/src/commands/transcription_benchmark.rs` with these concrete contracts at the top:

```rust
use super::finish_recording_session;
use crate::{
    audio::capture::{FinishedRecording, FinishedSource},
    db::{migrations::run_migrations, repositories::Repositories},
    domain::types::{
        AudioLevelDto, ProcessingStatus, RecordingSessionDto, RecordingSource,
        RecordingSourceMode, RecordingState,
    },
};
use serde::Serialize;
use sqlx::row::Row;
use sqlx_sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use std::{
    collections::HashMap,
    net::SocketAddr,
    path::{Path, PathBuf},
    str::FromStr,
    sync::{Arc, LazyLock, Mutex, OnceLock},
    time::{Duration, Instant},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::Notify,
};

const WARMUP_RUNS: usize = 1;
const MEASURED_RUNS: usize = 5;

#[derive(Clone, Copy)]
struct BenchmarkCase {
    name: &'static str,
    duration_minutes: u32,
    source_mode: RecordingSourceMode,
}

const CASES: [BenchmarkCase; 4] = [
    BenchmarkCase { name: "dual-1m", duration_minutes: 1, source_mode: RecordingSourceMode::MicrophonePlusSystem },
    BenchmarkCase { name: "dual-5m", duration_minutes: 5, source_mode: RecordingSourceMode::MicrophonePlusSystem },
    BenchmarkCase { name: "dual-10m", duration_minutes: 10, source_mode: RecordingSourceMode::MicrophonePlusSystem },
    BenchmarkCase { name: "mic-5m-control", duration_minutes: 5, source_mode: RecordingSourceMode::MicrophoneOnly },
];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BenchmarkSample {
    revision_label: String,
    case: String,
    iteration: usize,
    handoff_to_validation_ms: i64,
    handoff_to_dequeued_ms: i64,
    handoff_to_detection_complete_ms: Option<i64>,
    detection_duration_ms: Option<i64>,
    turn_wav_extraction_duration_ms: Option<i64>,
    active_preparation_duration_ms: Option<i64>,
    producer_wall_duration_ms: Option<i64>,
    handoff_to_first_request_ms: i64,
    handoff_to_first_persisted_ms: i64,
    handoff_to_transcription_complete_ms: i64,
    handoff_to_ready_ms: i64,
}

#[derive(Clone, Default)]
pub(super) struct BenchmarkClock {
    origin: Arc<OnceLock<Instant>>,
}

impl BenchmarkClock {
    pub(super) fn start(&self) {
        self.origin.set(Instant::now()).expect("benchmark clock starts once");
    }

    pub(super) fn elapsed_ms(&self) -> i64 {
        self.origin
            .get()
            .expect("benchmark clock started")
            .elapsed()
            .as_millis()
            .min(i64::MAX as u128) as i64
    }
}

#[derive(Clone)]
pub(super) struct RequestEvents {
    clock: BenchmarkClock,
    first_transcription_ms: Arc<Mutex<Option<i64>>>,
    first_generation_ms: Arc<Mutex<Option<i64>>>,
    changed: Arc<Notify>,
}

impl RequestEvents {
    pub(super) fn new(clock: BenchmarkClock) -> Self {
        Self {
            clock,
            first_transcription_ms: Arc::new(Mutex::new(None)),
            first_generation_ms: Arc::new(Mutex::new(None)),
            changed: Arc::new(Notify::new()),
        }
    }

    fn record(&self, path: &str) {
        let slot = match path {
            "/v1/notes/transcribe" => Some(&self.first_transcription_ms),
            "/v1/notes/generate" => Some(&self.first_generation_ms),
            _ => None,
        };
        if let Some(slot) = slot {
            let mut value = slot.lock().expect("request event mutex");
            if value.is_none() {
                *value = Some(self.clock.elapsed_ms());
                self.changed.notify_waiters();
            }
        }
    }
}

#[derive(Clone)]
struct BenchmarkObserver {
    clock: BenchmarkClock,
    dequeued_ms: Arc<Mutex<Option<i64>>>,
}

static BENCHMARK_OBSERVERS: LazyLock<Mutex<HashMap<String, BenchmarkObserver>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn register_benchmark_observer(session_id: &str, observer: BenchmarkObserver) {
    BENCHMARK_OBSERVERS
        .lock()
        .expect("benchmark observer mutex")
        .insert(session_id.to_string(), observer);
}

pub(super) fn record_processing_dequeued(session_id: &str) {
    let observer = BENCHMARK_OBSERVERS
        .lock()
        .expect("benchmark observer mutex")
        .get(session_id)
        .cloned();
    if let Some(observer) = observer {
        let mut value = observer.dequeued_ms.lock().expect("dequeue event mutex");
        if value.is_none() {
            *value = Some(observer.clock.elapsed_ms());
        }
    }
}

fn remove_benchmark_observer(session_id: &str) {
    BENCHMARK_OBSERVERS
        .lock()
        .expect("benchmark observer mutex")
        .remove(session_id);
}
```

In `commands.rs`, immediately after `let _guard = queue_lock.lock().await;`, add the baseline-compatible test-only observation seam:

```rust
#[cfg(test)]
transcription_benchmark::record_processing_dequeued(&task_session_id);
```

The hook is compiled only in tests, performs no work unless the exact benchmark registered that session, and is included in the benchmark-only commit applied to both revisions.

Use a file-backed database, not `sqlite::memory:`:

```rust
pub(super) async fn benchmark_repositories(dir: &tempfile::TempDir) -> Repositories {
    let database_path = dir.path().join("june-benchmark.sqlite3");
    let options = SqliteConnectOptions::from_str(&format!(
        "sqlite://{}",
        database_path.display()
    ))
    .expect("SQLite options")
    .create_if_missing(true);
    let pool = SqlitePoolOptions::new()
        .max_connections(5)
        .connect_with(options)
        .await
        .expect("benchmark database");
    run_migrations(&pool).await.expect("benchmark migrations");
    Repositories::new(pool)
}
```

- [ ] **Step 3: Add deterministic WAV fixtures outside the timed region**

Add these fixture helpers. The 12-second cycle gives each source a distinct, non-overlapping three-second signal and leaves real silence between signals; the different frequencies avoid manufacturing correlated echo.

```rust
fn write_benchmark_wav(path: &Path, minutes: u32, source: RecordingSource) {
    let spec = hound::WavSpec {
        channels: 2,
        sample_rate: 48_000,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut writer = hound::WavWriter::create(path, spec).expect("create benchmark WAV");
    let frames = u64::from(minutes) * 60 * u64::from(spec.sample_rate);
    let frequency = match source {
        RecordingSource::Microphone => 311.0_f32,
        RecordingSource::System => 577.0_f32,
    };
    for frame in 0..frames {
        let cycle_second = (frame / u64::from(spec.sample_rate)) % 12;
        let active = match source {
            RecordingSource::Microphone => cycle_second < 3,
            RecordingSource::System => (6..9).contains(&cycle_second),
        };
        let sample = if active {
            let phase = frame as f32 * frequency * std::f32::consts::TAU
                / spec.sample_rate as f32;
            (phase.sin() * 8_000.0) as i16
        } else {
            0_i16
        };
        writer.write_sample(sample).expect("left sample");
        writer.write_sample(sample).expect("right sample");
    }
    writer.finalize().expect("finalize benchmark WAV");
}

fn prepare_case_fixtures(root: &Path, case: BenchmarkCase) -> Vec<(RecordingSource, PathBuf)> {
    let microphone = root.join(format!("{}-microphone.wav", case.name));
    write_benchmark_wav(&microphone, case.duration_minutes, RecordingSource::Microphone);
    let mut fixtures = vec![(RecordingSource::Microphone, microphone)];
    if case.source_mode == RecordingSourceMode::MicrophonePlusSystem {
        let system = root.join(format!("{}-system.wav", case.name));
        write_benchmark_wav(&system, case.duration_minutes, RecordingSource::System);
        fixtures.push((RecordingSource::System, system));
    }
    fixtures
}
```

- [ ] **Step 4: Add the loopback June API**

Implement the server with `TcpListener`. It must record transcription arrival before draining the multipart body, drain exactly `Content-Length`, handle connections concurrently, and close each response:

```rust
async fn read_http_request(
    stream: &mut TcpStream,
    events: &RequestEvents,
) -> (String, Vec<u8>) {
    let mut bytes = Vec::new();
    let header_end = loop {
        let mut chunk = [0_u8; 8_192];
        let read = stream.read(&mut chunk).await.expect("read request");
        assert!(read > 0, "connection closed before headers");
        bytes.extend_from_slice(&chunk[..read]);
        if let Some(index) = bytes.windows(4).position(|window| window == b"\r\n\r\n") {
            break index + 4;
        }
    };
    let headers = String::from_utf8_lossy(&bytes[..header_end]);
    let path = headers
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .expect("request path")
        .to_string();
    let content_length = headers
        .lines()
        .find_map(|line| {
            let (name, value) = line.split_once(':')?;
            name.eq_ignore_ascii_case("content-length")
                .then(|| value.trim().parse::<usize>().expect("content length"))
        })
        .unwrap_or(0);
    events.record(&path);
    while bytes.len() - header_end < content_length {
        let mut chunk = [0_u8; 32_768];
        let read = stream.read(&mut chunk).await.expect("read request body");
        assert!(read > 0, "connection closed before request body");
        bytes.extend_from_slice(&chunk[..read]);
    }
    (path, bytes[header_end..header_end + content_length].to_vec())
}

async fn handle_fake_request(mut stream: TcpStream, events: RequestEvents) {
    let (path, _body) = read_http_request(&mut stream, &events).await;
    let (delay, body) = match path.as_str() {
        "/v1/notes/transcribe" => (
            Duration::from_millis(100),
            r#"{"success":true,"data":{"text":"benchmark transcript","language":"en","provider":"benchmark"}}"#,
        ),
        "/v1/dictate/cleanup" => (
            Duration::from_millis(25),
            r#"{"success":true,"data":{"text":"benchmark transcript"}}"#,
        ),
        "/v1/notes/generate" => (
            Duration::ZERO,
            r#"{"success":true,"data":{"content":"Benchmark note","titleSuggestion":null,"provider":"benchmark","promptVersion":"notes-mvp-v5"}}"#,
        ),
        _ => panic!("unexpected benchmark route: {path}"),
    };
    tokio::time::sleep(delay).await;
    let response = format!(
        "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
        body.len(),
        body
    );
    stream.write_all(response.as_bytes()).await.expect("write response");
    stream.shutdown().await.expect("close response");
}

pub(super) async fn spawn_fake_june_api(
    events: RequestEvents,
) -> (SocketAddr, tokio::task::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind loopback API");
    let address = listener.local_addr().expect("loopback address");
    let handle = tokio::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            tokio::spawn(handle_fake_request(stream, events.clone()));
        }
    });
    (address, handle)
}
```

- [ ] **Step 5: Add one measured command-layer iteration**

The iteration must create a note, recording session, pending artifacts, and public-field `FinishedRecording`; spawn the loopback server; set `JUNE_API_URL` to that server; register `BenchmarkObserver`; and start `BenchmarkClock` immediately before the existing three-argument `finish_recording_session` call. The server and observer are ready before `clock.start()`, so bind/setup time is not included in handoff latency.

Use a case-scaled hard timeout rather than a performance assertion disguised as a 30-second timeout:

```rust
fn benchmark_timeout(case: BenchmarkCase) -> Duration {
    Duration::from_secs(180 + u64::from(case.duration_minutes) * 120)
}
```

This allows 5 minutes for `dual-1m`, 13 minutes for each five-minute case, and 23 minutes for `dual-10m`. A timeout still catches a deadlock, while slow real DSP on a loaded machine does not become a false product failure.

Start a concurrent database observer before `finish_recording_session`. On a five-millisecond interval, use one read transaction to check for `audio_validation`, `turn_detection`, and `turn_wav_extraction` checkpoint rows, a successful transcript row, and the note's terminal status. Record `clock.elapsed_ms()` the first time each committed row becomes queryable. Query first committed persistence through the artifact join so microphone-only works:

```sql
SELECT EXISTS(
  SELECT 1
FROM transcripts t
JOIN audio_artifacts a ON a.id = t.audio_artifact_id
WHERE a.recording_session_id = ?
  AND t.status = 'succeeded'
)
AS present
```

Read checkpoint details with:

```sql
SELECT kind, details
FROM recording_checkpoints
WHERE recording_session_id = ?
ORDER BY created_at ASC, rowid ASC
```

Do not derive native availability from `transcripts.created_at`: the repository assigns it before awaiting the upsert. The observer timestamp is taken only after another SQLite query can see the committed row, and every target interval therefore uses the same monotonic `BenchmarkClock` as loopback request arrival.

After the observer sees Ready, collect `handoff_to_dequeued_ms` from the registered test-only hook, abort and await the loopback accept task, and remove the observer registration. Treat Failed as an immediate test failure containing only the error code/status, not note content. Set `handoff_to_transcription_complete_ms` from the first `/v1/notes/generate` arrival, not Ready.

Parse these stage fields from checkpoint JSON:

```rust
let turn_wav_extraction_duration_ms = details["durationMs"].as_i64();
let active_preparation_duration_ms = details["activePreparationDurationMs"].as_i64();
let producer_wall_duration_ms = details["producerWallDurationMs"].as_i64();
```

Baseline has only `durationMs`; feature benchmark samples add active preparation and producer-wall fields. They are intentionally not treated as interchangeable. `doneToPreparationCompleteMs` belongs only to tracked production Done telemetry; the unchanged benchmark uses the untracked three-argument seam and must not claim that field. The pre-change gate uses the existing synchronous extraction-stage duration:

```rust
let preparation_wall_ratio = sample
    .turn_wav_extraction_duration_ms
    .expect("dual-source extraction checkpoint") as f64
    / sample.handoff_to_first_request_ms.max(1) as f64;
```

- [ ] **Step 6: Add the ignored warm-up/median driver**

Use this exact test shape. Fixture generation occurs before the timed iteration loop, environment values are restored at the end, and no wall-clock threshold is asserted inside the test:

```rust
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "release-only JUN-334 benchmark"]
async fn benchmark_post_finalization_meeting_latency() {
    let revision_label = std::env::var("JUN334_REVISION_LABEL")
        .unwrap_or_else(|_| "unlabeled".to_string());
    let root = tempfile::tempdir().expect("benchmark tempdir");
    let fixtures = CASES
        .into_iter()
        .map(|case| (case, prepare_case_fixtures(root.path(), case)))
        .collect::<Vec<_>>();
    let previous = ["JUNE_API_URL", "OS_JUNE_LOCAL_DEV", "OS_JUNE_LOCAL_DEV_BEARER_TOKEN"]
        .map(|name| (name, std::env::var_os(name)));
    std::env::set_var("OS_JUNE_LOCAL_DEV", "1");
    std::env::set_var("OS_JUNE_LOCAL_DEV_BEARER_TOKEN", "benchmark-token");

    for (case, case_fixtures) in fixtures {
        let mut measured = Vec::new();
        for iteration in 0..(WARMUP_RUNS + MEASURED_RUNS) {
            let sample = run_benchmark_iteration(
                &revision_label,
                case,
                iteration,
                &case_fixtures,
            )
            .await;
            println!(
                "JUN334_BENCHMARK {}",
                serde_json::to_string(&sample).expect("serialize benchmark sample")
            );
            if iteration >= WARMUP_RUNS {
                measured.push(sample);
            }
        }
        print_case_medians(&revision_label, case.name, &measured);
    }

    for (name, value) in previous {
        if let Some(value) = value {
            std::env::set_var(name, value);
        } else {
            std::env::remove_var(name);
        }
    }
}
```

`print_case_medians` must sort each numeric field independently, select index `len / 2`, and emit a second `JUN334_BENCHMARK ` JSON object with `"aggregate":"median"`. Do not discard raw samples.

- [ ] **Step 7: Add and run the Make target**

Add:

```make
.PHONY: benchmark-transcription-latency
benchmark-transcription-latency:
	cargo test --manifest-path src-tauri/Cargo.toml --locked --release commands::transcription_benchmark::benchmark_post_finalization_meeting_latency -- --ignored --exact --nocapture --test-threads=1
```

Run:

```bash
make benchmark-transcription-latency
```

Expected: PASS and 24 measured/warm-up sample lines plus four median lines, all prefixed `JUN334_BENCHMARK `.

- [ ] **Step 8: Commit the benchmark-only overlay**

```bash
git add src-tauri/src/commands.rs src-tauri/src/commands/transcription_benchmark.rs Makefile
git commit -m "test: add meeting transcription latency benchmark"
```

- [ ] **Step 9: Run the exact overlay on the production baseline**

Record the benchmark commit SHA, then create the temporary worktree and apply only that commit:

```bash
BENCHMARK_COMMIT=$(git rev-parse HEAD)
git worktree add /tmp/os-june-jun334-baseline 06f4925ebba8947ae4197887dcf5d9dbba697a16
git -C /tmp/os-june-jun334-baseline cherry-pick "$BENCHMARK_COMMIT"
JUN334_REVISION_LABEL='06f4925e + test-only harness' make -C /tmp/os-june-jun334-baseline benchmark-transcription-latency
```

Expected: PASS. Preserve the complete output. Label it exactly `06f4925e + test-only harness`, never raw `06f4925e`.

- [ ] **Step 10: Apply the locked go/no-go gate**

For the five measured `dual-5m` samples, compute medians for the existing synchronous extraction-stage duration and handoff-to-first-request, then compute:

```text
gate ratio = median(turn_wav_extraction.durationMs) / median(handoff to first request)
```

Expected to proceed: `gate ratio >= 0.20`.

If it is below `0.20`, stop. Do not execute Task 2. Update the design and plan around the measured stage and request approval again.

---

### Task 2: Add Done-relative timing without adding provider-request latency

**Files:**

- Modify: `src-tauri/src/domain/processing.rs`
- Modify: `src-tauri/src/commands.rs`
- Create: `src-tauri/src/commands/transcription_timing_tests.rs`
- Test: inline `src-tauri/src/domain/processing.rs` test module

**Interfaces:**

- Produces: `pub(crate) struct ProcessingTiming` with `from_done`, `untracked`, `done_to_duration_ms`, and `checkpoint_details`.
- Produces: private `FirstEventTimeline` with synchronous `mark_first_request`, `mark_first_persisted`, and single-shot async `flush`.
- Changes: both processing entry points receive a final `ProcessingTiming` argument.
- Preserves: the current three-argument `finish_recording_session` for the benchmark-only overlay.

- [ ] **Step 1: Write failing timing unit tests**

Add `#[tokio::test] async fn first_event_timeline_flushes_each_checkpoint_once()`. Create a migrated in-memory `Repositories` with one recording session, create a tracked timeline, race two `mark_first_request` calls and two `mark_first_persisted` calls on cloned timelines, call `flush` twice, and query `recording_checkpoints` through `repos.pool`. Assert exact counts of one for `first_transcription_request` and one for `first_transcript_persisted`; parse both details objects and assert each contains only `doneToDurationMs`.

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml --locked domain::processing::tests::first_event_timeline_flushes_each_checkpoint_once -- --exact
```

Expected: FAIL because `ProcessingTiming` and `FirstEventTimeline` do not exist.

- [ ] **Step 2: Add the timing types**

Add `AtomicBool`, `AtomicI64`, and `Ordering` imports and this implementation beside `elapsed_ms`:

```rust
const UNSET_TIMING_MS: i64 = -1;

#[derive(Debug, Clone, Copy, Default)]
pub(crate) struct ProcessingTiming {
    done_started: Option<Instant>,
}

impl ProcessingTiming {
    pub(crate) fn from_done(done_started: Instant) -> Self {
        Self { done_started: Some(done_started) }
    }

    pub(crate) fn untracked() -> Self {
        Self::default()
    }

    fn done_to_duration_ms(self) -> Option<i64> {
        self.done_started.map(elapsed_ms)
    }

    pub(crate) fn checkpoint_details(self, mut details: serde_json::Value) -> String {
        if let (Some(duration_ms), Some(object)) =
            (self.done_to_duration_ms(), details.as_object_mut())
        {
            object.insert("doneToDurationMs".to_string(), duration_ms.into());
        }
        details.to_string()
    }
}

#[derive(Clone)]
struct FirstEventTimeline {
    timing: ProcessingTiming,
    first_request_ms: Arc<AtomicI64>,
    first_persisted_ms: Arc<AtomicI64>,
    flushed: Arc<AtomicBool>,
}

impl FirstEventTimeline {
    fn new(timing: ProcessingTiming) -> Self {
        Self {
            timing,
            first_request_ms: Arc::new(AtomicI64::new(UNSET_TIMING_MS)),
            first_persisted_ms: Arc::new(AtomicI64::new(UNSET_TIMING_MS)),
            flushed: Arc::new(AtomicBool::new(false)),
        }
    }

    fn mark_first_request(&self) {
        self.mark(&self.first_request_ms);
    }

    fn mark_first_persisted(&self) {
        self.mark(&self.first_persisted_ms);
    }

    fn mark(&self, slot: &AtomicI64) {
        if let Some(duration_ms) = self.timing.done_to_duration_ms() {
            let _ = slot.compare_exchange(
                UNSET_TIMING_MS,
                duration_ms,
                Ordering::AcqRel,
                Ordering::Acquire,
            );
        }
    }

    async fn flush(&self, repos: &Repositories, session_id: &str) {
        if self.flushed.swap(true, Ordering::AcqRel) {
            return;
        }
        for (kind, duration_ms) in [
            ("first_transcription_request", self.first_request_ms.load(Ordering::Acquire)),
            ("first_transcript_persisted", self.first_persisted_ms.load(Ordering::Acquire)),
        ] {
            if duration_ms == UNSET_TIMING_MS {
                continue;
            }
            if let Err(error) = repos
                .add_checkpoint(
                    session_id,
                    kind,
                    Some(serde_json::json!({ "doneToDurationMs": duration_ms }).to_string()),
                )
                .await
            {
                tracing::warn!(session_id, kind, %error, "failed to persist latency checkpoint");
            }
        }
    }
}
```

This captures the event synchronously but defers SQLite writes until transcription finishes, so telemetry cannot add a database round trip before the provider request.

- [ ] **Step 3: Wrap the actual transcriber invocation**

Add:

```rust
fn instrument_turn_transcriber(
    inner: TurnTranscriber,
    timeline: FirstEventTimeline,
) -> TurnTranscriber {
    Arc::new(move |request| {
        timeline.mark_first_request();
        inner(request)
    })
}
```

Pass the instrumented transcriber to `transcribe_prepared_audio` in both processing paths. Add `timeline: FirstEventTimeline` as the final argument of `persist_turn_transcription_event`; call `timeline.mark_first_persisted()` immediately after its successful transcript upsert and immediately after `create_transcript` in the microphone-only path. Clone the timeline into the existing sink closure and pass it to the persistence function rather than using a global.

- [ ] **Step 4: Move the production Done origin and preserve the benchmark seam**

In `commands.rs`, import `ProcessingTiming`. Rename the current `finish_recording_session` implementation to `finish_recording_session_with_timing`, add `timing: ProcessingTiming` as its fourth argument, and leave its existing body in place. Then add this untracked wrapper with the original signature for auto-finish and the baseline-compatible benchmark:

```rust
async fn finish_recording_session(
    repos: &Repositories,
    finished: crate::audio::capture::FinishedRecording,
    finalization_started: Instant,
) -> Result<FinishRecordingResponse, AppError> {
    finish_recording_session_with_timing(
        repos,
        finished,
        finalization_started,
        ProcessingTiming::untracked(),
    )
    .await
}

```

Change the public Done command so its first statement captures the origin:

```rust
pub async fn finish_recording(
    app: AppHandle,
    request: SessionRequest,
) -> Result<FinishRecordingResponse, AppError> {
    let timing = ProcessingTiming::from_done(Instant::now());
    let repos = repositories(&app).await?;
    let finalization_started = Instant::now();
    let finished = finish_capture(&request.session_id)?;
    let response = finish_recording_session_with_timing(
        &repos,
        finished,
        finalization_started,
        timing,
    )
    .await?;
    if response.processing_started {
        crate::p3a::record_question_best_effort(
            app,
            crate::p3a::questions::Question::NotesMeetingsRecorded,
        );
    }
    Ok(response)
}
```

`finish_active_capture_before_start` continues to call the untracked wrapper. Retry and recovery call sites pass `ProcessingTiming::untracked()` explicitly to processing functions.

- [ ] **Step 5: Add validation, dequeue, transcription, generation, and completion checkpoints**

Add one best-effort helper and use it for every new latency checkpoint:

```rust
async fn add_latency_checkpoint(
    repos: &Repositories,
    session_id: &str,
    kind: &str,
    details: String,
) {
    if let Err(error) = repos.add_checkpoint(session_id, kind, Some(details)).await {
        tracing::warn!(session_id, kind, %error, "failed to persist latency checkpoint");
    }
}
```

Never use `?` on a new latency checkpoint. Use `timing.checkpoint_details(...)` for `audio_validation` and `processing_dequeued`; add `processing_dequeued` immediately after acquiring the per-note guard.

For the dual-source path, compute the existing valid-source and blocking-failure decision first, flush `FirstEventTimeline`, then add this checkpoint before either returning Failed or entering Generating:

```rust
timing.checkpoint_details(serde_json::json!({
    "durationMs": elapsed_ms(transcription_started),
    "status": if blocking_error.is_some() { "failed" } else { "succeeded" },
    "successfulTurnCount": persisted_transcripts.len(),
    "failedTurnCount": visible_failures.len(),
}))
```

On a scheduler/preparation error, flush captured first events, add `transcription_complete` with status `failed`, the error code, and stage duration, then propagate the original `AppError`. Omit success/failure counts on this terminal infrastructure path rather than reporting zero after an in-flight sink may already have persisted a turn. Task 4 replaces this with the report-preserving pipeline failure path but retains the same telemetry rule.

The microphone-only path has no `persisted_transcripts`, `visible_failures`, or `blocking_error` collections. Give it explicit terminal behavior:

- On ASR failure before a row exists: flush the first-request event, add `transcription_complete` with `status: "failed"`, `successfulTurnCount: 0`, `failedTurnCount: 1`, and the provider error code, then add `processing_complete` with `status: "failed"` before returning the existing user-facing error.
- On successful `create_transcript`: mark first persistence immediately after the awaited insert, flush first events, add `transcription_complete` with `status: "succeeded"`, `successfulTurnCount: 1`, and `failedTurnCount: 0`, then enter Generating.
- On generation failure: add `note_generation` with `status: "failed"` and Done-relative duration, then add `processing_complete` with `status: "failed"` before returning.
- On Ready: add `note_generation` with `status: "succeeded"`, persist the generated result, then add `processing_complete` with `status: "succeeded"`.

The dual-source generation-failure and Ready branches receive the same Done-relative `note_generation` and `processing_complete` status fields. None of these diagnostic writes may replace the processing result.

- [ ] **Step 6: Add a real command-layer monotonicity test**

Declare `#[cfg(test)] mod transcription_timing_tests;` beside the benchmark module and create `src-tauri/src/commands/transcription_timing_tests.rs`. Reuse Task 1's `pub(super)` database and loopback-server helpers. Define the timing fixture locally so the benchmark-only overlay remains frozen:

```rust
fn write_one_second_timing_wav(path: &Path) {
    let spec = hound::WavSpec {
        channels: 2,
        sample_rate: 48_000,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut writer = hound::WavWriter::create(path, spec).expect("timing WAV");
    for frame in 0..48_000_u32 {
        let phase = frame as f32 * 311.0 * std::f32::consts::TAU / 48_000.0;
        let sample = (phase.sin() * 8_000.0) as i16;
        writer.write_sample(sample).expect("left timing sample");
        writer.write_sample(sample).expect("right timing sample");
    }
    writer.finalize().expect("finalize timing WAV");
}

fn timing_finished_recording(
    note_id: &str,
    session_id: &str,
    path: PathBuf,
) -> FinishedRecording {
    FinishedRecording {
        session_id: session_id.to_string(),
        note_id: note_id.to_string(),
        source_mode: RecordingSourceMode::MicrophoneOnly,
        final_path: path.clone(),
        sources: vec![FinishedSource {
            source: RecordingSource::Microphone,
            final_path: path,
            elapsed_ms: 1_000,
            capture_issue: None,
            failure: None,
        }],
        elapsed_ms: 1_000,
        recording: RecordingSessionDto {
            id: session_id.to_string(),
            note_id: note_id.to_string(),
            source_mode: RecordingSourceMode::MicrophoneOnly,
            state: RecordingState::Ready,
            started_at: "2026-07-15T00:00:00.000Z".to_string(),
            elapsed_ms: 1_000,
            device_label: Some("Timing fixture".to_string()),
            level: AudioLevelDto::default(),
            live_preview_enabled: false,
            sources: Vec::new(),
            warnings: Vec::new(),
        },
    }
}
```

Create the note, recording session, and pending microphone artifact with the existing repository APIs before calling `finish_recording_session_with_timing` with `ProcessingTiming::from_done(Instant::now())`. Poll to Ready and query the real checkpoint rows.

Add `#[tokio::test(flavor = "multi_thread", worker_threads = 4)] async fn done_origin_checkpoints_are_monotonic_and_single_shot()`. Assert exactly one row for both first-event kinds and extract `doneToDurationMs` for:

```text
audio_validation
processing_dequeued
first_transcription_request
first_transcript_persisted
transcription_complete
note_generation
processing_complete
```

Assert every adjacent duration is nondecreasing. This test exercises the actual command, queue, provider-call, persistence, generation, and Ready wiring; a test that merely calls `done_to_duration_ms` repeatedly is insufficient.

- [ ] **Step 7: Run timing tests and all command/processing tests**

```bash
cargo test --manifest-path src-tauri/Cargo.toml --locked domain::processing::tests::first_event_timeline_flushes_each_checkpoint_once -- --exact
cargo test --manifest-path src-tauri/Cargo.toml --locked commands::transcription_timing_tests::done_origin_checkpoints_are_monotonic_and_single_shot -- --exact --test-threads=1
cargo test --manifest-path src-tauri/Cargo.toml --locked domain::processing::tests
cargo test --manifest-path src-tauri/Cargo.toml --locked commands::tests
```

Expected: PASS, with exactly one first-request and first-persistence row in the race test.

- [ ] **Step 8: Commit timing instrumentation**

```bash
git add src-tauri/src/domain/processing.rs src-tauri/src/commands.rs src-tauri/src/commands/transcription_timing_tests.rs
git commit -m "feat: measure meeting transcription latency"
```

---

### Task 3: Separate ordinary preparation from lazy fallback

**Files:**

- Modify: `src-tauri/src/domain/processing.rs`
- Test: inline `src-tauri/src/domain/processing.rs` test module

**Interfaces:**

- Produces: `TurnPreparationJob`, `PreparedTurn`, `SourceFallbackPlan`, `TurnPreparer`, `SourceFallbackPreparer`, `prepare_turn_job`, `prepare_source_fallback`, and `build_source_fallback_plans`.
- Changes: `TurnTranscriptionJob` loses fallback-only `source_path`, `covers_full_source`, and `echo_trimmed` fields.
- Preserves: synchronous prepare-all scheduling in this task; streaming begins only in Task 4.

- [ ] **Step 1: Add failing audio-invariance and lazy-fallback tests**

Add `#[test] fn prepared_turn_matches_existing_audio_and_metadata()`: create one real 48 kHz stereo fixture and a fixed-bounds `AudioTurn`; prepare a reference via direct `write_turn_wav` plus `normalize_wav_for_transcription`; prepare the same turn via `prepare_turn_job`; read both WAVs with hound and assert equal `WavSpec`, equal complete `Vec<i16>`, equal source/start/end/index, and equal `turn_operation_id`.

Add `#[tokio::test] async fn successful_jobs_skip_complete_source_preparation()`: use one segmented descriptor per source, a successful fake provider, and an injected fallback preparer backed by `AtomicUsize`; assert both candidates exist and the counter is zero.

Add `#[tokio::test] async fn failed_source_prepares_one_lazy_fallback_with_source_operation_id()`: fail ordinary microphone requests, succeed the system request and microphone source fallback, capture operation IDs, and assert exactly one microphone fallback preparation, zero system fallback preparations, the existing `artifact-microphone-source` operation-id shape, and no remaining microphone failure.

Add `#[tokio::test] async fn failed_sources_prepare_one_fallback_each()`: fail both ordinary sources, make both fallback requests succeed, and assert the per-source call map is exactly `{microphone: 1, system: 1}`.

Add `#[tokio::test] async fn echo_trimmed_source_never_prepares_or_transcribes_fallback()`: fail an echo-trimmed microphone descriptor and assert both fallback-preparer and source-operation counters remain zero.

Add `#[tokio::test] async fn valid_cached_turn_suppresses_fallback_after_fresh_failures()`: pass a bounds-matched valid cached microphone candidate while fresh microphone work fails and assert the fallback counter remains zero.

Run the first two exact tests. Expected: FAIL because the descriptor and fallback preparer do not exist.

- [ ] **Step 2: Add descriptor and fallback types**

Add:

```rust
#[derive(Debug, Clone)]
struct TurnPreparationJob {
    schedule_index: usize,
    turn: AudioTurn,
    temp_dir: PathBuf,
    segment_path: PathBuf,
    normalized_path: PathBuf,
    recorded_silence: bool,
    echo_trimmed: bool,
}

impl TurnPreparationJob {
    fn covers_full_source(&self) -> bool {
        covers_full_source(self.turn.start_ms, self.turn.end_ms)
    }
}

#[derive(Debug)]
struct PreparedTurn {
    schedule_index: usize,
    job: TurnTranscriptionJob,
}

#[derive(Debug, Clone)]
struct SourceFallbackPlan {
    artifact_id: String,
    source: String,
    source_path: PathBuf,
    normalized_path: PathBuf,
    temp_dir: PathBuf,
    recorded_silence: bool,
    all_turns_cover_full_source: bool,
    echo_trimmed: bool,
    end_ms: i64,
    turn_index: i64,
}

impl SourceFallbackPlan {
    fn eligible(&self) -> bool {
        !self.all_turns_cover_full_source && !self.echo_trimmed
    }
}

type TurnPreparer = Arc<
    dyn Fn(TurnPreparationJob) -> Result<PreparedTurn, AppError> + Send + Sync,
>;
type SourceFallbackPreparer = Arc<
    dyn Fn(SourceFallbackPlan) -> Result<TurnTranscriptionJob, AppError> + Send + Sync,
>;
```

- [ ] **Step 3: Implement production preparation with the existing DSP primitives**

```rust
fn prepare_turn_job(descriptor: TurnPreparationJob) -> Result<PreparedTurn, AppError> {
    let raw_path = if descriptor.covers_full_source() {
        descriptor.turn.source_path.clone()
    } else {
        write_turn_wav(&descriptor.turn, &descriptor.segment_path)?;
        descriptor.segment_path.clone()
    };
    let audio_path = normalize_wav_for_transcription(&raw_path, &descriptor.normalized_path)?;
    Ok(PreparedTurn {
        schedule_index: descriptor.schedule_index,
        job: TurnTranscriptionJob {
            artifact_id: descriptor.turn.artifact_id,
            source: descriptor.turn.source,
            audio_path,
            temp_dir: descriptor.temp_dir,
            recorded_silence: descriptor.recorded_silence,
            source_fallback: false,
            start_ms: descriptor.turn.start_ms,
            end_ms: descriptor.turn.end_ms,
            turn_index: descriptor.turn.turn_index,
        },
    })
}

fn prepare_source_fallback(plan: SourceFallbackPlan) -> Result<TurnTranscriptionJob, AppError> {
    let audio_path = normalize_wav_for_transcription(&plan.source_path, &plan.normalized_path)?;
    Ok(TurnTranscriptionJob {
        artifact_id: plan.artifact_id,
        source: plan.source,
        audio_path,
        temp_dir: plan.temp_dir,
        recorded_silence: plan.recorded_silence,
        source_fallback: true,
        start_ms: 0,
        end_ms: plan.end_ms,
        turn_index: plan.turn_index,
    })
}
```

- [ ] **Step 4: Build ordered fallback plans before moving descriptors**

Implement `build_source_fallback_plans(&[TurnPreparationJob]) -> Vec<SourceFallbackPlan>` with a vector and source-to-index map. For each later descriptor of the same source, apply exactly:

```rust
plan.all_turns_cover_full_source &= descriptor.covers_full_source();
plan.echo_trimmed |= descriptor.echo_trimmed;
plan.end_ms = plan.end_ms.max(descriptor.turn.end_ms);
```

Use the first descriptor's artifact, raw source path, recorded-silence value, and turn index. Name the output `segment_dir.join(format!("{}-source-normalized.wav", source))`. A vector preserves microphone-before-system fallback order; do not iterate a `HashMap` for fallbacks.

- [ ] **Step 5: Replace eager fallback normalization and inject the fallback preparer**

Delete `normalized_full_source` and its cache. Build descriptors without opening audio. For this intermediate task, prepare ordinary descriptors synchronously with `prepare_turn_job` before calling the existing scheduler. Change the scheduler to accept ordered fallback plans and a `SourceFallbackPreparer`. After ordinary jobs finish, for each plan:

1. skip if fresh or cached candidates contain a valid non-empty row for the source;
2. skip if `!plan.eligible()`;
3. call the preparer once through awaited `spawn_blocking`;
4. transcribe through `transcribe_one_turn_job`; and
5. pass the event through the same result sink and failure-replacement logic.

The real fallback must never submit `plan.source_path` directly; only the normalized `audio_path` returned by `prepare_source_fallback` is transcribed.

- [ ] **Step 6: Run focused quality and fallback tests**

```bash
cargo test --manifest-path src-tauri/Cargo.toml --locked domain::processing::tests::prepared_turn_matches_existing_audio_and_metadata -- --exact
cargo test --manifest-path src-tauri/Cargo.toml --locked domain::processing::tests::successful_jobs_skip_complete_source_preparation -- --exact
cargo test --manifest-path src-tauri/Cargo.toml --locked domain::processing::tests::failed_source_prepares_one_lazy_fallback_with_source_operation_id -- --exact
cargo test --manifest-path src-tauri/Cargo.toml --locked domain::processing::tests::failed_sources_prepare_one_fallback_each -- --exact
cargo test --manifest-path src-tauri/Cargo.toml --locked domain::processing::tests::echo_trimmed_source_never_prepares_or_transcribes_fallback -- --exact
cargo test --manifest-path src-tauri/Cargo.toml --locked domain::processing::tests::valid_cached_turn_suppresses_fallback_after_fresh_failures -- --exact
```

Expected: PASS. The success test must report zero fallback-preparer invocations.

- [ ] **Step 7: Run the processing test module and commit**

```bash
cargo test --manifest-path src-tauri/Cargo.toml --locked domain::processing::tests
git add src-tauri/src/domain/processing.rs
git commit -m "perf: prepare meeting fallbacks only when needed"
```

Expected: all processing tests PASS.

---

### Task 4: Stream ordered preparation into a context-preserving bounded scheduler

**Files:**

- Modify: `src-tauri/src/domain/processing.rs`
- Test: inline `src-tauri/src/domain/processing.rs` test module

**Interfaces:**

- Produces: `spawn_turn_preparation`, `transcribe_prepared_turn_stream`, and `prepare_and_transcribe_turn_jobs_bounded`.
- Produces: `TurnLaunchPermit`, `TurnPreparationReport`, `TurnPipelineResult`, and report-preserving `TurnPipelineFailure`.
- Consumes: Task 3 descriptors/preparers and existing `TurnTranscriber`/`TurnResultSink`.

- [ ] **Step 1: Write failing overlap, concurrency, context, order, and error tests**

Add `#[tokio::test] async fn pipeline_starts_first_request_before_later_preparation_finishes()`: the blocking preparer returns index 0, signals that index 1 preparation began, and blocks index 1 on a standard channel; the fake transcriber notifies on invocation. Assert the transcriber notification arrives while index 1 remains blocked, release it, and assert success.

Add `#[tokio::test] async fn streaming_scheduler_never_exceeds_two_provider_calls()`: submit three prepared jobs, track active/max-active atomically, and block providers on a zero-permit Tokio semaphore. Wait until two are active, assert the third has not started and max-active is exactly two, release permits, and assert all finish.

Add `#[tokio::test] async fn streaming_scheduler_preserves_logical_spawn_context()`: delay descriptor 1 until job 0 completes, capture every outbound context, and assert jobs 0 and 1 have only dictionary context while job 2 includes job 0's completed text. This pins the current all-ready logical slot semantics despite slow preparation.

Add `#[tokio::test] async fn pipelined_results_are_sorted_after_reverse_completion()`: block turn 0, complete turn 1, have the sink release turn 0, and assert sink order `[1, 0]` but final candidate order `[0, 1]` with unchanged sources and bounds.

Add `#[tokio::test] async fn preparation_error_joins_in_flight_requests_and_skips_fallback()`: start provider work for descriptor 0, make descriptor 1 return `audio_turn_failed`, assert the pipeline future remains pending while provider 0 is blocked, release it, then assert active count zero, its sink invocation persisted, fallback count zero, and the original preparation error returned.

Run the overlap test. Expected: FAIL because `spawn_turn_preparation` does not exist.

- [ ] **Step 2: Add the producer report and capacity-two blocking producer**

```rust
const PREPARED_TURN_CHANNEL_CAPACITY: usize = DEFAULT_TURN_TRANSCRIPTION_CONCURRENCY;

#[derive(Debug)]
struct TurnPreparationReport {
    prepared_count: usize,
    active_preparation_duration_ms: i64,
    producer_wall_duration_ms: i64,
    done_to_preparation_complete_ms: Option<i64>,
    error: Option<AppError>,
}

#[derive(Debug)]
struct TurnPipelineResult {
    outcome: TranscriptionOutcome,
    preparation: TurnPreparationReport,
}

#[derive(Debug)]
struct TurnPipelineFailure {
    error: AppError,
    preparation: Option<TurnPreparationReport>,
}

fn spawn_turn_preparation(
    descriptors: Vec<TurnPreparationJob>,
    preparer: TurnPreparer,
    timing: ProcessingTiming,
) -> (
    tokio::sync::mpsc::Receiver<Result<PreparedTurn, AppError>>,
    tokio::task::JoinHandle<TurnPreparationReport>,
) {
    let (sender, receiver) = tokio::sync::mpsc::channel(PREPARED_TURN_CHANNEL_CAPACITY);
    let handle = tokio::task::spawn_blocking(move || {
        let producer_started = Instant::now();
        let mut prepared_count = 0;
        let mut active_preparation_duration_ms = 0_i64;
        let mut terminal_error = None;
        for descriptor in descriptors {
            let preparation_started = Instant::now();
            let prepared = preparer(descriptor);
            active_preparation_duration_ms = active_preparation_duration_ms
                .saturating_add(elapsed_ms(preparation_started));
            match prepared {
                Ok(prepared) => {
                    prepared_count += 1;
                    if sender.blocking_send(Ok(prepared)).is_err() {
                        break;
                    }
                }
                Err(error) => {
                    let _ = sender.blocking_send(Err(error.clone()));
                    terminal_error = Some(error);
                    break;
                }
            }
        }
        TurnPreparationReport {
            prepared_count,
            active_preparation_duration_ms,
            producer_wall_duration_ms: elapsed_ms(producer_started),
            done_to_preparation_complete_ms: timing.done_to_duration_ms(),
            error: terminal_error,
        }
    });
    (receiver, handle)
}
```

- [ ] **Step 3: Preserve the current logical context slots with launch permits**

Do not compute context merely when a slow prepared job arrives. The current all-ready scheduler gives the first two jobs the same empty completed-turn context, then snapshots context whenever a provider slot opens. Encode that explicitly:

```rust
#[derive(Debug)]
struct TurnLaunchPermit {
    schedule_index: usize,
    context: Option<String>,
}

fn turn_context(
    dictionary_context: Option<&str>,
    completed_inputs: &[SourceTranscriptInput],
) -> Option<String> {
    merge_transcription_context(
        dictionary_context,
        build_transcription_context(completed_inputs).as_deref(),
    )
}
```

At scheduler start, create permits for indices `0..total_jobs.min(max_concurrency)`, all from empty `completed_inputs`. On every joined result, await the sink and update `completed_inputs`. Create exactly one next permit only with this guard:

```rust
if terminal_error.is_none() && next_permit_index < total_jobs {
    permits.push_back(TurnLaunchPermit {
        schedule_index: next_permit_index,
        context: turn_context(dictionary_context.as_deref(), &completed_inputs),
    });
    next_permit_index += 1;
}
```

Maintain this invariant:

```text
active provider jobs + outstanding launch permits <= max_concurrency
```

The producer is ordered, so every received `PreparedTurn.schedule_index` must equal the front permit's `schedule_index`; return `AppError::new("audio_turn_failed", "prepared turn order changed")` if it does not.

- [ ] **Step 4: Implement the async consumer without starving completions**

Use this signature:

```rust
#[allow(clippy::too_many_arguments)]
async fn transcribe_prepared_turn_stream(
    mut receiver: tokio::sync::mpsc::Receiver<Result<PreparedTurn, AppError>>,
    total_jobs: usize,
    provider: String,
    title: String,
    dictionary_context: Option<String>,
    transcriber: TurnTranscriber,
    result_sink: Option<TurnResultSink>,
    max_concurrency: usize,
) -> Result<TranscriptionOutcome, AppError>
```

Use a `tokio::select! { biased; ... }` loop. When a permit exists, place the receiver branch first so an already-ready prepared job is launched before a second ready completion is observed; this matches the current scheduler's “handle one completion, refill one slot” order. Keep the join branch enabled whenever the `JoinSet` is nonempty, so a slow preparer never delays persistence of an already-completed provider job.

The loop state is:

```rust
let mut permits = VecDeque::<TurnLaunchPermit>::new();
let mut next_permit_index = permits.len();
let mut join_set = tokio::task::JoinSet::new();
let mut completed_inputs = Vec::<SourceTranscriptInput>::new();
let mut outcome = TranscriptionOutcome::default();
let mut terminal_error = None::<AppError>;
let mut receiver_open = true;
```

On a preparation, sink, join, or channel-order error: preserve the first error, call `receiver.close()`, clear outstanding permits, stop launching or creating permits, and continue `join_next` until no provider task remains. Attempt the normal sink for every already-started completion and preserve the first sink error. Return only after the `JoinSet` is empty. Receiver closure is success only when every schedule index was received; otherwise return `AppError::new("audio_turn_failed", "turn preparation ended before every job was received")`. Sort the outcome before a successful return.

- [ ] **Step 5: Add the orchestration wrapper and join the blocking producer**

Implement:

```rust
#[allow(clippy::too_many_arguments)]
async fn prepare_and_transcribe_turn_jobs_bounded(
    descriptors: Vec<TurnPreparationJob>,
    fallback_plans: Vec<SourceFallbackPlan>,
    cached_candidates: &[TranscriptCandidate],
    provider: String,
    title: String,
    dictionary_context: Option<String>,
    turn_preparer: TurnPreparer,
    fallback_preparer: SourceFallbackPreparer,
    transcriber: TurnTranscriber,
    result_sink: Option<TurnResultSink>,
    max_concurrency: usize,
    timing: ProcessingTiming,
) -> Result<TurnPipelineResult, TurnPipelineFailure>
```

It must:

1. derive `total_jobs` before moving descriptors;
2. spawn the producer;
3. await the stream consumer;
4. await the producer handle even when the consumer failed;
5. return the first consumer/producer error only after both owned stages are joined, attaching `Some(preparation_report)` whenever the producer returned one;
6. run eligible per-source fallback only after ordinary work and producer join succeed; and
7. return the combined sorted outcome and exact producer report.

The producer report is returned even when preparation fails. A `JoinError` is the only case where `TurnPipelineFailure.preparation` is `None`. This lets Task 5 persist active preparation and producer-wall telemetry before returning the original pipeline error.

Run each real fallback preparer in its own awaited `spawn_blocking`; never detach it.

- [ ] **Step 6: Run scheduler behavior tests**

```bash
cargo test --manifest-path src-tauri/Cargo.toml --locked domain::processing::tests::pipeline_starts_first_request_before_later_preparation_finishes -- --exact
cargo test --manifest-path src-tauri/Cargo.toml --locked domain::processing::tests::streaming_scheduler_never_exceeds_two_provider_calls -- --exact
cargo test --manifest-path src-tauri/Cargo.toml --locked domain::processing::tests::streaming_scheduler_preserves_logical_spawn_context -- --exact
cargo test --manifest-path src-tauri/Cargo.toml --locked domain::processing::tests::pipelined_results_are_sorted_after_reverse_completion -- --exact
cargo test --manifest-path src-tauri/Cargo.toml --locked domain::processing::tests::preparation_error_joins_in_flight_requests_and_skips_fallback -- --exact
```

Expected: PASS. The context test is mandatory; an implementation that lets a slow second preparation inherit the first completion has changed transcription inputs and must be rejected.

- [ ] **Step 7: Re-run existing retry and context regression tests**

Run the existing dictionary/completed-context, transient-retry, no-speech, partial-success, fallback, cache, echo, and ordering tests by running the whole module:

```bash
cargo test --manifest-path src-tauri/Cargo.toml --locked domain::processing::tests
```

Expected: PASS with no changed assertions for context text, retry counts, warnings, or candidate metadata.

- [ ] **Step 8: Commit the streaming scheduler**

```bash
git add src-tauri/src/domain/processing.rs
git commit -m "perf: overlap turn preparation and transcription"
```

---

### Task 5: Wire the pipeline into saved-source processing and make cleanup unconditional

**Files:**

- Modify: `src-tauri/src/domain/processing.rs`
- Test: inline `src-tauri/src/domain/processing.rs` test module

**Interfaces:**

- Consumes: Task 4 `prepare_and_transcribe_turn_jobs_bounded`.
- Produces: `TempDirCleanup` and the final production microphone-plus-system pipeline.
- Preserves: cached turns bypass preparation; sentinel full-source ordinary turns still normalize as ordinary work and do not create a second fallback.

- [ ] **Step 1: Write failing production-wiring and cleanup tests**

Add `#[tokio::test] async fn segment_temp_dir_is_removed_after_preparation_error()`: create a nested session directory under `tempfile::tempdir`, run the Task 4 error scenario while holding `TempDirCleanup`, release the in-flight provider, await the error, drop the guard, and assert the nested directory is absent and provider active count is zero.

Add `#[tokio::test] async fn preparation_report_separates_active_time_from_backpressure()`: use five descriptors, make each preparer spend a controlled interval in active work, and block provider progress. Two jobs are active and two fit in the capacity-two channel, so assert the producer handle remains pending on the fifth `blocking_send` until one provider permit is released. Then assert `active_preparation_duration_ms` reflects only the five preparer calls, `producer_wall_duration_ms` is larger because it spans the blocked send, and `done_to_preparation_complete_ms` is captured before final pipeline completion.

Extend `preparation_error_joins_in_flight_requests_and_skips_fallback` to assert the returned `TurnPipelineFailure.preparation` is `Some`, contains the completed active/prepared counters, and retains the original preparation error.

Run the cleanup test. Expected: FAIL because early `?` can bypass the current explicit `remove_dir_all`.

- [ ] **Step 2: Add the lexical temp-directory guard**

```rust
struct TempDirCleanup(PathBuf);

impl Drop for TempDirCleanup {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
```

Create the guard immediately after `create_dir_all(&segment_dir)` succeeds and remove the later explicit cleanup. The guard may drop only after the wrapper has joined the producer, all provider jobs, and any fallback `spawn_blocking` work.

- [ ] **Step 3: Build descriptors and fallback plans without WAV I/O**

Keep the cache-bound check first. For every non-cached `AudioTurn`, create a `TurnPreparationJob` with sequential `schedule_index`, raw `AudioTurn`, paths, silence metadata, and echo-trimmed flag. Do not call `write_turn_wav` or `normalize_wav_for_transcription` in this loop. After the loop:

```rust
let fallback_plans = build_source_fallback_plans(&preparation_jobs);
```

This must happen before moving `preparation_jobs` into the producer.

Capture `let reused_transcript_count = cached_candidates.len();` before moving cached candidates into `transcription_outcome` and use that value in both success and failure preparation checkpoints.

- [ ] **Step 4: Call the pipeline and persist accurate preparation details**

Invoke the wrapper with production closures and match its report-preserving result:

```rust
let pipeline_result = prepare_and_transcribe_turn_jobs_bounded(
    preparation_jobs,
    fallback_plans,
    &transcription_outcome.candidates,
    transcription_provider.clone(),
    title.clone(),
    dictionary_context,
    Arc::new(prepare_turn_job),
    Arc::new(prepare_source_fallback),
    instrument_turn_transcriber(default_turn_transcriber(), timeline.clone()),
    Some(result_sink),
    DEFAULT_TURN_TRANSCRIPTION_CONCURRENCY,
    timing,
)
.await;

let pipeline = match pipeline_result {
    Ok(pipeline) => {
        persist_turn_preparation_checkpoint(
            repos,
            session_id,
            "succeeded",
            Some(&pipeline.preparation),
            reused_transcript_count,
            None,
        )
        .await;
        pipeline
    }
    Err(failure) => {
        let error_code = failure.error.code.clone();
        persist_turn_preparation_checkpoint(
            repos,
            session_id,
            "failed",
            failure.preparation.as_ref(),
            reused_transcript_count,
            Some(error_code.as_str()),
        )
        .await;
        timeline.flush(repos, session_id).await;
        add_latency_checkpoint(
            repos,
            session_id,
            "transcription_complete",
            timing.checkpoint_details(serde_json::json!({
                "durationMs": elapsed_ms(transcription_started),
                "status": "failed",
                "error": error_code,
            })),
        )
        .await;
        return Err(failure.error);
    }
};
```

Implement the best-effort checkpoint helper used above:

```rust
async fn persist_turn_preparation_checkpoint(
    repos: &Repositories,
    session_id: &str,
    status: &str,
    report: Option<&TurnPreparationReport>,
    reused_transcript_count: usize,
    error: Option<&str>,
) {
    add_latency_checkpoint(
        repos,
        session_id,
        "turn_wav_extraction",
        serde_json::json!({
            "durationMs": report.map(|value| value.active_preparation_duration_ms),
            "activePreparationDurationMs": report.map(|value| value.active_preparation_duration_ms),
            "producerWallDurationMs": report.map(|value| value.producer_wall_duration_ms),
            "doneToPreparationCompleteMs": report.and_then(|value| value.done_to_preparation_complete_ms),
            "jobCount": report.map(|value| value.prepared_count).unwrap_or(0),
            "reusedTranscriptCount": reused_transcript_count,
            "status": status,
            "error": error,
        })
        .to_string(),
    )
    .await;
}
```

`durationMs` remains the active preparation field for compatibility. `producerWallDurationMs` includes channel backpressure and must never be compared directly with the baseline synchronous duration. Do not label wrapper return time as preparation completion.

- [ ] **Step 5: Preserve failure, coverage, and generation ordering**

Append the fresh outcome to cached candidates as before. Persist visible failures, compute coverage, query persisted transcripts, sort inputs, and evaluate blocking failures before writing `transcription_complete` and entering Generating. Do not allow a preparation error to reach fallback, coverage, or generation.

- [ ] **Step 6: Run production-wiring, quality, cleanup, and full Rust tests**

```bash
cargo test --manifest-path src-tauri/Cargo.toml --locked domain::processing::tests::segment_temp_dir_is_removed_after_preparation_error -- --exact
cargo test --manifest-path src-tauri/Cargo.toml --locked domain::processing::tests::preparation_report_separates_active_time_from_backpressure -- --exact
cargo test --manifest-path src-tauri/Cargo.toml --locked domain::processing::tests::prepared_turn_matches_existing_audio_and_metadata -- --exact
pnpm test:rust
```

Expected: PASS. The quality test must compare the real normalized sample stream, not merely filenames or call counts.

- [ ] **Step 7: Commit production wiring**

```bash
git add src-tauri/src/domain/processing.rs
git commit -m "perf: stream prepared meeting turns"
```

---

### Task 6: Prove persisted turns become visible during transcription

**Files:**

- Modify: `src/test/app-notes-reliability.test.tsx`

**Interfaces:**

- Consumes: existing `App` selected-note one-second polling and `NoteEditor` partial-turn rendering.
- Produces: Vitest regression `polls newly persisted turns while transcription remains active`.
- Production React output: unchanged.

- [ ] **Step 1: Add the App-level real-poll regression**

Place the test next to the existing active-note polling tests. Create `selectedNote` with `processingStatus: "transcribing"`, `activeTab: "transcription"`, and an empty `sourceTranscripts` array. Override `bootstrapApp` to return that note, make `mocks.getNote` return a mutable `pollResponse`, render `App`, open Meeting notes, select First note, and wait for the initial Transcribing status. Clear `mocks.getNote` while the existing real one-second interval remains installed.

Inside `try`, update `pollResponse` to:

```ts
{
  ...selectedNote,
  processingStatus: "transcribing",
  sourceTranscripts: [
    {
      id: "turn-1",
      text: "The first saved turn is visible.",
      source: "microphone",
      sourceMode: "microphonePlusSystem",
      startMs: 0,
      endMs: 4_000,
      turnIndex: 0,
      language: "en",
      status: "succeeded",
      recordedSilence: false,
    },
  ],
}
```

Wait for the next real poll and its render:

```ts
await waitFor(
  () => {
  expect(mocks.getNote).toHaveBeenCalledWith(selectedNote.id);
  expect(screen.getByText("The first saved turn is visible.")).toBeInTheDocument();
  },
  { timeout: 2_000 },
);
expect(screen.getByRole("status")).toHaveTextContent("Transcribing audio");
```

Do not return a Ready response in this test; it proves the partial turn appears while work remains active. Real timers are deliberate: the interval was created by the mounted effect, and installing fake timers afterward would not take ownership of it.

- [ ] **Step 2: Run the test and confirm the existing production path passes**

```bash
pnpm test -- src/test/app-notes-reliability.test.tsx -t "polls newly persisted turns while transcription remains active"
```

Expected: PASS without editing `App.tsx` or `NoteEditor.tsx`.

- [ ] **Step 3: Commit the UI regression test**

```bash
git add src/test/app-notes-reliability.test.tsx
git commit -m "test: cover partial transcript polling"
```

---

### Task 7: Measure the feature branch and document the proof

**Files:**

- Create: `docs/qa/jun-334-transcription-latency.md`
- Modify: `docs/index.md`

**Interfaces:**

- Consumes: Task 1 benchmark output from baseline and feature branch; Tasks 2-6 deterministic test results.
- Produces: reproducible JUN-334 evidence and locked threshold calculations for the PR.

- [ ] **Step 1: Run the unchanged feature benchmark**

```bash
JUN334_REVISION_LABEL="$(git rev-parse --short HEAD) feature" make benchmark-transcription-latency
```

Expected: PASS with the same four cases, one warm-up, five measured iterations, delays, and JSON schema used on the baseline overlay.

- [ ] **Step 2: Calculate the locked five-minute gates**

Using medians from the two `dual-5m` runs and the two five-minute microphone-only control runs, calculate:

```text
first-persist improvement = (baseline first-persist - feature first-persist) / baseline first-persist
completion improvement = (baseline completion - feature completion) / baseline completion
mic-control regression = (feature mic-control completion - baseline mic-control completion) / baseline mic-control completion
```

Expected:

- `first-persist improvement >= 0.20`
- `completion improvement >= 0.10`
- `mic-control regression <= 0.05`

If any condition fails, do not weaken it and do not open the PR. Diagnose the measured regression and revise the implementation.

- [ ] **Step 3: Write the QA evidence document**

Create `docs/qa/jun-334-transcription-latency.md` with these sections and populated values:

```markdown
# JUN-334 meeting transcription latency

## Measurement origins

## Environment and revisions

## Benchmark method

## Baseline samples: 06f4925e + test-only harness

## Feature samples

## Median comparison and gates

## Causal deterministic proofs

## UI visibility bound

## Scope and limitations

This is a desktop-only scheduling change and does not require a June API backend deploy.

## Reproduction commands
```

Include all raw `JUN334_BENCHMARK` lines or attach a checked table that preserves every measured value. State that native persistence precedes visible output by 0 to 1 second plus database, IPC, reducer, and render time. State that the fake generation endpoint characterizes orchestration only and is not production model latency.

- [ ] **Step 4: Index and lint the documentation**

Add the QA doc under the appropriate testing/QA section of `docs/index.md`.

Run:

```bash
rg -n "JUN-334|06f4925e \+ test-only harness|0 to 1 second|backend deploy" docs/qa/jun-334-transcription-latency.md
pnpm check
```

Expected: all four evidence phrases are present and Biome passes.

- [ ] **Step 5: Commit measured evidence**

```bash
git add docs/qa/jun-334-transcription-latency.md docs/index.md
git commit -m "docs: record transcription latency improvement"
```

---

### Task 8: Verify, independently review, and publish the PR

**Files:**

- Review all files changed from `origin/main`.
- Do not add implementation scope during this task unless a review finding requires a focused fix and test.

**Interfaces:**

- Consumes: completed implementation, deterministic tests, baseline/feature benchmark evidence.
- Produces: clean review battery, pushed branch, and ready PR referencing JUN-334.

- [ ] **Step 1: Run formatting and targeted deterministic checks**

```bash
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
pnpm check
pnpm typecheck
pnpm test -- src/test/app-notes-reliability.test.tsx -t "polls newly persisted turns while transcription remains active"
cargo test --manifest-path src-tauri/Cargo.toml --locked domain::processing::tests
```

Expected: PASS with zero test failures.

- [ ] **Step 2: Run the complete local gate**

```bash
make verify
```

Expected: PASS. If the documented HUD teardown noise appears with zero real failures, preserve the full output and verify the failure count rather than treating noise as a regression.

- [ ] **Step 3: Run the repo review battery against a fixed base**

Use the `repo-review` skill with base `origin/main`. Run Standards, Spec, and adversarial axes on a harness that did not implement the diff. Every finding must include file/line evidence and severity. Fix valid findings with a regression test, rerun the focused gate, and repeat reviews until no actionable findings remain.

- [ ] **Step 4: Inspect the final diff for secrets and scope drift**

```bash
git diff --check origin/main...HEAD
git diff --stat origin/main...HEAD
git status --short
rg -n "benchmark-token|OS_JUNE_LOCAL_DEV_BEARER_TOKEN|JUNE_API_URL" src-tauri/src/commands/transcription_benchmark.rs
```

Expected: clean diff check, expected files only, clean worktree, and only the fixed non-secret benchmark token/env variable names in test code.

- [ ] **Step 5: Push and open the draft PR**

```bash
git push -u origin seriusanbudi/faster-meeting-transcriptions
```

Open a draft PR titled `Reduce meeting transcription latency` with:

- Summary of lazy fallback plus bounded preparation overlap.
- Root cause: full-source fallback normalization and all-turn preparation happened before the first request.
- Baseline and feature medians with locked gate calculations.
- Structural tests proving zero fallback work and overlap.
- UI validation: automated App polling regression; no production UI change, so no visual artifact required.
- Backend deploy: not required.
- Out of scope: generation optimization, preview reuse, higher concurrency, batch API, microphone-only chunk persistence, push-based UI updates.
- Followups driven only by measured remaining bottlenecks.
- JUN-334 reference. Use `Closes JUN-334` only if every issue acceptance criterion is satisfied; otherwise use `Relates to JUN-334` and explain the remaining criterion.

- [ ] **Step 6: Complete automated review and CI loops**

Wait for CI, Greptile, and Codex review. Apply only evidence-backed findings, rerun the affected local test and `make verify`, push, and repeat until all checks pass and no actionable review thread remains.

- [ ] **Step 7: Mark the PR ready**

Mark the PR ready only after CI and review loops are clean and the measured thresholds remain satisfied. Report the PR URL, baseline/feature headline medians, exact tests, backend-deploy status, and any followup issue in the final handoff.
