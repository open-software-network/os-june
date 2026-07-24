use crate::domain::types::{
    AppError, AudioArtifactDto, AudioValidationDto, CompletedSessionDto, DictationHistoryItemDto,
    DictionaryEntryDto, FolderDto, ListDictationHistoryResponse, ListNotesResponse, MemoryDto,
    NoteCalendarEventDto, NoteDto, NoteListItemDto, NotePatchDto, NoteTranscriptionJobKind,
    NoteTranscriptionJobPlan, NoteTranscriptionJobRecord, NoteTranscriptionJobStatus,
    ProcessingStatus, ProfileDataSummaryDto, RecordingSourceMode, RecordingState, SessionFolderDto,
    SessionProfileDto, TranscriptCoverageDto, TranscriptDto,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use chrono::{DateTime, Duration, SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::query::query;
use sqlx::query_builder::QueryBuilder;
use sqlx::row::Row;
use sqlx_sqlite::{Sqlite, SqlitePool};
use uuid::Uuid;

use crate::note_audio_export::{NoteAudioExportSelection, NoteAudioExportSource};

const DICTATION_HISTORY_RETENTION_DAYS: i64 = 7;
const NOTE_PREVIEW_CHAR_LIMIT: usize = 140;
const LIST_NOTES_CURSOR_VERSION: u8 = 1;
const LIST_NOTES_CURSOR_MAX_ENCODED_LEN: usize = 1_024;

#[derive(Clone, Debug, Deserialize, Serialize)]
struct ListNotesCursor {
    version: u8,
    created_at: String,
    rowid: i64,
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

/// Non-secret connector account index row. Tokens are NEVER stored here;
/// they live in the OS keychain (src/connectors/store.rs).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ConnectorAccountRecord {
    pub account_id: String,
    pub provider: String,
    pub email: String,
    pub scopes: Vec<String>,
    pub status: String,
    pub created_at: String,
    pub updated_at: String,
    /// Provider-specific, non-secret details as a JSON object (e.g. Linear's
    /// workspace name/url key). `"{}"` for providers (Google) that carry
    /// none. The connectors layer owns parsing this; the repository treats
    /// it as an opaque string.
    pub metadata: String,
}

/// One Linear team a connected workspace account is scoped to.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SelectedTeamRecord {
    pub team_id: String,
    pub team_key: String,
    pub team_name: String,
}

/// One journaled connector mutation attempt. The `action_id` is the
/// client-minted v4 UUID that is ALSO the created object's id at the
/// provider, so an ambiguous outcome can be reconciled by querying that id.
/// Status lifecycle: `pending` (written before the mutation) then exactly
/// one of `committed` / `ambiguous` / `failed`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ConnectorActionRecord {
    pub action_id: String,
    pub account_id: String,
    pub tool: String,
    /// Short human description of the mutation target (e.g. "ENG: Fix the
    /// flaky test"); never carries tokens or full content bodies.
    pub summary: String,
    pub status: String,
    pub created_at: String,
    pub resolved_at: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RoutineTrustRecord {
    pub job_id: String,
    pub trust_mode: String,
    pub approval_run_count: i64,
    pub autonomous_tools: Vec<String>,
    /// When the routine most recently entered approval mode (RFC 3339), or
    /// `None` if it has never been in approval mode. Approval-run crediting
    /// only counts runs that finished at or after this instant.
    pub approval_since: Option<String>,
    pub updated_at: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ConnectorTriggerRecord {
    pub id: String,
    pub job_id: String,
    pub kind: String,
    pub account_id: String,
    /// JSON object as text; the command layer parses it.
    pub config: String,
    pub created_at: String,
}

/// Locally retained content key for a private share (JUN-308). The content
/// key must stay on the owner's device so later invites can wrap the same key
/// without re-encrypting; it never leaves the device except wrapped inside
/// per-recipient envelopes.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ShareKeyRecord {
    pub share_id: String,
    /// "note" | "session".
    pub item_kind: String,
    pub item_id: String,
    pub content_key: Vec<u8>,
}

/// Locally retained invite key so "copy link" keeps working across app
/// restarts (invite keys are not re-derivable from anything the server has).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ShareInviteKeyRecord {
    pub invite_id: String,
    pub share_id: String,
    pub invite_key: Vec<u8>,
}

/// Per-job, per-provider autonomy grant. Minted when a routine is set to
/// `autonomous`: the bridge registers a per-job auto MCP server carrying the
/// `token` in its env, and the provider proxy authorizes a tool call by
/// looking the token up and checking the tool is in `tools`. The token is a
/// bearer secret; never log it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ConnectorGrant {
    pub job_id: String,
    /// "gmail" | "gcal".
    pub provider: String,
    /// Deterministic per-job server name: `june_<provider>_auto_<jobid8>`.
    pub server_name: String,
    pub token: String,
    /// Granted tool names for this provider.
    pub tools: Vec<String>,
    pub account_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RoutineBrowserGrantRecord {
    pub job_id: String,
    pub server_name: String,
    pub token: String,
    pub enabled: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BrowserActionOutcomeRecord {
    pub id: String,
    pub operation: String,
    pub transport_kind: String,
    pub session_id: String,
    pub approval_id: Option<String>,
    pub outcome_class: Option<String>,
    pub result_kind: String,
    pub result_code_class: Option<String>,
    pub outcome_verified: bool,
    pub declared_at: String,
    pub evaluated_at: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct BrowserOutcomeCounts {
    pub declared: u64,
    pub verified_successes: u64,
    pub executed: u64,
    pub refused: u64,
    pub transport_errors: u64,
    pub parked: u64,
    pub approved: u64,
    pub declined: u64,
    pub expired: u64,
    pub cancelled_by_task_end: u64,
}

impl Repositories {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    pub async fn declare_browser_action(
        &self,
        id: &str,
        operation: &str,
        transport_kind: &str,
        session_id: &str,
        outcome_class: Option<&str>,
    ) -> Result<(), sqlx::error::Error> {
        query(
            "INSERT INTO browser_action_outcomes (
               id, operation, transport_kind, session_id, outcome_class, declared_at
             ) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind(id)
        .bind(operation)
        .bind(transport_kind)
        .bind(session_id)
        .bind(outcome_class)
        .bind(timestamp())
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn evaluate_browser_action(
        &self,
        id: &str,
        result_kind: &str,
        result_code_class: Option<&str>,
        outcome_verified: bool,
    ) -> Result<(), sqlx::error::Error> {
        let result = query(
            "UPDATE browser_action_outcomes
             SET result_kind = ?, result_code_class = ?, outcome_verified = ?, evaluated_at = ?
             WHERE id = ? AND result_kind = 'pending'",
        )
        .bind(result_kind)
        .bind(result_code_class)
        .bind(outcome_verified)
        .bind(timestamp())
        .bind(id)
        .execute(&self.pool)
        .await?;
        if result.rows_affected() == 1 {
            Ok(())
        } else {
            Err(sqlx::Error::RowNotFound)
        }
    }

    pub async fn park_browser_approval(
        &self,
        action_id: &str,
        approval_id: &str,
        session_id: &str,
    ) -> Result<(), sqlx::error::Error> {
        let mut tx = self.pool.begin().await?;
        let updated = query(
            "UPDATE browser_action_outcomes
             SET approval_id = ?
             WHERE id = ? AND result_kind = 'pending' AND approval_id IS NULL",
        )
        .bind(approval_id)
        .bind(action_id)
        .execute(&mut *tx)
        .await?;
        if updated.rows_affected() != 1 {
            return Err(sqlx::Error::RowNotFound);
        }
        insert_browser_approval_event(&mut tx, approval_id, action_id, session_id, "parked")
            .await?;
        tx.commit().await
    }

    pub async fn record_browser_approval_event(
        &self,
        action_id: &str,
        approval_id: &str,
        session_id: &str,
        event_kind: &str,
    ) -> Result<(), sqlx::error::Error> {
        let mut tx = self.pool.begin().await?;
        insert_browser_approval_event(&mut tx, approval_id, action_id, session_id, event_kind)
            .await?;
        tx.commit().await
    }

    pub async fn finish_browser_approval(
        &self,
        action_id: &str,
        approval_id: &str,
        session_id: &str,
        event_kind: &str,
        result_code_class: &str,
    ) -> Result<(), sqlx::error::Error> {
        let mut tx = self.pool.begin().await?;
        insert_browser_approval_event(&mut tx, approval_id, action_id, session_id, event_kind)
            .await?;
        let updated = query(
            "UPDATE browser_action_outcomes
             SET result_kind = 'refused', result_code_class = ?, outcome_verified = 0,
                 evaluated_at = ?
             WHERE id = ? AND result_kind = 'pending'",
        )
        .bind(result_code_class)
        .bind(timestamp())
        .bind(action_id)
        .execute(&mut *tx)
        .await?;
        if updated.rows_affected() != 1 {
            return Err(sqlx::Error::RowNotFound);
        }
        tx.commit().await
    }

    pub async fn browser_action_outcomes_for_session(
        &self,
        session_id: &str,
    ) -> Result<Vec<BrowserActionOutcomeRecord>, sqlx::error::Error> {
        let rows = query(
            "SELECT id, operation, transport_kind, session_id, approval_id, outcome_class,
                    result_kind, result_code_class, outcome_verified, declared_at, evaluated_at
             FROM browser_action_outcomes
             WHERE session_id = ?
             ORDER BY declared_at ASC, id ASC",
        )
        .bind(session_id)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows
            .into_iter()
            .map(|row| BrowserActionOutcomeRecord {
                id: row.get("id"),
                operation: row.get("operation"),
                transport_kind: row.get("transport_kind"),
                session_id: row.get("session_id"),
                approval_id: row.get("approval_id"),
                outcome_class: row.get("outcome_class"),
                result_kind: row.get("result_kind"),
                result_code_class: row.get("result_code_class"),
                outcome_verified: row.get("outcome_verified"),
                declared_at: row.get("declared_at"),
                evaluated_at: row.get("evaluated_at"),
            })
            .collect())
    }

    pub async fn browser_outcome_counts(&self) -> Result<BrowserOutcomeCounts, sqlx::error::Error> {
        let row = query(
            "SELECT
               COUNT(*) AS declared,
               COALESCE(SUM(outcome_verified), 0) AS verified_successes,
               COALESCE(SUM(result_kind = 'executed'), 0) AS executed,
               COALESCE(SUM(result_kind = 'refused'), 0) AS refused,
               COALESCE(SUM(result_kind = 'transport_error'), 0) AS transport_errors,
               (SELECT COUNT(*) FROM browser_approval_events WHERE event_kind = 'parked') AS parked,
               (SELECT COUNT(*) FROM browser_approval_events WHERE event_kind = 'approved') AS approved,
               (SELECT COUNT(*) FROM browser_approval_events WHERE event_kind = 'declined') AS declined,
               (SELECT COUNT(*) FROM browser_approval_events WHERE event_kind = 'expired') AS expired,
               (SELECT COUNT(*) FROM browser_approval_events WHERE event_kind = 'cancelled_by_task_end') AS cancelled_by_task_end
             FROM browser_action_outcomes",
        )
        .fetch_one(&self.pool)
        .await?;
        Ok(BrowserOutcomeCounts {
            declared: nonnegative_u64(row.get("declared")),
            verified_successes: nonnegative_u64(row.get("verified_successes")),
            executed: nonnegative_u64(row.get("executed")),
            refused: nonnegative_u64(row.get("refused")),
            transport_errors: nonnegative_u64(row.get("transport_errors")),
            parked: nonnegative_u64(row.get("parked")),
            approved: nonnegative_u64(row.get("approved")),
            declined: nonnegative_u64(row.get("declined")),
            expired: nonnegative_u64(row.get("expired")),
            cancelled_by_task_end: nonnegative_u64(row.get("cancelled_by_task_end")),
        })
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

    // --- Private connectors (Google, Linear) --------------------------------
    //
    // Non-secret account index only: tokens live in the OS keychain
    // (src/connectors/store.rs), never in SQLite.

    pub async fn upsert_connector_account(
        &self,
        account_id: &str,
        provider: &str,
        email: &str,
        scopes: &[String],
        status: &str,
        metadata: &str,
    ) -> Result<(), sqlx::error::Error> {
        let now = timestamp();
        let scopes_json = string_vec_to_json(scopes);
        query(
            "INSERT INTO connector_accounts (account_id, provider, email, scopes, status, metadata, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(account_id) DO UPDATE SET
               provider = excluded.provider,
               email = excluded.email,
               scopes = excluded.scopes,
               status = excluded.status,
               metadata = excluded.metadata,
               updated_at = excluded.updated_at",
        )
        .bind(account_id)
        .bind(provider)
        .bind(email)
        .bind(&scopes_json)
        .bind(status)
        .bind(metadata)
        .bind(&now)
        .bind(&now)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn list_connector_accounts(
        &self,
    ) -> Result<Vec<ConnectorAccountRecord>, sqlx::error::Error> {
        let rows = query(
            "SELECT account_id, provider, email, scopes, status, metadata, created_at, updated_at
             FROM connector_accounts ORDER BY created_at ASC",
        )
        .fetch_all(&self.pool)
        .await?;
        Ok(rows.into_iter().map(connector_account_from_row).collect())
    }

    pub async fn get_connector_account(
        &self,
        account_id: &str,
    ) -> Result<Option<ConnectorAccountRecord>, sqlx::error::Error> {
        let row = query(
            "SELECT account_id, provider, email, scopes, status, metadata, created_at, updated_at
             FROM connector_accounts WHERE account_id = ?",
        )
        .bind(account_id)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.map(connector_account_from_row))
    }

    /// Replace the set of Linear teams an account is scoped to. DELETE +
    /// re-INSERT in one transaction (never diffed): "manage teams" always
    /// submits the full desired set, and a partial failure must not leave a
    /// mix of old and new rows. One `created_at` for the whole batch keeps
    /// rows from the same save trivially group-able.
    pub async fn set_selected_teams(
        &self,
        account_id: &str,
        teams: &[SelectedTeamRecord],
    ) -> Result<(), sqlx::error::Error> {
        let now = timestamp();
        let mut tx = self.pool.begin().await?;
        query("DELETE FROM connector_selected_teams WHERE account_id = ?")
            .bind(account_id)
            .execute(&mut *tx)
            .await?;
        for team in teams {
            query(
                "INSERT INTO connector_selected_teams (account_id, team_id, team_key, team_name, created_at)
                 VALUES (?, ?, ?, ?, ?)",
            )
            .bind(account_id)
            .bind(&team.team_id)
            .bind(&team.team_key)
            .bind(&team.team_name)
            .bind(&now)
            .execute(&mut *tx)
            .await?;
        }
        tx.commit().await
    }

    pub async fn list_selected_teams(
        &self,
        account_id: &str,
    ) -> Result<Vec<SelectedTeamRecord>, sqlx::error::Error> {
        let rows = query(
            "SELECT team_id, team_key, team_name
             FROM connector_selected_teams WHERE account_id = ? ORDER BY team_name ASC",
        )
        .bind(account_id)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows.into_iter().map(selected_team_from_row).collect())
    }

    /// Journal a mutation attempt as `pending` BEFORE the provider call. The
    /// action id is the client-minted UUID handed to the provider as the
    /// object id, so the row exists even if the process dies mid-mutation.
    pub async fn insert_connector_action(
        &self,
        action_id: &str,
        account_id: &str,
        tool: &str,
        summary: &str,
    ) -> Result<(), sqlx::error::Error> {
        let now = timestamp();
        query(
            "INSERT INTO connector_actions (action_id, account_id, tool, summary, status, created_at)
             VALUES (?, ?, ?, ?, 'pending', ?)",
        )
        .bind(action_id)
        .bind(account_id)
        .bind(tool)
        .bind(summary)
        .bind(&now)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Record a journaled mutation's outcome: `committed`, `ambiguous`, or
    /// `failed` (the table's CHECK constraint rejects anything else). Also
    /// stamps `resolved_at`. Resolving an unknown action id is a no-op, not
    /// an error: the pending write is best-effort and may not exist.
    pub async fn resolve_connector_action(
        &self,
        action_id: &str,
        status: &str,
    ) -> Result<(), sqlx::error::Error> {
        let now = timestamp();
        query("UPDATE connector_actions SET status = ?, resolved_at = ? WHERE action_id = ?")
            .bind(status)
            .bind(&now)
            .bind(action_id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub async fn get_connector_action(
        &self,
        action_id: &str,
    ) -> Result<Option<ConnectorActionRecord>, sqlx::error::Error> {
        let row = query(
            "SELECT action_id, account_id, tool, summary, status, created_at, resolved_at
             FROM connector_actions WHERE action_id = ?",
        )
        .bind(action_id)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.map(connector_action_from_row))
    }

    pub async fn set_connector_account_status(
        &self,
        account_id: &str,
        status: &str,
    ) -> Result<(), sqlx::error::Error> {
        let now = timestamp();
        query("UPDATE connector_accounts SET status = ?, updated_at = ? WHERE account_id = ?")
            .bind(status)
            .bind(&now)
            .bind(account_id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    /// Remove the account row plus everything keyed to it (triggers, polling
    /// cursors, autonomy grants, selected teams, and journaled actions) in
    /// one transaction.
    /// Clearing the grants matters for security: without it, reconnecting the
    /// same email would silently revive the per-job autonomous action servers
    /// the user granted to the old connection.
    pub async fn delete_connector_account(
        &self,
        account_id: &str,
    ) -> Result<(), sqlx::error::Error> {
        let mut tx = self.pool.begin().await?;
        query("DELETE FROM connector_triggers WHERE account_id = ?")
            .bind(account_id)
            .execute(&mut *tx)
            .await?;
        query("DELETE FROM trigger_cursors WHERE account_id = ?")
            .bind(account_id)
            .execute(&mut *tx)
            .await?;
        query("DELETE FROM connector_grants WHERE account_id = ?")
            .bind(account_id)
            .execute(&mut *tx)
            .await?;
        query("DELETE FROM connector_selected_teams WHERE account_id = ?")
            .bind(account_id)
            .execute(&mut *tx)
            .await?;
        query("DELETE FROM connector_actions WHERE account_id = ?")
            .bind(account_id)
            .execute(&mut *tx)
            .await?;
        query("DELETE FROM connector_accounts WHERE account_id = ?")
            .bind(account_id)
            .execute(&mut *tx)
            .await?;
        tx.commit().await
    }

    pub async fn routine_trust_get(
        &self,
        job_id: &str,
    ) -> Result<Option<RoutineTrustRecord>, sqlx::error::Error> {
        let row = query(
            "SELECT job_id, trust_mode, approval_run_count, autonomous_tools, approval_since, updated_at
             FROM routine_trust WHERE job_id = ?",
        )
        .bind(job_id)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.map(routine_trust_from_row))
    }

    /// Every routine currently in a given trust mode. Used to re-mint
    /// autonomous grants after an account (re)connects: a disconnect deletes the
    /// account's grants but keeps the `routine_trust` rows and the jobs' auto
    /// toolsets, so without this the routines stay autonomous in name only (their
    /// action servers never render again). Single-account mode makes "the
    /// connected account" the unambiguous target for the re-mint.
    pub async fn list_routine_trust_by_mode(
        &self,
        trust_mode: &str,
    ) -> Result<Vec<RoutineTrustRecord>, sqlx::error::Error> {
        let rows = query(
            "SELECT job_id, trust_mode, approval_run_count, autonomous_tools, approval_since, updated_at
             FROM routine_trust WHERE trust_mode = ?",
        )
        .bind(trust_mode)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows.into_iter().map(routine_trust_from_row).collect())
    }

    /// Set the trust mode (and autonomous tool grants) for a routine,
    /// preserving its earned approval-run count.
    pub async fn routine_trust_set(
        &self,
        job_id: &str,
        trust_mode: &str,
        autonomous_tools: &[String],
    ) -> Result<RoutineTrustRecord, sqlx::error::Error> {
        let now = timestamp();
        let tools_json = string_vec_to_json(autonomous_tools);
        let existing = self.routine_trust_get(job_id).await?;
        // Stamp the approval window when the routine enters approval mode. An
        // already-approval routine keeps its original stamp so re-affirming the
        // mode does not restart the earned-autonomy count; leaving approval
        // preserves the last stamp but it goes unused until approval returns.
        let approval_since = if trust_mode == "approval" {
            match &existing {
                Some(record)
                    if record.trust_mode == "approval" && record.approval_since.is_some() =>
                {
                    record.approval_since.clone()
                }
                _ => Some(now.clone()),
            }
        } else {
            existing
                .as_ref()
                .and_then(|record| record.approval_since.clone())
        };
        query(
            "INSERT INTO routine_trust (job_id, trust_mode, approval_run_count, autonomous_tools, approval_since, updated_at)
             VALUES (?, ?, 0, ?, ?, ?)
             ON CONFLICT(job_id) DO UPDATE SET
               trust_mode = excluded.trust_mode,
               autonomous_tools = excluded.autonomous_tools,
               approval_since = excluded.approval_since,
               updated_at = excluded.updated_at",
        )
        .bind(job_id)
        .bind(trust_mode)
        .bind(&tools_json)
        .bind(&approval_since)
        .bind(&now)
        .execute(&self.pool)
        .await?;
        self.routine_trust_get(job_id)
            .await?
            .ok_or(sqlx::Error::RowNotFound)
    }

    /// Credits one completed approval-mode run toward the autonomy threshold,
    /// exactly once per `(job_id, run_id)`. A run counts only when the routine
    /// is currently in approval mode and the run finished at or after the
    /// routine entered that mode, so background runs still count on the next
    /// observation while earlier read-only runs never do. Returns the current
    /// trust record (updated when newly credited), or `None` when the routine
    /// has no trust row.
    pub async fn record_approval_run(
        &self,
        job_id: &str,
        run_id: &str,
        run_ended_at: &str,
    ) -> Result<Option<RoutineTrustRecord>, sqlx::error::Error> {
        let Some(record) = self.routine_trust_get(job_id).await? else {
            return Ok(None);
        };
        if record.trust_mode != "approval" {
            return Ok(Some(record));
        }
        if let Some(since) = &record.approval_since {
            if run_finished_before(run_ended_at, since) {
                return Ok(Some(record));
            }
        }
        let now = timestamp();
        let mut tx = self.pool.begin().await?;
        let inserted = query(
            "INSERT OR IGNORE INTO connector_credited_runs (job_id, run_id, created_at)
             VALUES (?, ?, ?)",
        )
        .bind(job_id)
        .bind(run_id)
        .bind(&now)
        .execute(&mut *tx)
        .await?;
        if inserted.rows_affected() == 0 {
            // Already credited on an earlier observation; leave the count as is.
            tx.commit().await?;
            return Ok(Some(record));
        }
        query(
            "UPDATE routine_trust SET approval_run_count = approval_run_count + 1, updated_at = ?
             WHERE job_id = ?",
        )
        .bind(&now)
        .bind(job_id)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        self.routine_trust_get(job_id).await
    }

    pub async fn list_connector_triggers(
        &self,
        job_id: Option<&str>,
    ) -> Result<Vec<ConnectorTriggerRecord>, sqlx::error::Error> {
        let rows = match job_id {
            Some(job_id) => {
                query(
                    "SELECT id, job_id, kind, account_id, config, created_at
                     FROM connector_triggers WHERE job_id = ? ORDER BY created_at ASC",
                )
                .bind(job_id)
                .fetch_all(&self.pool)
                .await?
            }
            None => {
                query(
                    "SELECT id, job_id, kind, account_id, config, created_at
                     FROM connector_triggers ORDER BY created_at ASC",
                )
                .fetch_all(&self.pool)
                .await?
            }
        };
        Ok(rows.into_iter().map(connector_trigger_from_row).collect())
    }

    /// Replace the trigger for a routine and, when this creates an account's
    /// first email subscription, reset its Gmail history cursor atomically.
    ///
    /// `BEGIN IMMEDIATE` serializes competing replacements before the
    /// first-subscription check. Readers therefore observe either the complete
    /// old trigger+cursor state or the complete new state, and a failed write
    /// rolls both pieces back together.
    pub async fn replace_connector_trigger(
        &self,
        job_id: &str,
        kind: &str,
        account_id: &str,
        config_json: &str,
    ) -> Result<ConnectorTriggerRecord, sqlx::error::Error> {
        let mut transaction = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        let replace_result = async {
            let previous = query(
                "SELECT kind, account_id
                 FROM connector_triggers
                 WHERE job_id = ?",
            )
            .bind(job_id)
            .fetch_optional(&mut *transaction)
            .await?;
            let previous_email_account = previous.as_ref().and_then(|row| {
                (row.get::<String, _>("kind") == "email_received")
                    .then(|| row.get::<String, _>("account_id"))
            });
            // Check before deleting this job's old trigger. Editing an existing
            // email subscription for the same account must retain its cursor;
            // only the account's first active email subscription re-baselines.
            let reset_email_cursor = kind == "email_received"
                && query(
                    "SELECT 1
                     FROM connector_triggers
                     WHERE kind = 'email_received' AND account_id = ?
                     LIMIT 1",
                )
                .bind(account_id)
                .fetch_optional(&mut *transaction)
                .await?
                .is_none();

            query("DELETE FROM connector_triggers WHERE job_id = ?")
                .bind(job_id)
                .execute(&mut *transaction)
                .await?;
            if let Some(previous_account_id) =
                previous_email_account.filter(|previous_account_id| {
                    kind != "email_received" || previous_account_id != account_id
                })
            {
                query(
                    "DELETE FROM trigger_cursors
                     WHERE account_id = ? AND kind = ?",
                )
                .bind(previous_account_id)
                .bind(format!("email_received:{job_id}"))
                .execute(&mut *transaction)
                .await?;
            }

            let id = Uuid::new_v4().to_string();
            let now = timestamp();
            query(
                "INSERT INTO connector_triggers (id, job_id, kind, account_id, config, created_at)
                 VALUES (?, ?, ?, ?, ?, ?)",
            )
            .bind(&id)
            .bind(job_id)
            .bind(kind)
            .bind(account_id)
            .bind(config_json)
            .bind(&now)
            .execute(&mut *transaction)
            .await?;

            if reset_email_cursor {
                query(
                    "DELETE FROM trigger_cursors
                     WHERE account_id = ?
                       AND (kind = 'email_received' OR kind LIKE 'email_received:%')",
                )
                .bind(account_id)
                .execute(&mut *transaction)
                .await?;
            }

            let row = query(
                "SELECT id, job_id, kind, account_id, config, created_at
                 FROM connector_triggers WHERE id = ?",
            )
            .bind(&id)
            .fetch_one(&mut *transaction)
            .await?;
            Ok(connector_trigger_from_row(row))
        }
        .await;

        match replace_result {
            Ok(record) => {
                transaction.commit().await?;
                Ok(record)
            }
            Err(error) => match transaction.rollback().await {
                Ok(()) => Err(error),
                Err(rollback_error) => Err(sqlx::Error::Protocol(format!(
                    "connector trigger replacement failed ({error}); rollback also failed \
                     ({rollback_error})"
                ))),
            },
        }
    }

    pub async fn delete_connector_trigger(&self, id: &str) -> Result<bool, sqlx::error::Error> {
        let mut transaction = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        let trigger = query(
            "SELECT job_id, kind, account_id
             FROM connector_triggers
             WHERE id = ?",
        )
        .bind(id)
        .fetch_optional(&mut *transaction)
        .await?;
        let result = query("DELETE FROM connector_triggers WHERE id = ?")
            .bind(id)
            .execute(&mut *transaction)
            .await?;
        if let Some(trigger) =
            trigger.filter(|row| row.get::<String, _>("kind") == "email_received")
        {
            let job_id: String = trigger.get("job_id");
            query(
                "DELETE FROM trigger_cursors
                 WHERE account_id = ? AND kind = ?",
            )
            .bind(trigger.get::<String, _>("account_id"))
            .bind(format!("email_received:{job_id}"))
            .execute(&mut *transaction)
            .await?;
        }
        transaction.commit().await?;
        Ok(result.rows_affected() > 0)
    }

    pub async fn trigger_cursor(
        &self,
        account_id: &str,
        kind: &str,
    ) -> Result<Option<String>, sqlx::error::Error> {
        let row = query("SELECT cursor FROM trigger_cursors WHERE account_id = ? AND kind = ?")
            .bind(account_id)
            .bind(kind)
            .fetch_optional(&self.pool)
            .await?;
        Ok(row.map(|row| row.get("cursor")))
    }

    pub async fn set_trigger_cursor(
        &self,
        account_id: &str,
        kind: &str,
        cursor: &str,
    ) -> Result<(), sqlx::error::Error> {
        let now = timestamp();
        query(
            "INSERT INTO trigger_cursors (account_id, kind, cursor, updated_at)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(account_id, kind) DO UPDATE SET
               cursor = excluded.cursor,
               updated_at = excluded.updated_at",
        )
        .bind(account_id)
        .bind(kind)
        .bind(cursor)
        .bind(&now)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Remove the polling cursor for one account+kind so the next daemon poll
    /// re-establishes a baseline. Used when a new subscription must not fire for
    /// items that arrived before it existed (a fresh Gmail subscription reusing
    /// a stale per-account history cursor left by a deleted routine).
    pub async fn clear_trigger_cursor(
        &self,
        account_id: &str,
        kind: &str,
    ) -> Result<(), sqlx::error::Error> {
        query("DELETE FROM trigger_cursors WHERE account_id = ? AND kind = ?")
            .bind(account_id)
            .bind(kind)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    // --- Earned-autonomy grants -------------------------------------------
    //
    // Grant tokens are bearer secrets consumed by the bridge (auto-server
    // env) and the provider proxy (authorization). Methods here return
    // AppError so those callers get a stable code; the tokens themselves are
    // never logged.

    /// Every grant across all jobs. The bridge calls this to register a
    /// per-job auto MCP server for each grant.
    pub async fn list_connector_grants(&self) -> Result<Vec<ConnectorGrant>, AppError> {
        let rows = query(
            "SELECT job_id, provider, server_name, token, tools, account_id
             FROM connector_grants ORDER BY job_id ASC, provider ASC",
        )
        .fetch_all(&self.pool)
        .await?;
        Ok(rows.into_iter().map(connector_grant_from_row).collect())
    }

    /// Grants for a single job (used to compose the trust DTO's server list).
    pub async fn connector_grants_for_job(
        &self,
        job_id: &str,
    ) -> Result<Vec<ConnectorGrant>, AppError> {
        let rows = query(
            "SELECT job_id, provider, server_name, token, tools, account_id
             FROM connector_grants WHERE job_id = ? ORDER BY provider ASC",
        )
        .bind(job_id)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows.into_iter().map(connector_grant_from_row).collect())
    }

    /// Look up a grant by its token. The provider proxy calls this to
    /// authorize an incoming autonomous tool call.
    pub async fn find_connector_grant_by_token(
        &self,
        token: &str,
    ) -> Result<Option<ConnectorGrant>, AppError> {
        let row = query(
            "SELECT job_id, provider, server_name, token, tools, account_id
             FROM connector_grants WHERE token = ?",
        )
        .bind(token)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.map(connector_grant_from_row))
    }

    /// Upsert one grant on its (job_id, provider) primary key.
    pub async fn set_connector_grant(
        &self,
        grant: &ConnectorGrant,
        created_at: &str,
    ) -> Result<(), AppError> {
        let tools_json = string_vec_to_json(&grant.tools);
        query(
            "INSERT INTO connector_grants (job_id, provider, server_name, token, tools, account_id, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(job_id, provider) DO UPDATE SET
               server_name = excluded.server_name,
               token = excluded.token,
               tools = excluded.tools,
               account_id = excluded.account_id,
               created_at = excluded.created_at",
        )
        .bind(&grant.job_id)
        .bind(&grant.provider)
        .bind(&grant.server_name)
        .bind(&grant.token)
        .bind(&tools_json)
        .bind(&grant.account_id)
        .bind(created_at)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Drop every grant for a job (routine left autonomous mode, or its
    /// autonomous provider set shrank).
    pub async fn delete_connector_grants(&self, job_id: &str) -> Result<(), AppError> {
        query("DELETE FROM connector_grants WHERE job_id = ?")
            .bind(job_id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub async fn list_routine_browser_grants(
        &self,
    ) -> Result<Vec<RoutineBrowserGrantRecord>, AppError> {
        let rows = query(
            "SELECT job_id, server_name, token, enabled FROM routine_browser_grants ORDER BY job_id ASC",
        )
        .fetch_all(&self.pool)
        .await?;
        Ok(rows
            .into_iter()
            .map(|row| RoutineBrowserGrantRecord {
                job_id: row.get("job_id"),
                server_name: row.get("server_name"),
                token: row.get("token"),
                enabled: row.get("enabled"),
            })
            .collect())
    }

    pub async fn routine_browser_grant(
        &self,
        job_id: &str,
    ) -> Result<Option<RoutineBrowserGrantRecord>, AppError> {
        let row = query(
            "SELECT job_id, server_name, token, enabled FROM routine_browser_grants WHERE job_id = ?",
        )
        .bind(job_id)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.map(|row| RoutineBrowserGrantRecord {
            job_id: row.get("job_id"),
            server_name: row.get("server_name"),
            token: row.get("token"),
            enabled: row.get("enabled"),
        }))
    }

    pub async fn set_routine_browser_grant(
        &self,
        grant: &RoutineBrowserGrantRecord,
    ) -> Result<(), AppError> {
        query(
            "INSERT INTO routine_browser_grants (job_id, server_name, token, enabled, created_at)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(job_id) DO UPDATE SET
               server_name = excluded.server_name,
               token = excluded.token,
               enabled = excluded.enabled,
               created_at = excluded.created_at",
        )
        .bind(&grant.job_id)
        .bind(&grant.server_name)
        .bind(&grant.token)
        .bind(grant.enabled)
        .bind(timestamp())
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Remove every June-owned row keyed to a routine when the routine itself is
    /// deleted: its triggers (so the poller stops firing a missing job), its
    /// per-job event cursor, its trust row and credited-run ledger, and its
    /// autonomy grants, and its Browser use credential (so a deleted routine
    /// can never keep a per-job MCP server or a live token). Email cursors are
    /// per account, not per job, so they are left for the account's own
    /// lifecycle.
    pub async fn delete_routine_connector_state(
        &self,
        job_id: &str,
    ) -> Result<(), sqlx::error::Error> {
        let event_cursor_kind = format!("event_upcoming:{job_id}");
        let mut tx = self.pool.begin().await?;
        query("DELETE FROM connector_triggers WHERE job_id = ?")
            .bind(job_id)
            .execute(&mut *tx)
            .await?;
        query("DELETE FROM trigger_cursors WHERE kind = ?")
            .bind(&event_cursor_kind)
            .execute(&mut *tx)
            .await?;
        query("DELETE FROM connector_grants WHERE job_id = ?")
            .bind(job_id)
            .execute(&mut *tx)
            .await?;
        query("DELETE FROM connector_credited_runs WHERE job_id = ?")
            .bind(job_id)
            .execute(&mut *tx)
            .await?;
        query("DELETE FROM routine_trust WHERE job_id = ?")
            .bind(job_id)
            .execute(&mut *tx)
            .await?;
        query("DELETE FROM routine_browser_grants WHERE job_id = ?")
            .bind(job_id)
            .execute(&mut *tx)
            .await?;
        tx.commit().await
    }

    pub async fn list_folders(&self, profile: &str) -> Result<Vec<FolderDto>, sqlx::error::Error> {
        let rows = query(
            "SELECT id, name, description, instructions, memory_disabled, local_path, created_at, updated_at
             FROM folders
             WHERE profile = ? AND deleted_at IS NULL
             ORDER BY lower(name) ASC",
        )
        .bind(profile)
        .fetch_all(&self.pool)
        .await?;

        Ok(rows.into_iter().map(folder_from_row).collect())
    }

    pub async fn create_folder(
        &self,
        profile: &str,
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
            instructions: None,
            memory_disabled: false,
            local_path: None,
            created_at: now.clone(),
            updated_at: now,
        };

        query(
            "INSERT INTO folders (id, name, description, profile, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind(&folder.id)
        .bind(&folder.name)
        .bind(&folder.description)
        .bind(profile)
        .bind(&folder.created_at)
        .bind(&folder.updated_at)
        .execute(&self.pool)
        .await?;

        Ok(folder)
    }

    pub async fn create_linked_folders(
        &self,
        profile: &str,
        projects: &[(String, String)],
    ) -> Result<Vec<FolderDto>, sqlx::error::Error> {
        let mut tx = self.pool.begin().await?;
        let mut folders = Vec::with_capacity(projects.len());
        for (name, local_path) in projects {
            if let Some(row) = query(
                "SELECT id, name, description, instructions, memory_disabled, local_path, created_at, updated_at
                 FROM folders
                 WHERE profile = ? AND local_path = ? AND deleted_at IS NULL",
            )
            .bind(profile)
            .bind(local_path)
            .fetch_optional(&mut *tx)
            .await?
            {
                folders.push(folder_from_row(row));
                continue;
            }

            let now = timestamp();
            let folder = FolderDto {
                id: Uuid::new_v4().to_string(),
                name: name.trim().to_string(),
                description: None,
                instructions: None,
                memory_disabled: false,
                local_path: Some(local_path.to_string()),
                created_at: now.clone(),
                updated_at: now,
            };
            query(
                "INSERT INTO folders
                 (id, name, description, profile, local_path, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(&folder.id)
            .bind(&folder.name)
            .bind(&folder.description)
            .bind(profile)
            .bind(&folder.local_path)
            .bind(&folder.created_at)
            .bind(&folder.updated_at)
            .execute(&mut *tx)
            .await?;
            folders.push(folder);
        }
        tx.commit().await?;
        Ok(folders)
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
            "SELECT id, name, description, instructions, memory_disabled, local_path, created_at, updated_at
             FROM folders
             WHERE id = ? AND deleted_at IS NULL",
        )
        .bind(folder_id)
        .fetch_one(&self.pool)
        .await?;

        Ok(folder_from_row(row))
    }

    pub async fn folder_exists(&self, folder_id: &str) -> Result<bool, sqlx::error::Error> {
        let row = query("SELECT 1 FROM folders WHERE id = ? AND deleted_at IS NULL")
            .bind(folder_id)
            .fetch_optional(&self.pool)
            .await?;
        Ok(row.is_some())
    }

    pub async fn set_folder_instructions(
        &self,
        folder_id: &str,
        instructions: Option<&str>,
    ) -> Result<FolderDto, AppError> {
        let instructions = instructions
            .map(str::trim)
            .filter(|value| !value.is_empty());
        let result = query(
            "UPDATE folders
             SET instructions = ?, updated_at = ?
             WHERE id = ? AND deleted_at IS NULL",
        )
        .bind(instructions)
        .bind(timestamp())
        .bind(folder_id)
        .execute(&self.pool)
        .await?;
        if result.rows_affected() == 0 {
            return Err(AppError::new(
                "folder_not_found",
                "Folder was not found or has already been deleted.",
            ));
        }
        self.get_folder(folder_id).await
    }

    pub async fn set_folder_memory_disabled(
        &self,
        folder_id: &str,
        disabled: bool,
    ) -> Result<FolderDto, AppError> {
        let result = query(
            "UPDATE folders
             SET memory_disabled = ?, updated_at = ?
             WHERE id = ? AND deleted_at IS NULL",
        )
        .bind(if disabled { 1 } else { 0 })
        .bind(timestamp())
        .bind(folder_id)
        .execute(&self.pool)
        .await?;
        if result.rows_affected() == 0 {
            return Err(AppError::new(
                "folder_not_found",
                "Folder was not found or has already been deleted.",
            ));
        }
        self.get_folder(folder_id).await
    }

    async fn get_folder(&self, folder_id: &str) -> Result<FolderDto, AppError> {
        let row = query(
            "SELECT id, name, description, instructions, memory_disabled, local_path, created_at, updated_at
             FROM folders
             WHERE id = ? AND deleted_at IS NULL",
        )
        .bind(folder_id)
        .fetch_optional(&self.pool)
        .await?
        .ok_or_else(|| {
            AppError::new(
                "folder_not_found",
                "Folder was not found or has already been deleted.",
            )
        })?;
        Ok(folder_from_row(row))
    }

    pub async fn list_memories(
        &self,
        profile: &str,
        folder_id: Option<&str>,
        include_global: bool,
    ) -> Result<Vec<MemoryDto>, sqlx::error::Error> {
        let rows = match (folder_id, include_global) {
            (Some(folder_id), true) => {
                query(
                    "SELECT m.id, m.folder_id, m.content, m.source, m.created_at, m.updated_at
                     FROM memories m
                     WHERE m.profile = ?
                       AND (
                         m.folder_id IS NULL
                         OR (m.folder_id = ? AND EXISTS (
                           SELECT 1 FROM folders f
                           WHERE f.id = m.folder_id
                             AND f.profile = ?
                             AND f.deleted_at IS NULL
                         ))
                       )
                     ORDER BY m.created_at DESC, m.rowid DESC",
                )
                .bind(profile)
                .bind(folder_id)
                .bind(profile)
                .fetch_all(&self.pool)
                .await?
            }
            (Some(folder_id), false) => {
                query(
                    "SELECT m.id, m.folder_id, m.content, m.source, m.created_at, m.updated_at
                     FROM memories m
                     INNER JOIN folders f ON f.id = m.folder_id
                     WHERE m.profile = ?
                       AND m.folder_id = ?
                       AND f.profile = ?
                       AND f.deleted_at IS NULL
                     ORDER BY m.created_at DESC, m.rowid DESC",
                )
                .bind(profile)
                .bind(folder_id)
                .bind(profile)
                .fetch_all(&self.pool)
                .await?
            }
            (None, true) => {
                query(
                    "SELECT id, folder_id, content, source, created_at, updated_at
                     FROM memories
                     WHERE profile = ?
                     ORDER BY created_at DESC, rowid DESC",
                )
                .bind(profile)
                .fetch_all(&self.pool)
                .await?
            }
            (None, false) => {
                query(
                    "SELECT id, folder_id, content, source, created_at, updated_at
                     FROM memories
                     WHERE profile = ? AND folder_id IS NULL
                     ORDER BY created_at DESC, rowid DESC",
                )
                .bind(profile)
                .fetch_all(&self.pool)
                .await?
            }
        };
        Ok(rows.into_iter().map(memory_from_row).collect())
    }

    pub async fn create_memory(
        &self,
        profile: &str,
        folder_id: Option<&str>,
        content: &str,
        source: &str,
    ) -> Result<MemoryDto, AppError> {
        let now = timestamp();
        let memory = MemoryDto {
            id: Uuid::new_v4().to_string(),
            folder_id: folder_id.map(str::to_string),
            content: content.trim().to_string(),
            source: source.to_string(),
            created_at: now.clone(),
            updated_at: now,
        };
        let result = if let Some(folder_id) = folder_id {
            query(
                "INSERT INTO memories
                   (id, profile, folder_id, content, source, created_at, updated_at)
                 SELECT ?, ?, ?, ?, ?, ?, ?
                 WHERE EXISTS (
                   SELECT 1 FROM folders
                   WHERE id = ?
                     AND profile = ?
                     AND deleted_at IS NULL
                     AND memory_disabled = 0
                 )",
            )
            .bind(&memory.id)
            .bind(profile)
            .bind(&memory.folder_id)
            .bind(&memory.content)
            .bind(&memory.source)
            .bind(&memory.created_at)
            .bind(&memory.updated_at)
            .bind(folder_id)
            .bind(profile)
            .execute(&self.pool)
            .await?
        } else {
            query(
                "INSERT INTO memories
                   (id, profile, folder_id, content, source, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(&memory.id)
            .bind(profile)
            .bind(&memory.folder_id)
            .bind(&memory.content)
            .bind(&memory.source)
            .bind(&memory.created_at)
            .bind(&memory.updated_at)
            .execute(&self.pool)
            .await?
        };
        if result.rows_affected() == 0 {
            return Err(self
                .memory_scope_write_error(profile, folder_id.expect("scoped insert"))
                .await?);
        }
        Ok(memory)
    }

    pub async fn update_memory(
        &self,
        profile: &str,
        id: &str,
        content: &str,
    ) -> Result<MemoryDto, AppError> {
        let result = query(
            "UPDATE memories
             SET content = ?, updated_at = ?
             WHERE id = ?
               AND profile = ?
               AND (
                 folder_id IS NULL
                 OR EXISTS (
                   SELECT 1 FROM folders
                   WHERE folders.id = memories.folder_id
                     AND folders.profile = ?
                     AND folders.deleted_at IS NULL
                     AND folders.memory_disabled = 0
                 )
               )",
        )
        .bind(content.trim())
        .bind(timestamp())
        .bind(id)
        .bind(profile)
        .bind(profile)
        .execute(&self.pool)
        .await?;
        if result.rows_affected() == 0 {
            let folder_id = query("SELECT folder_id FROM memories WHERE id = ? AND profile = ?")
                .bind(id)
                .bind(profile)
                .fetch_optional(&self.pool)
                .await?
                .ok_or_else(|| AppError::new("memory_not_found", "Memory was not found."))?
                .get::<Option<String>, _>("folder_id");
            if let Some(folder_id) = folder_id {
                return Err(self.memory_scope_write_error(profile, &folder_id).await?);
            }
            return Err(AppError::new("memory_not_found", "Memory was not found."));
        }
        let row = query(
            "SELECT id, folder_id, content, source, created_at, updated_at
             FROM memories
             WHERE id = ? AND profile = ?",
        )
        .bind(id)
        .bind(profile)
        .fetch_one(&self.pool)
        .await?;
        Ok(memory_from_row(row))
    }

    async fn memory_scope_write_error(
        &self,
        profile: &str,
        folder_id: &str,
    ) -> Result<AppError, sqlx::error::Error> {
        let memory_disabled = query(
            "SELECT memory_disabled
             FROM folders
             WHERE id = ? AND profile = ? AND deleted_at IS NULL",
        )
        .bind(folder_id)
        .bind(profile)
        .fetch_optional(&self.pool)
        .await?
        .map(|row| row.get::<i64, _>("memory_disabled") != 0);
        Ok(if memory_disabled == Some(true) {
            AppError::new("memory_disabled", "Memory is disabled for this scope.")
        } else {
            AppError::new(
                "folder_not_found",
                "Folder was not found or has already been deleted.",
            )
        })
    }

    pub async fn delete_memory(&self, profile: &str, id: &str) -> Result<(), AppError> {
        let mut tx = self.pool.begin().await?;
        let result = query("DELETE FROM memories WHERE id = ? AND profile = ?")
            .bind(id)
            .bind(profile)
            .execute(&mut *tx)
            .await?;
        if result.rows_affected() == 0 {
            return Err(AppError::new("memory_not_found", "Memory was not found."));
        }
        query("INSERT INTO memory_tombstones (id, deleted_at) VALUES (?, ?)")
            .bind(id)
            .bind(timestamp())
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        Ok(())
    }

    pub async fn create_note(
        &self,
        profile: &str,
        folder_id: Option<String>,
    ) -> Result<NoteDto, sqlx::error::Error> {
        let id = Uuid::new_v4().to_string();
        self.create_note_with_id(profile, folder_id, &id).await
    }

    pub async fn create_note_with_id(
        &self,
        profile: &str,
        folder_id: Option<String>,
        id: &str,
    ) -> Result<NoteDto, sqlx::error::Error> {
        let now = timestamp();

        let mut tx = self.pool.begin().await?;
        query(
            "INSERT OR IGNORE INTO notes (id, title, processing_status, profile, created_at, updated_at)
             VALUES (?, '', 'draft', ?, ?, ?)",
        )
        .bind(id)
        .bind(profile)
        .bind(&now)
        .bind(&now)
        .execute(&mut *tx)
        .await?;

        if let Some(folder_id) = folder_id {
            // A stale surface (e.g. a project tab saved under another profile)
            // can still hand over its folder id after a switch. Folders are
            // profile-scoped, so only file the note when the folder belongs to
            // the same profile; otherwise the note is created unfiled rather
            // than leaking a cross-profile association.
            query(
                "INSERT OR IGNORE INTO note_folders (note_id, folder_id, assigned_at)
                 SELECT ?, id, ? FROM folders
                 WHERE id = ? AND profile = ? AND deleted_at IS NULL",
            )
            .bind(id)
            .bind(&now)
            .bind(folder_id)
            .bind(profile)
            .execute(&mut *tx)
            .await?;
        }

        tx.commit().await?;
        self.get_note(id).await
    }

    pub async fn get_note(&self, note_id: &str) -> Result<NoteDto, sqlx::error::Error> {
        let row = query(
            "SELECT id, title, generated_content, edited_content, active_tab, processing_status, created_at, updated_at, last_error,
                    calendar_event_id, calendar_event_title, calendar_event_start_at,
                    calendar_event_end_at, calendar_account_email
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
        let processing_status =
            ProcessingStatus::from(row.get::<String, _>("processing_status").as_str());
        // Selecting the strongest retry session is intentionally more
        // expensive than the ordinary note hydration queries. Only failed
        // notes render Retry; processing polls and ready-note fetches should
        // not pay for the aggregate job/generation ranking query.
        let retry_recording_session_id = if processing_status == ProcessingStatus::Failed {
            self.retry_recording_session_id(note_id).await?
        } else {
            None
        };

        Ok(NoteDto {
            id: row.get("id"),
            title: title.clone(),
            preview: preview_for(&title, &content),
            processing_status,
            folder_ids,
            created_at: row.get("created_at"),
            updated_at: row.get("updated_at"),
            duration_ms: None,
            calendar_event: note_calendar_event_from_row(&row),
            generated_content: row.get("generated_content"),
            edited_content: row.get("edited_content"),
            transcript: self.latest_transcript(note_id).await?,
            transcript_coverage: self.transcript_coverage(note_id).await?,
            source_transcripts: self.source_transcripts(note_id).await?,
            recording: None,
            audio: self.latest_audio_artifact(note_id).await?,
            audio_sources: self.latest_audio_sources(note_id).await?,
            active_tab: row.get("active_tab"),
            last_error: row.get("last_error"),
            queued_recordings: 0,
            retry_recording_session_id,
        })
    }

    /// Persist the event provenance even when the user has already supplied a
    /// title. The calendar title only fills an untouched note title, so a
    /// background match can never clobber text typed while the request ran.
    pub async fn associate_note_with_calendar_event(
        &self,
        note_id: &str,
        expected_title: &str,
        event: &NoteCalendarEventDto,
    ) -> Result<bool, sqlx::error::Error> {
        let result = query(
            "UPDATE notes
             SET title = CASE WHEN ? = 1 AND title = ? THEN ? ELSE title END,
                 calendar_event_id = ?, calendar_event_title = ?,
                 calendar_event_start_at = ?, calendar_event_end_at = ?,
                 calendar_account_email = ?, updated_at = ?
             WHERE id = ? AND calendar_event_id IS NULL",
        )
        .bind(i64::from(expected_title.trim().is_empty()))
        .bind(expected_title)
        .bind(&event.title)
        .bind(&event.event_id)
        .bind(&event.title)
        .bind(&event.start_at)
        .bind(&event.end_at)
        .bind(&event.account_email)
        .bind(timestamp())
        .bind(note_id)
        .execute(&self.pool)
        .await?;
        Ok(result.rows_affected() > 0)
    }

    pub async fn list_notes(
        &self,
        profile: &str,
        folder_id: Option<String>,
        limit: i64,
        cursor: Option<String>,
    ) -> Result<ListNotesResponse, sqlx::error::Error> {
        let cursor = cursor
            .as_deref()
            .map(decode_list_notes_cursor)
            .transpose()?;
        let page_size = usize::try_from(limit).ok();
        let fetch_limit = page_size
            .map(|_| limit.saturating_add(1))
            // Preserve the existing SQLite `LIMIT -1` behavior for callers
            // that explicitly request an unbounded list.
            .unwrap_or(limit);

        // `char(...)` is the Unicode White_Space set used by Rust's
        // `char::is_whitespace`. Keeping the blank-content check in SQL lets
        // this projection match `preview_for` exactly without selecting either
        // full note body.
        let mut list_query = QueryBuilder::<Sqlite>::new(format!(
            "WITH page AS (
                 SELECT n.rowid AS note_rowid, n.id, n.title,
                        substr(
                            CASE
                                WHEN trim(
                                    COALESCE(n.edited_content, n.generated_content, ''),
                                    char(9, 10, 11, 12, 13, 32, 133, 160, 5760,
                                         8192, 8193, 8194, 8195, 8196, 8197,
                                         8198, 8199, 8200, 8201, 8202, 8232,
                                         8233, 8239, 8287, 12288)
                                ) = ''
                                THEN n.title
                                ELSE COALESCE(n.edited_content, n.generated_content, '')
                            END,
                            1,
                            {NOTE_PREVIEW_CHAR_LIMIT}
                        ) AS preview,
                        n.processing_status, n.created_at, n.updated_at
                 FROM notes n"
        ));
        if folder_id.is_some() {
            list_query.push(
                "
                 INNER JOIN note_folders nf_filter ON nf_filter.note_id = n.id",
            );
        }
        list_query.push(
            "
                 WHERE n.profile = ",
        );
        list_query.push_bind(profile);
        if let Some(folder_id) = folder_id {
            list_query.push(" AND nf_filter.folder_id = ");
            list_query.push_bind(folder_id);
        }
        if let Some(cursor) = &cursor {
            list_query.push(" AND (n.created_at < ");
            list_query.push_bind(&cursor.created_at);
            list_query.push(" OR (n.created_at = ");
            list_query.push_bind(&cursor.created_at);
            list_query.push(" AND n.rowid < ");
            list_query.push_bind(cursor.rowid);
            list_query.push("))");
        }
        list_query.push(
            "
                 ORDER BY n.created_at DESC, n.rowid DESC
                 LIMIT ",
        );
        list_query.push_bind(fetch_limit);
        list_query.push(
            "
             )
             SELECT page.note_rowid, page.id, page.title, page.preview,
                    page.processing_status, page.created_at, page.updated_at,
                    CASE WHEN f.id IS NOT NULL THEN nf.folder_id END AS folder_id
             FROM page
             LEFT JOIN note_folders nf ON nf.note_id = page.id
             LEFT JOIN folders f
               ON f.id = nf.folder_id AND f.deleted_at IS NULL
             ORDER BY page.created_at DESC, page.note_rowid DESC, nf.assigned_at ASC",
        );

        let rows = list_query.build().fetch_all(&self.pool).await?;
        let mut items_with_cursors: Vec<(NoteListItemDto, ListNotesCursor)> =
            Vec::with_capacity(rows.len());
        for row in rows {
            let id: String = row.get("id");
            let folder_id = row.try_get::<Option<String>, _>("folder_id")?;
            if let Some((item, _)) = items_with_cursors.last_mut() {
                if item.id == id {
                    if let Some(folder_id) = folder_id {
                        item.folder_ids.push(folder_id);
                    }
                    continue;
                }
            }

            let created_at: String = row.get("created_at");
            items_with_cursors.push((
                NoteListItemDto {
                    id,
                    title: row.get("title"),
                    preview: row.get("preview"),
                    processing_status: ProcessingStatus::from(
                        row.get::<String, _>("processing_status").as_str(),
                    ),
                    folder_ids: folder_id.into_iter().collect(),
                    created_at: created_at.clone(),
                    updated_at: row.get("updated_at"),
                    duration_ms: None,
                },
                ListNotesCursor {
                    version: LIST_NOTES_CURSOR_VERSION,
                    created_at,
                    rowid: row.get("note_rowid"),
                },
            ));
        }

        let has_more = page_size.is_some_and(|page_size| items_with_cursors.len() > page_size);
        if let Some(page_size) = page_size {
            items_with_cursors.truncate(page_size);
        }
        let next_cursor = if has_more {
            items_with_cursors
                .last()
                .map(|(_, cursor)| encode_list_notes_cursor(cursor))
                .transpose()?
        } else {
            None
        };

        Ok(ListNotesResponse {
            items: items_with_cursors
                .into_iter()
                .map(|(item, _)| item)
                .collect(),
            next_cursor,
        })
    }

    pub async fn assign_note_to_folder(
        &self,
        profile: &str,
        note_id: &str,
        folder_id: &str,
    ) -> Result<NoteDto, AppError> {
        let mut transaction = self.pool.begin().await?;
        let matches_active_profile = query(
            "SELECT 1
             FROM notes n
             INNER JOIN folders f ON f.id = ?
             WHERE n.id = ?
               AND n.profile = ?
               AND f.profile = ?
               AND f.deleted_at IS NULL",
        )
        .bind(folder_id)
        .bind(note_id)
        .bind(profile)
        .bind(profile)
        .fetch_optional(&mut *transaction)
        .await?
        .is_some();
        if !matches_active_profile {
            return Err(AppError::new(
                "note_folder_profile_mismatch",
                "The note and project must belong to the active profile.",
            ));
        }

        query(
            "INSERT OR IGNORE INTO note_folders (note_id, folder_id, assigned_at) VALUES (?, ?, ?)",
        )
        .bind(note_id)
        .bind(folder_id)
        .bind(timestamp())
        .execute(&mut *transaction)
        .await?;
        transaction.commit().await?;
        Ok(self.get_note(note_id).await?)
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
        profile: &str,
        session_id: &str,
        folder_id: &str,
    ) -> Result<(), AppError> {
        let mut transaction = self.pool.begin().await?;
        let matches_active_profile = query(
            "SELECT 1
             FROM folders f
             LEFT JOIN session_profiles sp ON sp.session_id = ?
             WHERE f.id = ?
               AND f.profile = ?
               AND f.deleted_at IS NULL
               AND COALESCE(sp.profile, 'default') = ?",
        )
        .bind(session_id)
        .bind(folder_id)
        .bind(profile)
        .bind(profile)
        .fetch_optional(&mut *transaction)
        .await?
        .is_some();
        if !matches_active_profile {
            return Err(AppError::new(
                "session_folder_profile_mismatch",
                "The session and project must belong to the active profile.",
            ));
        }

        query(
            "INSERT OR IGNORE INTO session_folders (session_id, folder_id, assigned_at) VALUES (?, ?, ?)",
        )
        .bind(session_id)
        .bind(folder_id)
        .bind(timestamp())
        .execute(&mut *transaction)
        .await?;
        transaction.commit().await?;
        Ok(())
    }

    pub async fn list_session_profiles(
        &self,
    ) -> Result<Vec<SessionProfileDto>, sqlx::error::Error> {
        let rows = query(
            "SELECT session_id, profile
             FROM session_profiles
             ORDER BY assigned_at ASC",
        )
        .fetch_all(&self.pool)
        .await?;
        Ok(rows
            .into_iter()
            .map(|row| SessionProfileDto {
                session_id: row.get("session_id"),
                profile: row.get("profile"),
            })
            .collect())
    }

    pub async fn assign_session_to_profile(
        &self,
        session_id: &str,
        profile: &str,
    ) -> Result<(), sqlx::error::Error> {
        query(
            "INSERT INTO session_profiles (session_id, profile, assigned_at)
             VALUES (?, ?, ?)
             ON CONFLICT(session_id) DO UPDATE SET
               profile = excluded.profile,
               assigned_at = excluded.assigned_at",
        )
        .bind(session_id)
        .bind(profile)
        .bind(timestamp())
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn profile_data_summary(
        &self,
        profile: &str,
    ) -> Result<ProfileDataSummaryDto, sqlx::error::Error> {
        Ok(ProfileDataSummaryDto {
            notes: count_profile_rows(&self.pool, "notes", profile).await?,
            dictation: count_profile_rows(&self.pool, "dictation_history", profile).await?,
            folders: count_profile_rows(&self.pool, "folders", profile).await?,
            sessions: count_profile_rows(&self.pool, "session_profiles", profile).await?,
            memories: count_profile_rows(&self.pool, "memories", profile).await?,
        })
    }

    pub async fn move_profile_data_to_default(
        &self,
        profile: &str,
    ) -> Result<(), sqlx::error::Error> {
        if profile == "default" {
            return Ok(());
        }

        let mut transaction = self.pool.begin().await?;
        query("UPDATE notes SET profile = 'default' WHERE profile = ?")
            .bind(profile)
            .execute(&mut *transaction)
            .await?;
        query("UPDATE dictation_history SET profile = 'default' WHERE profile = ?")
            .bind(profile)
            .execute(&mut *transaction)
            .await?;
        let duplicate_linked_folders = query(
            "SELECT source.id AS source_id, target.id AS target_id
             FROM folders source
             INNER JOIN folders target
               ON target.profile = 'default'
              AND target.local_path = source.local_path
              AND target.deleted_at IS NULL
             WHERE source.profile = ?
               AND source.local_path IS NOT NULL
               AND source.deleted_at IS NULL",
        )
        .bind(profile)
        .fetch_all(&mut *transaction)
        .await?;
        for row in duplicate_linked_folders {
            let source_id = row.get::<String, _>("source_id");
            let target_id = row.get::<String, _>("target_id");
            query(
                "INSERT OR IGNORE INTO note_folders (note_id, folder_id, assigned_at)
                 SELECT note_id, ?, assigned_at FROM note_folders WHERE folder_id = ?",
            )
            .bind(&target_id)
            .bind(&source_id)
            .execute(&mut *transaction)
            .await?;
            query("DELETE FROM note_folders WHERE folder_id = ?")
                .bind(&source_id)
                .execute(&mut *transaction)
                .await?;
            query(
                "INSERT OR IGNORE INTO session_folders (session_id, folder_id, assigned_at)
                 SELECT session_id, ?, assigned_at FROM session_folders WHERE folder_id = ?",
            )
            .bind(&target_id)
            .bind(&source_id)
            .execute(&mut *transaction)
            .await?;
            query("DELETE FROM session_folders WHERE folder_id = ?")
                .bind(&source_id)
                .execute(&mut *transaction)
                .await?;
            query("UPDATE memories SET folder_id = ? WHERE folder_id = ?")
                .bind(&target_id)
                .bind(&source_id)
                .execute(&mut *transaction)
                .await?;
            query("DELETE FROM folders WHERE id = ?")
                .bind(&source_id)
                .execute(&mut *transaction)
                .await?;
        }
        query("UPDATE folders SET profile = 'default' WHERE profile = ?")
            .bind(profile)
            .execute(&mut *transaction)
            .await?;
        query("UPDATE memories SET profile = 'default' WHERE profile = ?")
            .bind(profile)
            .execute(&mut *transaction)
            .await?;
        query("UPDATE session_profiles SET profile = 'default' WHERE profile = ?")
            .bind(profile)
            .execute(&mut *transaction)
            .await?;
        transaction.commit().await?;
        Ok(())
    }

    pub async fn delete_profile_data(&self, profile: &str) -> Result<(), sqlx::error::Error> {
        if profile == "default" {
            return Ok(());
        }

        let mut transaction = self.pool.begin().await?;
        query("DELETE FROM notes WHERE profile = ?")
            .bind(profile)
            .execute(&mut *transaction)
            .await?;
        query("DELETE FROM dictation_history WHERE profile = ?")
            .bind(profile)
            .execute(&mut *transaction)
            .await?;
        query(
            "INSERT OR IGNORE INTO memory_tombstones (id, deleted_at)
             SELECT id, ? FROM memories WHERE profile = ?",
        )
        .bind(timestamp())
        .bind(profile)
        .execute(&mut *transaction)
        .await?;
        query("DELETE FROM memories WHERE profile = ?")
            .bind(profile)
            .execute(&mut *transaction)
            .await?;
        query("DELETE FROM folders WHERE profile = ?")
            .bind(profile)
            .execute(&mut *transaction)
            .await?;
        query("DELETE FROM session_profiles WHERE profile = ?")
            .bind(profile)
            .execute(&mut *transaction)
            .await?;
        transaction.commit().await?;
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

    pub async fn list_completed_sessions(
        &self,
    ) -> Result<Vec<CompletedSessionDto>, sqlx::error::Error> {
        let rows = query(
            "SELECT session_id, completed_at FROM completed_sessions ORDER BY completed_at DESC",
        )
        .fetch_all(&self.pool)
        .await?;
        Ok(rows
            .into_iter()
            .map(|row| CompletedSessionDto {
                session_id: row.get("session_id"),
                completed_at: row.get("completed_at"),
            })
            .collect())
    }

    pub async fn set_session_completed(
        &self,
        session_id: &str,
        completed: bool,
    ) -> Result<(), sqlx::error::Error> {
        if completed {
            // Idempotent: keep the original completion time if the session is
            // already complete, so a redundant mark never re-sorts the Completed
            // list. A genuine re-completion goes through unmark (row deleted)
            // then mark, which inserts a fresh timestamp.
            query(
                "INSERT INTO completed_sessions (session_id, completed_at) VALUES (?, ?)
                 ON CONFLICT(session_id) DO NOTHING",
            )
            .bind(session_id)
            .bind(timestamp())
            .execute(&self.pool)
            .await?;
        } else {
            query("DELETE FROM completed_sessions WHERE session_id = ?")
                .bind(session_id)
                .execute(&self.pool)
                .await?;
        }
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
        profile: &str,
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
            "INSERT INTO dictation_history (id, text, language, provider, profile, created_at)
             VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind(&item.id)
        .bind(&item.text)
        .bind(&item.language)
        .bind(&item.provider)
        .bind(profile)
        .bind(&item.created_at)
        .execute(&self.pool)
        .await?;
        self.prune_old_dictation_history().await?;
        Ok(Some(item))
    }

    pub async fn list_dictation_history(
        &self,
        profile: &str,
        limit: i64,
    ) -> Result<ListDictationHistoryResponse, sqlx::error::Error> {
        self.prune_old_dictation_history().await?;
        let rows = query(
            "SELECT id, text, language, provider, created_at
             FROM dictation_history
             WHERE profile = ? AND created_at >= ?
             ORDER BY created_at DESC, rowid DESC
             LIMIT ?",
        )
        .bind(profile)
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
    ) -> Result<NotePatchDto, sqlx::error::Error> {
        let mut update = QueryBuilder::<Sqlite>::new("UPDATE notes SET ");
        // An omitted title is a patch omission, not a request to rewrite the
        // caller's snapshot. Leave the column out so a delayed content
        // autosave cannot clobber a title committed by note generation.
        if let Some(title) = title {
            update.push("title = ").push_bind(title).push(", ");
        }
        update
            .push("edited_content = COALESCE(")
            .push_bind(edited_content)
            .push(", edited_content), active_tab = COALESCE(")
            .push_bind(active_tab)
            .push(", active_tab, 'notes'), updated_at = ")
            .push_bind(timestamp())
            .push(" WHERE id = ")
            .push_bind(note_id)
            .push(
                " RETURNING id, title, generated_content, edited_content, active_tab, updated_at",
            );
        let row = update.build().fetch_one(&self.pool).await?;
        let title: String = row.get("title");
        let edited_content = row.try_get::<Option<String>, _>("edited_content")?;
        let generated_content = row.try_get::<Option<String>, _>("generated_content")?;
        let content = edited_content
            .as_deref()
            .or(generated_content.as_deref())
            .unwrap_or_default();

        Ok(NotePatchDto {
            id: row.get("id"),
            preview: preview_for(&title, content),
            title,
            edited_content,
            active_tab: row.get("active_tab"),
            updated_at: row.get("updated_at"),
        })
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

    /// Recording files owned by a profile's notes, for the delete-permanently
    /// path (delete_profile_data removes the rows; the caller removes these).
    pub async fn audio_artifact_paths_for_profile(
        &self,
        profile: &str,
    ) -> Result<Vec<String>, sqlx::error::Error> {
        let rows = query(
            "SELECT path
             FROM (
               SELECT a.path AS path
               FROM audio_artifacts a
               JOIN notes n ON n.id = a.note_id
               WHERE n.profile = ?
               UNION
               SELECT a.partial_path AS path
               FROM audio_artifacts a
               JOIN notes n ON n.id = a.note_id
               WHERE n.profile = ? AND a.partial_path IS NOT NULL
               UNION
               SELECT rs.final_path AS path
               FROM recording_sessions rs
               JOIN notes n ON n.id = rs.note_id
               WHERE n.profile = ? AND rs.final_path IS NOT NULL
               UNION
               SELECT rs.partial_path AS path
               FROM recording_sessions rs
               JOIN notes n ON n.id = rs.note_id
               WHERE n.profile = ? AND rs.partial_path IS NOT NULL
             )
             WHERE path IS NOT NULL AND trim(path) != ''",
        )
        .bind(profile)
        .bind(profile)
        .bind(profile)
        .bind(profile)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows.into_iter().map(|row| row.get("path")).collect())
    }

    pub(crate) async fn note_audio_export_selection(
        &self,
        note_id: &str,
    ) -> Result<Option<NoteAudioExportSelection>, sqlx::error::Error> {
        let rows = query(
            "SELECT n.id AS note_id, n.title, aa.path, aa.recording_session_id, aa.source
             FROM notes n
             INNER JOIN audio_artifacts aa ON aa.note_id = n.id
             INNER JOIN recording_sessions rs
               ON rs.id = aa.recording_session_id
              AND rs.note_id = aa.note_id
             WHERE n.id = ?
               AND aa.status = 'valid'
               AND aa.format = 'wav'
               AND aa.size_bytes > 0
             ORDER BY rs.started_at ASC,
                      rs.id ASC,
                      CASE aa.source WHEN 'microphone' THEN 0 WHEN 'system' THEN 1 ELSE 2 END,
                      aa.id ASC",
        )
        .bind(note_id)
        .fetch_all(&self.pool)
        .await?;
        let Some(first) = rows.first() else {
            return Ok(None);
        };
        let note_id = first.get("note_id");
        let title = first.get("title");
        let sources = rows
            .into_iter()
            .map(|row| NoteAudioExportSource {
                path: row.get::<String, _>("path").into(),
                recording_session_id: row.get("recording_session_id"),
                source: row.get("source"),
            })
            .collect();
        Ok(Some(NoteAudioExportSelection {
            note_id,
            title,
            sources,
        }))
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

    /// Deletes a deterministic meeting-start draft only while it is still the
    /// untouched row created by native startup. The conditional update takes
    /// SQLite's write lock before deletion so a concurrent user edit cannot
    /// pass the check and then be removed.
    pub async fn delete_untouched_draft(&self, note_id: &str) -> Result<bool, sqlx::error::Error> {
        let mut tx = self.pool.begin().await?;
        let claimed = query(
            "UPDATE notes
             SET processing_status = 'failed'
             WHERE id = ?
               AND processing_status = 'draft'
               AND updated_at = created_at
               AND title = ''
               AND COALESCE(generated_content, '') = ''
               AND COALESCE(edited_content, '') = ''
               AND NOT EXISTS (SELECT 1 FROM note_folders WHERE note_id = ?)
               AND NOT EXISTS (
                 SELECT 1 FROM share_keys WHERE item_kind = 'note' AND item_id = ?
               )",
        )
        .bind(note_id)
        .bind(note_id)
        .bind(note_id)
        .execute(&mut *tx)
        .await?
        .rows_affected()
            == 1;
        if !claimed {
            tx.rollback().await?;
            return Ok(false);
        }
        delete_note_records(&mut tx, note_id).await?;
        tx.commit().await?;
        Ok(true)
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
        query(
            "INSERT INTO memory_tombstones (id, deleted_at)
             SELECT id, ? FROM memories WHERE folder_id = ?",
        )
        .bind(&now)
        .bind(folder_id)
        .execute(&mut *tx)
        .await?;
        query("DELETE FROM memories WHERE folder_id = ?")
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
    ) -> Result<String, sqlx::error::Error> {
        let row = query(
            "UPDATE notes
             SET processing_status = ?, last_error = ?, updated_at = ?
             WHERE id = ?
             RETURNING updated_at",
        )
        .bind(status.as_db())
        .bind(last_error)
        .bind(timestamp())
        .bind(note_id)
        .fetch_one(&self.pool)
        .await?;
        Ok(row.get("updated_at"))
    }

    pub async fn set_note_transcription_warning(
        &self,
        note_id: &str,
        warning: &str,
    ) -> Result<bool, sqlx::error::Error> {
        let result = query(
            "UPDATE notes
             SET last_error = ?, updated_at = ?
             WHERE id = ?
               AND processing_status = 'transcribing'
               AND last_error IS NULL",
        )
        .bind(warning)
        .bind(timestamp())
        .bind(note_id)
        .execute(&self.pool)
        .await?;
        Ok(result.rows_affected() > 0)
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
        let expected_edited_content = current.edited_content.clone();
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
        // Title and edited content are user-owned. Apply generation's changes
        // only while the exact snapshots it read are still current; a NULL
        // edited-content snapshot never authorizes a write to that column.
        query(
            "UPDATE notes
             SET title = CASE
                     WHEN title IS ? THEN ?
                     ELSE title
                 END,
                 generated_content = ?,
                 edited_content = CASE
                     WHEN ? IS NULL THEN edited_content
                     WHEN edited_content IS ? THEN ?
                     ELSE edited_content
                 END,
                 active_tab = 'notes',
                 processing_status = 'ready',
                 last_error = NULL,
                 updated_at = ?
             WHERE id = ?",
        )
        .bind(current.title.as_str())
        .bind(title)
        .bind(next_generated_content)
        .bind(expected_edited_content.as_deref())
        .bind(expected_edited_content.as_deref())
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
        // A new capture may be stacked while an earlier recording from this
        // note is still processing. Keep that active stage and its warning;
        // the recording session row is the source of truth for live capture.
        query(
            "UPDATE notes
             SET processing_status = 'recording', last_error = NULL, updated_at = ?
             WHERE id = ?
               AND processing_status NOT IN ('transcribing', 'generating')",
        )
        .bind(timestamp())
        .bind(note_id)
        .execute(&self.pool)
        .await?;
        if let Err(error) = self.add_checkpoint(session_id, "start", None).await {
            eprintln!(
                "failed to persist start checkpoint for recording session {session_id}: {error}"
            );
        }
        Ok(())
    }

    /// Publishes every row required to recover a newly started capture in one
    /// transaction. Capture itself is already live when this runs, so callers
    /// must stop it if this transaction fails.
    #[allow(clippy::too_many_arguments)]
    pub async fn create_recording_start(
        &self,
        note_id: &str,
        session_id: &str,
        source_mode: RecordingSourceMode,
        partial_path: &str,
        final_path: &str,
        device_label: Option<String>,
        sources: &[(String, String, String)],
    ) -> Result<(), sqlx::error::Error> {
        let now = timestamp();
        let mut tx = self.pool.begin().await?;
        query(
            "INSERT INTO recording_sessions (id, note_id, source_mode, status, started_at, expected_elapsed_ms, device_label, permission_state, partial_path, final_path)
             VALUES (?, ?, ?, 'recording', ?, 0, ?, 'granted', ?, ?)",
        )
        .bind(session_id)
        .bind(note_id)
        .bind(source_mode.as_db())
        .bind(&now)
        .bind(device_label)
        .bind(partial_path)
        .bind(final_path)
        .execute(&mut *tx)
        .await?;
        query(
            "UPDATE notes
             SET processing_status = 'recording', last_error = NULL, updated_at = ?
             WHERE id = ?
               AND processing_status NOT IN ('transcribing', 'generating')",
        )
        .bind(&now)
        .bind(note_id)
        .execute(&mut *tx)
        .await?;
        query(
            "INSERT INTO recording_checkpoints (id, recording_session_id, kind, created_at, details)
             VALUES (?, ?, 'start', ?, NULL)",
        )
        .bind(Uuid::new_v4().to_string())
        .bind(session_id)
        .bind(&now)
        .execute(&mut *tx)
        .await?;
        for (source, source_partial_path, source_final_path) in sources {
            query(
                "INSERT INTO audio_artifacts
                 (id, note_id, recording_session_id, source, partial_path, path, format, duration_ms, size_bytes, checksum, status, expected_duration_ms, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, 'wav', 0, 0, '', 'recording', 0, ?)",
            )
            .bind(Uuid::new_v4().to_string())
            .bind(note_id)
            .bind(session_id)
            .bind(source)
            .bind(source_partial_path)
            .bind(source_final_path)
            .bind(&now)
            .execute(&mut *tx)
            .await?;
        }
        tx.commit().await
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

    /// Select the strongest unprocessed recording session for a note. A note can
    /// accumulate a later, tiny recording after an earlier meeting fails; using
    /// artifact recency alone would make Retry permanently skip the meeting.
    pub async fn latest_valid_audio_artifact_paths(
        &self,
        note_id: &str,
    ) -> Result<Vec<(String, String, String, String, bool)>, sqlx::error::Error> {
        let Some(session_id) = self.retry_recording_session_id(note_id).await? else {
            return Ok(Vec::new());
        };
        self.valid_audio_artifact_paths_for_session(note_id, &session_id)
            .await
    }

    async fn retry_recording_session_id(
        &self,
        note_id: &str,
    ) -> Result<Option<String>, sqlx::error::Error> {
        let row = query(
            "SELECT aa.recording_session_id
             FROM audio_artifacts aa
             LEFT JOIN note_generation_blocks ngb
               ON ngb.note_id = aa.note_id
              AND ngb.recording_session_id = aa.recording_session_id
             LEFT JOIN note_transcription_jobs ntj
               ON ntj.note_id = aa.note_id
              AND ntj.recording_session_id = aa.recording_session_id
             WHERE aa.note_id = ? AND aa.status = 'valid'
             GROUP BY aa.recording_session_id
             ORDER BY
               CASE WHEN MAX(
                 CASE WHEN ntj.status IN ('pending', 'running', 'failed') THEN 1 ELSE 0 END
               ) = 1 THEN 0 ELSE 1 END,
               CASE WHEN MAX(ntj.id) IS NULL THEN 1 ELSE 0 END,
               MAX(ntj.updated_at) DESC,
               CASE WHEN MAX(ngb.id) IS NULL THEN 0 ELSE 1 END,
               MAX(aa.duration_ms) DESC,
               MAX(aa.created_at) DESC
             LIMIT 1",
        )
        .bind(note_id)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.map(|row| row.get("recording_session_id")))
    }

    pub async fn valid_audio_artifact_paths_for_session(
        &self,
        note_id: &str,
        session_id: &str,
    ) -> Result<Vec<(String, String, String, String, bool)>, sqlx::error::Error> {
        let rows = query(
            "SELECT aa.id, aa.source, aa.path, aa.recording_session_id, aa.validation_summary
             FROM audio_artifacts aa
             INNER JOIN recording_sessions rs ON rs.id = aa.recording_session_id
             WHERE aa.note_id = ? AND rs.note_id = ?
               AND aa.recording_session_id = ? AND aa.status = 'valid'
             ORDER BY CASE aa.source WHEN 'microphone' THEN 0 WHEN 'system' THEN 1 ELSE 2 END",
        )
        .bind(note_id)
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
            "SELECT id, recording_session_id, span_id, text, source_mode, source, start_ms, end_ms, turn_index, language, status, last_error
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
            recording_session_id: row.get("recording_session_id"),
            span_id: row.get("span_id"),
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
        }))
    }

    async fn source_transcripts(
        &self,
        note_id: &str,
    ) -> Result<Vec<TranscriptDto>, sqlx::error::Error> {
        let rows = query(
            "SELECT t.id, t.recording_session_id, t.span_id, t.text, t.source_mode, t.source, t.start_ms, t.end_ms, t.turn_index, t.language, t.status, t.last_error,
                    aa.validation_summary
             FROM transcripts t
             LEFT JOIN audio_artifacts aa ON aa.id = t.audio_artifact_id
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
                recording_session_id: row.get("recording_session_id"),
                span_id: row.get("span_id"),
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
            })
            .collect())
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
            "SELECT id, recording_session_id, span_id, text, source_mode, source, start_ms, end_ms, turn_index, language, status, last_error
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
                recording_session_id: row.get("recording_session_id"),
                span_id: row.get("span_id"),
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
            })
            .collect())
    }

    /// Current authoritative saved-audio rows only. Last-known-good backup
    /// rows deliberately stay visible during a failed replacement, but must
    /// never be reused as transcription cache or note-generation input.
    pub async fn certified_source_turn_transcripts_for_session(
        &self,
        session_id: &str,
    ) -> Result<Vec<TranscriptDto>, sqlx::error::Error> {
        let rows = query(
            "SELECT transcript.id, transcript.recording_session_id, transcript.span_id,
                    transcript.text, transcript.source_mode, transcript.source,
                    transcript.start_ms, transcript.end_ms, transcript.turn_index,
                    transcript.language, transcript.status, transcript.last_error
             FROM transcripts transcript
             INNER JOIN note_transcription_jobs job
               ON job.id = transcript.span_id
              AND job.transcript_id = transcript.id
              AND job.recording_session_id = transcript.recording_session_id
             WHERE transcript.recording_session_id = ?
               AND transcript.turn_index IS NOT NULL
               AND transcript.status = 'succeeded'
               AND job.status = 'succeeded'
               AND TRIM(transcript.text) != ''
             ORDER BY COALESCE(transcript.turn_index, 999999),
                      COALESCE(transcript.start_ms, 999999999),
                      transcript.created_at ASC",
        )
        .bind(session_id)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows
            .into_iter()
            .map(|row| TranscriptDto {
                id: row.get("id"),
                recording_session_id: row.get("recording_session_id"),
                span_id: row.get("span_id"),
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
            })
            .collect())
    }

    /// Reconcile the complete authoritative saved-audio plan for one recording
    /// session. Exact succeeded jobs are reusable; older ledger-certified rows
    /// may remain visible only as last-known-good output until their replacement
    /// Source plan commits. Pre-ledger rows are never certified here.
    pub async fn reconcile_note_transcription_jobs(
        &self,
        note_id: &str,
        session_id: &str,
        source_mode: RecordingSourceMode,
        plans: &[NoteTranscriptionJobPlan],
    ) -> Result<Vec<NoteTranscriptionJobRecord>, sqlx::error::Error> {
        // Reserve the SQLite writer before reading the current ledger. A
        // deferred read transaction can otherwise lose its snapshot upgrade
        // when another note commits concurrently (SQLITE_BUSY_SNAPSHOT).
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        let session_exists = query("SELECT 1 FROM recording_sessions WHERE id = ? AND note_id = ?")
            .bind(session_id)
            .bind(note_id)
            .fetch_optional(&mut *tx)
            .await?
            .is_some();
        if !session_exists {
            return Err(sqlx::Error::RowNotFound);
        }

        for (index, plan) in plans.iter().enumerate() {
            validate_note_transcription_plan(plan)?;
            if plans[..index]
                .iter()
                .any(|other| other.span_id == plan.span_id)
            {
                return Err(sqlx::Error::Protocol(format!(
                    "duplicate note transcription span id: {}",
                    plan.span_id
                )));
            }
            if plans[..index].iter().any(|other| {
                other.job_kind == NoteTranscriptionJobKind::Turn
                    && plan.job_kind == NoteTranscriptionJobKind::Turn
                    && other.source == plan.source
                    && other.turn_index == plan.turn_index
            }) {
                return Err(sqlx::Error::Protocol(format!(
                    "duplicate note transcription turn: {}:{}",
                    plan.source, plan.turn_index
                )));
            }
        }

        let now = timestamp();
        let mut current = Vec::with_capacity(plans.len());
        let mut preserved_transcripts: Vec<(String, NoteTranscriptionJobPlan)> = Vec::new();

        for plan in plans {
            let artifact = query(
                "SELECT checksum, source
                 FROM audio_artifacts
                 WHERE id = ? AND note_id = ? AND recording_session_id = ? AND status = 'valid'",
            )
            .bind(&plan.audio_artifact_id)
            .bind(note_id)
            .bind(session_id)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or(sqlx::Error::RowNotFound)?;
            let artifact_source: String = artifact.get("source");
            if artifact_source != plan.source {
                return Err(sqlx::Error::Protocol(format!(
                    "note transcription plan source {} does not match artifact source {}",
                    plan.source, artifact_source
                )));
            }
            let checksum: String = artifact.get("checksum");
            let input_fingerprint = note_transcription_input_fingerprint(&checksum, plan);
            let operation_id = format!("{}:{}", plan.span_id, input_fingerprint);

            let existing = query(
                "SELECT id, note_id, recording_session_id, audio_artifact_id, source, source_mode,
                        job_kind, start_ms, end_ms, turn_index, input_fingerprint,
                        configuration_fingerprint, operation_id, provider, max_chunk_ms,
                        pipeline_version, status, attempt_count, transcript_id, last_error,
                        created_at, updated_at, completed_at
                 FROM note_transcription_jobs WHERE id = ?",
            )
            .bind(&plan.span_id)
            .fetch_optional(&mut *tx)
            .await?
            .map(note_transcription_job_from_row);

            if let Some(existing) = existing.as_ref() {
                if existing.note_id != note_id || existing.recording_session_id != session_id {
                    return Err(sqlx::Error::Protocol(format!(
                        "note transcription span id belongs to another recording: {}",
                        plan.span_id
                    )));
                }
                if existing.status == NoteTranscriptionJobStatus::Running
                    && existing.input_fingerprint != input_fingerprint
                {
                    return Err(sqlx::Error::Protocol(format!(
                        "cannot change running note transcription job: {}",
                        plan.span_id
                    )));
                }
            }

            let mut certified_transcript_id = None;
            if let Some(existing) = existing.as_ref() {
                if existing.input_fingerprint == input_fingerprint
                    && existing.status == NoteTranscriptionJobStatus::Succeeded
                {
                    if let Some(transcript_id) = existing.transcript_id.as_deref() {
                        let valid = query(
                            "SELECT 1 FROM transcripts
                             WHERE id = ? AND recording_session_id = ?
                               AND status = 'succeeded' AND TRIM(text) != ''",
                        )
                        .bind(transcript_id)
                        .bind(session_id)
                        .fetch_optional(&mut *tx)
                        .await?
                        .is_some();
                        if valid {
                            certified_transcript_id = Some(transcript_id.to_string());
                        }
                    }
                }
            }

            let target_status = if certified_transcript_id.is_some() {
                NoteTranscriptionJobStatus::Succeeded
            } else if existing.as_ref().is_some_and(|job| {
                job.input_fingerprint == input_fingerprint
                    && job.status == NoteTranscriptionJobStatus::Running
            }) {
                NoteTranscriptionJobStatus::Running
            } else {
                NoteTranscriptionJobStatus::Pending
            };
            let completed_at =
                (target_status == NoteTranscriptionJobStatus::Succeeded).then_some(now.as_str());

            query(
                "INSERT INTO note_transcription_jobs
                 (id, note_id, recording_session_id, audio_artifact_id, source, source_mode,
                  job_kind, start_ms, end_ms, turn_index, input_fingerprint,
                  configuration_fingerprint, operation_id, provider, max_chunk_ms,
                  pipeline_version, status, attempt_count, transcript_id, last_error,
                  created_at, updated_at, completed_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, NULL, ?, ?, ?)
                 ON CONFLICT(id) DO UPDATE SET
                   audio_artifact_id = excluded.audio_artifact_id,
                   source = excluded.source,
                   source_mode = excluded.source_mode,
                   job_kind = excluded.job_kind,
                   start_ms = excluded.start_ms,
                   end_ms = excluded.end_ms,
                   turn_index = excluded.turn_index,
                   input_fingerprint = excluded.input_fingerprint,
                   configuration_fingerprint = excluded.configuration_fingerprint,
                   operation_id = excluded.operation_id,
                   provider = excluded.provider,
                   max_chunk_ms = excluded.max_chunk_ms,
                   pipeline_version = excluded.pipeline_version,
                   status = excluded.status,
                   transcript_id = excluded.transcript_id,
                   last_error = CASE WHEN excluded.status = 'running' THEN note_transcription_jobs.last_error ELSE NULL END,
                   updated_at = excluded.updated_at,
                   completed_at = excluded.completed_at",
            )
            .bind(&plan.span_id)
            .bind(note_id)
            .bind(session_id)
            .bind(&plan.audio_artifact_id)
            .bind(&plan.source)
            .bind(source_mode.as_db())
            .bind(plan.job_kind.as_db())
            .bind(plan.start_ms)
            .bind(plan.end_ms)
            .bind(plan.turn_index)
            .bind(&input_fingerprint)
            .bind(&plan.configuration_fingerprint)
            .bind(&operation_id)
            .bind(&plan.provider)
            .bind(plan.max_chunk_ms)
            .bind(&plan.pipeline_version)
            .bind(target_status.as_db())
            .bind(&certified_transcript_id)
            .bind(&now)
            .bind(&now)
            .bind(completed_at)
            .execute(&mut *tx)
            .await?;

            if let Some(transcript_id) = certified_transcript_id {
                preserved_transcripts.push((transcript_id, plan.clone()));
            }
            current.push(plan.span_id.clone());
        }

        // An exact successful full-Source fallback is the authoritative
        // projection for that Source. Keep its ordinary span jobs superseded on
        // every reconciliation; otherwise Retry would revive and re-spend on
        // the turns that the fallback atomically replaced.
        let succeeded_fallback_sources = preserved_transcripts
            .iter()
            .filter(|(_, plan)| plan.job_kind == NoteTranscriptionJobKind::SourceFallback)
            .map(|(_, plan)| plan.source.clone())
            .collect::<Vec<_>>();
        for source in &succeeded_fallback_sources {
            query(
                "UPDATE note_transcription_jobs
                 SET status = 'superseded', transcript_id = NULL, last_error = NULL,
                     updated_at = ?, completed_at = ?
                 WHERE recording_session_id = ? AND source = ?
                   AND job_kind = 'turn'",
            )
            .bind(&now)
            .bind(&now)
            .bind(session_id)
            .bind(source)
            .execute(&mut *tx)
            .await?;
        }
        preserved_transcripts.retain(|(_, plan)| {
            plan.job_kind == NoteTranscriptionJobKind::SourceFallback
                || !succeeded_fallback_sources.contains(&plan.source)
        });

        let jobs =
            query("SELECT id, status FROM note_transcription_jobs WHERE recording_session_id = ?")
                .bind(session_id)
                .fetch_all(&mut *tx)
                .await?;
        for job in jobs {
            let id: String = job.get("id");
            if !current.iter().any(|current_id| current_id == &id) {
                query(
                    "UPDATE note_transcription_jobs
                     SET status = 'superseded', transcript_id = NULL, last_error = NULL,
                         updated_at = ?, completed_at = ?
                     WHERE id = ?",
                )
                .bind(&now)
                .bind(&now)
                .bind(id)
                .execute(&mut *tx)
                .await?;
            }
        }

        let complete_turn_sources = query(
            "SELECT source
             FROM note_transcription_jobs
             WHERE recording_session_id = ? AND job_kind = 'turn'
               AND status != 'superseded'
             GROUP BY source
             HAVING COUNT(*) > 0
                AND SUM(CASE WHEN status = 'succeeded' THEN 0 ELSE 1 END) = 0",
        )
        .bind(session_id)
        .fetch_all(&mut *tx)
        .await?
        .into_iter()
        .map(|row| row.get::<String, _>("source"))
        .collect::<Vec<_>>();
        let current_sources = plans
            .iter()
            .map(|plan| plan.source.as_str())
            .collect::<Vec<_>>();
        let transcript_rows = query(
            "SELECT id, span_id, source, turn_index
             FROM transcripts
             WHERE recording_session_id = ?",
        )
        .bind(session_id)
        .fetch_all(&mut *tx)
        .await?;

        // Move presentation indexes out of the unique-index range before
        // applying a shifted plan. Exact successes are projected first. A
        // ledger-certified older row is restored as a last-known-good backup
        // only while its Source replacement is incomplete; legacy rows without
        // span identity are deliberately not trusted.
        query(
            "UPDATE transcripts
             SET turn_index = -rowid - 1
             WHERE recording_session_id = ? AND turn_index IS NOT NULL",
        )
        .bind(session_id)
        .execute(&mut *tx)
        .await?;
        for transcript in &transcript_rows {
            let transcript_id: String = transcript.get("id");
            if let Some((_, plan)) = preserved_transcripts
                .iter()
                .find(|(preserved_id, _)| preserved_id == &transcript_id)
            {
                query(
                    "UPDATE transcripts
                     SET audio_artifact_id = ?, source_artifact_id = ?, source = ?, source_mode = ?,
                         start_ms = ?, end_ms = ?, turn_index = ?, span_id = ?, updated_at = ?
                     WHERE id = ?",
                )
                .bind(&plan.audio_artifact_id)
                .bind(&plan.audio_artifact_id)
                .bind(&plan.source)
                .bind(source_mode.as_db())
                .bind(plan.start_ms)
                .bind(plan.end_ms)
                .bind(plan.turn_index)
                .bind(&plan.span_id)
                .bind(&now)
                .bind(&transcript_id)
                .execute(&mut *tx)
                .await?;
            }
        }
        for transcript in transcript_rows {
            let transcript_id: String = transcript.get("id");
            if preserved_transcripts
                .iter()
                .any(|(preserved_id, _)| preserved_id == &transcript_id)
            {
                continue;
            }
            let span_id = transcript.get::<Option<String>, _>("span_id");
            let source = transcript.get::<Option<String>, _>("source");
            let turn_index = transcript.get::<Option<i64>, _>("turn_index");
            let source_is_current = source
                .as_deref()
                .is_some_and(|source| current_sources.contains(&source));
            let source_is_replaced = source.as_deref().is_some_and(|source| {
                succeeded_fallback_sources.iter().any(|item| item == source)
                    || complete_turn_sources.iter().any(|item| item == source)
            });
            let keep_last_known_good =
                span_id.is_some() && source_is_current && !source_is_replaced;
            if keep_last_known_good {
                let collision = match (source.as_deref(), turn_index) {
                    (Some(source), Some(turn_index)) => query(
                        "SELECT 1 FROM transcripts
                         WHERE recording_session_id = ? AND source = ? AND turn_index = ?
                           AND id != ?",
                    )
                    .bind(session_id)
                    .bind(source)
                    .bind(turn_index)
                    .bind(&transcript_id)
                    .fetch_optional(&mut *tx)
                    .await?
                    .is_some(),
                    _ => true,
                };
                if !collision {
                    query("UPDATE transcripts SET turn_index = ? WHERE id = ?")
                        .bind(turn_index)
                        .bind(&transcript_id)
                        .execute(&mut *tx)
                        .await?;
                    continue;
                }
            }
            query("DELETE FROM transcripts WHERE id = ?")
                .bind(&transcript_id)
                .execute(&mut *tx)
                .await?;
        }

        let mut records = Vec::with_capacity(current.len());
        for id in current {
            let row = query(
                "SELECT id, note_id, recording_session_id, audio_artifact_id, source, source_mode,
                        job_kind, start_ms, end_ms, turn_index, input_fingerprint,
                        configuration_fingerprint, operation_id, provider, max_chunk_ms,
                        pipeline_version, status, attempt_count, transcript_id, last_error,
                        created_at, updated_at, completed_at
                 FROM note_transcription_jobs WHERE id = ?",
            )
            .bind(id)
            .fetch_one(&mut *tx)
            .await?;
            records.push(note_transcription_job_from_row(row));
        }
        tx.commit().await?;
        Ok(records)
    }

    pub async fn claim_note_transcription_job(&self, id: &str) -> Result<bool, sqlx::error::Error> {
        let now = timestamp();
        let result = query(
            "UPDATE note_transcription_jobs
             SET status = 'running', attempt_count = attempt_count + 1,
                 last_error = NULL, updated_at = ?, completed_at = NULL
             WHERE id = ? AND status = 'pending'",
        )
        .bind(now)
        .bind(id)
        .execute(&self.pool)
        .await?;
        Ok(result.rows_affected() == 1)
    }

    pub async fn complete_note_transcription_job_success(
        &self,
        id: &str,
        text: &str,
        language: Option<String>,
    ) -> Result<TranscriptDto, sqlx::error::Error> {
        // Microphone and System provider calls may finish together. Serialize
        // their small commits before either reads a snapshot so one Source
        // cannot fail while upgrading a stale WAL reader into a writer.
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        let row = query(
            "SELECT id, note_id, recording_session_id, audio_artifact_id, source, source_mode,
                    job_kind, start_ms, end_ms, turn_index, input_fingerprint,
                    configuration_fingerprint, operation_id, provider, max_chunk_ms,
                    pipeline_version, status, attempt_count, transcript_id, last_error,
                    created_at, updated_at, completed_at
             FROM note_transcription_jobs WHERE id = ?",
        )
        .bind(id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or(sqlx::Error::RowNotFound)?;
        let job = note_transcription_job_from_row(row);
        if job.status != NoteTranscriptionJobStatus::Running {
            return Err(sqlx::Error::Protocol(format!(
                "note transcription job is not running: {id}"
            )));
        }

        let now = timestamp();
        if job.job_kind == NoteTranscriptionJobKind::SourceFallback {
            query("DELETE FROM transcripts WHERE recording_session_id = ? AND source = ?")
                .bind(&job.recording_session_id)
                .bind(&job.source)
                .execute(&mut *tx)
                .await?;
            query(
                "UPDATE note_transcription_jobs
                 SET status = 'superseded', transcript_id = NULL, last_error = NULL,
                     updated_at = ?, completed_at = ?
                 WHERE recording_session_id = ? AND source = ? AND id != ?",
            )
            .bind(&now)
            .bind(&now)
            .bind(&job.recording_session_id)
            .bind(&job.source)
            .bind(&job.id)
            .execute(&mut *tx)
            .await?;
        }
        // A changed fingerprint may leave the previous certified projection in
        // place as a last-known-good backup. Remove the same span inside this
        // success transaction so either the replacement fully commits or the
        // old text is restored by rollback.
        query("DELETE FROM transcripts WHERE span_id = ?")
            .bind(&job.id)
            .execute(&mut *tx)
            .await?;

        let transcript_id = Uuid::new_v4().to_string();
        let transcript = query(
            "INSERT INTO transcripts
             (id, note_id, recording_session_id, audio_artifact_id, source_artifact_id,
              source, source_mode, span_id, text, start_ms, end_ms, turn_index, language,
              provider, status, retry_count, last_error, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'succeeded', 0, NULL, ?, ?)
             ON CONFLICT(recording_session_id, source, turn_index)
             WHERE recording_session_id IS NOT NULL AND source IS NOT NULL AND turn_index IS NOT NULL
             DO UPDATE SET
               audio_artifact_id = excluded.audio_artifact_id,
               source_artifact_id = excluded.source_artifact_id,
               source_mode = excluded.source_mode,
               span_id = excluded.span_id,
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
        .bind(&transcript_id)
        .bind(&job.note_id)
        .bind(&job.recording_session_id)
        .bind(&job.audio_artifact_id)
        .bind(&job.audio_artifact_id)
        .bind(&job.source)
        .bind(job.source_mode.as_db())
        .bind(&job.id)
        .bind(text)
        .bind(job.start_ms)
        .bind(job.end_ms)
        .bind(job.turn_index)
        .bind(&language)
        .bind(&job.provider)
        .bind(&now)
        .bind(&now)
        .fetch_one(&mut *tx)
        .await?;
        let transcript_id: String = transcript.get("id");

        let updated = query(
            "UPDATE note_transcription_jobs
             SET status = 'succeeded', transcript_id = ?, last_error = NULL,
                 updated_at = ?, completed_at = ?
             WHERE id = ? AND status = 'running'",
        )
        .bind(&transcript_id)
        .bind(&now)
        .bind(&now)
        .bind(&job.id)
        .execute(&mut *tx)
        .await?;
        if updated.rows_affected() != 1 {
            return Err(sqlx::Error::Protocol(format!(
                "note transcription job changed while completing: {id}"
            )));
        }
        if job.job_kind == NoteTranscriptionJobKind::Turn {
            let incomplete_turn_count: i64 = query(
                "SELECT COUNT(*) AS count
                 FROM note_transcription_jobs
                 WHERE recording_session_id = ? AND source = ? AND job_kind = 'turn'
                   AND status NOT IN ('succeeded', 'superseded')",
            )
            .bind(&job.recording_session_id)
            .bind(&job.source)
            .fetch_one(&mut *tx)
            .await?
            .get("count");
            let succeeded_turn_count: i64 = query(
                "SELECT COUNT(*) AS count
                 FROM note_transcription_jobs
                 WHERE recording_session_id = ? AND source = ? AND job_kind = 'turn'
                   AND status = 'succeeded'",
            )
            .bind(&job.recording_session_id)
            .bind(&job.source)
            .fetch_one(&mut *tx)
            .await?
            .get("count");
            if incomplete_turn_count == 0 && succeeded_turn_count > 0 {
                // The complete ordinary Turn set is authoritative for this
                // Source. The lazily planned full-Source fallback was not used
                // and must not remain as orphaned pending work after success.
                query(
                    "UPDATE note_transcription_jobs
                     SET status = 'superseded', transcript_id = NULL, last_error = NULL,
                         updated_at = ?, completed_at = ?
                     WHERE recording_session_id = ? AND source = ?
                       AND job_kind = 'source_fallback' AND status = 'pending'",
                )
                .bind(&now)
                .bind(&now)
                .bind(&job.recording_session_id)
                .bind(&job.source)
                .execute(&mut *tx)
                .await?;
                query(
                    "DELETE FROM transcripts
                     WHERE recording_session_id = ? AND source = ?
                       AND NOT EXISTS (
                         SELECT 1 FROM note_transcription_jobs job
                         WHERE job.id = transcripts.span_id
                           AND job.recording_session_id = ?
                           AND job.source = ?
                           AND job.job_kind = 'turn'
                           AND job.status = 'succeeded'
                       )",
                )
                .bind(&job.recording_session_id)
                .bind(&job.source)
                .bind(&job.recording_session_id)
                .bind(&job.source)
                .execute(&mut *tx)
                .await?;
            }
        }
        tx.commit().await?;

        Ok(TranscriptDto {
            id: transcript_id,
            recording_session_id: Some(job.recording_session_id),
            span_id: Some(job.id),
            text: text.to_string(),
            source_mode: Some(job.source_mode),
            source: Some(job.source),
            start_ms: Some(job.start_ms),
            end_ms: Some(job.end_ms),
            turn_index: Some(job.turn_index),
            language,
            status: "succeeded".to_string(),
            last_error: None,
            recorded_silence: false,
        })
    }

    pub async fn supersede_pending_note_transcription_fallbacks(
        &self,
        recording_session_id: &str,
    ) -> Result<u64, sqlx::error::Error> {
        let now = timestamp();
        let result = query(
            "UPDATE note_transcription_jobs
             SET status = 'superseded', transcript_id = NULL, last_error = NULL,
                 updated_at = ?, completed_at = ?
             WHERE recording_session_id = ?
               AND job_kind = 'source_fallback' AND status = 'pending'",
        )
        .bind(&now)
        .bind(&now)
        .bind(recording_session_id)
        .execute(&self.pool)
        .await?;
        Ok(result.rows_affected())
    }

    pub async fn complete_note_transcription_job_failure(
        &self,
        id: &str,
        error: &str,
    ) -> Result<bool, sqlx::error::Error> {
        let now = timestamp();
        let result = query(
            "UPDATE note_transcription_jobs
             SET status = 'failed', last_error = ?, updated_at = ?, completed_at = ?
             WHERE id = ? AND status = 'running'",
        )
        .bind(error)
        .bind(&now)
        .bind(&now)
        .bind(id)
        .execute(&self.pool)
        .await?;
        Ok(result.rows_affected() == 1)
    }

    pub async fn release_interrupted_note_transcription_jobs(
        &self,
    ) -> Result<u64, sqlx::error::Error> {
        let now = timestamp();
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        query(
            "UPDATE notes
             SET processing_status = 'failed',
                 last_error = 'Transcription was interrupted when June closed. Your recording is saved locally, so you can retry.',
                 updated_at = ?
             WHERE processing_status IN ('transcribing', 'generating')
               AND EXISTS (
                 SELECT 1 FROM audio_artifacts artifact
                 WHERE artifact.note_id = notes.id AND artifact.status = 'valid'
               )",
        )
        .bind(&now)
        .execute(&mut *tx)
        .await?;
        let result = query(
            "UPDATE note_transcription_jobs
             SET status = 'pending', last_error = NULL, updated_at = ?, completed_at = NULL
             WHERE status = 'running'",
        )
        .bind(&now)
        .execute(&mut *tx)
        .await?;
        let released = result.rows_affected();
        tx.commit().await?;
        Ok(released)
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
            recording_session_id: None,
            span_id: None,
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
            recording_session_id: Some(session_id.to_string()),
            span_id: None,
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
            recording_session_id: Some(session_id.to_string()),
            span_id: None,
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
        })
    }

    pub async fn delete_source_turn_transcripts_for_session(
        &self,
        session_id: &str,
        source: &str,
    ) -> Result<(), sqlx::error::Error> {
        query(
            "DELETE FROM transcripts
             WHERE recording_session_id = ? AND source = ?",
        )
        .bind(session_id)
        .bind(source)
        .execute(&self.pool)
        .await?;
        Ok(())
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
            recording_session_id: Some(session_id.to_string()),
            span_id: None,
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
            recording_session_id: Some(session_id.to_string()),
            span_id: None,
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

    // ---- Private share keys (JUN-308) ----------------------------------

    pub async fn save_share_key(&self, record: &ShareKeyRecord) -> Result<(), sqlx::error::Error> {
        // The store holds at most one share per item (the `idx_share_keys_item`
        // unique index). Upsert on that item key so a fresh share for an
        // already-mapped item *replaces* the stale mapping instead of failing
        // the insert. This is what lets an item be shared again after its old
        // share is gone, or is owned by a different account now signed in on the
        // same local notes: the owner dialog resets to the unshared view on the
        // ambiguous share_not_found without purging keys (the store is not
        // account-scoped, so it must never delete another owner's live keys),
        // and the eventual re-share lands here to replace the row.
        query(
            "INSERT INTO share_keys (share_id, item_kind, item_id, content_key, created_at)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(item_kind, item_id) DO UPDATE SET
               share_id = excluded.share_id,
               content_key = excluded.content_key,
               created_at = excluded.created_at",
        )
        .bind(&record.share_id)
        .bind(&record.item_kind)
        .bind(&record.item_id)
        .bind(&record.content_key)
        .bind(timestamp())
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn share_key_for_item(
        &self,
        item_kind: &str,
        item_id: &str,
    ) -> Result<Option<ShareKeyRecord>, sqlx::error::Error> {
        let row = query(
            "SELECT share_id, item_kind, item_id, content_key
             FROM share_keys WHERE item_kind = ? AND item_id = ?",
        )
        .bind(item_kind)
        .bind(item_id)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.map(share_key_from_row))
    }

    pub async fn share_keys_for_profile_notes(
        &self,
        profile: &str,
    ) -> Result<Vec<ShareKeyRecord>, sqlx::error::Error> {
        let rows = query(
            "SELECT sk.share_id, sk.item_kind, sk.item_id, sk.content_key
             FROM share_keys sk
             INNER JOIN notes n ON n.id = sk.item_id
             WHERE sk.item_kind = 'note' AND n.profile = ?
             ORDER BY sk.created_at ASC, sk.share_id ASC",
        )
        .bind(profile)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows.into_iter().map(share_key_from_row).collect())
    }

    pub async fn save_share_invite_key(
        &self,
        record: &ShareInviteKeyRecord,
    ) -> Result<(), sqlx::error::Error> {
        query(
            "INSERT INTO share_invite_keys (invite_id, share_id, invite_key, created_at)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(invite_id) DO UPDATE SET
               share_id = excluded.share_id,
               invite_key = excluded.invite_key",
        )
        .bind(&record.invite_id)
        .bind(&record.share_id)
        .bind(&record.invite_key)
        .bind(timestamp())
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn share_invite_keys(
        &self,
        share_id: &str,
    ) -> Result<Vec<ShareInviteKeyRecord>, sqlx::error::Error> {
        let rows = query(
            "SELECT invite_id, share_id, invite_key
             FROM share_invite_keys WHERE share_id = ? ORDER BY created_at ASC",
        )
        .bind(share_id)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows
            .into_iter()
            .map(|row| ShareInviteKeyRecord {
                invite_id: row.get("invite_id"),
                share_id: row.get("share_id"),
                invite_key: row.get("invite_key"),
            })
            .collect())
    }

    /// Purges every locally stored key for a share (used on unshare).
    pub async fn delete_share_keys(&self, share_id: &str) -> Result<(), sqlx::error::Error> {
        query("DELETE FROM share_invite_keys WHERE share_id = ?")
            .bind(share_id)
            .execute(&self.pool)
            .await?;
        query("DELETE FROM share_keys WHERE share_id = ?")
            .bind(share_id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }
}

fn share_key_from_row(row: sqlx_sqlite::SqliteRow) -> ShareKeyRecord {
    ShareKeyRecord {
        share_id: row.get("share_id"),
        item_kind: row.get("item_kind"),
        item_id: row.get("item_id"),
        content_key: row.get("content_key"),
    }
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

fn validate_note_transcription_plan(
    plan: &NoteTranscriptionJobPlan,
) -> Result<(), sqlx::error::Error> {
    if plan.span_id.trim().is_empty()
        || plan.audio_artifact_id.trim().is_empty()
        || !matches!(plan.source.as_str(), "microphone" | "system")
        || plan.start_ms < 0
        || plan.end_ms < plan.start_ms
        || plan.turn_index < 0
        || plan.provider.trim().is_empty()
        || plan.max_chunk_ms.is_some_and(|value| value <= 0)
        || plan.pipeline_version.trim().is_empty()
        || plan.configuration_fingerprint.trim().is_empty()
    {
        return Err(sqlx::Error::Protocol(format!(
            "invalid note transcription plan: {}",
            plan.span_id
        )));
    }
    Ok(())
}

fn note_transcription_input_fingerprint(
    artifact_checksum: &str,
    plan: &NoteTranscriptionJobPlan,
) -> String {
    let mut digest = Sha256::new();
    digest.update(b"june-note-transcription-input-v1\0");
    hash_fingerprint_field(&mut digest, artifact_checksum.as_bytes());
    hash_fingerprint_field(&mut digest, plan.source.as_bytes());
    hash_fingerprint_field(&mut digest, plan.job_kind.as_db().as_bytes());
    hash_fingerprint_field(&mut digest, &plan.start_ms.to_be_bytes());
    hash_fingerprint_field(&mut digest, &plan.end_ms.to_be_bytes());
    hash_fingerprint_field(&mut digest, plan.provider.as_bytes());
    match plan.max_chunk_ms {
        Some(max_chunk_ms) => {
            hash_fingerprint_field(&mut digest, b"some");
            hash_fingerprint_field(&mut digest, &max_chunk_ms.to_be_bytes());
        }
        None => hash_fingerprint_field(&mut digest, b"none"),
    }
    hash_fingerprint_field(&mut digest, plan.pipeline_version.as_bytes());
    hash_fingerprint_field(&mut digest, plan.configuration_fingerprint.as_bytes());
    format!("{:x}", digest.finalize())
}

fn hash_fingerprint_field(digest: &mut Sha256, value: &[u8]) {
    digest.update((value.len() as u64).to_be_bytes());
    digest.update(value);
}

fn note_transcription_job_from_row(row: sqlx_sqlite::SqliteRow) -> NoteTranscriptionJobRecord {
    NoteTranscriptionJobRecord {
        id: row.get("id"),
        note_id: row.get("note_id"),
        recording_session_id: row.get("recording_session_id"),
        audio_artifact_id: row.get("audio_artifact_id"),
        source: row.get("source"),
        source_mode: RecordingSourceMode::from(row.get::<String, _>("source_mode").as_str()),
        job_kind: NoteTranscriptionJobKind::from(row.get::<String, _>("job_kind").as_str()),
        start_ms: row.get("start_ms"),
        end_ms: row.get("end_ms"),
        turn_index: row.get("turn_index"),
        input_fingerprint: row.get("input_fingerprint"),
        configuration_fingerprint: row.get("configuration_fingerprint"),
        operation_id: row.get("operation_id"),
        provider: row.get("provider"),
        max_chunk_ms: row.get("max_chunk_ms"),
        pipeline_version: row.get("pipeline_version"),
        status: NoteTranscriptionJobStatus::from(row.get::<String, _>("status").as_str()),
        attempt_count: row.get("attempt_count"),
        transcript_id: row.get("transcript_id"),
        last_error: row.get("last_error"),
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
        completed_at: row.get("completed_at"),
    }
}

pub fn timestamp() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

async fn insert_browser_approval_event(
    tx: &mut sqlx::transaction::Transaction<'_, sqlx_sqlite::Sqlite>,
    approval_id: &str,
    action_id: &str,
    session_id: &str,
    event_kind: &str,
) -> Result<(), sqlx::error::Error> {
    query(
        "INSERT INTO browser_approval_events (
           id, approval_id, action_id, session_id, event_kind, recorded_at
         ) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(Uuid::new_v4().to_string())
    .bind(approval_id)
    .bind(action_id)
    .bind(session_id)
    .bind(event_kind)
    .bind(timestamp())
    .execute(&mut **tx)
    .await?;
    Ok(())
}

fn nonnegative_u64(value: i64) -> u64 {
    value.max(0) as u64
}

async fn count_profile_rows(
    pool: &SqlitePool,
    table: &str,
    profile: &str,
) -> Result<u32, sqlx::error::Error> {
    let statement = match table {
        "notes" => "SELECT COUNT(*) AS count FROM notes WHERE profile = ?",
        "dictation_history" => "SELECT COUNT(*) AS count FROM dictation_history WHERE profile = ?",
        "folders" => "SELECT COUNT(*) AS count FROM folders WHERE profile = ?",
        "session_profiles" => "SELECT COUNT(*) AS count FROM session_profiles WHERE profile = ?",
        "memories" => "SELECT COUNT(*) AS count FROM memories WHERE profile = ?",
        _ => return Err(sqlx::Error::RowNotFound),
    };
    let row = query(statement).bind(profile).fetch_one(pool).await?;
    Ok(u32::try_from(row.get::<i64, _>("count")).unwrap_or(u32::MAX))
}

/// True when `run_ended_at` is strictly before `approval_since`. Unparseable
/// timestamps are treated as "not before" so a formatting quirk never silently
/// drops a run from the earned-autonomy count.
fn run_finished_before(run_ended_at: &str, approval_since: &str) -> bool {
    match (
        DateTime::parse_from_rfc3339(run_ended_at),
        DateTime::parse_from_rfc3339(approval_since),
    ) {
        (Ok(ended), Ok(since)) => ended < since,
        _ => false,
    }
}

fn string_vec_to_json(values: &[String]) -> String {
    serde_json::to_string(values).unwrap_or_else(|_| "[]".to_string())
}

fn string_vec_from_json(raw: &str) -> Vec<String> {
    serde_json::from_str(raw).unwrap_or_default()
}

fn connector_account_from_row(row: sqlx_sqlite::SqliteRow) -> ConnectorAccountRecord {
    ConnectorAccountRecord {
        account_id: row.get("account_id"),
        provider: row.get("provider"),
        email: row.get("email"),
        scopes: string_vec_from_json(&row.get::<String, _>("scopes")),
        status: row.get("status"),
        metadata: row.get("metadata"),
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
    }
}

fn note_calendar_event_from_row(row: &sqlx_sqlite::SqliteRow) -> Option<NoteCalendarEventDto> {
    Some(NoteCalendarEventDto {
        event_id: row
            .try_get::<Option<String>, _>("calendar_event_id")
            .ok()
            .flatten()?,
        title: row
            .try_get::<Option<String>, _>("calendar_event_title")
            .ok()
            .flatten()?,
        start_at: row
            .try_get::<Option<String>, _>("calendar_event_start_at")
            .ok()
            .flatten()?,
        end_at: row
            .try_get::<Option<String>, _>("calendar_event_end_at")
            .ok()
            .flatten()?,
        account_email: row
            .try_get::<Option<String>, _>("calendar_account_email")
            .ok()
            .flatten()?,
    })
}

fn selected_team_from_row(row: sqlx_sqlite::SqliteRow) -> SelectedTeamRecord {
    SelectedTeamRecord {
        team_id: row.get("team_id"),
        team_key: row.get("team_key"),
        team_name: row.get("team_name"),
    }
}

fn connector_action_from_row(row: sqlx_sqlite::SqliteRow) -> ConnectorActionRecord {
    ConnectorActionRecord {
        action_id: row.get("action_id"),
        account_id: row.get("account_id"),
        tool: row.get("tool"),
        summary: row.get("summary"),
        status: row.get("status"),
        created_at: row.get("created_at"),
        resolved_at: row.get::<Option<String>, _>("resolved_at"),
    }
}

fn routine_trust_from_row(row: sqlx_sqlite::SqliteRow) -> RoutineTrustRecord {
    RoutineTrustRecord {
        job_id: row.get("job_id"),
        trust_mode: row.get("trust_mode"),
        approval_run_count: row.get("approval_run_count"),
        autonomous_tools: string_vec_from_json(&row.get::<String, _>("autonomous_tools")),
        approval_since: row.get::<Option<String>, _>("approval_since"),
        updated_at: row.get("updated_at"),
    }
}

fn connector_trigger_from_row(row: sqlx_sqlite::SqliteRow) -> ConnectorTriggerRecord {
    ConnectorTriggerRecord {
        id: row.get("id"),
        job_id: row.get("job_id"),
        kind: row.get("kind"),
        account_id: row.get("account_id"),
        config: row.get("config"),
        created_at: row.get("created_at"),
    }
}

fn connector_grant_from_row(row: sqlx_sqlite::SqliteRow) -> ConnectorGrant {
    ConnectorGrant {
        job_id: row.get("job_id"),
        provider: row.get("provider"),
        server_name: row.get("server_name"),
        token: row.get("token"),
        tools: string_vec_from_json(&row.get::<String, _>("tools")),
        account_id: row.get("account_id"),
    }
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
        instructions: row
            .try_get::<Option<String>, _>("instructions")
            .unwrap_or(None)
            .and_then(|value| {
                let trimmed = value.trim().to_string();
                if trimmed.is_empty() {
                    None
                } else {
                    Some(trimmed)
                }
            }),
        memory_disabled: row.try_get::<i64, _>("memory_disabled").unwrap_or_default() != 0,
        local_path: row
            .try_get::<Option<String>, _>("local_path")
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

fn memory_from_row(row: sqlx_sqlite::SqliteRow) -> MemoryDto {
    MemoryDto {
        id: row.get("id"),
        folder_id: row.get("folder_id"),
        content: row.get("content"),
        source: row.get("source"),
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
    }
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

fn dictation_history_cutoff_timestamp() -> String {
    (Utc::now() - Duration::days(DICTATION_HISTORY_RETENTION_DAYS))
        .to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn preview_for(title: &str, content: &str) -> String {
    let source = if content.trim().is_empty() {
        title
    } else {
        content
    };
    source.chars().take(NOTE_PREVIEW_CHAR_LIMIT).collect()
}

fn encode_list_notes_cursor(cursor: &ListNotesCursor) -> Result<String, sqlx::Error> {
    let bytes = serde_json::to_vec(cursor).map_err(|error| {
        sqlx::Error::Protocol(format!("could not encode notes cursor: {error}"))
    })?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

fn decode_list_notes_cursor(cursor: &str) -> Result<ListNotesCursor, sqlx::Error> {
    if cursor.len() > LIST_NOTES_CURSOR_MAX_ENCODED_LEN {
        return Err(sqlx::Error::Protocol(
            "notes cursor is too large".to_string(),
        ));
    }
    let bytes = URL_SAFE_NO_PAD
        .decode(cursor)
        .map_err(|_| sqlx::Error::Protocol("notes cursor is not valid base64url".to_string()))?;
    let cursor: ListNotesCursor = serde_json::from_slice(&bytes)
        .map_err(|_| sqlx::Error::Protocol("notes cursor is not valid JSON".to_string()))?;
    if cursor.version != LIST_NOTES_CURSOR_VERSION {
        return Err(sqlx::Error::Protocol(
            "notes cursor version is not supported".to_string(),
        ));
    }
    Ok(cursor)
}

fn validation_summary_recorded_silence(summary: Option<&str>) -> bool {
    summary
        .and_then(|summary| serde_json::from_str::<AudioValidationDto>(summary).ok())
        .map(|validation| validation.recorded_silence)
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::Repositories;
    use crate::domain::types::{
        NoteCalendarEventDto, NoteTranscriptionJobKind, NoteTranscriptionJobPlan,
        NoteTranscriptionJobStatus, ProcessingStatus, RecordingSourceMode,
    };
    use sqlx::query::query;
    use sqlx::row::Row;
    use sqlx_sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions};
    use std::time::Duration as StdDuration;

    async fn test_repositories() -> Repositories {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .expect("sqlite memory");
        crate::db::migrations::run_migrations(&pool)
            .await
            .expect("migrations");
        Repositories::new(pool)
    }

    async fn concurrent_test_repositories() -> (tempfile::TempDir, Repositories) {
        let directory = tempfile::tempdir().expect("temporary database directory");
        let options = SqliteConnectOptions::new()
            .filename(directory.path().join("connector-concurrency.sqlite3"))
            .create_if_missing(true)
            .journal_mode(SqliteJournalMode::Wal)
            .busy_timeout(StdDuration::from_secs(2));
        let pool = SqlitePoolOptions::new()
            .max_connections(2)
            .connect_with(options)
            .await
            .expect("file-backed sqlite");
        crate::db::migrations::run_migrations(&pool)
            .await
            .expect("migrations");
        (directory, Repositories::new(pool))
    }

    fn scopes(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| value.to_string()).collect()
    }

    #[tokio::test]
    async fn create_note_with_id_replays_the_same_note() {
        let repos = test_repositories().await;

        let first = repos
            .create_note_with_id("default", None, "meeting-note-1")
            .await
            .expect("create deterministic note");
        let replay = repos
            .create_note_with_id("default", None, "meeting-note-1")
            .await
            .expect("replay deterministic note");
        let count: i64 = query("SELECT COUNT(*) AS count FROM notes WHERE id = ?")
            .bind("meeting-note-1")
            .fetch_one(&repos.pool)
            .await
            .expect("count deterministic notes")
            .get("count");

        assert_eq!(replay.id, first.id);
        assert_eq!(count, 1);
    }

    #[tokio::test]
    async fn meeting_start_cleanup_preserves_a_changed_draft() {
        let repos = test_repositories().await;
        let untouched = repos
            .create_note_with_id("default", None, "untouched-meeting-draft")
            .await
            .expect("create untouched draft");
        assert!(repos
            .delete_untouched_draft(&untouched.id)
            .await
            .expect("delete untouched draft"));
        assert!(repos.get_note(&untouched.id).await.is_err());

        let changed = repos
            .create_note_with_id("default", None, "changed-meeting-draft")
            .await
            .expect("create changed draft");
        repos
            .update_note(
                &changed.id,
                Some("Keep my meeting note".to_string()),
                Some("User-authored notes".to_string()),
                None,
            )
            .await
            .expect("edit meeting draft");

        assert!(!repos
            .delete_untouched_draft(&changed.id)
            .await
            .expect("preserve changed draft"));
        let preserved = repos.get_note(&changed.id).await.expect("preserved note");
        assert_eq!(preserved.title, "Keep my meeting note");
        assert_eq!(
            preserved.edited_content.as_deref(),
            Some("User-authored notes")
        );
    }

    #[tokio::test]
    async fn calendar_event_titles_only_untouched_notes_and_hydrates_context() {
        let repos = test_repositories().await;
        let untouched = repos.create_note("default", None).await.expect("note");
        let named = repos
            .create_note("default", None)
            .await
            .expect("named note");
        query("UPDATE notes SET title = 'My own title' WHERE id = ?")
            .bind(&named.id)
            .execute(&repos.pool)
            .await
            .expect("name note");
        let event = NoteCalendarEventDto {
            event_id: "event-1".to_string(),
            title: "Product review".to_string(),
            start_at: "2026-07-20T14:00:00Z".to_string(),
            end_at: "2026-07-20T14:30:00Z".to_string(),
            account_email: "june@example.com".to_string(),
        };

        repos
            .associate_note_with_calendar_event(&untouched.id, "", &event)
            .await
            .expect("associate untouched note");
        repos
            .associate_note_with_calendar_event(&named.id, "My own title", &event)
            .await
            .expect("associate named note");

        let untouched = repos.get_note(&untouched.id).await.expect("untouched");
        let named = repos.get_note(&named.id).await.expect("named");
        assert_eq!(untouched.title, "Product review");
        assert_eq!(untouched.calendar_event, Some(event.clone()));
        assert_eq!(named.title, "My own title");
        assert_eq!(named.calendar_event, Some(event));
    }

    async fn recording_fixture(
        repos: &Repositories,
        session_id: &str,
        source: &str,
        checksum: &str,
    ) -> (String, String) {
        let note = repos
            .create_note("default", None)
            .await
            .expect("create note");
        repos
            .create_recording_session(
                &note.id,
                session_id,
                RecordingSourceMode::MicrophonePlusSystem,
                "/tmp/fixture.partial.wav",
                "/tmp/fixture.wav",
                None,
            )
            .await
            .expect("create recording session");
        let artifact = repos
            .create_pending_source_artifact(
                &note.id,
                session_id,
                source,
                "/tmp/fixture.partial.wav",
                "/tmp/fixture.wav",
            )
            .await
            .expect("create audio artifact");
        repos
            .finalize_source_artifact(
                &artifact.id,
                "/tmp/fixture.wav",
                "valid",
                10_000,
                320_044,
                checksum,
                10_000,
                None,
                None,
            )
            .await
            .expect("finalize audio artifact");
        (note.id, artifact.id)
    }

    #[tokio::test]
    async fn linked_folder_batch_rolls_back_when_any_insert_fails() {
        let repos = test_repositories().await;
        query(
            "CREATE TRIGGER reject_linked_folder
             BEFORE INSERT ON folders
             WHEN NEW.local_path = '/tmp/reject'
             BEGIN SELECT RAISE(ABORT, 'rejected for test'); END",
        )
        .execute(&repos.pool)
        .await
        .expect("create rejection trigger");

        let projects = vec![
            ("Accepted".to_string(), "/tmp/accepted".to_string()),
            ("Rejected".to_string(), "/tmp/reject".to_string()),
        ];
        assert!(repos
            .create_linked_folders("default", &projects)
            .await
            .is_err());
        assert!(repos
            .list_folders("default")
            .await
            .expect("list folders after rollback")
            .is_empty());
    }

    #[tokio::test]
    async fn moving_profile_merges_duplicate_linked_folders() {
        let repos = test_repositories().await;
        let default_folder = repos
            .create_linked_folders(
                "default",
                &[("Default project".to_string(), "/tmp/shared".to_string())],
            )
            .await
            .expect("create default folder")
            .remove(0);
        let source_folder = repos
            .create_linked_folders(
                "work",
                &[("Work project".to_string(), "/tmp/shared".to_string())],
            )
            .await
            .expect("create source folder")
            .remove(0);
        let note = repos
            .create_note("work", Some(source_folder.id.clone()))
            .await
            .expect("create source note");
        let memory = repos
            .create_memory("work", Some(&source_folder.id), "Remember this", "user")
            .await
            .expect("create source memory");

        repos
            .move_profile_data_to_default("work")
            .await
            .expect("move profile data");

        let folders = repos
            .list_folders("default")
            .await
            .expect("list default folders");
        assert_eq!(folders.len(), 1);
        assert_eq!(folders[0].id, default_folder.id);
        assert_eq!(
            repos
                .get_note(&note.id)
                .await
                .expect("moved note")
                .folder_ids,
            vec![default_folder.id.clone()]
        );
        let memory_row = query("SELECT profile, folder_id FROM memories WHERE id = ?")
            .bind(&memory.id)
            .fetch_one(&repos.pool)
            .await
            .expect("moved memory");
        assert_eq!(memory_row.get::<String, _>("profile"), "default");
        assert_eq!(memory_row.get::<String, _>("folder_id"), default_folder.id);
    }

    fn transcription_plan(
        span_id: &str,
        artifact_id: &str,
        source: &str,
        start_ms: i64,
        end_ms: i64,
        turn_index: i64,
    ) -> NoteTranscriptionJobPlan {
        NoteTranscriptionJobPlan {
            span_id: span_id.to_string(),
            audio_artifact_id: artifact_id.to_string(),
            source: source.to_string(),
            job_kind: NoteTranscriptionJobKind::Turn,
            start_ms,
            end_ms,
            turn_index,
            provider: "provider-a".to_string(),
            max_chunk_ms: Some(60_000),
            pipeline_version: "pipeline-v1".to_string(),
            configuration_fingerprint: "config-v1".to_string(),
        }
    }

    #[tokio::test]
    async fn recording_start_atomically_creates_recovery_state() {
        let repos = test_repositories().await;
        let note = repos.create_note("default", None).await.expect("note");
        let sources = vec![
            (
                "microphone".to_string(),
                "/tmp/microphone.partial.wav".to_string(),
                "/tmp/microphone.wav".to_string(),
            ),
            (
                "system".to_string(),
                "/tmp/system.partial.wav".to_string(),
                "/tmp/system.wav".to_string(),
            ),
        ];

        repos
            .create_recording_start(
                &note.id,
                "atomic-session",
                RecordingSourceMode::MicrophonePlusSystem,
                "/tmp/combined.partial.wav",
                "/tmp/combined.wav",
                Some("Studio microphone".to_string()),
                &sources,
            )
            .await
            .expect("create recording recovery state");

        let session = query(
            "SELECT note_id, source_mode, status, device_label, partial_path, final_path
             FROM recording_sessions WHERE id = ?",
        )
        .bind("atomic-session")
        .fetch_one(&repos.pool)
        .await
        .expect("recording session");
        assert_eq!(session.get::<String, _>("note_id"), note.id);
        assert_eq!(
            session.get::<String, _>("source_mode"),
            "microphone_plus_system"
        );
        assert_eq!(session.get::<String, _>("status"), "recording");
        assert_eq!(
            session.get::<Option<String>, _>("device_label").as_deref(),
            Some("Studio microphone")
        );
        assert_eq!(
            session.get::<Option<String>, _>("partial_path").as_deref(),
            Some("/tmp/combined.partial.wav")
        );
        assert_eq!(
            session.get::<Option<String>, _>("final_path").as_deref(),
            Some("/tmp/combined.wav")
        );

        let checkpoints = query(
            "SELECT kind FROM recording_checkpoints
             WHERE recording_session_id = ? ORDER BY created_at, id",
        )
        .bind("atomic-session")
        .fetch_all(&repos.pool)
        .await
        .expect("recording checkpoints");
        assert_eq!(checkpoints.len(), 1);
        assert_eq!(checkpoints[0].get::<String, _>("kind"), "start");

        let artifacts = query(
            "SELECT source, partial_path, path, status FROM audio_artifacts
             WHERE recording_session_id = ? ORDER BY source",
        )
        .bind("atomic-session")
        .fetch_all(&repos.pool)
        .await
        .expect("source artifacts");
        assert_eq!(artifacts.len(), 2);
        assert_eq!(artifacts[0].get::<String, _>("source"), "microphone");
        assert_eq!(
            artifacts[0]
                .get::<Option<String>, _>("partial_path")
                .as_deref(),
            Some("/tmp/microphone.partial.wav")
        );
        assert_eq!(artifacts[0].get::<String, _>("path"), "/tmp/microphone.wav");
        assert_eq!(artifacts[0].get::<String, _>("status"), "recording");
        assert_eq!(artifacts[1].get::<String, _>("source"), "system");
        assert_eq!(
            artifacts[1]
                .get::<Option<String>, _>("partial_path")
                .as_deref(),
            Some("/tmp/system.partial.wav")
        );
        assert_eq!(artifacts[1].get::<String, _>("path"), "/tmp/system.wav");
        assert_eq!(artifacts[1].get::<String, _>("status"), "recording");

        let updated_note = repos.get_note(&note.id).await.expect("updated note");
        assert_eq!(updated_note.processing_status, ProcessingStatus::Recording);
        assert_eq!(updated_note.last_error, None);
    }

    #[tokio::test]
    async fn recording_start_rolls_back_every_row_when_a_source_insert_fails() {
        let repos = test_repositories().await;
        let note = repos.create_note("default", None).await.expect("note");
        let existing_error = "Keep this note state after rollback";
        repos
            .set_note_status(
                &note.id,
                ProcessingStatus::Failed,
                Some(existing_error.to_string()),
            )
            .await
            .expect("set initial note state");
        query(
            "CREATE TRIGGER reject_system_recording_start
             BEFORE INSERT ON audio_artifacts
             WHEN NEW.source = 'system'
             BEGIN SELECT RAISE(ABORT, 'rejected system artifact for test'); END",
        )
        .execute(&repos.pool)
        .await
        .expect("create rejection trigger");
        let sources = vec![
            (
                "microphone".to_string(),
                "/tmp/microphone.partial.wav".to_string(),
                "/tmp/microphone.wav".to_string(),
            ),
            (
                "system".to_string(),
                "/tmp/system.partial.wav".to_string(),
                "/tmp/system.wav".to_string(),
            ),
        ];

        let result = repos
            .create_recording_start(
                &note.id,
                "rolled-back-session",
                RecordingSourceMode::MicrophonePlusSystem,
                "/tmp/combined.partial.wav",
                "/tmp/combined.wav",
                None,
                &sources,
            )
            .await;

        let error = result.expect_err("system artifact trigger should abort the transaction");
        assert!(error
            .to_string()
            .contains("rejected system artifact for test"));
        let session_count: i64 =
            query("SELECT COUNT(*) AS count FROM recording_sessions WHERE id = ?")
                .bind("rolled-back-session")
                .fetch_one(&repos.pool)
                .await
                .expect("count rolled-back recording sessions")
                .get("count");
        assert_eq!(session_count, 0, "recording session should be rolled back");
        for table in ["recording_checkpoints", "audio_artifacts"] {
            let statement =
                format!("SELECT COUNT(*) AS count FROM {table} WHERE recording_session_id = ?");
            let count: i64 = query(&statement)
                .bind("rolled-back-session")
                .fetch_one(&repos.pool)
                .await
                .expect("count rolled-back rows")
                .get("count");
            assert_eq!(count, 0, "{table} rows should be rolled back");
        }
        let unchanged_note = repos.get_note(&note.id).await.expect("unchanged note");
        assert_eq!(unchanged_note.processing_status, ProcessingStatus::Failed);
        assert_eq!(unchanged_note.last_error.as_deref(), Some(existing_error));
    }

    #[tokio::test]
    async fn recording_session_preserves_active_note_processing_warning() {
        let repos = test_repositories().await;
        let note = repos
            .create_note("default", None)
            .await
            .expect("create note");
        let warning = "The service is busy right now. Wait a minute, then retry.";
        repos
            .set_note_status(
                &note.id,
                ProcessingStatus::Transcribing,
                Some(warning.to_string()),
            )
            .await
            .expect("set active warning");

        repos
            .create_recording_session(
                &note.id,
                "stacked-session",
                RecordingSourceMode::MicrophoneOnly,
                "/tmp/stacked.partial.wav",
                "/tmp/stacked.wav",
                None,
            )
            .await
            .expect("create stacked recording session");

        let active = repos.get_note(&note.id).await.expect("active note");
        assert_eq!(active.processing_status, ProcessingStatus::Transcribing);
        assert_eq!(active.last_error.as_deref(), Some(warning));
    }

    async fn transcript_count(repos: &Repositories, session_id: &str) -> i64 {
        query("SELECT COUNT(*) AS count FROM transcripts WHERE recording_session_id = ?")
            .bind(session_id)
            .fetch_one(&repos.pool)
            .await
            .expect("count transcripts")
            .get("count")
    }

    async fn export_artifact(
        repos: &Repositories,
        note_id: &str,
        recording_session_id: &str,
        source: &str,
        path: &str,
    ) -> String {
        let artifact = repos
            .create_pending_source_artifact(note_id, recording_session_id, source, path, path)
            .await
            .expect("create export artifact");
        repos
            .finalize_source_artifact(
                &artifact.id,
                path,
                "valid",
                1_000,
                10,
                "checksum",
                1_000,
                None,
                None,
            )
            .await
            .expect("finalize export artifact");
        artifact.id
    }

    #[tokio::test]
    async fn note_audio_export_selection_enforces_eligibility_ownership_and_order() {
        let repos = test_repositories().await;
        let note = repos.create_note("default", None).await.expect("note");
        let other_note = repos
            .create_note("default", None)
            .await
            .expect("other note");
        query("UPDATE notes SET title = 'Product review' WHERE id = ?")
            .bind(&note.id)
            .execute(&repos.pool)
            .await
            .expect("set title");

        for (note_id, recording_session_id) in [
            (&note.id, "session-b"),
            (&note.id, "session-a"),
            (&other_note.id, "session-other"),
        ] {
            repos
                .create_recording_session(
                    note_id,
                    recording_session_id,
                    RecordingSourceMode::MicrophonePlusSystem,
                    "/tmp/source.partial.wav",
                    "/tmp/source.wav",
                    None,
                )
                .await
                .expect("session");
        }
        query("UPDATE recording_sessions SET started_at = '2026-07-01T10:00:00.000Z' WHERE id IN ('session-a', 'session-b')")
            .execute(&repos.pool)
            .await
            .expect("same start time");

        export_artifact(
            &repos,
            &note.id,
            "session-a",
            "system",
            "/recordings/a-system.wav",
        )
        .await;
        export_artifact(
            &repos,
            &note.id,
            "session-a",
            "microphone",
            "/recordings/a-microphone.wav",
        )
        .await;
        export_artifact(
            &repos,
            &note.id,
            "session-b",
            "microphone",
            "/recordings/b-microphone.wav",
        )
        .await;

        let invalid_status = export_artifact(
            &repos,
            &note.id,
            "session-a",
            "system",
            "/recordings/invalid-status.wav",
        )
        .await;
        query("UPDATE audio_artifacts SET status = 'invalid' WHERE id = ?")
            .bind(invalid_status)
            .execute(&repos.pool)
            .await
            .expect("invalidate status");
        let invalid_format = export_artifact(
            &repos,
            &note.id,
            "session-a",
            "system",
            "/recordings/invalid-format.wav",
        )
        .await;
        query("UPDATE audio_artifacts SET format = 'mp3' WHERE id = ?")
            .bind(invalid_format)
            .execute(&repos.pool)
            .await
            .expect("invalidate format");
        let empty = export_artifact(
            &repos,
            &note.id,
            "session-a",
            "system",
            "/recordings/empty.wav",
        )
        .await;
        query("UPDATE audio_artifacts SET size_bytes = 0 WHERE id = ?")
            .bind(empty)
            .execute(&repos.pool)
            .await
            .expect("empty artifact");

        let mismatched = export_artifact(
            &repos,
            &other_note.id,
            "session-other",
            "microphone",
            "/recordings/cross-note.wav",
        )
        .await;
        query("UPDATE audio_artifacts SET note_id = ? WHERE id = ?")
            .bind(&note.id)
            .bind(mismatched)
            .execute(&repos.pool)
            .await
            .expect("make mismatched ownership row");

        let selection = repos
            .note_audio_export_selection(&note.id)
            .await
            .expect("selection query")
            .expect("eligible sources");
        assert_eq!(selection.title, "Product review");
        assert_eq!(selection.note_id, note.id);
        assert_eq!(
            selection
                .sources
                .iter()
                .map(|source| (
                    source.recording_session_id.as_str(),
                    source.source.as_str(),
                    source.path.to_string_lossy().into_owned(),
                ))
                .collect::<Vec<_>>(),
            vec![
                (
                    "session-a",
                    "microphone",
                    "/recordings/a-microphone.wav".to_string()
                ),
                (
                    "session-a",
                    "system",
                    "/recordings/a-system.wav".to_string()
                ),
                (
                    "session-b",
                    "microphone",
                    "/recordings/b-microphone.wav".to_string()
                ),
            ]
        );
        assert!(repos
            .note_audio_export_selection(&other_note.id)
            .await
            .expect("other selection")
            .is_none());
    }

    #[tokio::test]
    async fn transcription_job_exact_plan_reuses_succeeded_projection() {
        let repos = test_repositories().await;
        let (note_id, artifact_id) =
            recording_fixture(&repos, "session-reuse", "microphone", "checksum-a").await;
        let plan = transcription_plan("span-reuse", &artifact_id, "microphone", 100, 900, 0);

        let pending = repos
            .reconcile_note_transcription_jobs(
                &note_id,
                "session-reuse",
                RecordingSourceMode::MicrophonePlusSystem,
                std::slice::from_ref(&plan),
            )
            .await
            .expect("reconcile pending");
        assert_eq!(pending[0].status, NoteTranscriptionJobStatus::Pending);
        assert!(repos
            .claim_note_transcription_job(&plan.span_id)
            .await
            .expect("claim"));
        let transcript = repos
            .complete_note_transcription_job_success(
                &plan.span_id,
                "Durable text",
                Some("en".to_string()),
            )
            .await
            .expect("complete");

        let reused = repos
            .reconcile_note_transcription_jobs(
                &note_id,
                "session-reuse",
                RecordingSourceMode::MicrophonePlusSystem,
                std::slice::from_ref(&plan),
            )
            .await
            .expect("reconcile exact plan");

        assert_eq!(reused[0].status, NoteTranscriptionJobStatus::Succeeded);
        assert_eq!(
            reused[0].transcript_id.as_deref(),
            Some(transcript.id.as_str())
        );
        assert_eq!(reused[0].input_fingerprint, pending[0].input_fingerprint);
        assert_eq!(reused[0].operation_id, pending[0].operation_id);
        assert_eq!(transcript_count(&repos, "session-reuse").await, 1);
        assert!(!repos
            .claim_note_transcription_job(&plan.span_id)
            .await
            .expect("reject second claim"));
    }

    #[tokio::test]
    async fn transcription_job_does_not_certify_pre_ledger_text() {
        let repos = test_repositories().await;
        let (note_id, artifact_id) =
            recording_fixture(&repos, "session-legacy", "system", "checksum-a").await;
        repos
            .upsert_successful_source_turn_transcript(
                &note_id,
                "session-legacy",
                &artifact_id,
                RecordingSourceMode::MicrophonePlusSystem,
                "system",
                "Possibly incorrect legacy text",
                None,
                "provider-a",
                100,
                900,
                0,
            )
            .await
            .expect("insert legacy transcript");
        let plan = transcription_plan("span-legacy", &artifact_id, "system", 100, 900, 0);

        let reconciled = repos
            .reconcile_note_transcription_jobs(
                &note_id,
                "session-legacy",
                RecordingSourceMode::MicrophonePlusSystem,
                &[plan],
            )
            .await
            .expect("reconcile legacy transcript");

        assert_eq!(reconciled[0].status, NoteTranscriptionJobStatus::Pending);
        assert_eq!(transcript_count(&repos, "session-legacy").await, 0);
    }

    #[tokio::test]
    async fn transcription_job_fingerprint_changes_invalidate_output() {
        let repos = test_repositories().await;
        let (note_id, artifact_id) =
            recording_fixture(&repos, "session-invalidate", "microphone", "checksum-a").await;
        let base = transcription_plan("span-invalidate", &artifact_id, "microphone", 0, 1_000, 0);

        let first = repos
            .reconcile_note_transcription_jobs(
                &note_id,
                "session-invalidate",
                RecordingSourceMode::MicrophonePlusSystem,
                std::slice::from_ref(&base),
            )
            .await
            .expect("initial reconcile");
        repos
            .claim_note_transcription_job(&base.span_id)
            .await
            .expect("claim");
        repos
            .complete_note_transcription_job_success(&base.span_id, "Old text", None)
            .await
            .expect("complete");
        assert_eq!(transcript_count(&repos, "session-invalidate").await, 1);

        query("UPDATE audio_artifacts SET checksum = 'checksum-b' WHERE id = ?")
            .bind(&artifact_id)
            .execute(&repos.pool)
            .await
            .expect("change checksum");
        let checksum_changed = repos
            .reconcile_note_transcription_jobs(
                &note_id,
                "session-invalidate",
                RecordingSourceMode::MicrophonePlusSystem,
                std::slice::from_ref(&base),
            )
            .await
            .expect("checksum reconcile");
        assert_eq!(
            checksum_changed[0].status,
            NoteTranscriptionJobStatus::Pending
        );
        assert_ne!(
            checksum_changed[0].input_fingerprint,
            first[0].input_fingerprint
        );
        assert_eq!(transcript_count(&repos, "session-invalidate").await, 1);
        assert!(repos
            .claim_note_transcription_job(&base.span_id)
            .await
            .expect("claim replacement"));
        repos
            .complete_note_transcription_job_failure(&base.span_id, "provider unavailable")
            .await
            .expect("fail replacement");
        let last_known_good: String = query(
            "SELECT text FROM transcripts
             WHERE recording_session_id = 'session-invalidate'",
        )
        .fetch_one(&repos.pool)
        .await
        .expect("last-known-good transcript")
        .get("text");
        assert_eq!(last_known_good, "Old text");
        assert!(repos
            .certified_source_turn_transcripts_for_session("session-invalidate")
            .await
            .expect("current certified projection")
            .is_empty());

        let mut fingerprints = vec![checksum_changed[0].input_fingerprint.clone()];
        let variants = [
            {
                let mut plan = base.clone();
                plan.provider = "provider-b".to_string();
                plan
            },
            {
                let mut plan = base.clone();
                plan.max_chunk_ms = Some(30_000);
                plan
            },
            {
                let mut plan = base.clone();
                plan.pipeline_version = "pipeline-v2".to_string();
                plan
            },
            {
                let mut plan = base.clone();
                plan.configuration_fingerprint = "config-v2".to_string();
                plan
            },
        ];
        for variant in variants {
            let records = repos
                .reconcile_note_transcription_jobs(
                    &note_id,
                    "session-invalidate",
                    RecordingSourceMode::MicrophonePlusSystem,
                    std::slice::from_ref(&variant),
                )
                .await
                .expect("variant reconcile");
            assert_eq!(records[0].status, NoteTranscriptionJobStatus::Pending);
            assert!(!fingerprints.contains(&records[0].input_fingerprint));
            assert!(records[0].operation_id.starts_with("span-invalidate:"));
            fingerprints.push(records[0].input_fingerprint.clone());
        }
    }

    #[tokio::test]
    async fn transcription_job_reconcile_prunes_removed_turns() {
        let repos = test_repositories().await;
        let (note_id, artifact_id) =
            recording_fixture(&repos, "session-prune", "microphone", "checksum-a").await;
        let first = transcription_plan("span-first", &artifact_id, "microphone", 0, 1_000, 0);
        let second = transcription_plan("span-second", &artifact_id, "microphone", 2_000, 3_000, 1);
        let both = vec![first.clone(), second.clone()];
        repos
            .reconcile_note_transcription_jobs(
                &note_id,
                "session-prune",
                RecordingSourceMode::MicrophonePlusSystem,
                &both,
            )
            .await
            .expect("reconcile both");
        for plan in &both {
            assert!(repos
                .claim_note_transcription_job(&plan.span_id)
                .await
                .expect("claim"));
            repos
                .complete_note_transcription_job_success(&plan.span_id, &plan.span_id, None)
                .await
                .expect("complete");
        }
        assert_eq!(transcript_count(&repos, "session-prune").await, 2);

        let remaining = repos
            .reconcile_note_transcription_jobs(
                &note_id,
                "session-prune",
                RecordingSourceMode::MicrophonePlusSystem,
                std::slice::from_ref(&second),
            )
            .await
            .expect("reconcile fewer turns");
        assert_eq!(remaining[0].status, NoteTranscriptionJobStatus::Succeeded);
        assert_eq!(transcript_count(&repos, "session-prune").await, 1);
        let obsolete_status: String =
            query("SELECT status FROM note_transcription_jobs WHERE id = 'span-first'")
                .fetch_one(&repos.pool)
                .await
                .expect("obsolete job")
                .get("status");
        assert_eq!(obsolete_status, "superseded");
    }

    #[tokio::test]
    async fn transcription_job_double_claim_is_rejected() {
        let repos = test_repositories().await;
        let (note_id, artifact_id) =
            recording_fixture(&repos, "session-claim", "microphone", "checksum-a").await;
        let plan = transcription_plan("span-claim", &artifact_id, "microphone", 0, 1_000, 0);
        repos
            .reconcile_note_transcription_jobs(
                &note_id,
                "session-claim",
                RecordingSourceMode::MicrophonePlusSystem,
                std::slice::from_ref(&plan),
            )
            .await
            .expect("reconcile");

        assert!(repos
            .claim_note_transcription_job(&plan.span_id)
            .await
            .expect("first claim"));
        assert!(!repos
            .claim_note_transcription_job(&plan.span_id)
            .await
            .expect("second claim"));
        let attempt_count: i64 =
            query("SELECT attempt_count FROM note_transcription_jobs WHERE id = ?")
                .bind(&plan.span_id)
                .fetch_one(&repos.pool)
                .await
                .expect("job")
                .get("attempt_count");
        assert_eq!(attempt_count, 1);
    }

    #[tokio::test]
    async fn transcription_job_success_and_projection_are_atomic() {
        let repos = test_repositories().await;
        let (note_id, artifact_id) =
            recording_fixture(&repos, "session-atomic", "microphone", "checksum-a").await;
        let plan = transcription_plan("span-atomic", &artifact_id, "microphone", 0, 1_000, 0);
        repos
            .reconcile_note_transcription_jobs(
                &note_id,
                "session-atomic",
                RecordingSourceMode::MicrophonePlusSystem,
                std::slice::from_ref(&plan),
            )
            .await
            .expect("reconcile");
        repos
            .claim_note_transcription_job(&plan.span_id)
            .await
            .expect("claim");
        repos
            .set_note_status(&note_id, ProcessingStatus::Transcribing, None)
            .await
            .expect("mark processing");
        query(
            "CREATE TRIGGER force_job_completion_failure
             BEFORE UPDATE OF status ON note_transcription_jobs
             WHEN NEW.status = 'succeeded'
             BEGIN SELECT RAISE(ABORT, 'forced job completion failure'); END",
        )
        .execute(&repos.pool)
        .await
        .expect("create trigger");

        assert!(repos
            .complete_note_transcription_job_success(&plan.span_id, "Atomic text", None)
            .await
            .is_err());
        assert_eq!(transcript_count(&repos, "session-atomic").await, 0);
        let status: String = query("SELECT status FROM note_transcription_jobs WHERE id = ?")
            .bind(&plan.span_id)
            .fetch_one(&repos.pool)
            .await
            .expect("job")
            .get("status");
        assert_eq!(status, "running");

        query("DROP TRIGGER force_job_completion_failure")
            .execute(&repos.pool)
            .await
            .expect("drop trigger");
        repos
            .complete_note_transcription_job_success(&plan.span_id, "Atomic text", None)
            .await
            .expect("complete after removing trigger");
        assert_eq!(transcript_count(&repos, "session-atomic").await, 1);
    }

    #[tokio::test]
    async fn completed_turn_plan_supersedes_unused_source_fallback() {
        let repos = test_repositories().await;
        let (note_id, artifact_id) = recording_fixture(
            &repos,
            "session-unused-fallback",
            "microphone",
            "checksum-a",
        )
        .await;
        let turn = transcription_plan("span-turn", &artifact_id, "microphone", 0, 1_000, 0);
        let mut fallback =
            transcription_plan("span-fallback", &artifact_id, "microphone", 0, 10_000, 1);
        fallback.job_kind = NoteTranscriptionJobKind::SourceFallback;
        repos
            .reconcile_note_transcription_jobs(
                &note_id,
                "session-unused-fallback",
                RecordingSourceMode::MicrophonePlusSystem,
                &[turn.clone(), fallback.clone()],
            )
            .await
            .expect("reconcile");

        assert!(repos
            .claim_note_transcription_job(&turn.span_id)
            .await
            .expect("claim turn"));
        repos
            .complete_note_transcription_job_success(&turn.span_id, "Turn text", None)
            .await
            .expect("complete turn");

        let fallback_status: String =
            query("SELECT status FROM note_transcription_jobs WHERE id = 'span-fallback'")
                .fetch_one(&repos.pool)
                .await
                .expect("fallback job")
                .get("status");
        assert_eq!(fallback_status, "superseded");
    }

    #[tokio::test]
    async fn source_fallback_replacement_rolls_back_on_insert_failure() {
        let repos = test_repositories().await;
        let (note_id, artifact_id) =
            recording_fixture(&repos, "session-fallback", "microphone", "checksum-a").await;
        let first = transcription_plan("span-turn-1", &artifact_id, "microphone", 0, 1_000, 0);
        let second = transcription_plan("span-turn-2", &artifact_id, "microphone", 2_000, 3_000, 1);
        let mut fallback =
            transcription_plan("span-fallback", &artifact_id, "microphone", 0, 10_000, 2);
        fallback.job_kind = NoteTranscriptionJobKind::SourceFallback;
        let plans = vec![first.clone(), second.clone(), fallback.clone()];
        repos
            .reconcile_note_transcription_jobs(
                &note_id,
                "session-fallback",
                RecordingSourceMode::MicrophonePlusSystem,
                &plans,
            )
            .await
            .expect("reconcile");
        repos
            .claim_note_transcription_job(&first.span_id)
            .await
            .expect("claim turn");
        repos
            .complete_note_transcription_job_success(&first.span_id, &first.span_id, None)
            .await
            .expect("complete turn");
        assert_eq!(transcript_count(&repos, "session-fallback").await, 1);
        repos
            .claim_note_transcription_job(&fallback.span_id)
            .await
            .expect("claim fallback");
        query(
            "CREATE TRIGGER force_transcript_insert_failure
             BEFORE INSERT ON transcripts
             BEGIN SELECT RAISE(ABORT, 'forced transcript insert failure'); END",
        )
        .execute(&repos.pool)
        .await
        .expect("create trigger");

        assert!(repos
            .complete_note_transcription_job_success(&fallback.span_id, "Fallback text", None)
            .await
            .is_err());
        assert_eq!(transcript_count(&repos, "session-fallback").await, 1);
        let active_turns: i64 = query(
            "SELECT COUNT(*) AS count FROM note_transcription_jobs
             WHERE id IN ('span-turn-1', 'span-turn-2') AND status = 'succeeded'",
        )
        .fetch_one(&repos.pool)
        .await
        .expect("count active turns")
        .get("count");
        assert_eq!(active_turns, 1);

        query("DROP TRIGGER force_transcript_insert_failure")
            .execute(&repos.pool)
            .await
            .expect("drop trigger");
        repos
            .complete_note_transcription_job_success(&fallback.span_id, "Fallback text", None)
            .await
            .expect("complete fallback");
        assert_eq!(transcript_count(&repos, "session-fallback").await, 1);
        let rows = query(
            "SELECT span_id, text FROM transcripts WHERE recording_session_id = 'session-fallback'",
        )
        .fetch_all(&repos.pool)
        .await
        .expect("fallback projection");
        assert_eq!(rows[0].get::<String, _>("span_id"), fallback.span_id);
        assert_eq!(rows[0].get::<String, _>("text"), "Fallback text");

        let reconciled = repos
            .reconcile_note_transcription_jobs(
                &note_id,
                "session-fallback",
                RecordingSourceMode::MicrophonePlusSystem,
                &plans,
            )
            .await
            .expect("reconcile completed fallback");
        assert_eq!(
            reconciled
                .iter()
                .find(|job| job.id == fallback.span_id)
                .expect("fallback job")
                .status,
            NoteTranscriptionJobStatus::Succeeded
        );
        assert!(reconciled
            .iter()
            .filter(|job| job.job_kind == NoteTranscriptionJobKind::Turn)
            .all(|job| job.status == NoteTranscriptionJobStatus::Superseded));
        assert_eq!(transcript_count(&repos, "session-fallback").await, 1);

        let turn_only = repos
            .reconcile_note_transcription_jobs(
                &note_id,
                "session-fallback",
                RecordingSourceMode::MicrophonePlusSystem,
                &[first.clone(), second.clone()],
            )
            .await
            .expect("remove obsolete fallback from plan");
        assert!(turn_only
            .iter()
            .all(|job| job.status == NoteTranscriptionJobStatus::Pending));
        assert_eq!(transcript_count(&repos, "session-fallback").await, 1);
        for plan in [&first, &second] {
            assert!(repos
                .claim_note_transcription_job(&plan.span_id)
                .await
                .expect("claim replacement turn"));
            repos
                .complete_note_transcription_job_success(
                    &plan.span_id,
                    &format!("replacement {}", plan.span_id),
                    None,
                )
                .await
                .expect("complete replacement turn");
        }
        assert_eq!(transcript_count(&repos, "session-fallback").await, 2);
    }

    #[tokio::test]
    async fn interrupted_transcription_jobs_are_released_to_pending() {
        let repos = test_repositories().await;
        let (note_id, artifact_id) =
            recording_fixture(&repos, "session-release", "microphone", "checksum-a").await;
        let plan = transcription_plan("span-release", &artifact_id, "microphone", 0, 1_000, 0);
        repos
            .reconcile_note_transcription_jobs(
                &note_id,
                "session-release",
                RecordingSourceMode::MicrophonePlusSystem,
                std::slice::from_ref(&plan),
            )
            .await
            .expect("reconcile");
        repos
            .claim_note_transcription_job(&plan.span_id)
            .await
            .expect("claim");
        repos
            .set_note_status(&note_id, ProcessingStatus::Transcribing, None)
            .await
            .expect("mark interrupted transcription");

        assert_eq!(
            repos
                .release_interrupted_note_transcription_jobs()
                .await
                .expect("release"),
            1
        );
        assert!(repos
            .claim_note_transcription_job(&plan.span_id)
            .await
            .expect("claim after release"));
        let attempt_count: i64 =
            query("SELECT attempt_count FROM note_transcription_jobs WHERE id = ?")
                .bind(&plan.span_id)
                .fetch_one(&repos.pool)
                .await
                .expect("job")
                .get("attempt_count");
        assert_eq!(attempt_count, 2);
        let interrupted = repos.get_note(&note_id).await.expect("interrupted note");
        assert_eq!(interrupted.processing_status, ProcessingStatus::Failed);
        assert!(interrupted
            .last_error
            .as_deref()
            .is_some_and(|error| error.contains("recording is saved locally")));
        assert_eq!(
            interrupted.retry_recording_session_id.as_deref(),
            Some("session-release")
        );
    }

    #[tokio::test]
    async fn interrupted_generation_without_a_running_job_is_retryable() {
        let repos = test_repositories().await;
        let (note_id, artifact_id) =
            recording_fixture(&repos, "session-generation", "microphone", "checksum-a").await;
        let plan = transcription_plan("span-generation", &artifact_id, "microphone", 0, 1_000, 0);
        repos
            .reconcile_note_transcription_jobs(
                &note_id,
                "session-generation",
                RecordingSourceMode::MicrophoneOnly,
                std::slice::from_ref(&plan),
            )
            .await
            .expect("reconcile");
        assert!(repos
            .claim_note_transcription_job(&plan.span_id)
            .await
            .expect("claim"));
        repos
            .complete_note_transcription_job_success(&plan.span_id, "Recovered text", None)
            .await
            .expect("complete transcription");
        repos
            .set_note_status(&note_id, ProcessingStatus::Generating, None)
            .await
            .expect("mark generation");

        assert_eq!(
            repos
                .release_interrupted_note_transcription_jobs()
                .await
                .expect("startup repair"),
            0
        );
        let interrupted = repos.get_note(&note_id).await.expect("interrupted note");
        assert_eq!(interrupted.processing_status, ProcessingStatus::Failed);
        assert_eq!(
            interrupted.retry_recording_session_id.as_deref(),
            Some("session-generation")
        );
    }

    #[tokio::test]
    async fn retry_prefers_substantial_unprocessed_session_over_newest_artifact() {
        let repos = test_repositories().await;
        let note = repos
            .create_note("default", None)
            .await
            .expect("create note");

        repos
            .create_recording_session(
                &note.id,
                "meeting-session",
                RecordingSourceMode::MicrophonePlusSystem,
                "/tmp/meeting.partial.wav",
                "/tmp/meeting.wav",
                None,
            )
            .await
            .expect("create meeting session");
        for (source, size) in [("microphone", 93_000_000), ("system", 372_000_000)] {
            let artifact = repos
                .create_pending_source_artifact(
                    &note.id,
                    "meeting-session",
                    source,
                    &format!("/tmp/{source}.partial.wav"),
                    &format!("/tmp/{source}.wav"),
                )
                .await
                .expect("create meeting artifact");
            repos
                .finalize_source_artifact(
                    &artifact.id,
                    &format!("/tmp/{source}.wav"),
                    "valid",
                    1_940_000,
                    size,
                    "meeting-checksum",
                    1_940_000,
                    None,
                    None,
                )
                .await
                .expect("finalize meeting artifact");
        }

        repos
            .create_recording_session(
                &note.id,
                "short-session",
                RecordingSourceMode::MicrophoneOnly,
                "/tmp/short.partial.wav",
                "/tmp/short.wav",
                None,
            )
            .await
            .expect("create short session");
        let short = repos
            .create_pending_source_artifact(
                &note.id,
                "short-session",
                "microphone",
                "/tmp/short.partial.wav",
                "/tmp/short.wav",
            )
            .await
            .expect("create short artifact");
        repos
            .finalize_source_artifact(
                &short.id,
                "/tmp/short.wav",
                "valid",
                920,
                44_204,
                "short-checksum",
                920,
                None,
                None,
            )
            .await
            .expect("finalize short artifact");

        query("UPDATE audio_artifacts SET created_at = '2026-07-15T11:32:19.000Z' WHERE recording_session_id = 'short-session'")
            .execute(&repos.pool)
            .await
            .expect("make short artifact newest");

        let sources = repos
            .latest_valid_audio_artifact_paths(&note.id)
            .await
            .expect("select retry sources");

        assert_eq!(sources.len(), 2);
        assert!(sources
            .iter()
            .all(|(_, _, _, session_id, _)| session_id == "meeting-session"));
        assert_eq!(sources[0].1, "microphone");
        assert_eq!(sources[1].1, "system");
        repos
            .set_note_status(
                &note.id,
                ProcessingStatus::Failed,
                Some("Saved meeting needs retry".to_string()),
            )
            .await
            .expect("mark note failed");
        let hydrated = repos.get_note(&note.id).await.expect("hydrate note");
        assert_eq!(
            hydrated.retry_recording_session_id.as_deref(),
            Some("meeting-session")
        );
        assert_eq!(
            repos
                .valid_audio_artifact_paths_for_session(&note.id, "meeting-session")
                .await
                .expect("explicit session sources")
                .len(),
            2
        );

        let other_note = repos
            .create_note("default", None)
            .await
            .expect("create other note");
        assert!(repos
            .valid_audio_artifact_paths_for_session(&other_note.id, "meeting-session")
            .await
            .expect("reject cross-note session")
            .is_empty());
    }

    #[tokio::test]
    async fn memory_create_list_and_update_round_trip_across_scopes() {
        let repos = test_repositories().await;
        let folder = repos
            .create_folder("default", "Client work", None)
            .await
            .expect("create folder");
        let other_folder = repos
            .create_folder("default", "Internal", None)
            .await
            .expect("create other folder");
        let global = repos
            .create_memory("default", None, "Use concise summaries", "user")
            .await
            .expect("create global memory");
        let scoped = repos
            .create_memory("default", Some(&folder.id), "The launch is Friday", "agent")
            .await
            .expect("create scoped memory");
        repos
            .create_memory(
                "default",
                Some(&other_folder.id),
                "The budget is approved",
                "agent",
            )
            .await
            .expect("create other scoped memory");

        let scoped_only = repos
            .list_memories("default", Some(&folder.id), false)
            .await
            .expect("list scoped");
        assert_eq!(scoped_only, vec![scoped.clone()]);

        let scoped_and_global = repos
            .list_memories("default", Some(&folder.id), true)
            .await
            .expect("list scoped and global");
        assert_eq!(scoped_and_global.len(), 2);
        assert!(scoped_and_global
            .iter()
            .any(|memory| memory.id == global.id));
        assert!(scoped_and_global
            .iter()
            .any(|memory| memory.id == scoped.id));

        let global_only = repos
            .list_memories("default", None, false)
            .await
            .expect("list global");
        assert_eq!(global_only, vec![global]);
        assert_eq!(
            repos
                .list_memories("default", None, true)
                .await
                .expect("list everything")
                .len(),
            3
        );

        let updated = repos
            .update_memory("default", &scoped.id, "  The launch moved to Monday  ")
            .await
            .expect("update memory");
        assert_eq!(updated.content, "The launch moved to Monday");
        assert_eq!(updated.id, scoped.id);
        assert_eq!(updated.folder_id.as_deref(), Some(folder.id.as_str()));
        assert_eq!(updated.source, "agent");
    }

    #[tokio::test]
    async fn memories_are_isolated_by_profile_for_reads_and_mutations() {
        let repos = test_repositories().await;
        let folder_a = repos
            .create_folder("a", "Profile A project", None)
            .await
            .expect("profile a folder");
        let folder_b = repos
            .create_folder("b", "Profile B project", None)
            .await
            .expect("profile b folder");
        let global_a = repos
            .create_memory("a", None, "Profile A global", "user")
            .await
            .expect("profile a global memory");
        let scoped_a = repos
            .create_memory("a", Some(&folder_a.id), "Profile A project", "agent")
            .await
            .expect("profile a scoped memory");
        let global_b = repos
            .create_memory("b", None, "Profile B global", "user")
            .await
            .expect("profile b global memory");

        let profile_a = repos
            .list_memories("a", None, true)
            .await
            .expect("profile a memories");
        assert_eq!(profile_a.len(), 2);
        assert!(profile_a.iter().any(|memory| memory.id == global_a.id));
        assert!(profile_a.iter().any(|memory| memory.id == scoped_a.id));
        assert_eq!(
            repos
                .list_memories("b", None, true)
                .await
                .expect("profile b memories"),
            vec![global_b.clone()]
        );

        let update_error = repos
            .update_memory("b", &global_a.id, "Cross-profile edit")
            .await
            .expect_err("cross-profile update must fail closed");
        assert_eq!(update_error.code, "memory_not_found");
        let delete_error = repos
            .delete_memory("b", &global_a.id)
            .await
            .expect_err("cross-profile delete must fail closed");
        assert_eq!(delete_error.code, "memory_not_found");
        let folder_error = repos
            .create_memory("a", Some(&folder_b.id), "Wrong project", "user")
            .await
            .expect_err("cross-profile project scope must fail closed");
        assert_eq!(folder_error.code, "folder_not_found");
    }

    #[tokio::test]
    async fn memory_delete_is_permanent_and_writes_tombstone() {
        let repos = test_repositories().await;
        let memory = repos
            .create_memory("default", None, "Remember this briefly", "agent")
            .await
            .expect("create memory");

        repos
            .delete_memory("default", &memory.id)
            .await
            .expect("delete memory");

        assert!(repos
            .list_memories("default", None, true)
            .await
            .expect("list memories")
            .is_empty());
        let tombstone = query("SELECT id, deleted_at FROM memory_tombstones WHERE id = ?")
            .bind(&memory.id)
            .fetch_one(&repos.pool)
            .await
            .expect("tombstone");
        assert_eq!(tombstone.get::<String, _>("id"), memory.id);
        assert!(!tombstone.get::<String, _>("deleted_at").is_empty());
    }

    #[tokio::test]
    async fn create_memory_rejects_a_deleted_folder() {
        let repos = test_repositories().await;
        let folder = repos
            .create_folder("default", "Archived project", None)
            .await
            .expect("create folder");
        repos
            .delete_folder(&folder.id, false)
            .await
            .expect("soft delete folder");

        let error = repos
            .create_memory("default", Some(&folder.id), "Do not persist", "user")
            .await
            .expect_err("deleted folder must reject memory");
        assert_eq!(error.code, "folder_not_found");
    }

    #[tokio::test]
    async fn deleting_folder_removes_scoped_memories_and_writes_tombstones() {
        let repos = test_repositories().await;
        let folder = repos
            .create_folder("default", "Archived project", None)
            .await
            .expect("create folder");
        let other_folder = repos
            .create_folder("default", "Active project", None)
            .await
            .expect("create other folder");
        let global = repos
            .create_memory("default", None, "Global memory", "user")
            .await
            .expect("create global memory");
        let first_deleted = repos
            .create_memory("default", Some(&folder.id), "First project memory", "user")
            .await
            .expect("create first scoped memory");
        let second_deleted = repos
            .create_memory(
                "default",
                Some(&folder.id),
                "Second project memory",
                "agent",
            )
            .await
            .expect("create second scoped memory");
        let retained = repos
            .create_memory(
                "default",
                Some(&other_folder.id),
                "Other project memory",
                "user",
            )
            .await
            .expect("create other scoped memory");

        repos
            .delete_folder(&folder.id, false)
            .await
            .expect("delete folder");

        let remaining = repos
            .list_memories("default", None, true)
            .await
            .expect("list remaining memories");
        assert_eq!(remaining.len(), 2);
        assert!(remaining.iter().any(|memory| memory.id == global.id));
        assert!(remaining.iter().any(|memory| memory.id == retained.id));
        let tombstones = query("SELECT id FROM memory_tombstones ORDER BY id")
            .fetch_all(&repos.pool)
            .await
            .expect("list tombstones")
            .into_iter()
            .map(|row| row.get::<String, _>("id"))
            .collect::<Vec<_>>();
        assert_eq!(tombstones.len(), 2);
        assert!(tombstones.contains(&first_deleted.id));
        assert!(tombstones.contains(&second_deleted.id));
    }

    #[tokio::test]
    async fn folder_instructions_and_memory_disabled_persist_and_round_trip() {
        let repos = test_repositories().await;
        let folder = repos
            .create_folder("default", "Research", Some("Background"))
            .await
            .expect("create folder");
        assert_eq!(folder.instructions, None);
        assert!(!folder.memory_disabled);

        let folder = repos
            .set_folder_instructions(&folder.id, Some("  Prefer primary sources.  "))
            .await
            .expect("set instructions");
        assert_eq!(
            folder.instructions.as_deref(),
            Some("Prefer primary sources.")
        );
        let folder = repos
            .set_folder_memory_disabled(&folder.id, true)
            .await
            .expect("disable memory");
        assert!(folder.memory_disabled);

        let listed = repos.list_folders("default").await.expect("list folders");
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].instructions, folder.instructions);
        assert!(listed[0].memory_disabled);

        let cleared = repos
            .set_folder_instructions(&folder.id, Some("   "))
            .await
            .expect("clear instructions");
        assert_eq!(cleared.instructions, None);
    }

    #[tokio::test]
    async fn browser_outcome_ledger_is_queryable_and_content_free() {
        let repos = test_repositories().await;
        repos
            .declare_browser_action(
                "action-1",
                "navigate",
                "attended",
                "session-1",
                Some("target_state"),
            )
            .await
            .expect("declare action");
        repos
            .park_browser_approval("action-1", "approval-1", "session-1")
            .await
            .expect("park approval");
        repos
            .record_browser_approval_event("action-1", "approval-1", "session-1", "approved")
            .await
            .expect("approve");
        repos
            .evaluate_browser_action("action-1", "executed", None, true)
            .await
            .expect("evaluate action");

        let counts = repos.browser_outcome_counts().await.expect("counts");
        assert_eq!(counts.declared, 1);
        assert_eq!(counts.verified_successes, 1);
        assert_eq!(counts.executed, 1);
        assert_eq!(counts.parked, 1);
        assert_eq!(counts.approved, 1);

        let rows = repos
            .browser_action_outcomes_for_session("session-1")
            .await
            .expect("rows");
        let serialized = serde_json::to_string(&serde_json::json!({
            "id": rows[0].id,
            "operation": rows[0].operation,
            "transportKind": rows[0].transport_kind,
            "sessionId": rows[0].session_id,
            "approvalId": rows[0].approval_id,
            "outcomeClass": rows[0].outcome_class,
            "resultKind": rows[0].result_kind,
            "resultCodeClass": rows[0].result_code_class,
            "outcomeVerified": rows[0].outcome_verified,
            "declaredAt": rows[0].declared_at,
            "evaluatedAt": rows[0].evaluated_at,
        }))
        .expect("serialize ledger row");
        for sentinel in [
            "https://sentinel.invalid/private",
            "sentinel element label",
            "sentinel field value",
        ] {
            assert!(!serialized.contains(sentinel));
        }
    }

    #[tokio::test]
    async fn connector_account_upsert_list_and_status() {
        let repos = test_repositories().await;
        repos
            .upsert_connector_account(
                "user@example.com",
                "google",
                "user@example.com",
                &scopes(&["openid", "email"]),
                "connected",
                "{}",
            )
            .await
            .expect("insert account");

        let accounts = repos.list_connector_accounts().await.expect("list");
        assert_eq!(accounts.len(), 1);
        assert_eq!(accounts[0].account_id, "user@example.com");
        assert_eq!(accounts[0].scopes, scopes(&["openid", "email"]));
        assert_eq!(accounts[0].status, "connected");
        assert_eq!(accounts[0].metadata, "{}");

        // Upsert widens scopes without duplicating the row.
        repos
            .upsert_connector_account(
                "user@example.com",
                "google",
                "user@example.com",
                &scopes(&[
                    "openid",
                    "email",
                    "https://www.googleapis.com/auth/gmail.readonly",
                ]),
                "connected",
                "{}",
            )
            .await
            .expect("upsert account");
        let accounts = repos.list_connector_accounts().await.expect("list");
        assert_eq!(accounts.len(), 1);
        assert_eq!(accounts[0].scopes.len(), 3);

        repos
            .set_connector_account_status("user@example.com", "reconnect_required")
            .await
            .expect("set status");
        let account = repos
            .get_connector_account("user@example.com")
            .await
            .expect("get")
            .expect("present");
        assert_eq!(account.status, "reconnect_required");
        assert!(repos
            .get_connector_account("other@example.com")
            .await
            .expect("get")
            .is_none());
    }

    #[tokio::test]
    async fn delete_connector_account_cascades_triggers_cursors_and_teams() {
        let repos = test_repositories().await;
        repos
            .upsert_connector_account(
                "user@example.com",
                "google",
                "user@example.com",
                &scopes(&["openid"]),
                "connected",
                "{}",
            )
            .await
            .expect("insert account");
        repos
            .replace_connector_trigger("job-1", "email_received", "user@example.com", "{}")
            .await
            .expect("set trigger");
        repos
            .set_trigger_cursor("user@example.com", "email_received", "12345")
            .await
            .expect("set cursor");
        repos
            .set_connector_grant(
                &super::ConnectorGrant {
                    job_id: "job-1".to_string(),
                    provider: "gmail".to_string(),
                    server_name: "june_gmail_auto_job1".to_string(),
                    token: "grant-token".to_string(),
                    tools: scopes(&["send_email"]),
                    account_id: "user@example.com".to_string(),
                },
                "2026-07-09T00:00:00.000Z",
            )
            .await
            .expect("set grant");
        repos
            .set_selected_teams(
                "user@example.com",
                &[super::SelectedTeamRecord {
                    team_id: "team-1".to_string(),
                    team_key: "ENG".to_string(),
                    team_name: "Engineering".to_string(),
                }],
            )
            .await
            .expect("set selected teams");
        repos
            .insert_connector_action(
                "action-1",
                "user@example.com",
                "create_issue",
                "ENG: Fix the flaky test",
            )
            .await
            .expect("insert action");

        repos
            .delete_connector_account("user@example.com")
            .await
            .expect("delete");

        assert!(repos
            .get_connector_account("user@example.com")
            .await
            .expect("get")
            .is_none());
        assert!(repos
            .list_connector_triggers(None)
            .await
            .expect("triggers")
            .is_empty());
        assert!(repos
            .trigger_cursor("user@example.com", "email_received")
            .await
            .expect("cursor")
            .is_none());
        // Autonomy grants must not survive a disconnect; reconnecting the same
        // email should require the user to re-earn autonomous access.
        assert!(repos
            .list_connector_grants()
            .await
            .expect("grants")
            .is_empty());
        // Selected teams must not survive either: reconnecting the same
        // workspace should require re-picking teams, not silently inherit the
        // old scope.
        assert!(repos
            .list_selected_teams("user@example.com")
            .await
            .expect("teams")
            .is_empty());
        // The action journal rows for the account go with it.
        assert!(repos
            .get_connector_action("action-1")
            .await
            .expect("action")
            .is_none());
    }

    #[tokio::test]
    async fn connector_action_insert_resolve_and_get_round_trip() {
        let repos = test_repositories().await;

        // Unknown action id: no row, and resolving it is a harmless no-op
        // (the pending write is best-effort).
        assert!(repos
            .get_connector_action("missing")
            .await
            .expect("get")
            .is_none());
        repos
            .resolve_connector_action("missing", "committed")
            .await
            .expect("resolving an unknown action id is a no-op");

        repos
            .insert_connector_action(
                "0d1f2e3a-0000-4000-8000-000000000001",
                "workspace-1",
                "create_issue",
                "ENG: Fix the flaky test",
            )
            .await
            .expect("insert");
        let action = repos
            .get_connector_action("0d1f2e3a-0000-4000-8000-000000000001")
            .await
            .expect("get")
            .expect("present");
        assert_eq!(action.account_id, "workspace-1");
        assert_eq!(action.tool, "create_issue");
        assert_eq!(action.summary, "ENG: Fix the flaky test");
        assert_eq!(action.status, "pending");
        assert!(!action.created_at.is_empty());
        assert_eq!(action.resolved_at, None);

        repos
            .resolve_connector_action("0d1f2e3a-0000-4000-8000-000000000001", "committed")
            .await
            .expect("resolve");
        let action = repos
            .get_connector_action("0d1f2e3a-0000-4000-8000-000000000001")
            .await
            .expect("get")
            .expect("present");
        assert_eq!(action.status, "committed");
        assert!(action.resolved_at.is_some());

        // The action id is a PRIMARY KEY: journaling the same mutation twice
        // is a bug the database surfaces rather than silently absorbing.
        assert!(repos
            .insert_connector_action(
                "0d1f2e3a-0000-4000-8000-000000000001",
                "workspace-1",
                "create_issue",
                "duplicate",
            )
            .await
            .is_err());
    }

    #[tokio::test]
    async fn connector_action_status_check_rejects_unknown_values() {
        let repos = test_repositories().await;
        repos
            .insert_connector_action("action-1", "workspace-1", "add_comment", "ENG-42")
            .await
            .expect("insert");
        // The CHECK constraint is the last line of defense against a typo'd
        // status string reaching the journal.
        assert!(repos
            .resolve_connector_action("action-1", "bogus")
            .await
            .is_err());
        let action = repos
            .get_connector_action("action-1")
            .await
            .expect("get")
            .expect("present");
        assert_eq!(action.status, "pending");
        // Every legal terminal status passes the constraint.
        for status in ["committed", "ambiguous", "failed"] {
            repos
                .resolve_connector_action("action-1", status)
                .await
                .unwrap_or_else(|_| panic!("status {status} should pass the CHECK"));
        }
    }

    #[tokio::test]
    async fn selected_teams_set_replaces_wholesale_and_orders_by_name() {
        let repos = test_repositories().await;
        assert!(repos
            .list_selected_teams("workspace-1")
            .await
            .expect("list")
            .is_empty());

        repos
            .set_selected_teams(
                "workspace-1",
                &[
                    super::SelectedTeamRecord {
                        team_id: "team-eng".to_string(),
                        team_key: "ENG".to_string(),
                        team_name: "Engineering".to_string(),
                    },
                    super::SelectedTeamRecord {
                        team_id: "team-design".to_string(),
                        team_key: "DES".to_string(),
                        team_name: "Design".to_string(),
                    },
                ],
            )
            .await
            .expect("set teams");
        let teams = repos
            .list_selected_teams("workspace-1")
            .await
            .expect("list");
        // Ordered by team_name, not insertion order.
        assert_eq!(teams.len(), 2);
        assert_eq!(teams[0].team_name, "Design");
        assert_eq!(teams[1].team_name, "Engineering");

        // A second save replaces the set wholesale rather than appending: a
        // team dropped from the picker must actually disappear.
        repos
            .set_selected_teams(
                "workspace-1",
                &[super::SelectedTeamRecord {
                    team_id: "team-design".to_string(),
                    team_key: "DES".to_string(),
                    team_name: "Design".to_string(),
                }],
            )
            .await
            .expect("replace teams");
        let teams = repos
            .list_selected_teams("workspace-1")
            .await
            .expect("list after replace");
        assert_eq!(teams.len(), 1);
        assert_eq!(teams[0].team_id, "team-design");

        // A different account's teams are untouched.
        repos
            .set_selected_teams(
                "workspace-2",
                &[super::SelectedTeamRecord {
                    team_id: "team-other".to_string(),
                    team_key: "OTH".to_string(),
                    team_name: "Other".to_string(),
                }],
            )
            .await
            .expect("set other account teams");
        assert_eq!(
            repos
                .list_selected_teams("workspace-1")
                .await
                .expect("list")
                .len(),
            1
        );
        assert_eq!(
            repos
                .list_selected_teams("workspace-2")
                .await
                .expect("list")
                .len(),
            1
        );
    }

    // Far enough ahead that a recorded run always lands after the approval
    // window that a test opens moments earlier.
    const FUTURE_RUN_END: &str = "2999-01-01T00:00:00.000Z";

    #[tokio::test]
    async fn routine_trust_counts_runs_and_preserves_them_across_set() {
        let repos = test_repositories().await;
        // No trust row yet: recording a run is a no-op.
        assert!(repos
            .record_approval_run("job-1", "run-0", FUTURE_RUN_END)
            .await
            .expect("record with no row")
            .is_none());

        // Entering approval opens the crediting window.
        let record = repos
            .routine_trust_set("job-1", "approval", &[])
            .await
            .expect("set approval");
        assert_eq!(record.trust_mode, "approval");
        assert_eq!(record.approval_run_count, 0);
        assert!(record.approval_since.is_some());

        // Three distinct runs each count once.
        for (index, run_id) in ["run-1", "run-2", "run-3"].iter().enumerate() {
            let credited = repos
                .record_approval_run("job-1", run_id, FUTURE_RUN_END)
                .await
                .expect("record run")
                .expect("row exists");
            assert_eq!(credited.approval_run_count, (index + 1) as i64);
        }

        // Re-reporting a counted run never double counts.
        let again = repos
            .record_approval_run("job-1", "run-3", FUTURE_RUN_END)
            .await
            .expect("record dup")
            .expect("row");
        assert_eq!(again.approval_run_count, 3);

        // Changing the mode keeps the earned run count.
        let record = repos
            .routine_trust_set(
                "job-1",
                "autonomous",
                &scopes(&["gmail.create_draft", "gmail.modify_labels"]),
            )
            .await
            .expect("set trust");
        assert_eq!(record.trust_mode, "autonomous");
        assert_eq!(record.approval_run_count, 3);
        assert_eq!(
            record.autonomous_tools,
            scopes(&["gmail.create_draft", "gmail.modify_labels"])
        );
    }

    #[tokio::test]
    async fn list_routine_trust_by_mode_returns_only_that_mode() {
        let repos = test_repositories().await;
        repos
            .routine_trust_set("job-auto-1", "autonomous", &scopes(&["gmail.send_email"]))
            .await
            .expect("set autonomous 1");
        repos
            .routine_trust_set("job-auto-2", "autonomous", &scopes(&["gmail.create_draft"]))
            .await
            .expect("set autonomous 2");
        repos
            .routine_trust_set("job-approval", "approval", &[])
            .await
            .expect("set approval");
        repos
            .routine_trust_set("job-read", "read_only", &[])
            .await
            .expect("set read_only");

        // Only autonomous rows come back: these are the routines a reconnect
        // re-mints grants for.
        let mut autonomous: Vec<String> = repos
            .list_routine_trust_by_mode("autonomous")
            .await
            .expect("list autonomous")
            .into_iter()
            .map(|record| record.job_id)
            .collect();
        autonomous.sort();
        assert_eq!(autonomous, vec!["job-auto-1", "job-auto-2"]);

        let approval = repos
            .list_routine_trust_by_mode("approval")
            .await
            .expect("list approval");
        assert_eq!(approval.len(), 1);
        assert_eq!(approval[0].job_id, "job-approval");
    }

    #[tokio::test]
    async fn record_approval_run_gates_on_mode_and_window() {
        let repos = test_repositories().await;
        // A read-only routine never earns approval credit.
        repos
            .routine_trust_set("job-1", "read_only", &[])
            .await
            .expect("set read_only");
        let record = repos
            .record_approval_run("job-1", "run-1", FUTURE_RUN_END)
            .await
            .expect("record read_only")
            .expect("row");
        assert_eq!(record.approval_run_count, 0);

        // Switching to approval opens the window at "now".
        repos
            .routine_trust_set("job-1", "approval", &[])
            .await
            .expect("set approval");

        // A run that finished long before the window does not count.
        let before = repos
            .record_approval_run("job-1", "old-run", "2000-01-01T00:00:00.000Z")
            .await
            .expect("record old")
            .expect("row");
        assert_eq!(before.approval_run_count, 0);

        // A run after the window counts.
        let after = repos
            .record_approval_run("job-1", "new-run", FUTURE_RUN_END)
            .await
            .expect("record new")
            .expect("row");
        assert_eq!(after.approval_run_count, 1);
    }

    #[tokio::test]
    async fn delete_routine_connector_state_clears_all_job_rows() {
        let repos = test_repositories().await;
        repos
            .upsert_connector_account(
                "user@example.com",
                "google",
                "user@example.com",
                &scopes(&["openid"]),
                "connected",
                "{}",
            )
            .await
            .expect("account");
        repos
            .replace_connector_trigger("job-1", "event_upcoming", "user@example.com", "{}")
            .await
            .expect("trigger");
        repos
            .set_trigger_cursor("user@example.com", "event_upcoming:job-1", "{}")
            .await
            .expect("cursor");
        repos
            .routine_trust_set("job-1", "approval", &[])
            .await
            .expect("trust");
        repos
            .record_approval_run("job-1", "run-1", FUTURE_RUN_END)
            .await
            .expect("run");
        repos
            .set_connector_grant(
                &super::ConnectorGrant {
                    job_id: "job-1".to_string(),
                    provider: "gmail".to_string(),
                    server_name: "june_gmail_auto_job1".to_string(),
                    token: "tok".to_string(),
                    tools: scopes(&["send_email"]),
                    account_id: "user@example.com".to_string(),
                },
                "2026-07-09T00:00:00.000Z",
            )
            .await
            .expect("grant");
        repos
            .set_routine_browser_grant(&super::RoutineBrowserGrantRecord {
                job_id: "job-1".to_string(),
                server_name: "june_browser_routine_job1".to_string(),
                token: "browser-token".to_string(),
                enabled: true,
            })
            .await
            .expect("browser grant");

        repos
            .delete_routine_connector_state("job-1")
            .await
            .expect("delete state");

        assert!(repos
            .list_connector_triggers(Some("job-1"))
            .await
            .expect("triggers")
            .is_empty());
        assert!(repos
            .trigger_cursor("user@example.com", "event_upcoming:job-1")
            .await
            .expect("cursor")
            .is_none());
        assert!(repos
            .routine_trust_get("job-1")
            .await
            .expect("trust")
            .is_none());
        assert!(repos
            .list_connector_grants()
            .await
            .expect("grants")
            .is_empty());
        assert!(repos
            .routine_browser_grant("job-1")
            .await
            .expect("browser grant")
            .is_none());
        // The account itself survives; only the per-job rows are cleared.
        assert!(repos
            .get_connector_account("user@example.com")
            .await
            .expect("account")
            .is_some());
    }

    #[tokio::test]
    async fn routine_browser_grant_persists_disabled_credentials_for_request_time_refusal() {
        let repos = test_repositories().await;
        let enabled = super::RoutineBrowserGrantRecord {
            job_id: "job-1".to_string(),
            server_name: "june_browser_routine_job1".to_string(),
            token: "browser-token".to_string(),
            enabled: true,
        };
        repos
            .set_routine_browser_grant(&enabled)
            .await
            .expect("enable browser");

        let disabled = super::RoutineBrowserGrantRecord {
            enabled: false,
            ..enabled.clone()
        };
        repos
            .set_routine_browser_grant(&disabled)
            .await
            .expect("disable browser");

        assert_eq!(
            repos
                .routine_browser_grant("job-1")
                .await
                .expect("get browser grant"),
            Some(disabled.clone())
        );
        assert_eq!(
            repos
                .list_routine_browser_grants()
                .await
                .expect("list browser grants"),
            vec![disabled]
        );
    }

    #[tokio::test]
    async fn connector_trigger_replacement_keeps_one_trigger_per_job() {
        let repos = test_repositories().await;
        let first = repos
            .replace_connector_trigger(
                "job-1",
                "email_received",
                "user@example.com",
                r#"{"query":"is:unread"}"#,
            )
            .await
            .expect("set trigger");

        // Changing the kind (or account) replaces the routine's single trigger
        // rather than adding a second row the daemon would also fire.
        let replaced = repos
            .replace_connector_trigger("job-1", "event_upcoming", "other@example.com", "{}")
            .await
            .expect("replace trigger");
        assert_ne!(first.id, replaced.id);

        let for_job = repos
            .list_connector_triggers(Some("job-1"))
            .await
            .expect("list by job");
        assert_eq!(for_job.len(), 1);
        assert_eq!(for_job[0].kind, "event_upcoming");
        assert_eq!(for_job[0].account_id, "other@example.com");

        // The stale row is gone, so deleting the original id now no-ops.
        assert!(!repos
            .delete_connector_trigger(&first.id)
            .await
            .expect("delete stale idempotent"));
        assert!(repos
            .delete_connector_trigger(&replaced.id)
            .await
            .expect("delete current"));
        assert!(repos
            .list_connector_triggers(Some("job-1"))
            .await
            .expect("list after delete")
            .is_empty());
    }

    #[tokio::test]
    async fn connector_trigger_failure_after_delete_rolls_back_old_state() {
        let repos = test_repositories().await;
        repos
            .replace_connector_trigger("job-1", "event_upcoming", "user@example.com", "{}")
            .await
            .expect("old trigger");
        repos
            .set_trigger_cursor("user@example.com", "email_received", "stale-50")
            .await
            .expect("stale cursor");
        query(
            "CREATE TRIGGER fail_connector_trigger_after_delete
             AFTER DELETE ON connector_triggers
             WHEN OLD.job_id = 'job-1'
             BEGIN
               SELECT RAISE(ABORT, 'injected failure after trigger delete');
             END",
        )
        .execute(&repos.pool)
        .await
        .expect("fault trigger");

        let error = repos
            .replace_connector_trigger("job-1", "email_received", "user@example.com", "{}")
            .await
            .expect_err("replacement must fail");
        assert!(error.to_string().contains("injected failure"));

        let triggers = repos
            .list_connector_triggers(Some("job-1"))
            .await
            .expect("old trigger after rollback");
        assert_eq!(triggers.len(), 1);
        assert_eq!(triggers[0].kind, "event_upcoming");
        assert_eq!(
            repos
                .trigger_cursor("user@example.com", "email_received")
                .await
                .expect("old cursor after rollback")
                .as_deref(),
            Some("stale-50")
        );
    }

    #[tokio::test]
    async fn connector_trigger_failure_before_cursor_reset_rolls_back_new_trigger() {
        let repos = test_repositories().await;
        repos
            .replace_connector_trigger("job-1", "event_upcoming", "user@example.com", "{}")
            .await
            .expect("old trigger");
        repos
            .set_trigger_cursor("user@example.com", "email_received", "stale-50")
            .await
            .expect("stale cursor");
        query(
            "CREATE TRIGGER fail_email_cursor_reset
             BEFORE DELETE ON trigger_cursors
             WHEN OLD.account_id = 'user@example.com' AND OLD.kind = 'email_received'
             BEGIN
               SELECT RAISE(ABORT, 'injected failure before cursor reset');
             END",
        )
        .execute(&repos.pool)
        .await
        .expect("fault trigger");

        let error = repos
            .replace_connector_trigger("job-1", "email_received", "user@example.com", "{}")
            .await
            .expect_err("replacement must fail");
        assert!(error.to_string().contains("injected failure"));

        let triggers = repos
            .list_connector_triggers(Some("job-1"))
            .await
            .expect("old trigger after rollback");
        assert_eq!(triggers.len(), 1);
        assert_eq!(triggers[0].kind, "event_upcoming");
        assert_eq!(
            repos
                .trigger_cursor("user@example.com", "email_received")
                .await
                .expect("old cursor after rollback")
                .as_deref(),
            Some("stale-50")
        );
    }

    async fn simulate_email_poll(
        repos: &Repositories,
        current_history_id: u64,
        message_history_ids: &[u64],
    ) -> usize {
        let Some(cursor) = repos
            .trigger_cursor("user@example.com", "email_received")
            .await
            .expect("read simulated poll cursor")
        else {
            repos
                .set_trigger_cursor(
                    "user@example.com",
                    "email_received",
                    &current_history_id.to_string(),
                )
                .await
                .expect("seed simulated poll cursor");
            return 0;
        };
        let cursor: u64 = cursor.parse().expect("numeric test cursor");
        let fire_count = usize::from(
            message_history_ids
                .iter()
                .any(|history_id| *history_id > cursor),
        );
        repos
            .set_trigger_cursor(
                "user@example.com",
                "email_received",
                &current_history_id.to_string(),
            )
            .await
            .expect("advance simulated poll cursor");
        fire_count
    }

    #[tokio::test]
    async fn first_email_after_trigger_replacement_fires_exactly_once() {
        let repos = test_repositories().await;
        repos
            .replace_connector_trigger("job-1", "event_upcoming", "user@example.com", "{}")
            .await
            .expect("old event trigger");
        repos
            .set_trigger_cursor("user@example.com", "email_received", "50")
            .await
            .expect("stale cursor");
        repos
            .set_trigger_cursor("user@example.com", "email_received:job-1", "50")
            .await
            .expect("stale per-routine cursor");

        repos
            .replace_connector_trigger("job-1", "email_received", "user@example.com", "{}")
            .await
            .expect("first email subscription");
        assert!(repos
            .trigger_cursor("user@example.com", "email_received")
            .await
            .expect("cursor reset")
            .is_none());
        assert!(repos
            .trigger_cursor("user@example.com", "email_received:job-1")
            .await
            .expect("per-routine cursor reset")
            .is_none());

        let mut fire_count = simulate_email_poll(&repos, 100, &[]).await;
        fire_count += simulate_email_poll(&repos, 101, &[101]).await;
        fire_count += simulate_email_poll(&repos, 101, &[101]).await;

        // Editing an existing subscription is a replacement, not a reconnect:
        // retaining cursor 101 prevents the already-fired mail from repeating.
        repos
            .replace_connector_trigger(
                "job-1",
                "email_received",
                "user@example.com",
                r#"{"query":"is:unread"}"#,
            )
            .await
            .expect("edit email trigger");
        assert_eq!(
            repos
                .trigger_cursor("user@example.com", "email_received")
                .await
                .expect("cursor retained")
                .as_deref(),
            Some("101")
        );
        fire_count += simulate_email_poll(&repos, 101, &[101]).await;
        assert_eq!(fire_count, 1);
    }

    #[tokio::test]
    async fn removed_email_subscription_does_not_reuse_its_old_cursor() {
        let repos = test_repositories().await;
        let removed = repos
            .replace_connector_trigger("job-1", "email_received", "user@example.com", "{}")
            .await
            .expect("first email trigger");
        repos
            .replace_connector_trigger("job-2", "email_received", "user@example.com", "{}")
            .await
            .expect("peer email trigger");
        repos
            .set_trigger_cursor("user@example.com", "email_received", "100")
            .await
            .unwrap();
        repos
            .set_trigger_cursor("user@example.com", "email_received:job-1", "80")
            .await
            .unwrap();

        assert!(repos
            .delete_connector_trigger(&removed.id)
            .await
            .expect("remove subscription"));
        assert!(repos
            .trigger_cursor("user@example.com", "email_received:job-1")
            .await
            .unwrap()
            .is_none());

        repos
            .replace_connector_trigger("job-1", "email_received", "user@example.com", "{}")
            .await
            .expect("re-enable subscription");
        assert!(repos
            .trigger_cursor("user@example.com", "email_received:job-1")
            .await
            .unwrap()
            .is_none());
        assert_eq!(
            repos
                .trigger_cursor("user@example.com", "email_received")
                .await
                .unwrap()
                .as_deref(),
            Some("100")
        );

        repos
            .set_trigger_cursor("user@example.com", "email_received:job-1", "100")
            .await
            .unwrap();
        repos
            .replace_connector_trigger("job-1", "event_upcoming", "user@example.com", "{}")
            .await
            .expect("switch trigger kind");
        assert!(repos
            .trigger_cursor("user@example.com", "email_received:job-1")
            .await
            .unwrap()
            .is_none());
    }

    #[tokio::test]
    async fn concurrent_poll_snapshot_sees_no_trigger_cursor_half_state() {
        let (_directory, repos) = concurrent_test_repositories().await;
        repos
            .replace_connector_trigger("job-1", "event_upcoming", "user@example.com", "{}")
            .await
            .expect("old event trigger");
        repos
            .set_trigger_cursor("user@example.com", "email_received", "stale-50")
            .await
            .expect("stale cursor");

        let mut poll_snapshot = repos.pool.begin().await.expect("poll snapshot");
        let old_kind: String = query("SELECT kind FROM connector_triggers WHERE job_id = 'job-1'")
            .fetch_one(&mut *poll_snapshot)
            .await
            .expect("old trigger in snapshot")
            .get("kind");
        assert_eq!(old_kind, "event_upcoming");

        repos
            .replace_connector_trigger("job-1", "email_received", "user@example.com", "{}")
            .await
            .expect("concurrent replacement");

        let snapshot_kind: String =
            query("SELECT kind FROM connector_triggers WHERE job_id = 'job-1'")
                .fetch_one(&mut *poll_snapshot)
                .await
                .expect("stable trigger snapshot")
                .get("kind");
        let snapshot_cursor: String = query(
            "SELECT cursor FROM trigger_cursors
             WHERE account_id = 'user@example.com' AND kind = 'email_received'",
        )
        .fetch_one(&mut *poll_snapshot)
        .await
        .expect("stable cursor snapshot")
        .get("cursor");
        assert_eq!(snapshot_kind, "event_upcoming");
        assert_eq!(snapshot_cursor, "stale-50");
        poll_snapshot.commit().await.expect("finish poll snapshot");

        let triggers = repos
            .list_connector_triggers(Some("job-1"))
            .await
            .expect("new trigger");
        assert_eq!(triggers.len(), 1);
        assert_eq!(triggers[0].kind, "email_received");
        assert!(repos
            .trigger_cursor("user@example.com", "email_received")
            .await
            .expect("new cursor state")
            .is_none());
    }

    #[tokio::test]
    async fn connector_grant_set_list_find_and_delete_round_trip() {
        let repos = test_repositories().await;
        assert!(repos
            .list_connector_grants()
            .await
            .expect("list")
            .is_empty());

        let gmail = super::ConnectorGrant {
            job_id: "job-1".to_string(),
            provider: "gmail".to_string(),
            server_name: "june_gmail_auto_job1".to_string(),
            token: "gmail-token".to_string(),
            tools: scopes(&["create_draft", "send_email"]),
            account_id: "user@example.com".to_string(),
        };
        let gcal = super::ConnectorGrant {
            job_id: "job-1".to_string(),
            provider: "gcal".to_string(),
            server_name: "june_gcal_auto_job1".to_string(),
            token: "gcal-token".to_string(),
            tools: scopes(&["create_event"]),
            account_id: "user@example.com".to_string(),
        };
        repos
            .set_connector_grant(&gmail, "2026-07-09T00:00:00.000Z")
            .await
            .expect("set gmail");
        repos
            .set_connector_grant(&gcal, "2026-07-09T00:00:00.000Z")
            .await
            .expect("set gcal");

        let all = repos.list_connector_grants().await.expect("list");
        assert_eq!(all.len(), 2);
        // Ordered gcal before gmail (provider ASC).
        assert_eq!(all[0], gcal);
        assert_eq!(all[1], gmail);

        let for_job = repos
            .connector_grants_for_job("job-1")
            .await
            .expect("for job");
        assert_eq!(for_job.len(), 2);
        assert!(repos
            .connector_grants_for_job("job-2")
            .await
            .expect("other job")
            .is_empty());

        let found = repos
            .find_connector_grant_by_token("gmail-token")
            .await
            .expect("find")
            .expect("present");
        assert_eq!(found, gmail);
        assert!(repos
            .find_connector_grant_by_token("nope")
            .await
            .expect("find")
            .is_none());

        // Upsert on (job, provider) replaces token + tools in place.
        let gmail_v2 = super::ConnectorGrant {
            token: "gmail-token-2".to_string(),
            tools: scopes(&["create_draft", "send_email", "modify_labels"]),
            ..gmail.clone()
        };
        repos
            .set_connector_grant(&gmail_v2, "2026-07-09T01:00:00.000Z")
            .await
            .expect("upsert gmail");
        let all = repos.list_connector_grants().await.expect("list");
        assert_eq!(all.len(), 2);
        assert!(repos
            .find_connector_grant_by_token("gmail-token")
            .await
            .expect("find old")
            .is_none());
        assert_eq!(
            repos
                .find_connector_grant_by_token("gmail-token-2")
                .await
                .expect("find new")
                .expect("present")
                .tools,
            scopes(&["create_draft", "send_email", "modify_labels"])
        );

        repos
            .delete_connector_grants("job-1")
            .await
            .expect("delete");
        assert!(repos
            .list_connector_grants()
            .await
            .expect("list")
            .is_empty());
        // Idempotent.
        repos
            .delete_connector_grants("job-1")
            .await
            .expect("delete idempotent");
    }

    #[tokio::test]
    async fn trigger_cursor_round_trips_and_overwrites() {
        let repos = test_repositories().await;
        assert!(repos
            .trigger_cursor("user@example.com", "email_received")
            .await
            .expect("get")
            .is_none());
        repos
            .set_trigger_cursor("user@example.com", "email_received", "100")
            .await
            .expect("set");
        repos
            .set_trigger_cursor("user@example.com", "email_received", "200")
            .await
            .expect("overwrite");
        repos
            .set_trigger_cursor("user@example.com", "event_upcoming", "sync-token-1")
            .await
            .expect("set other kind");
        assert_eq!(
            repos
                .trigger_cursor("user@example.com", "email_received")
                .await
                .expect("get")
                .as_deref(),
            Some("200")
        );
        assert_eq!(
            repos
                .trigger_cursor("user@example.com", "event_upcoming")
                .await
                .expect("get")
                .as_deref(),
            Some("sync-token-1")
        );
    }

    #[tokio::test]
    async fn clear_trigger_cursor_removes_only_that_account_and_kind() {
        let repos = test_repositories().await;
        repos
            .set_trigger_cursor("user@example.com", "email_received", "100")
            .await
            .expect("set email");
        repos
            .set_trigger_cursor("user@example.com", "event_upcoming", "sync-1")
            .await
            .expect("set event");

        repos
            .clear_trigger_cursor("user@example.com", "email_received")
            .await
            .expect("clear email");

        // The mail cursor is gone, so the next poll reseeds a fresh baseline.
        assert!(repos
            .trigger_cursor("user@example.com", "email_received")
            .await
            .expect("get email")
            .is_none());
        // Other kinds are untouched.
        assert_eq!(
            repos
                .trigger_cursor("user@example.com", "event_upcoming")
                .await
                .expect("get event")
                .as_deref(),
            Some("sync-1")
        );
        // Clearing an absent cursor is a no-op, not an error.
        repos
            .clear_trigger_cursor("user@example.com", "email_received")
            .await
            .expect("clear idempotent");
    }

    #[tokio::test]
    async fn share_keys_round_trip_and_purge() {
        use super::{ShareInviteKeyRecord, ShareKeyRecord};

        let repos = test_repositories().await;
        let share_key = ShareKeyRecord {
            share_id: "shr_1".to_string(),
            item_kind: "note".to_string(),
            item_id: "note_1".to_string(),
            content_key: vec![1u8; 32],
        };
        repos.save_share_key(&share_key).await.expect("save key");
        // Saving again for the same share replaces rather than duplicating.
        let replacement = ShareKeyRecord {
            content_key: vec![2u8; 32],
            ..share_key.clone()
        };
        repos
            .save_share_key(&replacement)
            .await
            .expect("upsert key");
        assert_eq!(
            repos
                .share_key_for_item("note", "note_1")
                .await
                .expect("get key"),
            Some(replacement)
        );
        assert_eq!(
            repos
                .share_key_for_item("note", "missing")
                .await
                .expect("get missing"),
            None
        );

        let invite_key = ShareInviteKeyRecord {
            invite_id: "shi_1".to_string(),
            share_id: "shr_1".to_string(),
            invite_key: vec![3u8; 32],
        };
        repos
            .save_share_invite_key(&invite_key)
            .await
            .expect("save invite key");
        repos
            .save_share_invite_key(&ShareInviteKeyRecord {
                invite_id: "shi_2".to_string(),
                share_id: "shr_1".to_string(),
                invite_key: vec![4u8; 32],
            })
            .await
            .expect("save second invite key");
        let keys = repos.share_invite_keys("shr_1").await.expect("list");
        assert_eq!(keys.len(), 2);
        assert_eq!(keys[0].invite_id, "shi_1");
        assert_eq!(keys[0].invite_key, vec![3u8; 32]);

        repos.delete_share_keys("shr_1").await.expect("purge");
        assert!(repos
            .share_key_for_item("note", "note_1")
            .await
            .expect("get after purge")
            .is_none());
        assert!(repos
            .share_invite_keys("shr_1")
            .await
            .expect("list after purge")
            .is_empty());
    }

    #[tokio::test]
    async fn save_share_key_replaces_a_different_share_for_the_same_item() {
        use super::ShareKeyRecord;

        let repos = test_repositories().await;
        repos
            .save_share_key(&ShareKeyRecord {
                share_id: "shr_old".to_string(),
                item_kind: "note".to_string(),
                item_id: "note_1".to_string(),
                content_key: vec![1u8; 32],
            })
            .await
            .expect("save first");
        // A fresh share for the same item (re-sharing after the old share is
        // gone, or owned by a different signed-in account) replaces the stale
        // mapping rather than colliding on the item unique index.
        let replacement = ShareKeyRecord {
            share_id: "shr_new".to_string(),
            item_kind: "note".to_string(),
            item_id: "note_1".to_string(),
            content_key: vec![2u8; 32],
        };
        repos
            .save_share_key(&replacement)
            .await
            .expect("replace by item");
        assert_eq!(
            repos
                .share_key_for_item("note", "note_1")
                .await
                .expect("get key"),
            Some(replacement)
        );
    }
}
