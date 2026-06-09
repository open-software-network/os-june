use hound::{SampleFormat, WavReader, WavSpec, WavWriter};
use os_scribe_lib::app_paths::AppPaths;
use os_scribe_lib::audio_storage::compress_session_artifacts;
use os_scribe_lib::db::{migrations::run_migrations, repositories::Repositories};
use os_scribe_lib::domain::processing::materialize_retry_audio;
use os_scribe_lib::domain::types::{NoteDto, ProcessingStatus, RecordingSourceMode};
use sqlx::sqlite::SqlitePoolOptions;
use sqlx::Row;
use std::path::{Path, PathBuf};

async fn test_repositories() -> Repositories {
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect("sqlite::memory:")
        .await
        .expect("in-memory sqlite should open");
    run_migrations(&pool).await.expect("migrations should run");
    Repositories::new(pool)
}

fn write_speech_wav(path: &Path, frames: usize) {
    let spec = WavSpec {
        channels: 1,
        sample_rate: 16_000,
        bits_per_sample: 16,
        sample_format: SampleFormat::Int,
    };
    let mut writer = WavWriter::create(path, spec).unwrap();
    for index in 0..frames {
        let phase = index as f32 / 16.0;
        writer
            .write_sample(((phase * 2.0 * std::f32::consts::PI).sin() * 9_000.0) as i16)
            .unwrap();
    }
    writer.finalize().unwrap();
}

struct CompressedSession {
    repos: Repositories,
    paths: AppPaths,
    note: NoteDto,
    session_id: String,
    artifact_id: String,
    wav_path: PathBuf,
    _data_dir: tempfile::TempDir,
}

async fn validated_session() -> CompressedSession {
    let repos = test_repositories().await;
    let data_dir = tempfile::tempdir().expect("tempdir");
    let paths = AppPaths::from_data_dir(data_dir.path().join("data")).expect("paths");
    let note = repos.create_note(None).await.expect("note");
    let session_id = "session-compression".to_string();
    let session_dir = paths
        .recording_session_dir(&note.id, &session_id)
        .expect("session dir");
    std::fs::create_dir_all(&session_dir).expect("session dir create");
    let wav_path = session_dir.join("microphone.wav");
    write_speech_wav(&wav_path, 32_000);
    let partial_path = session_dir.join("microphone.partial.wav");
    repos
        .create_recording_session(
            &note.id,
            &session_id,
            RecordingSourceMode::MicrophoneOnly,
            &partial_path.to_string_lossy(),
            &wav_path.to_string_lossy(),
            None,
        )
        .await
        .expect("recording session");
    let artifact = repos
        .create_pending_source_artifact(
            &note.id,
            &session_id,
            "microphone",
            &partial_path.to_string_lossy(),
            &wav_path.to_string_lossy(),
        )
        .await
        .expect("artifact");
    let size_bytes = std::fs::metadata(&wav_path).unwrap().len() as i64;
    repos
        .finalize_source_artifact(
            &artifact.id,
            "valid",
            2_000,
            size_bytes,
            "checksum",
            2_000,
            None,
            None,
        )
        .await
        .expect("finalize artifact");
    CompressedSession {
        repos,
        paths,
        note,
        session_id,
        artifact_id: artifact.id,
        wav_path,
        _data_dir: data_dir,
    }
}

#[tokio::test]
async fn compresses_validated_artifact_and_keeps_wav_by_default_policy() {
    let session = validated_session().await;

    compress_session_artifacts(&session.repos, &session.paths, &session.session_id, true).await;

    let flac_path = session.wav_path.with_extension("flac");
    assert!(flac_path.exists(), "FLAC archive should exist");
    assert!(session.wav_path.exists(), "WAV original should be kept");

    let artifacts = session
        .repos
        .source_artifacts_for_session(&session.session_id)
        .await
        .expect("artifacts");
    assert_eq!(artifacts.len(), 1);
    let artifact = &artifacts[0];
    assert_eq!(artifact.compressed_format.as_deref(), Some("flac"));
    let compressed_size = artifact.compressed_size_bytes.expect("compressed size");
    assert!(compressed_size > 0);
    assert!(
        compressed_size < artifact.size_bytes,
        "FLAC ({compressed_size}) should be smaller than WAV ({})",
        artifact.size_bytes
    );
    let ratio = artifact.compression_ratio.expect("ratio");
    assert!(ratio > 0.0 && ratio < 1.0);

    let checkpoint = sqlx::query(
        "SELECT details FROM recording_checkpoints WHERE recording_session_id = ? AND kind = 'audio_compression'",
    )
    .bind(&session.session_id)
    .fetch_one(&session.repos.pool)
    .await
    .expect("compression checkpoint recorded");
    let detail: String = checkpoint.get("details");
    assert!(detail.contains("\"status\":\"succeeded\""));
    assert!(detail.contains("originalBytes"));
    assert!(detail.contains("compressedBytes"));
    assert!(detail.contains("compressionRatio"));
}

#[tokio::test]
async fn deletes_wav_only_after_validated_compression_when_policy_allows() {
    let session = validated_session().await;

    compress_session_artifacts(&session.repos, &session.paths, &session.session_id, false).await;

    let flac_path = session.wav_path.with_extension("flac");
    assert!(flac_path.exists(), "FLAC archive should exist");
    assert!(
        !session.wav_path.exists(),
        "WAV original should be deleted once the archive validated"
    );

    let row = sqlx::query(
        "SELECT original_removed_at, compression_status FROM audio_artifacts WHERE id = ?",
    )
    .bind(&session.artifact_id)
    .fetch_one(&session.repos.pool)
    .await
    .expect("artifact row");
    assert_eq!(
        row.get::<Option<String>, _>("compression_status")
            .as_deref(),
        Some("succeeded")
    );
    assert!(row
        .get::<Option<String>, _>("original_removed_at")
        .is_some());
}

#[tokio::test]
async fn retry_restores_wav_from_flac_archive() {
    let session = validated_session().await;
    let original_samples = WavReader::open(&session.wav_path)
        .unwrap()
        .samples::<i16>()
        .map(|sample| sample.unwrap())
        .collect::<Vec<_>>();

    compress_session_artifacts(&session.repos, &session.paths, &session.session_id, false).await;
    assert!(!session.wav_path.exists());

    let sources = session
        .repos
        .latest_valid_audio_artifact_paths(&session.note.id)
        .await
        .expect("retry sources");
    assert_eq!(sources.len(), 1);
    assert_eq!(sources[0].compression_status.as_deref(), Some("succeeded"));

    let restored = materialize_retry_audio(&session.paths, &sources[0])
        .await
        .expect("WAV should be restored from the FLAC archive");
    assert!(restored.exists());
    let restored_samples = WavReader::open(&restored)
        .unwrap()
        .samples::<i16>()
        .map(|sample| sample.unwrap())
        .collect::<Vec<_>>();
    assert_eq!(restored_samples, original_samples);
}

#[tokio::test]
async fn compression_failure_keeps_wav_and_does_not_fail_the_note() {
    let session = validated_session().await;
    std::fs::remove_file(&session.wav_path).expect("simulate missing source");

    compress_session_artifacts(&session.repos, &session.paths, &session.session_id, false).await;

    let row = sqlx::query(
        "SELECT compression_status, compression_error FROM audio_artifacts WHERE id = ?",
    )
    .bind(&session.artifact_id)
    .fetch_one(&session.repos.pool)
    .await
    .expect("artifact row");
    assert_eq!(
        row.get::<Option<String>, _>("compression_status")
            .as_deref(),
        Some("failed")
    );
    assert!(row.get::<Option<String>, _>("compression_error").is_some());

    let note = session
        .repos
        .get_note(&session.note.id)
        .await
        .expect("note");
    assert!(
        !matches!(note.processing_status, ProcessingStatus::Failed),
        "compression failure must not fail the note"
    );
}

#[tokio::test]
async fn already_compressed_artifacts_are_not_recompressed() {
    let session = validated_session().await;
    compress_session_artifacts(&session.repos, &session.paths, &session.session_id, true).await;
    let compressible = session
        .repos
        .compressible_artifacts_for_session(&session.session_id)
        .await
        .expect("compressible artifacts");
    assert!(
        compressible.is_empty(),
        "compressed artifacts must not be queued again"
    );
}
