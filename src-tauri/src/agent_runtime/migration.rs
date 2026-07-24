use super::domain::{AgentMigrationManifestDto, MigrationCounts};
use chrono::{SecondsFormat, TimeZone, Utc};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::{query::query, row::Row};
use sqlx_sqlite::{
    SqliteConnectOptions, SqliteConnection, SqlitePool, SqlitePoolOptions, SqliteRow,
};
use std::{
    collections::BTreeSet,
    fs,
    path::{Path, PathBuf},
    str::FromStr,
    time::Duration,
};
use thiserror::Error;

const MIGRATION_KEY: &str = "hermes-to-june-agent-runtime-v1";
const HERMES_GATEWAY_LAUNCHD_LABEL: &str = "ai.hermes.gateway";
const LEGACY_GATEWAY_STOP_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Debug, Clone)]
pub struct LegacyImportOptions {
    pub hermes_state_db: PathBuf,
    pub artifact_root: Option<PathBuf>,
}

#[derive(Debug, Error)]
pub enum LegacyImportError {
    #[error("legacy state database could not be read: {0}")]
    Source(#[source] sqlx::Error),
    #[error("June agent database migration failed: {0}")]
    Destination(#[source] sqlx::Error),
    #[error("legacy state metadata could not be read: {0}")]
    Metadata(#[source] std::io::Error),
}

/// Stops only gateway processes that are recorded inside June's retired Hermes
/// home and whose live command line still identifies the Hermes gateway. Stale
/// state files and unrelated Hermes installations are ignored.
pub async fn stop_legacy_hermes_runtime(hermes_home: &Path, user_home: Option<&Path>) {
    for pid in legacy_gateway_pids(hermes_home) {
        if pid == std::process::id() || !live_gateway_matches(pid).await {
            continue;
        }
        stop_legacy_gateway_process(pid).await;
    }
    #[cfg(target_os = "macos")]
    if let Some(user_home) = user_home {
        stop_legacy_launch_agent(hermes_home, user_home).await;
    }
}

fn legacy_gateway_pids(hermes_home: &Path) -> BTreeSet<u32> {
    let mut state_paths = vec![hermes_home.join("gateway_state.json")];
    if let Ok(profiles) = fs::read_dir(hermes_home.join("profiles")) {
        state_paths.extend(
            profiles
                .flatten()
                .map(|entry| entry.path().join("gateway_state.json")),
        );
    }
    state_paths
        .into_iter()
        .filter_map(|path| fs::read(path).ok())
        .filter_map(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .filter_map(|state| legacy_gateway_pid_from_state(&state))
        .collect()
}

fn legacy_gateway_pid_from_state(state: &Value) -> Option<u32> {
    if state.get("kind").and_then(Value::as_str) != Some("hermes-gateway") {
        return None;
    }
    let argv = state.get("argv").and_then(Value::as_array)?;
    let command = argv
        .iter()
        .filter_map(Value::as_str)
        .collect::<Vec<_>>()
        .join(" ");
    if !legacy_gateway_command_matches(&command) {
        return None;
    }
    state
        .get("pid")
        .and_then(Value::as_u64)
        .and_then(|pid| u32::try_from(pid).ok())
        .filter(|pid| *pid > 1)
}

fn legacy_gateway_command_matches(command: &str) -> bool {
    let normalized = command.replace('\\', "/").to_ascii_lowercase();
    normalized.contains("resources/native/hermes/")
        && normalized.contains("hermes_cli")
        && normalized.contains("gateway run")
}

#[cfg(target_os = "macos")]
async fn live_gateway_matches(pid: u32) -> bool {
    tokio::process::Command::new("/bin/ps")
        .args(["-ww", "-p", &pid.to_string(), "-o", "command="])
        .output()
        .await
        .ok()
        .filter(|output| output.status.success())
        .and_then(|output| String::from_utf8(output.stdout).ok())
        .is_some_and(|command| legacy_gateway_command_matches(&command))
}

#[cfg(target_os = "windows")]
async fn live_gateway_matches(pid: u32) -> bool {
    let script = format!("(Get-CimInstance Win32_Process -Filter 'ProcessId = {pid}').CommandLine");
    tokio::process::Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .output()
        .await
        .ok()
        .filter(|output| output.status.success())
        .and_then(|output| String::from_utf8(output.stdout).ok())
        .is_some_and(|command| legacy_gateway_command_matches(&command))
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
async fn live_gateway_matches(_pid: u32) -> bool {
    false
}

#[cfg(target_os = "macos")]
async fn stop_legacy_gateway_process(pid: u32) {
    let pid = pid as libc::pid_t;
    // SAFETY: the live command line and June-owned state file were validated
    // immediately above. Signals target that exact positive pid only.
    let _ = unsafe { libc::kill(pid, libc::SIGTERM) };
    let exited = tokio::time::timeout(LEGACY_GATEWAY_STOP_TIMEOUT, async {
        loop {
            // SAFETY: signal 0 only probes whether the validated pid exists.
            if unsafe { libc::kill(pid, 0) } != 0 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .is_ok();
    if !exited {
        // SAFETY: this is the same validated pid after a bounded graceful stop.
        let _ = unsafe { libc::kill(pid, libc::SIGKILL) };
    }
}

#[cfg(target_os = "windows")]
async fn stop_legacy_gateway_process(pid: u32) {
    let _ = tokio::time::timeout(
        LEGACY_GATEWAY_STOP_TIMEOUT,
        tokio::process::Command::new("taskkill.exe")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .status(),
    )
    .await;
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
async fn stop_legacy_gateway_process(_pid: u32) {}

#[cfg(target_os = "macos")]
async fn stop_legacy_launch_agent(hermes_home: &Path, user_home: &Path) {
    let plist = user_home
        .join("Library")
        .join("LaunchAgents")
        .join(format!("{HERMES_GATEWAY_LAUNCHD_LABEL}.plist"));
    let Ok(contents) = fs::read_to_string(&plist) else {
        return;
    };
    if !contents.contains(HERMES_GATEWAY_LAUNCHD_LABEL)
        || !contents.contains(hermes_home.to_string_lossy().as_ref())
    {
        return;
    }
    // SAFETY: getuid reads the current process's immutable real-user id.
    let uid = unsafe { libc::getuid() };
    for target in [
        format!("gui/{uid}/{HERMES_GATEWAY_LAUNCHD_LABEL}"),
        format!("user/{uid}/{HERMES_GATEWAY_LAUNCHD_LABEL}"),
    ] {
        let _ = tokio::time::timeout(
            LEGACY_GATEWAY_STOP_TIMEOUT,
            tokio::process::Command::new("/bin/launchctl")
                .args(["bootout", &target])
                .status(),
        )
        .await;
    }
    let _ = fs::remove_file(plist);
}

#[derive(Debug)]
struct LegacySession {
    id: String,
    source: String,
    model: String,
    title: String,
    started_at: f64,
    ended_at: Option<f64>,
    end_reason: Option<String>,
}

/// Imports the retired runtime's database without mutating it. All June
/// conversation writes and the success manifest commit atomically. A failed
/// import rolls those writes back and records a separate failed manifest for
/// diagnostics; the source database and its WAL files are never changed.
pub async fn import_legacy_agent_state(
    destination: &SqlitePool,
    options: &LegacyImportOptions,
) -> Result<AgentMigrationManifestDto, LegacyImportError> {
    let source_path = options.hermes_state_db.as_path();
    if !source_path.exists() {
        return Ok(empty_manifest(source_path, "source_missing"));
    }
    let fingerprint = source_fingerprint(source_path).map_err(LegacyImportError::Metadata)?;
    if let Some(existing) = successful_manifest(destination, source_path, &fingerprint).await? {
        return Ok(existing);
    }

    let source = read_only_pool(source_path).await?;
    let source_counts = source_counts(&source).await?;
    let started_at = now();
    let mut imported = MigrationCounts::default();
    let mut skipped_count = 0_u64;
    let mut errors = Vec::new();
    let completed_at = now();

    let result: Result<(), sqlx::Error> = async {
        let sessions = load_sessions(&source).await?;
        let has_active = table_has_column(&source, "messages", "active").await?;
        let mut transaction = destination.begin().await?;

        for session in sessions {
            let session_created_at = timestamp(session.started_at);
            let session_completed_at = session.ended_at.map(timestamp);
            let session_updated_at = session_completed_at
                .clone()
                .unwrap_or_else(|| session_created_at.clone());
            let imported_source = if session.source == "cron" {
                "legacy_routine"
            } else {
                "legacy_hermes"
            };
            query(
                "INSERT INTO agent_sessions
                 (id, title, status, model, safety_mode, source, created_at, updated_at,
                  completed_at, last_error)
                 VALUES (?, ?, ?, ?, 'sandboxed', ?, ?, ?, ?, ?)
                 ON CONFLICT(id) DO UPDATE SET
                   title = excluded.title, status = excluded.status, model = excluded.model,
                   source = excluded.source, created_at = excluded.created_at,
                   updated_at = excluded.updated_at, completed_at = excluded.completed_at,
                   last_error = excluded.last_error",
            )
            .bind(&session.id)
            .bind(&session.title)
            .bind(if session.ended_at.is_some() {
                "completed"
            } else {
                "idle"
            })
            .bind(&session.model)
            .bind(imported_source)
            .bind(&session_created_at)
            .bind(&session_updated_at)
            .bind(&session_completed_at)
            .bind(&session.end_reason)
            .execute(&mut *transaction)
            .await?;
            imported.sessions += 1;

            let rows = load_messages(&source, &session.id, has_active).await?;
            let mut sequence = next_sequence(&mut transaction, &session.id).await?;
            for row in rows {
                let message_id = row.try_get::<i64, _>("id").unwrap_or_default();
                let created_at = timestamp(row.try_get::<f64, _>("timestamp").unwrap_or_default());
                let role = row
                    .try_get::<String, _>("role")
                    .unwrap_or_else(|_| "user".to_string());
                let content = row.try_get::<Option<String>, _>("content").ok().flatten();
                let reasoning = first_nonempty(&row, &["reasoning", "reasoning_content"]);
                let tool_name = row.try_get::<Option<String>, _>("tool_name").ok().flatten();
                let tool_call_id = row
                    .try_get::<Option<String>, _>("tool_call_id")
                    .ok()
                    .flatten();
                let tool_calls = row
                    .try_get::<Option<String>, _>("tool_calls")
                    .ok()
                    .flatten();

                if let Some(text) = reasoning.filter(|value| !value.trim().is_empty()) {
                    if insert_item(
                        &mut transaction,
                        &session.id,
                        sequence,
                        "reasoning",
                        json!({ "text": text }),
                        &format!("hermes:{}:{}:reasoning", session.id, message_id),
                        &created_at,
                    )
                    .await?
                    {
                        imported.reasoning_items += 1;
                        sequence += 1;
                    } else {
                        skipped_count += 1;
                    }
                }

                if let Some(raw_calls) = tool_calls.filter(|value| !value.trim().is_empty()) {
                    let calls = parse_json_or_string(&raw_calls);
                    if insert_item(
                        &mut transaction,
                        &session.id,
                        sequence,
                        "tool_call",
                        json!({
                            "toolName": tool_name,
                            "toolCallId": tool_call_id,
                            "arguments": calls,
                            "result": null,
                            "status": "completed"
                        }),
                        &format!("hermes:{}:{}:tool-call", session.id, message_id),
                        &created_at,
                    )
                    .await?
                    {
                        imported.messages += 1;
                        sequence += 1;
                    } else {
                        skipped_count += 1;
                    }
                }

                if let Some(text) = content.filter(|value| !value.trim().is_empty()) {
                    let is_tool_result = role == "tool" || tool_name.is_some();
                    let (kind, payload) = if is_tool_result {
                        (
                            "tool_result",
                            json!({
                                "toolName": tool_name,
                                "toolCallId": tool_call_id,
                                "arguments": null,
                                "result": parse_json_or_string(&text),
                                "status": "completed"
                            }),
                        )
                    } else {
                        let kind = match role.as_str() {
                            "assistant" => "assistant_message",
                            "system" => "system_message",
                            _ => "user_message",
                        };
                        (kind, json!({ "role": role, "content": text }))
                    };
                    if insert_item(
                        &mut transaction,
                        &session.id,
                        sequence,
                        kind,
                        payload.clone(),
                        &format!("hermes:{}:{}:content", session.id, message_id),
                        &created_at,
                    )
                    .await?
                    {
                        imported.messages += 1;
                        sequence += 1;
                        if let Some(root) = options.artifact_root.as_deref() {
                            let candidates = artifact_candidates(&payload);
                            for candidate in candidates {
                                match copy_artifact(root, &session.id, &candidate).await {
                                    Ok(copied) => {
                                        insert_artifact(
                                            &mut transaction,
                                            &session.id,
                                            message_id,
                                            &candidate,
                                            copied.as_deref(),
                                            &created_at,
                                        )
                                        .await?;
                                        imported.artifacts += 1;
                                    }
                                    Err(error) => errors.push(format!(
                                        "session {} artifact {}: {}",
                                        session.id,
                                        candidate.display(),
                                        error
                                    )),
                                }
                            }
                        }
                    } else {
                        skipped_count += 1;
                    }
                }
            }
        }

        query(
            "INSERT INTO agent_migration_manifests
             (migration_key, source_path, source_fingerprint, status, source_counts_json,
              imported_counts_json, skipped_count, errors_json, started_at, completed_at)
             VALUES (?, ?, ?, 'completed', ?, ?, ?, ?, ?, ?)
             ON CONFLICT(migration_key) DO UPDATE SET
               source_path = excluded.source_path,
               source_fingerprint = excluded.source_fingerprint,
               status = excluded.status,
               source_counts_json = excluded.source_counts_json,
               imported_counts_json = excluded.imported_counts_json,
               skipped_count = excluded.skipped_count,
               errors_json = excluded.errors_json,
               started_at = excluded.started_at,
               completed_at = excluded.completed_at",
        )
        .bind(MIGRATION_KEY)
        .bind(source_path.to_string_lossy().as_ref())
        .bind(&fingerprint)
        .bind(serde_json::to_string(&source_counts).unwrap_or_else(|_| "{}".to_string()))
        .bind(serde_json::to_string(&imported).unwrap_or_else(|_| "{}".to_string()))
        .bind(skipped_count as i64)
        .bind(serde_json::to_string(&errors).unwrap_or_else(|_| "[]".to_string()))
        .bind(&started_at)
        .bind(&completed_at)
        .execute(&mut *transaction)
        .await?;
        transaction.commit().await
    }
    .await;

    source.close().await;
    if let Err(error) = result {
        let diagnostic = vec![error.to_string()];
        record_failed_manifest(
            destination,
            source_path,
            &fingerprint,
            &source_counts,
            &diagnostic,
            &started_at,
        )
        .await?;
        return Err(LegacyImportError::Destination(error));
    }

    Ok(AgentMigrationManifestDto {
        migration_key: MIGRATION_KEY.to_string(),
        source_path: source_path.to_string_lossy().into_owned(),
        source_fingerprint: Some(fingerprint),
        status: "completed".to_string(),
        source_counts,
        imported_counts: imported,
        skipped_count,
        errors,
        started_at,
        completed_at: Some(completed_at),
    })
}

async fn read_only_pool(path: &Path) -> Result<SqlitePool, LegacyImportError> {
    let options = SqliteConnectOptions::from_str(&format!("sqlite://{}", path.display()))
        .map_err(LegacyImportError::Source)?
        .create_if_missing(false)
        .read_only(true);
    SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await
        .map_err(LegacyImportError::Source)
}

async fn source_counts(pool: &SqlitePool) -> Result<MigrationCounts, LegacyImportError> {
    let sessions = query(
        "SELECT COUNT(*) AS count FROM sessions
         WHERE parent_session_id IS NULL
           AND lower(source) NOT IN ('subagent', 'delegate', 'delegated')",
    )
    .fetch_one(pool)
    .await
    .map_err(LegacyImportError::Source)?
    .get::<i64, _>("count") as u64;
    let messages = query(
        "SELECT COUNT(*) AS count FROM messages m
         JOIN sessions s ON s.id = m.session_id
         WHERE s.parent_session_id IS NULL
           AND lower(s.source) NOT IN ('subagent', 'delegate', 'delegated')",
    )
    .fetch_one(pool)
    .await
    .map_err(LegacyImportError::Source)?
    .get::<i64, _>("count") as u64;
    Ok(MigrationCounts {
        sessions,
        messages,
        reasoning_items: 0,
        artifacts: 0,
    })
}

async fn load_sessions(pool: &SqlitePool) -> Result<Vec<LegacySession>, sqlx::Error> {
    let rows = query(
        "SELECT id, source, model, title, started_at, ended_at, end_reason
         FROM sessions
         WHERE parent_session_id IS NULL
           AND lower(source) NOT IN ('subagent', 'delegate', 'delegated')
         ORDER BY started_at ASC, id ASC",
    )
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(|row| LegacySession {
            id: row.get("id"),
            source: row.get::<String, _>("source").to_lowercase(),
            model: row
                .try_get::<Option<String>, _>("model")
                .ok()
                .flatten()
                .unwrap_or_else(|| "auto".to_string()),
            title: row
                .try_get::<Option<String>, _>("title")
                .ok()
                .flatten()
                .filter(|value| !value.trim().is_empty())
                .unwrap_or_else(|| "Imported session".to_string()),
            started_at: row.get("started_at"),
            ended_at: row.try_get("ended_at").ok().flatten(),
            end_reason: row.try_get("end_reason").ok().flatten(),
        })
        .collect())
}

async fn load_messages(
    pool: &SqlitePool,
    session_id: &str,
    has_active: bool,
) -> Result<Vec<SqliteRow>, sqlx::Error> {
    let sql = if has_active {
        "SELECT id, role, content, tool_call_id, tool_calls, tool_name, timestamp,
                reasoning, reasoning_content
         FROM messages WHERE session_id = ? AND active = 1 ORDER BY timestamp ASC, id ASC"
    } else {
        "SELECT id, role, content, tool_call_id, tool_calls, tool_name, timestamp,
                reasoning, reasoning_content
         FROM messages WHERE session_id = ? ORDER BY timestamp ASC, id ASC"
    };
    query(sql).bind(session_id).fetch_all(pool).await
}

async fn table_has_column(
    pool: &SqlitePool,
    table: &str,
    column: &str,
) -> Result<bool, sqlx::Error> {
    let rows = query(&format!("PRAGMA table_info({table})"))
        .fetch_all(pool)
        .await?;
    Ok(rows
        .iter()
        .any(|row| row.get::<String, _>("name") == column))
}

async fn next_sequence(
    transaction: &mut SqliteConnection,
    session_id: &str,
) -> Result<i64, sqlx::Error> {
    query("SELECT COALESCE(MAX(sequence), -1) + 1 AS next FROM agent_items WHERE session_id = ?")
        .bind(session_id)
        .fetch_one(&mut *transaction)
        .await
        .map(|row| row.get("next"))
}

async fn insert_item(
    transaction: &mut SqliteConnection,
    session_id: &str,
    sequence: i64,
    kind: &str,
    payload: Value,
    external_id: &str,
    created_at: &str,
) -> Result<bool, sqlx::Error> {
    let id = deterministic_id("item", external_id);
    query(
        "INSERT OR IGNORE INTO agent_items
         (id, session_id, sequence, kind, payload_json, external_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(id)
    .bind(session_id)
    .bind(sequence)
    .bind(kind)
    .bind(payload.to_string())
    .bind(external_id)
    .bind(created_at)
    .execute(&mut *transaction)
    .await
    .map(|result| result.rows_affected() == 1)
}

async fn insert_artifact(
    transaction: &mut SqliteConnection,
    session_id: &str,
    message_id: i64,
    original: &Path,
    copied: Option<&Path>,
    created_at: &str,
) -> Result<(), sqlx::Error> {
    let original_string = original.to_string_lossy();
    let id = deterministic_id("artifact", &format!("{session_id}:{original_string}"));
    let path = copied.unwrap_or(original).to_string_lossy();
    let size = copied
        .and_then(|path| std::fs::metadata(path).ok())
        .map(|metadata| metadata.len() as i64);
    query(
        "INSERT OR IGNORE INTO agent_artifacts
         (id, session_id, provenance, action, path, original_path, size_bytes, available, created_at)
         VALUES (?, ?, ?, 'created', ?, ?, ?, ?, ?)",
    )
    .bind(id)
    .bind(session_id)
    .bind(format!("legacy_hermes_message:{message_id}"))
    .bind(path.as_ref())
    .bind(original_string.as_ref())
    .bind(size)
    .bind(i64::from(copied.is_some()))
    .bind(created_at)
    .execute(&mut *transaction)
    .await?;
    Ok(())
}

async fn copy_artifact(
    root: &Path,
    session_id: &str,
    source: &Path,
) -> Result<Option<PathBuf>, std::io::Error> {
    if !source.is_absolute() || !source.is_file() {
        return Ok(None);
    }
    let destination_dir = root.join(safe_component(session_id));
    tokio::fs::create_dir_all(&destination_dir).await?;
    let name = source
        .file_name()
        .and_then(|name| name.to_str())
        .map(safe_component)
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| deterministic_id("file", source.to_string_lossy().as_ref()));
    let destination = destination_dir.join(name);
    if !destination.exists() {
        tokio::fs::copy(source, &destination).await?;
    }
    Ok(Some(destination))
}

fn artifact_candidates(value: &Value) -> BTreeSet<PathBuf> {
    fn visit(value: &Value, key: Option<&str>, found: &mut BTreeSet<PathBuf>) {
        match value {
            Value::Object(map) => {
                for (child_key, child) in map {
                    visit(child, Some(child_key), found);
                }
            }
            Value::Array(items) => {
                for item in items {
                    visit(item, key, found);
                }
            }
            Value::String(path)
                if key.is_some_and(|key| {
                    matches!(
                        key,
                        "path"
                            | "filePath"
                            | "file_path"
                            | "artifactPath"
                            | "artifact_path"
                            | "outputPath"
                            | "output_path"
                    )
                }) =>
            {
                found.insert(PathBuf::from(path));
            }
            _ => {}
        }
    }
    let mut found = BTreeSet::new();
    visit(value, None, &mut found);
    found
}

async fn successful_manifest(
    pool: &SqlitePool,
    source_path: &Path,
    fingerprint: &str,
) -> Result<Option<AgentMigrationManifestDto>, LegacyImportError> {
    let row = query(
        "SELECT migration_key, source_path, source_fingerprint, status, source_counts_json,
                imported_counts_json, skipped_count, errors_json, started_at, completed_at
         FROM agent_migration_manifests
         WHERE migration_key = ? AND source_path = ? AND source_fingerprint = ? AND status = 'completed'",
    )
    .bind(MIGRATION_KEY)
    .bind(source_path.to_string_lossy().as_ref())
    .bind(fingerprint)
    .fetch_optional(pool)
    .await
    .map_err(LegacyImportError::Destination)?;
    Ok(row.map(manifest_from_row))
}

async fn record_failed_manifest(
    pool: &SqlitePool,
    source_path: &Path,
    fingerprint: &str,
    source_counts: &MigrationCounts,
    errors: &[String],
    started_at: &str,
) -> Result<(), LegacyImportError> {
    query(
        "INSERT INTO agent_migration_manifests
         (migration_key, source_path, source_fingerprint, status, source_counts_json,
          imported_counts_json, skipped_count, errors_json, started_at, completed_at)
         VALUES (?, ?, ?, 'failed', ?, '{}', 0, ?, ?, ?)
         ON CONFLICT(migration_key) DO UPDATE SET
           source_path = excluded.source_path, source_fingerprint = excluded.source_fingerprint,
           status = excluded.status, source_counts_json = excluded.source_counts_json,
           imported_counts_json = excluded.imported_counts_json,
           skipped_count = excluded.skipped_count, errors_json = excluded.errors_json,
           started_at = excluded.started_at, completed_at = excluded.completed_at",
    )
    .bind(MIGRATION_KEY)
    .bind(source_path.to_string_lossy().as_ref())
    .bind(fingerprint)
    .bind(serde_json::to_string(source_counts).unwrap_or_else(|_| "{}".to_string()))
    .bind(serde_json::to_string(errors).unwrap_or_else(|_| "[]".to_string()))
    .bind(started_at)
    .bind(now())
    .execute(pool)
    .await
    .map_err(LegacyImportError::Destination)?;
    Ok(())
}

fn manifest_from_row(row: SqliteRow) -> AgentMigrationManifestDto {
    AgentMigrationManifestDto {
        migration_key: row.get("migration_key"),
        source_path: row.get("source_path"),
        source_fingerprint: row.get("source_fingerprint"),
        status: row.get("status"),
        source_counts: serde_json::from_str(&row.get::<String, _>("source_counts_json"))
            .unwrap_or_default(),
        imported_counts: serde_json::from_str(&row.get::<String, _>("imported_counts_json"))
            .unwrap_or_default(),
        skipped_count: row.get::<i64, _>("skipped_count") as u64,
        errors: serde_json::from_str(&row.get::<String, _>("errors_json")).unwrap_or_default(),
        started_at: row.get("started_at"),
        completed_at: row.get("completed_at"),
    }
}

fn empty_manifest(path: &Path, status: &str) -> AgentMigrationManifestDto {
    AgentMigrationManifestDto {
        migration_key: MIGRATION_KEY.to_string(),
        source_path: path.to_string_lossy().into_owned(),
        source_fingerprint: None,
        status: status.to_string(),
        source_counts: MigrationCounts::default(),
        imported_counts: MigrationCounts::default(),
        skipped_count: 0,
        errors: Vec::new(),
        started_at: now(),
        completed_at: Some(now()),
    }
}

fn source_fingerprint(path: &Path) -> Result<String, std::io::Error> {
    let metadata = std::fs::metadata(path)?;
    let modified = metadata
        .modified()?
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let mut hash = Sha256::new();
    hash.update(path.to_string_lossy().as_bytes());
    hash.update(metadata.len().to_le_bytes());
    hash.update(modified.to_le_bytes());
    Ok(format!("{:x}", hash.finalize()))
}

fn first_nonempty(row: &SqliteRow, columns: &[&str]) -> Option<String> {
    columns.iter().find_map(|column| {
        row.try_get::<Option<String>, _>(*column)
            .ok()
            .flatten()
            .filter(|value| !value.trim().is_empty())
    })
}

fn parse_json_or_string(value: &str) -> Value {
    serde_json::from_str(value).unwrap_or_else(|_| Value::String(value.to_string()))
}

fn deterministic_id(namespace: &str, value: &str) -> String {
    let mut hash = Sha256::new();
    hash.update(namespace.as_bytes());
    hash.update(b":");
    hash.update(value.as_bytes());
    format!("{namespace}-{:x}", hash.finalize())
}

fn safe_component(value: &str) -> String {
    value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.') {
                character
            } else {
                '_'
            }
        })
        .collect()
}

fn timestamp(value: f64) -> String {
    let seconds = value.trunc() as i64;
    let nanos = ((value.fract().abs() * 1_000_000_000.0).round() as u32).min(999_999_999);
    Utc.timestamp_opt(seconds, nanos)
        .single()
        .unwrap_or_else(Utc::now)
        .to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

#[cfg(test)]
mod tests {
    use super::{
        legacy_gateway_command_matches, legacy_gateway_pid_from_state, stop_legacy_hermes_runtime,
    };
    use serde_json::json;
    use std::{fs, time::Duration};

    #[test]
    fn accepts_june_hermes_gateway_state() {
        let state = json!({
            "pid": 42,
            "kind": "hermes-gateway",
            "argv": [
                "/Applications/June.app/Contents/Resources/native/hermes/bin/python3",
                "-m",
                "hermes_cli.main",
                "--profile",
                "profile-2",
                "gateway",
                "run",
                "--replace"
            ]
        });

        assert_eq!(legacy_gateway_pid_from_state(&state), Some(42));
    }

    #[test]
    fn rejects_unrelated_or_incomplete_process_state() {
        assert_eq!(
            legacy_gateway_pid_from_state(&json!({
                "pid": 42,
                "kind": "other",
                "argv": ["hermes", "gateway", "run"]
            })),
            None
        );
        assert_eq!(
            legacy_gateway_pid_from_state(&json!({
                "pid": 42,
                "kind": "hermes-gateway",
                "argv": ["hermes", "status"]
            })),
            None
        );
        assert!(!legacy_gateway_command_matches(
            "/usr/bin/python unrelated_agent.py"
        ));
    }

    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn stops_only_a_live_gateway_recorded_in_junes_legacy_home() {
        let root = tempfile::tempdir().expect("temporary Hermes home");
        let mut child = tokio::process::Command::new("/bin/bash")
            .args([
                "-c",
                "exec -a '/tmp/June.app/Contents/Resources/native/hermes/hermes_cli gateway run' sleep 30",
            ])
            .spawn()
            .expect("spawn fake legacy gateway");
        let pid = child.id().expect("child pid");
        fs::write(
            root.path().join("gateway_state.json"),
            serde_json::to_vec(&json!({
                "pid": pid,
                "kind": "hermes-gateway",
                "argv": [
                    "/tmp/June.app/Contents/Resources/native/hermes/hermes_cli/main.py",
                    "gateway",
                    "run",
                    "--replace"
                ]
            }))
            .expect("serialize gateway state"),
        )
        .expect("write gateway state");

        stop_legacy_hermes_runtime(root.path(), None).await;

        tokio::time::timeout(Duration::from_secs(3), child.wait())
            .await
            .expect("gateway should stop before the timeout")
            .expect("wait for fake gateway");
    }
}
