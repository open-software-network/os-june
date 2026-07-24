use os_june_lib::agent_runtime::{
    import_legacy_agent_state, legacy_import_completed, AgentItemPayload, AgentRepository,
    LegacyImportOptions, MessagePayload,
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
    run_migrations(&pool).await.expect("current schema");
    for statement in [
        "DROP TABLE routine_runs",
        "DROP TABLE routines",
        "DROP TABLE agent_run_mcp_policies",
        "DROP TABLE agent_mcp_servers",
        "DROP TABLE session_folders",
        "DROP TABLE agent_artifacts",
        "DROP TABLE agent_items",
        "DROP TABLE agent_runs",
        "DROP TABLE agent_skill_settings",
        "DROP TABLE agent_migration_manifests",
        "DROP TABLE agent_sessions",
        "DELETE FROM schema_migrations WHERE version BETWEEN 32 AND 37",
    ] {
        query(statement)
            .execute(&pool)
            .await
            .expect("restore pre-runtime schema");
    }
    for migration in [
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
        "INSERT INTO sessions VALUES ('daily-brief', 'cron', 'model-b', 'Daily run', NULL, 2000, 2002, NULL)",
        "INSERT INTO sessions VALUES ('child-1', 'subagent', 'model-a', 'Delegate', NULL, 3000, 3002, NULL)",
        "INSERT INTO sessions VALUES ('split-1', 'cli', 'model-a', 'Compressed child', 'user-1', 4000, 4002, NULL)",
        "INSERT INTO messages VALUES (1, 'user-1', 'user', 'Question', NULL, NULL, NULL, 1000, NULL, NULL, 1)",
        "INSERT INTO messages VALUES (2, 'user-1', 'assistant', 'Answer', NULL, NULL, NULL, 1001, 'Thought', NULL, 1)",
        "INSERT INTO messages VALUES (3, 'daily-brief', 'assistant', 'Routine result', NULL, NULL, NULL, 2001, NULL, NULL, 1)",
        "INSERT INTO messages VALUES (4, 'child-1', 'assistant', 'Child result', NULL, NULL, NULL, 3001, NULL, NULL, 1)",
        "INSERT INTO messages VALUES (5, 'split-1', 'assistant', 'Split result', NULL, NULL, NULL, 4001, NULL, NULL, 1)",
    ] {
        query(statement).execute(&source).await.expect("fixture row");
    }
    source.close().await;
    std::fs::create_dir_all(directory.path().join("cron")).expect("cron directory");
    std::fs::write(
        directory.path().join("cron/jobs.json"),
        r#"{
          "jobs": [{
            "id": "daily-brief",
            "name": "Daily brief",
            "prompt": "Summarize my recent notes.",
            "schedule": {"kind":"cron","expr":"0 9 * * *","display":"0 9 * * *"},
            "repeat": {"times":null,"completed":4},
            "enabled": true,
            "state": "scheduled",
            "created_at": "2026-01-01T00:00:00Z",
            "next_run_at": "2026-07-25T13:00:00Z",
            "last_run_at": "2026-07-24T13:00:00Z",
            "last_status": "ok",
            "deliver": "local",
            "enabled_toolsets": ["web"],
            "script": "echo preserved-routine-output",
            "no_agent": true
          }]
        }"#,
    )
    .expect("legacy routines");
    std::fs::write(
        directory.path().join("config.yaml"),
        r#"mcp_servers:
  june_context:
    command: python
    args: [managed.py]
  todo:
    enabled: true
    command: node
    args: [server.js]
    tools:
      include: [list_tasks]
"#,
    )
    .expect("legacy MCP config");
    let source_bytes_before = std::fs::read(&source_path).expect("source bytes");

    let options = LegacyImportOptions {
        hermes_state_db: source_path.clone(),
        hermes_home: Some(directory.path().to_path_buf()),
        artifact_root: Some(directory.path().join("artifacts")),
    };
    let first = import_legacy_agent_state(&destination, &options)
        .await
        .expect("first import");
    let second = import_legacy_agent_state(&destination, &options)
        .await
        .expect("idempotent import");

    assert_eq!(first.imported_counts.sessions, 2);
    assert_eq!(first.imported_counts.routines, 1);
    assert_eq!(first.imported_counts.mcp_servers, 1);
    assert_eq!(second, first);
    let sessions = AgentRepository::new(destination.clone())
        .list_sessions()
        .await
        .expect("sessions");
    assert!(sessions.iter().any(|session| session.id == "user-1"));
    assert!(sessions
        .iter()
        .any(|session| session.id == "daily-brief" && session.source == "legacy_routine"));
    assert!(!sessions.iter().any(|session| session.id == "child-1"));
    assert!(!sessions.iter().any(|session| session.id == "split-1"));
    let items = AgentRepository::new(destination.clone())
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
    let routine_items = AgentRepository::new(destination.clone())
        .items("daily-brief")
        .await
        .expect("routine history");
    assert!(routine_items.iter().any(|item| matches!(
        &item.payload,
        AgentItemPayload::AssistantMessage(MessagePayload { content, .. }) if content == "Routine result"
    )));
    let routine = query(
        "SELECT state, enabled, next_run_at, metadata_json FROM routines WHERE id = 'daily-brief'",
    )
    .fetch_one(&destination)
    .await
    .expect("imported routine");
    assert_eq!(routine.get::<String, _>("state"), "needs_review");
    assert_eq!(routine.get::<i64, _>("enabled"), 0);
    assert!(routine.get::<Option<String>, _>("next_run_at").is_none());
    let routine_metadata: serde_json::Value =
        serde_json::from_str(&routine.get::<String, _>("metadata_json")).expect("routine metadata");
    assert_eq!(
        routine_metadata["legacyScript"],
        "echo preserved-routine-output"
    );
    assert_eq!(routine_metadata["legacyScriptExecution"], "needs_review");
    let mcp_count: i64 =
        query("SELECT COUNT(*) AS count FROM agent_mcp_servers WHERE name = 'todo'")
            .fetch_one(&destination)
            .await
            .expect("imported MCP server")
            .get("count");
    assert_eq!(mcp_count, 1);
    let managed_mcp_count: i64 =
        query("SELECT COUNT(*) AS count FROM agent_mcp_servers WHERE name = 'june_context'")
            .fetch_one(&destination)
            .await
            .expect("managed MCP server")
            .get("count");
    assert_eq!(managed_mcp_count, 0);
    assert_eq!(
        std::fs::read(&source_path).expect("source bytes after"),
        source_bytes_before
    );
}

#[tokio::test]
async fn legacy_import_recovers_routines_and_mcp_when_state_database_is_missing() {
    let destination = memory_database().await;
    let directory = tempfile::tempdir().expect("temp directory");
    std::fs::create_dir_all(directory.path().join("cron")).expect("cron directory");
    std::fs::write(
        directory.path().join("cron/jobs.json"),
        r#"[{
          "id": "companion-routine",
          "name": "Companion routine",
          "prompt": "Summarize notes.",
          "schedule": {"kind":"cron","expr":"0 9 * * *","timezone":"America/New_York"},
          "enabled": false,
          "state": "paused"
        }]"#,
    )
    .expect("routine companion");
    std::fs::write(
        directory.path().join("config.yaml"),
        "mcp_servers:\n  docs:\n    command: node\n    args: [server.js]\n",
    )
    .expect("MCP companion");
    let source_path = directory.path().join("missing-state.db");
    let options = LegacyImportOptions {
        hermes_state_db: source_path.clone(),
        hermes_home: Some(directory.path().to_path_buf()),
        artifact_root: None,
    };

    let first = import_legacy_agent_state(&destination, &options)
        .await
        .expect("companion import");
    let second = import_legacy_agent_state(&destination, &options)
        .await
        .expect("idempotent companion import");

    assert_eq!(first.status, "completed");
    assert_eq!(first.imported_counts.sessions, 0);
    assert_eq!(first.imported_counts.routines, 1);
    assert_eq!(first.imported_counts.mcp_servers, 1);
    assert_eq!(second, first);
    let timezone: String = query("SELECT timezone FROM routines WHERE id = 'companion-routine'")
        .fetch_one(&destination)
        .await
        .expect("imported routine")
        .get("timezone");
    assert_eq!(timezone, "America/New_York");
    assert!(!source_path.exists());
}

#[tokio::test]
async fn legacy_import_does_not_touch_secrets_for_a_duplicate_mcp_server() {
    let destination = memory_database().await;
    query(
        "INSERT INTO agent_mcp_servers
         (id, name, enabled, transport, command, args_json, secret_ref,
          metadata_json, tool_visibility_json, safety_json, created_at, updated_at)
         VALUES ('existing-id', 'docs', 1, 'stdio', 'existing-command', '[]',
                 'existing-secret', '{}', '{}', '{}', '2026-01-01', '2026-01-01')",
    )
    .execute(&destination)
    .await
    .expect("existing MCP server");
    let directory = tempfile::tempdir().expect("temporary migration directory");
    std::fs::write(
        directory.path().join("config.yaml"),
        "mcp_servers:\n  docs:\n    command: replacement-command\n    env:\n      TOKEN: must-not-be-staged\n",
    )
    .expect("legacy MCP config");
    let options = LegacyImportOptions {
        hermes_state_db: directory.path().join("missing-state.db"),
        hermes_home: Some(directory.path().to_path_buf()),
        artifact_root: None,
    };

    let manifest = import_legacy_agent_state(&destination, &options)
        .await
        .expect("duplicate definition is skipped without secure storage access");

    assert_eq!(manifest.imported_counts.mcp_servers, 0);
    assert_eq!(manifest.skipped_count, 1);
    let existing = query("SELECT command, secret_ref FROM agent_mcp_servers WHERE name = 'docs'")
        .fetch_one(&destination)
        .await
        .expect("existing MCP server remains");
    assert_eq!(existing.get::<String, _>("command"), "existing-command");
    assert_eq!(
        existing.get::<Option<String>, _>("secret_ref").as_deref(),
        Some("existing-secret")
    );
}

#[tokio::test]
async fn legacy_script_routine_is_copied_and_disabled_until_review() {
    let destination = memory_database().await;
    let directory = tempfile::tempdir().expect("temporary migration directory");
    let legacy_home = directory.path().join("legacy-home");
    let script_path = legacy_home.join("scripts").join("nightly.sh");
    std::fs::create_dir_all(script_path.parent().expect("script parent"))
        .expect("legacy script directory");
    std::fs::write(&script_path, "#!/bin/sh\necho preserved-output\n").expect("legacy script");
    std::fs::create_dir_all(legacy_home.join("cron")).expect("legacy cron directory");
    let jobs = serde_json::json!([{
        "id": "scripted-routine",
        "name": "Nightly cleanup",
        "prompt": "Run cleanup.",
        "schedule": {"kind": "cron", "expr": "0 2 * * *", "timezone": "America/New_York"},
        "enabled": true,
        "state": "scheduled",
        "script": script_path.to_string_lossy(),
        "no_agent": true,
        "last_error": "legacy failure detail"
    }]);
    std::fs::write(legacy_home.join("cron").join("jobs.json"), jobs.to_string())
        .expect("legacy routine");
    let storage_root = directory.path().join("june-owned-storage");
    let options = LegacyImportOptions {
        hermes_state_db: legacy_home.join("state.db"),
        hermes_home: Some(legacy_home.clone()),
        artifact_root: Some(storage_root.clone()),
    };

    let first = import_legacy_agent_state(&destination, &options)
        .await
        .expect("script routine import");
    assert_eq!(first.imported_counts.routines, 1);
    assert!(legacy_import_completed(&destination)
        .await
        .expect("completed manifest"));
    let row = query(
        "SELECT state, enabled, next_run_at, safety_mode, timezone, last_error, metadata_json
         FROM routines WHERE id = 'scripted-routine'",
    )
    .fetch_one(&destination)
    .await
    .expect("imported script routine");
    assert_eq!(row.get::<String, _>("state"), "needs_review");
    assert_eq!(row.get::<i64, _>("enabled"), 0);
    assert!(row.get::<Option<String>, _>("next_run_at").is_none());
    assert_eq!(row.get::<String, _>("safety_mode"), "sandboxed");
    assert_eq!(row.get::<String, _>("timezone"), "America/New_York");
    assert!(row
        .get::<String, _>("last_error")
        .contains("require review"));
    let metadata: serde_json::Value =
        serde_json::from_str(&row.get::<String, _>("metadata_json")).expect("routine metadata");
    assert_eq!(
        metadata["legacyScript"],
        serde_json::Value::String(script_path.to_string_lossy().into_owned())
    );
    assert_eq!(metadata["legacyScriptExecution"], "needs_review");
    assert_eq!(metadata["legacyNoAgent"], true);
    assert_eq!(metadata["legacyLastError"], "legacy failure detail");
    let copied_path = metadata["legacyScriptStoredPath"]
        .as_str()
        .map(std::path::PathBuf::from)
        .expect("June-owned script copy");
    assert!(copied_path.starts_with(&storage_root));
    assert_eq!(
        std::fs::read_to_string(&copied_path).expect("copied script contents"),
        "#!/bin/sh\necho preserved-output\n"
    );

    // A completed manifest is checked before any legacy-home filesystem work.
    // Removing the old home therefore cannot erase the imported source or make
    // a later app launch depend on the retired runtime.
    std::fs::remove_dir_all(&legacy_home).expect("remove retired home");
    let second = import_legacy_agent_state(&destination, &options)
        .await
        .expect("completed import uses June manifest only");
    assert_eq!(second, first);
    assert!(copied_path.is_file());
}
