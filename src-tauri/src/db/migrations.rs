use sqlx::SqlitePool;

pub async fn run_migrations(_pool: &SqlitePool) -> Result<(), sqlx::migrate::MigrateError> {
    for statement in include_str!("../../migrations/001_init.sql").split(';') {
        let statement = statement.trim();
        if !statement.is_empty() {
            sqlx::query(statement)
                .execute(_pool)
                .await
                .map_err(sqlx::migrate::MigrateError::Execute)?;
        }
    }
    ensure_column(
        _pool,
        "recording_sessions",
        "source_mode",
        "TEXT NOT NULL DEFAULT 'microphone_only'",
    )
    .await?;
    ensure_column(_pool, "recording_sessions", "permission_summary", "TEXT").await?;
    ensure_column(
        _pool,
        "audio_artifacts",
        "source",
        "TEXT NOT NULL DEFAULT 'microphone'",
    )
    .await?;
    ensure_column(_pool, "audio_artifacts", "partial_path", "TEXT").await?;
    ensure_column(
        _pool,
        "audio_artifacts",
        "status",
        "TEXT NOT NULL DEFAULT 'valid'",
    )
    .await?;
    ensure_column(
        _pool,
        "audio_artifacts",
        "expected_duration_ms",
        "INTEGER NOT NULL DEFAULT 0",
    )
    .await?;
    ensure_column(_pool, "audio_artifacts", "validation_summary", "TEXT").await?;
    ensure_column(_pool, "audio_artifacts", "last_error", "TEXT").await?;
    ensure_column(_pool, "transcripts", "recording_session_id", "TEXT").await?;
    ensure_column(_pool, "transcripts", "source_artifact_id", "TEXT").await?;
    ensure_column(_pool, "transcripts", "source", "TEXT").await?;
    ensure_column(
        _pool,
        "transcripts",
        "source_mode",
        "TEXT NOT NULL DEFAULT 'microphone_only'",
    )
    .await?;
    ensure_column(_pool, "recording_checkpoints", "source", "TEXT").await?;
    ensure_column(_pool, "recording_checkpoints", "source_artifact_id", "TEXT").await?;
    for statement in include_str!("../../migrations/002_source_modes.sql").split(';') {
        let statement = statement.trim();
        if !statement.is_empty() {
            sqlx::query(statement)
                .execute(_pool)
                .await
                .map_err(sqlx::migrate::MigrateError::Execute)?;
        }
    }
    Ok(())
}

async fn ensure_column(
    pool: &SqlitePool,
    table: &str,
    column: &str,
    definition: &str,
) -> Result<(), sqlx::migrate::MigrateError> {
    let pragma = format!("PRAGMA table_info({table})");
    let rows = sqlx::query(&pragma)
        .fetch_all(pool)
        .await
        .map_err(sqlx::migrate::MigrateError::Execute)?;
    let exists = rows.iter().any(|row| {
        use sqlx::Row;
        row.get::<String, _>("name") == column
    });
    if !exists {
        let alter = format!("ALTER TABLE {table} ADD COLUMN {column} {definition}");
        sqlx::query(&alter)
            .execute(pool)
            .await
            .map_err(sqlx::migrate::MigrateError::Execute)?;
    }
    Ok(())
}
