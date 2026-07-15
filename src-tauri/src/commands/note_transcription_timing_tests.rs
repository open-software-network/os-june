use super::{
    finish_recording_session_with_timing,
    note_transcription_benchmark::{
        benchmark_repositories, spawn_fake_june_api, BenchmarkClock, RequestEvents,
    },
};
use crate::{
    audio::capture::{FinishedRecording, FinishedSource},
    domain::{
        processing::ProcessingTiming,
        types::{
            AudioLevelDto, ProcessingStatus, RecordingSessionDto, RecordingSource,
            RecordingSourceMode, RecordingState,
        },
    },
};
use sqlx::row::Row;
use std::{
    ffi::OsString,
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

struct EnvGuard {
    previous: Vec<(&'static str, Option<OsString>)>,
}

impl EnvGuard {
    fn set(values: [(&'static str, String); 3]) -> Self {
        crate::os_accounts::load_local_env();
        let previous = values
            .iter()
            .map(|(name, _)| (*name, std::env::var_os(name)))
            .collect();
        for (name, value) in values {
            std::env::set_var(name, value);
        }
        Self { previous }
    }
}

impl Drop for EnvGuard {
    fn drop(&mut self) {
        for (name, value) in self.previous.drain(..) {
            if let Some(value) = value {
                std::env::set_var(name, value);
            } else {
                std::env::remove_var(name);
            }
        }
    }
}

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
    recording_session_id: &str,
    path: PathBuf,
) -> FinishedRecording {
    FinishedRecording {
        session_id: recording_session_id.to_string(),
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
            id: recording_session_id.to_string(),
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

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn done_origin_checkpoints_are_monotonic_and_single_shot() {
    let dir = tempfile::tempdir().expect("timing tempdir");
    let repos = benchmark_repositories(&dir).await;
    let note = repos.create_note(None).await.expect("timing note");
    let recording_session_id = format!("timing-{}", uuid::Uuid::new_v4());
    let audio_path = dir.path().join("timing-microphone.wav");
    write_one_second_timing_wav(&audio_path);
    let partial_path = audio_path.with_extension("partial.wav");
    repos
        .create_recording_session(
            &note.id,
            &recording_session_id,
            RecordingSourceMode::MicrophoneOnly,
            &partial_path.to_string_lossy(),
            &audio_path.to_string_lossy(),
            Some("Timing fixture".to_string()),
        )
        .await
        .expect("timing recording session");
    repos
        .create_pending_source_artifact(
            &note.id,
            &recording_session_id,
            RecordingSource::Microphone.as_db(),
            &partial_path.to_string_lossy(),
            &audio_path.to_string_lossy(),
        )
        .await
        .expect("timing microphone artifact");

    let clock = BenchmarkClock::default();
    clock.start();
    let events = RequestEvents::new(clock);
    let (address, api_handle) = spawn_fake_june_api(events).await;
    let _env = EnvGuard::set([
        ("JUNE_API_URL", format!("http://{address}")),
        ("OS_JUNE_LOCAL_DEV", "1".to_string()),
        (
            "OS_JUNE_LOCAL_DEV_BEARER_TOKEN",
            "timing-test-token".to_string(),
        ),
    ]);

    let timing = ProcessingTiming::from_done(Instant::now());
    let response = finish_recording_session_with_timing(
        &repos,
        timing_finished_recording(&note.id, &recording_session_id, audio_path),
        Instant::now(),
        timing,
    )
    .await
    .expect("finish timing recording");
    assert!(response.processing_started);

    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let status: String =
            sqlx::query_scalar::query_scalar("SELECT processing_status FROM notes WHERE id = ?")
                .bind(&note.id)
                .fetch_one(&repos.pool)
                .await
                .expect("timing note status");
        let processing_complete_count: i64 = sqlx::query_scalar::query_scalar(
            "SELECT COUNT(*)
             FROM recording_checkpoints
             WHERE recording_session_id = ? AND kind = 'processing_complete'",
        )
        .bind(&recording_session_id)
        .fetch_one(&repos.pool)
        .await
        .expect("processing-complete count");
        assert_ne!(
            status,
            ProcessingStatus::Failed.as_db(),
            "timing processing reached Failed",
        );
        if status == ProcessingStatus::Ready.as_db() && processing_complete_count >= 1 {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "timing processing did not finish"
        );
        tokio::time::sleep(Duration::from_millis(5)).await;
    }

    let rows = sqlx::query::query(
        "SELECT kind, details
         FROM recording_checkpoints
         WHERE recording_session_id = ?
           AND kind IN (
             'audio_validation',
             'processing_dequeued',
             'first_note_transcription_request',
             'first_transcript_persisted',
             'note_transcription_complete',
             'note_generation',
             'processing_complete'
           )
         ORDER BY rowid ASC",
    )
    .bind(&recording_session_id)
    .fetch_all(&repos.pool)
    .await
    .expect("timing checkpoints");

    for first_event_kind in [
        "first_note_transcription_request",
        "first_transcript_persisted",
    ] {
        assert_eq!(
            rows.iter()
                .filter(|row| row.get::<String, _>("kind") == first_event_kind)
                .count(),
            1,
            "checkpoint count for {first_event_kind}",
        );
    }

    let ordered_kinds = [
        "audio_validation",
        "processing_dequeued",
        "first_note_transcription_request",
        "first_transcript_persisted",
        "note_transcription_complete",
        "note_generation",
        "processing_complete",
    ];
    let durations = ordered_kinds
        .iter()
        .map(|expected_kind| {
            let matching = rows
                .iter()
                .filter(|row| row.get::<String, _>("kind") == *expected_kind)
                .collect::<Vec<_>>();
            assert_eq!(matching.len(), 1, "checkpoint count for {expected_kind}");
            let details = matching[0]
                .get::<Option<String>, _>("details")
                .expect("timing checkpoint details");
            let details: serde_json::Value =
                serde_json::from_str(&details).expect("timing checkpoint JSON");
            details["doneToDurationMs"]
                .as_i64()
                .unwrap_or_else(|| panic!("missing Done duration for {expected_kind}"))
        })
        .collect::<Vec<_>>();
    assert!(
        durations.windows(2).all(|pair| pair[0] <= pair[1]),
        "Done-relative checkpoints must be monotonic: {durations:?}",
    );

    api_handle.abort();
    let _ = api_handle.await;
}
