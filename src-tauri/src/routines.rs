//! June-owned Routine persistence and dispatch.
//!
//! A Routine is a durable schedule and policy. A `routine_runs` row is first
//! claimed transactionally, then linked to the June-owned agent session/run
//! created for that execution. The claim is the single-active-run boundary: a
//! second scheduler tick, a manual trigger, or a restarted app cannot start a
//! duplicate while the original claim is live.

use crate::{
    agent_runtime::{
        AgentItemPayload, AgentRepository, AgentRuntimeHost, AgentSafetyMode, MessagePayload,
    },
    browser_broker::{BrowserBroker, RoutineBrowserGrant},
    commands::repositories,
    db::repositories::RoutineBrowserGrantRecord,
    domain::types::AppError,
};
use chrono::{DateTime, Datelike, Duration, TimeZone, Timelike, Utc};
use chrono_tz::Tz;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::{query::query, row::Row};
use sqlx_sqlite::SqlitePool;
use std::path::PathBuf;
use tauri::{AppHandle, Manager, State};
use uuid::Uuid;

const CLAIM_STALE_AFTER_MINUTES: i64 = 10;
const SCHEDULER_TICK_SECONDS: u64 = 30;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentRoutineDto {
    /// Stable June routine id. Legacy imports may deliberately preserve the
    /// retired Hermes job id here, while also storing it in `legacy_job_id`.
    pub id: String,
    pub legacy_job_id: Option<String>,
    pub name: String,
    pub prompt: String,
    pub schedule: String,
    pub timezone: String,
    pub repeat: String,
    pub deliver: String,
    pub model: String,
    pub safety_mode: AgentSafetyMode,
    pub state: String,
    pub enabled: bool,
    pub created_at: String,
    pub updated_at: String,
    pub next_run_at: Option<String>,
    pub last_run_at: Option<String>,
    pub last_status: Option<String>,
    pub last_error: Option<String>,
    pub last_delivery_error: Option<String>,
    pub metadata: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentRoutineRunDto {
    pub id: String,
    pub routine_id: String,
    pub agent_session_id: Option<String>,
    pub agent_run_id: Option<String>,
    pub trigger_kind: String,
    pub status: String,
    pub scheduled_for: Option<String>,
    pub started_at: Option<String>,
    pub completed_at: Option<String>,
    /// Concrete model resolved at claim time, never a moving `auto` alias.
    pub model: String,
    pub safety_mode: AgentSafetyMode,
    pub error_code: Option<String>,
    pub error_message: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateAgentRoutineRequest {
    pub id: Option<String>,
    pub legacy_job_id: Option<String>,
    pub name: Option<String>,
    pub prompt: String,
    pub schedule: String,
    #[serde(default = "utc_timezone")]
    pub timezone: String,
    pub repeat: Option<String>,
    pub deliver: Option<String>,
    #[serde(default = "auto_model")]
    pub model: String,
    #[serde(default)]
    pub safety_mode: Option<AgentSafetyMode>,
    pub state: Option<String>,
    pub enabled: Option<bool>,
    #[serde(default)]
    pub metadata: Value,
    pub enabled_toolsets: Option<Vec<String>>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateAgentRoutineRequest {
    pub routine_id: String,
    pub name: Option<String>,
    pub prompt: Option<String>,
    pub schedule: Option<String>,
    pub timezone: Option<String>,
    pub repeat: Option<String>,
    pub deliver: Option<String>,
    pub model: Option<String>,
    pub safety_mode: Option<AgentSafetyMode>,
    pub state: Option<String>,
    pub enabled: Option<bool>,
    pub metadata: Option<Value>,
    pub enabled_toolsets: Option<Vec<String>>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutineIdRequest {
    pub routine_id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListAgentRoutineRunsRequest {
    pub routine_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutineBrowserAccessStatus {
    pub enabled: bool,
    pub server_name: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetRoutineBrowserAccessRequest {
    pub job_id: String,
    pub enabled: bool,
}

fn utc_timezone() -> String {
    "UTC".into()
}
fn auto_model() -> String {
    "auto".into()
}
fn now() -> String {
    Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn app_error(error: sqlx::Error) -> AppError {
    AppError::new("routine_storage_failed", error.to_string())
}

fn validate_state(state: &str) -> Result<(), AppError> {
    if matches!(state, "scheduled" | "paused" | "completed" | "needs_review") {
        Ok(())
    } else {
        Err(AppError::new(
            "routine_state_invalid",
            "Unknown routine state.",
        ))
    }
}

fn normalized_model(model: &str) -> String {
    let model = model.trim();
    if model.is_empty() || model == "auto" || model == "open-software/auto" {
        crate::providers::AUTO_GENERATION_MODEL.to_string()
    } else {
        model.to_string()
    }
}

/// Create a durable Routine. The first next run is derived before insertion so
/// the scheduler can claim it without re-parsing creation data.
pub async fn create(
    pool: &SqlitePool,
    request: CreateAgentRoutineRequest,
) -> Result<AgentRoutineDto, AppError> {
    let name = request
        .name
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| prompt_title(&request.prompt));
    let prompt = request.prompt.trim();
    let schedule = request.schedule.trim();
    if prompt.is_empty() || schedule.is_empty() {
        return Err(AppError::new(
            "invalid_arguments",
            "A routine needs a name, instructions, and schedule.",
        ));
    }
    let state = request.state.unwrap_or_else(|| "scheduled".into());
    validate_state(&state)?;
    let enabled = request.enabled.unwrap_or(state == "scheduled");
    let safety_mode = request.safety_mode.unwrap_or(AgentSafetyMode::Sandboxed);
    let timezone = nonempty(request.timezone, "UTC");
    let timestamp = now();
    let next_run_at = if enabled && state == "scheduled" {
        next_run_after(schedule, &timezone, Utc::now())?.map(format_time)
    } else {
        None
    };
    let id = request.id.unwrap_or_else(|| Uuid::new_v4().to_string());
    let mut metadata = request.metadata;
    set_enabled_toolsets(
        &mut metadata,
        Some(request.enabled_toolsets.unwrap_or_default()),
    );
    query("INSERT INTO routines (id, legacy_job_id, name, prompt, schedule, timezone, repeat, deliver, model, safety_mode, state, enabled, created_at, updated_at, next_run_at, metadata_json, tool_catalog_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)")
        .bind(&id).bind(request.legacy_job_id).bind(name).bind(prompt).bind(schedule)
        .bind(timezone).bind(request.repeat.unwrap_or_else(|| "forever".into()))
        .bind(request.deliver.unwrap_or_else(|| "local".into())).bind(nonempty(request.model, "auto"))
        .bind(safety_mode.as_db()).bind(&state).bind(enabled).bind(&timestamp).bind(&timestamp)
        .bind(next_run_at).bind(metadata_json(metadata)).execute(pool).await.map_err(app_error)?;
    get(pool, &id).await
}

pub async fn list(pool: &SqlitePool) -> Result<Vec<AgentRoutineDto>, AppError> {
    query("SELECT id, legacy_job_id, name, prompt, schedule, timezone, repeat, deliver, model, safety_mode, state, enabled, created_at, updated_at, next_run_at, last_run_at, last_status, last_error, last_delivery_error, metadata_json FROM routines ORDER BY updated_at DESC, id ASC")
        .fetch_all(pool).await.map_err(app_error).map(|rows| rows.into_iter().map(routine_from_row).collect())
}

pub async fn get(pool: &SqlitePool, id: &str) -> Result<AgentRoutineDto, AppError> {
    query("SELECT id, legacy_job_id, name, prompt, schedule, timezone, repeat, deliver, model, safety_mode, state, enabled, created_at, updated_at, next_run_at, last_run_at, last_status, last_error, last_delivery_error, metadata_json FROM routines WHERE id = ?")
        .bind(id).fetch_one(pool).await.map_err(|error| if matches!(error, sqlx::Error::RowNotFound) { AppError::new("routine_not_found", "Routine was not found.") } else { app_error(error) }).map(routine_from_row)
}

pub async fn update(
    pool: &SqlitePool,
    request: UpdateAgentRoutineRequest,
) -> Result<AgentRoutineDto, AppError> {
    let current = get(pool, &request.routine_id).await?;
    let state = request.state.unwrap_or(current.state);
    validate_state(&state)?;
    let enabled = request.enabled.unwrap_or(current.enabled);
    if requires_legacy_execution_review(&current.metadata) && state == "scheduled" && enabled {
        return Err(AppError::new(
            "routine_legacy_execution_review_required",
            "This imported routine contains legacy execution settings. Create a new routine after reviewing its script and safety mode.",
        ));
    }
    let schedule = request.schedule.unwrap_or(current.schedule);
    let timezone = request.timezone.unwrap_or(current.timezone);
    if schedule.trim().is_empty() {
        return Err(AppError::new(
            "invalid_arguments",
            "A routine schedule is required.",
        ));
    }
    let next_run_at = if enabled && state == "scheduled" {
        next_run_after(&schedule, &timezone, Utc::now())?.map(format_time)
    } else {
        None
    };
    let mut metadata = request.metadata.unwrap_or(current.metadata);
    let tool_catalog_updated = request.enabled_toolsets.is_some();
    set_enabled_toolsets(&mut metadata, request.enabled_toolsets);
    query("UPDATE routines SET name = ?, prompt = ?, schedule = ?, timezone = ?, repeat = ?, deliver = ?, model = ?, safety_mode = ?, state = ?, enabled = ?, updated_at = ?, next_run_at = ?, metadata_json = ?, tool_catalog_version = CASE WHEN ? THEN 1 ELSE tool_catalog_version END, claim_token = CASE WHEN ? THEN NULL ELSE claim_token END, claimed_at = CASE WHEN ? THEN NULL ELSE claimed_at END WHERE id = ?")
        .bind(request.name.unwrap_or(current.name).trim()).bind(request.prompt.unwrap_or(current.prompt).trim())
        .bind(&schedule).bind(timezone).bind(request.repeat.unwrap_or(current.repeat))
        .bind(request.deliver.unwrap_or(current.deliver)).bind(request.model.unwrap_or(current.model))
        .bind(request.safety_mode.unwrap_or(current.safety_mode).as_db()).bind(&state).bind(enabled).bind(now())
        .bind(next_run_at).bind(metadata_json(metadata)).bind(tool_catalog_updated)
        .bind(state != "scheduled" || !enabled).bind(state != "scheduled" || !enabled).bind(&request.routine_id)
        .execute(pool).await.map_err(app_error)?;
    get(pool, &request.routine_id).await
}

pub async fn pause(pool: &SqlitePool, id: &str) -> Result<AgentRoutineDto, AppError> {
    let changed = query("UPDATE routines SET state = 'paused', enabled = 0, next_run_at = NULL, claim_token = NULL, claimed_at = NULL, updated_at = ? WHERE id = ?")
        .bind(now()).bind(id).execute(pool).await.map_err(app_error)?;
    if changed.rows_affected() == 0 {
        return Err(AppError::new("routine_not_found", "Routine was not found."));
    }
    get(pool, id).await
}

pub async fn resume(pool: &SqlitePool, id: &str) -> Result<AgentRoutineDto, AppError> {
    let current = get(pool, id).await?;
    if requires_legacy_execution_review(&current.metadata) {
        return Err(AppError::new(
            "routine_legacy_execution_review_required",
            "This imported routine contains legacy execution settings. Create a new routine after reviewing its script and safety mode.",
        ));
    }
    let next = next_run_after(&current.schedule, &current.timezone, Utc::now())?.map(format_time);
    query("UPDATE routines SET state = 'scheduled', enabled = 1, next_run_at = ?, updated_at = ? WHERE id = ?")
        .bind(next).bind(now()).bind(id).execute(pool).await.map_err(app_error)?;
    get(pool, id).await
}

pub async fn delete(pool: &SqlitePool, id: &str) -> Result<(), AppError> {
    let deleted = query("DELETE FROM routines WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await
        .map_err(app_error)?;
    if deleted.rows_affected() == 0 {
        Err(AppError::new("routine_not_found", "Routine was not found."))
    } else {
        Ok(())
    }
}

pub async fn list_runs(
    pool: &SqlitePool,
    routine_id: Option<&str>,
) -> Result<Vec<AgentRoutineRunDto>, AppError> {
    let rows = if let Some(routine_id) = routine_id {
        query("SELECT id, routine_id, agent_session_id, agent_run_id, trigger_kind, status, scheduled_for, started_at, completed_at, model, safety_mode, error_code, error_message, created_at, updated_at FROM routine_runs WHERE routine_id = ? ORDER BY created_at DESC, id DESC")
            .bind(routine_id).fetch_all(pool).await.map_err(app_error)?
    } else {
        query("SELECT id, routine_id, agent_session_id, agent_run_id, trigger_kind, status, scheduled_for, started_at, completed_at, model, safety_mode, error_code, error_message, created_at, updated_at FROM routine_runs ORDER BY created_at DESC, id DESC")
            .fetch_all(pool).await.map_err(app_error)?
    };
    Ok(rows.into_iter().map(run_from_row).collect())
}

/// Atomically claim an immediate or due execution. It deliberately does not
/// start the harness: callers can persist/reconcile the claim before external
/// work begins, and a crash leaves one recoverable queued row rather than two
/// model calls.
pub async fn claim(
    pool: &SqlitePool,
    routine_id: &str,
    trigger_kind: &str,
    require_due: bool,
) -> Result<Option<Claim>, AppError> {
    claim_with_connector_guard(pool, routine_id, trigger_kind, require_due, None).await
}

struct ConnectorClaimGuard<'a> {
    trigger_id: &'a str,
    kind: &'a str,
    account_id: &'a str,
}

async fn claim_with_connector_guard(
    pool: &SqlitePool,
    routine_id: &str,
    trigger_kind: &str,
    require_due: bool,
    connector: Option<ConnectorClaimGuard<'_>>,
) -> Result<Option<Claim>, AppError> {
    // Serialize the eligibility read with the claim write. A deferred
    // transaction can fail with SQLITE_BUSY_SNAPSHOT when a scheduler,
    // connector, and manual trigger race after reading the same free row.
    let mut transaction = pool
        .begin_with("BEGIN IMMEDIATE")
        .await
        .map_err(app_error)?;
    let trigger_id = connector.as_ref().map(|guard| guard.trigger_id);
    let trigger_guard_kind = connector.as_ref().map(|guard| guard.kind);
    let trigger_account_id = connector.as_ref().map(|guard| guard.account_id);
    let routine = query("SELECT id, name, prompt, schedule, model, safety_mode, next_run_at, metadata_json, tool_catalog_version FROM routines WHERE id = ? AND state = 'scheduled' AND enabled = 1 AND claim_token IS NULL AND NOT EXISTS (SELECT 1 FROM routine_runs active WHERE active.routine_id = routines.id AND active.status IN ('queued', 'running', 'waiting_for_user')) AND (? IS NULL OR EXISTS (SELECT 1 FROM connector_triggers trigger WHERE trigger.id = ? AND trigger.job_id = routines.id AND trigger.kind = ? AND trigger.account_id = ?))")
        .bind(routine_id).bind(trigger_id).bind(trigger_id).bind(trigger_guard_kind).bind(trigger_account_id)
        .fetch_optional(&mut *transaction).await.map_err(app_error)?;
    let Some(routine) = routine else {
        transaction.commit().await.map_err(app_error)?;
        return Ok(None);
    };
    let scheduled_for: Option<String> = routine.get("next_run_at");
    if require_due
        && scheduled_for
            .as_deref()
            .is_some_and(|value| parse_time(value).is_ok_and(|time| time > Utc::now()))
    {
        transaction.commit().await.map_err(app_error)?;
        return Ok(None);
    }
    let token = Uuid::new_v4().to_string();
    let run_id = Uuid::new_v4().to_string();
    let timestamp = now();
    let model: String = routine.get("model");
    let model = normalized_model(&model);
    let safety_mode = AgentSafetyMode::from(routine.get::<String, _>("safety_mode").as_str());
    let metadata = serde_json::from_str::<Value>(&routine.get::<String, _>("metadata_json"))
        .unwrap_or_else(|_| json!({}));
    let enabled_toolsets = enabled_toolsets_from_metadata(
        &metadata,
        routine.get::<i64, _>("tool_catalog_version") == 0,
    );
    let claimed = query("UPDATE routines SET claim_token = ?, claimed_at = ?, updated_at = ? WHERE id = ? AND claim_token IS NULL AND state = 'scheduled' AND enabled = 1")
        .bind(&token).bind(&timestamp).bind(&timestamp).bind(routine_id).execute(&mut *transaction).await.map_err(app_error)?;
    if claimed.rows_affected() != 1 {
        transaction.commit().await.map_err(app_error)?;
        return Ok(None);
    }
    query("INSERT INTO routine_runs (id, routine_id, claim_token, trigger_kind, status, scheduled_for, model, safety_mode, created_at, updated_at) VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?)")
        .bind(&run_id).bind(routine_id).bind(&token).bind(trigger_kind).bind(scheduled_for).bind(&model).bind(safety_mode.as_db()).bind(&timestamp).bind(&timestamp)
        .execute(&mut *transaction).await.map_err(app_error)?;
    transaction.commit().await.map_err(app_error)?;
    Ok(Some(Claim {
        routine_id: routine.get("id"),
        routine_name: routine.get("name"),
        prompt: routine.get("prompt"),
        model,
        safety_mode,
        enabled_toolsets,
        token,
        routine_run_id: run_id,
    }))
}

/// Claim every due routine. The caller should then call `start_claim` for each
/// result; keeping the operations separate makes scheduler tests deterministic
/// and allows bounded concurrent dispatch at the app integration layer.
pub async fn claim_due(pool: &SqlitePool) -> Result<Vec<Claim>, AppError> {
    let ids: Vec<String> = query("SELECT id FROM routines WHERE state = 'scheduled' AND enabled = 1 AND claim_token IS NULL AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at ASC, id ASC")
        .bind(now()).fetch_all(pool).await.map_err(app_error)?.into_iter().map(|row| row.get("id")).collect();
    let mut claims = Vec::new();
    for id in ids {
        if let Some(claim) = claim(pool, &id, "schedule", true).await? {
            claims.push(claim);
        }
    }
    Ok(claims)
}

/// Reconciles terminal agent runs and releases abandoned queued claims after a
/// restart. A still-running agent run remains claimed; an unstarted claim only
/// becomes eligible again after a bounded lease expiry.
pub async fn reconcile(pool: &SqlitePool) -> Result<(), AppError> {
    let timestamp = now();
    query("UPDATE routine_runs SET status = (SELECT status FROM agent_runs WHERE agent_runs.id = routine_runs.agent_run_id), completed_at = COALESCE((SELECT completed_at FROM agent_runs WHERE agent_runs.id = routine_runs.agent_run_id), completed_at), error_code = COALESCE((SELECT error_code FROM agent_runs WHERE agent_runs.id = routine_runs.agent_run_id), error_code), error_message = COALESCE((SELECT error_message FROM agent_runs WHERE agent_runs.id = routine_runs.agent_run_id), error_message), updated_at = ? WHERE agent_run_id IS NOT NULL AND status IN ('running', 'waiting_for_user') AND EXISTS (SELECT 1 FROM agent_runs WHERE agent_runs.id = routine_runs.agent_run_id AND agent_runs.status IN ('completed', 'cancelled', 'interrupted', 'failed'))")
        .bind(&timestamp).execute(pool).await.map_err(app_error)?;
    let stale_before = format_time(Utc::now() - Duration::minutes(CLAIM_STALE_AFTER_MINUTES));
    query("UPDATE routine_runs SET status = 'interrupted', completed_at = ?, error_code = 'routine_claim_expired', error_message = 'Routine dispatch did not start before its claim expired.', updated_at = ? WHERE status = 'queued' AND agent_run_id IS NULL AND updated_at < ?")
        .bind(&timestamp).bind(&timestamp).bind(stale_before).execute(pool).await.map_err(app_error)?;
    // A terminal run releases exactly its matching routine claim. Advance the
    // schedule here rather than leaving a past `next_run_at`, which would
    // otherwise immediately re-run a completed routine on the next tick.
    let terminal = query("SELECT routines.id, routines.schedule, routines.timezone, routines.repeat, routines.metadata_json, routines.state, routines.enabled, routine_runs.claim_token, routine_runs.status, routine_runs.completed_at, routine_runs.error_message FROM routines JOIN routine_runs ON routine_runs.routine_id = routines.id AND routine_runs.claim_token = routines.claim_token WHERE routines.claim_token IS NOT NULL AND routine_runs.status IN ('completed', 'cancelled', 'interrupted', 'failed')")
        .fetch_all(pool).await.map_err(app_error)?;
    for row in terminal {
        let state: String = row.get("state");
        let enabled = row.get::<i64, _>("enabled") != 0;
        let mut metadata = parse_metadata(row.get::<String, _>("metadata_json"));
        let repeat_completed = advance_repeat(&row.get::<String, _>("repeat"), &mut metadata);
        let next_run_at = if state == "scheduled" && enabled && !repeat_completed {
            next_run_after(
                &row.get::<String, _>("schedule"),
                &row.get::<String, _>("timezone"),
                Utc::now(),
            )?
            .map(format_time)
        } else {
            None
        };
        let status: String = row.get("status");
        query("UPDATE routines SET claim_token = NULL, claimed_at = NULL, next_run_at = ?, state = CASE WHEN ? THEN 'completed' ELSE state END, enabled = CASE WHEN ? THEN 0 ELSE enabled END, metadata_json = ?, last_run_at = COALESCE(?, ?), last_status = ?, last_error = ?, updated_at = ? WHERE id = ? AND claim_token = ?")
            .bind(next_run_at)
            .bind(repeat_completed)
            .bind(repeat_completed)
            .bind(metadata_json(metadata))
            .bind(row.get::<Option<String>, _>("completed_at"))
            .bind(&timestamp)
            .bind(if status == "completed" { "ok" } else { "error" })
            .bind(row.get::<Option<String>, _>("error_message"))
            .bind(&timestamp)
            .bind(row.get::<String, _>("id"))
            .bind(row.get::<String, _>("claim_token"))
            .execute(pool).await.map_err(app_error)?;
    }
    Ok(())
}

fn advance_repeat(repeat: &str, metadata: &mut Value) -> bool {
    let maximum = match repeat.trim().to_ascii_lowercase().as_str() {
        "forever" | "" => None,
        "once" => Some(1_u64),
        value => value.parse::<u64>().ok(),
    };
    let completed = metadata
        .get("repeatState")
        .and_then(|state| state.get("completed"))
        .and_then(Value::as_u64)
        .unwrap_or(0)
        .saturating_add(1);
    if !metadata.is_object() {
        *metadata = json!({});
    }
    if !metadata["repeatState"].is_object() {
        metadata["repeatState"] = json!({});
    }
    metadata["repeatState"]["completed"] = json!(completed);
    maximum.is_some_and(|maximum| completed >= maximum)
}

/// Reconcile claims left by a previous desktop process before starting a new
/// scheduler. The runtime child is process-owned and cannot survive an app
/// restart, so an old `running`/`waiting_for_user` run must not retain the
/// single-flight lease forever. This is deliberately separate from `reconcile`
/// because calling it during normal scheduler ticks would interrupt live work.
pub async fn reconcile_after_restart(pool: &SqlitePool) -> Result<(), AppError> {
    let timestamp = now();
    // The agent run is the source of truth at a process boundary. Mirroring
    // the active state first closes either crash window between the two normal
    // persistence writes: a stored waiting run stays resumable, while a stored
    // running run is interrupted below even if its routine projection was
    // still waiting.
    query(
        "UPDATE routine_runs
         SET status = (
           SELECT status FROM agent_runs
           WHERE agent_runs.id = routine_runs.agent_run_id
         ), updated_at = ?
         WHERE agent_run_id IS NOT NULL
           AND status IN ('running', 'waiting_for_user')
           AND EXISTS (
             SELECT 1 FROM agent_runs
             WHERE agent_runs.id = routine_runs.agent_run_id
               AND agent_runs.status IN ('running', 'waiting_for_user')
           )",
    )
    .bind(&timestamp)
    .execute(pool)
    .await
    .map_err(app_error)?;
    // Waiting runs retain their serialized SDK state and routine claim so the
    // pending approval or clarification remains resumable after relaunch.
    // Ordinary running work cannot survive the process boundary and is
    // interrupted, which releases its claim through `reconcile`.
    query("UPDATE agent_runs SET status = 'interrupted', completed_at = COALESCE(completed_at, ?), error_code = COALESCE(error_code, 'routine_runtime_restarted'), error_message = COALESCE(error_message, 'June restarted before this routine completed.'), updated_at = ? WHERE id IN (SELECT agent_run_id FROM routine_runs WHERE agent_run_id IS NOT NULL AND status = 'running')")
        .bind(&timestamp).bind(&timestamp).execute(pool).await.map_err(app_error)?;
    query("UPDATE routine_runs SET status = 'interrupted', completed_at = COALESCE(completed_at, ?), error_code = COALESCE(error_code, 'routine_runtime_restarted'), error_message = COALESCE(error_message, 'June restarted before this routine completed.'), updated_at = ? WHERE status IN ('queued', 'running')")
        .bind(&timestamp).bind(&timestamp).execute(pool).await.map_err(app_error)?;
    reconcile(pool).await
}

pub async fn mark_agent_run_waiting(pool: &SqlitePool, agent_run_id: &str) -> Result<(), AppError> {
    query(
        "UPDATE routine_runs
         SET status = 'waiting_for_user', updated_at = ?
         WHERE agent_run_id = ? AND status = 'running'",
    )
    .bind(now())
    .bind(agent_run_id)
    .execute(pool)
    .await
    .map_err(app_error)?;
    Ok(())
}

pub async fn mark_agent_run_resumed(pool: &SqlitePool, agent_run_id: &str) -> Result<(), AppError> {
    query(
        "UPDATE routine_runs
         SET status = 'running', updated_at = ?
         WHERE agent_run_id = ? AND status = 'waiting_for_user'",
    )
    .bind(now())
    .bind(agent_run_id)
    .execute(pool)
    .await
    .map_err(app_error)?;
    Ok(())
}

/// Start the single local scheduler for June-owned routines. Claims are stored
/// before dispatch, so overlapping ticks, manual runs, and connector wakes all
/// share the same single-flight boundary.
pub fn start_scheduler(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let repositories = match repositories(&app).await {
            Ok(repositories) => repositories,
            Err(error) => {
                tracing::warn!(error_code = %error.code, "routine scheduler could not open storage");
                return;
            }
        };
        let pool = repositories.pool;
        if let Err(error) = reconcile_after_restart(&pool).await {
            tracing::warn!(error_code = %error.code, "routine restart reconciliation failed");
        }
        loop {
            match claim_due(&pool).await {
                Ok(claims) => {
                    let host = app.state::<AgentRuntimeHost>();
                    for claim in claims {
                        if let Err(error) = start_claim(&app, &host, &pool, claim).await {
                            tracing::warn!(error_code = %error.code, "routine scheduled dispatch failed");
                        }
                    }
                }
                Err(error) => {
                    tracing::warn!(error_code = %error.code, "routine scheduler claim failed")
                }
            }
            tokio::time::sleep(std::time::Duration::from_secs(SCHEDULER_TICK_SECONDS)).await;
        }
    });
}

/// Starts a previously persisted claim with the unattended tool contract.
/// There is intentionally no Computer use, clarification, shell, write, or
/// approval-required tool in this set.
pub async fn start_claim(
    app: &AppHandle,
    host: &AgentRuntimeHost,
    pool: &SqlitePool,
    claim: Claim,
) -> Result<AgentRoutineRunDto, AppError> {
    let repository = AgentRepository::new(pool.clone());
    let session_id = Uuid::new_v4().to_string();
    let workspace = routine_workspace(app, &session_id)?;
    tokio::fs::create_dir_all(&workspace)
        .await
        .map_err(|error| AppError::new("routine_workspace_failed", error.to_string()))?;
    let timestamp = now();
    let started = async {
        query("INSERT INTO agent_sessions (id, title, status, model, safety_mode, workspace_path, source, created_at, updated_at) VALUES (?, ?, 'idle', ?, ?, ?, 'routine', ?, ?)")
            .bind(&session_id).bind(&claim.routine_name).bind(&claim.model).bind(claim.safety_mode.as_db()).bind(workspace.to_string_lossy().as_ref()).bind(&timestamp).bind(&timestamp).execute(pool).await.map_err(app_error)?;
        let run = repository.create_run(&session_id, &claim.model).await.map_err(app_error)?;
        repository.append_item(&session_id, Some(&run.id), 0, &AgentItemPayload::UserMessage(MessagePayload { role: "user".into(), content: claim.prompt.clone(), attachments: vec![] }), Some(&format!("routine:{}", claim.routine_run_id))).await.map_err(app_error)?;
        attach_run_mapping(pool, &claim.routine_run_id, &claim.token, &session_id, &run.id, &timestamp).await?;
        host.ensure_started(app, repository.clone()).await?;
        let workspace = workspace.to_string_lossy();
        let request = UnattendedRunRequest {
            session_id: &session_id,
            run_id: &run.id,
            routine_id: &claim.routine_id,
            model: &claim.model,
            safety_mode: claim.safety_mode,
            workspace: workspace.as_ref(),
            prompt: &claim.prompt,
            enabled_toolsets: &claim.enabled_toolsets,
        };
        host.request("run.start", &session_id, &run.id, unattended_run_params(app, &repository, &request).await?).await?;
        Ok::<_, AppError>(run.id)
    }.await;
    if let Err(error) = started {
        let _ = query("UPDATE routine_runs SET status = 'failed', completed_at = ?, error_code = ?, error_message = ?, updated_at = ? WHERE id = ?")
            .bind(now()).bind(&error.code).bind(&error.message).bind(now()).bind(&claim.routine_run_id).execute(pool).await;
        let _ = query("UPDATE routines SET claim_token = NULL, claimed_at = NULL, last_run_at = ?, last_status = 'error', last_error = ?, updated_at = ? WHERE id = ? AND claim_token = ?")
            .bind(now()).bind(&error.message).bind(now()).bind(&claim.routine_id).bind(&claim.token).execute(pool).await;
        return Err(error);
    }
    list_runs(pool, Some(&claim.routine_id))
        .await?
        .into_iter()
        .find(|run| run.id == claim.routine_run_id)
        .ok_or_else(|| AppError::new("routine_run_missing", "Routine run was not persisted."))
}

pub async fn trigger_and_start(
    app: &AppHandle,
    host: &AgentRuntimeHost,
    pool: &SqlitePool,
    routine_id: &str,
) -> Result<Option<AgentRoutineRunDto>, AppError> {
    reconcile(pool).await?;
    match claim(pool, routine_id, "manual", false).await? {
        Some(claim) => start_claim(app, host, pool, claim).await.map(Some),
        None => Ok(None),
    }
}

/// Shared entry point for connector event triggers. `false` means the routine
/// was paused, missing, or already active. Callers decide whether that is an
/// acknowledged wake or one that should remain pending for their event type.
pub async fn trigger_from_connector(
    app: &AppHandle,
    routine_id: &str,
    trigger_id: &str,
    kind: &str,
    account_id: &str,
) -> Result<bool, AppError> {
    let pool = repositories(app).await?.pool;
    let host = app.state::<AgentRuntimeHost>();
    reconcile(&pool).await?;
    let guard = ConnectorClaimGuard {
        trigger_id,
        kind,
        account_id,
    };
    match claim_with_connector_guard(&pool, routine_id, kind, false, Some(guard)).await? {
        Some(claim) => start_claim(app, &host, &pool, claim).await.map(|_| true),
        None => Ok(false),
    }
}

/// Attach a created agent session/run to the already-durable claim. Keeping
/// this as a small unit makes restart recovery and the mapping invariant easy
/// to test independently of the runtime host.
async fn attach_run_mapping(
    pool: &SqlitePool,
    routine_run_id: &str,
    claim_token: &str,
    session_id: &str,
    agent_run_id: &str,
    timestamp: &str,
) -> Result<(), AppError> {
    let changed = query("UPDATE routine_runs SET agent_session_id = ?, agent_run_id = ?, status = 'running', started_at = ?, updated_at = ? WHERE id = ? AND claim_token = ? AND status = 'queued'")
        .bind(session_id).bind(agent_run_id).bind(timestamp).bind(timestamp).bind(routine_run_id).bind(claim_token).execute(pool).await.map_err(app_error)?;
    if changed.rows_affected() == 1 {
        Ok(())
    } else {
        Err(AppError::new(
            "routine_claim_lost",
            "Routine claim is no longer active.",
        ))
    }
}

#[tauri::command]
pub async fn list_agent_routines(app: AppHandle) -> Result<Vec<AgentRoutineDto>, AppError> {
    list(&repositories(&app).await?.pool).await
}
#[tauri::command]
pub async fn create_agent_routine(
    app: AppHandle,
    request: CreateAgentRoutineRequest,
) -> Result<AgentRoutineDto, AppError> {
    create(&repositories(&app).await?.pool, request).await
}
#[tauri::command]
pub async fn update_agent_routine(
    app: AppHandle,
    request: UpdateAgentRoutineRequest,
) -> Result<AgentRoutineDto, AppError> {
    update(&repositories(&app).await?.pool, request).await
}
#[tauri::command]
pub async fn pause_agent_routine(
    app: AppHandle,
    routine_id: String,
) -> Result<AgentRoutineDto, AppError> {
    pause(&repositories(&app).await?.pool, &routine_id).await
}
#[tauri::command]
pub async fn resume_agent_routine(
    app: AppHandle,
    routine_id: String,
) -> Result<AgentRoutineDto, AppError> {
    resume(&repositories(&app).await?.pool, &routine_id).await
}
#[tauri::command]
pub async fn trigger_agent_routine(
    app: AppHandle,
    host: State<'_, AgentRuntimeHost>,
    routine_id: String,
) -> Result<Option<AgentRoutineRunDto>, AppError> {
    trigger_and_start(&app, &host, &repositories(&app).await?.pool, &routine_id).await
}
#[tauri::command]
pub async fn delete_agent_routine(app: AppHandle, routine_id: String) -> Result<(), AppError> {
    delete(&repositories(&app).await?.pool, &routine_id).await
}
#[tauri::command]
pub async fn list_agent_routine_runs(
    app: AppHandle,
    request: Option<ListAgentRoutineRunsRequest>,
) -> Result<Vec<AgentRoutineRunDto>, AppError> {
    list_runs(
        &repositories(&app).await?.pool,
        request.and_then(|value| value.routine_id).as_deref(),
    )
    .await
}

#[tauri::command]
pub async fn routine_browser_access_get(
    app: AppHandle,
    job_id: String,
) -> Result<RoutineBrowserAccessStatus, AppError> {
    let grant = repositories(&app)
        .await?
        .routine_browser_grant(&job_id)
        .await?;
    Ok(RoutineBrowserAccessStatus {
        enabled: grant.as_ref().is_some_and(|grant| grant.enabled),
        server_name: grant.map(|grant| grant.server_name),
    })
}

/// Persist and immediately apply a routine-specific managed-browser grant.
/// The broker remains the request-time policy boundary; a database record is
/// merely opt-in metadata and never grants unattended computer control.
#[tauri::command]
pub(crate) async fn routine_browser_access_set(
    app: AppHandle,
    broker: State<'_, std::sync::Arc<BrowserBroker>>,
    request: SetRoutineBrowserAccessRequest,
) -> Result<RoutineBrowserAccessStatus, AppError> {
    let job_id = request.job_id.trim();
    if job_id.is_empty() {
        return Err(AppError::new(
            "invalid_arguments",
            "A routine id is required.",
        ));
    }
    let repos = repositories(&app).await?;
    let previous = repos.routine_browser_grant(job_id).await?;
    if request.enabled {
        let grant = previous
            .clone()
            .unwrap_or_else(|| RoutineBrowserGrantRecord {
                job_id: job_id.to_string(),
                server_name: format!("june_browser_routine_{}", Uuid::new_v4().simple()),
                token: Uuid::new_v4().to_string(),
                enabled: true,
            });
        let grant = RoutineBrowserGrantRecord {
            enabled: true,
            ..grant
        };
        broker.set_routine_grant(broker_grant(&grant));
        if let Err(error) = repos.set_routine_browser_grant(&grant).await {
            restore_browser_grant(&broker, previous, job_id);
            return Err(error);
        }
        Ok(RoutineBrowserAccessStatus {
            enabled: true,
            server_name: Some(grant.server_name),
        })
    } else {
        if let Some(previous) = previous {
            let disabled = RoutineBrowserGrantRecord {
                enabled: false,
                ..previous.clone()
            };
            broker.set_routine_grant(broker_grant(&disabled));
            if let Err(error) = repos.set_routine_browser_grant(&disabled).await {
                broker.set_routine_grant(broker_grant(&previous));
                return Err(error);
            }
        }
        broker.revoke_routine_sessions(job_id).await;
        Ok(RoutineBrowserAccessStatus {
            enabled: false,
            server_name: None,
        })
    }
}

fn broker_grant(grant: &RoutineBrowserGrantRecord) -> RoutineBrowserGrant {
    RoutineBrowserGrant {
        job_id: grant.job_id.clone(),
        server_name: grant.server_name.clone(),
        token: grant.token.clone(),
        enabled: grant.enabled,
    }
}

fn restore_browser_grant(
    broker: &BrowserBroker,
    previous: Option<RoutineBrowserGrantRecord>,
    job_id: &str,
) {
    if let Some(previous) = previous {
        broker.set_routine_grant(broker_grant(&previous));
    } else {
        broker.remove_routine_grant(job_id);
    }
}

#[derive(Debug, Clone)]
pub struct Claim {
    pub routine_id: String,
    pub routine_name: String,
    pub prompt: String,
    pub model: String,
    pub safety_mode: AgentSafetyMode,
    pub enabled_toolsets: Vec<String>,
    pub token: String,
    pub routine_run_id: String,
}

fn routine_from_row(row: sqlx_sqlite::SqliteRow) -> AgentRoutineDto {
    AgentRoutineDto {
        id: row.get("id"),
        legacy_job_id: row.get("legacy_job_id"),
        name: row.get("name"),
        prompt: row.get("prompt"),
        schedule: row.get("schedule"),
        timezone: row.get("timezone"),
        repeat: row.get("repeat"),
        deliver: row.get("deliver"),
        model: row.get("model"),
        safety_mode: AgentSafetyMode::from(row.get::<String, _>("safety_mode").as_str()),
        state: row.get("state"),
        enabled: row.get::<i64, _>("enabled") != 0,
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
        next_run_at: row.get("next_run_at"),
        last_run_at: row.get("last_run_at"),
        last_status: row.get("last_status"),
        last_error: row.get("last_error"),
        last_delivery_error: row.get("last_delivery_error"),
        metadata: parse_metadata(row.get::<String, _>("metadata_json")),
    }
}
fn run_from_row(row: sqlx_sqlite::SqliteRow) -> AgentRoutineRunDto {
    AgentRoutineRunDto {
        id: row.get("id"),
        routine_id: row.get("routine_id"),
        agent_session_id: row.get("agent_session_id"),
        agent_run_id: row.get("agent_run_id"),
        trigger_kind: row.get("trigger_kind"),
        status: row.get("status"),
        scheduled_for: row.get("scheduled_for"),
        started_at: row.get("started_at"),
        completed_at: row.get("completed_at"),
        model: row.get("model"),
        safety_mode: AgentSafetyMode::from(row.get::<String, _>("safety_mode").as_str()),
        error_code: row.get("error_code"),
        error_message: row.get("error_message"),
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
    }
}
fn parse_metadata(raw: String) -> Value {
    serde_json::from_str(&raw).unwrap_or_else(|_| json!({}))
}
fn requires_legacy_execution_review(metadata: &Value) -> bool {
    metadata
        .get("legacyExecutionNeedsReview")
        .and_then(Value::as_bool)
        .unwrap_or(false)
}
fn metadata_json(value: Value) -> String {
    if value.is_object() {
        value.to_string()
    } else {
        "{}".into()
    }
}
fn set_enabled_toolsets(metadata: &mut Value, enabled_toolsets: Option<Vec<String>>) {
    let Some(enabled_toolsets) = enabled_toolsets else {
        return;
    };
    if !metadata.is_object() {
        *metadata = json!({});
    }
    metadata["enabledToolsets"] = json!(enabled_toolsets);
}
fn prompt_title(prompt: &str) -> &str {
    let prompt = prompt.trim();
    let end = prompt
        .char_indices()
        .nth(50)
        .map(|(index, _)| index)
        .unwrap_or(prompt.len());
    prompt[..end].trim()
}
fn nonempty(value: String, fallback: &str) -> String {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        fallback.into()
    } else {
        trimmed.into()
    }
}
fn format_time(time: DateTime<Utc>) -> String {
    time.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
fn parse_time(value: &str) -> Result<DateTime<Utc>, AppError> {
    DateTime::parse_from_rfc3339(value)
        .map(|time| time.with_timezone(&Utc))
        .map_err(|_| AppError::new("routine_schedule_invalid", "Routine time is not RFC 3339."))
}
fn routine_workspace(app: &AppHandle, session_id: &str) -> Result<PathBuf, AppError> {
    Ok(crate::app_paths::app_data_dir(app)
        .map_err(|error| AppError::new("routine_workspace_failed", error.to_string()))?
        .join("agent-workspaces")
        .join(session_id))
}

struct UnattendedRunRequest<'a> {
    session_id: &'a str,
    run_id: &'a str,
    routine_id: &'a str,
    model: &'a str,
    safety_mode: AgentSafetyMode,
    workspace: &'a str,
    prompt: &'a str,
    enabled_toolsets: &'a [String],
}

async fn unattended_run_params(
    app: &AppHandle,
    repository: &AgentRepository,
    request: &UnattendedRunRequest<'_>,
) -> Result<Value, AppError> {
    let history = repository.items(request.session_id).await.map_err(app_error)?.into_iter().filter_map(|item| match item.payload { AgentItemPayload::UserMessage(message) | AgentItemPayload::AssistantMessage(message) | AgentItemPayload::SystemMessage(message) => Some(json!({ "id": item.id, "kind": "message", "role": message.role, "text": message.content })), AgentItemPayload::ContextSummary(summary) => Some(json!({ "id": item.id, "kind": "context_summary", "role": "system", "text": summary.text })), _ => None }).collect::<Vec<_>>();
    let tools = unattended_tools(
        app,
        repository,
        request.safety_mode,
        std::path::Path::new(request.workspace),
        request.routine_id,
        request.enabled_toolsets,
    )
    .await;
    let mcp_descriptors = tools
        .as_array()
        .into_iter()
        .flatten()
        .filter(|descriptor| {
            descriptor
                .get("id")
                .and_then(Value::as_str)
                .is_some_and(|id| id.starts_with("mcp:"))
        })
        .filter_map(|descriptor| serde_json::from_value(descriptor.clone()).ok())
        .collect::<Vec<crate::agent_mcp::RuntimeToolDescriptorJson>>();
    crate::agent_mcp::snapshot_run_policies(&repository.pool, request.run_id, &mcp_descriptors)
        .await
        .map_err(|error| AppError::new("agent_mcp_policy_snapshot_failed", error.to_string()))?;
    Ok(
        json!({ "model": request.model, "instructions": "You are June executing an unattended routine. Complete the requested work without asking questions. Never claim a tool succeeded unless its result confirms success. If a tool needs approval, pause and wait for the user instead of choosing for them.", "workspace": request.workspace, "safetyMode": request.safety_mode.as_db(), "input": request.prompt, "history": history, "tools": tools, "skills": [], "contextWindow": 128000, "maxOutputTokens": 8192 }),
    )
}
async fn unattended_tools(
    app: &AppHandle,
    repository: &AgentRepository,
    safety_mode: AgentSafetyMode,
    workspace: &std::path::Path,
    routine_id: &str,
    enabled_toolsets: &[String],
) -> Value {
    let autonomous_tools = routine_autonomous_tools(&repository.pool, routine_id).await;
    let mut tools = base_unattended_tools();
    if let Some(descriptors) = tools.as_array_mut() {
        descriptors.retain(|descriptor| {
            descriptor
                .get("name")
                .and_then(Value::as_str)
                .is_some_and(|name| routine_base_tool_allowed(name, enabled_toolsets))
        });
    }
    let subsystem = crate::agent_mcp::AgentMcpSubsystem::new(
        crate::agent_mcp::AgentMcpRepository::new(repository.pool.clone()),
        crate::agent_mcp::KeychainMcpSecretStore,
    );
    match subsystem
        .refresh_registry_for_workspace(safety_mode == AgentSafetyMode::Sandboxed, Some(workspace))
        .await
    {
        Ok(descriptors) => {
            let mcp_repository = crate::agent_mcp::AgentMcpRepository::new(repository.pool.clone());
            for descriptor in descriptors {
                let Some(server_id) = descriptor
                    .id
                    .strip_prefix("mcp:")
                    .and_then(|value| value.split('/').next())
                else {
                    continue;
                };
                let Ok(server) = mcp_repository.get(server_id).await else {
                    continue;
                };
                if enabled_toolsets
                    .iter()
                    .any(|toolset| toolset == &server.name)
                {
                    if let Ok(value) = serde_json::to_value(descriptor) {
                        tools
                            .as_array_mut()
                            .expect("routine tool catalog is an array")
                            .push(value);
                    }
                }
            }
        }
        Err(error) => tracing::warn!(
            error_code = "routine_mcp_discovery_failed",
            error = %error,
            "MCP discovery was unavailable for this routine run"
        ),
    }
    match crate::agent_runtime::native_connectors::descriptors(app).await {
        Ok(descriptors) => tools
            .as_array_mut()
            .expect("routine tool catalog is an array")
            .extend(descriptors.into_iter().filter(|descriptor| {
                descriptor
                    .get("name")
                    .and_then(Value::as_str)
                    .is_some_and(|name| {
                        crate::agent_runtime::native_connectors::routine_tool_allowed(
                            name,
                            enabled_toolsets,
                            &autonomous_tools,
                        )
                    })
            })),
        Err(error) => tracing::warn!(
            error_code = %error.code,
            "native connector tools were unavailable for this routine run"
        ),
    }
    tools
}

fn enabled_toolsets_from_metadata(metadata: &Value, legacy_catalog: bool) -> Vec<String> {
    match metadata.get("enabledToolsets") {
        Some(Value::Array(toolsets)) => toolsets
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect(),
        // Only rows durably marked as pre-catalog retain the historical June
        // context, web, and read-only workspace contract. New routines persist
        // an explicit empty catalog until the user selects tools.
        _ if legacy_catalog => ["context_engine", "session_search", "web", "file"]
            .into_iter()
            .map(str::to_owned)
            .collect(),
        _ => Vec::new(),
    }
}

async fn routine_autonomous_tools(pool: &SqlitePool, routine_id: &str) -> Vec<String> {
    query("SELECT autonomous_tools FROM routine_trust WHERE job_id = ?")
        .bind(routine_id)
        .fetch_optional(pool)
        .await
        .ok()
        .flatten()
        .and_then(|row| serde_json::from_str(&row.get::<String, _>("autonomous_tools")).ok())
        .unwrap_or_default()
}

fn routine_base_tool_allowed(name: &str, enabled_toolsets: &[String]) -> bool {
    let has = |toolset: &str| enabled_toolsets.iter().any(|value| value == toolset);
    match name {
        "search_june" => has("context_engine") || has("memory") || has("session_search"),
        "web_search" | "web_fetch" => has("web"),
        "list_files" | "read_file" | "preview_file" | "search_files" => has("file"),
        _ => false,
    }
}

pub async fn routine_tool_allowed_for_session(
    pool: &SqlitePool,
    session_id: &str,
    name: &str,
) -> Result<Option<bool>, AppError> {
    let row = query(
        "SELECT routines.id, routines.metadata_json, routines.tool_catalog_version
         FROM routine_runs
         JOIN routines ON routines.id = routine_runs.routine_id
         WHERE routine_runs.agent_session_id = ?",
    )
    .bind(session_id)
    .fetch_optional(pool)
    .await
    .map_err(app_error)?;
    let Some(row) = row else {
        return Ok(None);
    };
    let routine_id: String = row.get("id");
    let metadata = serde_json::from_str::<Value>(&row.get::<String, _>("metadata_json"))
        .unwrap_or_else(|_| json!({}));
    let enabled_toolsets =
        enabled_toolsets_from_metadata(&metadata, row.get::<i64, _>("tool_catalog_version") == 0);
    let autonomous_tools = routine_autonomous_tools(pool, &routine_id).await;
    Ok(Some(
        routine_base_tool_allowed(name, &enabled_toolsets)
            || crate::agent_runtime::native_connectors::routine_tool_allowed(
                name,
                &enabled_toolsets,
                &autonomous_tools,
            )
            || name == "request_clarification",
    ))
}

pub async fn routine_mcp_server_allowed_for_session(
    pool: &SqlitePool,
    session_id: &str,
    server_name: &str,
) -> Result<Option<bool>, AppError> {
    let row = query(
        "SELECT routines.metadata_json, routines.tool_catalog_version
         FROM routine_runs
         JOIN routines ON routines.id = routine_runs.routine_id
         WHERE routine_runs.agent_session_id = ?",
    )
    .bind(session_id)
    .fetch_optional(pool)
    .await
    .map_err(app_error)?;
    let Some(row) = row else {
        return Ok(None);
    };
    let metadata = serde_json::from_str::<Value>(&row.get::<String, _>("metadata_json"))
        .unwrap_or_else(|_| json!({}));
    Ok(Some(
        enabled_toolsets_from_metadata(&metadata, row.get::<i64, _>("tool_catalog_version") == 0)
            .iter()
            .any(|toolset| toolset == server_name),
    ))
}

fn base_unattended_tools() -> Value {
    json!([
        { "name": "search_june", "description": "Search June notes, transcripts, and dictations.", "parameters": { "type": "object", "properties": { "query": { "type": "string" } }, "required": ["query"], "additionalProperties": false } },
        { "name": "web_search", "description": "Search the public web.", "parameters": { "type": "object", "properties": { "query": { "type": "string" } }, "required": ["query"], "additionalProperties": false } },
        { "name": "web_fetch", "description": "Fetch a public web page.", "parameters": { "type": "object", "properties": { "url": { "type": "string" } }, "required": ["url"], "additionalProperties": false } },
        { "name": "list_files", "description": "List files in the routine workspace.", "parameters": { "type": "object", "properties": { "path": { "type": "string" } }, "required": [], "additionalProperties": false } },
        { "name": "read_file", "description": "Read a UTF-8 text file in the routine workspace.", "parameters": { "type": "object", "properties": { "path": { "type": "string" } }, "required": ["path"], "additionalProperties": false } },
        { "name": "preview_file", "description": "Read file metadata and a bounded text preview.", "parameters": { "type": "object", "properties": { "path": { "type": "string" } }, "required": ["path"], "additionalProperties": false } },
        { "name": "search_files", "description": "Search text files in the routine workspace.", "parameters": { "type": "object", "properties": { "query": { "type": "string" }, "path": { "type": "string" } }, "required": ["query"], "additionalProperties": false } }
    ])
}

/// Supports the legacy routine schedule forms June surfaced: one-shot RFC3339,
/// `every 30m|2h|1d`, macros, and standard five-field cron. Cron fields are
/// evaluated in the routine's IANA timezone, including daylight-saving
/// transitions, while persisted instants remain UTC.
fn next_run_after(
    schedule: &str,
    timezone: &str,
    after: DateTime<Utc>,
) -> Result<Option<DateTime<Utc>>, AppError> {
    let normalized = schedule.trim().to_ascii_lowercase();
    let source = match normalized.as_str() {
        "@hourly" => "0 * * * *".to_string(),
        "@daily" | "@midnight" => "0 0 * * *".to_string(),
        "@weekly" => "0 0 * * 0".to_string(),
        "@monthly" => "0 0 1 * *".to_string(),
        value => value.to_string(),
    };
    if let Ok(instant) = DateTime::parse_from_rfc3339(&source) {
        return Ok((instant.with_timezone(&Utc) > after).then_some(instant.with_timezone(&Utc)));
    }
    if let Some(interval) = source.strip_prefix("every ").and_then(parse_interval) {
        return Ok(Some(after + interval));
    }
    let fields: Vec<&str> = source.split_whitespace().collect();
    if fields.len() != 5 {
        return Err(AppError::new(
            "routine_schedule_invalid",
            "Routine schedules must be RFC 3339, every <n>m/h/d, or five-field cron.",
        ));
    }
    let timezone = timezone.parse::<Tz>().map_err(|_| {
        AppError::new(
            "routine_timezone_invalid",
            "Routine timezone must be a valid IANA timezone.",
        )
    })?;
    let mut candidate = after + Duration::minutes(1);
    candidate = candidate
        .with_second(0)
        .and_then(|value| value.with_nanosecond(0))
        .unwrap_or(candidate);
    for _ in 0..=527_040 {
        if cron_matches(&fields, candidate.with_timezone(&timezone)) {
            return Ok(Some(candidate));
        }
        candidate += Duration::minutes(1);
    }
    Err(AppError::new(
        "routine_schedule_invalid",
        "Routine schedule has no occurrence in the next year.",
    ))
}
fn parse_interval(value: &str) -> Option<Duration> {
    let value = value.trim();
    let (number, unit) = value.split_at(value.len().checked_sub(1)?);
    let number = number.parse::<i64>().ok()?.max(1);
    match unit {
        "m" => Some(Duration::minutes(number)),
        "h" => Some(Duration::hours(number)),
        "d" => Some(Duration::days(number)),
        _ => None,
    }
}
fn cron_matches<T: TimeZone>(fields: &[&str], value: DateTime<T>) -> bool {
    cron_field(fields[0], value.minute() as i32, 0, 59)
        && cron_field(fields[1], value.hour() as i32, 0, 23)
        && cron_field(fields[2], value.day() as i32, 1, 31)
        && cron_field(fields[3], value.month() as i32, 1, 12)
        && cron_field(
            fields[4],
            value.weekday().num_days_from_sunday() as i32,
            0,
            7,
        )
}
fn cron_field(field: &str, value: i32, min: i32, max: i32) -> bool {
    field.split(',').any(|part| {
        let (base, step) = part.split_once('/').map_or((part, 1), |(base, step)| {
            (base, step.parse::<i32>().unwrap_or(0))
        });
        if step < 1 {
            return false;
        }
        let matches_base = if base == "*" {
            true
        } else if let Some((start, end)) = base.split_once('-') {
            start
                .parse::<i32>()
                .ok()
                .zip(end.parse::<i32>().ok())
                .is_some_and(|(start, end)| value >= start && value <= end)
        } else {
            base.parse::<i32>()
                .ok()
                .is_some_and(|wanted| wanted == value || (max == 7 && wanted == 7 && value == 0))
        };
        if !matches_base {
            return false;
        }
        if base == "*" {
            (value - min) % step == 0
        } else if let Some((start, _)) = base.split_once('-') {
            start
                .parse::<i32>()
                .ok()
                .is_some_and(|start| (value - start) % step == 0)
        } else {
            true
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx_sqlite::SqlitePoolOptions;

    async fn pool() -> SqlitePool {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        // The routine migration only needs these parent keys for FK coverage.
        // Running the full runtime migration in memory would also require the
        // retired Hermes tables it deliberately imports from.
        for statement in [
            "CREATE TABLE agent_sessions (id TEXT PRIMARY KEY)",
            "CREATE TABLE agent_runs (id TEXT PRIMARY KEY, status TEXT, updated_at TEXT, completed_at TEXT, interrupted_state_json TEXT, error_code TEXT, error_message TEXT)",
            "CREATE TABLE connector_triggers (id TEXT PRIMARY KEY, job_id TEXT, kind TEXT, account_id TEXT)",
        ] {
            query(statement).execute(&pool).await.unwrap();
        }
        for statement in include_str!("../migrations/026_routines.sql")
            .split(';')
            .filter(|statement| !statement.trim().is_empty())
        {
            query(statement).execute(&pool).await.unwrap();
        }
        pool
    }
    fn create_request(schedule: &str) -> CreateAgentRoutineRequest {
        CreateAgentRoutineRequest {
            id: Some("routine-1".into()),
            legacy_job_id: Some("legacy-1".into()),
            name: Some("Daily brief".into()),
            prompt: "Summarize notes".into(),
            schedule: schedule.into(),
            timezone: "UTC".into(),
            repeat: None,
            deliver: None,
            model: "auto".into(),
            safety_mode: Some(AgentSafetyMode::Sandboxed),
            state: None,
            enabled: None,
            metadata: json!({"origin":"test"}),
            enabled_toolsets: None,
        }
    }

    #[test]
    fn cron_schedule_uses_the_routine_iana_timezone() {
        let summer = Utc.with_ymd_and_hms(2026, 7, 24, 12, 30, 0).unwrap();
        let winter = Utc.with_ymd_and_hms(2026, 1, 24, 13, 30, 0).unwrap();
        assert_eq!(
            next_run_after("0 9 * * *", "America/New_York", summer)
                .unwrap()
                .unwrap(),
            Utc.with_ymd_and_hms(2026, 7, 24, 13, 0, 0).unwrap()
        );
        assert_eq!(
            next_run_after("0 9 * * *", "America/New_York", winter)
                .unwrap()
                .unwrap(),
            Utc.with_ymd_and_hms(2026, 1, 24, 14, 0, 0).unwrap()
        );
    }

    #[test]
    fn finite_repeat_completes_after_the_preserved_run_count() {
        let mut metadata = json!({"repeatState":{"completed":1}});
        assert!(!advance_repeat("3", &mut metadata));
        assert_eq!(metadata["repeatState"]["completed"], 2);
        assert!(advance_repeat("3", &mut metadata));
        assert_eq!(metadata["repeatState"]["completed"], 3);
        assert!(!advance_repeat("forever", &mut metadata));
    }

    #[tokio::test]
    async fn crud_persists_the_legacy_compatible_contract() {
        let pool = pool().await;
        let created = create(&pool, create_request("every 1h")).await.unwrap();
        assert_eq!(created.id, "routine-1");
        assert_eq!(created.legacy_job_id.as_deref(), Some("legacy-1"));
        assert!(created.next_run_at.is_some());
        let updated = update(
            &pool,
            UpdateAgentRoutineRequest {
                routine_id: created.id.clone(),
                name: Some("Updated brief".into()),
                prompt: None,
                schedule: None,
                timezone: None,
                repeat: None,
                deliver: None,
                model: Some("model-x".into()),
                safety_mode: Some(AgentSafetyMode::Unrestricted),
                state: None,
                enabled: None,
                metadata: Some(json!({"edited":true})),
                enabled_toolsets: None,
            },
        )
        .await
        .unwrap();
        assert_eq!(updated.name, "Updated brief");
        assert_eq!(updated.model, "model-x");
        assert_eq!(updated.safety_mode, AgentSafetyMode::Unrestricted);
        assert_eq!(pause(&pool, &created.id).await.unwrap().state, "paused");
        assert_eq!(resume(&pool, &created.id).await.unwrap().state, "scheduled");
        delete(&pool, &created.id).await.unwrap();
        assert!(list(&pool).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn imported_legacy_execution_routine_cannot_be_resumed_or_reenabled() {
        let pool = pool().await;
        let mut request = create_request("every 1h");
        request.state = Some("needs_review".into());
        request.enabled = Some(false);
        request.metadata = json!({"legacyExecutionNeedsReview": true});
        create(&pool, request).await.unwrap();
        let resume_error = resume(&pool, "routine-1").await.unwrap_err();
        assert_eq!(
            resume_error.code,
            "routine_legacy_execution_review_required"
        );
        let update_error = update(
            &pool,
            UpdateAgentRoutineRequest {
                routine_id: "routine-1".into(),
                name: None,
                prompt: None,
                schedule: None,
                timezone: None,
                repeat: None,
                deliver: None,
                model: None,
                safety_mode: None,
                state: Some("scheduled".into()),
                enabled: Some(true),
                metadata: Some(json!({})),
                enabled_toolsets: None,
            },
        )
        .await
        .unwrap_err();
        assert_eq!(
            update_error.code,
            "routine_legacy_execution_review_required"
        );
    }

    #[tokio::test]
    async fn due_claim_is_single_flight_and_reconciles_an_expired_restart_claim() {
        let pool = pool().await;
        create(&pool, create_request("every 1m")).await.unwrap();
        query("UPDATE routines SET next_run_at = ? WHERE id = 'routine-1'")
            .bind(format_time(Utc::now() - Duration::minutes(1)))
            .execute(&pool)
            .await
            .unwrap();
        let first = claim_due(&pool).await.unwrap();
        assert_eq!(first.len(), 1);
        assert!(claim_due(&pool).await.unwrap().is_empty());
        query("UPDATE routine_runs SET updated_at = ? WHERE id = ?")
            .bind(format_time(
                Utc::now() - Duration::minutes(CLAIM_STALE_AFTER_MINUTES + 1),
            ))
            .bind(&first[0].routine_run_id)
            .execute(&pool)
            .await
            .unwrap();
        reconcile(&pool).await.unwrap();
        assert_eq!(
            list_runs(&pool, Some("routine-1")).await.unwrap()[0].status,
            "interrupted"
        );
    }

    #[tokio::test]
    async fn event_style_manual_claim_ignores_far_future_schedule_and_keeps_toolsets() {
        let pool = pool().await;
        let mut request = create_request("2099-01-01T09:00:00Z");
        request.enabled_toolsets = Some(vec!["web".into(), "june_gmail".into()]);
        create(&pool, request).await.unwrap();

        let claim = claim(&pool, "routine-1", "email_received", false)
            .await
            .unwrap()
            .expect("active event routine should be claimable");
        assert_eq!(claim.enabled_toolsets, vec!["web", "june_gmail"]);
        assert_eq!(claim.routine_id, "routine-1");
    }

    #[tokio::test]
    async fn connector_claim_rejects_a_removed_poll_snapshot() {
        let pool = pool().await;
        create(&pool, create_request("2099-01-01T09:00:00Z"))
            .await
            .unwrap();
        query(
            "INSERT INTO connector_triggers (id, job_id, kind, account_id)
             VALUES ('trigger-1', 'routine-1', 'email_received', 'user@example.com')",
        )
        .execute(&pool)
        .await
        .unwrap();
        query("DELETE FROM connector_triggers WHERE id = 'trigger-1'")
            .execute(&pool)
            .await
            .unwrap();

        let guard = ConnectorClaimGuard {
            trigger_id: "trigger-1",
            kind: "email_received",
            account_id: "user@example.com",
        };
        assert!(claim_with_connector_guard(
            &pool,
            "routine-1",
            "email_received",
            false,
            Some(guard),
        )
        .await
        .unwrap()
        .is_none());
        assert!(list_runs(&pool, Some("routine-1"))
            .await
            .unwrap()
            .is_empty());
    }

    #[tokio::test]
    async fn new_routines_without_a_catalog_have_no_tools() {
        let pool = pool().await;
        create(&pool, create_request("every 1h")).await.unwrap();

        let claim = claim(&pool, "routine-1", "manual", false)
            .await
            .unwrap()
            .unwrap();
        assert!(claim.enabled_toolsets.is_empty());
    }

    #[tokio::test]
    async fn pre_catalog_routines_keep_the_legacy_safe_toolset() {
        let pool = pool().await;
        create(&pool, create_request("every 1h")).await.unwrap();
        query(
            "UPDATE routines
             SET metadata_json = json_remove(metadata_json, '$.enabledToolsets'),
                 tool_catalog_version = 0
             WHERE id = 'routine-1'",
        )
        .execute(&pool)
        .await
        .unwrap();

        let claim = claim(&pool, "routine-1", "manual", false)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            claim.enabled_toolsets,
            vec!["context_engine", "session_search", "web", "file"]
        );
    }

    #[tokio::test]
    async fn claimed_run_snapshots_the_resolved_model_and_safety_mode() {
        let pool = pool().await;
        let mut request = create_request("every 1h");
        request.model = "auto".into();
        request.safety_mode = Some(AgentSafetyMode::Unrestricted);
        create(&pool, request).await.unwrap();
        let claim = claim(&pool, "routine-1", "manual", false)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(claim.model, crate::providers::AUTO_GENERATION_MODEL);
        assert_eq!(claim.safety_mode, AgentSafetyMode::Unrestricted);
        let run = list_runs(&pool, Some("routine-1"))
            .await
            .unwrap()
            .pop()
            .unwrap();
        assert_eq!(run.model, crate::providers::AUTO_GENERATION_MODEL);
        assert_eq!(run.safety_mode, AgentSafetyMode::Unrestricted);
        let tools = base_unattended_tools().to_string();
        assert!(!tools.contains("computer_use"));
        assert!(!tools.contains("request_clarification"));
    }

    #[tokio::test]
    async fn routine_run_maps_one_agent_session_and_run() {
        let pool = pool().await;
        create(&pool, create_request("every 1h")).await.unwrap();
        let claim = claim(&pool, "routine-1", "manual", false)
            .await
            .unwrap()
            .unwrap();
        query("INSERT INTO agent_sessions (id) VALUES ('session-1')")
            .execute(&pool)
            .await
            .unwrap();
        query("INSERT INTO agent_runs (id) VALUES ('run-1')")
            .execute(&pool)
            .await
            .unwrap();
        attach_run_mapping(
            &pool,
            &claim.routine_run_id,
            &claim.token,
            "session-1",
            "run-1",
            &now(),
        )
        .await
        .unwrap();
        let run = list_runs(&pool, Some("routine-1"))
            .await
            .unwrap()
            .pop()
            .unwrap();
        assert_eq!(run.agent_session_id.as_deref(), Some("session-1"));
        assert_eq!(run.agent_run_id.as_deref(), Some("run-1"));
        assert_eq!(run.status, "running");
    }

    #[tokio::test]
    async fn restart_releases_an_active_agent_run_for_a_future_schedule() {
        let pool = pool().await;
        create(&pool, create_request("every 1h")).await.unwrap();
        let claim = claim(&pool, "routine-1", "manual", false)
            .await
            .unwrap()
            .unwrap();
        query("INSERT INTO agent_sessions (id) VALUES ('session-restart')")
            .execute(&pool)
            .await
            .unwrap();
        query("INSERT INTO agent_runs (id, status) VALUES ('run-restart', 'running')")
            .execute(&pool)
            .await
            .unwrap();
        attach_run_mapping(
            &pool,
            &claim.routine_run_id,
            &claim.token,
            "session-restart",
            "run-restart",
            &now(),
        )
        .await
        .unwrap();
        reconcile_after_restart(&pool).await.unwrap();
        assert_eq!(
            list_runs(&pool, Some("routine-1")).await.unwrap()[0].status,
            "interrupted"
        );
        let routine = get(&pool, "routine-1").await.unwrap();
        assert_eq!(routine.last_status.as_deref(), Some("error"));
        assert!(routine.next_run_at.is_some());
    }

    #[tokio::test]
    async fn restart_preserves_a_waiting_run_and_its_single_flight_claim() {
        let pool = pool().await;
        create(&pool, create_request("every 1h")).await.unwrap();
        let claimed_run = claim(&pool, "routine-1", "manual", false)
            .await
            .unwrap()
            .unwrap();
        query("INSERT INTO agent_sessions (id) VALUES ('session-waiting')")
            .execute(&pool)
            .await
            .unwrap();
        query(
            "INSERT INTO agent_runs (id, status, interrupted_state_json)
             VALUES ('run-waiting', 'waiting_for_user', '\"serialized-state\"')",
        )
        .execute(&pool)
        .await
        .unwrap();
        attach_run_mapping(
            &pool,
            &claimed_run.routine_run_id,
            &claimed_run.token,
            "session-waiting",
            "run-waiting",
            &now(),
        )
        .await
        .unwrap();
        mark_agent_run_waiting(&pool, "run-waiting").await.unwrap();

        reconcile_after_restart(&pool).await.unwrap();

        assert_eq!(
            list_runs(&pool, Some("routine-1")).await.unwrap()[0].status,
            "waiting_for_user"
        );
        let claim_token: Option<String> =
            query("SELECT claim_token FROM routines WHERE id = 'routine-1'")
                .fetch_one(&pool)
                .await
                .unwrap()
                .get("claim_token");
        assert_eq!(claim_token.as_deref(), Some(claimed_run.token.as_str()));
        assert!(claim(&pool, "routine-1", "manual", false)
            .await
            .unwrap()
            .is_none());
        let agent_run = query("SELECT status, interrupted_state_json FROM agent_runs WHERE id = ?")
            .bind("run-waiting")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(agent_run.get::<String, _>("status"), "waiting_for_user");
        assert_eq!(
            agent_run.get::<Option<String>, _>("interrupted_state_json"),
            Some("\"serialized-state\"".to_string())
        );
    }

    #[tokio::test]
    async fn restart_repairs_a_partially_persisted_waiting_transition() {
        let pool = pool().await;
        create(&pool, create_request("every 1h")).await.unwrap();
        let claimed_run = claim(&pool, "routine-1", "manual", false)
            .await
            .unwrap()
            .unwrap();
        query("INSERT INTO agent_sessions (id) VALUES ('session-partial-wait')")
            .execute(&pool)
            .await
            .unwrap();
        query(
            "INSERT INTO agent_runs (id, status, interrupted_state_json)
             VALUES ('run-partial-wait', 'waiting_for_user', '\"serialized-state\"')",
        )
        .execute(&pool)
        .await
        .unwrap();
        attach_run_mapping(
            &pool,
            &claimed_run.routine_run_id,
            &claimed_run.token,
            "session-partial-wait",
            "run-partial-wait",
            &now(),
        )
        .await
        .unwrap();

        reconcile_after_restart(&pool).await.unwrap();

        assert_eq!(
            list_runs(&pool, Some("routine-1")).await.unwrap()[0].status,
            "waiting_for_user"
        );
        assert!(claim(&pool, "routine-1", "manual", false)
            .await
            .unwrap()
            .is_none());
    }

    #[tokio::test]
    async fn restart_repairs_a_partially_persisted_resume_transition() {
        let pool = pool().await;
        create(&pool, create_request("every 1h")).await.unwrap();
        let claimed_run = claim(&pool, "routine-1", "manual", false)
            .await
            .unwrap()
            .unwrap();
        query("INSERT INTO agent_sessions (id) VALUES ('session-partial-resume')")
            .execute(&pool)
            .await
            .unwrap();
        query("INSERT INTO agent_runs (id, status) VALUES ('run-partial-resume', 'running')")
            .execute(&pool)
            .await
            .unwrap();
        attach_run_mapping(
            &pool,
            &claimed_run.routine_run_id,
            &claimed_run.token,
            "session-partial-resume",
            "run-partial-resume",
            &now(),
        )
        .await
        .unwrap();
        query("UPDATE routine_runs SET status = 'waiting_for_user' WHERE id = ?")
            .bind(&claimed_run.routine_run_id)
            .execute(&pool)
            .await
            .unwrap();

        reconcile_after_restart(&pool).await.unwrap();

        assert_eq!(
            list_runs(&pool, Some("routine-1")).await.unwrap()[0].status,
            "interrupted"
        );
        assert!(get(&pool, "routine-1").await.unwrap().next_run_at.is_some());
    }
}
