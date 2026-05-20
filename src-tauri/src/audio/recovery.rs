use crate::domain::types::{
    RecordingSource, RecordingSourceMode, RecoverableRecordingDto, RecoverableSourceDto,
};
use sqlx::Row;
use sqlx::SqlitePool;

pub async fn scan_recoverable_recordings(
    pool: &SqlitePool,
) -> Result<Vec<RecoverableRecordingDto>, sqlx::Error> {
    let rows = sqlx::query(
        "SELECT id, note_id, source_mode, started_at, partial_path, final_path
         FROM recording_sessions
         WHERE status IN ('recording', 'paused', 'finalizing', 'validating', 'transcribing', 'generating', 'failed', 'recoverable')",
    )
    .fetch_all(pool)
    .await?;

    let mut recoveries = Vec::new();
    for row in rows {
        let partial_path: Option<String> = row.get("partial_path");
        let final_path: Option<String> = row.get("final_path");
        let partial_bytes = file_size(partial_path.as_deref());
        let final_bytes = file_size(final_path.as_deref());
        let bytes_found = partial_bytes.max(final_bytes);
        let sources = recoverable_sources(pool, row.get::<String, _>("id").as_str()).await?;
        let source_bytes = sources
            .iter()
            .map(|source| source.bytes_found)
            .max()
            .unwrap_or_default();
        if bytes_found == 0 && source_bytes == 0 {
            continue;
        }
        recoveries.push(RecoverableRecordingDto {
            session_id: row.get("id"),
            note_id: row.get("note_id"),
            source_mode: RecordingSourceMode::from(row.get::<String, _>("source_mode").as_str()),
            started_at: row.get("started_at"),
            partial_path_present: partial_bytes > 0,
            final_path_present: final_bytes > 0,
            bytes_found: bytes_found.max(source_bytes),
            sources,
        });
    }

    Ok(recoveries)
}

async fn recoverable_sources(
    pool: &SqlitePool,
    session_id: &str,
) -> Result<Vec<RecoverableSourceDto>, sqlx::Error> {
    let rows = sqlx::query(
        "SELECT source, partial_path, path, last_error
         FROM audio_artifacts
         WHERE recording_session_id = ?",
    )
    .bind(session_id)
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .filter_map(|row| {
            let partial_path: Option<String> = row.get("partial_path");
            let final_path: Option<String> = row.get("path");
            let partial_bytes = file_size(partial_path.as_deref());
            let final_bytes = file_size(final_path.as_deref());
            let bytes_found = partial_bytes.max(final_bytes);
            (bytes_found > 0).then(|| RecoverableSourceDto {
                source: RecordingSource::from(row.get::<String, _>("source").as_str()),
                partial_path_present: partial_bytes > 0,
                final_path_present: final_bytes > 0,
                bytes_found,
                last_error: row.get("last_error"),
            })
        })
        .collect())
}

fn file_size(path: Option<&str>) -> i64 {
    path.and_then(|path| std::fs::metadata(path).ok())
        .map(|metadata| metadata.len() as i64)
        .unwrap_or(0)
}
