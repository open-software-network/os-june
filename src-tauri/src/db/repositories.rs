use crate::domain::types::{
    AgentMessageDto, AgentMessageRole, AgentSafetyProfile, AgentTaskDto, AgentTaskListResponse,
    AgentTaskStatus, AgentToolEventDto, AgentToolEventStatus, AppError, AudioArtifactDto,
    DictationHistoryItemDto, DictionaryEntryDto, FolderDto, ListDictationHistoryResponse,
    ListNotesResponse, NoteDto, NoteListItemDto, ProcessingStatus, RecordingSourceMode,
    SessionFolderDto, TranscriptDto,
};
use chrono::{Duration, SecondsFormat, Utc};
use sqlx::{Row, SqlitePool};
use uuid::Uuid;

const DICTATION_HISTORY_RETENTION_DAYS: i64 = 7;

#[derive(Clone)]
pub struct Repositories {
    pub pool: SqlitePool,
}

impl Repositories {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    pub async fn list_folders(&self) -> Result<Vec<FolderDto>, sqlx::Error> {
        let rows = sqlx::query(
            "SELECT id, name, description, created_at, updated_at FROM folders WHERE deleted_at IS NULL ORDER BY lower(name) ASC",
        )
        .fetch_all(&self.pool)
        .await?;

        Ok(rows.into_iter().map(folder_from_row).collect())
    }

    pub async fn create_folder(
        &self,
        name: impl AsRef<str>,
        description: Option<&str>,
    ) -> Result<FolderDto, sqlx::Error> {
        let now = timestamp();
        let description = description
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        let folder = FolderDto {
            id: Uuid::new_v4().to_string(),
            name: name.as_ref().trim().to_string(),
            description: description.clone(),
            created_at: now.clone(),
            updated_at: now,
        };

        sqlx::query(
            "INSERT INTO folders (id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
        )
        .bind(&folder.id)
        .bind(&folder.name)
        .bind(&folder.description)
        .bind(&folder.created_at)
        .bind(&folder.updated_at)
        .execute(&self.pool)
        .await?;

        Ok(folder)
    }

    pub async fn rename_folder(
        &self,
        folder_id: &str,
        name: &str,
        description: Option<&str>,
    ) -> Result<FolderDto, AppError> {
        let now = timestamp();
        let trimmed = name.trim();
        let description = description
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        let result = sqlx::query(
            "UPDATE folders SET name = ?, description = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL",
        )
        .bind(trimmed)
        .bind(&description)
        .bind(&now)
        .bind(folder_id)
        .execute(&self.pool)
        .await?;
        if result.rows_affected() == 0 {
            return Err(AppError::new(
                "folder_not_found",
                "Folder was not found or has already been deleted.",
            ));
        }

        let row = sqlx::query(
            "SELECT id, name, description, created_at, updated_at FROM folders WHERE id = ? AND deleted_at IS NULL",
        )
        .bind(folder_id)
        .fetch_one(&self.pool)
        .await?;

        Ok(folder_from_row(row))
    }

    pub async fn create_note(&self, folder_id: Option<String>) -> Result<NoteDto, sqlx::Error> {
        let now = timestamp();
        let id = Uuid::new_v4().to_string();

        let mut tx = self.pool.begin().await?;
        sqlx::query(
            "INSERT INTO notes (id, title, processing_status, created_at, updated_at) VALUES (?, '', 'draft', ?, ?)",
        )
        .bind(&id)
        .bind(&now)
        .bind(&now)
        .execute(&mut *tx)
        .await?;

        if let Some(folder_id) = folder_id {
            sqlx::query("INSERT OR IGNORE INTO note_folders (note_id, folder_id, assigned_at) VALUES (?, ?, ?)")
                .bind(&id)
                .bind(folder_id)
                .bind(&now)
                .execute(&mut *tx)
                .await?;
        }

        tx.commit().await?;
        self.get_note(&id).await
    }

    pub async fn get_note(&self, note_id: &str) -> Result<NoteDto, sqlx::Error> {
        let row = sqlx::query(
            "SELECT id, title, generated_content, edited_content, active_tab, processing_status, created_at, updated_at, last_error FROM notes WHERE id = ?",
        )
        .bind(note_id)
        .fetch_one(&self.pool)
        .await?;

        let folder_ids = self.folder_ids(note_id).await?;
        let content = row
            .try_get::<Option<String>, _>("edited_content")?
            .or_else(|| {
                row.try_get::<Option<String>, _>("generated_content")
                    .ok()
                    .flatten()
            })
            .unwrap_or_default();
        let title: String = row.get("title");

        Ok(NoteDto {
            id: row.get("id"),
            title: title.clone(),
            preview: preview_for(&title, &content),
            processing_status: ProcessingStatus::from(
                row.get::<String, _>("processing_status").as_str(),
            ),
            folder_ids,
            created_at: row.get("created_at"),
            updated_at: row.get("updated_at"),
            duration_ms: None,
            generated_content: row.get("generated_content"),
            edited_content: row.get("edited_content"),
            transcript: self.latest_transcript(note_id).await?,
            source_transcripts: self.source_transcripts(note_id).await?,
            recording: None,
            audio: self.latest_audio_artifact(note_id).await?,
            audio_sources: self.latest_audio_sources(note_id).await?,
            active_tab: row.get("active_tab"),
            last_error: row.get("last_error"),
            queued_recordings: 0,
        })
    }

    pub async fn list_notes(
        &self,
        folder_id: Option<String>,
        limit: i64,
        _cursor: Option<String>,
    ) -> Result<ListNotesResponse, sqlx::Error> {
        let rows = if let Some(folder_id) = folder_id {
            sqlx::query(
                "SELECT n.id, n.title, n.generated_content, n.edited_content, n.processing_status, n.created_at, n.updated_at
                 FROM notes n
                 INNER JOIN note_folders nf ON nf.note_id = n.id
                 WHERE nf.folder_id = ?
                 ORDER BY n.created_at DESC, n.rowid DESC
                 LIMIT ?",
            )
            .bind(folder_id)
            .bind(limit)
            .fetch_all(&self.pool)
            .await?
        } else {
            sqlx::query(
                "SELECT id, title, generated_content, edited_content, processing_status, created_at, updated_at
                 FROM notes
                 ORDER BY created_at DESC, rowid DESC
                 LIMIT ?",
            )
            .bind(limit)
            .fetch_all(&self.pool)
            .await?
        };

        let mut items = Vec::with_capacity(rows.len());
        for row in rows {
            let id: String = row.get("id");
            let title: String = row.get("title");
            let content = row
                .try_get::<Option<String>, _>("edited_content")?
                .or_else(|| {
                    row.try_get::<Option<String>, _>("generated_content")
                        .ok()
                        .flatten()
                })
                .unwrap_or_default();
            items.push(NoteListItemDto {
                id: id.clone(),
                title: title.clone(),
                preview: preview_for(&title, &content),
                processing_status: ProcessingStatus::from(
                    row.get::<String, _>("processing_status").as_str(),
                ),
                folder_ids: self.folder_ids(&id).await?,
                created_at: row.get("created_at"),
                updated_at: row.get("updated_at"),
                duration_ms: None,
            });
        }

        Ok(ListNotesResponse {
            items,
            next_cursor: None,
        })
    }

    pub async fn assign_note_to_folder(
        &self,
        note_id: &str,
        folder_id: &str,
    ) -> Result<NoteDto, sqlx::Error> {
        sqlx::query(
            "INSERT OR IGNORE INTO note_folders (note_id, folder_id, assigned_at) VALUES (?, ?, ?)",
        )
        .bind(note_id)
        .bind(folder_id)
        .bind(timestamp())
        .execute(&self.pool)
        .await?;
        self.get_note(note_id).await
    }

    pub async fn remove_note_from_folder(
        &self,
        note_id: &str,
        folder_id: &str,
    ) -> Result<NoteDto, sqlx::Error> {
        sqlx::query("DELETE FROM note_folders WHERE note_id = ? AND folder_id = ?")
            .bind(note_id)
            .bind(folder_id)
            .execute(&self.pool)
            .await?;
        self.get_note(note_id).await
    }

    pub async fn list_session_folders(&self) -> Result<Vec<SessionFolderDto>, sqlx::Error> {
        let rows = sqlx::query(
            "SELECT sf.session_id, sf.folder_id
             FROM session_folders sf
             INNER JOIN folders f ON f.id = sf.folder_id
             WHERE f.deleted_at IS NULL
             ORDER BY sf.assigned_at ASC",
        )
        .fetch_all(&self.pool)
        .await?;
        Ok(rows
            .into_iter()
            .map(|row| SessionFolderDto {
                session_id: row.get("session_id"),
                folder_id: row.get("folder_id"),
            })
            .collect())
    }

    pub async fn assign_session_to_folder(
        &self,
        session_id: &str,
        folder_id: &str,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            "INSERT OR IGNORE INTO session_folders (session_id, folder_id, assigned_at) VALUES (?, ?, ?)",
        )
        .bind(session_id)
        .bind(folder_id)
        .bind(timestamp())
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn remove_session_from_folder(
        &self,
        session_id: &str,
        folder_id: &str,
    ) -> Result<(), sqlx::Error> {
        sqlx::query("DELETE FROM session_folders WHERE session_id = ? AND folder_id = ?")
            .bind(session_id)
            .bind(folder_id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub async fn list_dictionary_entries(&self) -> Result<Vec<DictionaryEntryDto>, sqlx::Error> {
        let rows = sqlx::query(
            "SELECT id, phrase, created_at, updated_at
             FROM dictionary_entries
             WHERE deleted_at IS NULL
             ORDER BY lower(phrase) ASC, created_at ASC",
        )
        .fetch_all(&self.pool)
        .await?;
        Ok(rows.into_iter().map(dictionary_entry_from_row).collect())
    }

    pub async fn create_dictation_history_item(
        &self,
        text: &str,
        language: Option<String>,
        provider: &str,
    ) -> Result<Option<DictationHistoryItemDto>, sqlx::Error> {
        let text = text.trim();
        if text.is_empty() {
            return Ok(None);
        }
        let item = DictationHistoryItemDto {
            id: Uuid::new_v4().to_string(),
            text: text.to_string(),
            language,
            provider: provider.to_string(),
            created_at: timestamp(),
        };
        sqlx::query(
            "INSERT INTO dictation_history (id, text, language, provider, created_at)
             VALUES (?, ?, ?, ?, ?)",
        )
        .bind(&item.id)
        .bind(&item.text)
        .bind(&item.language)
        .bind(&item.provider)
        .bind(&item.created_at)
        .execute(&self.pool)
        .await?;
        self.prune_old_dictation_history().await?;
        Ok(Some(item))
    }

    pub async fn list_dictation_history(
        &self,
        limit: i64,
    ) -> Result<ListDictationHistoryResponse, sqlx::Error> {
        self.prune_old_dictation_history().await?;
        let rows = sqlx::query(
            "SELECT id, text, language, provider, created_at
             FROM dictation_history
             WHERE created_at >= ?
             ORDER BY created_at DESC, rowid DESC
             LIMIT ?",
        )
        .bind(dictation_history_cutoff_timestamp())
        .bind(limit.clamp(1, 500))
        .fetch_all(&self.pool)
        .await?;

        Ok(ListDictationHistoryResponse {
            items: rows
                .into_iter()
                .map(dictation_history_item_from_row)
                .collect(),
            retention_days: DICTATION_HISTORY_RETENTION_DAYS,
        })
    }

    pub async fn prune_old_dictation_history(&self) -> Result<(), sqlx::Error> {
        sqlx::query("DELETE FROM dictation_history WHERE created_at < ?")
            .bind(dictation_history_cutoff_timestamp())
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub async fn pause_running_agent_tasks_on_launch(&self) -> Result<(), sqlx::Error> {
        let now = timestamp();
        sqlx::query(
            "UPDATE agent_tasks
             SET status = 'paused',
                 progress_summary = 'Paused when June restarted.',
                 updated_at = ?
             WHERE status IN ('queued', 'running')",
        )
        .bind(now)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Repairs genuinely stale `queued`/`running` tasks whose latest message
    /// is already an assistant reply. `paused` and `waiting_for_user` are
    /// deliberate resting states (placeholder pauses, clarify exchanges) and
    /// must never be force-completed by this repair.
    pub async fn complete_agent_tasks_with_assistant_messages(&self) -> Result<(), sqlx::Error> {
        sqlx::query(
            "UPDATE agent_tasks
             SET status = 'completed',
                 progress_summary = 'Completed.',
                 updated_at = COALESCE(
                     (SELECT MAX(created_at)
                      FROM agent_messages
                      WHERE task_id = agent_tasks.id AND role = 'assistant'),
                     updated_at
                 ),
                 completed_at = COALESCE(
                     completed_at,
                     (SELECT MAX(created_at)
                      FROM agent_messages
                      WHERE task_id = agent_tasks.id AND role = 'assistant'),
                     updated_at
                 )
             WHERE status IN ('queued', 'running')
               AND (SELECT role
                    FROM agent_messages
                    WHERE task_id = agent_tasks.id
                    ORDER BY created_at DESC, rowid DESC
                    LIMIT 1) = 'assistant'",
        )
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn list_agent_tasks(&self) -> Result<AgentTaskListResponse, sqlx::Error> {
        let rows = sqlx::query(
            "SELECT id, title, prompt, status, safety_profile, progress_summary, last_error,
                    hermes_session_id, created_at, updated_at, completed_at
             FROM agent_tasks
             ORDER BY updated_at DESC, rowid DESC
             LIMIT 200",
        )
        .fetch_all(&self.pool)
        .await?;
        Ok(AgentTaskListResponse {
            items: rows.into_iter().map(agent_task_from_row).collect(),
        })
    }

    pub async fn create_agent_task(
        &self,
        prompt: &str,
        title: Option<&str>,
        safety_profile: AgentSafetyProfile,
    ) -> Result<AgentTaskDto, sqlx::Error> {
        let now = timestamp();
        let task_id = Uuid::new_v4().to_string();
        let trimmed_prompt = prompt.trim();
        let title = title
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| title_from_prompt(trimmed_prompt));

        let mut tx = self.pool.begin().await?;
        sqlx::query(
            "INSERT INTO agent_tasks
             (id, title, prompt, status, safety_profile, progress_summary, created_at, updated_at)
             VALUES (?, ?, ?, 'queued', ?, 'Queued for the agent runtime.', ?, ?)",
        )
        .bind(&task_id)
        .bind(title)
        .bind(trimmed_prompt)
        .bind(safety_profile.as_db())
        .bind(&now)
        .bind(&now)
        .execute(&mut *tx)
        .await?;
        sqlx::query(
            "INSERT INTO agent_messages (id, task_id, role, content, created_at)
             VALUES (?, ?, 'user', ?, ?)",
        )
        .bind(Uuid::new_v4().to_string())
        .bind(&task_id)
        .bind(trimmed_prompt)
        .bind(&now)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        self.get_agent_task(&task_id).await
    }

    pub async fn get_agent_task(&self, task_id: &str) -> Result<AgentTaskDto, sqlx::Error> {
        let row = sqlx::query(
            "SELECT id, title, prompt, status, safety_profile, progress_summary, last_error,
                    hermes_session_id, created_at, updated_at, completed_at
             FROM agent_tasks
             WHERE id = ?",
        )
        .bind(task_id)
        .fetch_one(&self.pool)
        .await?;
        let mut task = agent_task_from_row(row);
        task.messages = self.agent_messages(task_id).await?;
        task.tool_events = self.agent_tool_events(task_id).await?;
        Ok(task)
    }

    pub async fn set_agent_task_hermes_session(
        &self,
        task_id: &str,
        hermes_session_id: &str,
    ) -> Result<(), sqlx::Error> {
        sqlx::query("UPDATE agent_tasks SET hermes_session_id = ? WHERE id = ?")
            .bind(hermes_session_id)
            .bind(task_id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub async fn add_agent_message(
        &self,
        task_id: &str,
        role: AgentMessageRole,
        content: &str,
    ) -> Result<AgentMessageDto, sqlx::Error> {
        let now = timestamp();
        let id = Uuid::new_v4().to_string();
        sqlx::query(
            "INSERT INTO agent_messages (id, task_id, role, content, created_at)
             VALUES (?, ?, ?, ?, ?)",
        )
        .bind(&id)
        .bind(task_id)
        .bind(role.as_db())
        .bind(content)
        .bind(&now)
        .execute(&self.pool)
        .await?;
        sqlx::query("UPDATE agent_tasks SET updated_at = ? WHERE id = ?")
            .bind(&now)
            .bind(task_id)
            .execute(&self.pool)
            .await?;
        let row = sqlx::query(
            "SELECT id, task_id, role, content, created_at
             FROM agent_messages
             WHERE id = ?",
        )
        .bind(id)
        .fetch_one(&self.pool)
        .await?;
        Ok(agent_message_from_row(row))
    }

    /// Inserts a hydrated message exactly once. `external_id` carries the
    /// source-side identity (e.g. a Hermes message id); the unique index on
    /// `(task_id, external_id)` plus `INSERT OR IGNORE` makes concurrent
    /// hydrations race-safe. Rows hydrated before external ids existed are
    /// matched by content so they are not duplicated either.
    pub async fn add_agent_message_if_absent(
        &self,
        task_id: &str,
        role: AgentMessageRole,
        content: &str,
        created_at: &str,
        external_id: &str,
    ) -> Result<bool, sqlx::Error> {
        let existing = sqlx::query(
            "SELECT 1 FROM agent_messages
             WHERE task_id = ?
               AND role = ?
               AND (external_id = ? OR (external_id IS NULL AND content = ?))
             LIMIT 1",
        )
        .bind(task_id)
        .bind(role.as_db())
        .bind(external_id)
        .bind(content)
        .fetch_optional(&self.pool)
        .await?;
        if existing.is_some() {
            return Ok(false);
        }
        let result = sqlx::query(
            "INSERT OR IGNORE INTO agent_messages
             (id, task_id, role, content, created_at, external_id)
             VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind(Uuid::new_v4().to_string())
        .bind(task_id)
        .bind(role.as_db())
        .bind(content)
        .bind(created_at)
        .bind(external_id)
        .execute(&self.pool)
        .await?;
        Ok(result.rows_affected() > 0)
    }

    pub async fn update_agent_task_status(
        &self,
        task_id: &str,
        status: AgentTaskStatus,
        progress_summary: Option<&str>,
        last_error: Option<&str>,
    ) -> Result<AgentTaskDto, sqlx::Error> {
        let now = timestamp();
        let completed_at = match status {
            AgentTaskStatus::Completed | AgentTaskStatus::Cancelled => Some(now.clone()),
            _ => None,
        };
        sqlx::query(
            "UPDATE agent_tasks
             SET status = ?, progress_summary = ?, last_error = ?, updated_at = ?,
                 completed_at = COALESCE(?, completed_at)
             WHERE id = ?",
        )
        .bind(status.as_db())
        .bind(progress_summary)
        .bind(last_error)
        .bind(&now)
        .bind(completed_at)
        .bind(task_id)
        .execute(&self.pool)
        .await?;
        self.get_agent_task(task_id).await
    }

    /// Updates a task's status only when its current status is in
    /// `allowed_current`. Returns whether the transition was applied. This
    /// lets background work (e.g. the runtime placeholder) avoid clobbering
    /// states the user reached concurrently, such as resurrecting a
    /// cancelled task.
    pub async fn update_agent_task_status_if_in(
        &self,
        task_id: &str,
        status: AgentTaskStatus,
        progress_summary: Option<&str>,
        last_error: Option<&str>,
        allowed_current: &[AgentTaskStatus],
    ) -> Result<bool, sqlx::Error> {
        if allowed_current.is_empty() {
            return Ok(false);
        }
        let now = timestamp();
        let completed_at = match status {
            AgentTaskStatus::Completed | AgentTaskStatus::Cancelled => Some(now.clone()),
            _ => None,
        };
        let placeholders = vec!["?"; allowed_current.len()].join(", ");
        let sql = format!(
            "UPDATE agent_tasks
             SET status = ?, progress_summary = ?, last_error = ?, updated_at = ?,
                 completed_at = COALESCE(?, completed_at)
             WHERE id = ? AND status IN ({placeholders})"
        );
        let mut query = sqlx::query(&sql)
            .bind(status.as_db())
            .bind(progress_summary)
            .bind(last_error)
            .bind(&now)
            .bind(completed_at)
            .bind(task_id);
        for current in allowed_current {
            query = query.bind(current.as_db());
        }
        let result = query.execute(&self.pool).await?;
        Ok(result.rows_affected() > 0)
    }

    /// Returns whether a Hermes session is already bound to a different
    /// task, so heuristic session matching never steals another task's
    /// conversation.
    pub async fn hermes_session_bound_to_other_task(
        &self,
        task_id: &str,
        hermes_session_id: &str,
    ) -> Result<bool, sqlx::Error> {
        let row = sqlx::query(
            "SELECT 1 FROM agent_tasks WHERE hermes_session_id = ? AND id != ? LIMIT 1",
        )
        .bind(hermes_session_id)
        .bind(task_id)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.is_some())
    }

    pub async fn add_agent_tool_event(
        &self,
        task_id: &str,
        tool_name: &str,
        status: AgentToolEventStatus,
        summary: &str,
        arguments_json: Option<&str>,
        result_json: Option<&str>,
        redacted: bool,
    ) -> Result<AgentToolEventDto, sqlx::Error> {
        let now = timestamp();
        let completed_at = match status {
            AgentToolEventStatus::Completed
            | AgentToolEventStatus::Failed
            | AgentToolEventStatus::Blocked => Some(now.clone()),
            _ => None,
        };
        let id = Uuid::new_v4().to_string();
        sqlx::query(
            "INSERT INTO agent_tool_events
             (id, task_id, tool_name, status, summary, arguments_json, result_json,
              redacted, created_at, completed_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&id)
        .bind(task_id)
        .bind(tool_name)
        .bind(status.as_db())
        .bind(summary)
        .bind(arguments_json)
        .bind(result_json)
        .bind(if redacted { 1 } else { 0 })
        .bind(&now)
        .bind(completed_at)
        .execute(&self.pool)
        .await?;
        sqlx::query("UPDATE agent_tasks SET updated_at = ? WHERE id = ?")
            .bind(&now)
            .bind(task_id)
            .execute(&self.pool)
            .await?;
        let row = sqlx::query(
            "SELECT id, task_id, tool_name, status, summary, arguments_json, result_json,
                    redacted, created_at, completed_at
             FROM agent_tool_events
             WHERE id = ?",
        )
        .bind(id)
        .fetch_one(&self.pool)
        .await?;
        Ok(agent_tool_event_from_row(row))
    }

    pub async fn agent_tool_events(
        &self,
        task_id: &str,
    ) -> Result<Vec<AgentToolEventDto>, sqlx::Error> {
        let rows = sqlx::query(
            "SELECT id, task_id, tool_name, status, summary, arguments_json, result_json,
                    redacted, created_at, completed_at
             FROM agent_tool_events
             WHERE task_id = ?
             ORDER BY created_at ASC, rowid ASC",
        )
        .bind(task_id)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows.into_iter().map(agent_tool_event_from_row).collect())
    }

    async fn agent_messages(&self, task_id: &str) -> Result<Vec<AgentMessageDto>, sqlx::Error> {
        let rows = sqlx::query(
            "SELECT id, task_id, role, content, created_at
             FROM agent_messages
             WHERE task_id = ?
             ORDER BY created_at ASC, rowid ASC",
        )
        .bind(task_id)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows.into_iter().map(agent_message_from_row).collect())
    }

    pub async fn delete_dictation_history_item(&self, id: &str) -> Result<(), sqlx::Error> {
        sqlx::query("DELETE FROM dictation_history WHERE id = ?")
            .bind(id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub async fn create_dictionary_entry(
        &self,
        phrase: &str,
    ) -> Result<DictionaryEntryDto, sqlx::Error> {
        let now = timestamp();
        let entry = DictionaryEntryDto {
            id: Uuid::new_v4().to_string(),
            phrase: phrase.trim().to_string(),
            created_at: now.clone(),
            updated_at: now,
        };
        sqlx::query(
            "INSERT INTO dictionary_entries (id, phrase, created_at, updated_at)
             VALUES (?, ?, ?, ?)",
        )
        .bind(&entry.id)
        .bind(&entry.phrase)
        .bind(&entry.created_at)
        .bind(&entry.updated_at)
        .execute(&self.pool)
        .await?;
        Ok(entry)
    }

    pub async fn update_dictionary_entry(
        &self,
        entry_id: &str,
        phrase: &str,
    ) -> Result<DictionaryEntryDto, AppError> {
        let now = timestamp();
        let result = sqlx::query(
            "UPDATE dictionary_entries
             SET phrase = ?, updated_at = ?
             WHERE id = ? AND deleted_at IS NULL",
        )
        .bind(phrase.trim())
        .bind(&now)
        .bind(entry_id)
        .execute(&self.pool)
        .await?;
        if result.rows_affected() == 0 {
            return Err(AppError::new(
                "dictionary_entry_not_found",
                "Dictionary entry was not found.",
            ));
        }
        let row = sqlx::query(
            "SELECT id, phrase, created_at, updated_at
             FROM dictionary_entries
             WHERE id = ? AND deleted_at IS NULL",
        )
        .bind(entry_id)
        .fetch_one(&self.pool)
        .await?;
        Ok(dictionary_entry_from_row(row))
    }

    pub async fn delete_dictionary_entry(&self, entry_id: &str) -> Result<(), AppError> {
        let now = timestamp();
        let result = sqlx::query(
            "UPDATE dictionary_entries SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL",
        )
        .bind(&now)
        .bind(&now)
        .bind(entry_id)
        .execute(&self.pool)
        .await?;
        if result.rows_affected() == 0 {
            return Err(AppError::new(
                "dictionary_entry_not_found",
                "Dictionary entry was not found.",
            ));
        }
        Ok(())
    }

    pub async fn update_note(
        &self,
        note_id: &str,
        title: Option<String>,
        edited_content: Option<String>,
        active_tab: Option<String>,
    ) -> Result<NoteDto, sqlx::Error> {
        let current = self.get_note(note_id).await?;
        let next_title = title.unwrap_or(current.title);
        let next_content = edited_content.or(current.edited_content);
        let next_tab = active_tab
            .or(current.active_tab)
            .unwrap_or_else(|| "notes".to_string());

        sqlx::query(
            "UPDATE notes SET title = ?, edited_content = ?, active_tab = ?, updated_at = ? WHERE id = ?",
        )
        .bind(next_title)
        .bind(next_content)
        .bind(next_tab)
        .bind(timestamp())
        .bind(note_id)
        .execute(&self.pool)
        .await?;

        self.get_note(note_id).await
    }

    pub async fn audio_artifact_paths_for_note(
        &self,
        note_id: &str,
    ) -> Result<Vec<String>, sqlx::Error> {
        let rows = sqlx::query("SELECT path FROM audio_artifacts WHERE note_id = ?")
            .bind(note_id)
            .fetch_all(&self.pool)
            .await?;
        Ok(rows.into_iter().map(|row| row.get("path")).collect())
    }

    pub async fn audio_artifact_paths_for_notes(
        &self,
        note_ids: &[String],
    ) -> Result<Vec<String>, sqlx::Error> {
        let mut paths = Vec::new();
        for note_id in note_ids {
            paths.extend(self.audio_artifact_paths_for_note(note_id).await?);
        }
        Ok(paths)
    }

    pub async fn delete_note(&self, note_id: &str) -> Result<(), sqlx::Error> {
        let mut tx = self.pool.begin().await?;
        delete_note_records(&mut tx, note_id).await?;
        tx.commit().await
    }

    pub async fn delete_notes(&self, note_ids: &[String]) -> Result<(), sqlx::Error> {
        let mut tx = self.pool.begin().await?;
        for note_id in note_ids {
            delete_note_records(&mut tx, note_id).await?;
        }
        tx.commit().await
    }

    pub async fn delete_folder(
        &self,
        folder_id: &str,
        delete_notes: bool,
    ) -> Result<(), sqlx::Error> {
        let now = timestamp();
        let mut tx = self.pool.begin().await?;

        if delete_notes {
            sqlx::query(
                "DELETE FROM note_generation_blocks
                 WHERE note_id IN (SELECT note_id FROM note_folders WHERE folder_id = ?)",
            )
            .bind(folder_id)
            .execute(&mut *tx)
            .await?;
            sqlx::query(
                "DELETE FROM generation_results
                 WHERE note_id IN (SELECT note_id FROM note_folders WHERE folder_id = ?)",
            )
            .bind(folder_id)
            .execute(&mut *tx)
            .await?;
            sqlx::query(
                "DELETE FROM transcripts
                 WHERE note_id IN (SELECT note_id FROM note_folders WHERE folder_id = ?)",
            )
            .bind(folder_id)
            .execute(&mut *tx)
            .await?;
            sqlx::query(
                "DELETE FROM audio_artifacts
                 WHERE note_id IN (SELECT note_id FROM note_folders WHERE folder_id = ?)",
            )
            .bind(folder_id)
            .execute(&mut *tx)
            .await?;
            sqlx::query(
                "DELETE FROM recording_checkpoints
                 WHERE recording_session_id IN (
                   SELECT rs.id
                   FROM recording_sessions rs
                   INNER JOIN note_folders nf ON nf.note_id = rs.note_id
                   WHERE nf.folder_id = ?
                 )",
            )
            .bind(folder_id)
            .execute(&mut *tx)
            .await?;
            sqlx::query(
                "DELETE FROM recording_sessions
                 WHERE note_id IN (SELECT note_id FROM note_folders WHERE folder_id = ?)",
            )
            .bind(folder_id)
            .execute(&mut *tx)
            .await?;
            sqlx::query(
                "DELETE FROM notes
                 WHERE id IN (SELECT note_id FROM note_folders WHERE folder_id = ?)",
            )
            .bind(folder_id)
            .execute(&mut *tx)
            .await?;
        }

        sqlx::query("DELETE FROM note_folders WHERE folder_id = ?")
            .bind(folder_id)
            .execute(&mut *tx)
            .await?;
        sqlx::query("DELETE FROM session_folders WHERE folder_id = ?")
            .bind(folder_id)
            .execute(&mut *tx)
            .await?;
        sqlx::query("UPDATE folders SET deleted_at = ?, updated_at = ? WHERE id = ?")
            .bind(&now)
            .bind(&now)
            .bind(folder_id)
            .execute(&mut *tx)
            .await?;

        tx.commit().await
    }

    pub async fn set_note_status(
        &self,
        note_id: &str,
        status: ProcessingStatus,
        last_error: Option<String>,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            "UPDATE notes SET processing_status = ?, last_error = ?, updated_at = ? WHERE id = ?",
        )
        .bind(status.as_db())
        .bind(last_error)
        .bind(timestamp())
        .bind(note_id)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn set_generated_note(
        &self,
        note_id: &str,
        title: Option<String>,
        content: String,
    ) -> Result<NoteDto, sqlx::Error> {
        self.set_generated_note_for_session(note_id, None, None, title, content)
            .await
    }

    pub async fn set_generated_note_for_session(
        &self,
        note_id: &str,
        recording_session_id: Option<&str>,
        generation_result_id: Option<&str>,
        title: Option<String>,
        content: String,
    ) -> Result<NoteDto, sqlx::Error> {
        let current = self.get_note(note_id).await?;
        let title = if is_replaceable_generated_title(&current.title) {
            usable_generated_title(title.as_deref())
                .or_else(|| generated_title_from_content(&content))
                .unwrap_or_else(|| "New note".to_string())
        } else {
            current.title.clone()
        };
        let recording_session_id = recording_session_id
            .map(str::trim)
            .filter(|value| !value.is_empty());
        let existing_session_block = match recording_session_id {
            Some(session_id) => self.generation_block_exists(note_id, session_id).await?,
            None => false,
        };
        let manual_tail = manual_tail_for_append(
            current.generated_content.as_deref(),
            current.edited_content.as_deref(),
        );
        let existing_for_normalization = if existing_session_block {
            None
        } else {
            current.generated_content.as_deref()
        };
        let content = normalize_generated_addition(
            &title,
            existing_for_normalization,
            manual_tail.as_deref(),
            &content,
        );
        let next_generated_content = if let Some(session_id) = recording_session_id {
            if self.generation_block_count(note_id).await? == 0 {
                self.seed_legacy_generation_block(
                    note_id,
                    current.generated_content.as_deref(),
                    Some(title.as_str()),
                )
                .await?;
            }
            self.upsert_generation_block(
                note_id,
                session_id,
                generation_result_id,
                Some(title.as_str()),
                &content,
            )
            .await?;
            self.compose_generation_blocks(note_id)
                .await?
                .unwrap_or_default()
        } else {
            append_note_content(current.generated_content.clone(), content.clone())
        };
        let next_edited_content = current.edited_content.map(|edited_content| {
            if existing_session_block {
                if edited_content.trim()
                    == current.generated_content.as_deref().unwrap_or("").trim()
                {
                    next_generated_content.clone()
                } else {
                    edited_content
                }
            } else {
                let content = normalize_generated_addition(
                    &title,
                    Some(edited_content.as_str()),
                    manual_tail.as_deref(),
                    &content,
                );
                append_note_content(Some(edited_content), content)
            }
        });
        sqlx::query(
            "UPDATE notes SET title = ?, generated_content = ?, edited_content = ?, active_tab = 'notes', processing_status = 'ready', last_error = NULL, updated_at = ? WHERE id = ?",
        )
        .bind(title)
        .bind(next_generated_content)
        .bind(next_edited_content)
        .bind(timestamp())
        .bind(note_id)
        .execute(&self.pool)
        .await?;
        self.get_note(note_id).await
    }

    async fn generation_block_exists(
        &self,
        note_id: &str,
        recording_session_id: &str,
    ) -> Result<bool, sqlx::Error> {
        let row = sqlx::query(
            "SELECT 1 FROM note_generation_blocks WHERE note_id = ? AND recording_session_id = ? LIMIT 1",
        )
        .bind(note_id)
        .bind(recording_session_id)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.is_some())
    }

    async fn generation_block_count(&self, note_id: &str) -> Result<i64, sqlx::Error> {
        let row =
            sqlx::query("SELECT COUNT(*) AS count FROM note_generation_blocks WHERE note_id = ?")
                .bind(note_id)
                .fetch_one(&self.pool)
                .await?;
        Ok(row.get("count"))
    }

    async fn seed_legacy_generation_block(
        &self,
        note_id: &str,
        content: Option<&str>,
        title_suggestion: Option<&str>,
    ) -> Result<(), sqlx::Error> {
        let Some(content) = content.map(str::trim).filter(|value| !value.is_empty()) else {
            return Ok(());
        };
        let now = timestamp();
        sqlx::query(
            "INSERT INTO note_generation_blocks
             (id, note_id, recording_session_id, generation_result_id, content, title_suggestion, sort_order, created_at, updated_at)
             VALUES (?, ?, NULL, NULL, ?, ?, 0, ?, ?)",
        )
        .bind(Uuid::new_v4().to_string())
        .bind(note_id)
        .bind(content)
        .bind(title_suggestion)
        .bind(&now)
        .bind(&now)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    async fn upsert_generation_block(
        &self,
        note_id: &str,
        recording_session_id: &str,
        generation_result_id: Option<&str>,
        title_suggestion: Option<&str>,
        content: &str,
    ) -> Result<(), sqlx::Error> {
        let now = timestamp();
        if let Some(row) = sqlx::query(
            "SELECT id FROM note_generation_blocks WHERE note_id = ? AND recording_session_id = ? LIMIT 1",
        )
        .bind(note_id)
        .bind(recording_session_id)
        .fetch_optional(&self.pool)
        .await?
        {
            let id: String = row.get("id");
            sqlx::query(
                "UPDATE note_generation_blocks
                 SET generation_result_id = ?, content = ?, title_suggestion = ?, updated_at = ?
                 WHERE id = ?",
            )
            .bind(generation_result_id)
            .bind(content)
            .bind(title_suggestion)
            .bind(&now)
            .bind(id)
            .execute(&self.pool)
            .await?;
            return Ok(());
        }

        let sort_order = self.next_generation_block_sort_order(note_id).await?;
        sqlx::query(
            "INSERT INTO note_generation_blocks
             (id, note_id, recording_session_id, generation_result_id, content, title_suggestion, sort_order, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(Uuid::new_v4().to_string())
        .bind(note_id)
        .bind(recording_session_id)
        .bind(generation_result_id)
        .bind(content)
        .bind(title_suggestion)
        .bind(sort_order)
        .bind(&now)
        .bind(&now)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    async fn next_generation_block_sort_order(&self, note_id: &str) -> Result<i64, sqlx::Error> {
        let row = sqlx::query(
            "SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_order
             FROM note_generation_blocks
             WHERE note_id = ?",
        )
        .bind(note_id)
        .fetch_one(&self.pool)
        .await?;
        Ok(row.get("next_order"))
    }

    async fn compose_generation_blocks(
        &self,
        note_id: &str,
    ) -> Result<Option<String>, sqlx::Error> {
        let rows = sqlx::query(
            "SELECT content
             FROM note_generation_blocks
             WHERE note_id = ?
             ORDER BY sort_order ASC, created_at ASC, rowid ASC",
        )
        .bind(note_id)
        .fetch_all(&self.pool)
        .await?;
        if rows.is_empty() {
            return Ok(None);
        }
        let content = rows
            .into_iter()
            .map(|row| row.get::<String, _>("content"))
            .filter(|content| !content.trim().is_empty())
            .collect::<Vec<_>>()
            .join("\n\n");
        Ok(Some(content))
    }

    pub async fn create_recording_session(
        &self,
        note_id: &str,
        session_id: &str,
        source_mode: RecordingSourceMode,
        partial_path: &str,
        final_path: &str,
        device_label: Option<String>,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            "INSERT INTO recording_sessions (id, note_id, source_mode, status, started_at, expected_elapsed_ms, device_label, permission_state, partial_path, final_path)
             VALUES (?, ?, ?, 'recording', ?, 0, ?, 'granted', ?, ?)",
        )
        .bind(session_id)
        .bind(note_id)
        .bind(source_mode.as_db())
        .bind(timestamp())
        .bind(device_label)
        .bind(partial_path)
        .bind(final_path)
        .execute(&self.pool)
        .await?;
        self.set_note_status(note_id, ProcessingStatus::Recording, None)
            .await?;
        self.add_checkpoint(session_id, "start", None).await
    }

    pub async fn recording_session_source_mode(
        &self,
        session_id: &str,
    ) -> Result<Option<RecordingSourceMode>, sqlx::Error> {
        let row = sqlx::query("SELECT source_mode FROM recording_sessions WHERE id = ?")
            .bind(session_id)
            .fetch_optional(&self.pool)
            .await?;
        Ok(row.map(|row| RecordingSourceMode::from(row.get::<String, _>("source_mode").as_str())))
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn update_recording_session(
        &self,
        session_id: &str,
        status: &str,
        elapsed_ms: i64,
        file_size_bytes: Option<i64>,
        duration_ms: Option<i64>,
        checksum: Option<String>,
        peak_amplitude: Option<f32>,
        rms_amplitude: Option<f32>,
        validation_summary: Option<String>,
        last_error: Option<String>,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            "UPDATE recording_sessions
             SET status = ?, expected_elapsed_ms = ?, file_size_bytes = ?, duration_ms = ?, checksum = ?,
                 peak_amplitude = ?, rms_amplitude = ?, validation_summary = ?, last_error = ?,
                 ended_at = CASE WHEN ? IN ('valid', 'invalid', 'failed') THEN ? ELSE ended_at END
             WHERE id = ?",
        )
        .bind(status)
        .bind(elapsed_ms)
        .bind(file_size_bytes)
        .bind(duration_ms)
        .bind(checksum)
        .bind(peak_amplitude)
        .bind(rms_amplitude)
        .bind(validation_summary)
        .bind(last_error)
        .bind(status)
        .bind(timestamp())
        .bind(session_id)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn add_checkpoint(
        &self,
        session_id: &str,
        kind: &str,
        details: Option<String>,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            "INSERT INTO recording_checkpoints (id, recording_session_id, kind, created_at, details) VALUES (?, ?, ?, ?, ?)",
        )
        .bind(Uuid::new_v4().to_string())
        .bind(session_id)
        .bind(kind)
        .bind(timestamp())
        .bind(details)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn add_source_checkpoint(
        &self,
        session_id: &str,
        source_artifact_id: Option<&str>,
        source: Option<&str>,
        kind: &str,
        details: Option<String>,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            "INSERT INTO recording_checkpoints (id, recording_session_id, source_artifact_id, source, kind, created_at, details)
             VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(Uuid::new_v4().to_string())
        .bind(session_id)
        .bind(source_artifact_id)
        .bind(source)
        .bind(kind)
        .bind(timestamp())
        .bind(details)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn create_pending_source_artifact(
        &self,
        note_id: &str,
        session_id: &str,
        source: &str,
        partial_path: &str,
        final_path: &str,
    ) -> Result<AudioArtifactDto, sqlx::Error> {
        let artifact = AudioArtifactDto {
            id: Uuid::new_v4().to_string(),
            source: source.to_string(),
            format: "wav".to_string(),
            duration_ms: 0,
            size_bytes: 0,
            checksum: String::new(),
            created_at: timestamp(),
        };
        sqlx::query(
            "INSERT INTO audio_artifacts
             (id, note_id, recording_session_id, source, partial_path, path, format, duration_ms, size_bytes, checksum, status, expected_duration_ms, created_at)
             VALUES (?, ?, ?, ?, ?, ?, 'wav', 0, 0, '', 'recording', 0, ?)",
        )
        .bind(&artifact.id)
        .bind(note_id)
        .bind(session_id)
        .bind(source)
        .bind(partial_path)
        .bind(final_path)
        .bind(&artifact.created_at)
        .execute(&self.pool)
        .await?;
        Ok(artifact)
    }

    pub async fn source_artifacts_for_session(
        &self,
        session_id: &str,
    ) -> Result<Vec<AudioArtifactDto>, sqlx::Error> {
        let rows = sqlx::query(
            "SELECT id, source, format, duration_ms, size_bytes, checksum, created_at
             FROM audio_artifacts
             WHERE recording_session_id = ?
             ORDER BY CASE source WHEN 'microphone' THEN 0 WHEN 'system' THEN 1 ELSE 2 END",
        )
        .bind(session_id)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows
            .into_iter()
            .map(|row| AudioArtifactDto {
                id: row.get("id"),
                source: row.get("source"),
                format: row.get("format"),
                duration_ms: row.get("duration_ms"),
                size_bytes: row.get("size_bytes"),
                checksum: row.get("checksum"),
                created_at: row.get("created_at"),
            })
            .collect())
    }

    pub async fn source_artifact_paths_for_session(
        &self,
        session_id: &str,
    ) -> Result<Vec<SourceArtifactPath>, sqlx::Error> {
        let rows = sqlx::query(
            "SELECT id, note_id, source, partial_path, path, expected_duration_ms
             FROM audio_artifacts
             WHERE recording_session_id = ?
             ORDER BY CASE source WHEN 'microphone' THEN 0 WHEN 'system' THEN 1 ELSE 2 END",
        )
        .bind(session_id)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows
            .into_iter()
            .map(|row| SourceArtifactPath {
                id: row.get("id"),
                note_id: row.get("note_id"),
                source: row.get("source"),
                partial_path: row.get("partial_path"),
                final_path: row.get("path"),
                expected_duration_ms: row.get("expected_duration_ms"),
            })
            .collect())
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn finalize_source_artifact(
        &self,
        artifact_id: &str,
        status: &str,
        duration_ms: i64,
        size_bytes: i64,
        checksum: &str,
        expected_duration_ms: i64,
        validation_summary: Option<String>,
        last_error: Option<String>,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            "UPDATE audio_artifacts
             SET status = ?, duration_ms = ?, size_bytes = ?, checksum = ?, expected_duration_ms = ?,
                 validation_summary = ?, last_error = ?
             WHERE id = ?",
        )
        .bind(status)
        .bind(duration_ms)
        .bind(size_bytes)
        .bind(checksum)
        .bind(expected_duration_ms)
        .bind(validation_summary)
        .bind(last_error)
        .bind(artifact_id)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn create_audio_artifact(
        &self,
        note_id: &str,
        session_id: &str,
        path: &str,
        duration_ms: i64,
        size_bytes: i64,
        checksum: &str,
    ) -> Result<AudioArtifactDto, sqlx::Error> {
        let artifact = AudioArtifactDto {
            id: Uuid::new_v4().to_string(),
            source: "microphone".to_string(),
            format: "wav".to_string(),
            duration_ms,
            size_bytes,
            checksum: checksum.to_string(),
            created_at: timestamp(),
        };
        sqlx::query(
            "INSERT INTO audio_artifacts (id, note_id, recording_session_id, source, path, format, duration_ms, size_bytes, checksum, status, expected_duration_ms, created_at)
             VALUES (?, ?, ?, 'microphone', ?, 'wav', ?, ?, ?, 'valid', ?, ?)",
        )
        .bind(&artifact.id)
        .bind(note_id)
        .bind(session_id)
        .bind(path)
        .bind(duration_ms)
        .bind(size_bytes)
        .bind(checksum)
        .bind(duration_ms)
        .bind(&artifact.created_at)
        .execute(&self.pool)
        .await?;
        Ok(artifact)
    }

    pub async fn latest_audio_artifact_path(
        &self,
        note_id: &str,
    ) -> Result<Option<(String, String)>, sqlx::Error> {
        let row = sqlx::query(
            "SELECT id, path FROM audio_artifacts WHERE note_id = ? AND status = 'valid' ORDER BY created_at DESC LIMIT 1",
        )
        .bind(note_id)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.map(|row| (row.get("id"), row.get("path"))))
    }

    async fn latest_audio_artifact(
        &self,
        note_id: &str,
    ) -> Result<Option<AudioArtifactDto>, sqlx::Error> {
        let row = sqlx::query(
            "SELECT id, source, format, duration_ms, size_bytes, checksum, created_at
             FROM audio_artifacts
             WHERE note_id = ? AND status = 'valid'
             ORDER BY created_at DESC
             LIMIT 1",
        )
        .bind(note_id)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.map(|row| AudioArtifactDto {
            id: row.get("id"),
            source: row.get("source"),
            format: row.get("format"),
            duration_ms: row.get("duration_ms"),
            size_bytes: row.get("size_bytes"),
            checksum: row.get("checksum"),
            created_at: row.get("created_at"),
        }))
    }

    pub async fn latest_valid_audio_artifact_paths(
        &self,
        note_id: &str,
    ) -> Result<Vec<(String, String, String, String)>, sqlx::Error> {
        let session = sqlx::query(
            "SELECT recording_session_id
             FROM audio_artifacts
             WHERE note_id = ? AND status = 'valid'
             ORDER BY created_at DESC
             LIMIT 1",
        )
        .bind(note_id)
        .fetch_optional(&self.pool)
        .await?;
        let Some(session) = session else {
            return Ok(Vec::new());
        };
        let session_id: String = session.get("recording_session_id");
        let rows = sqlx::query(
            "SELECT id, source, path, recording_session_id
             FROM audio_artifacts
             WHERE note_id = ? AND recording_session_id = ? AND status = 'valid'
             ORDER BY CASE source WHEN 'microphone' THEN 0 WHEN 'system' THEN 1 ELSE 2 END",
        )
        .bind(note_id)
        .bind(session_id)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows
            .into_iter()
            .map(|row| {
                (
                    row.get("id"),
                    row.get("source"),
                    row.get("path"),
                    row.get("recording_session_id"),
                )
            })
            .collect())
    }

    async fn latest_audio_sources(
        &self,
        note_id: &str,
    ) -> Result<Vec<AudioArtifactDto>, sqlx::Error> {
        let rows = sqlx::query(
            "SELECT id, source, format, duration_ms, size_bytes, checksum, created_at
             FROM audio_artifacts
             WHERE note_id = ? AND status = 'valid'
             ORDER BY created_at DESC",
        )
        .bind(note_id)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows
            .into_iter()
            .map(|row| AudioArtifactDto {
                id: row.get("id"),
                source: row.get("source"),
                format: row.get("format"),
                duration_ms: row.get("duration_ms"),
                size_bytes: row.get("size_bytes"),
                checksum: row.get("checksum"),
                created_at: row.get("created_at"),
            })
            .collect())
    }

    async fn latest_transcript(&self, note_id: &str) -> Result<Option<TranscriptDto>, sqlx::Error> {
        let row = sqlx::query(
            "SELECT id, text, source_mode, source, start_ms, end_ms, turn_index, language, status, last_error
             FROM transcripts
             WHERE note_id = ?
             ORDER BY created_at DESC
             LIMIT 1",
        )
        .bind(note_id)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.map(|row| TranscriptDto {
            id: row.get("id"),
            text: row.get("text"),
            source_mode: Some(RecordingSourceMode::from(
                row.get::<String, _>("source_mode").as_str(),
            )),
            source: row.get("source"),
            start_ms: row.get("start_ms"),
            end_ms: row.get("end_ms"),
            turn_index: row.get("turn_index"),
            language: row.get("language"),
            status: row.get("status"),
            last_error: row.get("last_error"),
        }))
    }

    async fn source_transcripts(&self, note_id: &str) -> Result<Vec<TranscriptDto>, sqlx::Error> {
        let rows = sqlx::query(
            "SELECT t.id, t.text, t.source_mode, t.source, t.start_ms, t.end_ms, t.turn_index, t.language, t.status, t.last_error
             FROM transcripts t
             LEFT JOIN recording_sessions rs ON rs.id = t.recording_session_id
             WHERE t.note_id = ?
               AND t.recording_session_id IS NOT NULL
               AND t.turn_index IS NOT NULL
             ORDER BY COALESCE(rs.started_at, t.created_at) ASC,
                      COALESCE(rs.rowid, 9223372036854775807) ASC,
                      COALESCE(t.turn_index, 999999),
                      COALESCE(t.start_ms, 999999999),
                      t.created_at ASC,
                      t.rowid ASC",
        )
        .bind(note_id)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows
            .into_iter()
            .map(|row| TranscriptDto {
                id: row.get("id"),
                text: row.get("text"),
                source_mode: Some(RecordingSourceMode::from(
                    row.get::<String, _>("source_mode").as_str(),
                )),
                source: row.get("source"),
                start_ms: row.get("start_ms"),
                end_ms: row.get("end_ms"),
                turn_index: row.get("turn_index"),
                language: row.get("language"),
                status: row.get("status"),
                last_error: row.get("last_error"),
            })
            .collect())
    }

    pub async fn successful_source_turn_transcripts_for_session(
        &self,
        session_id: &str,
    ) -> Result<Vec<TranscriptDto>, sqlx::Error> {
        let rows = sqlx::query(
            "SELECT id, text, source_mode, source, start_ms, end_ms, turn_index, language, status, last_error
             FROM transcripts
             WHERE recording_session_id = ?
               AND turn_index IS NOT NULL
               AND status = 'succeeded'
               AND TRIM(text) != ''
             ORDER BY COALESCE(turn_index, 999999), COALESCE(start_ms, 999999999), created_at ASC",
        )
        .bind(session_id)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows
            .into_iter()
            .map(|row| TranscriptDto {
                id: row.get("id"),
                text: row.get("text"),
                source_mode: Some(RecordingSourceMode::from(
                    row.get::<String, _>("source_mode").as_str(),
                )),
                source: row.get("source"),
                start_ms: row.get("start_ms"),
                end_ms: row.get("end_ms"),
                turn_index: row.get("turn_index"),
                language: row.get("language"),
                status: row.get("status"),
                last_error: row.get("last_error"),
            })
            .collect())
    }

    pub async fn create_transcript(
        &self,
        note_id: &str,
        audio_artifact_id: &str,
        text: &str,
        language: Option<String>,
        provider: &str,
    ) -> Result<TranscriptDto, sqlx::Error> {
        let transcript = TranscriptDto {
            id: Uuid::new_v4().to_string(),
            text: text.to_string(),
            source_mode: Some(RecordingSourceMode::MicrophoneOnly),
            source: Some("microphone".to_string()),
            start_ms: None,
            end_ms: None,
            turn_index: None,
            language,
            status: "succeeded".to_string(),
            last_error: None,
        };
        let now = timestamp();
        sqlx::query(
            "INSERT INTO transcripts (id, note_id, audio_artifact_id, source_artifact_id, source, source_mode, text, language, provider, status, retry_count, created_at, updated_at)
             VALUES (?, ?, ?, ?, 'microphone', 'microphone_only', ?, ?, ?, 'succeeded', 0, ?, ?)",
        )
        .bind(&transcript.id)
        .bind(note_id)
        .bind(audio_artifact_id)
        .bind(audio_artifact_id)
        .bind(text)
        .bind(&transcript.language)
        .bind(provider)
        .bind(&now)
        .bind(&now)
        .execute(&self.pool)
        .await?;
        Ok(transcript)
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn create_source_transcript(
        &self,
        note_id: &str,
        session_id: &str,
        audio_artifact_id: &str,
        source_mode: RecordingSourceMode,
        source: &str,
        text: &str,
        language: Option<String>,
        provider: &str,
        start_ms: Option<i64>,
        end_ms: Option<i64>,
        turn_index: Option<i64>,
    ) -> Result<TranscriptDto, sqlx::Error> {
        let transcript = TranscriptDto {
            id: Uuid::new_v4().to_string(),
            text: text.to_string(),
            source_mode: Some(source_mode),
            source: Some(source.to_string()),
            start_ms,
            end_ms,
            turn_index,
            language,
            status: "succeeded".to_string(),
            last_error: None,
        };
        let now = timestamp();
        sqlx::query(
            "INSERT INTO transcripts
             (id, note_id, recording_session_id, audio_artifact_id, source_artifact_id, source, source_mode, text, start_ms, end_ms, turn_index, language, provider, status, retry_count, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'succeeded', 0, ?, ?)",
        )
        .bind(&transcript.id)
        .bind(note_id)
        .bind(session_id)
        .bind(audio_artifact_id)
        .bind(audio_artifact_id)
        .bind(source)
        .bind(source_mode.as_db())
        .bind(text)
        .bind(start_ms)
        .bind(end_ms)
        .bind(turn_index)
        .bind(&transcript.language)
        .bind(provider)
        .bind(&now)
        .bind(&now)
        .execute(&self.pool)
        .await?;
        Ok(transcript)
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn upsert_successful_source_turn_transcript(
        &self,
        note_id: &str,
        session_id: &str,
        audio_artifact_id: &str,
        source_mode: RecordingSourceMode,
        source: &str,
        text: &str,
        language: Option<String>,
        provider: &str,
        start_ms: i64,
        end_ms: i64,
        turn_index: i64,
    ) -> Result<TranscriptDto, sqlx::Error> {
        let now = timestamp();
        let row = sqlx::query(
            "INSERT INTO transcripts
             (id, note_id, recording_session_id, audio_artifact_id, source_artifact_id, source, source_mode, text, start_ms, end_ms, turn_index, language, provider, status, retry_count, last_error, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'succeeded', 0, NULL, ?, ?)
             ON CONFLICT(recording_session_id, source, turn_index)
             WHERE recording_session_id IS NOT NULL AND source IS NOT NULL AND turn_index IS NOT NULL
             DO UPDATE SET
                 audio_artifact_id = excluded.audio_artifact_id,
                 source_artifact_id = excluded.source_artifact_id,
                 source_mode = excluded.source_mode,
                 text = excluded.text,
                 start_ms = excluded.start_ms,
                 end_ms = excluded.end_ms,
                 language = excluded.language,
                 provider = excluded.provider,
                 status = 'succeeded',
                 last_error = NULL,
                 updated_at = excluded.updated_at
             RETURNING id",
        )
        .bind(Uuid::new_v4().to_string())
        .bind(note_id)
        .bind(session_id)
        .bind(audio_artifact_id)
        .bind(audio_artifact_id)
        .bind(source)
        .bind(source_mode.as_db())
        .bind(text)
        .bind(start_ms)
        .bind(end_ms)
        .bind(turn_index)
        .bind(&language)
        .bind(provider)
        .bind(&now)
        .bind(&now)
        .fetch_one(&self.pool)
        .await?;

        Ok(TranscriptDto {
            id: row.get("id"),
            text: text.to_string(),
            source_mode: Some(source_mode),
            source: Some(source.to_string()),
            start_ms: Some(start_ms),
            end_ms: Some(end_ms),
            turn_index: Some(turn_index),
            language,
            status: "succeeded".to_string(),
            last_error: None,
        })
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn create_failed_source_transcript(
        &self,
        note_id: &str,
        session_id: &str,
        audio_artifact_id: &str,
        source_mode: RecordingSourceMode,
        source: &str,
        provider: &str,
        last_error: &str,
        start_ms: Option<i64>,
        end_ms: Option<i64>,
        turn_index: Option<i64>,
    ) -> Result<TranscriptDto, sqlx::Error> {
        let transcript = TranscriptDto {
            id: Uuid::new_v4().to_string(),
            text: String::new(),
            source_mode: Some(source_mode),
            source: Some(source.to_string()),
            start_ms,
            end_ms,
            turn_index,
            language: None,
            status: "failed".to_string(),
            last_error: Some(last_error.to_string()),
        };
        let now = timestamp();
        sqlx::query(
            "INSERT INTO transcripts
             (id, note_id, recording_session_id, audio_artifact_id, source_artifact_id, source, source_mode, text, start_ms, end_ms, turn_index, language, provider, status, retry_count, last_error, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, '', ?, ?, ?, NULL, ?, 'failed', 0, ?, ?, ?)",
        )
        .bind(&transcript.id)
        .bind(note_id)
        .bind(session_id)
        .bind(audio_artifact_id)
        .bind(audio_artifact_id)
        .bind(source)
        .bind(source_mode.as_db())
        .bind(start_ms)
        .bind(end_ms)
        .bind(turn_index)
        .bind(provider)
        .bind(last_error)
        .bind(&now)
        .bind(&now)
        .execute(&self.pool)
        .await?;
        Ok(transcript)
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn upsert_failed_source_turn_transcript(
        &self,
        note_id: &str,
        session_id: &str,
        audio_artifact_id: &str,
        source_mode: RecordingSourceMode,
        source: &str,
        provider: &str,
        last_error: &str,
        start_ms: i64,
        end_ms: i64,
        turn_index: i64,
    ) -> Result<TranscriptDto, sqlx::Error> {
        let now = timestamp();
        let row = sqlx::query(
            "INSERT INTO transcripts
             (id, note_id, recording_session_id, audio_artifact_id, source_artifact_id, source, source_mode, text, start_ms, end_ms, turn_index, language, provider, status, retry_count, last_error, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, '', ?, ?, ?, NULL, ?, 'failed', 0, ?, ?, ?)
             ON CONFLICT(recording_session_id, source, turn_index)
             WHERE recording_session_id IS NOT NULL AND source IS NOT NULL AND turn_index IS NOT NULL
             DO UPDATE SET
                 audio_artifact_id = excluded.audio_artifact_id,
                 source_artifact_id = excluded.source_artifact_id,
                 source_mode = excluded.source_mode,
                 text = '',
                 start_ms = excluded.start_ms,
                 end_ms = excluded.end_ms,
                 language = NULL,
                 provider = excluded.provider,
                 status = 'failed',
                 last_error = excluded.last_error,
                 updated_at = excluded.updated_at
             RETURNING id",
        )
        .bind(Uuid::new_v4().to_string())
        .bind(note_id)
        .bind(session_id)
        .bind(audio_artifact_id)
        .bind(audio_artifact_id)
        .bind(source)
        .bind(source_mode.as_db())
        .bind(start_ms)
        .bind(end_ms)
        .bind(turn_index)
        .bind(provider)
        .bind(last_error)
        .bind(&now)
        .bind(&now)
        .fetch_one(&self.pool)
        .await?;

        Ok(TranscriptDto {
            id: row.get("id"),
            text: String::new(),
            source_mode: Some(source_mode),
            source: Some(source.to_string()),
            start_ms: Some(start_ms),
            end_ms: Some(end_ms),
            turn_index: Some(turn_index),
            language: None,
            status: "failed".to_string(),
            last_error: Some(last_error.to_string()),
        })
    }

    pub async fn create_generation_result(
        &self,
        note_id: &str,
        transcript_id: &str,
        content: &str,
        title_suggestion: Option<String>,
        provider: &str,
        prompt_version: &str,
    ) -> Result<String, sqlx::Error> {
        let now = timestamp();
        let id = Uuid::new_v4().to_string();
        sqlx::query(
            "INSERT INTO generation_results (id, note_id, transcript_id, content, title_suggestion, provider, prompt_version, status, retry_count, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'succeeded', 0, ?, ?)",
        )
        .bind(&id)
        .bind(note_id)
        .bind(transcript_id)
        .bind(content)
        .bind(title_suggestion)
        .bind(provider)
        .bind(prompt_version)
        .bind(&now)
        .bind(&now)
        .execute(&self.pool)
        .await?;
        Ok(id)
    }

    pub async fn recording_recovery_info(
        &self,
        session_id: &str,
    ) -> Result<Option<RecordingRecoveryInfo>, sqlx::Error> {
        let row = sqlx::query(
            "SELECT id, note_id, source_mode, partial_path, final_path, expected_elapsed_ms
             FROM recording_sessions
             WHERE id = ?",
        )
        .bind(session_id)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.map(|row| RecordingRecoveryInfo {
            session_id: row.get("id"),
            note_id: row.get("note_id"),
            source_mode: RecordingSourceMode::from(row.get::<String, _>("source_mode").as_str()),
            partial_path: row.get("partial_path"),
            final_path: row.get("final_path"),
            expected_elapsed_ms: row.get("expected_elapsed_ms"),
        }))
    }

    pub async fn mark_recording_discarded(
        &self,
        session_id: &str,
        note_id: &str,
    ) -> Result<NoteDto, sqlx::Error> {
        sqlx::query("UPDATE recording_sessions SET status = 'failed', last_error = 'Discarded by user' WHERE id = ?")
            .bind(session_id)
            .execute(&self.pool)
            .await?;
        self.set_note_status(
            note_id,
            ProcessingStatus::Failed,
            Some("Recording discarded".to_string()),
        )
        .await?;
        self.get_note(note_id).await
    }

    async fn folder_ids(&self, note_id: &str) -> Result<Vec<String>, sqlx::Error> {
        let rows = sqlx::query(
            "SELECT nf.folder_id
             FROM note_folders nf
             INNER JOIN folders f ON f.id = nf.folder_id
             WHERE nf.note_id = ? AND f.deleted_at IS NULL
             ORDER BY nf.assigned_at ASC",
        )
        .bind(note_id)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows.into_iter().map(|row| row.get("folder_id")).collect())
    }
}

async fn delete_note_records(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    note_id: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query("DELETE FROM note_generation_blocks WHERE note_id = ?")
        .bind(note_id)
        .execute(&mut **tx)
        .await?;
    sqlx::query("DELETE FROM generation_results WHERE note_id = ?")
        .bind(note_id)
        .execute(&mut **tx)
        .await?;
    sqlx::query("DELETE FROM transcripts WHERE note_id = ?")
        .bind(note_id)
        .execute(&mut **tx)
        .await?;
    sqlx::query("DELETE FROM audio_artifacts WHERE note_id = ?")
        .bind(note_id)
        .execute(&mut **tx)
        .await?;
    sqlx::query(
        "DELETE FROM recording_checkpoints
         WHERE recording_session_id IN (SELECT id FROM recording_sessions WHERE note_id = ?)",
    )
    .bind(note_id)
    .execute(&mut **tx)
    .await?;
    sqlx::query("DELETE FROM recording_sessions WHERE note_id = ?")
        .bind(note_id)
        .execute(&mut **tx)
        .await?;
    sqlx::query("DELETE FROM note_folders WHERE note_id = ?")
        .bind(note_id)
        .execute(&mut **tx)
        .await?;
    sqlx::query("DELETE FROM notes WHERE id = ?")
        .bind(note_id)
        .execute(&mut **tx)
        .await?;
    Ok(())
}

fn append_note_content(existing: Option<String>, addition: String) -> String {
    let existing = existing.unwrap_or_default();
    let existing = existing.trim_end();
    let addition = addition.trim_start();
    if existing.is_empty() {
        addition.to_string()
    } else if addition.is_empty() {
        existing.to_string()
    } else {
        format!("{existing}\n\n{addition}")
    }
}

fn normalize_generated_addition(
    title: &str,
    existing: Option<&str>,
    manual_tail: Option<&str>,
    content: &str,
) -> String {
    let content = content.trim();
    let Some(existing) = existing.map(str::trim).filter(|value| !value.is_empty()) else {
        return strip_generated_addition_prefixes(title, manual_tail, content).to_string();
    };
    if content == existing {
        String::new()
    } else if let Some(rest) = content.strip_prefix(existing) {
        strip_generated_addition_prefixes(title, manual_tail, rest.trim_start()).to_string()
    } else {
        strip_generated_addition_prefixes(title, manual_tail, content).to_string()
    }
}

fn usable_generated_title(title: Option<&str>) -> Option<String> {
    title
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .filter(|value| !is_replaceable_generated_title(value))
        .map(ToString::to_string)
}

fn is_replaceable_generated_title(title: &str) -> bool {
    let normalized = title.trim().to_lowercase();
    normalized.is_empty() || normalized == "new note" || normalized == "untitled note"
}

fn generated_title_from_content(content: &str) -> Option<String> {
    content
        .lines()
        .map(clean_generated_title_line)
        .find(|line| !line.is_empty() && !is_replaceable_generated_title(line))
        .map(|line| truncate_title(&line, 72))
}

fn clean_generated_title_line(line: &str) -> String {
    line.trim()
        .trim_start_matches('#')
        .trim_start_matches(|character: char| {
            character.is_whitespace() || matches!(character, '-' | '*' | ':' | '"' | '\'' | '`')
        })
        .trim()
        .trim_end_matches([':', '"', '\'', '`'])
        .trim()
        .to_string()
}

fn truncate_title(title: &str, max_chars: usize) -> String {
    if title.chars().count() <= max_chars {
        return title.to_string();
    }

    let mut truncated = String::new();
    for word in title.split_whitespace() {
        let separator_len = usize::from(!truncated.is_empty());
        if truncated.chars().count() + separator_len + word.chars().count() > max_chars {
            break;
        }
        if !truncated.is_empty() {
            truncated.push(' ');
        }
        truncated.push_str(word);
    }

    if truncated.is_empty() {
        title.chars().take(max_chars).collect()
    } else {
        truncated
    }
}

fn strip_generated_addition_prefixes<'a>(
    title: &str,
    manual_tail: Option<&str>,
    content: &'a str,
) -> &'a str {
    let mut content = content;
    loop {
        let next = strip_duplicate_generated_heading(
            title,
            manual_tail,
            strip_manual_tail_line_echo(manual_tail, strip_manual_tail_echo(manual_tail, content)),
        );
        if next == content {
            return content;
        }
        content = next;
    }
}

fn strip_manual_tail_echo<'a>(manual_tail: Option<&str>, content: &'a str) -> &'a str {
    let Some(manual_tail) = manual_tail.map(str::trim).filter(|value| !value.is_empty()) else {
        return content;
    };
    let Some(rest) = content.strip_prefix(manual_tail) else {
        return content;
    };
    rest.strip_prefix(':').unwrap_or(rest).trim_start()
}

fn strip_manual_tail_line_echo<'a>(manual_tail: Option<&str>, content: &'a str) -> &'a str {
    let Some(manual_tail) = manual_tail.map(str::trim).filter(|value| !value.is_empty()) else {
        return content;
    };
    let Some((line, rest)) = content.split_once('\n') else {
        return content;
    };
    if manual_echo_matches(line, manual_tail) {
        rest.trim_start()
    } else {
        content
    }
}

fn manual_echo_matches(line: &str, manual_tail: &str) -> bool {
    let manual_tail = manual_echo_text(manual_tail);
    let line = manual_echo_text(line);
    !manual_tail.is_empty() && line.eq_ignore_ascii_case(&manual_tail)
}

fn manual_echo_text(value: &str) -> String {
    let mut text = value.trim();
    if let Some(heading) = markdown_heading_text(text) {
        text = heading;
    }
    for prefix in ["- ", "* ", "+ "] {
        if let Some(rest) = text.strip_prefix(prefix) {
            text = rest.trim();
            break;
        }
    }
    text.trim_end_matches(':').trim().to_string()
}

fn strip_duplicate_generated_heading<'a>(
    title: &str,
    manual_tail: Option<&str>,
    content: &'a str,
) -> &'a str {
    let Some((heading, rest)) = content.split_once('\n') else {
        return content;
    };
    let Some(heading_text) = markdown_heading_text(heading) else {
        return content;
    };
    if is_duplicate_generated_heading(title, manual_tail, heading_text) {
        rest.trim_start()
    } else {
        content
    }
}

fn markdown_heading_text(line: &str) -> Option<&str> {
    let trimmed = line.trim_start();
    let hash_count = trimmed
        .chars()
        .take_while(|character| *character == '#')
        .count();
    if hash_count == 0 || hash_count > 6 {
        return None;
    }

    trimmed[hash_count..].strip_prefix(' ').map(str::trim)
}

fn is_duplicate_generated_heading(title: &str, manual_tail: Option<&str>, heading: &str) -> bool {
    let heading = heading.trim();
    let title = title.trim();
    heading.eq_ignore_ascii_case("New note")
        || heading.eq_ignore_ascii_case("Note")
        || heading.eq_ignore_ascii_case("Generated note")
        || (!title.is_empty() && heading.eq_ignore_ascii_case(title))
        || manual_tail
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .is_some_and(|manual_tail| heading.eq_ignore_ascii_case(manual_tail))
}

fn manual_tail_for_append(generated: Option<&str>, edited: Option<&str>) -> Option<String> {
    let edited = edited?.trim();
    if edited.is_empty() {
        return None;
    }
    let Some(generated) = generated.map(str::trim).filter(|value| !value.is_empty()) else {
        return Some(edited.to_string());
    };
    if edited == generated {
        return None;
    }
    if let Some(rest) = edited.strip_prefix(generated) {
        let rest = rest.trim();
        return if rest.is_empty() {
            None
        } else {
            Some(rest.to_string())
        };
    }
    edited.find(generated).and_then(|index| {
        let rest = edited[index + generated.len()..].trim();
        if rest.is_empty() {
            None
        } else {
            Some(rest.to_string())
        }
    })
}

#[derive(Debug, Clone)]
pub struct RecordingRecoveryInfo {
    pub session_id: String,
    pub note_id: String,
    pub source_mode: RecordingSourceMode,
    pub partial_path: Option<String>,
    pub final_path: Option<String>,
    pub expected_elapsed_ms: i64,
}

#[derive(Debug, Clone)]
pub struct SourceArtifactPath {
    pub id: String,
    pub note_id: String,
    pub source: String,
    pub partial_path: Option<String>,
    pub final_path: Option<String>,
    pub expected_duration_ms: i64,
}

pub fn timestamp() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn folder_from_row(row: sqlx::sqlite::SqliteRow) -> FolderDto {
    FolderDto {
        id: row.get("id"),
        name: row.get("name"),
        description: row
            .try_get::<Option<String>, _>("description")
            .unwrap_or(None)
            .and_then(|value| {
                let trimmed = value.trim().to_string();
                if trimmed.is_empty() {
                    None
                } else {
                    Some(trimmed)
                }
            }),
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
    }
}

fn dictionary_entry_from_row(row: sqlx::sqlite::SqliteRow) -> DictionaryEntryDto {
    DictionaryEntryDto {
        id: row.get("id"),
        phrase: row.get("phrase"),
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
    }
}

fn dictation_history_item_from_row(row: sqlx::sqlite::SqliteRow) -> DictationHistoryItemDto {
    DictationHistoryItemDto {
        id: row.get("id"),
        text: row.get("text"),
        language: row.get("language"),
        provider: row.get("provider"),
        created_at: row.get("created_at"),
    }
}

fn agent_task_from_row(row: sqlx::sqlite::SqliteRow) -> AgentTaskDto {
    AgentTaskDto {
        id: row.get("id"),
        title: row.get("title"),
        prompt: row.get("prompt"),
        status: AgentTaskStatus::from(row.get::<String, _>("status").as_str()),
        safety_profile: AgentSafetyProfile::from(row.get::<String, _>("safety_profile").as_str()),
        hermes_session_id: row.get("hermes_session_id"),
        progress_summary: row.get("progress_summary"),
        last_error: row.get("last_error"),
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
        completed_at: row.get("completed_at"),
        messages: Vec::new(),
        tool_events: Vec::new(),
    }
}

fn agent_message_from_row(row: sqlx::sqlite::SqliteRow) -> AgentMessageDto {
    AgentMessageDto {
        id: row.get("id"),
        task_id: row.get("task_id"),
        role: AgentMessageRole::from(row.get::<String, _>("role").as_str()),
        content: row.get("content"),
        created_at: row.get("created_at"),
    }
}

fn agent_tool_event_from_row(row: sqlx::sqlite::SqliteRow) -> AgentToolEventDto {
    AgentToolEventDto {
        id: row.get("id"),
        task_id: row.get("task_id"),
        tool_name: row.get("tool_name"),
        status: AgentToolEventStatus::from(row.get::<String, _>("status").as_str()),
        summary: row.get("summary"),
        arguments_json: row.get("arguments_json"),
        result_json: row.get("result_json"),
        redacted: row.get::<i64, _>("redacted") != 0,
        created_at: row.get("created_at"),
        completed_at: row.get("completed_at"),
    }
}

fn dictation_history_cutoff_timestamp() -> String {
    (Utc::now() - Duration::days(DICTATION_HISTORY_RETENTION_DAYS))
        .to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn title_from_prompt(prompt: &str) -> String {
    let compact = prompt.split_whitespace().collect::<Vec<_>>().join(" ");
    let title: String = compact.chars().take(64).collect();
    if title.trim().is_empty() {
        "New task".to_string()
    } else {
        title
    }
}

fn preview_for(title: &str, content: &str) -> String {
    let source = if content.trim().is_empty() {
        title
    } else {
        content
    };
    source.chars().take(140).collect()
}
