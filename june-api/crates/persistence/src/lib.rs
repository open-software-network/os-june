//! Postgres-backed `ShareStore` (JUN-308) — the first persistent state in
//! june-api. Everything stored here is ciphertext or ACL metadata; plaintext
//! and content keys never reach this crate by construction. Nothing in this
//! crate logs payload bytes.

use async_trait::async_trait;
use june_domain::{
    MAX_INVITES_PER_SHARE, NewShare, NewShareInvite, SHARE_LINK_EMAIL, ShareInviteRecord,
    ShareKind, ShareRecord, ShareStore, ShareStoreError, ShareViewRecord, ViewRequest,
};
use sqlx::{
    PgPool, Row,
    postgres::PgPoolOptions,
    types::chrono::{DateTime, Utc},
};

static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("./migrations");

pub struct PgShareStore {
    pool: PgPool,
}

impl PgShareStore {
    /// Connects and runs migrations. Called once at boot; a failure here is
    /// surfaced as "sharing unavailable", never a crash of the whole API.
    pub async fn connect(database_url: &str) -> Result<Self, ShareStoreError> {
        let pool = PgPoolOptions::new()
            .max_connections(8)
            .connect(database_url)
            .await
            .map_err(|error| ShareStoreError::Unavailable {
                reason: format!("connect failed: {error}"),
            })?;
        MIGRATOR
            .run(&pool)
            .await
            .map_err(|error| ShareStoreError::Unavailable {
                reason: format!("migration failed: {error}"),
            })?;
        Ok(Self { pool })
    }

    pub fn from_pool(pool: PgPool) -> Self {
        Self { pool }
    }
}

fn query_error(error: sqlx::Error) -> ShareStoreError {
    match error {
        sqlx::Error::RowNotFound => ShareStoreError::NotFound,
        other => ShareStoreError::Unavailable {
            reason: format!("query failed: {other}"),
        },
    }
}

fn rfc3339(ts: DateTime<Utc>) -> String {
    // Whole-second RFC 3339 with a Z suffix; sub-second precision is noise
    // for share metadata.
    ts.format("%Y-%m-%dT%H:%M:%SZ").to_string()
}

#[async_trait]
impl ShareStore for PgShareStore {
    async fn create_share(&self, share: NewShare) -> Result<(), ShareStoreError> {
        let mut tx = self.pool.begin().await.map_err(query_error)?;
        let row_id = sqlx::query_scalar::<_, i64>(
            r"
            INSERT INTO shares (share_id, owner_user_id, kind, ciphertext, iv)
            VALUES ($1, $2, $3, $4, $5)
            RETURNING id
            ",
        )
        .bind(&share.share_id)
        .bind(&share.owner_user_id.0)
        .bind(share.kind.as_str())
        .bind(&share.ciphertext)
        .bind(&share.iv)
        .fetch_one(&mut *tx)
        .await
        .map_err(query_error)?;
        for (invite_id, invite) in &share.invites {
            insert_invite(&mut tx, row_id, invite_id, invite).await?;
        }
        tx.commit().await.map_err(query_error)?;
        Ok(())
    }

    async fn list_shares(&self, owner: &str) -> Result<Vec<ShareRecord>, ShareStoreError> {
        let rows = sqlx::query(
            r"
            SELECT share_id, owner_user_id, kind, created_at
            FROM shares
            WHERE owner_user_id = $1 AND deleted_at IS NULL
            ORDER BY created_at DESC
            ",
        )
        .bind(owner)
        .fetch_all(&self.pool)
        .await
        .map_err(query_error)?;
        rows.into_iter().map(|row| share_record(&row)).collect()
    }

    async fn share_invites(
        &self,
        owner: &str,
        share_id: &str,
    ) -> Result<(ShareRecord, Vec<ShareInviteRecord>), ShareStoreError> {
        let share_row = sqlx::query(
            r"
            SELECT id, share_id, owner_user_id, kind, created_at
            FROM shares
            WHERE share_id = $1 AND owner_user_id = $2 AND deleted_at IS NULL
            ",
        )
        .bind(share_id)
        .bind(owner)
        .fetch_optional(&self.pool)
        .await
        .map_err(query_error)?
        .ok_or(ShareStoreError::NotFound)?;
        let row_id: i64 = share_row.try_get("id").map_err(query_error)?;
        let record = share_record(&share_row)?;
        let invite_rows = sqlx::query(
            r"
            SELECT invite_id, email, recipient_user_id, accepted_at, revoked_at, last_access_at
            FROM share_invites
            WHERE share_id = $1
            ORDER BY created_at ASC
            ",
        )
        .bind(row_id)
        .fetch_all(&self.pool)
        .await
        .map_err(query_error)?;
        let invites = invite_rows
            .into_iter()
            .map(|row| invite_record(&row))
            .collect::<Result<Vec<_>, _>>()?;
        Ok((record, invites))
    }

    async fn add_invites(
        &self,
        owner: &str,
        share_id: &str,
        invites: Vec<(String, NewShareInvite)>,
    ) -> Result<(), ShareStoreError> {
        let mut tx = self.pool.begin().await.map_err(query_error)?;
        let row_id = sqlx::query_scalar::<_, i64>(
            r"
            SELECT id FROM shares
            WHERE share_id = $1 AND owner_user_id = $2 AND deleted_at IS NULL
            FOR UPDATE
            ",
        )
        .bind(share_id)
        .bind(owner)
        .fetch_optional(&mut *tx)
        .await
        .map_err(query_error)?
        .ok_or(ShareStoreError::NotFound)?;
        let existing =
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM share_invites WHERE share_id = $1")
                .bind(row_id)
                .fetch_one(&mut *tx)
                .await
                .map_err(query_error)?;
        let total = usize::try_from(existing).unwrap_or(usize::MAX);
        if total.saturating_add(invites.len()) > MAX_INVITES_PER_SHARE {
            return Err(ShareStoreError::InviteLimitExceeded);
        }
        // Reject any email that already holds a non-revoked invite on this
        // share. The viewer authorizes by any active invite for a verified
        // email, so a second active row would survive revoking the first.
        let new_emails: Vec<String> = invites
            .iter()
            .map(|(_, invite)| invite.email.clone())
            .collect();
        let clash = sqlx::query_scalar::<_, i64>(
            r"
            SELECT COUNT(*) FROM share_invites
            WHERE share_id = $1 AND revoked_at IS NULL AND email = ANY($2)
            ",
        )
        .bind(row_id)
        .bind(&new_emails)
        .fetch_one(&mut *tx)
        .await
        .map_err(query_error)?;
        if clash > 0 {
            return Err(ShareStoreError::DuplicateActiveInvite);
        }
        for (invite_id, invite) in &invites {
            insert_invite(&mut tx, row_id, invite_id, invite).await?;
        }
        tx.commit().await.map_err(query_error)?;
        Ok(())
    }

    async fn revoke_invite(
        &self,
        owner: &str,
        share_id: &str,
        invite_id: &str,
    ) -> Result<(), ShareStoreError> {
        let updated = sqlx::query(
            r"
            UPDATE share_invites i
            SET revoked_at = COALESCE(i.revoked_at, now())
            FROM shares s
            WHERE i.share_id = s.id
              AND i.invite_id = $1
              AND s.share_id = $2
              AND s.owner_user_id = $3
              AND s.deleted_at IS NULL
            ",
        )
        .bind(invite_id)
        .bind(share_id)
        .bind(owner)
        .execute(&self.pool)
        .await
        .map_err(query_error)?;
        if updated.rows_affected() == 0 {
            return Err(ShareStoreError::NotFound);
        }
        Ok(())
    }

    async fn delete_share(&self, owner: &str, share_id: &str) -> Result<(), ShareStoreError> {
        // Soft-delete the row and drop the ciphertext bytes immediately: a
        // deleted share must not keep user content at rest.
        let updated = sqlx::query(
            r"
            UPDATE shares
            SET deleted_at = COALESCE(deleted_at, now()),
                ciphertext = ''::BYTEA
            WHERE share_id = $1 AND owner_user_id = $2
            ",
        )
        .bind(share_id)
        .bind(owner)
        .execute(&self.pool)
        .await
        .map_err(query_error)?;
        if updated.rows_affected() == 0 {
            return Err(ShareStoreError::NotFound);
        }
        Ok(())
    }

    async fn fetch_view(
        &self,
        request: ViewRequest<'_>,
    ) -> Result<ShareViewRecord, ShareStoreError> {
        let ViewRequest {
            share_id,
            viewer_user_id,
            viewer_emails,
            invite_id,
        } = request;
        let mut tx = self.pool.begin().await.map_err(query_error)?;
        let share_row = sqlx::query(
            r"
            SELECT id, owner_user_id, kind, ciphertext, iv
            FROM shares
            WHERE share_id = $1 AND deleted_at IS NULL
            FOR UPDATE
            ",
        )
        .bind(share_id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(query_error)?
        .ok_or(ShareStoreError::NotFound)?;
        let row_id: i64 = share_row.try_get("id").map_err(query_error)?;
        let owner: String = share_row.try_get("owner_user_id").map_err(query_error)?;
        let kind = parse_kind(&share_row)?;
        let ciphertext: Vec<u8> = share_row.try_get("ciphertext").map_err(query_error)?;
        let iv: Vec<u8> = share_row.try_get("iv").map_err(query_error)?;

        if owner == viewer_user_id {
            tx.commit().await.map_err(query_error)?;
            return Ok(ShareViewRecord {
                kind,
                owner_user_id: owner,
                ciphertext,
                iv,
                envelope: None,
            });
        }

        // Match a non-revoked invite. The invited email must still be one of
        // the caller's currently-verified emails ($3) — enforced even for an
        // already-bound invite, so access lapses if the recipient later removes
        // that address from their account. Among those, the invite must be
        // unbound or bound to this caller. When the viewer carries an invite id
        // ($4), pin to that invite so a caller holding several verified emails
        // gets the envelope for the link they opened; the id only narrows the
        // match, it never widens the authorization.
        let invite_row = sqlx::query(
            r"
            SELECT id, envelope, envelope_iv
            FROM share_invites
            WHERE share_id = $1
              AND revoked_at IS NULL
              AND email = ANY($3)
              AND (recipient_user_id IS NULL OR recipient_user_id = $2)
              AND ($4::text IS NULL OR invite_id = $4)
            ORDER BY (recipient_user_id = $2) DESC, created_at ASC
            LIMIT 1
            FOR UPDATE
            ",
        )
        .bind(row_id)
        .bind(viewer_user_id)
        .bind(viewer_emails)
        .bind(invite_id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(query_error)?
        .ok_or(ShareStoreError::NotFound)?;
        let invite_row_id: i64 = invite_row.try_get("id").map_err(query_error)?;
        let envelope: Vec<u8> = invite_row.try_get("envelope").map_err(query_error)?;
        let envelope_iv: Vec<u8> = invite_row.try_get("envelope_iv").map_err(query_error)?;

        let updated = sqlx::query(
            r"
            UPDATE share_invites
            SET recipient_user_id = COALESCE(recipient_user_id, $2),
                accepted_at = COALESCE(accepted_at, now()),
                last_access_at = now()
            WHERE id = $1
              AND revoked_at IS NULL
              AND email = ANY($3)
              AND (recipient_user_id IS NULL OR recipient_user_id = $2)
            ",
        )
        .bind(invite_row_id)
        .bind(viewer_user_id)
        .bind(viewer_emails)
        .execute(&mut *tx)
        .await
        .map_err(query_error)?;
        if updated.rows_affected() == 0 {
            return Err(ShareStoreError::NotFound);
        }
        tx.commit().await.map_err(query_error)?;

        Ok(ShareViewRecord {
            kind,
            owner_user_id: owner,
            ciphertext,
            iv,
            envelope: Some((envelope, envelope_iv)),
        })
    }

    async fn fetch_link_view(
        &self,
        share_id: &str,
        invite_id: &str,
    ) -> Result<ShareViewRecord, ShareStoreError> {
        let mut tx = self.pool.begin().await.map_err(query_error)?;
        let row = sqlx::query(
            r"
            SELECT s.kind, s.owner_user_id, s.ciphertext, s.iv,
                   i.id AS invite_row_id, i.envelope, i.envelope_iv
            FROM shares s
            JOIN share_invites i ON i.share_id = s.id
            WHERE s.share_id = $1
              AND s.deleted_at IS NULL
              AND i.invite_id = $2
              AND i.email = $3
              AND i.revoked_at IS NULL
            FOR UPDATE OF i
            ",
        )
        .bind(share_id)
        .bind(invite_id)
        .bind(SHARE_LINK_EMAIL)
        .fetch_optional(&mut *tx)
        .await
        .map_err(query_error)?
        .ok_or(ShareStoreError::NotFound)?;

        let invite_row_id: i64 = row.try_get("invite_row_id").map_err(query_error)?;
        let updated = sqlx::query(
            "UPDATE share_invites SET last_access_at = now() WHERE id = $1 AND revoked_at IS NULL",
        )
        .bind(invite_row_id)
        .execute(&mut *tx)
        .await
        .map_err(query_error)?;
        if updated.rows_affected() == 0 {
            return Err(ShareStoreError::NotFound);
        }

        let kind = parse_kind(&row)?;
        let owner_user_id = row.try_get("owner_user_id").map_err(query_error)?;
        let ciphertext = row.try_get("ciphertext").map_err(query_error)?;
        let iv = row.try_get("iv").map_err(query_error)?;
        let envelope = row.try_get("envelope").map_err(query_error)?;
        let envelope_iv = row.try_get("envelope_iv").map_err(query_error)?;
        tx.commit().await.map_err(query_error)?;

        Ok(ShareViewRecord {
            kind,
            owner_user_id,
            ciphertext,
            iv,
            envelope: Some((envelope, envelope_iv)),
        })
    }
}

async fn insert_invite(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    share_row_id: i64,
    invite_id: &str,
    invite: &NewShareInvite,
) -> Result<(), ShareStoreError> {
    sqlx::query(
        r"
        INSERT INTO share_invites (invite_id, share_id, email, envelope, envelope_iv)
        VALUES ($1, $2, $3, $4, $5)
        ",
    )
    .bind(invite_id)
    .bind(share_row_id)
    .bind(&invite.email)
    .bind(&invite.envelope)
    .bind(&invite.envelope_iv)
    .execute(&mut **tx)
    .await
    .map_err(insert_invite_error)?;
    Ok(())
}

/// Maps a violation of the active-email uniqueness index to a clean
/// `DuplicateActiveInvite`. This is the authoritative guard: it fires even
/// when two concurrent add-invite transactions both pass the pre-insert clash
/// check under READ COMMITTED. Any other error (including an `invite_id`
/// collision, which is astronomically unlikely) falls through unchanged.
fn insert_invite_error(error: sqlx::Error) -> ShareStoreError {
    if let sqlx::Error::Database(db_error) = &error
        && db_error.constraint() == Some("idx_share_invites_active_email")
    {
        return ShareStoreError::DuplicateActiveInvite;
    }
    query_error(error)
}

fn share_record(row: &sqlx::postgres::PgRow) -> Result<ShareRecord, ShareStoreError> {
    Ok(ShareRecord {
        share_id: row.try_get("share_id").map_err(query_error)?,
        owner_user_id: row.try_get("owner_user_id").map_err(query_error)?,
        kind: parse_kind(row)?,
        created_at: rfc3339(row.try_get("created_at").map_err(query_error)?),
    })
}

fn parse_kind(row: &sqlx::postgres::PgRow) -> Result<ShareKind, ShareStoreError> {
    let kind: String = row.try_get("kind").map_err(query_error)?;
    ShareKind::parse(&kind).ok_or_else(|| ShareStoreError::Unavailable {
        reason: format!("unknown share kind '{kind}' in store"),
    })
}

fn invite_record(row: &sqlx::postgres::PgRow) -> Result<ShareInviteRecord, ShareStoreError> {
    let accepted: Option<DateTime<Utc>> = row.try_get("accepted_at").map_err(query_error)?;
    let revoked: Option<DateTime<Utc>> = row.try_get("revoked_at").map_err(query_error)?;
    let last_access: Option<DateTime<Utc>> = row.try_get("last_access_at").map_err(query_error)?;
    Ok(ShareInviteRecord {
        invite_id: row.try_get("invite_id").map_err(query_error)?,
        email: row.try_get("email").map_err(query_error)?,
        recipient_user_id: row.try_get("recipient_user_id").map_err(query_error)?,
        accepted_at: accepted.map(rfc3339),
        revoked_at: revoked.map(rfc3339),
        last_access_at: last_access.map(rfc3339),
    })
}
