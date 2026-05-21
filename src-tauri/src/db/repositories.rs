use crate::domain::types::{
    AudioArtifactDto, FolderDto, ListNotesResponse, NoteDto, NoteListItemDto, ProcessingStatus,
    RecordingSourceMode, TranscriptDto,
};
use chrono::{SecondsFormat, Utc};
use sqlx::{Row, SqlitePool};
use uuid::Uuid;

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
            "SELECT id, name, created_at, updated_at FROM folders WHERE deleted_at IS NULL ORDER BY lower(name) ASC",
        )
        .fetch_all(&self.pool)
        .await?;

        Ok(rows
            .into_iter()
            .map(|row| FolderDto {
                id: row.get("id"),
                name: row.get("name"),
                created_at: row.get("created_at"),
                updated_at: row.get("updated_at"),
            })
            .collect())
    }

    pub async fn create_folder(&self, name: impl AsRef<str>) -> Result<FolderDto, sqlx::Error> {
        let now = timestamp();
        let folder = FolderDto {
            id: Uuid::new_v4().to_string(),
            name: name.as_ref().trim().to_string(),
            created_at: now.clone(),
            updated_at: now,
        };

        sqlx::query("INSERT INTO folders (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)")
            .bind(&folder.id)
            .bind(&folder.name)
            .bind(&folder.created_at)
            .bind(&folder.updated_at)
            .execute(&self.pool)
            .await?;

        Ok(folder)
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

    pub async fn delete_note(&self, note_id: &str) -> Result<(), sqlx::Error> {
        let mut tx = self.pool.begin().await?;
        delete_note_records(&mut tx, note_id).await?;
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
        sqlx::query("UPDATE folders SET deleted_at = ?, updated_at = ? WHERE id = ?")
            .bind(&now)
            .bind(&now)
            .bind(folder_id)
            .execute(&mut *tx)
            .await?;

        tx.commit().await
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
        let current = self.get_note(note_id).await?;
        let title = if current.title.trim().is_empty() {
            title.unwrap_or_else(|| "New note".to_string())
        } else {
            current.title.clone()
        };
        let appending_to_existing = current.generated_content.as_deref().is_some_and(has_text)
            || current.edited_content.as_deref().is_some_and(has_text);
        let content = normalize_generated_addition(&title, &content, appending_to_existing);
        let next_generated_content =
            append_note_content(current.generated_content, content.clone());
        let next_edited_content = current
            .edited_content
            .map(|edited_content| append_note_content(Some(edited_content), content));
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
    ) -> Result<Vec<(String, String, String)>, sqlx::Error> {
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
            "SELECT id, source, path
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
            .map(|row| (row.get("id"), row.get("source"), row.get("path")))
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
            "SELECT id, text, source_mode, source, start_ms, end_ms, turn_index, language, status, last_error
             FROM transcripts
             WHERE note_id = ?
               AND recording_session_id IS NOT NULL
               AND turn_index IS NOT NULL
             ORDER BY COALESCE(turn_index, 999999), COALESCE(start_ms, 999999999), created_at ASC",
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

    pub async fn create_generation_result(
        &self,
        note_id: &str,
        transcript_id: &str,
        content: &str,
        title_suggestion: Option<String>,
        provider: &str,
        prompt_version: &str,
    ) -> Result<(), sqlx::Error> {
        let now = timestamp();
        sqlx::query(
            "INSERT INTO generation_results (id, note_id, transcript_id, content, title_suggestion, provider, prompt_version, status, retry_count, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'succeeded', 0, ?, ?)",
        )
        .bind(Uuid::new_v4().to_string())
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
        Ok(())
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

fn normalize_generated_addition(title: &str, content: &str, appending_to_existing: bool) -> String {
    let content = content.trim();
    if !appending_to_existing {
        return content.to_string();
    }
    let Some((heading, rest)) = content.split_once('\n') else {
        return content.to_string();
    };
    let Some(heading_text) = heading.strip_prefix("# ") else {
        return content.to_string();
    };
    if is_duplicate_generated_heading(title, heading_text) {
        rest.trim_start().to_string()
    } else {
        content.to_string()
    }
}

fn is_duplicate_generated_heading(title: &str, heading: &str) -> bool {
    let heading = heading.trim();
    let title = title.trim();
    heading.eq_ignore_ascii_case("New note")
        || heading.eq_ignore_ascii_case("Generated note")
        || (!title.is_empty() && heading.eq_ignore_ascii_case(title))
}

fn has_text(value: &str) -> bool {
    !value.trim().is_empty()
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

fn preview_for(title: &str, content: &str) -> String {
    let source = if content.trim().is_empty() {
        title
    } else {
        content
    };
    source.chars().take(140).collect()
}
