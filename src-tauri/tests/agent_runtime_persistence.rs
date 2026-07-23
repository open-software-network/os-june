use os_june_lib::agent_runtime::{
    import_legacy_agent_state, AgentItemPayload, AgentRepository, LegacyImportOptions,
    MessagePayload,
};
use os_june_lib::db::migrations::run_migrations;
use sqlx::{query::query, row::Row};
use sqlx_sqlite::{SqliteConnectOptions, SqlitePool, SqlitePoolOptions};
use std::str::FromStr;

async fn memory_database() -> SqlitePool {
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect("sqlite::memory:")
        .await
        .expect("memory database");
    run_migrations(&pool).await.expect("migrations");
    pool
}

#[tokio::test]
async fn runtime_schema_replaces_legacy_tables_and_keeps_folder_assignments() {
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect("sqlite::memory:")
        .await
        .expect("memory database");
    for migration in [
        include_str!("../migrations/001_init.sql"),
        include_str!("../migrations/007_agent.sql"),
        include_str!("../migrations/009_session_folders.sql"),
    ] {
        for statement in migration
            .split(';')
            .map(str::trim)
            .filter(|sql| !sql.is_empty())
        {
            query(statement)
                .execute(&pool)
                .await
                .expect("legacy schema");
        }
    }
    query("ALTER TABLE agent_tasks ADD COLUMN hermes_session_id TEXT")
        .execute(&pool)
        .await
        .expect("legacy Hermes identity column");
    query("ALTER TABLE agent_messages ADD COLUMN external_id TEXT")
        .execute(&pool)
        .await
        .expect("legacy external identity column");
    query(
        "INSERT INTO folders (id, name, created_at, updated_at) VALUES ('folder-1', 'Work', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
    )
    .execute(&pool)
    .await
    .expect("folder");
    query(
        "INSERT INTO session_folders (session_id, folder_id, assigned_at) VALUES ('hermes-1', 'folder-1', '2026-01-02T00:00:00Z')",
    )
    .execute(&pool)
    .await
    .expect("folder assignment");
    query(
        "INSERT INTO agent_tasks
         (id, title, prompt, status, safety_profile, created_at, updated_at, hermes_session_id)
         VALUES ('task-1', 'Task title', 'Prompt', 'completed', 'autonomous_private',
                 '2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z', 'hermes-1')",
    )
    .execute(&pool)
    .await
    .expect("legacy task");
    query(
        "INSERT INTO agent_messages (id, task_id, role, content, created_at)
         VALUES ('message-1', 'task-1', 'user', 'Hello', '2026-01-01T00:00:00Z')",
    )
    .execute(&pool)
    .await
    .expect("legacy message");

    run_migrations(&pool).await.expect("runtime migration");

    let assignment = query("SELECT session_id FROM session_folders")
        .fetch_one(&pool)
        .await
        .expect("preserved assignment");
    assert_eq!(assignment.get::<String, _>("session_id"), "hermes-1");
    let session = query("SELECT title, source FROM agent_sessions WHERE id = 'hermes-1'")
        .fetch_one(&pool)
        .await
        .expect("imported session");
    assert_eq!(session.get::<String, _>("title"), "Task title");
    assert_eq!(session.get::<String, _>("source"), "legacy_agent_task");
    let content: String =
        query("SELECT payload_json FROM agent_items WHERE session_id = 'hermes-1'")
            .fetch_one(&pool)
            .await
            .expect("imported message")
            .get("payload_json");
    assert!(content.contains("Hello"));
    let legacy_count: i64 = query(
        "SELECT COUNT(*) AS count FROM sqlite_master
         WHERE type = 'table' AND name IN ('agent_tasks', 'agent_messages', 'agent_tool_events')",
    )
    .fetch_one(&pool)
    .await
    .expect("legacy table check")
    .get("count");
    assert_eq!(legacy_count, 0);
}

#[tokio::test]
async fn legacy_import_is_read_only_idempotent_and_filters_delegated_sessions() {
    let destination = memory_database().await;
    let directory = tempfile::tempdir().expect("temp directory");
    let source_path = directory.path().join("state.db");
    let options = SqliteConnectOptions::from_str(&format!("sqlite://{}", source_path.display()))
        .expect("source options")
        .create_if_missing(true);
    let source = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await
        .expect("source database");
    query(
        "CREATE TABLE sessions (
           id TEXT PRIMARY KEY, source TEXT NOT NULL, model TEXT, title TEXT,
           parent_session_id TEXT, started_at REAL NOT NULL, ended_at REAL, end_reason TEXT
         )",
    )
    .execute(&source)
    .await
    .expect("sessions");
    query(
        "CREATE TABLE messages (
           id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, role TEXT NOT NULL,
           content TEXT, tool_call_id TEXT, tool_calls TEXT, tool_name TEXT,
           timestamp REAL NOT NULL, reasoning TEXT, reasoning_content TEXT, active INTEGER
         )",
    )
    .execute(&source)
    .await
    .expect("messages");
    for statement in [
        "INSERT INTO sessions VALUES ('user-1', 'cli', 'model-a', 'User session', NULL, 1000, 1002, NULL)",
        "INSERT INTO sessions VALUES ('routine-1', 'cron', 'model-b', 'Daily run', NULL, 2000, 2002, NULL)",
        "INSERT INTO sessions VALUES ('child-1', 'subagent', 'model-a', 'Delegate', NULL, 3000, 3002, NULL)",
        "INSERT INTO sessions VALUES ('split-1', 'cli', 'model-a', 'Compressed child', 'user-1', 4000, 4002, NULL)",
        "INSERT INTO messages VALUES (1, 'user-1', 'user', 'Question', NULL, NULL, NULL, 1000, NULL, NULL, 1)",
        "INSERT INTO messages VALUES (2, 'user-1', 'assistant', 'Answer', NULL, NULL, NULL, 1001, 'Thought', NULL, 1)",
        "INSERT INTO messages VALUES (3, 'routine-1', 'assistant', 'Routine result', NULL, NULL, NULL, 2001, NULL, NULL, 1)",
        "INSERT INTO messages VALUES (4, 'child-1', 'assistant', 'Child result', NULL, NULL, NULL, 3001, NULL, NULL, 1)",
        "INSERT INTO messages VALUES (5, 'split-1', 'assistant', 'Split result', NULL, NULL, NULL, 4001, NULL, NULL, 1)",
    ] {
        query(statement).execute(&source).await.expect("fixture row");
    }
    source.close().await;
    let source_bytes_before = std::fs::read(&source_path).expect("source bytes");

    let options = LegacyImportOptions {
        hermes_state_db: source_path.clone(),
        artifact_root: Some(directory.path().join("artifacts")),
    };
    let first = import_legacy_agent_state(&destination, &options)
        .await
        .expect("first import");
    let second = import_legacy_agent_state(&destination, &options)
        .await
        .expect("idempotent import");

    assert_eq!(first.imported_counts.sessions, 2);
    assert_eq!(second, first);
    let sessions = AgentRepository::new(destination.clone())
        .list_sessions()
        .await
        .expect("sessions");
    assert!(sessions.iter().any(|session| session.id == "user-1"));
    assert!(sessions
        .iter()
        .any(|session| session.id == "routine-1" && session.source == "legacy_routine"));
    assert!(!sessions.iter().any(|session| session.id == "child-1"));
    assert!(!sessions.iter().any(|session| session.id == "split-1"));
    let items = AgentRepository::new(destination)
        .items("user-1")
        .await
        .expect("items");
    assert!(items.iter().any(|item| matches!(
        &item.payload,
        AgentItemPayload::AssistantMessage(MessagePayload { content, .. })
        if content == "Answer"
    )));
    assert!(items
        .iter()
        .any(|item| matches!(&item.payload, AgentItemPayload::Reasoning(_))));
    assert_eq!(
        std::fs::read(&source_path).expect("source bytes after"),
        source_bytes_before
    );
}
