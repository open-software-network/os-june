use super::types::{
    FocusIntervalDto, FocusIntervalInput, FocusIntervalKind, FocusOutcome, FocusSegmentDto,
    FocusSegmentKind, FocusSessionDto, FocusStatus, ListFocusHistoryRequest, StartFocusRequest,
};
use crate::{db::repositories::Repositories, domain::types::AppError};
use chrono::{DateTime, Duration, SecondsFormat, Utc};
use sqlx::query::query;
use sqlx::row::Row;
use sqlx::transaction::Transaction;
use sqlx_sqlite::Sqlite;
use uuid::Uuid;

pub const DEFAULT_FOCUS_MINUTES: u32 = 25;
pub const MAX_FOCUS_INTENTION_CHARS: usize = 500;
pub const MAX_FOCUS_SHORTCUT_NAME_CHARS: usize = 500;
pub const MAX_FOCUS_REFLECTION_CHARS: usize = 2_000;
pub const MAX_FOCUS_INTERVALS: u32 = 12;
pub const MAX_FOCUS_MINUTES: u32 = 720;
pub const MAX_BREAK_MINUTES: u32 = 120;
const MAX_PLAN_MINUTES: u32 = 1_440;
const DEFAULT_BREAK_MINUTES: u32 = 5;
const DEFAULT_LONG_BREAK_MINUTES: u32 = 15;
const ACTIVE_STATUSES_SQL: &str = "'planned', 'focusing', 'paused', 'overtime', 'on_break'";

#[derive(Debug, Clone)]
struct ValidatedInterval {
    position: u32,
    kind: FocusIntervalKind,
    planned_duration_ms: i64,
    project_id: Option<String>,
    project_name: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FocusTransition {
    EnteredOvertime,
    BreakCompleted,
}

impl Repositories {
    pub async fn start_focus(
        &self,
        request: StartFocusRequest,
    ) -> Result<FocusSessionDto, AppError> {
        self.start_focus_at(request, Utc::now()).await
    }

    pub(crate) async fn start_focus_at(
        &self,
        request: StartFocusRequest,
        now: DateTime<Utc>,
    ) -> Result<FocusSessionDto, AppError> {
        if let Some(active) = self.active_focus_session_at(now).await? {
            return Err(active_focus_error(active));
        }
        let intention = validate_intention(request.intention.as_deref())?;
        let start_shortcut_name =
            validate_start_shortcut_name(request.start_shortcut_name.as_deref())?;
        let plan = self.validate_plan(&request).await?;
        let session_id = Uuid::new_v4().to_string();
        let now_text = format_time(now);
        let mut tx = self.pool.begin().await?;

        if let Err(error) = insert_focus_session(
            &mut tx,
            &session_id,
            &intention,
            start_shortcut_name.as_deref(),
            FocusStatus::Planned,
            &now_text,
        )
        .await
        {
            drop(tx);
            return self.map_start_error(error, now).await;
        }
        insert_intervals(&mut tx, &session_id, &plan).await?;

        let first = plan.first().ok_or_else(|| {
            AppError::new(
                "focus_invalid_plan",
                "A focus plan needs at least one interval.",
            )
        })?;
        query(
            "UPDATE focus_sessions
             SET status = 'focusing', started_at = ?, current_interval_position = ?
             WHERE id = ? AND status = 'planned'",
        )
        .bind(&now_text)
        .bind(i64::from(first.position))
        .bind(&session_id)
        .execute(&mut *tx)
        .await?;
        insert_segment(
            &mut tx,
            &session_id,
            first.position,
            FocusSegmentKind::Focus,
            now,
            first.project_id.as_deref(),
            first.project_name.as_deref(),
        )
        .await?;
        tx.commit().await?;
        self.load_focus_session_at(&session_id, now).await
    }

    pub async fn create_focus_plan(
        &self,
        request: StartFocusRequest,
    ) -> Result<FocusSessionDto, AppError> {
        self.create_focus_plan_at(request, Utc::now()).await
    }

    pub(crate) async fn create_focus_plan_at(
        &self,
        request: StartFocusRequest,
        now: DateTime<Utc>,
    ) -> Result<FocusSessionDto, AppError> {
        if let Some(active) = self.active_focus_session_at(now).await? {
            return Err(active_focus_error(active));
        }
        let intention = validate_intention(request.intention.as_deref())?;
        let start_shortcut_name =
            validate_start_shortcut_name(request.start_shortcut_name.as_deref())?;
        let plan = self.validate_plan(&request).await?;
        let session_id = Uuid::new_v4().to_string();
        let now_text = format_time(now);
        let mut tx = self.pool.begin().await?;
        if let Err(error) = insert_focus_session(
            &mut tx,
            &session_id,
            &intention,
            start_shortcut_name.as_deref(),
            FocusStatus::Planned,
            &now_text,
        )
        .await
        {
            drop(tx);
            return self.map_start_error(error, now).await;
        }
        insert_intervals(&mut tx, &session_id, &plan).await?;
        tx.commit().await?;
        self.load_focus_session_at(&session_id, now).await
    }

    pub async fn start_focus_plan(&self, session_id: &str) -> Result<FocusSessionDto, AppError> {
        self.start_focus_plan_at(session_id, Utc::now()).await
    }

    pub(crate) async fn start_focus_plan_at(
        &self,
        session_id: &str,
        now: DateTime<Utc>,
    ) -> Result<FocusSessionDto, AppError> {
        let mut tx = self.pool.begin().await?;
        let row = query("SELECT status FROM focus_sessions WHERE id = ?")
            .bind(session_id)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or_else(|| AppError::new("focus_not_found", "Focus session was not found."))?;
        if row.get::<String, _>("status") != FocusStatus::Planned.as_db() {
            return Err(AppError::new(
                "focus_invalid_transition",
                "Only a planned focus session can be started.",
            ));
        }
        let first = query(
            "SELECT position, kind, project_id, project_name
             FROM focus_intervals WHERE session_id = ? ORDER BY position ASC LIMIT 1",
        )
        .bind(session_id)
        .fetch_one(&mut *tx)
        .await?;
        if first.get::<String, _>("kind") != FocusIntervalKind::Focus.as_db() {
            return Err(AppError::new(
                "focus_invalid_plan",
                "A focus plan must begin with a focus interval.",
            ));
        }
        let position = u32_from_i64(first.get::<i64, _>("position"))?;
        let project_id = first.try_get::<Option<String>, _>("project_id")?;
        let project_name = first.try_get::<Option<String>, _>("project_name")?;
        let now_text = format_time(now);
        query(
            "UPDATE focus_sessions
             SET status = 'focusing', started_at = ?, current_interval_position = ?
             WHERE id = ?",
        )
        .bind(&now_text)
        .bind(i64::from(position))
        .bind(session_id)
        .execute(&mut *tx)
        .await?;
        insert_segment(
            &mut tx,
            session_id,
            position,
            FocusSegmentKind::Focus,
            now,
            project_id.as_deref(),
            project_name.as_deref(),
        )
        .await?;
        tx.commit().await?;
        self.load_focus_session_at(session_id, now).await
    }

    pub async fn get_active_focus(&self) -> Result<Option<FocusSessionDto>, AppError> {
        self.get_active_focus_at(Utc::now()).await
    }

    pub(crate) async fn get_active_focus_at(
        &self,
        now: DateTime<Utc>,
    ) -> Result<Option<FocusSessionDto>, AppError> {
        self.reconcile_active_focus_at(now).await?;
        self.active_focus_session_at(now).await
    }

    pub async fn pause_focus(
        &self,
        requested_session_id: Option<&str>,
    ) -> Result<FocusSessionDto, AppError> {
        self.pause_focus_at(requested_session_id, Utc::now()).await
    }

    pub(crate) async fn pause_focus_at(
        &self,
        requested_session_id: Option<&str>,
        now: DateTime<Utc>,
    ) -> Result<FocusSessionDto, AppError> {
        self.reconcile_active_focus_at(now).await?;
        let (session_id, status, position) =
            self.resolve_active_request(requested_session_id).await?;
        if !matches!(status, FocusStatus::Focusing | FocusStatus::Overtime) {
            return Err(invalid_transition(
                "Focus can only be paused while focusing or in overtime.",
            ));
        }
        let mut tx = self.pool.begin().await?;
        close_open_segment(&mut tx, &session_id, now).await?;
        insert_segment(
            &mut tx,
            &session_id,
            position,
            FocusSegmentKind::Pause,
            now,
            None,
            None,
        )
        .await?;
        query("UPDATE focus_sessions SET status = 'paused', paused_from = ? WHERE id = ?")
            .bind(status.as_db())
            .bind(&session_id)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        self.load_focus_session_at(&session_id, now).await
    }

    pub async fn resume_focus(
        &self,
        requested_session_id: Option<&str>,
    ) -> Result<FocusSessionDto, AppError> {
        self.resume_focus_at(requested_session_id, Utc::now()).await
    }

    pub(crate) async fn resume_focus_at(
        &self,
        requested_session_id: Option<&str>,
        now: DateTime<Utc>,
    ) -> Result<FocusSessionDto, AppError> {
        self.reconcile_active_focus_at(now).await?;
        let (session_id, status, position) =
            self.resolve_active_request(requested_session_id).await?;
        let mut tx = self.pool.begin().await?;
        let (target_status, target_position, segment_kind) = match status {
            FocusStatus::Paused => {
                let row = query("SELECT paused_from FROM focus_sessions WHERE id = ?")
                    .bind(&session_id)
                    .fetch_one(&mut *tx)
                    .await?;
                let paused_from = row
                    .try_get::<Option<String>, _>("paused_from")?
                    .and_then(|value| FocusStatus::from_db(&value))
                    .ok_or_else(|| {
                        AppError::new(
                            "focus_state_corrupt",
                            "Paused focus session has no resumable phase.",
                        )
                    })?;
                let kind = match paused_from {
                    FocusStatus::Focusing => FocusSegmentKind::Focus,
                    FocusStatus::Overtime => FocusSegmentKind::Overtime,
                    _ => return Err(invalid_transition("This focus phase cannot be resumed.")),
                };
                (paused_from, position, kind)
            }
            FocusStatus::OnBreak => {
                let next = interval_after(&mut tx, &session_id, position).await?;
                if next.kind != FocusIntervalKind::Focus {
                    return Err(AppError::new(
                        "focus_state_corrupt",
                        "A break is not followed by a focus interval.",
                    ));
                }
                (
                    FocusStatus::Focusing,
                    next.position,
                    FocusSegmentKind::Focus,
                )
            }
            _ => {
                return Err(invalid_transition(
                    "Focus can only resume from a pause or a break.",
                ))
            }
        };
        close_open_segment(&mut tx, &session_id, now).await?;
        let project = interval_project(&mut tx, &session_id, target_position).await?;
        insert_segment(
            &mut tx,
            &session_id,
            target_position,
            segment_kind,
            now,
            project.0.as_deref(),
            project.1.as_deref(),
        )
        .await?;
        query(
            "UPDATE focus_sessions
             SET status = ?, paused_from = NULL, current_interval_position = ? WHERE id = ?",
        )
        .bind(target_status.as_db())
        .bind(i64::from(target_position))
        .bind(&session_id)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        self.load_focus_session_at(&session_id, now).await
    }

    pub async fn start_focus_break(
        &self,
        requested_session_id: Option<&str>,
    ) -> Result<FocusSessionDto, AppError> {
        self.start_focus_break_at(requested_session_id, Utc::now())
            .await
    }

    pub(crate) async fn start_focus_break_at(
        &self,
        requested_session_id: Option<&str>,
        now: DateTime<Utc>,
    ) -> Result<FocusSessionDto, AppError> {
        self.reconcile_active_focus_at(now).await?;
        let (session_id, status, position) =
            self.resolve_active_request(requested_session_id).await?;
        if !matches!(status, FocusStatus::Focusing | FocusStatus::Overtime) {
            return Err(invalid_transition(
                "A break can only start while focusing or in overtime.",
            ));
        }
        let mut tx = self.pool.begin().await?;
        let next = interval_after(&mut tx, &session_id, position)
            .await
            .map_err(|error| {
                if error.code == "focus_no_next_interval" {
                    AppError::new(
                        "focus_no_break_planned",
                        "No break is planned after the current focus interval. Finish the session instead.",
                    )
                } else {
                    error
                }
            })?;
        if next.kind != FocusIntervalKind::Break {
            return Err(AppError::new(
                "focus_no_break_planned",
                "No break is planned after the current focus interval. Finish the session instead.",
            ));
        }
        close_open_segment(&mut tx, &session_id, now).await?;
        insert_segment(
            &mut tx,
            &session_id,
            next.position,
            FocusSegmentKind::Break,
            now,
            None,
            None,
        )
        .await?;
        query(
            "UPDATE focus_sessions
             SET status = 'on_break', paused_from = NULL, current_interval_position = ?
             WHERE id = ?",
        )
        .bind(i64::from(next.position))
        .bind(&session_id)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        self.load_focus_session_at(&session_id, now).await
    }

    pub async fn finish_focus(
        &self,
        requested_session_id: Option<&str>,
    ) -> Result<FocusSessionDto, AppError> {
        self.finish_focus_at(requested_session_id, Utc::now()).await
    }

    pub(crate) async fn finish_focus_at(
        &self,
        requested_session_id: Option<&str>,
        now: DateTime<Utc>,
    ) -> Result<FocusSessionDto, AppError> {
        self.complete_focus_at(requested_session_id, now, FocusStatus::Completed)
            .await
    }

    pub async fn abandon_focus(
        &self,
        requested_session_id: Option<&str>,
    ) -> Result<FocusSessionDto, AppError> {
        self.abandon_focus_at(requested_session_id, Utc::now())
            .await
    }

    pub(crate) async fn abandon_focus_at(
        &self,
        requested_session_id: Option<&str>,
        now: DateTime<Utc>,
    ) -> Result<FocusSessionDto, AppError> {
        self.complete_focus_at(requested_session_id, now, FocusStatus::Abandoned)
            .await
    }

    async fn complete_focus_at(
        &self,
        requested_session_id: Option<&str>,
        now: DateTime<Utc>,
        terminal_status: FocusStatus,
    ) -> Result<FocusSessionDto, AppError> {
        self.reconcile_active_focus_at(now).await?;
        let (session_id, status, _) = self.resolve_active_request(requested_session_id).await?;
        if !status.is_active() {
            return Err(invalid_transition("This focus session has already ended."));
        }
        let now_text = format_time(now);
        let mut tx = self.pool.begin().await?;
        close_open_segment_if_present(&mut tx, &session_id, now).await?;
        let (completed_at, abandoned_at) = match terminal_status {
            FocusStatus::Completed => (Some(&now_text), None),
            FocusStatus::Abandoned => (None, Some(&now_text)),
            _ => unreachable!("terminal focus state"),
        };
        query(
            "UPDATE focus_sessions
             SET status = ?, paused_from = NULL, completed_at = ?, abandoned_at = ?
             WHERE id = ?",
        )
        .bind(terminal_status.as_db())
        .bind(completed_at)
        .bind(abandoned_at)
        .bind(&session_id)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        self.load_focus_session_at(&session_id, now).await
    }

    pub async fn update_focus_completion(
        &self,
        session_id: &str,
        reflection: Option<&str>,
        quality: Option<u8>,
    ) -> Result<FocusSessionDto, AppError> {
        if quality.is_some_and(|value| !(1..=5).contains(&value)) {
            return Err(AppError::new(
                "focus_invalid_quality",
                "Focus quality must be between 1 and 5.",
            ));
        }
        let reflection =
            normalize_optional_text(reflection, MAX_FOCUS_REFLECTION_CHARS, "reflection")?;
        let status = query("SELECT status FROM focus_sessions WHERE id = ?")
            .bind(session_id)
            .fetch_optional(&self.pool)
            .await?
            .ok_or_else(|| AppError::new("focus_not_found", "Focus session was not found."))?
            .get::<String, _>("status");
        let status = parse_status(&status)?;
        if !matches!(status, FocusStatus::Completed | FocusStatus::Abandoned) {
            return Err(invalid_transition(
                "Reflection can only be saved after a focus session ends.",
            ));
        }
        query("UPDATE focus_sessions SET reflection = ?, quality = ? WHERE id = ?")
            .bind(reflection)
            .bind(quality.map(i64::from))
            .bind(session_id)
            .execute(&self.pool)
            .await?;
        self.load_focus_session_at(session_id, Utc::now()).await
    }

    pub async fn update_next_focus_project(
        &self,
        session_id: &str,
        project_id: Option<&str>,
    ) -> Result<FocusSessionDto, AppError> {
        let snapshot = self.resolve_project(project_id).await?;
        let row =
            query("SELECT current_interval_position, status FROM focus_sessions WHERE id = ?")
                .bind(session_id)
                .fetch_optional(&self.pool)
                .await?
                .ok_or_else(|| AppError::new("focus_not_found", "Focus session was not found."))?;
        let status = parse_status(&row.get::<String, _>("status"))?;
        if !status.is_active() {
            return Err(invalid_transition(
                "The next Project can only change while a focus session is active.",
            ));
        }
        let current = row.get::<i64, _>("current_interval_position");
        let next = query(
            "SELECT position FROM focus_intervals
             WHERE session_id = ? AND position > ? AND kind = 'focus'
             ORDER BY position ASC LIMIT 1",
        )
        .bind(session_id)
        .bind(current)
        .fetch_optional(&self.pool)
        .await?
        .ok_or_else(|| {
            AppError::new(
                "focus_no_next_interval",
                "There is no later focus interval to reassign.",
            )
        })?;
        query(
            "UPDATE focus_intervals SET project_id = ?, project_name = ?
             WHERE session_id = ? AND position = ?",
        )
        .bind(snapshot.0)
        .bind(snapshot.1)
        .bind(session_id)
        .bind(next.get::<i64, _>("position"))
        .execute(&self.pool)
        .await?;
        self.load_focus_session_at(session_id, Utc::now()).await
    }

    pub async fn split_focus_segment(
        &self,
        segment_id: &str,
        split_at: &str,
    ) -> Result<FocusSessionDto, AppError> {
        let split_at = parse_time(split_at).map_err(|_| {
            AppError::new(
                "focus_invalid_split",
                "Split time must be a valid RFC 3339 timestamp.",
            )
        })?;
        let row = query(
            "SELECT fsg.id, fsg.session_id, fsg.interval_position, fsg.kind, fsg.started_at,
                    fsg.ended_at, fsg.project_id, fsg.project_name, fs.status AS session_status
             FROM focus_segments fsg
             JOIN focus_sessions fs ON fs.id = fsg.session_id
             WHERE fsg.id = ?",
        )
        .bind(segment_id)
        .fetch_optional(&self.pool)
        .await?
        .ok_or_else(|| AppError::new("focus_segment_not_found", "Focus segment was not found."))?;
        let kind = parse_segment_kind(&row.get::<String, _>("kind"))?;
        if !matches!(kind, FocusSegmentKind::Focus | FocusSegmentKind::Overtime) {
            return Err(AppError::new(
                "focus_invalid_split",
                "Only completed focus or overtime segments can be split.",
            ));
        }
        let session_status = parse_status(&row.get::<String, _>("session_status"))?;
        if !matches!(
            session_status,
            FocusStatus::Completed | FocusStatus::Abandoned
        ) {
            return Err(AppError::new(
                "focus_invalid_split",
                "Only a completed or abandoned Focus session can be corrected.",
            ));
        }
        let start = parse_time(&row.get::<String, _>("started_at"))?;
        let end_text = row
            .try_get::<Option<String>, _>("ended_at")?
            .ok_or_else(|| {
                AppError::new("focus_invalid_split", "An active segment cannot be split.")
            })?;
        let end = parse_time(&end_text)?;
        if split_at <= start || split_at >= end {
            return Err(AppError::new(
                "focus_invalid_split",
                "Split time must be strictly inside the segment.",
            ));
        }
        let session_id = row.get::<String, _>("session_id");
        let interval_position = row.get::<i64, _>("interval_position");
        let project_id = row.try_get::<Option<String>, _>("project_id")?;
        let project_name = row.try_get::<Option<String>, _>("project_name")?;
        let split_text = format_time(split_at);
        let second_id = Uuid::new_v4().to_string();
        let mut tx = self.pool.begin().await?;
        query("UPDATE focus_segments SET ended_at = ? WHERE id = ? AND ended_at = ?")
            .bind(&split_text)
            .bind(segment_id)
            .bind(&end_text)
            .execute(&mut *tx)
            .await?;
        query(
            "INSERT INTO focus_segments
             (id, session_id, interval_position, kind, started_at, ended_at,
              project_id, project_name, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&second_id)
        .bind(&session_id)
        .bind(interval_position)
        .bind(kind.as_db())
        .bind(&split_text)
        .bind(&end_text)
        .bind(project_id)
        .bind(project_name)
        .bind(&split_text)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        self.load_focus_session_at(&session_id, Utc::now()).await
    }

    pub async fn reassign_focus_segment(
        &self,
        segment_id: &str,
        project_id: Option<&str>,
    ) -> Result<FocusSessionDto, AppError> {
        let snapshot = self.resolve_project(project_id).await?;
        let row = query(
            "SELECT fsg.session_id, fsg.kind, fsg.ended_at, fs.status AS session_status
             FROM focus_segments fsg
             JOIN focus_sessions fs ON fs.id = fsg.session_id
             WHERE fsg.id = ?",
        )
        .bind(segment_id)
        .fetch_optional(&self.pool)
        .await?
        .ok_or_else(|| AppError::new("focus_segment_not_found", "Focus segment was not found."))?;
        let kind = parse_segment_kind(&row.get::<String, _>("kind"))?;
        if !matches!(kind, FocusSegmentKind::Focus | FocusSegmentKind::Overtime) {
            return Err(AppError::new(
                "focus_invalid_reassignment",
                "Breaks and interruptions cannot carry Project time.",
            ));
        }
        let session_status = parse_status(&row.get::<String, _>("session_status"))?;
        let ended_at = row.try_get::<Option<String>, _>("ended_at")?;
        if ended_at.is_none()
            || !matches!(
                session_status,
                FocusStatus::Completed | FocusStatus::Abandoned
            )
        {
            return Err(AppError::new(
                "focus_invalid_reassignment",
                "Only a completed or abandoned Focus session can be corrected.",
            ));
        }
        let session_id = row.get::<String, _>("session_id");
        query("UPDATE focus_segments SET project_id = ?, project_name = ? WHERE id = ?")
            .bind(snapshot.0)
            .bind(snapshot.1)
            .bind(segment_id)
            .execute(&self.pool)
            .await?;
        self.load_focus_session_at(&session_id, Utc::now()).await
    }

    pub async fn list_focus_history(
        &self,
        request: ListFocusHistoryRequest,
    ) -> Result<Vec<FocusSessionDto>, AppError> {
        let limit = i64::from(request.limit.unwrap_or(50).clamp(1, 200));
        let rows = if let Some(project_id) = request
            .project_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            query(
                "SELECT id FROM focus_sessions fs
                 WHERE fs.status IN ('completed', 'abandoned')
                   AND (
                     EXISTS (SELECT 1 FROM focus_intervals fi
                             WHERE fi.session_id = fs.id AND fi.project_id = ?)
                     OR EXISTS (SELECT 1 FROM focus_segments fsg
                                WHERE fsg.session_id = fs.id AND fsg.project_id = ?)
                   )
                 ORDER BY COALESCE(fs.completed_at, fs.abandoned_at, fs.created_at) DESC
                 LIMIT ?",
            )
            .bind(project_id)
            .bind(project_id)
            .bind(limit)
            .fetch_all(&self.pool)
            .await?
        } else {
            query(
                "SELECT id FROM focus_sessions
                 WHERE status IN ('completed', 'abandoned')
                 ORDER BY COALESCE(completed_at, abandoned_at, created_at) DESC
                 LIMIT ?",
            )
            .bind(limit)
            .fetch_all(&self.pool)
            .await?
        };
        let now = Utc::now();
        let mut sessions = Vec::with_capacity(rows.len());
        for row in rows {
            sessions.push(
                self.load_focus_session_at(&row.get::<String, _>("id"), now)
                    .await?,
            );
        }
        Ok(sessions)
    }

    pub(crate) async fn reconcile_active_focus_at(
        &self,
        now: DateTime<Utc>,
    ) -> Result<Vec<FocusTransition>, AppError> {
        let mut transitions = Vec::new();
        // At most one break completion followed by one focus expiry is
        // possible without user input; the wider bound protects corrupt data
        // from an unbounded loop.
        for _ in 0..4 {
            let Some(row) = query(&format!(
                "SELECT id, status, current_interval_position FROM focus_sessions
                 WHERE status IN ({ACTIVE_STATUSES_SQL}) LIMIT 1"
            ))
            .fetch_optional(&self.pool)
            .await?
            else {
                break;
            };
            let session_id = row.get::<String, _>("id");
            let status = parse_status(&row.get::<String, _>("status"))?;
            let position = u32_from_i64(row.get::<i64, _>("current_interval_position"))?;
            let (interval_kind, planned_ms) = self
                .interval_kind_and_duration(&session_id, position)
                .await?;
            let segment_kind = match status {
                FocusStatus::Focusing if interval_kind == FocusIntervalKind::Focus => {
                    FocusSegmentKind::Focus
                }
                FocusStatus::OnBreak if interval_kind == FocusIntervalKind::Break => {
                    FocusSegmentKind::Break
                }
                _ => break,
            };
            let Some((open_id, open_start, completed_ms)) = self
                .phase_progress(&session_id, position, segment_kind)
                .await?
            else {
                return Err(AppError::new(
                    "focus_state_corrupt",
                    "Active focus phase has no open timeline segment.",
                ));
            };
            let open_elapsed = duration_ms(open_start, now);
            if completed_ms.saturating_add(open_elapsed) < planned_ms {
                break;
            }
            let needed_from_open = planned_ms.saturating_sub(completed_ms);
            let boundary = open_start + Duration::milliseconds(needed_from_open);
            let boundary_text = format_time(boundary);
            let mut tx = self.pool.begin().await?;
            query("UPDATE focus_segments SET ended_at = ? WHERE id = ? AND ended_at IS NULL")
                .bind(&boundary_text)
                .bind(&open_id)
                .execute(&mut *tx)
                .await?;
            match status {
                FocusStatus::Focusing => {
                    let project = interval_project(&mut tx, &session_id, position).await?;
                    insert_segment(
                        &mut tx,
                        &session_id,
                        position,
                        FocusSegmentKind::Overtime,
                        boundary,
                        project.0.as_deref(),
                        project.1.as_deref(),
                    )
                    .await?;
                    query("UPDATE focus_sessions SET status = 'overtime' WHERE id = ?")
                        .bind(&session_id)
                        .execute(&mut *tx)
                        .await?;
                    transitions.push(FocusTransition::EnteredOvertime);
                }
                FocusStatus::OnBreak => {
                    let next = interval_after(&mut tx, &session_id, position).await?;
                    if next.kind != FocusIntervalKind::Focus {
                        return Err(AppError::new(
                            "focus_state_corrupt",
                            "A completed break is not followed by a focus interval.",
                        ));
                    }
                    insert_segment(
                        &mut tx,
                        &session_id,
                        next.position,
                        FocusSegmentKind::Focus,
                        boundary,
                        next.project_id.as_deref(),
                        next.project_name.as_deref(),
                    )
                    .await?;
                    query(
                        "UPDATE focus_sessions
                         SET status = 'focusing', current_interval_position = ? WHERE id = ?",
                    )
                    .bind(i64::from(next.position))
                    .bind(&session_id)
                    .execute(&mut *tx)
                    .await?;
                    transitions.push(FocusTransition::BreakCompleted);
                }
                _ => unreachable!("reconciled status"),
            }
            tx.commit().await?;
        }
        Ok(transitions)
    }

    pub(crate) async fn load_focus_session_at(
        &self,
        session_id: &str,
        now: DateTime<Utc>,
    ) -> Result<FocusSessionDto, AppError> {
        let row = query(
            "SELECT id, intention, start_shortcut_name, status, paused_from, current_interval_position,
                    created_at, started_at, completed_at, abandoned_at, reflection, quality
             FROM focus_sessions WHERE id = ?",
        )
        .bind(session_id)
        .fetch_optional(&self.pool)
        .await?
        .ok_or_else(|| AppError::new("focus_not_found", "Focus session was not found."))?;

        let status = parse_status(&row.get::<String, _>("status"))?;
        let paused_from = row
            .try_get::<Option<String>, _>("paused_from")?
            .map(|value| parse_status(&value))
            .transpose()?;
        let current_interval_position =
            u32_from_i64(row.get::<i64, _>("current_interval_position"))?;

        let interval_rows = query(
            "SELECT position, kind, planned_duration_ms, project_id, project_name
             FROM focus_intervals WHERE session_id = ? ORDER BY position ASC",
        )
        .bind(session_id)
        .fetch_all(&self.pool)
        .await?;
        let mut intervals = Vec::with_capacity(interval_rows.len());
        for interval in interval_rows {
            intervals.push(FocusIntervalDto {
                position: u32_from_i64(interval.get::<i64, _>("position"))?,
                kind: parse_interval_kind(&interval.get::<String, _>("kind"))?,
                planned_duration_ms: interval.get::<i64, _>("planned_duration_ms"),
                project_id: interval.try_get::<Option<String>, _>("project_id")?,
                project_name: interval.try_get::<Option<String>, _>("project_name")?,
            });
        }

        let segment_rows = query(
            "SELECT id, interval_position, kind, started_at, ended_at, project_id, project_name
             FROM focus_segments WHERE session_id = ? ORDER BY started_at ASC, created_at ASC",
        )
        .bind(session_id)
        .fetch_all(&self.pool)
        .await?;
        let mut segments = Vec::with_capacity(segment_rows.len());
        let mut actual_focus_ms = 0_i64;
        let mut actual_break_ms = 0_i64;
        let mut paused_ms = 0_i64;
        let mut overtime_ms = 0_i64;
        for segment in segment_rows {
            let kind = parse_segment_kind(&segment.get::<String, _>("kind"))?;
            let started_at = segment.get::<String, _>("started_at");
            let ended_at = segment.try_get::<Option<String>, _>("ended_at")?;
            let start = parse_time(&started_at)?;
            let end = ended_at
                .as_deref()
                .map(parse_time)
                .transpose()?
                .unwrap_or(now);
            let segment_ms = duration_ms(start, end);
            match kind {
                FocusSegmentKind::Focus => {
                    actual_focus_ms = actual_focus_ms.saturating_add(segment_ms)
                }
                FocusSegmentKind::Overtime => {
                    actual_focus_ms = actual_focus_ms.saturating_add(segment_ms);
                    overtime_ms = overtime_ms.saturating_add(segment_ms);
                }
                FocusSegmentKind::Break => {
                    actual_break_ms = actual_break_ms.saturating_add(segment_ms)
                }
                FocusSegmentKind::Pause => paused_ms = paused_ms.saturating_add(segment_ms),
            }
            segments.push(FocusSegmentDto {
                id: segment.get::<String, _>("id"),
                interval_position: u32_from_i64(segment.get::<i64, _>("interval_position"))?,
                kind,
                started_at,
                ended_at,
                duration_ms: segment_ms,
                project_id: segment.try_get::<Option<String>, _>("project_id")?,
                project_name: segment.try_get::<Option<String>, _>("project_name")?,
            });
        }

        let planned_focus_ms = intervals
            .iter()
            .filter(|interval| interval.kind == FocusIntervalKind::Focus)
            .fold(0_i64, |total, interval| {
                total.saturating_add(interval.planned_duration_ms)
            });
        let current_interval = intervals
            .iter()
            .find(|interval| interval.position == current_interval_position);
        let current_segment_ms = |kind| {
            segments
                .iter()
                .filter(|segment| {
                    segment.interval_position == current_interval_position && segment.kind == kind
                })
                .map(|segment| segment.duration_ms)
                .sum::<i64>()
        };
        let current_focus_ms = current_segment_ms(FocusSegmentKind::Focus);
        let current_overtime_ms = current_segment_ms(FocusSegmentKind::Overtime);
        let current_elapsed_ms = match status {
            FocusStatus::Focusing => current_focus_ms,
            FocusStatus::Overtime => current_interval
                .map(|interval| interval.planned_duration_ms)
                .unwrap_or_default()
                .saturating_add(current_overtime_ms),
            FocusStatus::OnBreak => current_segment_ms(FocusSegmentKind::Break),
            FocusStatus::Paused if paused_from == Some(FocusStatus::Focusing) => current_focus_ms,
            FocusStatus::Paused if paused_from == Some(FocusStatus::Overtime) => current_interval
                .map(|interval| interval.planned_duration_ms)
                .unwrap_or_default()
                .saturating_add(current_overtime_ms),
            _ => 0,
        };
        let remaining_ms = current_interval
            .map(|interval| {
                interval
                    .planned_duration_ms
                    .saturating_sub(current_elapsed_ms)
            })
            .unwrap_or_default()
            .max(0);
        let outcome = match status {
            FocusStatus::Abandoned => FocusOutcome::Abandoned,
            FocusStatus::Completed if overtime_ms > 0 => FocusOutcome::Overtime,
            FocusStatus::Completed if actual_focus_ms < planned_focus_ms => FocusOutcome::Shortened,
            FocusStatus::Completed => FocusOutcome::Completed,
            _ => FocusOutcome::Active,
        };

        Ok(FocusSessionDto {
            id: row.get::<String, _>("id"),
            intention: row.get::<String, _>("intention"),
            start_shortcut_name: row.try_get::<Option<String>, _>("start_shortcut_name")?,
            status,
            paused_from,
            current_interval_position,
            created_at: row.get::<String, _>("created_at"),
            started_at: row.try_get::<Option<String>, _>("started_at")?,
            completed_at: row.try_get::<Option<String>, _>("completed_at")?,
            abandoned_at: row.try_get::<Option<String>, _>("abandoned_at")?,
            reflection: row.try_get::<Option<String>, _>("reflection")?,
            quality: row
                .try_get::<Option<i64>, _>("quality")?
                .map(u8::try_from)
                .transpose()
                .map_err(|_| AppError::new("focus_state_corrupt", "Focus quality is invalid."))?,
            intervals,
            segments,
            planned_focus_ms,
            actual_focus_ms,
            actual_break_ms,
            paused_ms,
            current_elapsed_ms,
            remaining_ms,
            overtime_ms,
            outcome,
        })
    }

    pub(crate) async fn active_focus_session_at(
        &self,
        now: DateTime<Utc>,
    ) -> Result<Option<FocusSessionDto>, AppError> {
        let row = query(&format!(
            "SELECT id FROM focus_sessions WHERE status IN ({ACTIVE_STATUSES_SQL}) LIMIT 1"
        ))
        .fetch_optional(&self.pool)
        .await?;
        match row {
            Some(row) => Ok(Some(
                self.load_focus_session_at(&row.get::<String, _>("id"), now)
                    .await?,
            )),
            None => Ok(None),
        }
    }

    async fn resolve_active_request(
        &self,
        requested_session_id: Option<&str>,
    ) -> Result<(String, FocusStatus, u32), AppError> {
        let row = query(&format!(
            "SELECT id, status, current_interval_position FROM focus_sessions
             WHERE status IN ({ACTIVE_STATUSES_SQL}) LIMIT 1"
        ))
        .fetch_optional(&self.pool)
        .await?
        .ok_or_else(|| AppError::new("focus_not_active", "No focus session is active."))?;
        let session_id = row.get::<String, _>("id");
        if requested_session_id
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .is_some_and(|requested| requested != session_id)
        {
            return Err(AppError::new(
                "focus_session_mismatch",
                "A different focus session is active.",
            ));
        }
        Ok((
            session_id,
            parse_status(&row.get::<String, _>("status"))?,
            u32_from_i64(row.get::<i64, _>("current_interval_position"))?,
        ))
    }

    async fn resolve_project(
        &self,
        project_id: Option<&str>,
    ) -> Result<(Option<String>, Option<String>), AppError> {
        let Some(project_id) = project_id
            .map(str::trim)
            .filter(|project_id| !project_id.is_empty())
        else {
            return Ok((None, None));
        };
        let row = query("SELECT id, name FROM folders WHERE id = ? AND deleted_at IS NULL")
            .bind(project_id)
            .fetch_optional(&self.pool)
            .await?
            .ok_or_else(|| AppError::new("focus_project_not_found", "Project was not found."))?;
        Ok((
            Some(row.get::<String, _>("id")),
            Some(row.get::<String, _>("name")),
        ))
    }

    async fn validate_plan(
        &self,
        request: &StartFocusRequest,
    ) -> Result<Vec<ValidatedInterval>, AppError> {
        let default_project = self.resolve_project(request.project_id.as_deref()).await?;
        let raw_plan = if let Some(plan) = request.interval_plan.as_ref() {
            if plan.is_empty() {
                return Err(invalid_plan("A focus plan needs at least one interval."));
            }
            plan.clone()
        } else {
            let count = request.interval_count.unwrap_or(1);
            if count == 0 || count > MAX_FOCUS_INTERVALS {
                return Err(invalid_plan(format!(
                    "A focus plan can contain between 1 and {MAX_FOCUS_INTERVALS} focus intervals."
                )));
            }
            let focus_minutes = request
                .interval_duration_minutes
                .or(request.duration_minutes)
                .unwrap_or(DEFAULT_FOCUS_MINUTES);
            let break_minutes = request
                .break_duration_minutes
                .unwrap_or(DEFAULT_BREAK_MINUTES);
            let long_break_minutes = request
                .long_break_duration_minutes
                .unwrap_or(DEFAULT_LONG_BREAK_MINUTES);
            let mut plan = Vec::with_capacity((count.saturating_mul(2).saturating_sub(1)) as usize);
            for index in 0..count {
                plan.push(FocusIntervalInput {
                    kind: FocusIntervalKind::Focus,
                    duration_minutes: focus_minutes,
                    project_id: request.project_id.clone(),
                });
                if index + 1 < count {
                    plan.push(FocusIntervalInput {
                        kind: FocusIntervalKind::Break,
                        duration_minutes: if (index + 1) % 4 == 0 {
                            long_break_minutes
                        } else {
                            break_minutes
                        },
                        project_id: None,
                    });
                }
            }
            plan
        };
        if raw_plan.len() > (MAX_FOCUS_INTERVALS.saturating_mul(2).saturating_sub(1)) as usize {
            return Err(invalid_plan("The focus plan contains too many intervals."));
        }

        let mut validated = Vec::with_capacity(raw_plan.len());
        let mut total_minutes = 0_u32;
        let mut focus_count = 0_u32;
        for (index, interval) in raw_plan.into_iter().enumerate() {
            let expected_kind = if index % 2 == 0 {
                FocusIntervalKind::Focus
            } else {
                FocusIntervalKind::Break
            };
            if interval.kind != expected_kind {
                return Err(invalid_plan(
                    "Focus plans must alternate focus and break intervals, beginning with focus.",
                ));
            }
            let max_minutes = match interval.kind {
                FocusIntervalKind::Focus => MAX_FOCUS_MINUTES,
                FocusIntervalKind::Break => MAX_BREAK_MINUTES,
            };
            if interval.duration_minutes == 0 || interval.duration_minutes > max_minutes {
                return Err(invalid_plan(format!(
                    "{} intervals must be between 1 and {max_minutes} minutes.",
                    if interval.kind == FocusIntervalKind::Focus {
                        "Focus"
                    } else {
                        "Break"
                    }
                )));
            }
            total_minutes = total_minutes
                .checked_add(interval.duration_minutes)
                .ok_or_else(|| invalid_plan("The focus plan is too long."))?;
            if total_minutes > MAX_PLAN_MINUTES {
                return Err(invalid_plan(format!(
                    "A focus plan cannot exceed {MAX_PLAN_MINUTES} minutes."
                )));
            }
            let project = match interval.kind {
                FocusIntervalKind::Focus => {
                    focus_count += 1;
                    if interval.project_id.is_some() {
                        self.resolve_project(interval.project_id.as_deref()).await?
                    } else {
                        default_project.clone()
                    }
                }
                FocusIntervalKind::Break => {
                    if interval.project_id.is_some() {
                        return Err(invalid_plan("Break intervals cannot carry a Project."));
                    }
                    (None, None)
                }
            };
            validated.push(ValidatedInterval {
                position: u32::try_from(index)
                    .map_err(|_| invalid_plan("The focus plan is too long."))?,
                kind: interval.kind,
                planned_duration_ms: i64::from(interval.duration_minutes) * 60_000,
                project_id: project.0,
                project_name: project.1,
            });
        }
        if validated
            .last()
            .is_some_and(|interval| interval.kind != FocusIntervalKind::Focus)
        {
            return Err(invalid_plan("A focus plan must end with a focus interval."));
        }
        if focus_count == 0 || focus_count > MAX_FOCUS_INTERVALS {
            return Err(invalid_plan(format!(
                "A focus plan can contain between 1 and {MAX_FOCUS_INTERVALS} focus intervals."
            )));
        }
        Ok(validated)
    }

    async fn map_start_error(
        &self,
        error: sqlx::Error,
        now: DateTime<Utc>,
    ) -> Result<FocusSessionDto, AppError> {
        if error
            .as_database_error()
            .is_some_and(|db| db.message().contains("idx_focus_one_active_session"))
        {
            if let Some(active) = self.active_focus_session_at(now).await? {
                return Err(active_focus_error(active));
            }
        }
        Err(error.into())
    }

    async fn interval_kind_and_duration(
        &self,
        session_id: &str,
        position: u32,
    ) -> Result<(FocusIntervalKind, i64), AppError> {
        let row = query(
            "SELECT kind, planned_duration_ms FROM focus_intervals
             WHERE session_id = ? AND position = ?",
        )
        .bind(session_id)
        .bind(i64::from(position))
        .fetch_optional(&self.pool)
        .await?
        .ok_or_else(|| AppError::new("focus_state_corrupt", "Focus interval was not found."))?;
        Ok((
            parse_interval_kind(&row.get::<String, _>("kind"))?,
            row.get::<i64, _>("planned_duration_ms"),
        ))
    }

    async fn phase_progress(
        &self,
        session_id: &str,
        position: u32,
        kind: FocusSegmentKind,
    ) -> Result<Option<(String, DateTime<Utc>, i64)>, AppError> {
        let rows = query(
            "SELECT id, started_at, ended_at FROM focus_segments
             WHERE session_id = ? AND interval_position = ? AND kind = ?
             ORDER BY started_at ASC, created_at ASC",
        )
        .bind(session_id)
        .bind(i64::from(position))
        .bind(kind.as_db())
        .fetch_all(&self.pool)
        .await?;
        let mut completed_ms = 0_i64;
        let mut open = None;
        for row in rows {
            let start = parse_time(&row.get::<String, _>("started_at"))?;
            match row.try_get::<Option<String>, _>("ended_at")? {
                Some(end) => {
                    completed_ms =
                        completed_ms.saturating_add(duration_ms(start, parse_time(&end)?))
                }
                None => open = Some((row.get::<String, _>("id"), start)),
            }
        }
        Ok(open.map(|(id, start)| (id, start, completed_ms)))
    }
}

fn validate_intention(value: Option<&str>) -> Result<String, AppError> {
    Ok(normalize_optional_text(value, MAX_FOCUS_INTENTION_CHARS, "intention")?.unwrap_or_default())
}

fn validate_start_shortcut_name(value: Option<&str>) -> Result<Option<String>, AppError> {
    let value = value.filter(|value| !value.is_empty());
    if value.is_some_and(|value| {
        value.chars().count() > MAX_FOCUS_SHORTCUT_NAME_CHARS || value.contains(['\0', '\n', '\r'])
    }) {
        return Err(AppError::new(
            "focus_invalid_start_shortcut",
            format!(
                "A macOS Shortcut name must be one line and no more than {MAX_FOCUS_SHORTCUT_NAME_CHARS} characters."
            ),
        ));
    }
    Ok(value.map(ToOwned::to_owned))
}

fn normalize_optional_text(
    value: Option<&str>,
    max_chars: usize,
    field: &str,
) -> Result<Option<String>, AppError> {
    let value = value.map(str::trim).filter(|value| !value.is_empty());
    if value.is_some_and(|value| value.chars().count() > max_chars) {
        return Err(AppError::new(
            format!("focus_invalid_{field}"),
            format!("Focus {field} cannot exceed {max_chars} characters."),
        ));
    }
    Ok(value.map(ToOwned::to_owned))
}

fn parse_status(value: &str) -> Result<FocusStatus, AppError> {
    FocusStatus::from_db(value)
        .ok_or_else(|| AppError::new("focus_state_corrupt", "Focus status is invalid."))
}

fn parse_interval_kind(value: &str) -> Result<FocusIntervalKind, AppError> {
    FocusIntervalKind::from_db(value)
        .ok_or_else(|| AppError::new("focus_state_corrupt", "Focus interval kind is invalid."))
}

fn parse_segment_kind(value: &str) -> Result<FocusSegmentKind, AppError> {
    FocusSegmentKind::from_db(value)
        .ok_or_else(|| AppError::new("focus_state_corrupt", "Focus segment kind is invalid."))
}

fn parse_time(value: &str) -> Result<DateTime<Utc>, AppError> {
    DateTime::parse_from_rfc3339(value)
        .map(|value| value.with_timezone(&Utc))
        .map_err(|_| AppError::new("focus_state_corrupt", "Focus timestamp is invalid."))
}

fn format_time(value: DateTime<Utc>) -> String {
    value.to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn duration_ms(start: DateTime<Utc>, end: DateTime<Utc>) -> i64 {
    end.signed_duration_since(start).num_milliseconds().max(0)
}

fn u32_from_i64(value: i64) -> Result<u32, AppError> {
    u32::try_from(value)
        .map_err(|_| AppError::new("focus_state_corrupt", "Focus interval position is invalid."))
}

fn invalid_plan(message: impl Into<String>) -> AppError {
    AppError::new("focus_invalid_plan", message)
}

fn invalid_transition(message: impl Into<String>) -> AppError {
    AppError::new("focus_invalid_transition", message)
}

fn active_focus_error(active: FocusSessionDto) -> AppError {
    let mut error = AppError::new("focus_already_active", "A focus session is already active.");
    error.details = serde_json::to_value(active).ok();
    error
}

async fn insert_focus_session(
    tx: &mut Transaction<'_, Sqlite>,
    session_id: &str,
    intention: &str,
    start_shortcut_name: Option<&str>,
    status: FocusStatus,
    created_at: &str,
) -> Result<(), sqlx::Error> {
    query(
        "INSERT INTO focus_sessions (id, intention, start_shortcut_name, status, created_at)
         VALUES (?, ?, ?, ?, ?)",
    )
    .bind(session_id)
    .bind(intention)
    .bind(start_shortcut_name)
    .bind(status.as_db())
    .bind(created_at)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

async fn insert_intervals(
    tx: &mut Transaction<'_, Sqlite>,
    session_id: &str,
    intervals: &[ValidatedInterval],
) -> Result<(), AppError> {
    for interval in intervals {
        query(
            "INSERT INTO focus_intervals
             (session_id, position, kind, planned_duration_ms, project_id, project_name)
             VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind(session_id)
        .bind(i64::from(interval.position))
        .bind(interval.kind.as_db())
        .bind(interval.planned_duration_ms)
        .bind(&interval.project_id)
        .bind(&interval.project_name)
        .execute(&mut **tx)
        .await?;
    }
    Ok(())
}

async fn insert_segment(
    tx: &mut Transaction<'_, Sqlite>,
    session_id: &str,
    interval_position: u32,
    kind: FocusSegmentKind,
    started_at: DateTime<Utc>,
    project_id: Option<&str>,
    project_name: Option<&str>,
) -> Result<(), AppError> {
    let started_at = format_time(started_at);
    query(
        "INSERT INTO focus_segments
         (id, session_id, interval_position, kind, started_at, project_id, project_name, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(Uuid::new_v4().to_string())
    .bind(session_id)
    .bind(i64::from(interval_position))
    .bind(kind.as_db())
    .bind(&started_at)
    .bind(project_id)
    .bind(project_name)
    .bind(&started_at)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

async fn close_open_segment(
    tx: &mut Transaction<'_, Sqlite>,
    session_id: &str,
    ended_at: DateTime<Utc>,
) -> Result<(), AppError> {
    let result = query(
        "UPDATE focus_segments SET ended_at = ?
         WHERE session_id = ? AND ended_at IS NULL",
    )
    .bind(format_time(ended_at))
    .bind(session_id)
    .execute(&mut **tx)
    .await?;
    if result.rows_affected() != 1 {
        return Err(AppError::new(
            "focus_state_corrupt",
            "Active focus session has no open timeline segment.",
        ));
    }
    Ok(())
}

async fn close_open_segment_if_present(
    tx: &mut Transaction<'_, Sqlite>,
    session_id: &str,
    ended_at: DateTime<Utc>,
) -> Result<(), AppError> {
    query(
        "UPDATE focus_segments SET ended_at = ?
         WHERE session_id = ? AND ended_at IS NULL",
    )
    .bind(format_time(ended_at))
    .bind(session_id)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

async fn interval_after(
    tx: &mut Transaction<'_, Sqlite>,
    session_id: &str,
    position: u32,
) -> Result<ValidatedInterval, AppError> {
    let row = query(
        "SELECT position, kind, planned_duration_ms, project_id, project_name
         FROM focus_intervals WHERE session_id = ? AND position > ?
         ORDER BY position ASC LIMIT 1",
    )
    .bind(session_id)
    .bind(i64::from(position))
    .fetch_optional(&mut **tx)
    .await?
    .ok_or_else(|| AppError::new("focus_no_next_interval", "No later focus interval exists."))?;
    Ok(ValidatedInterval {
        position: u32_from_i64(row.get::<i64, _>("position"))?,
        kind: parse_interval_kind(&row.get::<String, _>("kind"))?,
        planned_duration_ms: row.get::<i64, _>("planned_duration_ms"),
        project_id: row.try_get::<Option<String>, _>("project_id")?,
        project_name: row.try_get::<Option<String>, _>("project_name")?,
    })
}

async fn interval_project(
    tx: &mut Transaction<'_, Sqlite>,
    session_id: &str,
    position: u32,
) -> Result<(Option<String>, Option<String>), AppError> {
    let row = query(
        "SELECT project_id, project_name FROM focus_intervals
         WHERE session_id = ? AND position = ?",
    )
    .bind(session_id)
    .bind(i64::from(position))
    .fetch_optional(&mut **tx)
    .await?
    .ok_or_else(|| AppError::new("focus_state_corrupt", "Focus interval was not found."))?;
    Ok((
        row.try_get::<Option<String>, _>("project_id")?,
        row.try_get::<Option<String>, _>("project_name")?,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::migrations::run_migrations;
    use chrono::TimeZone;
    use sqlx_sqlite::{SqliteConnectOptions, SqlitePoolOptions};
    use std::str::FromStr;

    async fn repositories() -> Repositories {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .expect("in-memory database");
        run_migrations(&pool).await.expect("migrations");
        Repositories::new(pool)
    }

    fn time(seconds: i64) -> DateTime<Utc> {
        Utc.timestamp_opt(1_800_000_000 + seconds, 0)
            .single()
            .expect("test timestamp")
    }

    fn one_minute() -> StartFocusRequest {
        StartFocusRequest {
            duration_minutes: Some(1),
            ..StartFocusRequest::default()
        }
    }

    #[tokio::test]
    async fn pause_time_is_excluded_and_expiry_enters_overtime() {
        let repos = repositories().await;
        let started = repos
            .start_focus_at(one_minute(), time(0))
            .await
            .expect("focus starts");

        let paused = repos
            .pause_focus_at(Some(&started.id), time(20))
            .await
            .expect("focus pauses");
        assert_eq!(paused.current_elapsed_ms, 20_000);
        assert_eq!(paused.remaining_ms, 40_000);
        repos
            .resume_focus_at(Some(&started.id), time(50))
            .await
            .expect("focus resumes");
        let active = repos
            .get_active_focus_at(time(90))
            .await
            .expect("active focus")
            .expect("session remains active");

        assert_eq!(active.status, FocusStatus::Overtime);
        assert_eq!(active.actual_focus_ms, 60_000);
        assert_eq!(active.paused_ms, 30_000);
        assert_eq!(active.overtime_ms, 0);

        let completed = repos
            .finish_focus_at(Some(&started.id), time(100))
            .await
            .expect("focus finishes");
        assert_eq!(completed.actual_focus_ms, 70_000);
        assert_eq!(completed.overtime_ms, 10_000);
        assert_eq!(completed.outcome, FocusOutcome::Overtime);
    }

    #[tokio::test]
    async fn wake_reconciliation_crosses_break_and_focus_boundaries() {
        let repos = repositories().await;
        let started = repos
            .start_focus_at(
                StartFocusRequest {
                    interval_plan: Some(vec![
                        FocusIntervalInput {
                            kind: FocusIntervalKind::Focus,
                            duration_minutes: 1,
                            project_id: None,
                        },
                        FocusIntervalInput {
                            kind: FocusIntervalKind::Break,
                            duration_minutes: 1,
                            project_id: None,
                        },
                        FocusIntervalInput {
                            kind: FocusIntervalKind::Focus,
                            duration_minutes: 1,
                            project_id: None,
                        },
                    ]),
                    ..StartFocusRequest::default()
                },
                time(0),
            )
            .await
            .expect("focus starts");
        repos
            .reconcile_active_focus_at(time(60))
            .await
            .expect("first interval expires");
        repos
            .start_focus_break_at(Some(&started.id), time(70))
            .await
            .expect("break starts");

        let transitions = repos
            .reconcile_active_focus_at(time(200))
            .await
            .expect("wake reconciliation");
        assert_eq!(
            transitions,
            vec![
                FocusTransition::BreakCompleted,
                FocusTransition::EnteredOvertime
            ]
        );
        let active = repos
            .active_focus_session_at(time(200))
            .await
            .expect("active focus")
            .expect("session remains active");
        assert_eq!(active.status, FocusStatus::Overtime);
        assert_eq!(active.current_interval_position, 2);
        assert_eq!(active.actual_focus_ms, 140_000);
        assert_eq!(active.actual_break_ms, 60_000);
        assert_eq!(active.overtime_ms, 20_000);
        assert_eq!(active.current_elapsed_ms, 70_000);
    }

    #[tokio::test]
    async fn active_session_is_a_global_database_invariant() {
        let repos = repositories().await;
        let first = repos
            .start_focus_at(one_minute(), time(0))
            .await
            .expect("first focus starts");
        let error = repos
            .create_focus_plan_at(one_minute(), time(1))
            .await
            .expect_err("second active focus is rejected");

        assert_eq!(error.code, "focus_already_active");
        assert_eq!(
            error.details.expect("active session details")["id"],
            first.id
        );
    }

    #[tokio::test]
    async fn planned_session_persists_its_start_shortcut() {
        let repos = repositories().await;
        let planned = repos
            .create_focus_plan_at(
                StartFocusRequest {
                    start_shortcut_name: Some("Writing Focus".to_string()),
                    duration_minutes: Some(1),
                    ..StartFocusRequest::default()
                },
                time(0),
            )
            .await
            .expect("focus plan is created");

        assert_eq!(
            planned.start_shortcut_name.as_deref(),
            Some("Writing Focus")
        );
        let started = repos
            .start_focus_plan_at(&planned.id, time(10))
            .await
            .expect("focus plan starts");
        assert_eq!(
            started.start_shortcut_name.as_deref(),
            Some("Writing Focus")
        );
    }

    #[test]
    fn start_shortcut_name_must_be_one_bounded_line() {
        let newline = validate_start_shortcut_name(Some("Focus\nSomething else"))
            .expect_err("newlines are rejected");
        assert_eq!(newline.code, "focus_invalid_start_shortcut");

        let too_long = "x".repeat(MAX_FOCUS_SHORTCUT_NAME_CHARS + 1);
        let length =
            validate_start_shortcut_name(Some(&too_long)).expect_err("overlong names are rejected");
        assert_eq!(length.code, "focus_invalid_start_shortcut");
    }

    #[tokio::test]
    async fn project_name_snapshot_survives_project_deletion() {
        let repos = repositories().await;
        query(
            "INSERT INTO folders (id, name, created_at, updated_at)
             VALUES ('project-1', 'Launch', '2027-01-15T00:00:00.000Z', '2027-01-15T00:00:00.000Z')",
        )
        .execute(&repos.pool)
        .await
        .expect("project fixture");
        let started = repos
            .start_focus_at(
                StartFocusRequest {
                    project_id: Some("project-1".to_string()),
                    duration_minutes: Some(1),
                    ..StartFocusRequest::default()
                },
                time(0),
            )
            .await
            .expect("focus starts");
        repos
            .finish_focus_at(Some(&started.id), time(30))
            .await
            .expect("focus finishes");
        query("UPDATE folders SET deleted_at = '2027-01-15T00:01:00.000Z' WHERE id = 'project-1'")
            .execute(&repos.pool)
            .await
            .expect("project deleted");

        let history = repos
            .list_focus_history(ListFocusHistoryRequest::default())
            .await
            .expect("history loads");
        assert_eq!(
            history[0].segments[0].project_name.as_deref(),
            Some("Launch")
        );
    }

    #[tokio::test]
    async fn next_focus_interval_project_can_change_while_active() {
        let repos = repositories().await;
        for (id, name) in [("project-1", "Launch"), ("project-2", "Support")] {
            query(
                "INSERT INTO folders (id, name, created_at, updated_at)
                 VALUES (?, ?, '2027-01-15T00:00:00.000Z', '2027-01-15T00:00:00.000Z')",
            )
            .bind(id)
            .bind(name)
            .execute(&repos.pool)
            .await
            .expect("project fixture");
        }
        let started = repos
            .start_focus_at(
                StartFocusRequest {
                    project_id: Some("project-1".to_string()),
                    interval_count: Some(2),
                    duration_minutes: Some(1),
                    break_duration_minutes: Some(1),
                    ..StartFocusRequest::default()
                },
                time(0),
            )
            .await
            .expect("focus starts");

        let updated = repos
            .update_next_focus_project(&started.id, Some("project-2"))
            .await
            .expect("next Project updates");

        let next = updated
            .intervals
            .iter()
            .find(|interval| interval.position == 2)
            .expect("next focus interval");
        assert_eq!(next.project_id.as_deref(), Some("project-2"));
        assert_eq!(next.project_name.as_deref(), Some("Support"));
        assert_eq!(updated.segments[0].project_id.as_deref(), Some("project-1"));
    }

    #[tokio::test]
    async fn split_preserves_total_time_and_can_be_reassigned() {
        let repos = repositories().await;
        for (id, name) in [("project-1", "Launch"), ("project-2", "Support")] {
            query(
                "INSERT INTO folders (id, name, created_at, updated_at)
                 VALUES (?, ?, '2027-01-15T00:00:00.000Z', '2027-01-15T00:00:00.000Z')",
            )
            .bind(id)
            .bind(name)
            .execute(&repos.pool)
            .await
            .expect("project fixture");
        }
        let started = repos
            .start_focus_at(
                StartFocusRequest {
                    project_id: Some("project-1".to_string()),
                    duration_minutes: Some(1),
                    ..StartFocusRequest::default()
                },
                time(0),
            )
            .await
            .expect("focus starts");
        let active_error = repos
            .reassign_focus_segment(&started.segments[0].id, Some("project-2"))
            .await
            .expect_err("active focus time cannot be corrected");
        assert_eq!(active_error.code, "focus_invalid_reassignment");
        let completed = repos
            .finish_focus_at(Some(&started.id), time(40))
            .await
            .expect("focus finishes");
        let segment_id = completed.segments[0].id.clone();
        assert_eq!(completed.outcome, FocusOutcome::Shortened);
        let split = repos
            .split_focus_segment(&segment_id, &format_time(time(15)))
            .await
            .expect("segment splits");
        assert_eq!(split.actual_focus_ms, 40_000);
        assert_eq!(split.segments.len(), 2);

        let reassigned = repos
            .reassign_focus_segment(&split.segments[1].id, Some("project-2"))
            .await
            .expect("segment reassigns");
        assert_eq!(
            reassigned.segments[1].project_name.as_deref(),
            Some("Support")
        );
        assert_eq!(reassigned.actual_focus_ms, 40_000);
    }

    #[tokio::test]
    async fn abandonment_stays_in_history_with_recorded_time() {
        let repos = repositories().await;
        let started = repos
            .start_focus_at(one_minute(), time(0))
            .await
            .expect("focus starts");
        let abandoned = repos
            .abandon_focus_at(Some(&started.id), time(15))
            .await
            .expect("focus is abandoned");

        assert_eq!(abandoned.status, FocusStatus::Abandoned);
        assert_eq!(abandoned.outcome, FocusOutcome::Abandoned);
        assert_eq!(abandoned.actual_focus_ms, 15_000);
        assert!(abandoned.abandoned_at.is_some());
        let history = repos
            .list_focus_history(ListFocusHistoryRequest::default())
            .await
            .expect("history loads");
        assert_eq!(history.len(), 1);
        assert_eq!(history[0].id, started.id);
    }

    #[tokio::test]
    async fn active_focus_reconciles_after_database_reopen() {
        let directory = tempfile::tempdir().expect("temp directory");
        let database_path = directory.path().join("focus.sqlite3");
        let options =
            SqliteConnectOptions::from_str(&format!("sqlite://{}", database_path.display()))
                .expect("database URL")
                .create_if_missing(true);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options.clone())
            .await
            .expect("database opens");
        run_migrations(&pool).await.expect("migrations");
        let repos = Repositories::new(pool);
        let started = repos
            .start_focus_at(one_minute(), time(0))
            .await
            .expect("focus starts");
        repos.pool.close().await;

        let reopened_pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .expect("database reopens");
        run_migrations(&reopened_pool)
            .await
            .expect("migrations remain idempotent");
        let reopened = Repositories::new(reopened_pool);
        let active = reopened
            .get_active_focus_at(time(80))
            .await
            .expect("focus reconciles")
            .expect("session remains active");

        assert_eq!(active.id, started.id);
        assert_eq!(active.status, FocusStatus::Overtime);
        assert_eq!(active.actual_focus_ms, 80_000);
        assert_eq!(active.overtime_ms, 20_000);
    }
}
