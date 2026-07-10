use crate::domain::types::{
    AgentMessageDto, AgentMessageRole, AgentSafetyProfile, AgentTaskDto, AgentTaskListResponse,
    AgentTaskStatus, AgentToolEventDto, AgentToolEventStatus, AppError, AudioArtifactDto,
    AudioValidationDto, DictationHistoryItemDto, DictionaryEntryDto, FolderDto,
    ListDictationHistoryResponse, ListNotesResponse, NoteDto, NoteListItemDto, ParticipantDto,
    PersonaAttributionDto, PersonaCommitmentDirection, PersonaCommitmentDto,
    PersonaDeletionReceipt, PersonaDetailDto, PersonaDossierJobDto, PersonaDto,
    PersonaMutationReceipt, PersonaNoteHistoryDto, PersonaSummaryDto, ProcessingStatus,
    RecordingSourceMode, RecordingState, SessionFolderDto, TranscriptCoverageDto, TranscriptDto,
};
use chrono::{Duration, SecondsFormat, Utc};
use sqlx::query::query;
use sqlx::row::Row;
use sqlx_sqlite::SqlitePool;
use sqlx_sqlite::SqliteRow;
use uuid::Uuid;

const DICTATION_HISTORY_RETENTION_DAYS: i64 = 7;

#[derive(Debug, Clone)]
pub struct PersonaVoiceprintRecord {
    pub persona_id: String,
    pub source: String,
    pub model_id: String,
    pub embedding: Vec<u8>,
    pub kind: String,
    pub recording_session_id: String,
    pub recognition_confirmed: bool,
}

#[derive(Debug, Clone)]
pub struct PersonaClusterRecord {
    pub id: String,
    pub recording_session_id: String,
    pub note_id: String,
    pub source: String,
    pub speaker_index: i64,
    pub anonymous_label: String,
    pub model_id: String,
    pub embedding: Vec<u8>,
    pub spans_json: String,
    pub state: String,
    pub persona_id: Option<String>,
    pub confidence: Option<f32>,
}

#[derive(Debug, Clone)]
pub struct PersonaClusterPreviewSource {
    pub cluster_id: String,
    pub note_id: String,
    pub recording_session_id: String,
    pub source: String,
    pub spans_json: String,
    pub audio_path: String,
}

#[derive(Debug, Clone)]
pub(crate) struct PersonaDossierJob {
    pub id: String,
    pub idempotency_key: String,
    pub attempt_count: i64,
}

#[derive(Debug, Clone)]
pub(crate) struct PersonaDossierJobContext {
    pub persona_name: String,
    pub relationship: Option<String>,
    pub dossier: String,
    pub dossier_revision: i64,
    pub commitments: Vec<PersonaCommitmentDto>,
    pub trusted_transcript: String,
    #[allow(dead_code)]
    pub source_note_id: String,
}

#[derive(Debug, Clone)]
pub(crate) struct PersonaCommitmentProposal {
    pub item_key: String,
    pub direction: PersonaCommitmentDirection,
    pub text: String,
    pub due: Option<String>,
}

#[derive(Debug, Clone)]
pub(crate) struct PersonaCommitmentUpdateProposal {
    pub id: String,
    pub status: String,
    pub text: String,
    pub due: Option<String>,
}

#[derive(Debug, Clone)]
pub(crate) struct PersonaDossierUpdate {
    pub dossier: String,
    pub new_commitments: Vec<PersonaCommitmentProposal>,
    pub commitment_updates: Vec<PersonaCommitmentUpdateProposal>,
}

#[derive(Clone)]
pub struct Repositories {
    pub pool: SqlitePool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct P3aCounterState {
    pub raw_value: u64,
    pub reported_value: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct P3aPendingReport {
    pub question_id: String,
    pub epoch: String,
    pub raw_value: u64,
    pub reported_value: u64,
}

impl Repositories {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    pub async fn increment_p3a_counter(
        &self,
        question_id: &str,
        epoch: &str,
        amount: u64,
    ) -> Result<P3aCounterState, sqlx::error::Error> {
        let now = timestamp();
        query(
            "INSERT INTO p3a_counters (question_id, epoch, raw_value, updated_at)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(question_id, epoch) DO UPDATE SET
               raw_value = raw_value + excluded.raw_value,
               updated_at = excluded.updated_at",
        )
        .bind(question_id)
        .bind(epoch)
        .bind(i64::try_from(amount).unwrap_or(i64::MAX))
        .bind(&now)
        .execute(&self.pool)
        .await?;
        self.p3a_counter_state(question_id, epoch)
            .await?
            .ok_or(sqlx::Error::RowNotFound)
    }

    pub async fn mark_p3a_events_reported(
        &self,
        question_id: &str,
        epoch: &str,
        reported_value: u64,
    ) -> Result<(), sqlx::error::Error> {
        let now = timestamp();
        query(
            "UPDATE p3a_counters
             SET reported_value = CASE
                   WHEN reported_value < ? THEN ?
                   ELSE reported_value
                 END,
                 reported_at = ?,
                 updated_at = ?
             WHERE question_id = ? AND epoch = ?",
        )
        .bind(i64::try_from(reported_value).unwrap_or(i64::MAX))
        .bind(i64::try_from(reported_value).unwrap_or(i64::MAX))
        .bind(&now)
        .bind(&now)
        .bind(question_id)
        .bind(epoch)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn clear_p3a_counters(&self) -> Result<(), sqlx::error::Error> {
        query("DELETE FROM p3a_counters")
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub async fn p3a_counter_value(
        &self,
        question_id: &str,
        epoch: &str,
    ) -> Result<Option<i64>, sqlx::error::Error> {
        let row = query("SELECT raw_value FROM p3a_counters WHERE question_id = ? AND epoch = ?")
            .bind(question_id)
            .bind(epoch)
            .fetch_optional(&self.pool)
            .await?;
        Ok(row.map(|row| row.get("raw_value")))
    }

    pub async fn p3a_counter_state(
        &self,
        question_id: &str,
        epoch: &str,
    ) -> Result<Option<P3aCounterState>, sqlx::error::Error> {
        let row = query(
            "SELECT raw_value, reported_value FROM p3a_counters WHERE question_id = ? AND epoch = ?",
        )
        .bind(question_id)
        .bind(epoch)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.map(|row| {
            let raw_value = row.get::<i64, _>("raw_value").max(0) as u64;
            let reported_value = row.get::<i64, _>("reported_value").max(0) as u64;
            P3aCounterState {
                raw_value,
                reported_value,
            }
        }))
    }

    pub async fn unreported_p3a_counters(
        &self,
    ) -> Result<Vec<P3aPendingReport>, sqlx::error::Error> {
        let rows = query(
            "SELECT question_id, epoch, raw_value, reported_value
             FROM p3a_counters
             WHERE raw_value > reported_value
             ORDER BY epoch ASC, question_id ASC",
        )
        .fetch_all(&self.pool)
        .await?;
        Ok(rows
            .into_iter()
            .map(|row| {
                let raw_value = row.get::<i64, _>("raw_value").max(0) as u64;
                let reported_value = row.get::<i64, _>("reported_value").max(0) as u64;
                P3aPendingReport {
                    question_id: row.get("question_id"),
                    epoch: row.get("epoch"),
                    raw_value,
                    reported_value,
                }
            })
            .collect())
    }

    pub async fn list_folders(&self) -> Result<Vec<FolderDto>, sqlx::error::Error> {
        let rows = query(
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
    ) -> Result<FolderDto, sqlx::error::Error> {
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

        query(
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
        let result = query(
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

        let row = query(
            "SELECT id, name, description, created_at, updated_at FROM folders WHERE id = ? AND deleted_at IS NULL",
        )
        .bind(folder_id)
        .fetch_one(&self.pool)
        .await?;

        Ok(folder_from_row(row))
    }

    pub async fn create_note(
        &self,
        folder_id: Option<String>,
    ) -> Result<NoteDto, sqlx::error::Error> {
        let now = timestamp();
        let id = Uuid::new_v4().to_string();

        let mut tx = self.pool.begin().await?;
        query(
            "INSERT INTO notes (id, title, processing_status, created_at, updated_at) VALUES (?, '', 'draft', ?, ?)",
        )
        .bind(&id)
        .bind(&now)
        .bind(&now)
        .execute(&mut *tx)
        .await?;

        if let Some(folder_id) = folder_id {
            query("INSERT OR IGNORE INTO note_folders (note_id, folder_id, assigned_at) VALUES (?, ?, ?)")
                .bind(&id)
                .bind(folder_id)
                .bind(&now)
                .execute(&mut *tx)
                .await?;
        }

        tx.commit().await?;
        self.get_note(&id).await
    }

    pub async fn get_note(&self, note_id: &str) -> Result<NoteDto, sqlx::error::Error> {
        let row = query(
            "SELECT id, title, generated_content, edited_content, active_tab, processing_status,
                    created_at, updated_at, last_error, persona_recognition_warning
             FROM notes WHERE id = ?",
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
            transcript_coverage: self.transcript_coverage(note_id).await?,
            source_transcripts: self.source_transcripts(note_id).await?,
            participants: self.note_participants(note_id).await?,
            recording: None,
            audio: self.latest_audio_artifact(note_id).await?,
            audio_sources: self.latest_audio_sources(note_id).await?,
            active_tab: row.get("active_tab"),
            last_error: row.get("last_error"),
            persona_recognition_warning: row.get("persona_recognition_warning"),
            queued_recordings: 0,
        })
    }

    pub async fn list_notes(
        &self,
        folder_id: Option<String>,
        limit: i64,
        _cursor: Option<String>,
    ) -> Result<ListNotesResponse, sqlx::error::Error> {
        let rows = if let Some(folder_id) = folder_id {
            query(
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
            query(
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
    ) -> Result<NoteDto, sqlx::error::Error> {
        query(
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
    ) -> Result<NoteDto, sqlx::error::Error> {
        query("DELETE FROM note_folders WHERE note_id = ? AND folder_id = ?")
            .bind(note_id)
            .bind(folder_id)
            .execute(&self.pool)
            .await?;
        self.get_note(note_id).await
    }

    pub async fn list_session_folders(&self) -> Result<Vec<SessionFolderDto>, sqlx::error::Error> {
        let rows = query(
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
    ) -> Result<(), sqlx::error::Error> {
        query(
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
    ) -> Result<(), sqlx::error::Error> {
        query("DELETE FROM session_folders WHERE session_id = ? AND folder_id = ?")
            .bind(session_id)
            .bind(folder_id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub async fn list_dictionary_entries(
        &self,
    ) -> Result<Vec<DictionaryEntryDto>, sqlx::error::Error> {
        let rows = query(
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
    ) -> Result<Option<DictationHistoryItemDto>, sqlx::error::Error> {
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
        query(
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
    ) -> Result<ListDictationHistoryResponse, sqlx::error::Error> {
        self.prune_old_dictation_history().await?;
        let rows = query(
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

    pub async fn prune_old_dictation_history(&self) -> Result<(), sqlx::error::Error> {
        query("DELETE FROM dictation_history WHERE created_at < ?")
            .bind(dictation_history_cutoff_timestamp())
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub async fn pause_running_agent_tasks_on_launch(&self) -> Result<(), sqlx::error::Error> {
        let now = timestamp();
        query(
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
    pub async fn complete_agent_tasks_with_assistant_messages(
        &self,
    ) -> Result<(), sqlx::error::Error> {
        query(
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

    pub async fn list_agent_tasks(&self) -> Result<AgentTaskListResponse, sqlx::error::Error> {
        let rows = query(
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
    ) -> Result<AgentTaskDto, sqlx::error::Error> {
        let now = timestamp();
        let task_id = Uuid::new_v4().to_string();
        let trimmed_prompt = prompt.trim();
        let title = title
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| title_from_prompt(trimmed_prompt));

        let mut tx = self.pool.begin().await?;
        query(
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
        query(
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

    pub async fn get_agent_task(&self, task_id: &str) -> Result<AgentTaskDto, sqlx::error::Error> {
        let row = query(
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
    ) -> Result<(), sqlx::error::Error> {
        query("UPDATE agent_tasks SET hermes_session_id = ? WHERE id = ?")
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
    ) -> Result<AgentMessageDto, sqlx::error::Error> {
        let now = timestamp();
        let id = Uuid::new_v4().to_string();
        query(
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
        query("UPDATE agent_tasks SET updated_at = ? WHERE id = ?")
            .bind(&now)
            .bind(task_id)
            .execute(&self.pool)
            .await?;
        let row = query(
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
    ) -> Result<bool, sqlx::error::Error> {
        let existing = query(
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
        let result = query(
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
    ) -> Result<AgentTaskDto, sqlx::error::Error> {
        let now = timestamp();
        let completed_at = match status {
            AgentTaskStatus::Completed | AgentTaskStatus::Cancelled => Some(now.clone()),
            _ => None,
        };
        query(
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
    ) -> Result<bool, sqlx::error::Error> {
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
        let mut query = query(&sql)
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
    ) -> Result<bool, sqlx::error::Error> {
        let row =
            query("SELECT 1 FROM agent_tasks WHERE hermes_session_id = ? AND id != ? LIMIT 1")
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
    ) -> Result<AgentToolEventDto, sqlx::error::Error> {
        let now = timestamp();
        let completed_at = match status {
            AgentToolEventStatus::Completed
            | AgentToolEventStatus::Failed
            | AgentToolEventStatus::Blocked => Some(now.clone()),
            _ => None,
        };
        let id = Uuid::new_v4().to_string();
        query(
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
        query("UPDATE agent_tasks SET updated_at = ? WHERE id = ?")
            .bind(&now)
            .bind(task_id)
            .execute(&self.pool)
            .await?;
        let row = query(
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
    ) -> Result<Vec<AgentToolEventDto>, sqlx::error::Error> {
        let rows = query(
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

    async fn agent_messages(
        &self,
        task_id: &str,
    ) -> Result<Vec<AgentMessageDto>, sqlx::error::Error> {
        let rows = query(
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

    pub async fn delete_dictation_history_item(&self, id: &str) -> Result<(), sqlx::error::Error> {
        query("DELETE FROM dictation_history WHERE id = ?")
            .bind(id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub async fn create_dictionary_entry(
        &self,
        phrase: &str,
    ) -> Result<DictionaryEntryDto, sqlx::error::Error> {
        let now = timestamp();
        let entry = DictionaryEntryDto {
            id: Uuid::new_v4().to_string(),
            phrase: phrase.trim().to_string(),
            created_at: now.clone(),
            updated_at: now,
        };
        query(
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
        let result = query(
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
        let row = query(
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
        let result = query(
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
    ) -> Result<NoteDto, sqlx::error::Error> {
        let current = self.get_note(note_id).await?;
        let next_title = title.unwrap_or(current.title);
        let next_content = edited_content.or(current.edited_content);
        let next_tab = active_tab
            .or(current.active_tab)
            .unwrap_or_else(|| "notes".to_string());

        query(
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

    pub async fn list_personas(
        &self,
        filter: &str,
        search: Option<&str>,
    ) -> Result<Vec<PersonaSummaryDto>, AppError> {
        let archive_clause = match filter {
            "active" | "" => "p.archived_at IS NULL",
            "archived" => "p.archived_at IS NOT NULL",
            "all" => "1 = 1",
            _ => {
                return Err(AppError::new(
                    "persona_filter_invalid",
                    "Persona filter must be active, archived, or all.",
                ))
            }
        };
        let search = search.map(str::trim).filter(|value| !value.is_empty());
        let sql = format!(
            "SELECT p.id, p.name, p.relationship, p.is_self, p.archived_at,
                    p.created_at, p.updated_at,
                    (SELECT COUNT(*) FROM persona_voiceprints pv
                     WHERE pv.persona_id = p.id AND pv.kind = 'positive') AS voiceprint_count,
                    (SELECT MAX(np.updated_at) FROM note_participants np
                     WHERE np.persona_id = p.id) AS last_seen_at
             FROM personas p
             WHERE {archive_clause}
               AND (? IS NULL OR p.name LIKE '%' || ? || '%' COLLATE NOCASE
                    OR COALESCE(p.relationship, '') LIKE '%' || ? || '%' COLLATE NOCASE)
             ORDER BY p.name COLLATE NOCASE ASC, p.created_at ASC"
        );
        let rows = query(&sql)
            .bind(search)
            .bind(search)
            .bind(search)
            .fetch_all(&self.pool)
            .await?;
        Ok(rows.iter().map(persona_summary_from_row).collect())
    }

    pub async fn get_persona(&self, persona_id: &str) -> Result<PersonaDetailDto, AppError> {
        let row = query(
            "SELECT p.id, p.name, p.relationship, p.dossier, p.dossier_revision,
                    p.is_self, p.archived_at, p.created_at, p.updated_at,
                    (SELECT COUNT(*) FROM persona_voiceprints pv
                     WHERE pv.persona_id = p.id AND pv.kind = 'positive') AS voiceprint_count,
                    (SELECT MAX(np.updated_at) FROM note_participants np
                     WHERE np.persona_id = p.id) AS last_seen_at
             FROM personas p WHERE p.id = ?",
        )
        .bind(persona_id)
        .fetch_optional(&self.pool)
        .await?
        .ok_or_else(|| AppError::new("persona_not_found", "This Persona no longer exists."))?;
        let summary = persona_summary_from_row(&row);
        Ok(PersonaDetailDto {
            id: summary.id,
            name: summary.name,
            relationship: summary.relationship,
            is_self: summary.is_self,
            archived_at: summary.archived_at,
            voiceprint_count: summary.voiceprint_count,
            last_seen_at: summary.last_seen_at,
            created_at: summary.created_at,
            updated_at: summary.updated_at,
            dossier: row.get("dossier"),
            dossier_revision: row.get("dossier_revision"),
            commitments: self.persona_commitments(persona_id).await?,
            meetings: self.persona_meetings(persona_id).await?,
            dossier_jobs: self.persona_dossier_jobs(persona_id).await?,
        })
    }

    pub async fn persona_affected_note_ids(
        &self,
        persona_id: &str,
    ) -> Result<Vec<String>, sqlx::error::Error> {
        let rows = query(
            "SELECT DISTINCT note_id FROM (
               SELECT note_id FROM note_participants WHERE persona_id = ?
               UNION
               SELECT t.note_id
               FROM transcript_persona_assignments tpa
               INNER JOIN transcripts t ON t.id = tpa.transcript_id
               WHERE tpa.persona_id = ?
               UNION
               SELECT t.note_id
               FROM transcript_persona_attributions tpat
               INNER JOIN transcripts t ON t.id = tpat.transcript_id
               WHERE tpat.persona_id = ? OR tpat.candidate_persona_id = ?
             )
             ORDER BY note_id",
        )
        .bind(persona_id)
        .bind(persona_id)
        .bind(persona_id)
        .bind(persona_id)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows.into_iter().map(|row| row.get("note_id")).collect())
    }

    pub async fn update_persona(
        &self,
        persona_id: &str,
        name: &str,
        relationship: Option<&str>,
        dossier: &str,
    ) -> Result<PersonaDetailDto, AppError> {
        let name = name.trim();
        if name.is_empty() {
            return Err(AppError::new(
                "persona_name_required",
                "Enter a name for this Persona.",
            ));
        }
        let relationship = relationship
            .map(str::trim)
            .filter(|value| !value.is_empty());
        let result = query(
            "UPDATE personas
             SET name = ?, relationship = ?, dossier = ?, dossier_revision = dossier_revision + 1,
                 updated_at = ?
             WHERE id = ?",
        )
        .bind(name)
        .bind(relationship)
        .bind(dossier.trim())
        .bind(timestamp())
        .bind(persona_id)
        .execute(&self.pool)
        .await?;
        if result.rows_affected() == 0 {
            return Err(AppError::new(
                "persona_not_found",
                "This Persona no longer exists.",
            ));
        }
        self.get_persona(persona_id).await
    }

    pub async fn archive_persona(&self, persona_id: &str) -> Result<PersonaDetailDto, AppError> {
        self.set_persona_archived(persona_id, true).await
    }

    pub async fn restore_persona(&self, persona_id: &str) -> Result<PersonaDetailDto, AppError> {
        self.set_persona_archived(persona_id, false).await
    }

    async fn set_persona_archived(
        &self,
        persona_id: &str,
        archived: bool,
    ) -> Result<PersonaDetailDto, AppError> {
        let mut tx = self.pool.begin().await?;
        let row = query("SELECT is_self FROM personas WHERE id = ?")
            .bind(persona_id)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or_else(|| AppError::new("persona_not_found", "This Persona no longer exists."))?;
        if archived && row.get::<i64, _>("is_self") != 0 {
            return Err(AppError::new(
                "persona_self_protected",
                "Your own Persona cannot be archived while recognition is enabled.",
            ));
        }
        let now = timestamp();
        let archived_at = archived.then_some(now.as_str());
        query("UPDATE personas SET archived_at = ?, updated_at = ? WHERE id = ?")
            .bind(archived_at)
            .bind(&now)
            .bind(persona_id)
            .execute(&mut *tx)
            .await?;
        if archived {
            query(
                "UPDATE transcript_persona_attributions
                 SET state = 'anonymous', candidate_persona_id = NULL, confidence = NULL,
                     updated_at = ?
                 WHERE state = 'suggested' AND candidate_persona_id = ?",
            )
            .bind(&now)
            .bind(persona_id)
            .execute(&mut *tx)
            .await?;
        }
        tx.commit().await?;
        self.get_persona(persona_id).await
    }

    pub async fn delete_persona(
        &self,
        persona_id: &str,
    ) -> Result<PersonaDeletionReceipt, AppError> {
        let mut tx = self.pool.begin().await?;
        let persona = query("SELECT name, is_self FROM personas WHERE id = ?")
            .bind(persona_id)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or_else(|| AppError::new("persona_not_found", "This Persona no longer exists."))?;
        if persona.get::<i64, _>("is_self") != 0 {
            return Err(AppError::new(
                "persona_self_protected",
                "Your own Persona cannot be deleted while recognition is enabled.",
            ));
        }
        let name: String = persona.get("name");
        let deletion_batch_id = Uuid::new_v4().to_string();
        let now = timestamp();
        let note_rows = query(
            "SELECT DISTINCT note_id FROM (
               SELECT t.note_id AS note_id
               FROM transcript_persona_assignments tpa
               INNER JOIN transcripts t ON t.id = tpa.transcript_id
               WHERE tpa.persona_id = ?
               UNION
               SELECT t.note_id AS note_id
               FROM transcript_persona_attributions tpat
               INNER JOIN transcripts t ON t.id = tpat.transcript_id
               WHERE tpat.candidate_persona_id = ?
             )
             ORDER BY note_id",
        )
        .bind(persona_id)
        .bind(persona_id)
        .fetch_all(&mut *tx)
        .await?;
        let affected_note_ids = note_rows
            .iter()
            .map(|row| row.get::<String, _>("note_id"))
            .collect::<Vec<_>>();
        let affected_transcript_count: i64 = query(
            "SELECT COUNT(*) AS count FROM transcript_persona_assignments WHERE persona_id = ?",
        )
        .bind(persona_id)
        .fetch_one(&mut *tx)
        .await?
        .get("count");
        query(
            "INSERT INTO persona_historical_attributions
             (transcript_id, deletion_batch_id, original_cluster_id, anonymous_label,
              frozen_name, state, created_at, updated_at)
             SELECT t.id, ?, COALESCE(pc.id, 'historical:' || t.id),
                    COALESCE(pc.anonymous_label,
                      CASE t.source WHEN 'system' THEN 'System' ELSE 'Microphone' END),
                    ?, 'frozen', ?, ?
             FROM transcript_persona_assignments tpa
             INNER JOIN transcripts t ON t.id = tpa.transcript_id
             LEFT JOIN transcript_persona_attributions tpat ON tpat.transcript_id = t.id
             LEFT JOIN persona_clusters pc ON pc.id = tpat.persona_cluster_id
             WHERE tpa.persona_id = ?
             ON CONFLICT(transcript_id) DO UPDATE SET
               deletion_batch_id = excluded.deletion_batch_id,
               original_cluster_id = excluded.original_cluster_id,
               anonymous_label = excluded.anonymous_label,
               frozen_name = excluded.frozen_name,
               state = 'frozen', updated_at = excluded.updated_at",
        )
        .bind(&deletion_batch_id)
        .bind(&name)
        .bind(&now)
        .bind(&now)
        .bind(persona_id)
        .execute(&mut *tx)
        .await?;
        query(
            "UPDATE transcript_persona_attributions
             SET state = 'anonymous', candidate_persona_id = NULL, confidence = NULL,
                 updated_at = ?
             WHERE candidate_persona_id = ?",
        )
        .bind(&now)
        .bind(persona_id)
        .execute(&mut *tx)
        .await?;
        let cluster_rows = query(
            "SELECT DISTINCT persona_cluster_id
             FROM transcript_persona_attributions
             WHERE persona_id = ?",
        )
        .bind(persona_id)
        .fetch_all(&mut *tx)
        .await?;
        query("DELETE FROM transcript_persona_assignments WHERE persona_id = ?")
            .bind(persona_id)
            .execute(&mut *tx)
            .await?;
        query("DELETE FROM transcript_persona_attributions WHERE persona_id = ?")
            .bind(persona_id)
            .execute(&mut *tx)
            .await?;
        for row in cluster_rows {
            let cluster_id: String = row.get("persona_cluster_id");
            query("DELETE FROM persona_voiceprints WHERE persona_cluster_id = ?")
                .bind(&cluster_id)
                .execute(&mut *tx)
                .await?;
            query("DELETE FROM persona_clusters WHERE id = ?")
                .bind(&cluster_id)
                .execute(&mut *tx)
                .await?;
        }
        query("DELETE FROM personas WHERE id = ?")
            .bind(persona_id)
            .execute(&mut *tx)
            .await?;
        for note_id in &affected_note_ids {
            query("UPDATE notes SET updated_at = ? WHERE id = ?")
                .bind(&now)
                .bind(note_id)
                .execute(&mut *tx)
                .await?;
        }
        tx.commit().await?;
        Ok(PersonaDeletionReceipt {
            deletion_batch_id,
            affected_note_ids,
            affected_transcript_count,
        })
    }

    pub async fn scrub_deleted_persona_from_notes(
        &self,
        deletion_batch_id: &str,
    ) -> Result<PersonaMutationReceipt, AppError> {
        let mut tx = self.pool.begin().await?;
        let rows = query(
            "SELECT DISTINCT t.note_id
             FROM persona_historical_attributions pha
             INNER JOIN transcripts t ON t.id = pha.transcript_id
             WHERE pha.deletion_batch_id = ?
             ORDER BY t.note_id",
        )
        .bind(deletion_batch_id)
        .fetch_all(&mut *tx)
        .await?;
        if rows.is_empty() {
            return Err(AppError::new(
                "persona_deletion_batch_not_found",
                "This deleted Persona has already been scrubbed or no longer exists.",
            ));
        }
        let affected_note_ids = rows
            .iter()
            .map(|row| row.get::<String, _>("note_id"))
            .collect::<Vec<_>>();
        let now = timestamp();
        query(
            "UPDATE persona_historical_attributions
             SET deletion_batch_id = NULL, frozen_name = NULL, state = 'anonymous', updated_at = ?
             WHERE deletion_batch_id = ?",
        )
        .bind(&now)
        .bind(deletion_batch_id)
        .execute(&mut *tx)
        .await?;
        for note_id in &affected_note_ids {
            query("UPDATE notes SET updated_at = ? WHERE id = ?")
                .bind(&now)
                .bind(note_id)
                .execute(&mut *tx)
                .await?;
        }
        tx.commit().await?;
        Ok(PersonaMutationReceipt { affected_note_ids })
    }

    async fn persona_commitments(
        &self,
        persona_id: &str,
    ) -> Result<Vec<PersonaCommitmentDto>, sqlx::error::Error> {
        let rows = query(
            "SELECT id, persona_id, direction, text, due_value, status, source_note_id,
                    created_at, updated_at
             FROM persona_commitments WHERE persona_id = ?
             ORDER BY CASE status WHEN 'open' THEN 0 WHEN 'done' THEN 1 ELSE 2 END,
                      created_at DESC",
        )
        .bind(persona_id)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows.iter().map(persona_commitment_from_row).collect())
    }

    async fn persona_meetings(
        &self,
        persona_id: &str,
    ) -> Result<Vec<PersonaNoteHistoryDto>, sqlx::error::Error> {
        let rows = query(
            "SELECT n.id AS note_id, n.title, n.generated_content, n.edited_content,
                    np.provenance, np.first_confirmed_at, np.updated_at AS last_seen_at
             FROM note_participants np
             INNER JOIN notes n ON n.id = np.note_id
             WHERE np.persona_id = ?
             ORDER BY np.updated_at DESC, n.id DESC",
        )
        .bind(persona_id)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows
            .iter()
            .map(|row| {
                let title: String = row.get("title");
                let content = row
                    .get::<Option<String>, _>("edited_content")
                    .or_else(|| row.get::<Option<String>, _>("generated_content"))
                    .unwrap_or_default();
                PersonaNoteHistoryDto {
                    note_id: row.get("note_id"),
                    title: title.clone(),
                    preview: preview_for(&title, &content),
                    provenance: row.get("provenance"),
                    first_confirmed_at: row.get("first_confirmed_at"),
                    last_seen_at: row.get("last_seen_at"),
                }
            })
            .collect())
    }

    async fn persona_dossier_jobs(
        &self,
        persona_id: &str,
    ) -> Result<Vec<PersonaDossierJobDto>, sqlx::error::Error> {
        let rows = query(
            "SELECT id, generation_result_id, persona_id, idempotency_key, status,
                    attempt_count, last_error, lease_expires_at, created_at, updated_at,
                    completed_at
             FROM persona_dossier_jobs WHERE persona_id = ?
             ORDER BY created_at DESC",
        )
        .bind(persona_id)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows.iter().map(persona_dossier_job_dto_from_row).collect())
    }

    pub async fn create_persona_commitment(
        &self,
        persona_id: &str,
        direction: PersonaCommitmentDirection,
        text: &str,
        due_value: Option<&str>,
        source_note_id: Option<&str>,
    ) -> Result<PersonaCommitmentDto, AppError> {
        let text = validate_commitment_text(text)?;
        let id = Uuid::new_v4().to_string();
        let now = timestamp();
        let mut tx = self.pool.begin().await?;
        query(
            "INSERT INTO persona_commitments
             (id, persona_id, direction, text, due_value, status, source_note_id,
              created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?)",
        )
        .bind(&id)
        .bind(persona_id)
        .bind(direction.as_db())
        .bind(text)
        .bind(normalize_optional(due_value))
        .bind(source_note_id)
        .bind(&now)
        .bind(&now)
        .execute(&mut *tx)
        .await
        .map_err(|error| match &error {
            sqlx::Error::Database(database) if database.is_foreign_key_violation() => {
                AppError::new(
                    "persona_not_found",
                    "This Persona or source note no longer exists.",
                )
            }
            _ => error.into(),
        })?;
        query(
            "UPDATE personas SET dossier_revision = dossier_revision + 1, updated_at = ?
             WHERE id = ?",
        )
        .bind(&now)
        .bind(persona_id)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        self.persona_commitment(&id).await
    }

    pub async fn update_persona_commitment(
        &self,
        commitment_id: &str,
        direction: PersonaCommitmentDirection,
        text: &str,
        due_value: Option<&str>,
        status: &str,
    ) -> Result<PersonaCommitmentDto, AppError> {
        let text = validate_commitment_text(text)?;
        if !matches!(status, "open" | "done" | "dropped") {
            return Err(AppError::new(
                "persona_commitment_status_invalid",
                "Commitment status must be open, done, or dropped.",
            ));
        }
        let now = timestamp();
        let mut tx = self.pool.begin().await?;
        let row = query(
            "UPDATE persona_commitments
             SET direction = ?, text = ?, due_value = ?, status = ?, updated_at = ?
             WHERE id = ?
             RETURNING persona_id",
        )
        .bind(direction.as_db())
        .bind(text)
        .bind(normalize_optional(due_value))
        .bind(status)
        .bind(&now)
        .bind(commitment_id)
        .fetch_optional(&mut *tx)
        .await?;
        let persona_id: String = row
            .ok_or_else(|| {
                AppError::new(
                    "persona_commitment_not_found",
                    "This Commitment no longer exists.",
                )
            })?
            .get("persona_id");
        query(
            "UPDATE personas SET dossier_revision = dossier_revision + 1, updated_at = ?
             WHERE id = ?",
        )
        .bind(&now)
        .bind(persona_id)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        self.persona_commitment(commitment_id).await
    }

    pub async fn delete_persona_commitment(&self, commitment_id: &str) -> Result<(), AppError> {
        let now = timestamp();
        let mut tx = self.pool.begin().await?;
        let row = query("DELETE FROM persona_commitments WHERE id = ? RETURNING persona_id")
            .bind(commitment_id)
            .fetch_optional(&mut *tx)
            .await?;
        let persona_id: String = row
            .ok_or_else(|| {
                AppError::new(
                    "persona_commitment_not_found",
                    "This Commitment no longer exists.",
                )
            })?
            .get("persona_id");
        query(
            "UPDATE personas SET dossier_revision = dossier_revision + 1, updated_at = ?
             WHERE id = ?",
        )
        .bind(&now)
        .bind(persona_id)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        Ok(())
    }

    async fn persona_commitment(
        &self,
        commitment_id: &str,
    ) -> Result<PersonaCommitmentDto, AppError> {
        let row = query(
            "SELECT id, persona_id, direction, text, due_value, status, source_note_id,
                    created_at, updated_at
             FROM persona_commitments WHERE id = ?",
        )
        .bind(commitment_id)
        .fetch_optional(&self.pool)
        .await?
        .ok_or_else(|| {
            AppError::new(
                "persona_commitment_not_found",
                "This Commitment no longer exists.",
            )
        })?;
        Ok(persona_commitment_from_row(&row))
    }

    pub async fn assign_transcript_persona(
        &self,
        note_id: &str,
        transcript_id: &str,
        name: &str,
        relationship: Option<&str>,
    ) -> Result<NoteDto, AppError> {
        self.assign_transcript_persona_with_id(note_id, transcript_id, None, name, relationship)
            .await
    }

    pub async fn assign_transcript_persona_with_id(
        &self,
        note_id: &str,
        transcript_id: &str,
        requested_persona_id: Option<&str>,
        name: &str,
        relationship: Option<&str>,
    ) -> Result<NoteDto, AppError> {
        self.assign_transcript_persona_with_options(
            note_id,
            transcript_id,
            requested_persona_id,
            name,
            relationship,
            false,
        )
        .await
    }

    pub async fn assign_transcript_persona_with_options(
        &self,
        note_id: &str,
        transcript_id: &str,
        requested_persona_id: Option<&str>,
        name: &str,
        relationship: Option<&str>,
        is_self: bool,
    ) -> Result<NoteDto, AppError> {
        let name = name.trim();
        if name.is_empty() {
            return Err(AppError::new(
                "persona_name_required",
                "Enter a name for this Persona.",
            ));
        }
        let relationship = relationship
            .map(str::trim)
            .filter(|value| !value.is_empty());
        let now = timestamp();
        let mut tx = self.pool.begin().await?;

        let transcript = query(
            "SELECT t.source, tpat.persona_cluster_id
             FROM transcripts t
             LEFT JOIN transcript_persona_attributions tpat ON tpat.transcript_id = t.id
             WHERE t.id = ? AND t.note_id = ? LIMIT 1",
        )
        .bind(transcript_id)
        .bind(note_id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(|| {
            AppError::new(
                "transcript_not_found",
                "The transcript turn could not be found in this note.",
            )
        })?;
        let transcript_source: Option<String> = transcript.get("source");
        let cluster_id: Option<String> = transcript.get("persona_cluster_id");
        let previous_legacy_persona_id = if cluster_id.is_none() {
            query("SELECT persona_id FROM transcript_persona_assignments WHERE transcript_id = ?")
                .bind(transcript_id)
                .fetch_optional(&mut *tx)
                .await?
                .map(|row| row.get::<String, _>("persona_id"))
        } else {
            None
        };
        if is_self {
            if requested_persona_id.is_some()
                || transcript_source.as_deref() != Some("microphone")
                || cluster_id.is_none()
            {
                return Err(AppError::new(
                    "persona_self_enrollment_invalid",
                    "Your own Voiceprint must be created from a recognized Microphone voice.",
                ));
            }
            if query("SELECT 1 FROM personas WHERE is_self = 1 LIMIT 1")
                .fetch_optional(&mut *tx)
                .await?
                .is_some()
            {
                return Err(AppError::new(
                    "persona_self_exists",
                    "Your own Voiceprint is already enrolled.",
                ));
            }
        }

        // Relationship text is part of the disambiguation contract: two
        // people may share a name, so never silently reuse a Persona whose
        // relationship does not match this assignment.
        let existing = if is_self {
            None
        } else if let Some(persona_id) = requested_persona_id {
            query(
                "SELECT id FROM personas
                 WHERE id = ? AND archived_at IS NULL
                   AND (is_self = 0 OR ? = 'microphone')",
            )
            .bind(persona_id)
            .bind(transcript_source.as_deref())
            .fetch_optional(&mut *tx)
            .await?
        } else {
            query(
                "SELECT id FROM personas
                 WHERE archived_at IS NULL
                   AND is_self = 0
                   AND name = ? COLLATE NOCASE
                   AND ((relationship IS NULL AND ? IS NULL) OR relationship = ?)
                 ORDER BY created_at ASC
                 LIMIT 1",
            )
            .bind(name)
            .bind(relationship)
            .bind(relationship)
            .fetch_optional(&mut *tx)
            .await?
        };
        if requested_persona_id.is_some() && existing.is_none() {
            return Err(AppError::new(
                "persona_not_found",
                "The selected active Persona no longer exists.",
            ));
        }
        let persona_id = if let Some(row) = existing {
            let id: String = row.get("id");
            id
        } else {
            let id = Uuid::new_v4().to_string();
            query(
                "INSERT INTO personas (id, name, relationship, is_self, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?)",
            )
            .bind(&id)
            .bind(name)
            .bind(relationship)
            .bind(i64::from(is_self))
            .bind(&now)
            .bind(&now)
            .execute(&mut *tx)
            .await?;
            id
        };

        if let Some(cluster_id) = cluster_id {
            let previous_persona_ids = query(
                "SELECT DISTINCT tpa.persona_id
                 FROM transcript_persona_attributions tpat
                 INNER JOIN transcript_persona_assignments tpa
                   ON tpa.transcript_id = tpat.transcript_id
                 WHERE tpat.persona_cluster_id = ?",
            )
            .bind(&cluster_id)
            .fetch_all(&mut *tx)
            .await?
            .into_iter()
            .map(|row| row.get::<String, _>("persona_id"))
            .collect::<Vec<_>>();
            query(
                "DELETE FROM persona_voiceprints
                 WHERE persona_cluster_id = ? AND kind = 'positive'",
            )
            .bind(&cluster_id)
            .execute(&mut *tx)
            .await?;
            insert_cluster_voiceprint(&mut tx, &persona_id, &cluster_id, "positive", &now).await?;
            query(
                "UPDATE transcript_persona_attributions
                 SET state = 'tagged', persona_id = ?, candidate_persona_id = NULL,
                     confidence = NULL, updated_at = ?
                 WHERE persona_cluster_id = ?",
            )
            .bind(&persona_id)
            .bind(&now)
            .bind(&cluster_id)
            .execute(&mut *tx)
            .await?;
            assign_cluster_transcripts(&mut tx, &cluster_id, &persona_id, &now).await?;
            for previous_persona_id in previous_persona_ids {
                if previous_persona_id == persona_id {
                    continue;
                }
                delete_note_participant_if_unused(&mut tx, note_id, &previous_persona_id).await?;
            }
        } else {
            query(
                "INSERT INTO transcript_persona_assignments (transcript_id, persona_id, created_at, updated_at)
                 VALUES (?, ?, ?, ?)
                 ON CONFLICT(transcript_id) DO UPDATE SET
                     persona_id = excluded.persona_id,
                     updated_at = excluded.updated_at",
            )
            .bind(transcript_id)
            .bind(&persona_id)
            .bind(&now)
            .bind(&now)
            .execute(&mut *tx)
            .await?;
            if let Some(previous_persona_id) = previous_legacy_persona_id {
                if previous_persona_id != persona_id {
                    delete_note_participant_if_unused(&mut tx, note_id, &previous_persona_id)
                        .await?;
                }
            }
        }
        upsert_note_participant(&mut tx, note_id, &persona_id, "tagged", &now).await?;
        query("UPDATE notes SET updated_at = ? WHERE id = ?")
            .bind(&now)
            .bind(note_id)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        Ok(self.get_note(note_id).await?)
    }

    pub async fn unassign_transcript_persona(
        &self,
        note_id: &str,
        transcript_id: &str,
    ) -> Result<NoteDto, AppError> {
        let now = timestamp();
        let mut tx = self.pool.begin().await?;
        let assignment = query(
            "SELECT tpa.persona_id, tpat.persona_cluster_id
             FROM transcript_persona_assignments tpa
             INNER JOIN transcripts t ON t.id = tpa.transcript_id
             LEFT JOIN transcript_persona_attributions tpat ON tpat.transcript_id = tpa.transcript_id
             WHERE tpa.transcript_id = ? AND t.note_id = ?",
        )
        .bind(transcript_id)
        .bind(note_id)
        .fetch_optional(&mut *tx)
        .await?;
        if let Some(assignment) = assignment {
            let persona_id: String = assignment.get("persona_id");
            let cluster_id: Option<String> = assignment.get("persona_cluster_id");
            if let Some(cluster_id) = cluster_id {
                query(
                    "DELETE FROM persona_voiceprints
                     WHERE persona_id = ? AND persona_cluster_id = ? AND kind = 'positive'",
                )
                .bind(&persona_id)
                .bind(&cluster_id)
                .execute(&mut *tx)
                .await?;
                query(
                    "DELETE FROM transcript_persona_assignments
                     WHERE transcript_id IN (
                       SELECT transcript_id FROM transcript_persona_attributions
                       WHERE persona_cluster_id = ?
                     )",
                )
                .bind(&cluster_id)
                .execute(&mut *tx)
                .await?;
                query(
                    "UPDATE transcript_persona_attributions
                     SET state = 'anonymous', persona_id = NULL, candidate_persona_id = NULL,
                         confidence = NULL, updated_at = ?
                     WHERE persona_cluster_id = ?",
                )
                .bind(&now)
                .bind(&cluster_id)
                .execute(&mut *tx)
                .await?;
            } else {
                query("DELETE FROM transcript_persona_assignments WHERE transcript_id = ?")
                    .bind(transcript_id)
                    .execute(&mut *tx)
                    .await?;
            }
            query(
                "DELETE FROM note_participants
                 WHERE note_id = ? AND persona_id = ?
                   AND NOT EXISTS (
                     SELECT 1
                     FROM transcripts t
                     INNER JOIN transcript_persona_assignments tpa ON tpa.transcript_id = t.id
                     WHERE t.note_id = ? AND tpa.persona_id = ?
                   )",
            )
            .bind(note_id)
            .bind(&persona_id)
            .bind(note_id)
            .bind(&persona_id)
            .execute(&mut *tx)
            .await?;
            query("UPDATE notes SET updated_at = ? WHERE id = ?")
                .bind(&now)
                .bind(note_id)
                .execute(&mut *tx)
                .await?;
        }
        tx.commit().await?;
        Ok(self.get_note(note_id).await?)
    }

    pub async fn confirm_persona_suggestion(
        &self,
        note_id: &str,
        transcript_id: &str,
    ) -> Result<NoteDto, AppError> {
        let now = timestamp();
        let mut tx = self.pool.begin().await?;
        let row = query(
            "SELECT tpat.persona_cluster_id, tpat.candidate_persona_id
             FROM transcript_persona_attributions tpat
             INNER JOIN transcripts t ON t.id = tpat.transcript_id
             INNER JOIN personas p ON p.id = tpat.candidate_persona_id
             WHERE tpat.transcript_id = ? AND t.note_id = ? AND tpat.state = 'suggested'
               AND p.archived_at IS NULL",
        )
        .bind(transcript_id)
        .bind(note_id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(|| {
            AppError::new(
                "persona_suggestion_not_found",
                "This Persona suggestion is no longer available.",
            )
        })?;
        let cluster_id: String = row.get("persona_cluster_id");
        let persona_id: String = row
            .get::<Option<String>, _>("candidate_persona_id")
            .ok_or_else(|| {
                AppError::new(
                    "persona_suggestion_not_found",
                    "This Persona suggestion is no longer available.",
                )
            })?;
        insert_cluster_voiceprint(&mut tx, &persona_id, &cluster_id, "positive", &now).await?;
        query(
            "UPDATE transcript_persona_attributions
             SET state = 'confirmed', persona_id = ?, candidate_persona_id = NULL,
                 updated_at = ?
             WHERE persona_cluster_id = ?",
        )
        .bind(&persona_id)
        .bind(&now)
        .bind(&cluster_id)
        .execute(&mut *tx)
        .await?;
        assign_cluster_transcripts(&mut tx, &cluster_id, &persona_id, &now).await?;
        query(
            "UPDATE personas
             SET recognition_confirmed_at = COALESCE(recognition_confirmed_at, ?), updated_at = ?
             WHERE id = ?",
        )
        .bind(&now)
        .bind(&now)
        .bind(&persona_id)
        .execute(&mut *tx)
        .await?;
        upsert_note_participant(&mut tx, note_id, &persona_id, "confirmed", &now).await?;
        query("UPDATE notes SET updated_at = ? WHERE id = ?")
            .bind(&now)
            .bind(note_id)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        Ok(self.get_note(note_id).await?)
    }

    pub async fn reject_persona_attribution(
        &self,
        note_id: &str,
        transcript_id: &str,
    ) -> Result<NoteDto, AppError> {
        let now = timestamp();
        let mut tx = self.pool.begin().await?;
        let row = query(
            "SELECT tpat.persona_cluster_id,
                    COALESCE(tpat.candidate_persona_id, tpat.persona_id) AS rejected_persona_id
             FROM transcript_persona_attributions tpat
             INNER JOIN transcripts t ON t.id = tpat.transcript_id
             WHERE tpat.transcript_id = ? AND t.note_id = ?
               AND tpat.state IN ('suggested', 'automatic')",
        )
        .bind(transcript_id)
        .bind(note_id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(|| {
            AppError::new(
                "persona_attribution_not_found",
                "This Persona attribution is no longer available.",
            )
        })?;
        let cluster_id: String = row.get("persona_cluster_id");
        let persona_id: String = row
            .get::<Option<String>, _>("rejected_persona_id")
            .ok_or_else(|| {
                AppError::new(
                    "persona_attribution_not_found",
                    "This Persona attribution is no longer available.",
                )
            })?;
        query(
            "DELETE FROM persona_voiceprints
             WHERE persona_id = ? AND persona_cluster_id = ? AND kind = 'positive'",
        )
        .bind(&persona_id)
        .bind(&cluster_id)
        .execute(&mut *tx)
        .await?;
        insert_cluster_voiceprint(&mut tx, &persona_id, &cluster_id, "negative", &now).await?;
        query(
            "DELETE FROM transcript_persona_assignments
             WHERE transcript_id IN (
               SELECT transcript_id FROM transcript_persona_attributions
               WHERE persona_cluster_id = ?
             )",
        )
        .bind(&cluster_id)
        .execute(&mut *tx)
        .await?;
        query(
            "UPDATE transcript_persona_attributions
             SET state = 'anonymous', persona_id = NULL, candidate_persona_id = NULL,
                 confidence = NULL, updated_at = ?
             WHERE persona_cluster_id = ?",
        )
        .bind(&now)
        .bind(&cluster_id)
        .execute(&mut *tx)
        .await?;
        query(
            "DELETE FROM note_participants
             WHERE note_id = ? AND persona_id = ?
               AND NOT EXISTS (
                 SELECT 1 FROM transcripts t
                 INNER JOIN transcript_persona_assignments tpa ON tpa.transcript_id = t.id
                 WHERE t.note_id = ? AND tpa.persona_id = ?
               )",
        )
        .bind(note_id)
        .bind(&persona_id)
        .bind(note_id)
        .bind(&persona_id)
        .execute(&mut *tx)
        .await?;
        query("UPDATE notes SET updated_at = ? WHERE id = ?")
            .bind(&now)
            .bind(note_id)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        Ok(self.get_note(note_id).await?)
    }

    pub async fn persona_voiceprints_for_source(
        &self,
        source: &str,
        model_id: &str,
        excluding_session_id: &str,
    ) -> Result<Vec<PersonaVoiceprintRecord>, sqlx::error::Error> {
        let rows = query(
            "SELECT pv.persona_id, pv.source, pv.model_id, pv.embedding, pv.kind,
                    pv.recording_session_id, p.recognition_confirmed_at
             FROM persona_voiceprints pv
             INNER JOIN personas p ON p.id = pv.persona_id
             WHERE pv.source = ? AND pv.model_id = ? AND pv.recording_session_id != ?
               AND p.archived_at IS NULL
               AND (? != 'microphone' OR p.is_self = 1)",
        )
        .bind(source)
        .bind(model_id)
        .bind(excluding_session_id)
        .bind(source)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows
            .into_iter()
            .map(|row| PersonaVoiceprintRecord {
                persona_id: row.get("persona_id"),
                source: row.get("source"),
                model_id: row.get("model_id"),
                embedding: row.get("embedding"),
                kind: row.get("kind"),
                recording_session_id: row.get("recording_session_id"),
                recognition_confirmed: row
                    .get::<Option<String>, _>("recognition_confirmed_at")
                    .is_some(),
            })
            .collect())
    }

    pub async fn persona_clusters_for_session(
        &self,
        session_id: &str,
    ) -> Result<Vec<PersonaClusterRecord>, sqlx::error::Error> {
        let rows = query(
            "SELECT pc.id, pc.recording_session_id, pc.note_id, pc.source,
                    pc.speaker_index, pc.anonymous_label, pc.model_id, pc.embedding,
                    pc.spans_json,
                    COALESCE((
                      SELECT state FROM transcript_persona_attributions
                      WHERE persona_cluster_id = pc.id LIMIT 1
                    ), 'anonymous') AS attribution_state,
                    (SELECT COALESCE(persona_id, candidate_persona_id)
                     FROM transcript_persona_attributions
                     WHERE persona_cluster_id = pc.id LIMIT 1) AS attribution_persona_id,
                    (SELECT confidence FROM transcript_persona_attributions
                     WHERE persona_cluster_id = pc.id LIMIT 1) AS attribution_confidence
             FROM persona_clusters pc
             WHERE pc.recording_session_id = ?
             ORDER BY pc.source ASC, pc.speaker_index ASC",
        )
        .bind(session_id)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows
            .into_iter()
            .map(|row| PersonaClusterRecord {
                id: row.get("id"),
                recording_session_id: row.get("recording_session_id"),
                note_id: row.get("note_id"),
                source: row.get("source"),
                speaker_index: row.get("speaker_index"),
                anonymous_label: row.get("anonymous_label"),
                model_id: row.get("model_id"),
                embedding: row.get("embedding"),
                spans_json: row.get("spans_json"),
                state: row.get("attribution_state"),
                persona_id: row.get("attribution_persona_id"),
                confidence: row.get("attribution_confidence"),
            })
            .collect())
    }

    pub async fn persona_cluster_preview_source(
        &self,
        cluster_id: &str,
    ) -> Result<Option<PersonaClusterPreviewSource>, sqlx::error::Error> {
        let row = query(
            "SELECT pc.id, pc.note_id, pc.recording_session_id, pc.source, pc.spans_json,
                    aa.path AS audio_path
             FROM persona_clusters pc
             INNER JOIN audio_artifacts aa
               ON aa.recording_session_id = pc.recording_session_id
              AND aa.source = pc.source
              AND aa.status = 'valid'
             WHERE pc.id = ?
             ORDER BY aa.created_at DESC
             LIMIT 1",
        )
        .bind(cluster_id)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.map(|row| PersonaClusterPreviewSource {
            cluster_id: row.get("id"),
            note_id: row.get("note_id"),
            recording_session_id: row.get("recording_session_id"),
            source: row.get("source"),
            spans_json: row.get("spans_json"),
            audio_path: row.get("audio_path"),
        }))
    }

    pub async fn persist_persona_recognition(
        &self,
        note_id: &str,
        session_id: &str,
        clusters: &[PersonaClusterRecord],
    ) -> Result<(), AppError> {
        if clusters.is_empty() {
            return Ok(());
        }
        let now = timestamp();
        let mut tx = self.pool.begin().await?;
        // Bootstrap the protected owner registry row without a separate
        // enrollment ceremony, but never trust a microphone cluster merely
        // because it is the only one. The first unambiguous sample is a
        // visible suggestion ("Is this You?"); only confirmation makes it a
        // Participant or eligible dossier evidence. If it was a guest, a
        // rejection removes the positive sample and a later cluster can be
        // proposed instead.
        let self_row = query(
            "SELECT p.id,
                    EXISTS(SELECT 1 FROM persona_voiceprints pv
                           WHERE pv.persona_id = p.id AND pv.kind = 'positive') AS has_voiceprint
             FROM personas p WHERE p.is_self = 1 LIMIT 1",
        )
        .fetch_optional(&mut *tx)
        .await?;
        let microphone_clusters = clusters
            .iter()
            .filter(|cluster| cluster.source == "microphone")
            .collect::<Vec<_>>();
        let implicit_self_persona_id = if microphone_clusters.len() != 1 {
            None
        } else if let Some(row) = self_row {
            (!row.get::<bool, _>("has_voiceprint")).then(|| row.get::<String, _>("id"))
        } else {
            let id = Uuid::new_v4().to_string();
            query(
                "INSERT INTO personas (id, name, relationship, is_self, created_at, updated_at)
                 VALUES (?, 'You', NULL, 1, ?, ?)",
            )
            .bind(&id)
            .bind(&now)
            .bind(&now)
            .execute(&mut *tx)
            .await?;
            Some(id)
        };
        let implicit_self_cluster_id = implicit_self_persona_id
            .as_ref()
            .map(|_| microphone_clusters[0].id.clone());
        for cluster in clusters {
            if cluster.note_id != note_id || cluster.recording_session_id != session_id {
                return Err(AppError::new(
                    "persona_cluster_scope_invalid",
                    "Persona recognition returned a cluster outside this recording.",
                ));
            }
            query(
                "INSERT INTO persona_clusters
                 (id, recording_session_id, note_id, source, speaker_index, anonymous_label,
                  model_id, embedding, spans_json, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT(recording_session_id, source, speaker_index) DO UPDATE SET
                   anonymous_label = excluded.anonymous_label,
                   model_id = excluded.model_id,
                   embedding = excluded.embedding,
                   spans_json = excluded.spans_json,
                   updated_at = excluded.updated_at",
            )
            .bind(&cluster.id)
            .bind(session_id)
            .bind(note_id)
            .bind(&cluster.source)
            .bind(cluster.speaker_index)
            .bind(&cluster.anonymous_label)
            .bind(&cluster.model_id)
            .bind(&cluster.embedding)
            .bind(&cluster.spans_json)
            .bind(&now)
            .bind(&now)
            .execute(&mut *tx)
            .await?;
        }

        if let (Some(persona_id), Some(cluster_id)) = (
            implicit_self_persona_id.as_deref(),
            implicit_self_cluster_id.as_deref(),
        ) {
            insert_cluster_voiceprint(&mut tx, persona_id, cluster_id, "positive", &now).await?;
        }

        let transcript_rows = query(
            "SELECT id, source, start_ms, end_ms
             FROM transcripts
             WHERE note_id = ? AND recording_session_id = ?
               AND status = 'succeeded' AND start_ms IS NOT NULL AND end_ms IS NOT NULL",
        )
        .bind(note_id)
        .bind(session_id)
        .fetch_all(&mut *tx)
        .await?;
        for row in transcript_rows {
            let transcript_id: String = row.get("id");
            let source: String = row.get("source");
            let start_ms: i64 = row.get("start_ms");
            let end_ms: i64 = row.get("end_ms");
            let best = clusters
                .iter()
                .filter(|cluster| cluster.source == source)
                .filter_map(|cluster| {
                    let spans =
                        serde_json::from_str::<Vec<(i64, i64)>>(&cluster.spans_json).ok()?;
                    let overlap = spans
                        .into_iter()
                        .map(|(start, end)| (end.min(end_ms) - start.max(start_ms)).max(0))
                        .sum::<i64>();
                    (overlap > 0).then_some((overlap, cluster))
                })
                .max_by_key(|(overlap, _cluster)| *overlap)
                .map(|(_overlap, cluster)| cluster);
            let Some(cluster) = best else {
                continue;
            };
            let implicitly_enrolled =
                implicit_self_cluster_id.as_deref() == Some(cluster.id.as_str());
            let attribution_state = if implicitly_enrolled {
                "suggested"
            } else {
                cluster.state.as_str()
            };
            let recognized_persona_id = if implicitly_enrolled {
                implicit_self_persona_id.as_deref()
            } else {
                cluster.persona_id.as_deref()
            };
            let (persona_id, candidate_persona_id) = match attribution_state {
                "automatic" | "tagged" | "confirmed" => (recognized_persona_id, None),
                "suggested" => (None, recognized_persona_id),
                _ => (None, None),
            };
            query(
                "INSERT INTO transcript_persona_attributions
                 (transcript_id, persona_cluster_id, state, persona_id, candidate_persona_id,
                  confidence, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT(transcript_id) DO UPDATE SET
                   persona_cluster_id = excluded.persona_cluster_id,
                   state = excluded.state,
                   persona_id = excluded.persona_id,
                   candidate_persona_id = excluded.candidate_persona_id,
                   frozen_name = NULL,
                   confidence = excluded.confidence,
                   updated_at = excluded.updated_at",
            )
            .bind(&transcript_id)
            .bind(&cluster.id)
            .bind(attribution_state)
            .bind(persona_id)
            .bind(candidate_persona_id)
            .bind(cluster.confidence)
            .bind(&now)
            .bind(&now)
            .execute(&mut *tx)
            .await?;

            if let Some(persona_id) = persona_id {
                insert_cluster_voiceprint(&mut tx, persona_id, &cluster.id, "positive", &now)
                    .await?;
                query(
                    "INSERT INTO transcript_persona_assignments
                     (transcript_id, persona_id, created_at, updated_at)
                     VALUES (?, ?, ?, ?)
                     ON CONFLICT(transcript_id) DO UPDATE SET
                       persona_id = excluded.persona_id,
                       updated_at = excluded.updated_at",
                )
                .bind(&transcript_id)
                .bind(persona_id)
                .bind(&now)
                .bind(&now)
                .execute(&mut *tx)
                .await?;
                let provenance = match attribution_state {
                    "confirmed" => "confirmed",
                    "tagged" => "tagged",
                    _ => "automatic",
                };
                upsert_note_participant(&mut tx, note_id, persona_id, provenance, &now).await?;
            } else {
                query("DELETE FROM transcript_persona_assignments WHERE transcript_id = ?")
                    .bind(&transcript_id)
                    .execute(&mut *tx)
                    .await?;
            }
        }
        tx.commit().await?;
        Ok(())
    }

    pub async fn audio_artifact_paths_for_note(
        &self,
        note_id: &str,
    ) -> Result<Vec<String>, sqlx::error::Error> {
        let rows = query("SELECT path FROM audio_artifacts WHERE note_id = ?")
            .bind(note_id)
            .fetch_all(&self.pool)
            .await?;
        Ok(rows.into_iter().map(|row| row.get("path")).collect())
    }

    pub async fn audio_artifact_paths_for_notes(
        &self,
        note_ids: &[String],
    ) -> Result<Vec<String>, sqlx::error::Error> {
        let mut paths = Vec::new();
        for note_id in note_ids {
            paths.extend(self.audio_artifact_paths_for_note(note_id).await?);
        }
        Ok(paths)
    }

    pub async fn delete_note(&self, note_id: &str) -> Result<(), sqlx::error::Error> {
        let mut tx = self.pool.begin().await?;
        delete_note_records(&mut tx, note_id).await?;
        tx.commit().await
    }

    pub async fn delete_notes(&self, note_ids: &[String]) -> Result<(), sqlx::error::Error> {
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
    ) -> Result<(), sqlx::error::Error> {
        let now = timestamp();
        let mut tx = self.pool.begin().await?;

        if delete_notes {
            query(
                "DELETE FROM note_generation_blocks
                 WHERE note_id IN (SELECT note_id FROM note_folders WHERE folder_id = ?)",
            )
            .bind(folder_id)
            .execute(&mut *tx)
            .await?;
            query(
                "DELETE FROM generation_results
                 WHERE note_id IN (SELECT note_id FROM note_folders WHERE folder_id = ?)",
            )
            .bind(folder_id)
            .execute(&mut *tx)
            .await?;
            query(
                "DELETE FROM transcripts
                 WHERE note_id IN (SELECT note_id FROM note_folders WHERE folder_id = ?)",
            )
            .bind(folder_id)
            .execute(&mut *tx)
            .await?;
            query(
                "DELETE FROM audio_artifacts
                 WHERE note_id IN (SELECT note_id FROM note_folders WHERE folder_id = ?)",
            )
            .bind(folder_id)
            .execute(&mut *tx)
            .await?;
            query(
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
            query(
                "DELETE FROM recording_sessions
                 WHERE note_id IN (SELECT note_id FROM note_folders WHERE folder_id = ?)",
            )
            .bind(folder_id)
            .execute(&mut *tx)
            .await?;
            query(
                "DELETE FROM notes
                 WHERE id IN (SELECT note_id FROM note_folders WHERE folder_id = ?)",
            )
            .bind(folder_id)
            .execute(&mut *tx)
            .await?;
        }

        query("DELETE FROM note_folders WHERE folder_id = ?")
            .bind(folder_id)
            .execute(&mut *tx)
            .await?;
        query("DELETE FROM session_folders WHERE folder_id = ?")
            .bind(folder_id)
            .execute(&mut *tx)
            .await?;
        query("UPDATE folders SET deleted_at = ?, updated_at = ? WHERE id = ?")
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
    ) -> Result<(), sqlx::error::Error> {
        query(
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

    pub async fn set_persona_recognition_warning(
        &self,
        note_id: &str,
        warning: Option<&str>,
    ) -> Result<(), sqlx::error::Error> {
        query("UPDATE notes SET persona_recognition_warning = ?, updated_at = ? WHERE id = ?")
            .bind(warning)
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
    ) -> Result<NoteDto, sqlx::error::Error> {
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
    ) -> Result<NoteDto, sqlx::error::Error> {
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
        let mut tx = self.pool.begin().await?;
        query(
            "UPDATE notes SET title = ?, generated_content = ?, edited_content = ?, active_tab = 'notes', processing_status = 'ready', last_error = NULL, updated_at = ? WHERE id = ?",
        )
        .bind(title)
        .bind(next_generated_content)
        .bind(next_edited_content)
        .bind(timestamp())
        .bind(note_id)
        .execute(&mut *tx)
        .await?;
        if let Some(generation_result_id) = generation_result_id {
            enqueue_dossier_jobs_for_generation_tx(&mut tx, generation_result_id).await?;
        }
        tx.commit().await?;
        self.get_note(note_id).await
    }

    pub async fn enqueue_dossier_jobs_for_generation(
        &self,
        generation_result_id: &str,
    ) -> Result<u64, sqlx::error::Error> {
        let mut tx = self.pool.begin().await?;
        let inserted =
            enqueue_dossier_jobs_for_generation_tx(&mut tx, generation_result_id).await?;
        tx.commit().await?;
        Ok(inserted)
    }

    pub async fn enqueue_dossier_jobs_for_note(
        &self,
        note_id: &str,
    ) -> Result<u64, sqlx::error::Error> {
        let mut tx = self.pool.begin().await?;
        let rows = query(
            "SELECT id FROM generation_results
             WHERE note_id = ? AND status = 'succeeded'
             ORDER BY created_at ASC",
        )
        .bind(note_id)
        .fetch_all(&mut *tx)
        .await?;
        let mut inserted = 0;
        for row in rows {
            let generation_result_id: String = row.get("id");
            inserted +=
                enqueue_dossier_jobs_for_generation_tx(&mut tx, &generation_result_id).await?;
        }
        tx.commit().await?;
        Ok(inserted)
    }

    pub(crate) async fn claim_next_dossier_job(
        &self,
    ) -> Result<Option<PersonaDossierJob>, sqlx::error::Error> {
        let now = timestamp();
        let lease_expires_at =
            (Utc::now() + Duration::minutes(15)).to_rfc3339_opts(SecondsFormat::Millis, true);
        let row = query(
            "UPDATE persona_dossier_jobs
             SET status = 'running', attempt_count = attempt_count + 1,
                 last_error = NULL, lease_expires_at = ?, updated_at = ?
             WHERE id = (
               SELECT id FROM persona_dossier_jobs
               WHERE status = 'pending'
                  OR (status = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at < ?)
               ORDER BY created_at ASC LIMIT 1
             )
             RETURNING id, generation_result_id, persona_id, idempotency_key, attempt_count",
        )
        .bind(&lease_expires_at)
        .bind(&now)
        .bind(&now)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.map(|row| PersonaDossierJob {
            id: row.get("id"),
            idempotency_key: row.get("idempotency_key"),
            attempt_count: row.get("attempt_count"),
        }))
    }

    pub(crate) async fn requeue_interrupted_dossier_jobs(&self) -> Result<u64, sqlx::error::Error> {
        let result = query(
            "UPDATE persona_dossier_jobs
             SET status = 'pending', lease_expires_at = NULL, updated_at = ?
             WHERE status = 'running'",
        )
        .bind(timestamp())
        .execute(&self.pool)
        .await?;
        Ok(result.rows_affected())
    }

    pub(crate) async fn persona_dossier_job_context(
        &self,
        job: &PersonaDossierJob,
    ) -> Result<PersonaDossierJobContext, sqlx::error::Error> {
        let row = query(
            "SELECT p.id AS persona_id, p.name, p.relationship, p.dossier, p.dossier_revision,
                    gr.note_id, anchor.recording_session_id
             FROM persona_dossier_jobs pdj
             INNER JOIN personas p ON p.id = pdj.persona_id
             INNER JOIN generation_results gr ON gr.id = pdj.generation_result_id
             INNER JOIN transcripts anchor ON anchor.id = gr.transcript_id
             WHERE pdj.id = ?",
        )
        .bind(&job.id)
        .fetch_one(&self.pool)
        .await?;
        let source_note_id: String = row.get("note_id");
        let persona_id: String = row.get("persona_id");
        let recording_session_id: Option<String> = row.get("recording_session_id");
        let transcript_row = query(
            "SELECT GROUP_CONCAT(labeled_text, char(10) || char(10)) AS transcript
             FROM (
               SELECT CASE WHEN p.is_self = 1 THEN 'User' ELSE p.name END
                      || ' [' || COALESCE(t.source, 'unknown') || ']:'
                      || char(10) || t.text AS labeled_text
               FROM transcripts t
               INNER JOIN transcript_persona_assignments tpa ON tpa.transcript_id = t.id
               INNER JOIN personas p ON p.id = tpa.persona_id
               LEFT JOIN transcript_persona_attributions tpat ON tpat.transcript_id = t.id
               WHERE t.note_id = ? AND t.recording_session_id = ?
                 AND t.status = 'succeeded'
                 AND TRIM(t.text) != ''
                 AND (tpat.state IS NULL OR tpat.state IN ('tagged', 'confirmed', 'automatic'))
               ORDER BY t.created_at ASC, t.turn_index ASC
             )",
        )
        .bind(&source_note_id)
        .bind(recording_session_id)
        .fetch_one(&self.pool)
        .await?;
        Ok(PersonaDossierJobContext {
            persona_name: row.get("name"),
            relationship: row.get("relationship"),
            dossier: row.get("dossier"),
            dossier_revision: row.get("dossier_revision"),
            commitments: self.persona_commitments(&persona_id).await?,
            trusted_transcript: transcript_row
                .get::<Option<String>, _>("transcript")
                .unwrap_or_default(),
            source_note_id,
        })
    }

    pub(crate) async fn complete_persona_dossier_job(
        &self,
        job_id: &str,
        expected_revision: i64,
        update: &PersonaDossierUpdate,
    ) -> Result<(), AppError> {
        let mut tx = self.pool.begin().await?;
        let row = query(
            "SELECT pdj.persona_id, gr.note_id
             FROM persona_dossier_jobs pdj
             INNER JOIN generation_results gr ON gr.id = pdj.generation_result_id
             WHERE pdj.id = ? AND pdj.status = 'running'",
        )
        .bind(job_id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(|| {
            AppError::new(
                "persona_dossier_job_not_running",
                "This dossier update is no longer running.",
            )
        })?;
        let persona_id: String = row.get("persona_id");
        let source_note_id: String = row.get("note_id");
        let now = timestamp();
        let updated = query(
            "UPDATE personas SET dossier = ?, dossier_revision = dossier_revision + 1,
                    updated_at = ?
             WHERE id = ? AND dossier_revision = ?",
        )
        .bind(update.dossier.trim())
        .bind(&now)
        .bind(&persona_id)
        .bind(expected_revision)
        .execute(&mut *tx)
        .await?;
        if updated.rows_affected() == 0 {
            return Err(AppError::new(
                "persona_dossier_conflict",
                "The dossier changed while this update was running. Retry with fresh context.",
            ));
        }
        for proposal in &update.new_commitments {
            let text = validate_commitment_text(&proposal.text)?;
            query(
                "INSERT INTO persona_commitments
                 (id, persona_id, direction, text, due_value, status, source_note_id,
                  source_job_id, source_item_key, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?)
                 ON CONFLICT(source_job_id, source_item_key)
                 WHERE source_job_id IS NOT NULL AND source_item_key IS NOT NULL
                 DO UPDATE SET
                   direction = excluded.direction, text = excluded.text,
                   due_value = excluded.due_value, updated_at = excluded.updated_at",
            )
            .bind(Uuid::new_v4().to_string())
            .bind(&persona_id)
            .bind(proposal.direction.as_db())
            .bind(text)
            .bind(normalize_optional(proposal.due.as_deref()))
            .bind(&source_note_id)
            .bind(job_id)
            .bind(&proposal.item_key)
            .bind(&now)
            .bind(&now)
            .execute(&mut *tx)
            .await?;
        }
        for proposal in &update.commitment_updates {
            if !matches!(proposal.status.as_str(), "open" | "done" | "dropped") {
                return Err(AppError::new(
                    "persona_commitment_status_invalid",
                    "Commitment status must be open, done, or dropped.",
                ));
            }
            let text = validate_commitment_text(&proposal.text)?;
            query(
                "UPDATE persona_commitments
                 SET status = ?, text = ?, due_value = ?, updated_at = ?
                 WHERE id = ? AND persona_id = ?",
            )
            .bind(&proposal.status)
            .bind(text)
            .bind(normalize_optional(proposal.due.as_deref()))
            .bind(&now)
            .bind(&proposal.id)
            .bind(&persona_id)
            .execute(&mut *tx)
            .await?;
        }
        query(
            "UPDATE persona_dossier_jobs
             SET status = 'succeeded', lease_expires_at = NULL, last_error = NULL,
                 completed_at = ?, updated_at = ? WHERE id = ?",
        )
        .bind(&now)
        .bind(&now)
        .bind(job_id)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        Ok(())
    }

    pub(crate) async fn fail_persona_dossier_job(
        &self,
        job_id: &str,
        error: &str,
    ) -> Result<(), sqlx::error::Error> {
        query(
            "UPDATE persona_dossier_jobs
             SET status = 'failed', last_error = ?, lease_expires_at = NULL, updated_at = ?
             WHERE id = ? AND status = 'running'",
        )
        .bind(error.trim())
        .bind(timestamp())
        .bind(job_id)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn retry_persona_dossier_job(
        &self,
        job_id: &str,
    ) -> Result<PersonaDossierJobDto, AppError> {
        let result = query(
            "UPDATE persona_dossier_jobs
             SET status = 'pending', last_error = NULL, lease_expires_at = NULL, updated_at = ?
             WHERE id = ? AND status = 'failed'",
        )
        .bind(timestamp())
        .bind(job_id)
        .execute(&self.pool)
        .await?;
        if result.rows_affected() == 0 {
            return Err(AppError::new(
                "persona_dossier_job_not_retryable",
                "This dossier update is not waiting for a retry.",
            ));
        }
        let row = query(
            "SELECT id, generation_result_id, persona_id, idempotency_key, status,
                    attempt_count, last_error, lease_expires_at, created_at, updated_at,
                    completed_at
             FROM persona_dossier_jobs WHERE id = ?",
        )
        .bind(job_id)
        .fetch_one(&self.pool)
        .await?;
        Ok(persona_dossier_job_dto_from_row(&row))
    }

    pub async fn persona_roster_text(&self) -> Result<String, sqlx::error::Error> {
        let rows = query(
            "SELECT name, relationship FROM personas
             WHERE archived_at IS NULL AND is_self = 0
             ORDER BY name COLLATE NOCASE ASC, created_at ASC",
        )
        .fetch_all(&self.pool)
        .await?;
        Ok(rows
            .iter()
            .map(|row| {
                let name: String = row.get("name");
                row.get::<Option<String>, _>("relationship")
                    .filter(|value| !value.trim().is_empty())
                    .map(|relationship| format!("{name} - {relationship}"))
                    .unwrap_or(name)
            })
            .collect::<Vec<_>>()
            .join("\n"))
    }

    pub async fn attach_detection_context(
        &self,
        session_id: &str,
        episode_id: &str,
        bundle_ids_json: &str,
        local_weekday: i64,
        time_bucket: i64,
    ) -> Result<(), sqlx::error::Error> {
        query(
            "UPDATE recording_sessions
             SET detected_episode_id = ?, detected_bundle_ids_json = ?,
                 detected_local_weekday = ?, detected_time_bucket = ?
             WHERE id = ?",
        )
        .bind(episode_id)
        .bind(bundle_ids_json)
        .bind(local_weekday)
        .bind(time_bucket)
        .bind(session_id)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn recurring_persona_candidates(
        &self,
        bundle_ids_json: &str,
        local_weekday: i64,
        time_bucket: i64,
    ) -> Result<Vec<String>, sqlx::error::Error> {
        let rows = query(
            "WITH matched_sessions AS (
               SELECT id
               FROM recording_sessions
               WHERE status = 'valid'
                 AND detected_bundle_ids_json = ?
                 AND detected_local_weekday = ?
                 AND detected_time_bucket BETWEEN ? AND ?
             ), matched_count AS (
               SELECT COUNT(*) AS count FROM matched_sessions
             )
             SELECT tpa.persona_id
             FROM matched_sessions ms
             INNER JOIN transcripts t ON t.recording_session_id = ms.id
             INNER JOIN transcript_persona_assignments tpa ON tpa.transcript_id = t.id
             INNER JOIN personas p ON p.id = tpa.persona_id
             WHERE p.archived_at IS NULL
               AND (SELECT count FROM matched_count) >= 2
             GROUP BY tpa.persona_id
             HAVING COUNT(DISTINCT ms.id) >= 2
                AND COUNT(DISTINCT ms.id) * 3 >= (SELECT count FROM matched_count) * 2
             ORDER BY MIN(p.name) COLLATE NOCASE ASC, tpa.persona_id ASC",
        )
        .bind(bundle_ids_json)
        .bind(local_weekday)
        .bind((time_bucket - 1).max(0))
        .bind((time_bucket + 1).min(47))
        .fetch_all(&self.pool)
        .await?;
        Ok(rows.into_iter().map(|row| row.get("persona_id")).collect())
    }

    pub async fn record_prep_offer(
        &self,
        detection_episode_id: &str,
        bundle_key: &str,
        expected_persona_ids: &[String],
    ) -> Result<bool, sqlx::error::Error> {
        let now = timestamp();
        let expected_persona_ids_json =
            serde_json::to_string(expected_persona_ids).unwrap_or_else(|_| "[]".to_string());
        let result = query(
            "INSERT INTO persona_prep_offers
             (detection_episode_id, bundle_key, expected_persona_ids_json, status,
              created_at, updated_at)
             VALUES (?, ?, ?, 'offered', ?, ?)
             ON CONFLICT(detection_episode_id) DO NOTHING",
        )
        .bind(detection_episode_id)
        .bind(bundle_key)
        .bind(expected_persona_ids_json)
        .bind(&now)
        .bind(&now)
        .execute(&self.pool)
        .await?;
        Ok(result.rows_affected() == 1)
    }

    pub async fn claim_prep_offer(
        &self,
        detection_episode_id: &str,
    ) -> Result<bool, sqlx::error::Error> {
        let now = timestamp();
        let stale_before =
            (Utc::now() - Duration::minutes(15)).to_rfc3339_opts(SecondsFormat::Millis, true);
        let result = query(
            "UPDATE persona_prep_offers
             SET status = 'running', updated_at = ?
             WHERE detection_episode_id = ?
               AND (status = 'offered' OR (status = 'running' AND updated_at < ?))",
        )
        .bind(now)
        .bind(detection_episode_id)
        .bind(stale_before)
        .execute(&self.pool)
        .await?;
        Ok(result.rows_affected() == 1)
    }

    pub async fn requeue_interrupted_prep_offers(&self) -> Result<u64, sqlx::error::Error> {
        let result = query(
            "UPDATE persona_prep_offers
             SET status = 'offered', updated_at = ?
             WHERE status = 'running'",
        )
        .bind(timestamp())
        .execute(&self.pool)
        .await?;
        Ok(result.rows_affected())
    }

    pub async fn release_prep_offer(
        &self,
        detection_episode_id: &str,
    ) -> Result<(), sqlx::error::Error> {
        query(
            "UPDATE persona_prep_offers
             SET status = 'offered', updated_at = ?
             WHERE detection_episode_id = ? AND status = 'running'",
        )
        .bind(timestamp())
        .bind(detection_episode_id)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn accepted_prep_note_id(
        &self,
        detection_episode_id: &str,
    ) -> Result<Option<String>, sqlx::error::Error> {
        let row = query(
            "SELECT accepted_note_id FROM persona_prep_offers
             WHERE detection_episode_id = ? AND status = 'accepted'",
        )
        .bind(detection_episode_id)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.and_then(|row| row.get("accepted_note_id")))
    }

    pub async fn complete_prep_offer_with_note(
        &self,
        detection_episode_id: &str,
        title: &str,
        content: &str,
    ) -> Result<NoteDto, AppError> {
        let note_id = Uuid::new_v4().to_string();
        let now = timestamp();
        let mut tx = self.pool.begin().await?;
        query(
            "INSERT INTO notes
             (id, title, generated_content, active_tab, processing_status, created_at, updated_at)
             VALUES (?, ?, ?, 'notes', 'ready', ?, ?)",
        )
        .bind(&note_id)
        .bind(title.trim())
        .bind(content.trim())
        .bind(&now)
        .bind(&now)
        .execute(&mut *tx)
        .await?;
        let accepted = query(
            "UPDATE persona_prep_offers
             SET status = 'accepted', accepted_note_id = ?, updated_at = ?
             WHERE detection_episode_id = ? AND status = 'running'",
        )
        .bind(&note_id)
        .bind(&now)
        .bind(detection_episode_id)
        .execute(&mut *tx)
        .await?;
        if accepted.rows_affected() != 1 {
            return Err(AppError::new(
                "persona_prep_offer_conflict",
                "This prep offer is no longer available.",
            ));
        }
        tx.commit().await?;
        Ok(self.get_note(&note_id).await?)
    }

    async fn generation_block_exists(
        &self,
        note_id: &str,
        recording_session_id: &str,
    ) -> Result<bool, sqlx::error::Error> {
        let row = query(
            "SELECT 1 FROM note_generation_blocks WHERE note_id = ? AND recording_session_id = ? LIMIT 1",
        )
        .bind(note_id)
        .bind(recording_session_id)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.is_some())
    }

    async fn generation_block_count(&self, note_id: &str) -> Result<i64, sqlx::error::Error> {
        let row = query("SELECT COUNT(*) AS count FROM note_generation_blocks WHERE note_id = ?")
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
    ) -> Result<(), sqlx::error::Error> {
        let Some(content) = content.map(str::trim).filter(|value| !value.is_empty()) else {
            return Ok(());
        };
        let now = timestamp();
        query(
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
    ) -> Result<(), sqlx::error::Error> {
        let now = timestamp();
        if let Some(row) = query(
            "SELECT id FROM note_generation_blocks WHERE note_id = ? AND recording_session_id = ? LIMIT 1",
        )
        .bind(note_id)
        .bind(recording_session_id)
        .fetch_optional(&self.pool)
        .await?
        {
            let id: String = row.get("id");
            query(
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
        query(
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

    async fn next_generation_block_sort_order(
        &self,
        note_id: &str,
    ) -> Result<i64, sqlx::error::Error> {
        let row = query(
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
    ) -> Result<Option<String>, sqlx::error::Error> {
        let rows = query(
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
    ) -> Result<(), sqlx::error::Error> {
        query(
            "INSERT INTO recording_sessions
             (id, note_id, source_mode, status, started_at, expected_elapsed_ms,
              device_label, permission_state, partial_path, final_path,
              persona_recognition_eligible)
             VALUES (?, ?, ?, 'recording', ?, 0, ?, 'granted', ?, ?, 1)",
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
    ) -> Result<Option<RecordingSourceMode>, sqlx::error::Error> {
        let row = query("SELECT source_mode FROM recording_sessions WHERE id = ?")
            .bind(session_id)
            .fetch_optional(&self.pool)
            .await?;
        Ok(row.map(|row| RecordingSourceMode::from(row.get::<String, _>("source_mode").as_str())))
    }

    pub async fn persona_recognition_eligible(
        &self,
        session_id: &str,
    ) -> Result<bool, sqlx::error::Error> {
        let row = query(
            "SELECT persona_recognition_eligible
             FROM recording_sessions WHERE id = ?",
        )
        .bind(session_id)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row
            .map(|row| row.get::<i64, _>("persona_recognition_eligible") != 0)
            .unwrap_or(false))
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
    ) -> Result<(), sqlx::error::Error> {
        query(
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

    pub async fn update_recording_recovery_snapshot(
        &self,
        session_id: &str,
        state: RecordingState,
        elapsed_ms: i64,
    ) -> Result<(), sqlx::error::Error> {
        let status = state.as_db();
        let mut tx = self.pool.begin().await?;
        query(
            "UPDATE recording_sessions
             SET status = ?, expected_elapsed_ms = max(expected_elapsed_ms, ?)
             WHERE id = ?
               AND status IN ('recording', 'paused')",
        )
        .bind(status)
        .bind(elapsed_ms)
        .bind(session_id)
        .execute(&mut *tx)
        .await?;
        query(
            "UPDATE audio_artifacts
             SET status = ?, expected_duration_ms = max(expected_duration_ms, ?)
             WHERE recording_session_id = ?
               AND status IN ('recording', 'paused')",
        )
        .bind(status)
        .bind(elapsed_ms)
        .bind(session_id)
        .execute(&mut *tx)
        .await?;
        tx.commit().await
    }

    pub async fn mark_recording_recoverable(
        &self,
        session_id: &str,
        note_id: &str,
    ) -> Result<(), sqlx::error::Error> {
        let now = timestamp();
        let message = "Recording interrupted before it could be finished.";
        let mut tx = self.pool.begin().await?;
        query(
            "UPDATE recording_sessions
             SET status = 'recoverable',
                 last_error = COALESCE(last_error, ?),
                 ended_at = COALESCE(ended_at, ?)
             WHERE id = ?
               AND status IN (
                 'recording',
                 'paused',
                 'finalizing',
                 'validating',
                 'transcribing',
                 'generating',
                 'failed',
                 'recoverable'
               )",
        )
        .bind(message)
        .bind(&now)
        .bind(session_id)
        .execute(&mut *tx)
        .await?;
        query(
            "UPDATE audio_artifacts
             SET status = 'recoverable',
                 last_error = COALESCE(last_error, ?)
             WHERE recording_session_id = ?
               AND status IN (
                 'recording',
                 'paused',
                 'finalizing',
                 'validating',
                 'transcribing',
                 'generating',
                 'failed',
                 'recoverable'
               )",
        )
        .bind(message)
        .bind(session_id)
        .execute(&mut *tx)
        .await?;
        query(
            "UPDATE notes
             SET processing_status = ?,
                 last_error = ?,
                 updated_at = ?
             WHERE id = ?",
        )
        .bind(ProcessingStatus::Recoverable.as_db())
        .bind("Recording interrupted. Review recovery options.")
        .bind(&now)
        .bind(note_id)
        .execute(&mut *tx)
        .await?;
        tx.commit().await
    }

    pub async fn mark_recording_recovery_valid(
        &self,
        session_id: &str,
    ) -> Result<(), sqlx::error::Error> {
        query(
            "UPDATE recording_sessions
             SET status = 'valid',
                 last_error = NULL,
                 ended_at = COALESCE(ended_at, ?)
             WHERE id = ?
               AND status = 'recoverable'",
        )
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
    ) -> Result<(), sqlx::error::Error> {
        query(
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
    ) -> Result<(), sqlx::error::Error> {
        query(
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
    ) -> Result<AudioArtifactDto, sqlx::error::Error> {
        let artifact = AudioArtifactDto {
            id: Uuid::new_v4().to_string(),
            source: source.to_string(),
            format: "wav".to_string(),
            duration_ms: 0,
            size_bytes: 0,
            checksum: String::new(),
            created_at: timestamp(),
        };
        query(
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
    ) -> Result<Vec<AudioArtifactDto>, sqlx::error::Error> {
        let rows = query(
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
    ) -> Result<Vec<SourceArtifactPath>, sqlx::error::Error> {
        let rows = query(
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
        path: &str,
        status: &str,
        duration_ms: i64,
        size_bytes: i64,
        checksum: &str,
        expected_duration_ms: i64,
        validation_summary: Option<String>,
        last_error: Option<String>,
    ) -> Result<(), sqlx::error::Error> {
        query(
            "UPDATE audio_artifacts
             SET path = ?, status = ?, duration_ms = ?, size_bytes = ?, checksum = ?, expected_duration_ms = ?,
                 validation_summary = ?, last_error = ?
             WHERE id = ?",
        )
        .bind(path)
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
    ) -> Result<AudioArtifactDto, sqlx::error::Error> {
        let artifact = AudioArtifactDto {
            id: Uuid::new_v4().to_string(),
            source: "microphone".to_string(),
            format: "wav".to_string(),
            duration_ms,
            size_bytes,
            checksum: checksum.to_string(),
            created_at: timestamp(),
        };
        query(
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
    ) -> Result<Option<(String, String)>, sqlx::error::Error> {
        let row = query(
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
    ) -> Result<Option<AudioArtifactDto>, sqlx::error::Error> {
        let row = query(
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
    ) -> Result<Vec<(String, String, String, String, bool)>, sqlx::error::Error> {
        let session = query(
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
        let rows = query(
            "SELECT id, source, path, recording_session_id, validation_summary
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
                    validation_summary_recorded_silence(
                        row.get::<Option<String>, _>("validation_summary")
                            .as_deref(),
                    ),
                )
            })
            .collect())
    }

    async fn latest_audio_sources(
        &self,
        note_id: &str,
    ) -> Result<Vec<AudioArtifactDto>, sqlx::error::Error> {
        let rows = query(
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

    async fn latest_transcript(
        &self,
        note_id: &str,
    ) -> Result<Option<TranscriptDto>, sqlx::error::Error> {
        let row = query(
            "SELECT t.id, t.text, t.source_mode, t.source, t.start_ms, t.end_ms, t.turn_index, t.language, t.status, t.last_error,
                    p.id AS persona_id, p.name AS persona_name, p.relationship AS persona_relationship,
                    p.created_at AS persona_created_at, p.updated_at AS persona_updated_at,
                    COALESCE(tpat.state, pha.state) AS attribution_state,
                    tpat.confidence AS attribution_confidence,
                    COALESCE(tpat.frozen_name, pha.frozen_name) AS attribution_frozen_name,
                    COALESCE(pc.id, pha.original_cluster_id) AS attribution_cluster_id,
                    COALESCE(pc.anonymous_label, pha.anonymous_label) AS attribution_speaker_label,
                    cp.id AS candidate_id, cp.name AS candidate_name,
                    cp.relationship AS candidate_relationship, cp.created_at AS candidate_created_at,
                    cp.updated_at AS candidate_updated_at
             FROM transcripts t
             LEFT JOIN transcript_persona_assignments tpa ON tpa.transcript_id = t.id
             LEFT JOIN personas p ON p.id = tpa.persona_id
             LEFT JOIN transcript_persona_attributions tpat ON tpat.transcript_id = t.id
             LEFT JOIN persona_clusters pc ON pc.id = tpat.persona_cluster_id
             LEFT JOIN persona_historical_attributions pha ON pha.transcript_id = t.id
             LEFT JOIN personas cp ON cp.id = tpat.candidate_persona_id
             WHERE t.note_id = ?
             ORDER BY t.created_at DESC
             LIMIT 1",
        )
        .bind(note_id)
        .fetch_optional(&self.pool)
        .await?;
        row.map(|row| {
            let persona = persona_from_row(&row)?;
            let attribution = attribution_from_row(&row, persona.clone())?;
            Ok(TranscriptDto {
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
                recorded_silence: false,
                persona,
                attribution,
            })
        })
        .transpose()
    }

    async fn source_transcripts(
        &self,
        note_id: &str,
    ) -> Result<Vec<TranscriptDto>, sqlx::error::Error> {
        let rows = query(
            "SELECT t.id, t.text, t.source_mode, t.source, t.start_ms, t.end_ms, t.turn_index, t.language, t.status, t.last_error,
                    p.id AS persona_id, p.name AS persona_name, p.relationship AS persona_relationship,
                    p.created_at AS persona_created_at, p.updated_at AS persona_updated_at,
                    COALESCE(tpat.state, pha.state) AS attribution_state,
                    tpat.confidence AS attribution_confidence,
                    COALESCE(tpat.frozen_name, pha.frozen_name) AS attribution_frozen_name,
                    COALESCE(pc.id, pha.original_cluster_id) AS attribution_cluster_id,
                    COALESCE(pc.anonymous_label, pha.anonymous_label) AS attribution_speaker_label,
                    cp.id AS candidate_id, cp.name AS candidate_name,
                    cp.relationship AS candidate_relationship, cp.created_at AS candidate_created_at,
                    cp.updated_at AS candidate_updated_at,
                    aa.validation_summary
             FROM transcripts t
             LEFT JOIN audio_artifacts aa ON aa.id = t.audio_artifact_id
             LEFT JOIN recording_sessions rs ON rs.id = t.recording_session_id
             LEFT JOIN transcript_persona_assignments tpa ON tpa.transcript_id = t.id
             LEFT JOIN personas p ON p.id = tpa.persona_id
             LEFT JOIN transcript_persona_attributions tpat ON tpat.transcript_id = t.id
             LEFT JOIN persona_clusters pc ON pc.id = tpat.persona_cluster_id
             LEFT JOIN persona_historical_attributions pha ON pha.transcript_id = t.id
             LEFT JOIN personas cp ON cp.id = tpat.candidate_persona_id
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
        rows.into_iter()
            .map(|row| {
                let persona = persona_from_row(&row)?;
                let attribution = attribution_from_row(&row, persona.clone())?;
                Ok(TranscriptDto {
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
                    recorded_silence: validation_summary_recorded_silence(
                        row.get::<Option<String>, _>("validation_summary")
                            .as_deref(),
                    ),
                    persona,
                    attribution,
                })
            })
            .collect::<Result<Vec<_>, sqlx::error::Error>>()
    }

    async fn transcript_coverage(
        &self,
        note_id: &str,
    ) -> Result<Option<TranscriptCoverageDto>, sqlx::error::Error> {
        let rows = query(
            "SELECT rc.details
             FROM recording_sessions rs
             INNER JOIN recording_checkpoints rc ON rc.recording_session_id = rs.id
             WHERE rs.note_id = ?
               AND rc.kind = 'transcript_coverage'
               AND NOT EXISTS (
                 SELECT 1
                 FROM recording_checkpoints newer
                 WHERE newer.recording_session_id = rc.recording_session_id
                   AND newer.kind = rc.kind
                   AND (
                     newer.created_at > rc.created_at
                     OR (newer.created_at = rc.created_at AND newer.rowid > rc.rowid)
                   )
               )",
        )
        .bind(note_id)
        .fetch_all(&self.pool)
        .await?;

        let mut detected_speech_ms = 0_i64;
        let mut transcribed_ms = 0_i64;
        let mut any_warning = false;
        let mut found = false;
        for row in rows {
            let Some(details) = row.get::<Option<String>, _>("details") else {
                continue;
            };
            let Ok(value) = serde_json::from_str::<serde_json::Value>(&details) else {
                continue;
            };
            found = true;
            let session_detected = value
                .get("totalDetectedSpeechMs")
                .and_then(serde_json::Value::as_i64)
                .unwrap_or_default()
                .max(0);
            let session_transcribed = value
                .get("totalTranscribedMs")
                .and_then(serde_json::Value::as_i64)
                .unwrap_or_default()
                .max(0);
            detected_speech_ms = detected_speech_ms.saturating_add(session_detected);
            transcribed_ms = transcribed_ms.saturating_add(session_transcribed);
            // Recompute each session's warning from its stored totals with
            // the CURRENT thresholds instead of trusting the serialized
            // `warning` bit, so tuning the constants applies retroactively
            // while per-session sensitivity is preserved.
            any_warning |= crate::domain::processing::transcript_coverage_warning(
                session_detected,
                session_transcribed,
            );
        }
        if !found {
            return Ok(None);
        }
        let warning = crate::domain::processing::transcript_coverage_warning(
            detected_speech_ms,
            transcribed_ms,
        ) || any_warning;
        Ok(Some(TranscriptCoverageDto {
            detected_speech_ms,
            transcribed_ms,
            warning,
        }))
    }

    pub async fn successful_source_turn_transcripts_for_session(
        &self,
        session_id: &str,
    ) -> Result<Vec<TranscriptDto>, sqlx::error::Error> {
        let rows = query(
            "SELECT t.id, t.text, t.source_mode, t.source, t.start_ms, t.end_ms, t.turn_index, t.language, t.status, t.last_error,
                    p.id AS persona_id, p.name AS persona_name, p.relationship AS persona_relationship,
                    p.created_at AS persona_created_at, p.updated_at AS persona_updated_at,
                    COALESCE(tpat.state, pha.state) AS attribution_state,
                    tpat.confidence AS attribution_confidence,
                    COALESCE(tpat.frozen_name, pha.frozen_name) AS attribution_frozen_name,
                    COALESCE(pc.id, pha.original_cluster_id) AS attribution_cluster_id,
                    COALESCE(pc.anonymous_label, pha.anonymous_label) AS attribution_speaker_label,
                    cp.id AS candidate_id, cp.name AS candidate_name,
                    cp.relationship AS candidate_relationship, cp.created_at AS candidate_created_at,
                    cp.updated_at AS candidate_updated_at
             FROM transcripts t
             LEFT JOIN transcript_persona_assignments tpa ON tpa.transcript_id = t.id
             LEFT JOIN personas p ON p.id = tpa.persona_id
             LEFT JOIN transcript_persona_attributions tpat ON tpat.transcript_id = t.id
             LEFT JOIN persona_clusters pc ON pc.id = tpat.persona_cluster_id
             LEFT JOIN persona_historical_attributions pha ON pha.transcript_id = t.id
             LEFT JOIN personas cp ON cp.id = tpat.candidate_persona_id
             WHERE t.recording_session_id = ?
               AND t.turn_index IS NOT NULL
               AND t.status = 'succeeded'
               AND TRIM(t.text) != ''
             ORDER BY COALESCE(t.turn_index, 999999), COALESCE(t.start_ms, 999999999), t.created_at ASC",
        )
        .bind(session_id)
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter()
            .map(|row| {
                let persona = persona_from_row(&row)?;
                let attribution = attribution_from_row(&row, persona.clone())?;
                Ok(TranscriptDto {
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
                    recorded_silence: false,
                    persona,
                    attribution,
                })
            })
            .collect::<Result<Vec<_>, sqlx::error::Error>>()
    }

    pub async fn create_transcript(
        &self,
        note_id: &str,
        audio_artifact_id: &str,
        text: &str,
        language: Option<String>,
        provider: &str,
    ) -> Result<TranscriptDto, sqlx::error::Error> {
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
            recorded_silence: false,
            persona: None,
            attribution: None,
        };
        let now = timestamp();
        query(
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
    ) -> Result<TranscriptDto, sqlx::error::Error> {
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
            recorded_silence: false,
            persona: None,
            attribution: None,
        };
        let now = timestamp();
        query(
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
    ) -> Result<TranscriptDto, sqlx::error::Error> {
        let now = timestamp();
        let row = query(
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
            recorded_silence: false,
            persona: None,
            attribution: None,
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
    ) -> Result<TranscriptDto, sqlx::error::Error> {
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
            recorded_silence: false,
            persona: None,
            attribution: None,
        };
        let now = timestamp();
        query(
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
    ) -> Result<TranscriptDto, sqlx::error::Error> {
        let now = timestamp();
        let row = query(
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
            recorded_silence: false,
            persona: None,
            attribution: None,
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
    ) -> Result<String, sqlx::error::Error> {
        let now = timestamp();
        let id = Uuid::new_v4().to_string();
        query(
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
    ) -> Result<Option<RecordingRecoveryInfo>, sqlx::error::Error> {
        let row = query(
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
    ) -> Result<NoteDto, sqlx::error::Error> {
        query("UPDATE recording_sessions SET status = 'failed', last_error = 'Discarded by user' WHERE id = ?")
            .bind(session_id)
            .execute(&self.pool)
            .await?;
        query(
            "UPDATE audio_artifacts
             SET status = 'discarded', last_error = 'Discarded by user'
             WHERE recording_session_id = ?",
        )
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

    async fn note_participants(
        &self,
        note_id: &str,
    ) -> Result<Vec<ParticipantDto>, sqlx::error::Error> {
        let rows = query(
            "SELECT p.id, p.name, p.relationship, p.created_at, p.updated_at,
                    np.provenance, np.first_confirmed_at
             FROM note_participants np
             INNER JOIN personas p ON p.id = np.persona_id
             WHERE np.note_id = ?
             ORDER BY np.first_confirmed_at ASC, p.name COLLATE NOCASE ASC",
        )
        .bind(note_id)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows
            .into_iter()
            .map(|row| ParticipantDto {
                persona: PersonaDto {
                    id: row.get("id"),
                    name: row.get("name"),
                    relationship: row.get("relationship"),
                    created_at: row.get("created_at"),
                    updated_at: row.get("updated_at"),
                },
                provenance: row.get("provenance"),
                first_confirmed_at: row.get("first_confirmed_at"),
            })
            .collect())
    }

    async fn folder_ids(&self, note_id: &str) -> Result<Vec<String>, sqlx::error::Error> {
        let rows = query(
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

async fn upsert_note_participant(
    tx: &mut sqlx::transaction::Transaction<'_, sqlx_sqlite::Sqlite>,
    note_id: &str,
    persona_id: &str,
    provenance: &str,
    now: &str,
) -> Result<(), sqlx::error::Error> {
    query(
        "INSERT INTO note_participants
         (note_id, persona_id, provenance, first_confirmed_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(note_id, persona_id) DO UPDATE SET
           provenance = excluded.provenance,
           updated_at = excluded.updated_at",
    )
    .bind(note_id)
    .bind(persona_id)
    .bind(provenance)
    .bind(now)
    .bind(now)
    .bind(now)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

async fn enqueue_dossier_jobs_for_generation_tx(
    tx: &mut sqlx::transaction::Transaction<'_, sqlx_sqlite::Sqlite>,
    generation_result_id: &str,
) -> Result<u64, sqlx::error::Error> {
    let rows = query(
        "SELECT DISTINCT tpa.persona_id, anchor.recording_session_id
         FROM generation_results gr
         INNER JOIN transcripts anchor ON anchor.id = gr.transcript_id
         INNER JOIN transcripts t
           ON t.note_id = gr.note_id
          AND t.recording_session_id = anchor.recording_session_id
         INNER JOIN transcript_persona_assignments tpa ON tpa.transcript_id = t.id
         LEFT JOIN transcript_persona_attributions tpat ON tpat.transcript_id = t.id
         INNER JOIN personas p ON p.id = tpa.persona_id
         WHERE gr.id = ?
           AND gr.created_at >= (
             SELECT enabled_at FROM persona_feature_state WHERE feature = 'persona_memory'
           )
           AND t.status = 'succeeded'
           AND (tpat.state IS NULL OR tpat.state IN ('tagged', 'confirmed', 'automatic'))
           AND p.archived_at IS NULL
           AND p.is_self = 0",
    )
    .bind(generation_result_id)
    .fetch_all(&mut **tx)
    .await?;
    let now = timestamp();
    let mut inserted = 0;
    for row in rows {
        let persona_id: String = row.get("persona_id");
        let recording_session_id: String = row.get("recording_session_id");
        let idempotency_key = format!("persona-dossier:v1:{recording_session_id}:{persona_id}");
        let result = query(
            "INSERT INTO persona_dossier_jobs
             (id, generation_result_id, persona_id, idempotency_key, status,
              attempt_count, created_at, updated_at)
             VALUES (?, ?, ?, ?, 'pending', 0, ?, ?)
             ON CONFLICT DO NOTHING",
        )
        .bind(Uuid::new_v4().to_string())
        .bind(generation_result_id)
        .bind(&persona_id)
        .bind(idempotency_key)
        .bind(&now)
        .bind(&now)
        .execute(&mut **tx)
        .await?;
        inserted += result.rows_affected();
    }
    Ok(inserted)
}

async fn insert_cluster_voiceprint(
    tx: &mut sqlx::transaction::Transaction<'_, sqlx_sqlite::Sqlite>,
    persona_id: &str,
    cluster_id: &str,
    kind: &str,
    now: &str,
) -> Result<(), sqlx::error::Error> {
    query(
        "INSERT INTO persona_voiceprints
         (id, persona_id, source, model_id, embedding, kind,
          recording_session_id, persona_cluster_id, created_at)
         SELECT ?, ?, source, model_id, embedding, ?, recording_session_id, id, ?
         FROM persona_clusters WHERE id = ?
         ON CONFLICT(persona_id, persona_cluster_id, kind) DO NOTHING",
    )
    .bind(Uuid::new_v4().to_string())
    .bind(persona_id)
    .bind(kind)
    .bind(now)
    .bind(cluster_id)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

async fn assign_cluster_transcripts(
    tx: &mut sqlx::transaction::Transaction<'_, sqlx_sqlite::Sqlite>,
    cluster_id: &str,
    persona_id: &str,
    now: &str,
) -> Result<(), sqlx::error::Error> {
    query(
        "INSERT INTO transcript_persona_assignments
         (transcript_id, persona_id, created_at, updated_at)
         SELECT transcript_id, ?, ?, ?
         FROM transcript_persona_attributions
         WHERE persona_cluster_id = ?
         ON CONFLICT(transcript_id) DO UPDATE SET
           persona_id = excluded.persona_id,
           updated_at = excluded.updated_at",
    )
    .bind(persona_id)
    .bind(now)
    .bind(now)
    .bind(cluster_id)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

async fn delete_note_participant_if_unused(
    tx: &mut sqlx::transaction::Transaction<'_, sqlx_sqlite::Sqlite>,
    note_id: &str,
    persona_id: &str,
) -> Result<(), sqlx::error::Error> {
    query(
        "DELETE FROM note_participants
         WHERE note_id = ? AND persona_id = ?
           AND NOT EXISTS (
             SELECT 1 FROM transcripts t
             INNER JOIN transcript_persona_assignments tpa ON tpa.transcript_id = t.id
             WHERE t.note_id = ? AND tpa.persona_id = ?
           )",
    )
    .bind(note_id)
    .bind(persona_id)
    .bind(note_id)
    .bind(persona_id)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

async fn delete_note_records(
    tx: &mut sqlx::transaction::Transaction<'_, sqlx_sqlite::Sqlite>,
    note_id: &str,
) -> Result<(), sqlx::error::Error> {
    query("DELETE FROM note_generation_blocks WHERE note_id = ?")
        .bind(note_id)
        .execute(&mut **tx)
        .await?;
    query("DELETE FROM generation_results WHERE note_id = ?")
        .bind(note_id)
        .execute(&mut **tx)
        .await?;
    query("DELETE FROM transcripts WHERE note_id = ?")
        .bind(note_id)
        .execute(&mut **tx)
        .await?;
    query("DELETE FROM audio_artifacts WHERE note_id = ?")
        .bind(note_id)
        .execute(&mut **tx)
        .await?;
    query(
        "DELETE FROM recording_checkpoints
         WHERE recording_session_id IN (SELECT id FROM recording_sessions WHERE note_id = ?)",
    )
    .bind(note_id)
    .execute(&mut **tx)
    .await?;
    query("DELETE FROM recording_sessions WHERE note_id = ?")
        .bind(note_id)
        .execute(&mut **tx)
        .await?;
    query("DELETE FROM note_folders WHERE note_id = ?")
        .bind(note_id)
        .execute(&mut **tx)
        .await?;
    query("DELETE FROM notes WHERE id = ?")
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
    let heading_title = title_from_generated_headings(content);
    if heading_title.is_some() {
        return heading_title;
    }

    content
        .lines()
        .map(clean_generated_title_line)
        .find(|line| !line.is_empty() && !is_replaceable_generated_title(line))
        .map(|line| truncate_title(&line, 72))
}

fn title_from_generated_headings(content: &str) -> Option<String> {
    let mut headings = Vec::new();
    for heading in content.lines().filter_map(markdown_heading_text) {
        let heading = clean_generated_title_line(heading);
        if heading.is_empty()
            || is_replaceable_generated_title(&heading)
            || headings
                .iter()
                .any(|existing: &String| existing.eq_ignore_ascii_case(&heading))
        {
            continue;
        }
        headings.push(heading);
    }

    title_from_parts(&headings)
}

fn title_from_parts(parts: &[String]) -> Option<String> {
    match parts {
        [] => None,
        [only] => Some(truncate_title(only, 72)),
        [first, second] => Some(truncate_title(&format!("{first} and {second}"), 72)),
        _ => {
            let last = parts.last()?;
            let prefix = parts[..parts.len() - 1].join(", ");
            Some(truncate_title(&format!("{prefix}, and {last}"), 72))
        }
    }
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

fn folder_from_row(row: sqlx_sqlite::SqliteRow) -> FolderDto {
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

fn persona_from_row(row: &SqliteRow) -> Result<Option<PersonaDto>, sqlx::error::Error> {
    let Some(id) = row.try_get::<Option<String>, _>("persona_id")? else {
        return Ok(None);
    };
    Ok(Some(PersonaDto {
        id,
        name: row.try_get("persona_name")?,
        relationship: row.try_get("persona_relationship")?,
        created_at: row.try_get("persona_created_at")?,
        updated_at: row.try_get("persona_updated_at")?,
    }))
}

fn persona_summary_from_row(row: &SqliteRow) -> PersonaSummaryDto {
    PersonaSummaryDto {
        id: row.get("id"),
        name: row.get("name"),
        relationship: row.get("relationship"),
        is_self: row.get::<i64, _>("is_self") != 0,
        archived_at: row.get("archived_at"),
        voiceprint_count: row.get("voiceprint_count"),
        last_seen_at: row.get("last_seen_at"),
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
    }
}

fn persona_commitment_from_row(row: &SqliteRow) -> PersonaCommitmentDto {
    PersonaCommitmentDto {
        id: row.get("id"),
        persona_id: row.get("persona_id"),
        direction: PersonaCommitmentDirection::from_db(row.get::<String, _>("direction").as_str()),
        text: row.get("text"),
        due_value: row.get("due_value"),
        status: row.get("status"),
        source_note_id: row.get("source_note_id"),
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
    }
}

fn persona_dossier_job_dto_from_row(row: &SqliteRow) -> PersonaDossierJobDto {
    PersonaDossierJobDto {
        id: row.get("id"),
        generation_result_id: row.get("generation_result_id"),
        persona_id: row.get("persona_id"),
        idempotency_key: row.get("idempotency_key"),
        status: row.get("status"),
        attempt_count: row.get("attempt_count"),
        last_error: row.get("last_error"),
        lease_expires_at: row.get("lease_expires_at"),
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
        completed_at: row.get("completed_at"),
    }
}

fn validate_commitment_text(value: &str) -> Result<&str, AppError> {
    let value = value.trim();
    if value.is_empty() {
        return Err(AppError::new(
            "persona_commitment_text_required",
            "Enter what was committed.",
        ));
    }
    Ok(value)
}

fn normalize_optional(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|value| !value.is_empty())
}

fn candidate_persona_from_row(row: &SqliteRow) -> Result<Option<PersonaDto>, sqlx::error::Error> {
    let Some(id) = row.try_get::<Option<String>, _>("candidate_id")? else {
        return Ok(None);
    };
    Ok(Some(PersonaDto {
        id,
        name: row.try_get("candidate_name")?,
        relationship: row.try_get("candidate_relationship")?,
        created_at: row.try_get("candidate_created_at")?,
        updated_at: row.try_get("candidate_updated_at")?,
    }))
}

fn attribution_from_row(
    row: &SqliteRow,
    persona: Option<PersonaDto>,
) -> Result<Option<PersonaAttributionDto>, sqlx::error::Error> {
    let Some(cluster_id) = row.try_get::<Option<String>, _>("attribution_cluster_id")? else {
        return Ok(None);
    };
    let frozen_name = row.try_get::<Option<String>, _>("attribution_frozen_name")?;
    let speaker_label = frozen_name
        .or(row.try_get::<Option<String>, _>("attribution_speaker_label")?)
        .unwrap_or_else(|| "Speaker".to_string());
    Ok(Some(PersonaAttributionDto {
        cluster_id,
        speaker_label,
        state: row
            .try_get::<Option<String>, _>("attribution_state")?
            .unwrap_or_else(|| "anonymous".to_string()),
        persona,
        candidate: candidate_persona_from_row(row)?,
        confidence: row.try_get("attribution_confidence")?,
    }))
}

fn dictionary_entry_from_row(row: sqlx_sqlite::SqliteRow) -> DictionaryEntryDto {
    DictionaryEntryDto {
        id: row.get("id"),
        phrase: row.get("phrase"),
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
    }
}

fn dictation_history_item_from_row(row: sqlx_sqlite::SqliteRow) -> DictationHistoryItemDto {
    DictationHistoryItemDto {
        id: row.get("id"),
        text: row.get("text"),
        language: row.get("language"),
        provider: row.get("provider"),
        created_at: row.get("created_at"),
    }
}

fn agent_task_from_row(row: sqlx_sqlite::SqliteRow) -> AgentTaskDto {
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

fn agent_message_from_row(row: sqlx_sqlite::SqliteRow) -> AgentMessageDto {
    AgentMessageDto {
        id: row.get("id"),
        task_id: row.get("task_id"),
        role: AgentMessageRole::from(row.get::<String, _>("role").as_str()),
        content: row.get("content"),
        created_at: row.get("created_at"),
    }
}

fn agent_tool_event_from_row(row: sqlx_sqlite::SqliteRow) -> AgentToolEventDto {
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

fn validation_summary_recorded_silence(summary: Option<&str>) -> bool {
    summary
        .and_then(|summary| serde_json::from_str::<AudioValidationDto>(summary).ok())
        .map(|validation| validation.recorded_silence)
        .unwrap_or(false)
}
