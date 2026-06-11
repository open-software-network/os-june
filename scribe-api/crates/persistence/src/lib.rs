#![cfg_attr(test, allow(clippy::expect_used, clippy::unwrap_used, clippy::panic))]

//! SQLite-backed storage for scribe-api. The service is a single instance
//! inside the TEE, so `SQLite` on the CVM's encrypted volume is the right
//! weight; the `SharedNotesStore` port in `scribe-domain` keeps a Postgres
//! swap from touching anything above this crate.

use async_trait::async_trait;
use scribe_domain::{
    CreateSharedNoteParams, DomainError, RevokeOutcome, ShareId, SharedNote, SharedNotesStore,
    UserId,
};
use sqlx::{
    Row, SqlitePool,
    sqlite::{SqliteConnectOptions, SqlitePoolOptions},
};
use std::{path::Path, str::FromStr};

static MIGRATIONS: sqlx::migrate::Migrator = sqlx::migrate!("./migrations");

/// Opens (creating if needed) the `SQLite` database at `path` and applies
/// migrations. `:memory:` is honored for tests.
pub async fn connect(path: &str) -> Result<SqlitePool, sqlx::Error> {
    if path != ":memory:"
        && let Some(parent) = Path::new(path).parent()
        && !parent.as_os_str().is_empty()
    {
        tokio::fs::create_dir_all(parent).await.ok();
    }
    let options = SqliteConnectOptions::from_str(&format!("sqlite://{path}"))?
        .create_if_missing(true)
        .journal_mode(sqlx::sqlite::SqliteJournalMode::Wal);
    let pool = SqlitePoolOptions::new()
        .max_connections(8)
        .connect_with(options)
        .await?;
    MIGRATIONS.run(&pool).await?;
    Ok(pool)
}

pub struct SqliteSharedNotesStore {
    pool: SqlitePool,
}

impl SqliteSharedNotesStore {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }
}

fn storage_error(error: &sqlx::Error) -> DomainError {
    tracing::error!(%error, "shared notes storage failed");
    DomainError::Storage
}

#[async_trait]
impl SharedNotesStore for SqliteSharedNotesStore {
    async fn create(&self, params: CreateSharedNoteParams) -> Result<SharedNote, DomainError> {
        sqlx::query(
            "INSERT INTO shared_notes (id, user_id, title, body_markdown, shared_by, created_at) \
             VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind(&params.id.0)
        .bind(&params.user_id.0)
        .bind(&params.title)
        .bind(&params.body_markdown)
        .bind(&params.shared_by)
        .bind(&params.created_at)
        .execute(&self.pool)
        .await
        .map_err(|error| storage_error(&error))?;
        Ok(SharedNote {
            id: params.id,
            user_id: params.user_id,
            title: params.title,
            body_markdown: params.body_markdown,
            shared_by: params.shared_by,
            created_at: params.created_at,
        })
    }

    async fn get(&self, id: &ShareId) -> Result<Option<SharedNote>, DomainError> {
        let row = sqlx::query(
            "SELECT id, user_id, title, body_markdown, shared_by, created_at \
             FROM shared_notes WHERE id = ? AND revoked_at IS NULL",
        )
        .bind(&id.0)
        .fetch_optional(&self.pool)
        .await
        .map_err(|error| storage_error(&error))?;
        Ok(row.map(|row| SharedNote {
            id: ShareId(row.get("id")),
            user_id: UserId(row.get("user_id")),
            title: row.get("title"),
            body_markdown: row.get("body_markdown"),
            shared_by: row.get("shared_by"),
            created_at: row.get("created_at"),
        }))
    }

    async fn revoke(&self, id: &ShareId, owner: &UserId) -> Result<RevokeOutcome, DomainError> {
        let result = sqlx::query(
            "UPDATE shared_notes SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') \
             WHERE id = ? AND user_id = ? AND revoked_at IS NULL",
        )
        .bind(&id.0)
        .bind(&owner.0)
        .execute(&self.pool)
        .await
        .map_err(|error| storage_error(&error))?;
        Ok(if result.rows_affected() > 0 {
            RevokeOutcome::Revoked
        } else {
            RevokeOutcome::NotFound
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn params(id: &str, user: &str) -> CreateSharedNoteParams {
        CreateSharedNoteParams {
            id: ShareId(id.to_string()),
            user_id: UserId(user.to_string()),
            title: "Weekly sync".to_string(),
            body_markdown: "# Notes\nHello".to_string(),
            shared_by: "Gaut".to_string(),
            created_at: "2026-06-11T00:00:00Z".to_string(),
        }
    }

    #[tokio::test]
    async fn create_get_revoke_round_trip() {
        let pool = connect(":memory:").await.expect("connect");
        let store = SqliteSharedNotesStore::new(pool);

        let created = store
            .create(params("share-1", "usr_a"))
            .await
            .expect("create");
        assert_eq!(created.title, "Weekly sync");

        let fetched = store
            .get(&ShareId("share-1".to_string()))
            .await
            .expect("get")
            .expect("present");
        assert_eq!(fetched.shared_by, "Gaut");

        // Someone else cannot revoke; the owner can; revoked reads as gone.
        let outcome = store
            .revoke(
                &ShareId("share-1".to_string()),
                &UserId("usr_b".to_string()),
            )
            .await
            .expect("revoke other");
        assert_eq!(outcome, RevokeOutcome::NotFound);
        let outcome = store
            .revoke(
                &ShareId("share-1".to_string()),
                &UserId("usr_a".to_string()),
            )
            .await
            .expect("revoke owner");
        assert_eq!(outcome, RevokeOutcome::Revoked);
        assert!(
            store
                .get(&ShareId("share-1".to_string()))
                .await
                .expect("get revoked")
                .is_none()
        );
        // Idempotent second revoke reads as NotFound.
        let outcome = store
            .revoke(
                &ShareId("share-1".to_string()),
                &UserId("usr_a".to_string()),
            )
            .await
            .expect("revoke again");
        assert_eq!(outcome, RevokeOutcome::NotFound);
    }
}
