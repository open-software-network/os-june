use crate::domain::types::RecoverableRecordingDto;
use sqlx::Row;
use sqlx::SqlitePool;

pub async fn scan_recoverable_recordings(
    pool: &SqlitePool,
) -> Result<Vec<RecoverableRecordingDto>, sqlx::Error> {
    let rows = sqlx::query(
        "SELECT id, note_id, started_at, partial_path, final_path
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
        if bytes_found == 0 {
            continue;
        }
        recoveries.push(RecoverableRecordingDto {
            session_id: row.get("id"),
            note_id: row.get("note_id"),
            started_at: row.get("started_at"),
            partial_path_present: partial_bytes > 0,
            final_path_present: final_bytes > 0,
            bytes_found,
        });
    }

    Ok(recoveries)
}

fn file_size(path: Option<&str>) -> i64 {
    path.and_then(|path| std::fs::metadata(path).ok())
        .map(|metadata| metadata.len() as i64)
        .unwrap_or(0)
}
