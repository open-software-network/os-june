//! Rolling-chunk transcription while a dual-source recording is in progress.
//!
//! Every tick, the in-progress source WAVs are scanned with the same turn
//! detection used after finalization. Turns that ended comfortably before the
//! live edge are extracted as valid standalone WAVs, transcribed, and
//! persisted as provisional turn transcripts so most of the transcription work
//! is already done when the user stops the recording. Final processing then
//! reuses those transcripts by time-range matching (see
//! `processing::reuse_persisted_transcript_text`).
//!
//! Reliability rules: the saved full WAVs stay the source of truth, every
//! failure here is logged-and-dropped (the final pass redoes the turn), and
//! nothing in this module can touch the note's processing status or the
//! capture path.

use crate::{
    audio::{
        live::{detect_partial_turns, RmsWindowCache},
        turns::{coalesce_turns_for_transcription, normalize_wav_for_transcription, AudioTurn},
    },
    db::repositories::Repositories,
    domain::{
        processing::{
            build_dictionary_context, build_transcription_context, default_turn_transcriber,
            elapsed_ms, maybe_post_process_note_transcript, merge_transcription_context,
            session_temp_dir, transcribe_prepared_audio, SourceTranscriptInput,
            TranscribePreparedAudioRequest, TurnTranscriber,
        },
        types::{AppError, RecordingSourceMode},
    },
};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, LazyLock, Mutex,
    },
    time::{Duration, Instant},
};

/// Set to `0`, `false`, or `off` to disable live transcription.
const LIVE_TRANSCRIPTION_ENV: &str = "OS_SCRIBE_LIVE_TRANSCRIPTION";
const LIVE_TEMP_PREFIX: &str = "os-scribe-live";
const LIVE_TICK_INTERVAL: Duration = Duration::from_secs(15);
const STOP_POLL_INTERVAL: Duration = Duration::from_millis(250);
/// A live turn is only transcribed once this much audio exists after it.
/// Must exceed the transcription coalesce gap (2.5s) so a turn that already
/// ended can never later merge with speech that starts after the live edge.
const LIVE_EDGE_PADDING_MS: i64 = 4_000;
/// Overlap (relative to the shorter interval) above which a detected turn is
/// considered already attempted in an earlier tick.
const ATTEMPTED_OVERLAP: f64 = 0.6;
/// How long [`drain`] waits for a signalled loop to finish its in-flight turn
/// before aborting it. Final processing re-transcribes whatever the aborted
/// turn would have produced, so waiting longer only delays the note.
const DRAIN_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug, Clone)]
pub struct LiveSourceInput {
    pub artifact_id: String,
    pub source: String,
    pub partial_path: PathBuf,
}

pub struct LiveSessionHandle {
    session_id: String,
    stop: Arc<AtomicBool>,
    task: tokio::task::JoinHandle<()>,
}

static LIVE_SESSIONS: LazyLock<Mutex<HashMap<String, LiveSessionHandle>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn live_transcription_enabled() -> bool {
    match std::env::var(LIVE_TRANSCRIPTION_ENV) {
        Ok(value) => {
            let value = value.trim().to_ascii_lowercase();
            !(value == "0" || value == "false" || value == "off")
        }
        Err(_) => true,
    }
}

/// Starts the live transcription loop for a dual-source recording session.
/// No-op for microphone-only recordings (their final processing transcribes
/// the whole file, so there are no turn transcripts to reuse).
pub fn start_live_transcription(
    repos: Repositories,
    note_id: String,
    session_id: String,
    source_mode: RecordingSourceMode,
    sources: Vec<LiveSourceInput>,
) {
    if source_mode != RecordingSourceMode::MicrophonePlusSystem || !live_transcription_enabled() {
        return;
    }
    if sources.is_empty() {
        return;
    }
    let stop = Arc::new(AtomicBool::new(false));
    let task_stop = Arc::clone(&stop);
    let task_session_id = session_id.clone();
    let task = tokio::spawn(async move {
        run_live_session(
            repos,
            note_id,
            task_session_id,
            source_mode,
            sources,
            task_stop,
        )
        .await;
    });
    let mut sessions = LIVE_SESSIONS
        .lock()
        .expect("live transcription registry poisoned");
    if let Some(previous) = sessions.insert(
        session_id.clone(),
        LiveSessionHandle {
            session_id,
            stop,
            task,
        },
    ) {
        // Should be unreachable (capture is single-instance and session ids
        // are fresh UUIDs), but never leave a loop without a reachable stop
        // flag: a dropped handle would detach the task and let it tick
        // forever.
        previous.stop.store(true, Ordering::Release);
    }
}

/// Signals the session's live loop to stop and removes it from the registry.
/// Returns the handle so the caller can [`drain`] it when it needs the loop to
/// have fully finished (e.g. before final processing).
pub fn signal_stop(session_id: &str) -> Option<LiveSessionHandle> {
    let handle = LIVE_SESSIONS
        .lock()
        .expect("live transcription registry poisoned")
        .remove(session_id)?;
    handle.stop.store(true, Ordering::Release);
    Some(handle)
}

/// Waits for a signalled live loop to finish its in-flight work, aborting it
/// after [`DRAIN_TIMEOUT`] so one hung provider request can never hold up the
/// final pass indefinitely. The loop must be fully terminated when this
/// returns: a still-running task could persist a provisional row *after*
/// reconciliation pruned the session, leaving a stale row behind.
pub async fn drain(mut handle: LiveSessionHandle) {
    if tokio::time::timeout(DRAIN_TIMEOUT, &mut handle.task)
        .await
        .is_err()
    {
        tracing::warn!(
            session_id = %handle.session_id,
            "live transcription did not stop in time; aborting it"
        );
        handle.task.abort();
        let _ = handle.task.await;
        // The aborted loop never reached its own cleanup.
        let _ = std::fs::remove_dir_all(session_temp_dir(LIVE_TEMP_PREFIX, &handle.session_id));
    }
}

pub async fn stop_and_drain(session_id: &str) {
    if let Some(handle) = signal_stop(session_id) {
        drain(handle).await;
    }
}

pub(crate) struct LiveSessionState {
    /// Turns already attempted (successfully or not), as (source, start, end).
    attempted: Vec<(String, i64, i64)>,
    /// Successful transcripts in completion order, used as rolling context.
    completed: Vec<SourceTranscriptInput>,
    /// Per-source RMS windows accumulated across ticks, so each tick reads
    /// only the audio appended since the previous one.
    rms_caches: HashMap<String, RmsWindowCache>,
    transcribed_turns: usize,
    failed_turns: usize,
}

impl LiveSessionState {
    pub(crate) fn new() -> Self {
        Self {
            attempted: Vec::new(),
            completed: Vec::new(),
            rms_caches: HashMap::new(),
            transcribed_turns: 0,
            failed_turns: 0,
        }
    }

    fn already_attempted(&self, turn: &AudioTurn) -> bool {
        self.attempted.iter().any(|(source, start_ms, end_ms)| {
            if source != &turn.source {
                return false;
            }
            let overlap = turn
                .end_ms
                .min(*end_ms)
                .saturating_sub(turn.start_ms.max(*start_ms)) as f64;
            let shorter = (turn.end_ms - turn.start_ms).min(end_ms - start_ms).max(1) as f64;
            overlap / shorter >= ATTEMPTED_OVERLAP
        })
    }

    fn mark_attempted(&mut self, turn: &AudioTurn) {
        self.attempted
            .push((turn.source.clone(), turn.start_ms, turn.end_ms));
    }
}

pub(crate) struct LiveTickContext {
    pub(crate) note_id: String,
    pub(crate) session_id: String,
    pub(crate) source_mode: RecordingSourceMode,
    pub(crate) title: String,
    pub(crate) provider: String,
    pub(crate) dictionary_context: Option<String>,
    pub(crate) temp_dir: PathBuf,
    pub(crate) sources: Vec<LiveSourceInput>,
}

async fn run_live_session(
    repos: Repositories,
    note_id: String,
    session_id: String,
    source_mode: RecordingSourceMode,
    sources: Vec<LiveSourceInput>,
    stop: Arc<AtomicBool>,
) {
    let temp_dir = session_temp_dir(LIVE_TEMP_PREFIX, &session_id);
    let _ = std::fs::remove_dir_all(&temp_dir);
    if std::fs::create_dir_all(&temp_dir).is_err() {
        return;
    }
    let title = repos
        .get_note(&note_id)
        .await
        .map(|note| note.title)
        .unwrap_or_default();
    let dictionary_context = match repos.list_dictionary_entries().await {
        Ok(entries) => build_dictionary_context(&entries),
        Err(_) => None,
    };
    let context = LiveTickContext {
        note_id,
        session_id: session_id.clone(),
        source_mode,
        title,
        provider: crate::providers::configured_transcription_provider(),
        dictionary_context,
        temp_dir: temp_dir.clone(),
        sources,
    };
    let transcriber = default_turn_transcriber();
    let mut state = LiveSessionState::new();

    let mut last_tick = Instant::now();
    loop {
        if stop.load(Ordering::Acquire) {
            break;
        }
        if last_tick.elapsed() < LIVE_TICK_INTERVAL {
            tokio::time::sleep(STOP_POLL_INTERVAL).await;
            continue;
        }
        last_tick = Instant::now();
        if let Err(error) = run_live_tick(&repos, &context, &mut state, &transcriber, &stop).await {
            tracing::debug!(
                %session_id,
                code = %error.code,
                message = %error.message,
                "live transcription tick skipped"
            );
        }
    }

    let _ = repos
        .add_checkpoint(
            &session_id,
            "live_transcription",
            Some(
                serde_json::json!({
                    "turnsTranscribed": state.transcribed_turns,
                    "turnsFailed": state.failed_turns,
                })
                .to_string(),
            ),
        )
        .await;
    let _ = std::fs::remove_dir_all(&temp_dir);
}

/// One detection + transcription pass over the in-progress source files.
pub(crate) async fn run_live_tick(
    repos: &Repositories,
    context: &LiveTickContext,
    state: &mut LiveSessionState,
    transcriber: &TurnTranscriber,
    stop: &Arc<AtomicBool>,
) -> Result<(), AppError> {
    let mut detected = Vec::new();
    let mut source_durations: HashMap<String, i64> = HashMap::new();
    for source in &context.sources {
        let artifact_id = source.artifact_id.clone();
        let source_name = source.source.clone();
        let path = source.partial_path.clone();
        let mut cache = state.rms_caches.remove(&source.source).unwrap_or_default();
        let (result, cache) = tokio::task::spawn_blocking(move || {
            let result = detect_partial_turns(&artifact_id, &source_name, &path, &mut cache);
            (result, cache)
        })
        .await
        .map_err(|error| AppError::new("audio_live_read_failed", error.to_string()))?;
        state.rms_caches.insert(source.source.clone(), cache);
        match result {
            Ok((info, mut turns)) => {
                source_durations.insert(source.source.clone(), info.duration_ms());
                detected.append(&mut turns);
            }
            Err(error) => {
                // The partial file may not exist yet (or was just finalized);
                // skip the source this tick.
                tracing::debug!(
                    source = %source.source,
                    code = %error.code,
                    "live detection skipped for source"
                );
            }
        }
    }
    if detected.is_empty() {
        return Ok(());
    }

    let turns = coalesce_turns_for_transcription(detected);
    for turn in turns {
        if stop.load(Ordering::Acquire) {
            break;
        }
        let source_duration = source_durations
            .get(&turn.source)
            .copied()
            .unwrap_or_default();
        if turn.end_ms + LIVE_EDGE_PADDING_MS > source_duration {
            continue;
        }
        if state.already_attempted(&turn) {
            continue;
        }
        state.mark_attempted(&turn);
        transcribe_live_turn(repos, context, state, transcriber, &turn, stop).await;
    }
    Ok(())
}

async fn transcribe_live_turn(
    repos: &Repositories,
    context: &LiveTickContext,
    state: &mut LiveSessionState,
    transcriber: &TurnTranscriber,
    turn: &AudioTurn,
    stop: &Arc<AtomicBool>,
) {
    let started = Instant::now();
    let result = prepare_and_transcribe_live_turn(context, state, transcriber, turn, stop).await;
    let status = if result.is_ok() {
        "succeeded"
    } else {
        "failed"
    };
    let _ = repos
        .add_source_checkpoint(
            &context.session_id,
            Some(&turn.artifact_id),
            Some(&turn.source),
            "live_transcription_request",
            Some(
                serde_json::json!({
                    "durationMs": elapsed_ms(started),
                    "status": status,
                    "startMs": turn.start_ms,
                    "endMs": turn.end_ms,
                })
                .to_string(),
            ),
        )
        .await;
    match result {
        Ok(transcript) => {
            let text = transcript.text.trim().to_string();
            if text.is_empty() {
                state.failed_turns += 1;
                return;
            }
            // Provisional rows are keyed by start time: chronologically
            // ordered for display, collision-free per source, and replaced by
            // final-index rows during reconciliation after the recording ends.
            let provisional_index = turn.start_ms;
            match repos
                .upsert_successful_source_turn_transcript(
                    &context.note_id,
                    &context.session_id,
                    &turn.artifact_id,
                    context.source_mode,
                    &turn.source,
                    &text,
                    transcript.language.clone(),
                    &transcript.provider,
                    turn.start_ms,
                    turn.end_ms,
                    provisional_index,
                )
                .await
            {
                Ok(row) => {
                    tracing::info!(
                        session_id = %context.session_id,
                        source = %turn.source,
                        start_ms = turn.start_ms,
                        end_ms = turn.end_ms,
                        transcript_id = %row.id,
                        "persisted live turn transcript"
                    );
                    state.transcribed_turns += 1;
                    state.completed.push(SourceTranscriptInput {
                        source: turn.source.clone(),
                        text,
                        valid: true,
                        warning: None,
                        start_ms: Some(turn.start_ms),
                        end_ms: Some(turn.end_ms),
                        turn_index: Some(provisional_index),
                    });
                }
                Err(error) => {
                    state.failed_turns += 1;
                    tracing::warn!(
                        session_id = %context.session_id,
                        %error,
                        "could not persist live turn transcript"
                    );
                }
            }
        }
        Err(error) => {
            state.failed_turns += 1;
            tracing::debug!(
                session_id = %context.session_id,
                source = %turn.source,
                start_ms = turn.start_ms,
                code = %error.code,
                "live turn transcription failed; final processing will retry it"
            );
        }
    }
}

async fn prepare_and_transcribe_live_turn(
    context: &LiveTickContext,
    state: &LiveSessionState,
    transcriber: &TurnTranscriber,
    turn: &AudioTurn,
    stop: &Arc<AtomicBool>,
) -> Result<crate::scribe_api::TranscriptionProviderResult, AppError> {
    let segment_path = context.temp_dir.join(format!(
        "live-{}-{}-{}.wav",
        turn.source, turn.start_ms, turn.end_ms
    ));
    let normalized_path = context.temp_dir.join(format!(
        "live-{}-{}-{}-normalized.wav",
        turn.source, turn.start_ms, turn.end_ms
    ));
    let chunk_stem = format!("live-{}-{}", turn.source, turn.start_ms);
    let result = transcribe_extracted_live_turn(
        context,
        state,
        transcriber,
        turn,
        stop,
        &segment_path,
        &normalized_path,
        &chunk_stem,
    )
    .await;
    // The session temp dir is only removed when the loop ends; clean this
    // turn's files (on success *and* failure) so they don't pile up over a
    // long recording.
    let _ = std::fs::remove_file(&segment_path);
    let _ = std::fs::remove_file(&normalized_path);
    remove_turn_chunks(&context.temp_dir.join("chunks"), &chunk_stem);
    result
}

/// Removes the split-chunk WAVs a long turn may have produced.
fn remove_turn_chunks(chunk_dir: &std::path::Path, chunk_stem: &str) {
    let Ok(entries) = std::fs::read_dir(chunk_dir) else {
        return;
    };
    for entry in entries.flatten() {
        if entry.file_name().to_string_lossy().starts_with(chunk_stem) {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn transcribe_extracted_live_turn(
    context: &LiveTickContext,
    state: &LiveSessionState,
    transcriber: &TurnTranscriber,
    turn: &AudioTurn,
    stop: &Arc<AtomicBool>,
    segment_path: &std::path::Path,
    normalized_path: &std::path::Path,
    chunk_stem: &str,
) -> Result<crate::scribe_api::TranscriptionProviderResult, AppError> {
    let source_path = turn.source_path.clone();
    let (start_ms, end_ms) = (turn.start_ms, turn.end_ms);
    let extract_segment = segment_path.to_path_buf();
    let normalize_target = normalized_path.to_path_buf();
    let audio_path = tokio::task::spawn_blocking(move || {
        crate::audio::live::extract_partial_turn_wav(
            &source_path,
            start_ms,
            end_ms,
            &extract_segment,
        )?;
        normalize_wav_for_transcription(&extract_segment, &normalize_target)
    })
    .await
    .map_err(|error| AppError::new("audio_live_read_failed", error.to_string()))??;

    let base_context = merge_transcription_context(
        context.dictionary_context.as_deref(),
        build_transcription_context(&state.completed).as_deref(),
    );
    let transcript = transcribe_prepared_audio(
        Arc::clone(transcriber),
        TranscribePreparedAudioRequest {
            provider: context.provider.clone(),
            audio_path,
            temp_dir: context.temp_dir.clone(),
            chunk_stem: chunk_stem.to_string(),
            title: context.title.clone(),
            base_context: base_context.clone(),
            operation_id: format!(
                "{}-{}-live-{}",
                turn.artifact_id, turn.source, turn.start_ms
            ),
            source: turn.source.clone(),
            start_ms: Some(turn.start_ms),
            end_ms: Some(turn.end_ms),
            turn_index: None,
            stop: Some(Arc::clone(stop)),
        },
    )
    .await?;
    Ok(
        maybe_post_process_note_transcript(&context.provider, transcript, base_context.as_deref())
            .await,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{migrations::run_migrations, repositories::Repositories};
    use crate::domain::processing::TranscriptionFuture;
    use crate::scribe_api::{TranscriptionProviderResult, TranscriptionRequest};
    use hound::{SampleFormat, WavSpec, WavWriter};
    use sqlx::sqlite::SqlitePoolOptions;
    use std::path::Path;
    use std::sync::atomic::AtomicUsize;

    async fn test_repositories() -> Repositories {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .expect("in-memory sqlite should open");
        run_migrations(&pool).await.expect("migrations should run");
        Repositories::new(pool)
    }

    fn write_partial_wav(path: &Path, samples: &[i16]) {
        let spec = WavSpec {
            channels: 1,
            sample_rate: 16_000,
            bits_per_sample: 16,
            sample_format: SampleFormat::Int,
        };
        let mut writer = WavWriter::create(path, spec).unwrap();
        for sample in samples {
            writer.write_sample(*sample).unwrap();
        }
        writer.finalize().unwrap();
        // Simulate an in-progress file: zero out the header sizes the writer
        // only patches on finalize.
        let mut bytes = std::fs::read(path).unwrap();
        bytes[4..8].fill(0);
        let data_pos = bytes
            .windows(4)
            .position(|window| window == b"data")
            .unwrap();
        bytes[data_pos + 4..data_pos + 8].fill(0);
        std::fs::write(path, bytes).unwrap();
    }

    fn tone(frames: usize) -> Vec<i16> {
        (0..frames)
            .map(|index| {
                let phase = index as f32 / 32.0;
                ((phase * 2.0 * std::f32::consts::PI).sin() * 12_000.0) as i16
            })
            .collect()
    }

    fn counting_transcriber(counter: Arc<AtomicUsize>) -> TurnTranscriber {
        Arc::new(move |request: TranscriptionRequest| {
            let counter = Arc::clone(&counter);
            Box::pin(async move {
                counter.fetch_add(1, Ordering::SeqCst);
                Ok(TranscriptionProviderResult {
                    text: format!("transcript for {}", request.operation_id()),
                    language: Some("en".to_string()),
                    provider: "test".to_string(),
                }) as Result<TranscriptionProviderResult, AppError>
            }) as TranscriptionFuture
        }) as TurnTranscriber
    }

    async fn tick_fixture(
        repos: &Repositories,
        dir: &Path,
        samples: &[i16],
    ) -> (LiveTickContext, LiveSessionState) {
        let note = repos.create_note(None).await.expect("note");
        let session_id = "live-session".to_string();
        let partial_path = dir.join("microphone.partial.wav");
        write_partial_wav(&partial_path, samples);
        repos
            .create_recording_session(
                &note.id,
                &session_id,
                RecordingSourceMode::MicrophonePlusSystem,
                &partial_path.to_string_lossy(),
                &dir.join("microphone.wav").to_string_lossy(),
                None,
            )
            .await
            .expect("session");
        let artifact = repos
            .create_pending_source_artifact(
                &note.id,
                &session_id,
                "microphone",
                &partial_path.to_string_lossy(),
                &dir.join("microphone.wav").to_string_lossy(),
            )
            .await
            .expect("artifact");
        let context = LiveTickContext {
            note_id: note.id,
            session_id,
            source_mode: RecordingSourceMode::MicrophonePlusSystem,
            title: "Meeting".to_string(),
            provider: crate::providers::OPENAI_PROVIDER.to_string(),
            dictionary_context: None,
            temp_dir: dir.join("temp"),
            sources: vec![LiveSourceInput {
                artifact_id: artifact.id,
                source: "microphone".to_string(),
                partial_path,
            }],
        };
        std::fs::create_dir_all(&context.temp_dir).unwrap();
        (context, LiveSessionState::new())
    }

    /// 2s speech, 8s silence: one turn ending 8s before the live edge.
    fn eligible_turn_samples() -> Vec<i16> {
        let mut samples = tone(32_000);
        samples.extend(std::iter::repeat(0).take(128_000));
        samples
    }

    #[tokio::test]
    async fn tick_transcribes_eligible_turn_and_persists_provisional_row() {
        let repos = test_repositories().await;
        let dir = tempfile::tempdir().expect("tempdir");
        let (context, mut state) = tick_fixture(&repos, dir.path(), &eligible_turn_samples()).await;
        let calls = Arc::new(AtomicUsize::new(0));
        let transcriber = counting_transcriber(Arc::clone(&calls));
        let stop = Arc::new(AtomicBool::new(false));

        run_live_tick(&repos, &context, &mut state, &transcriber, &stop)
            .await
            .expect("tick");

        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert_eq!(state.transcribed_turns, 1);
        let rows = repos
            .successful_source_turn_transcripts_for_session(&context.session_id)
            .await
            .expect("rows");
        assert_eq!(rows.len(), 1);
        let row = &rows[0];
        assert_eq!(row.source.as_deref(), Some("microphone"));
        let start_ms = row.start_ms.expect("start");
        assert_eq!(
            row.turn_index,
            Some(start_ms),
            "provisional index is the start time"
        );
        assert!(row.text.starts_with("transcript for"));

        // Same audio on the next tick: nothing new to transcribe.
        run_live_tick(&repos, &context, &mut state, &transcriber, &stop)
            .await
            .expect("second tick");
        assert_eq!(
            calls.load(Ordering::SeqCst),
            1,
            "turn must not be re-transcribed"
        );
    }

    #[tokio::test]
    async fn tick_skips_turns_near_the_live_edge() {
        let repos = test_repositories().await;
        let dir = tempfile::tempdir().expect("tempdir");
        // 2s speech then only 1s silence: too close to the live edge.
        let mut samples = tone(32_000);
        samples.extend(std::iter::repeat(0).take(16_000));
        let (context, mut state) = tick_fixture(&repos, dir.path(), &samples).await;
        let calls = Arc::new(AtomicUsize::new(0));
        let transcriber = counting_transcriber(Arc::clone(&calls));
        let stop = Arc::new(AtomicBool::new(false));

        run_live_tick(&repos, &context, &mut state, &transcriber, &stop)
            .await
            .expect("tick");

        assert_eq!(calls.load(Ordering::SeqCst), 0);
        assert_eq!(state.transcribed_turns, 0);
        let rows = repos
            .successful_source_turn_transcripts_for_session(&context.session_id)
            .await
            .expect("rows");
        assert!(rows.is_empty());
    }

    #[tokio::test]
    async fn failed_live_turn_is_not_persisted_and_not_retried_live() {
        let repos = test_repositories().await;
        let dir = tempfile::tempdir().expect("tempdir");
        let (context, mut state) = tick_fixture(&repos, dir.path(), &eligible_turn_samples()).await;
        let calls = Arc::new(AtomicUsize::new(0));
        let failing: TurnTranscriber = {
            let calls = Arc::clone(&calls);
            Arc::new(move |_request: TranscriptionRequest| {
                let calls = Arc::clone(&calls);
                Box::pin(async move {
                    calls.fetch_add(1, Ordering::SeqCst);
                    Err(AppError::new("transcription_failed", "provider offline"))
                }) as TranscriptionFuture
            })
        };
        let stop = Arc::new(AtomicBool::new(false));

        run_live_tick(&repos, &context, &mut state, &failing, &stop)
            .await
            .expect("tick");
        run_live_tick(&repos, &context, &mut state, &failing, &stop)
            .await
            .expect("second tick");

        assert_eq!(
            calls.load(Ordering::SeqCst),
            1,
            "a failed live turn is left for final processing, not hammered"
        );
        assert_eq!(state.failed_turns, 1);
        let rows = repos
            .successful_source_turn_transcripts_for_session(&context.session_id)
            .await
            .expect("rows");
        assert!(rows.is_empty());
    }

    #[tokio::test]
    async fn stop_flag_prevents_new_turn_transcriptions() {
        let repos = test_repositories().await;
        let dir = tempfile::tempdir().expect("tempdir");
        let (context, mut state) = tick_fixture(&repos, dir.path(), &eligible_turn_samples()).await;
        let calls = Arc::new(AtomicUsize::new(0));
        let transcriber = counting_transcriber(Arc::clone(&calls));
        let stop = Arc::new(AtomicBool::new(true));

        run_live_tick(&repos, &context, &mut state, &transcriber, &stop)
            .await
            .expect("tick");

        assert_eq!(calls.load(Ordering::SeqCst), 0);
    }
}
