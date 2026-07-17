use sqlx::query::query;
use sqlx::row::Row;
use sqlx_sqlite::SqlitePool;

const LEGACY_PENDING_COMPANION_MESSAGE: &str =
    "This request may already have reached June. Check your Mac before trying a different request.";
const OUTCOME_UNKNOWN_COMPANION_MESSAGE: &str = "This request may already have reached June. Check your Mac, then choose the action again only if it is still needed.";

pub async fn run_migrations(_pool: &SqlitePool) -> Result<(), sqlx::error::Error> {
    for statement in include_str!("../../migrations/001_init.sql").split(';') {
        let statement = statement.trim();
        if !statement.is_empty() {
            query(statement).execute(_pool).await?;
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
    ensure_column(_pool, "folders", "instructions", "TEXT").await?;
    ensure_column(
        _pool,
        "folders",
        "memory_disabled",
        "INTEGER NOT NULL DEFAULT 0",
    )
    .await?;
    // Folder names don't need to be unique — each folder has a stable
    // UUID, and the user may legitimately want two "Inbox"es etc.
    drop_index_if_exists(_pool, "idx_folders_active_name").await?;
    for statement in include_str!("../../migrations/002_source_modes.sql").split(';') {
        let statement = statement.trim();
        if !statement.is_empty() {
            query(statement).execute(_pool).await?;
        }
    }
    for statement in include_str!("../../migrations/003_generation_blocks.sql").split(';') {
        let statement = statement.trim();
        if !statement.is_empty() {
            query(statement).execute(_pool).await?;
        }
    }
    for statement in include_str!("../../migrations/004_dictionary.sql").split(';') {
        let statement = statement.trim();
        if !statement.is_empty() {
            query(statement).execute(_pool).await?;
        }
    }
    for statement in include_str!("../../migrations/005_dictation_history.sql").split(';') {
        let statement = statement.trim();
        if !statement.is_empty() {
            query(statement).execute(_pool).await?;
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
                query(statement).execute(_pool).await?;
            }
        }
    }
    for statement in include_str!("../../migrations/007_agent.sql").split(';') {
        let statement = statement.trim();
        if !statement.is_empty() {
            query(statement).execute(_pool).await?;
        }
    }
    ensure_column(_pool, "agent_tasks", "hermes_session_id", "TEXT").await?;
    // `external_id` records the Hermes-side identity of hydrated agent
    // messages so concurrent hydrations cannot double-insert the same
    // message. The dedupe DELETE in this migration scans `agent_messages`,
    // so only run it until the unique index exists (matching the pattern
    // used for migration 006 above).
    ensure_column(_pool, "agent_messages", "external_id", "TEXT").await?;
    if !index_exists(_pool, "idx_agent_messages_task_external_id").await? {
        for statement in include_str!("../../migrations/008_agent_message_identity.sql").split(';')
        {
            let statement = statement.trim();
            if !statement.is_empty() {
                query(statement).execute(_pool).await?;
            }
        }
    }
    for statement in include_str!("../../migrations/009_session_folders.sql").split(';') {
        let statement = statement.trim();
        if !statement.is_empty() {
            query(statement).execute(_pool).await?;
        }
    }
    for statement in include_str!("../../migrations/010_p3a_counters.sql").split(';') {
        let statement = statement.trim();
        if !statement.is_empty() {
            query(statement).execute(_pool).await?;
        }
    }
    ensure_column(
        _pool,
        "p3a_counters",
        "reported_value",
        "INTEGER NOT NULL DEFAULT 0",
    )
    .await?;
    ensure_column(_pool, "p3a_counters", "reported_at", "TEXT").await?;
    for statement in include_str!("../../migrations/011_connectors.sql").split(';') {
        let statement = statement.trim();
        if !statement.is_empty() {
            query(statement).execute(_pool).await?;
        }
    }
    for statement in include_str!("../../migrations/012_connector_grants.sql").split(';') {
        let statement = statement.trim();
        if !statement.is_empty() {
            query(statement).execute(_pool).await?;
        }
    }
    for statement in include_str!("../../migrations/013_connector_credited_runs.sql").split(';') {
        let statement = statement.trim();
        if !statement.is_empty() {
            query(statement).execute(_pool).await?;
        }
    }
    ensure_column(_pool, "transcripts", "span_id", "TEXT").await?;
    for statement in include_str!("../../migrations/014_note_transcription_jobs.sql").split(';') {
        let statement = statement.trim();
        if !statement.is_empty() {
            query(statement).execute(_pool).await?;
        }
    }
    for statement in include_str!("../../migrations/015_memories.sql").split(';') {
        let statement = statement.trim();
        if !statement.is_empty() {
            query(statement).execute(_pool).await?;
        }
    }
    ensure_column(_pool, "notes", "revision", "INTEGER NOT NULL DEFAULT 1").await?;
    for statement in include_str!("../../migrations/016_companion.sql").split(';') {
        let statement = statement.trim();
        if !statement.is_empty() {
            query(statement).execute(_pool).await?;
        }
    }
    ensure_column(
        _pool,
        "companion_devices",
        "account_user_id",
        "TEXT NOT NULL DEFAULT ''",
    )
    .await?;
    for statement in include_str!("../../migrations/017_companion_account_scope.sql").split(';') {
        let statement = statement.trim();
        if !statement.is_empty() {
            query(statement).execute(_pool).await?;
        }
    }
    ensure_column(
        _pool,
        "companion_operations",
        "operation_state",
        "TEXT NOT NULL DEFAULT 'completed'",
    )
    .await?;
    migrate_legacy_companion_reservations(_pool).await?;
    for statement in include_str!("../../migrations/018_companion_operation_state.sql").split(';') {
        let statement = statement.trim();
        if !statement.is_empty() {
            query(statement).execute(_pool).await?;
        }
    }
    // Marks when a routine most recently entered approval mode; approval-run
    // crediting only counts runs that finished at or after this instant, so
    // earlier read-only runs never retroactively unlock autonomy.
    ensure_column(_pool, "routine_trust", "approval_since", "TEXT").await?;
    for statement in include_str!("../../migrations/014_share_keys.sql").split(';') {
        let statement = statement.trim();
        if !statement.is_empty() {
            query(statement).execute(_pool).await?;
        }
    }
    Ok(())
}

async fn migrate_legacy_companion_reservations(
    pool: &SqlitePool,
) -> Result<(), sqlx::error::Error> {
    use june_companion_protocol::{FailureCode, ResultPayload};

    let rows = query(
        "SELECT device_id, operation_id, response
         FROM companion_operations
         WHERE operation_state = 'completed'
           AND instr(CAST(response AS TEXT), ?) > 0",
    )
    .bind(LEGACY_PENDING_COMPANION_MESSAGE)
    .fetch_all(pool)
    .await?;
    for row in rows {
        let encoded: Vec<u8> = row.get("response");
        let Ok(mut response) =
            serde_json::from_slice::<june_companion_protocol::Response>(&encoded)
        else {
            continue;
        };
        let ResultPayload::Error(failure) = &mut response.result else {
            continue;
        };
        if failure.code != FailureCode::Busy
            || !failure.retryable
            || failure.message != LEGACY_PENDING_COMPANION_MESSAGE
        {
            continue;
        }
        failure.code = FailureCode::OutcomeUnknown;
        failure.message = OUTCOME_UNKNOWN_COMPANION_MESSAGE.to_string();
        failure.retryable = false;
        let Ok(encoded) = serde_json::to_vec(&response) else {
            continue;
        };
        query(
            "UPDATE companion_operations
             SET operation_state = 'pending', response = ?
             WHERE device_id = ? AND operation_id = ?",
        )
        .bind(encoded)
        .bind(row.get::<String, _>("device_id"))
        .bind(row.get::<String, _>("operation_id"))
        .execute(pool)
        .await?;
    }
    Ok(())
}

async fn index_exists(pool: &SqlitePool, index: &str) -> Result<bool, sqlx::error::Error> {
    let row = query("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?")
        .bind(index)
        .fetch_optional(pool)
        .await?;
    Ok(row.is_some())
}

async fn ensure_column(
    pool: &SqlitePool,
    table: &str,
    column: &str,
    definition: &str,
) -> Result<(), sqlx::error::Error> {
    let pragma = format!("PRAGMA table_info({table})");
    let rows = query(&pragma).fetch_all(pool).await?;
    let exists = rows
        .iter()
        .any(|row| row.get::<String, _>("name") == column);
    if !exists {
        let alter = format!("ALTER TABLE {table} ADD COLUMN {column} {definition}");
        match query(&alter).execute(pool).await {
            Ok(_) => {}
            Err(error) if is_duplicate_column_error(&error, column) => {}
            Err(error) => return Err(error),
        }
    }
    Ok(())
}

fn is_duplicate_column_error(error: &sqlx::error::Error, column: &str) -> bool {
    let message = error.to_string().to_lowercase();
    message.contains("duplicate column name") && message.contains(&column.to_lowercase())
}

async fn drop_index_if_exists(pool: &SqlitePool, index: &str) -> Result<(), sqlx::error::Error> {
    let sql = format!("DROP INDEX IF EXISTS {}", quote_sqlite_identifier(index));
    query(&sql).execute(pool).await?;
    Ok(())
}

fn quote_sqlite_identifier(identifier: &str) -> String {
    format!("\"{}\"", identifier.replace('"', "\"\""))
}
