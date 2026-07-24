use super::domain::{
    AgentArtifactDto, AgentItemDto, AgentItemPayload, AgentRunDto, AgentSafetyMode,
    AgentSessionDto, AgentSkillDto,
};
use chrono::{SecondsFormat, Utc};
use sqlx::{query::query, row::Row};
use sqlx_sqlite::{SqlitePool, SqliteRow};
use std::collections::BTreeSet;
use uuid::Uuid;

#[derive(Clone)]
pub struct AgentRepository {
    pub(crate) pool: SqlitePool,
}

impl AgentRepository {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    pub async fn create_session(
        &self,
        title: &str,
        model: &str,
        safety_mode: AgentSafetyMode,
        workspace_path: Option<&str>,
    ) -> Result<AgentSessionDto, sqlx::Error> {
        let id = Uuid::new_v4().to_string();
        let now = now();
        query(
            "INSERT INTO agent_sessions
             (id, title, status, model, safety_mode, workspace_path, source, created_at, updated_at)
             VALUES (?, ?, 'idle', ?, ?, ?, 'user', ?, ?)",
        )
        .bind(&id)
        .bind(title.trim())
        .bind(model)
        .bind(safety_mode.as_db())
        .bind(workspace_path)
        .bind(&now)
        .bind(&now)
        .execute(&self.pool)
        .await?;
        self.get_session(&id).await
    }

    pub async fn get_session(&self, id: &str) -> Result<AgentSessionDto, sqlx::Error> {
        query(
            "SELECT id, title, status, model, safety_mode, workspace_path, source,
                    created_at, updated_at, completed_at, last_error
             FROM agent_sessions WHERE id = ?",
        )
        .bind(id)
        .fetch_one(&self.pool)
        .await
        .map(session_from_row)
    }

    pub async fn list_sessions(&self) -> Result<Vec<AgentSessionDto>, sqlx::Error> {
        query(
            "SELECT id, title, status, model, safety_mode, workspace_path, source,
                    created_at, updated_at, completed_at, last_error
             FROM agent_sessions ORDER BY updated_at DESC, id ASC",
        )
        .fetch_all(&self.pool)
        .await
        .map(|rows| rows.into_iter().map(session_from_row).collect())
    }

    pub async fn rename_session(
        &self,
        id: &str,
        title: &str,
    ) -> Result<AgentSessionDto, sqlx::Error> {
        query("UPDATE agent_sessions SET title = ?, updated_at = ? WHERE id = ?")
            .bind(title.trim())
            .bind(now())
            .bind(id)
            .execute(&self.pool)
            .await?;
        self.get_session(id).await
    }

    pub async fn delete_session(&self, id: &str) -> Result<(), sqlx::Error> {
        let deleted = query("DELETE FROM agent_sessions WHERE id = ?")
            .bind(id)
            .execute(&self.pool)
            .await?;
        if deleted.rows_affected() == 0 {
            return Err(sqlx::Error::RowNotFound);
        }
        Ok(())
    }

    pub async fn latest_run(&self, session_id: &str) -> Result<AgentRunDto, sqlx::Error> {
        query(
            "SELECT id, session_id, status, model, started_at, updated_at, completed_at,
                      usage_json, interrupted_state_json, last_sequence, error_code, error_message
               FROM agent_runs WHERE session_id = ? ORDER BY started_at DESC LIMIT 1",
        )
        .bind(session_id)
        .fetch_one(&self.pool)
        .await
        .map(run_from_row)
    }

    pub async fn create_run(
        &self,
        session_id: &str,
        model: &str,
    ) -> Result<AgentRunDto, sqlx::Error> {
        let id = Uuid::new_v4().to_string();
        let now = now();
        let mut transaction = self.pool.begin().await?;
        query(
            "INSERT INTO agent_runs
             (id, session_id, status, model, started_at, updated_at)
             VALUES (?, ?, 'running', ?, ?, ?)",
        )
        .bind(&id)
        .bind(session_id)
        .bind(model)
        .bind(&now)
        .bind(&now)
        .execute(&mut *transaction)
        .await?;
        query("UPDATE agent_sessions SET status = 'running', updated_at = ? WHERE id = ?")
            .bind(&now)
            .bind(session_id)
            .execute(&mut *transaction)
            .await?;
        transaction.commit().await?;
        self.get_run(&id).await
    }

    pub async fn get_run(&self, id: &str) -> Result<AgentRunDto, sqlx::Error> {
        let row = query(
            "SELECT id, session_id, status, model, started_at, updated_at, completed_at,
                    usage_json, interrupted_state_json, last_sequence, error_code, error_message
             FROM agent_runs WHERE id = ?",
        )
        .bind(id)
        .fetch_one(&self.pool)
        .await?;
        Ok(run_from_row(row))
    }

    pub async fn set_run_enabled_skills(
        &self,
        run_id: &str,
        skill_ids: &[String],
    ) -> Result<(), sqlx::Error> {
        let unique = skill_ids.iter().cloned().collect::<BTreeSet<_>>();
        query("UPDATE agent_runs SET enabled_skills_json = ? WHERE id = ?")
            .bind(
                serde_json::to_string(&unique)
                    .map_err(|error| sqlx::Error::Decode(Box::new(error)))?,
            )
            .bind(run_id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub async fn run_enabled_skills(&self, run_id: &str) -> Result<Vec<String>, sqlx::Error> {
        let row = query("SELECT enabled_skills_json FROM agent_runs WHERE id = ?")
            .bind(run_id)
            .fetch_one(&self.pool)
            .await?;
        serde_json::from_str(&row.get::<String, _>("enabled_skills_json"))
            .map_err(|error| sqlx::Error::Decode(Box::new(error)))
    }

    /// Persists one runtime event. Duplicate or out-of-order sequence numbers
    /// are ignored so reconnect/replay cannot duplicate transcript items.
    pub async fn append_item(
        &self,
        session_id: &str,
        run_id: Option<&str>,
        sequence: i64,
        payload: &AgentItemPayload,
        external_id: Option<&str>,
    ) -> Result<Option<AgentItemDto>, sqlx::Error> {
        let id = Uuid::new_v4().to_string();
        let now = now();
        let payload_json = payload
            .value()
            .map_err(|error| sqlx::Error::Decode(Box::new(error)))?
            .to_string();
        let mut transaction = self.pool.begin().await?;
        if let Some(run_id) = run_id {
            let updated = query(
                "UPDATE agent_runs SET last_sequence = ?, updated_at = ?
                 WHERE id = ? AND last_sequence < ?",
            )
            .bind(sequence)
            .bind(&now)
            .bind(run_id)
            .bind(sequence)
            .execute(&mut *transaction)
            .await?
            .rows_affected();
            if updated == 0 {
                transaction.rollback().await?;
                return Ok(None);
            }
        }
        let display_sequence: i64 = query(
            "SELECT COALESCE(MAX(sequence), -1) + 1 AS next_sequence FROM agent_items WHERE session_id = ?",
        )
        .bind(session_id)
        .fetch_one(&mut *transaction)
        .await?
        .get("next_sequence");
        let inserted = query(
            "INSERT OR IGNORE INTO agent_items
             (id, session_id, run_id, sequence, kind, payload_json, external_id, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&id)
        .bind(session_id)
        .bind(run_id)
        .bind(display_sequence)
        .bind(payload.kind())
        .bind(payload_json)
        .bind(external_id)
        .bind(&now)
        .execute(&mut *transaction)
        .await?
        .rows_affected();
        if inserted == 0 {
            transaction.rollback().await?;
            return Ok(None);
        }
        query("UPDATE agent_sessions SET updated_at = ? WHERE id = ?")
            .bind(&now)
            .bind(session_id)
            .execute(&mut *transaction)
            .await?;
        transaction.commit().await?;
        Ok(Some(AgentItemDto {
            id,
            session_id: session_id.to_string(),
            run_id: run_id.map(ToString::to_string),
            sequence: display_sequence,
            payload: payload.clone(),
            external_id: external_id.map(ToString::to_string),
            created_at: now,
        }))
    }

    pub async fn items(&self, session_id: &str) -> Result<Vec<AgentItemDto>, sqlx::Error> {
        let rows = query(
            "SELECT id, session_id, run_id, sequence, kind, payload_json, external_id, created_at
             FROM agent_items WHERE session_id = ? ORDER BY sequence ASC",
        )
        .bind(session_id)
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter().map(item_from_row).collect()
    }

    /// Atomically replaces compacted transcript items with one visible context
    /// summary at the earliest removed position. A replay is a no-op because
    /// the source item ids have already been removed.
    pub async fn replace_items_with_context_summary(
        &self,
        session_id: &str,
        run_id: &str,
        summary_text: &str,
        removed_item_ids: &[String],
    ) -> Result<Option<AgentItemDto>, sqlx::Error> {
        if removed_item_ids.is_empty() {
            return Ok(None);
        }
        let mut transaction = self.pool.begin().await?;
        let mut earliest_sequence: Option<i64> = None;
        for item_id in removed_item_ids {
            let row = query("SELECT sequence FROM agent_items WHERE session_id = ? AND id = ?")
                .bind(session_id)
                .bind(item_id)
                .fetch_optional(&mut *transaction)
                .await?;
            if let Some(row) = row {
                let sequence: i64 = row.get("sequence");
                earliest_sequence =
                    Some(earliest_sequence.map_or(sequence, |current| current.min(sequence)));
            }
        }
        let Some(sequence) = earliest_sequence else {
            transaction.rollback().await?;
            return Ok(None);
        };
        for item_id in removed_item_ids {
            query("DELETE FROM agent_items WHERE session_id = ? AND id = ?")
                .bind(session_id)
                .bind(item_id)
                .execute(&mut *transaction)
                .await?;
        }
        let id = Uuid::new_v4().to_string();
        let created_at = now();
        let payload = AgentItemPayload::ContextSummary(super::domain::TextPayload {
            text: summary_text.to_string(),
        });
        query(
            "INSERT INTO agent_items
             (id, session_id, run_id, sequence, kind, payload_json, external_id, created_at)
             VALUES (?, ?, ?, ?, 'context_summary', ?, ?, ?)",
        )
        .bind(&id)
        .bind(session_id)
        .bind(run_id)
        .bind(sequence)
        .bind(
            payload
                .value()
                .map_err(|error| sqlx::Error::Decode(Box::new(error)))?
                .to_string(),
        )
        .bind(format!("context-summary:{run_id}"))
        .bind(&created_at)
        .execute(&mut *transaction)
        .await?;
        query("UPDATE agent_sessions SET updated_at = ? WHERE id = ?")
            .bind(&created_at)
            .bind(session_id)
            .execute(&mut *transaction)
            .await?;
        transaction.commit().await?;
        Ok(Some(AgentItemDto {
            id,
            session_id: session_id.to_string(),
            run_id: Some(run_id.to_string()),
            sequence,
            payload,
            external_id: Some(format!("context-summary:{run_id}")),
            created_at,
        }))
    }

    pub async fn update_run_status(
        &self,
        run_id: &str,
        status: &str,
        usage: Option<&serde_json::Value>,
        interrupted_state: Option<&serde_json::Value>,
        error: Option<(&str, &str)>,
    ) -> Result<AgentRunDto, sqlx::Error> {
        let now = now();
        let terminal = matches!(status, "completed" | "cancelled" | "failed" | "interrupted");
        let run = self.get_run(run_id).await?;
        query("UPDATE agent_runs SET status = ?, updated_at = ?, completed_at = ?, usage_json = COALESCE(?, usage_json), interrupted_state_json = COALESCE(?, interrupted_state_json), error_code = ?, error_message = ? WHERE id = ?")
            .bind(status).bind(&now).bind(terminal.then_some(now.as_str()))
            .bind(usage.map(serde_json::Value::to_string))
            .bind(interrupted_state.map(serde_json::Value::to_string))
            .bind(error.map(|v| v.0)).bind(error.map(|v| v.1)).bind(run_id)
            .execute(&self.pool).await?;
        let session_status = match status {
            "waiting_for_user" => "waiting_for_user",
            "failed" => "failed",
            "interrupted" => "interrupted",
            "completed" | "cancelled" => "idle",
            _ => "running",
        };
        query("UPDATE agent_sessions SET status = ?, updated_at = ?, last_error = ? WHERE id = ?")
            .bind(session_status)
            .bind(&now)
            .bind(error.map(|v| v.1))
            .bind(&run.session_id)
            .execute(&self.pool)
            .await?;
        self.get_run(run_id).await
    }

    pub async fn mark_active_runs_interrupted(&self, message: &str) -> Result<u64, sqlx::Error> {
        let now = now();
        let result = query("UPDATE agent_runs SET status = 'interrupted', updated_at = ?, completed_at = ?, error_code = 'runtime_crashed', error_message = ? WHERE status IN ('running', 'waiting_for_user')")
            .bind(&now).bind(&now).bind(message).execute(&self.pool).await?;
        query("UPDATE agent_sessions SET status = 'interrupted', updated_at = ?, last_error = ? WHERE status IN ('running', 'waiting_for_user')")
            .bind(&now).bind(message).execute(&self.pool).await?;
        Ok(result.rows_affected())
    }

    pub async fn artifacts(&self, session_id: &str) -> Result<Vec<AgentArtifactDto>, sqlx::Error> {
        let rows = query("SELECT id, session_id, run_id, item_id, provenance, action, path, original_path, mime_type, size_bytes, available, created_at FROM agent_artifacts WHERE session_id = ? ORDER BY created_at ASC")
            .bind(session_id).fetch_all(&self.pool).await?;
        Ok(rows
            .into_iter()
            .map(|row| AgentArtifactDto {
                id: row.get("id"),
                session_id: row.get("session_id"),
                run_id: row.get("run_id"),
                item_id: row.get("item_id"),
                provenance: row.get("provenance"),
                action: row.get("action"),
                path: row.get("path"),
                original_path: row.get("original_path"),
                mime_type: row.get("mime_type"),
                size_bytes: row.get("size_bytes"),
                available: row.get::<i64, _>("available") != 0,
                created_at: row.get("created_at"),
            })
            .collect())
    }

    pub async fn skills(&self) -> Result<Vec<AgentSkillDto>, sqlx::Error> {
        let rows = query("SELECT skill_id, enabled, managed, updated_at FROM agent_skill_settings ORDER BY skill_id")
            .fetch_all(&self.pool).await?;
        Ok(rows
            .into_iter()
            .map(|row| AgentSkillDto {
                id: row.get("skill_id"),
                enabled: row.get::<i64, _>("enabled") != 0,
                managed: row.get::<i64, _>("managed") != 0,
                updated_at: row.get("updated_at"),
            })
            .collect())
    }

    pub async fn set_skill_enabled(
        &self,
        id: &str,
        enabled: bool,
        managed: bool,
    ) -> Result<AgentSkillDto, sqlx::Error> {
        let updated_at = now();
        query("INSERT INTO agent_skill_settings(skill_id, enabled, managed, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(skill_id) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at")
            .bind(id).bind(enabled).bind(managed).bind(&updated_at).execute(&self.pool).await?;
        Ok(AgentSkillDto {
            id: id.into(),
            enabled,
            managed,
            updated_at,
        })
    }
}

fn now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn session_from_row(row: SqliteRow) -> AgentSessionDto {
    AgentSessionDto {
        id: row.get("id"),
        title: row.get("title"),
        status: row.get("status"),
        model: row.get("model"),
        safety_mode: AgentSafetyMode::from(row.get::<String, _>("safety_mode").as_str()),
        workspace_path: row.get("workspace_path"),
        source: row.get("source"),
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
        completed_at: row.get("completed_at"),
        last_error: row.get("last_error"),
    }
}

fn run_from_row(row: SqliteRow) -> AgentRunDto {
    AgentRunDto {
        id: row.get("id"),
        session_id: row.get("session_id"),
        status: row.get("status"),
        model: row.get("model"),
        started_at: row.get("started_at"),
        updated_at: row.get("updated_at"),
        completed_at: row.get("completed_at"),
        usage: json_column(&row, "usage_json"),
        interrupted_state: json_column(&row, "interrupted_state_json"),
        last_sequence: row.get("last_sequence"),
        error_code: row.get("error_code"),
        error_message: row.get("error_message"),
    }
}

fn item_from_row(row: SqliteRow) -> Result<AgentItemDto, sqlx::Error> {
    let kind: String = row.get("kind");
    let payload_json: String = row.get("payload_json");
    let value = serde_json::from_str(&payload_json).map_err(decode_error)?;
    let payload = match kind.as_str() {
        "user_message" => {
            AgentItemPayload::UserMessage(serde_json::from_value(value).map_err(decode_error)?)
        }
        "assistant_message" => {
            AgentItemPayload::AssistantMessage(serde_json::from_value(value).map_err(decode_error)?)
        }
        "system_message" => {
            AgentItemPayload::SystemMessage(serde_json::from_value(value).map_err(decode_error)?)
        }
        "reasoning" => {
            AgentItemPayload::Reasoning(serde_json::from_value(value).map_err(decode_error)?)
        }
        "context_summary" => {
            AgentItemPayload::ContextSummary(serde_json::from_value(value).map_err(decode_error)?)
        }
        "tool_call" => {
            AgentItemPayload::ToolCall(serde_json::from_value(value).map_err(decode_error)?)
        }
        "tool_result" => {
            AgentItemPayload::ToolResult(serde_json::from_value(value).map_err(decode_error)?)
        }
        "interruption" => AgentItemPayload::Interruption(value),
        _ => AgentItemPayload::Error(value),
    };
    Ok(AgentItemDto {
        id: row.get("id"),
        session_id: row.get("session_id"),
        run_id: row.get("run_id"),
        sequence: row.get("sequence"),
        payload,
        external_id: row.get("external_id"),
        created_at: row.get("created_at"),
    })
}

fn json_column(row: &SqliteRow, column: &str) -> Option<serde_json::Value> {
    row.get::<Option<String>, _>(column)
        .and_then(|value| serde_json::from_str(&value).ok())
}

fn decode_error(error: serde_json::Error) -> sqlx::Error {
    sqlx::Error::Decode(Box::new(error))
}
