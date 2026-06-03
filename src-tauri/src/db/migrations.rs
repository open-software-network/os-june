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
    ensure_column(_pool, "transcripts", "start_ms", "INTEGER").await?;
    ensure_column(_pool, "transcripts", "end_ms", "INTEGER").await?;
    ensure_column(_pool, "transcripts", "turn_index", "INTEGER").await?;
    ensure_column(
        _pool,
        "transcripts",
        "source_mode",
        "TEXT NOT NULL DEFAULT 'microphone_only'",
    )
    .await?;
    ensure_column(_pool, "recording_checkpoints", "source", "TEXT").await?;
    ensure_column(_pool, "recording_checkpoints", "source_artifact_id", "TEXT").await?;
    ensure_column(_pool, "folders", "description", "TEXT").await?;
    // Folder names don't need to be unique — each folder has a stable
    // UUID, and the user may legitimately want two "Inbox"es etc.
    drop_index_if_exists(_pool, "idx_folders_active_name").await?;
    for statement in include_str!("../../migrations/002_source_modes.sql").split(';') {
        let statement = statement.trim();
        if !statement.is_empty() {
            sqlx::query(statement)
                .execute(_pool)
                .await
                .map_err(sqlx::migrate::MigrateError::Execute)?;
        }
    }
    for statement in include_str!("../../migrations/003_generation_blocks.sql").split(';') {
        let statement = statement.trim();
        if !statement.is_empty() {
            sqlx::query(statement)
                .execute(_pool)
                .await
                .map_err(sqlx::migrate::MigrateError::Execute)?;
        }
    }
    for statement in include_str!("../../migrations/004_dictionary.sql").split(';') {
        let statement = statement.trim();
        if !statement.is_empty() {
            sqlx::query(statement)
                .execute(_pool)
                .await
                .map_err(sqlx::migrate::MigrateError::Execute)?;
        }
    }
    for statement in include_str!("../../migrations/005_dictation_history.sql").split(';') {
        let statement = statement.trim();
        if !statement.is_empty() {
            sqlx::query(statement)
                .execute(_pool)
                .await
                .map_err(sqlx::migrate::MigrateError::Execute)?;
        }
    }
    // The dedupe DELETE in this migration scans `transcripts`, so only run it
    // until the unique index exists. Once present, there is nothing left to
    // dedupe and re-running on every startup would be wasted work.
    if !index_exists(_pool, "idx_transcripts_session_source_turn").await? {
        for statement in
            include_str!("../../migrations/006_transcript_turn_uniqueness.sql").split(';')
        {
            let statement = statement.trim();
            if !statement.is_empty() {
                sqlx::query(statement)
                    .execute(_pool)
                    .await
                    .map_err(sqlx::migrate::MigrateError::Execute)?;
            }
        }
    }
    Ok(())
}

async fn index_exists(
    pool: &SqlitePool,
    index: &str,
) -> Result<bool, sqlx::migrate::MigrateError> {
    let row = sqlx::query("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?")
        .bind(index)
        .fetch_optional(pool)
        .await
        .map_err(sqlx::migrate::MigrateError::Execute)?;
    Ok(row.is_some())
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
        match sqlx::query(&alter).execute(pool).await {
            Ok(_) => {}
            Err(error) if is_duplicate_column_error(&error, column) => {}
            Err(error) => return Err(sqlx::migrate::MigrateError::Execute(error)),
        }
    }
    Ok(())
}

fn is_duplicate_column_error(error: &sqlx::Error, column: &str) -> bool {
    let message = error.to_string().to_lowercase();
    message.contains("duplicate column name") && message.contains(&column.to_lowercase())
}

async fn drop_index_if_exists(
    pool: &SqlitePool,
    index: &str,
) -> Result<(), sqlx::migrate::MigrateError> {
    let sql = format!("DROP INDEX IF EXISTS {}", quote_sqlite_identifier(index));
    sqlx::query(&sql)
        .execute(pool)
        .await
        .map_err(sqlx::migrate::MigrateError::Execute)?;
    Ok(())
}

fn quote_sqlite_identifier(identifier: &str) -> String {
    format!("\"{}\"", identifier.replace('"', "\"\""))
}
