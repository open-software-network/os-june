use crate::{app_paths, db::repositories::Repositories, domain::types::AppError};
use chrono::{DateTime, SecondsFormat, Utc};
use june_companion_protocol::{
    AttachmentReference, AttachmentSource, BrowseEntry, BrowseEntryKind, BrowseFile, BrowseRoot,
    Page, PageRequest, UploadBeginRequest, UploadChunkRequest, UploadProgress, MAX_BROWSE_ROOTS,
    MAX_PAGE_SIZE, MAX_UPLOAD_BYTES,
};
use sha2::{Digest, Sha256};
use sqlx::{query::query, row::Row};
use std::{
    path::{Component, Path, PathBuf},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager};
use tokio::{
    fs::{self, OpenOptions},
    io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt},
};
use uuid::Uuid;

const UPLOAD_LIFETIME: Duration = Duration::from_secs(60 * 60);
const BROWSE_REFERENCE_LIFETIME: Duration = Duration::from_secs(15 * 60);
const MAX_ACTIVE_UPLOADS_PER_DEVICE: i64 = 4;
const MAX_STAGED_UPLOAD_BYTES_PER_DEVICE: i64 = 50 * 1024 * 1024;
const MAX_BROWSE_REFERENCES_PER_DEVICE: usize = 128;
const MAX_ROOT_DISPLAY_NAME_BYTES: usize = 128;
const CLEANUP_INTERVAL: Duration = Duration::from_secs(60);

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct BrowseRootRecord {
    pub id: Uuid,
    pub canonical_path: PathBuf,
    pub display_name: String,
    volume_device_id: String,
    directory_file_id: String,
}

#[derive(Debug, Clone)]
pub(super) struct BrowseReference {
    account_user_id: String,
    device_id: String,
    root_id: Uuid,
    relative_path: String,
    expires_at_ms: u64,
}

#[derive(Debug, Clone)]
struct UploadRecord {
    reservation_id: Uuid,
    name: String,
    media_type: Option<String>,
    size_bytes: u64,
    sha256: String,
    accepted_bytes: u64,
    state: UploadState,
    attachment_reference_id: Option<Uuid>,
    expires_at_ms: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum UploadState {
    Pending,
    Committed,
}

pub(super) fn start_cleanup(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            prune_expired_browse_references(&app);
            if let Ok(repositories) = crate::commands::repositories(&app).await {
                if let Err(error) = cleanup_expired_uploads(&app, &repositories).await {
                    tracing::warn!(code = %error.code, "companion upload cleanup failed");
                }
            }
            tokio::time::sleep(CLEANUP_INTERVAL).await;
        }
    });
}

pub(super) async fn list_root_records(
    repositories: &Repositories,
    account_user_id: &str,
) -> Result<Vec<BrowseRootRecord>, AppError> {
    let rows = query(
        "SELECT id, canonical_path, display_name, volume_device_id, directory_file_id
         FROM companion_browse_roots
         WHERE account_user_id = ?
         ORDER BY created_at ASC, id ASC",
    )
    .bind(account_user_id)
    .fetch_all(&repositories.pool)
    .await?;
    rows.into_iter()
        .map(|row| {
            Ok(BrowseRootRecord {
                id: parse_uuid(row.get::<String, _>("id").as_str())?,
                canonical_path: PathBuf::from(row.get::<String, _>("canonical_path")),
                display_name: row.get("display_name"),
                volume_device_id: row.get("volume_device_id"),
                directory_file_id: row.get("directory_file_id"),
            })
        })
        .collect()
}

pub(super) async fn grant_root(
    repositories: &Repositories,
    account_user_id: &str,
    selected_path: &Path,
) -> Result<BrowseRootRecord, AppError> {
    let root = validate_root(selected_path)?;
    if let Some(existing) = list_root_records(repositories, account_user_id)
        .await?
        .into_iter()
        .find(|candidate| candidate.canonical_path == root.canonical_path)
    {
        return Ok(existing);
    }
    let count: i64 = query(
        "SELECT COUNT(*) AS count
         FROM companion_browse_roots
         WHERE account_user_id = ?",
    )
    .bind(account_user_id)
    .fetch_one(&repositories.pool)
    .await?
    .get("count");
    if count >= MAX_BROWSE_ROOTS as i64 {
        return Err(AppError::new(
            "companion_root_limit_exceeded",
            "Remove a shared folder before adding another one.",
        ));
    }
    query(
        "INSERT INTO companion_browse_roots
         (account_user_id, id, canonical_path, display_name, volume_device_id,
          directory_file_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(account_user_id)
    .bind(root.id.to_string())
    .bind(root.canonical_path.to_string_lossy().into_owned())
    .bind(&root.display_name)
    .bind(&root.volume_device_id)
    .bind(&root.directory_file_id)
    .bind(Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true))
    .execute(&repositories.pool)
    .await?;
    Ok(root)
}

pub(super) async fn revoke_root(
    app: &AppHandle,
    repositories: &Repositories,
    account_user_id: &str,
    root_id: Uuid,
) -> Result<(), AppError> {
    query(
        "DELETE FROM companion_browse_roots
         WHERE account_user_id = ? AND id = ?",
    )
    .bind(account_user_id)
    .bind(root_id.to_string())
    .execute(&repositories.pool)
    .await?;
    if let Ok(mut references) = app
        .state::<super::CompanionRuntime>()
        .browse_references
        .lock()
    {
        references.retain(|_, reference| {
            reference.account_user_id != account_user_id || reference.root_id != root_id
        });
    }
    Ok(())
}

pub(super) async fn protocol_roots(
    repositories: &Repositories,
    account_user_id: &str,
) -> Result<Vec<BrowseRoot>, AppError> {
    Ok(list_root_records(repositories, account_user_id)
        .await?
        .into_iter()
        .map(|root| BrowseRoot {
            root_id: root.id,
            name: root.display_name,
        })
        .collect())
}

pub(super) async fn list_directory(
    repositories: &Repositories,
    account_user_id: &str,
    root_id: Uuid,
    relative_path: &str,
    page: &PageRequest,
) -> Result<Page<BrowseEntry>, AppError> {
    let root = root_record(repositories, account_user_id, root_id).await?;
    let directory = resolve_granted_path(&root, relative_path, ExpectedKind::Directory)?;
    let mut read = fs::read_dir(&directory).await.map_err(browse_io_error)?;
    let mut items = Vec::new();
    while let Some(entry) = read.next_entry().await.map_err(browse_io_error)? {
        let Some(name) = entry.file_name().to_str().map(str::to_string) else {
            continue;
        };
        if invalid_visible_name(&name) {
            continue;
        }
        let file_type = entry.file_type().await.map_err(browse_io_error)?;
        if file_type.is_symlink() || (!file_type.is_dir() && !file_type.is_file()) {
            continue;
        }
        let child_relative = if relative_path.is_empty() {
            name.clone()
        } else {
            format!("{relative_path}/{name}")
        };
        let resolved = match resolve_granted_path(
            &root,
            &child_relative,
            if file_type.is_dir() {
                ExpectedKind::Directory
            } else {
                ExpectedKind::File
            },
        ) {
            Ok(resolved) => resolved,
            Err(_) => continue,
        };
        let metadata = fs::metadata(&resolved).await.map_err(browse_io_error)?;
        if metadata.is_file() && metadata.len() > MAX_UPLOAD_BYTES {
            continue;
        }
        items.push(BrowseEntry {
            name,
            relative_path: child_relative,
            kind: if metadata.is_dir() {
                BrowseEntryKind::Directory
            } else {
                BrowseEntryKind::File
            },
            size_bytes: metadata.is_file().then_some(metadata.len()),
            modified_at: metadata.modified().ok().map(system_time_string),
        });
    }
    items.sort_by(|left, right| {
        browse_kind_rank(left.kind)
            .cmp(&browse_kind_rank(right.kind))
            .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
            .then_with(|| left.name.cmp(&right.name))
    });
    if let Some(cursor) = page.cursor.as_deref() {
        let Some(index) = items.iter().position(|entry| entry.relative_path == cursor) else {
            return Err(AppError::new(
                "companion_browse_cursor_invalid",
                "This folder changed. Refresh it and try again.",
            ));
        };
        items.drain(..=index);
    }
    let limit = usize::from(page.limit.min(MAX_PAGE_SIZE));
    let next_cursor =
        (items.len() > limit).then(|| items[limit.saturating_sub(1)].relative_path.clone());
    items.truncate(limit);
    Ok(Page { items, next_cursor })
}

pub(super) async fn stat_file(
    app: &AppHandle,
    repositories: &Repositories,
    account_user_id: &str,
    device_id: &str,
    root_id: Uuid,
    relative_path: &str,
) -> Result<BrowseFile, AppError> {
    let root = root_record(repositories, account_user_id, root_id).await?;
    let path = resolve_granted_path(&root, relative_path, ExpectedKind::File)?;
    let metadata = fs::metadata(&path).await.map_err(browse_io_error)?;
    if metadata.len() == 0 || metadata.len() > MAX_UPLOAD_BYTES {
        return Err(AppError::new(
            "companion_file_limit_exceeded",
            "This file is not within the companion attachment size limit.",
        ));
    }
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| {
            AppError::new(
                "companion_browse_invalid",
                "This file name cannot be shown in June Companion.",
            )
        })?
        .to_string();
    let reference_id = Uuid::new_v4();
    let expires_at_ms = now_ms().saturating_add(duration_ms(BROWSE_REFERENCE_LIFETIME));
    {
        let runtime = app.state::<super::CompanionRuntime>();
        let mut references = runtime.browse_references.lock().map_err(|_| {
            AppError::new(
                "companion_browse_unavailable",
                "Companion file references are unavailable.",
            )
        })?;
        let now = now_ms();
        references.retain(|_, reference| reference.expires_at_ms >= now);
        let device_count = references
            .values()
            .filter(|reference| {
                reference.account_user_id == account_user_id && reference.device_id == device_id
            })
            .count();
        if device_count >= MAX_BROWSE_REFERENCES_PER_DEVICE {
            return Err(AppError::new(
                "companion_reference_limit_exceeded",
                "Use or discard an earlier file selection before choosing another one.",
            ));
        }
        references.insert(
            reference_id,
            BrowseReference {
                account_user_id: account_user_id.to_string(),
                device_id: device_id.to_string(),
                root_id,
                relative_path: relative_path.to_string(),
                expires_at_ms,
            },
        );
    }
    let entry = BrowseEntry {
        name: name.clone(),
        relative_path: relative_path.to_string(),
        kind: BrowseEntryKind::File,
        size_bytes: Some(metadata.len()),
        modified_at: metadata.modified().ok().map(system_time_string),
    };
    Ok(BrowseFile {
        entry,
        attachment: AttachmentReference {
            reference_id,
            source: AttachmentSource::MacFile,
            name,
            media_type: attachment_media_type(&path).map(str::to_string),
            size_bytes: metadata.len(),
            expires_at_ms,
        },
    })
}

pub(super) async fn begin_upload(
    app: &AppHandle,
    repositories: &Repositories,
    account_user_id: &str,
    device_id: &str,
    request: &UploadBeginRequest,
) -> Result<UploadProgress, AppError> {
    cleanup_expired_uploads(app, repositories).await?;
    if let Some(existing) = upload_by_reservation(
        repositories,
        account_user_id,
        device_id,
        request.reservation_id,
    )
    .await?
    {
        if existing.name != request.name
            || existing.media_type != request.media_type
            || existing.size_bytes != request.size_bytes
            || existing.sha256 != request.sha256
        {
            return Err(AppError::new(
                "companion_upload_conflict",
                "This upload reservation already describes a different file.",
            ));
        }
        ensure_upload_file(app, account_user_id, device_id, &existing).await?;
        return Ok(upload_progress(existing));
    }

    let expires_at_ms = now_ms().saturating_add(duration_ms(UPLOAD_LIFETIME));
    let inserted = insert_upload_reservation(
        repositories,
        account_user_id,
        device_id,
        request,
        expires_at_ms,
        now_ms(),
    )
    .await?;
    if inserted == 0 {
        if let Some(existing) = upload_by_reservation(
            repositories,
            account_user_id,
            device_id,
            request.reservation_id,
        )
        .await?
        {
            if existing.name != request.name
                || existing.media_type != request.media_type
                || existing.size_bytes != request.size_bytes
                || existing.sha256 != request.sha256
            {
                return Err(AppError::new(
                    "companion_upload_conflict",
                    "This upload reservation already describes a different file.",
                ));
            }
            ensure_upload_file(app, account_user_id, device_id, &existing).await?;
            return Ok(upload_progress(existing));
        }
        let active_device = repositories
            .companion_device(account_user_id, device_id)
            .await?
            .is_some_and(|device| device.revoked_at.is_none());
        if !active_device {
            return Err(AppError::new(
                "unauthorized",
                "This linked device is no longer authorized.",
            ));
        }
        return Err(AppError::new(
            "companion_upload_limit_exceeded",
            "Finish or discard an earlier phone attachment before adding another one.",
        ));
    }
    let record = upload_by_reservation(
        repositories,
        account_user_id,
        device_id,
        request.reservation_id,
    )
    .await?
    .ok_or_else(|| {
        AppError::new(
            "unauthorized",
            "This linked device is no longer authorized.",
        )
    })?;
    ensure_upload_file(app, account_user_id, device_id, &record).await?;
    Ok(upload_progress(record))
}

async fn insert_upload_reservation(
    repositories: &Repositories,
    account_user_id: &str,
    device_id: &str,
    request: &UploadBeginRequest,
    expires_at_ms: u64,
    current_time_ms: u64,
) -> Result<u64, AppError> {
    Ok(query(
        "INSERT OR IGNORE INTO companion_uploads
         (account_user_id, device_id, reservation_id, name, media_type, size_bytes,
          sha256, accepted_bytes, state, expires_at_ms, created_at)
         SELECT ?, ?, ?, ?, ?, ?, ?, 0, 'pending', ?, ?
         WHERE EXISTS (
           SELECT 1 FROM companion_devices
           WHERE account_user_id = ? AND id = ? AND revoked_at IS NULL
         )
         AND (
           SELECT COUNT(*) FROM companion_uploads
           WHERE account_user_id = ? AND device_id = ? AND expires_at_ms >= ?
         ) < ?
         AND (
           SELECT COALESCE(SUM(size_bytes), 0) FROM companion_uploads
           WHERE account_user_id = ? AND device_id = ? AND expires_at_ms >= ?
         ) + ? <= ?",
    )
    .bind(account_user_id)
    .bind(device_id)
    .bind(request.reservation_id.to_string())
    .bind(&request.name)
    .bind(&request.media_type)
    .bind(request.size_bytes as i64)
    .bind(&request.sha256)
    .bind(expires_at_ms as i64)
    .bind(Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true))
    .bind(account_user_id)
    .bind(device_id)
    .bind(account_user_id)
    .bind(device_id)
    .bind(i64::try_from(current_time_ms).unwrap_or(i64::MAX))
    .bind(MAX_ACTIVE_UPLOADS_PER_DEVICE)
    .bind(account_user_id)
    .bind(device_id)
    .bind(i64::try_from(current_time_ms).unwrap_or(i64::MAX))
    .bind(request.size_bytes as i64)
    .bind(MAX_STAGED_UPLOAD_BYTES_PER_DEVICE)
    .execute(&repositories.pool)
    .await?
    .rows_affected())
}

pub(super) async fn append_upload_chunk(
    app: &AppHandle,
    repositories: &Repositories,
    account_user_id: &str,
    device_id: &str,
    request: &UploadChunkRequest,
) -> Result<UploadProgress, AppError> {
    let mut record = active_upload(
        repositories,
        account_user_id,
        device_id,
        request.reservation_id,
    )
    .await?;
    if record.state != UploadState::Pending {
        return Err(AppError::new(
            "companion_upload_conflict",
            "This phone attachment was already committed.",
        ));
    }
    let chunk_end = request
        .offset_bytes
        .saturating_add(request.bytes.len() as u64);
    if chunk_end > record.size_bytes
        || !matches!(
            record.accepted_bytes,
            accepted if accepted == request.offset_bytes || accepted == chunk_end
        )
    {
        return Err(AppError::new(
            "companion_upload_offset_invalid",
            "This phone attachment chunk is out of order.",
        ));
    }
    let staging = upload_staging_path(app, account_user_id, device_id, request.reservation_id)?;
    append_chunk_file(&staging, request.offset_bytes, &request.bytes).await?;
    if record.accepted_bytes == request.offset_bytes {
        let updated = query(
            "UPDATE companion_uploads
             SET accepted_bytes = ?
             WHERE account_user_id = ? AND device_id = ? AND reservation_id = ?
               AND state = 'pending' AND accepted_bytes = ?",
        )
        .bind(chunk_end as i64)
        .bind(account_user_id)
        .bind(device_id)
        .bind(request.reservation_id.to_string())
        .bind(request.offset_bytes as i64)
        .execute(&repositories.pool)
        .await?;
        if updated.rows_affected() != 1 {
            return Err(AppError::new(
                "companion_upload_outcome_unknown",
                "June could not confirm this phone attachment chunk.",
            ));
        }
        record.accepted_bytes = chunk_end;
    }
    Ok(upload_progress(record))
}

pub(super) async fn commit_upload(
    app: &AppHandle,
    repositories: &Repositories,
    account_user_id: &str,
    device_id: &str,
    reservation_id: Uuid,
) -> Result<UploadProgress, AppError> {
    let mut record =
        active_upload(repositories, account_user_id, device_id, reservation_id).await?;
    if record.state == UploadState::Committed {
        return Ok(upload_progress(record));
    }
    if record.accepted_bytes != record.size_bytes {
        return Err(AppError::new(
            "companion_upload_incomplete",
            "Finish sending every phone attachment chunk before committing it.",
        ));
    }
    let staging = upload_staging_path(app, account_user_id, device_id, reservation_id)?;
    let final_path = upload_final_path(app, account_user_id, device_id, reservation_id)?;
    let source = if final_path.is_file() {
        &final_path
    } else {
        &staging
    };
    let metadata = fs::metadata(source).await.map_err(upload_io_error)?;
    if metadata.len() != record.size_bytes || sha256_file(source).await? != record.sha256 {
        return Err(AppError::new(
            "companion_upload_integrity_mismatch",
            "The phone attachment did not match its declared size and content hash.",
        ));
    }
    if source == &staging {
        fs::rename(&staging, &final_path)
            .await
            .map_err(upload_io_error)?;
    }
    let reference_id = record.attachment_reference_id.unwrap_or_else(Uuid::new_v4);
    let updated = query(
        "UPDATE companion_uploads
         SET state = 'committed', attachment_reference_id = ?
         WHERE account_user_id = ? AND device_id = ? AND reservation_id = ?
           AND state = 'pending'",
    )
    .bind(reference_id.to_string())
    .bind(account_user_id)
    .bind(device_id)
    .bind(reservation_id.to_string())
    .execute(&repositories.pool)
    .await?;
    if updated.rows_affected() != 1 {
        let reconciled =
            active_upload(repositories, account_user_id, device_id, reservation_id).await?;
        if reconciled.state == UploadState::Committed {
            return Ok(upload_progress(reconciled));
        }
        return Err(AppError::new(
            "companion_upload_outcome_unknown",
            "June could not confirm this phone attachment commit.",
        ));
    }
    record.state = UploadState::Committed;
    record.attachment_reference_id = Some(reference_id);
    Ok(upload_progress(record))
}

pub(super) async fn resolve_attachment_paths(
    app: &AppHandle,
    repositories: &Repositories,
    account_user_id: &str,
    device_id: &str,
    reference_ids: &[Uuid],
) -> Result<Vec<String>, AppError> {
    let mut paths = Vec::with_capacity(reference_ids.len());
    for reference_id in reference_ids {
        if let Some(record) =
            upload_by_reference(repositories, account_user_id, device_id, *reference_id).await?
        {
            if record.expires_at_ms < now_ms() || record.state != UploadState::Committed {
                return Err(AppError::new(
                    "companion_attachment_expired",
                    "This phone attachment expired. Add it again.",
                ));
            }
            let path = upload_final_path(app, account_user_id, device_id, record.reservation_id)?;
            let metadata = fs::metadata(&path).await.map_err(upload_io_error)?;
            if !metadata.is_file()
                || metadata.len() != record.size_bytes
                || sha256_file(&path).await? != record.sha256
            {
                return Err(AppError::new(
                    "companion_upload_integrity_mismatch",
                    "This phone attachment is no longer available.",
                ));
            }
            paths.push(path.to_string_lossy().into_owned());
            continue;
        }

        let browse = {
            let runtime = app.state::<super::CompanionRuntime>();
            let mut references = runtime.browse_references.lock().map_err(|_| {
                AppError::new(
                    "companion_browse_unavailable",
                    "Companion file references are unavailable.",
                )
            })?;
            let now = now_ms();
            references.retain(|_, reference| reference.expires_at_ms >= now);
            references.get(reference_id).cloned()
        }
        .ok_or_else(|| {
            AppError::new(
                "companion_attachment_not_found",
                "This file selection is no longer available.",
            )
        })?;
        if browse.account_user_id != account_user_id || browse.device_id != device_id {
            return Err(AppError::new(
                "unauthorized",
                "This file selection belongs to another linked device.",
            ));
        }
        let root = root_record(repositories, account_user_id, browse.root_id).await?;
        let path = resolve_granted_path(&root, &browse.relative_path, ExpectedKind::File)?;
        let metadata = fs::metadata(&path).await.map_err(browse_io_error)?;
        if metadata.len() == 0 || metadata.len() > MAX_UPLOAD_BYTES {
            return Err(AppError::new(
                "companion_file_limit_exceeded",
                "This file is not within the companion attachment size limit.",
            ));
        }
        paths.push(path.to_string_lossy().into_owned());
    }
    Ok(paths)
}

pub(super) async fn consume_attachments(
    app: &AppHandle,
    repositories: &Repositories,
    account_user_id: &str,
    reference_ids: &[Uuid],
) -> Result<(), AppError> {
    if let Ok(mut references) = app
        .state::<super::CompanionRuntime>()
        .browse_references
        .lock()
    {
        for reference_id in reference_ids {
            if references
                .get(reference_id)
                .is_some_and(|reference| reference.account_user_id == account_user_id)
            {
                references.remove(reference_id);
            }
        }
    }
    for reference_id in reference_ids {
        let row = query(
            "SELECT device_id, reservation_id
             FROM companion_uploads
             WHERE account_user_id = ? AND attachment_reference_id = ?",
        )
        .bind(account_user_id)
        .bind(reference_id.to_string())
        .fetch_optional(&repositories.pool)
        .await?;
        let Some(row) = row else {
            continue;
        };
        let device_id: String = row.get("device_id");
        let reservation_id: String = row.get("reservation_id");
        let invalidated = query(
            "UPDATE companion_uploads
             SET attachment_reference_id = NULL
             WHERE account_user_id = ? AND attachment_reference_id = ?",
        )
        .bind(account_user_id)
        .bind(reference_id.to_string())
        .execute(&repositories.pool)
        .await?;
        if invalidated.rows_affected() == 1
            && remove_upload_directory(app, account_user_id, &device_id, &reservation_id).await
        {
            delete_upload_record(repositories, account_user_id, &device_id, &reservation_id).await;
        }
    }
    Ok(())
}

pub(super) async fn cleanup_device_uploads(
    app: &AppHandle,
    repositories: &Repositories,
    account_user_id: &str,
    device_id: &str,
) {
    let rows = query(
        "SELECT reservation_id
         FROM companion_uploads
         WHERE account_user_id = ? AND device_id = ?",
    )
    .bind(account_user_id)
    .bind(device_id)
    .fetch_all(&repositories.pool)
    .await
    .unwrap_or_default();
    for row in rows {
        let reservation_id = row.get::<String, _>("reservation_id");
        if remove_upload_directory(app, account_user_id, device_id, &reservation_id).await {
            delete_upload_record(repositories, account_user_id, device_id, &reservation_id).await;
        }
    }
    if let Ok(mut references) = app
        .state::<super::CompanionRuntime>()
        .browse_references
        .lock()
    {
        references.retain(|_, reference| {
            reference.account_user_id != account_user_id || reference.device_id != device_id
        });
    }
}

fn prune_expired_browse_references(app: &AppHandle) {
    if let Ok(mut references) = app
        .state::<super::CompanionRuntime>()
        .browse_references
        .lock()
    {
        let now = now_ms();
        references.retain(|_, reference| reference.expires_at_ms >= now);
    }
}

async fn cleanup_expired_uploads(
    app: &AppHandle,
    repositories: &Repositories,
) -> Result<(), AppError> {
    let rows = query(
        "SELECT account_user_id, device_id, reservation_id
         FROM companion_uploads
         WHERE expires_at_ms < ?",
    )
    .bind(now_ms_i64())
    .fetch_all(&repositories.pool)
    .await?;
    for row in rows {
        let account_user_id = row.get::<String, _>("account_user_id");
        let device_id = row.get::<String, _>("device_id");
        let reservation_id = row.get::<String, _>("reservation_id");
        if remove_upload_directory(app, &account_user_id, &device_id, &reservation_id).await {
            delete_upload_record(repositories, &account_user_id, &device_id, &reservation_id).await;
        }
    }
    Ok(())
}

async fn delete_upload_record(
    repositories: &Repositories,
    account_user_id: &str,
    device_id: &str,
    reservation_id: &str,
) {
    let _ = query(
        "DELETE FROM companion_uploads
         WHERE account_user_id = ? AND device_id = ? AND reservation_id = ?",
    )
    .bind(account_user_id)
    .bind(device_id)
    .bind(reservation_id)
    .execute(&repositories.pool)
    .await;
}

fn validate_root(selected_path: &Path) -> Result<BrowseRootRecord, AppError> {
    let selected_metadata = std::fs::symlink_metadata(selected_path).map_err(browse_io_error)?;
    if selected_metadata.file_type().is_symlink() || !selected_metadata.is_dir() {
        return Err(AppError::new(
            "companion_root_invalid",
            "Choose a regular folder, not a link or special location.",
        ));
    }
    let canonical_path = selected_path.canonicalize().map_err(browse_io_error)?;
    if canonical_path.parent().is_none() {
        return Err(AppError::new(
            "companion_root_invalid",
            "Choose a folder inside this disk, not the entire disk.",
        ));
    }
    let display_name = canonical_path
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|value| !invalid_visible_name(value) && value.len() <= MAX_ROOT_DISPLAY_NAME_BYTES)
        .ok_or_else(|| {
            AppError::new(
                "companion_root_invalid",
                "Choose a visible folder with a standard name.",
            )
        })?
        .to_string();
    let identity =
        root_filesystem_identity(&std::fs::metadata(&canonical_path).map_err(browse_io_error)?)?;
    Ok(BrowseRootRecord {
        id: Uuid::new_v4(),
        canonical_path,
        display_name,
        volume_device_id: identity.volume_device_id,
        directory_file_id: identity.directory_file_id,
    })
}

async fn root_record(
    repositories: &Repositories,
    account_user_id: &str,
    root_id: Uuid,
) -> Result<BrowseRootRecord, AppError> {
    list_root_records(repositories, account_user_id)
        .await?
        .into_iter()
        .find(|root| root.id == root_id)
        .ok_or_else(|| {
            AppError::new(
                "companion_root_not_found",
                "This shared folder is no longer available.",
            )
        })
}

#[derive(Debug, Clone, Copy)]
enum ExpectedKind {
    Directory,
    File,
}

fn resolve_granted_path(
    root: &BrowseRootRecord,
    relative_path: &str,
    expected_kind: ExpectedKind,
) -> Result<PathBuf, AppError> {
    let root_metadata = std::fs::symlink_metadata(&root.canonical_path).map_err(browse_io_error)?;
    if root_metadata.file_type().is_symlink() || !root_metadata.is_dir() {
        return Err(root_changed());
    }
    let current_identity = root_filesystem_identity(&root_metadata)?;
    if current_identity.volume_device_id != root.volume_device_id
        || current_identity.directory_file_id != root.directory_file_id
    {
        return Err(root_changed());
    }
    let current_root = root
        .canonical_path
        .canonicalize()
        .map_err(browse_io_error)?;
    if current_root != root.canonical_path {
        return Err(root_changed());
    }
    let mut candidate = root.canonical_path.clone();
    if !relative_path.is_empty() {
        let relative = Path::new(relative_path);
        for component in relative.components() {
            let Component::Normal(component) = component else {
                return Err(path_invalid());
            };
            let name = component.to_str().ok_or_else(path_invalid)?;
            if invalid_visible_name(name) {
                return Err(path_invalid());
            }
            candidate.push(component);
            let metadata = std::fs::symlink_metadata(&candidate).map_err(browse_io_error)?;
            if metadata.file_type().is_symlink() {
                return Err(path_invalid());
            }
        }
    }
    let canonical = candidate.canonicalize().map_err(browse_io_error)?;
    if !canonical.starts_with(&root.canonical_path) {
        return Err(path_invalid());
    }
    let metadata = std::fs::metadata(&canonical).map_err(browse_io_error)?;
    let kind_matches = match expected_kind {
        ExpectedKind::Directory => metadata.is_dir(),
        ExpectedKind::File => metadata.is_file(),
    };
    if !kind_matches {
        return Err(path_invalid());
    }
    Ok(canonical)
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct RootFilesystemIdentity {
    volume_device_id: String,
    directory_file_id: String,
}

#[cfg(unix)]
fn root_filesystem_identity(
    metadata: &std::fs::Metadata,
) -> Result<RootFilesystemIdentity, AppError> {
    use std::os::unix::fs::MetadataExt;

    Ok(RootFilesystemIdentity {
        volume_device_id: metadata.dev().to_string(),
        directory_file_id: metadata.ino().to_string(),
    })
}

#[cfg(not(unix))]
fn root_filesystem_identity(
    _metadata: &std::fs::Metadata,
) -> Result<RootFilesystemIdentity, AppError> {
    Err(AppError::new(
        "companion_root_identity_unavailable",
        "June cannot verify this folder's volume identity on this platform.",
    ))
}

fn invalid_visible_name(value: &str) -> bool {
    value.is_empty()
        || value == "."
        || value == ".."
        || value.starts_with('.')
        || value.len() > 255
        || value
            .chars()
            .any(|character| character.is_control() || matches!(character, '/' | '\\' | ':'))
}

fn browse_kind_rank(kind: BrowseEntryKind) -> u8 {
    match kind {
        BrowseEntryKind::Directory => 0,
        BrowseEntryKind::File => 1,
    }
}

async fn upload_by_reservation(
    repositories: &Repositories,
    account_user_id: &str,
    device_id: &str,
    reservation_id: Uuid,
) -> Result<Option<UploadRecord>, AppError> {
    let row = query(
        "SELECT reservation_id, name, media_type, size_bytes, sha256, accepted_bytes,
                state, attachment_reference_id, expires_at_ms
         FROM companion_uploads
         WHERE account_user_id = ? AND device_id = ? AND reservation_id = ?",
    )
    .bind(account_user_id)
    .bind(device_id)
    .bind(reservation_id.to_string())
    .fetch_optional(&repositories.pool)
    .await?;
    row.map(upload_record_from_row).transpose()
}

async fn upload_by_reference(
    repositories: &Repositories,
    account_user_id: &str,
    device_id: &str,
    reference_id: Uuid,
) -> Result<Option<UploadRecord>, AppError> {
    let row = query(
        "SELECT reservation_id, name, media_type, size_bytes, sha256, accepted_bytes,
                state, attachment_reference_id, expires_at_ms
         FROM companion_uploads
         WHERE account_user_id = ? AND device_id = ? AND attachment_reference_id = ?",
    )
    .bind(account_user_id)
    .bind(device_id)
    .bind(reference_id.to_string())
    .fetch_optional(&repositories.pool)
    .await?;
    row.map(upload_record_from_row).transpose()
}

async fn active_upload(
    repositories: &Repositories,
    account_user_id: &str,
    device_id: &str,
    reservation_id: Uuid,
) -> Result<UploadRecord, AppError> {
    let record = upload_by_reservation(repositories, account_user_id, device_id, reservation_id)
        .await?
        .ok_or_else(|| {
            AppError::new(
                "companion_upload_not_found",
                "This phone attachment reservation is no longer available.",
            )
        })?;
    if record.expires_at_ms < now_ms() {
        return Err(AppError::new(
            "companion_upload_expired",
            "This phone attachment expired. Add it again.",
        ));
    }
    Ok(record)
}

fn upload_record_from_row(row: sqlx_sqlite::SqliteRow) -> Result<UploadRecord, AppError> {
    let state = match row.get::<String, _>("state").as_str() {
        "pending" => UploadState::Pending,
        "committed" => UploadState::Committed,
        _ => {
            return Err(AppError::new(
                "companion_upload_invalid",
                "A saved phone attachment has an invalid state.",
            ));
        }
    };
    let size_bytes =
        u64::try_from(row.get::<i64, _>("size_bytes")).map_err(|_| upload_record_invalid())?;
    let accepted_bytes =
        u64::try_from(row.get::<i64, _>("accepted_bytes")).map_err(|_| upload_record_invalid())?;
    let expires_at_ms =
        u64::try_from(row.get::<i64, _>("expires_at_ms")).map_err(|_| upload_record_invalid())?;
    let reference = row.get::<Option<String>, _>("attachment_reference_id");
    Ok(UploadRecord {
        reservation_id: parse_uuid(&row.get::<String, _>("reservation_id"))?,
        name: row.get("name"),
        media_type: row.get("media_type"),
        size_bytes,
        sha256: row.get("sha256"),
        accepted_bytes,
        state,
        attachment_reference_id: reference.as_deref().map(parse_uuid).transpose()?,
        expires_at_ms,
    })
}

fn upload_progress(record: UploadRecord) -> UploadProgress {
    let attachment = record
        .attachment_reference_id
        .map(|reference_id| AttachmentReference {
            reference_id,
            source: AttachmentSource::PhoneUpload,
            name: record.name.clone(),
            media_type: record.media_type.clone(),
            size_bytes: record.size_bytes,
            expires_at_ms: record.expires_at_ms,
        });
    UploadProgress {
        reservation_id: record.reservation_id,
        accepted_bytes: record.accepted_bytes,
        size_bytes: record.size_bytes,
        expires_at_ms: record.expires_at_ms,
        attachment,
    }
}

async fn ensure_upload_file(
    app: &AppHandle,
    account_user_id: &str,
    device_id: &str,
    record: &UploadRecord,
) -> Result<(), AppError> {
    let directory = upload_directory(app, account_user_id, device_id, record.reservation_id)?;
    fs::create_dir_all(&directory)
        .await
        .map_err(upload_io_error)?;
    set_owner_only_directory(&directory).await?;
    let path = if record.state == UploadState::Committed {
        directory.join("content")
    } else {
        directory.join("staging")
    };
    let file = owner_only_open_options()
        .create(true)
        .read(true)
        .write(true)
        .open(&path)
        .await
        .map_err(upload_io_error)?;
    let length = file.metadata().await.map_err(upload_io_error)?.len();
    if length != record.accepted_bytes {
        return Err(AppError::new(
            "companion_upload_outcome_unknown",
            "June could not reconcile this phone attachment after a restart.",
        ));
    }
    Ok(())
}

async fn append_chunk_file(path: &Path, offset: u64, bytes: &[u8]) -> Result<(), AppError> {
    let mut file = owner_only_open_options()
        .read(true)
        .write(true)
        .open(path)
        .await
        .map_err(upload_io_error)?;
    let length = file.metadata().await.map_err(upload_io_error)?.len();
    let chunk_end = offset.saturating_add(bytes.len() as u64);
    if length == chunk_end {
        let mut existing = vec![0_u8; bytes.len()];
        file.seek(std::io::SeekFrom::Start(offset))
            .await
            .map_err(upload_io_error)?;
        file.read_exact(&mut existing)
            .await
            .map_err(upload_io_error)?;
        if existing != bytes {
            return Err(AppError::new(
                "companion_upload_conflict",
                "This phone attachment offset already contains different bytes.",
            ));
        }
        return Ok(());
    }
    if length != offset {
        return Err(AppError::new(
            "companion_upload_outcome_unknown",
            "June could not reconcile this phone attachment chunk.",
        ));
    }
    file.seek(std::io::SeekFrom::Start(offset))
        .await
        .map_err(upload_io_error)?;
    file.write_all(bytes).await.map_err(upload_io_error)?;
    file.flush().await.map_err(upload_io_error)?;
    file.sync_data().await.map_err(upload_io_error)
}

async fn sha256_file(path: &Path) -> Result<String, AppError> {
    let mut file = fs::File::open(path).await.map_err(upload_io_error)?;
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 32 * 1024];
    loop {
        let read = file.read(&mut buffer).await.map_err(upload_io_error)?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
    }
    Ok(format!("{:x}", digest.finalize()))
}

fn upload_directory(
    app: &AppHandle,
    account_user_id: &str,
    device_id: &str,
    reservation_id: Uuid,
) -> Result<PathBuf, AppError> {
    let device_id = parse_uuid(device_id)?;
    let account_digest = format!("{:x}", Sha256::digest(account_user_id.as_bytes()));
    Ok(app_paths::app_data_dir(app)
        .map_err(|error| AppError::new("storage_unavailable", error.to_string()))?
        .join("companion")
        .join("attachments")
        .join(&account_digest[..32])
        .join(device_id.to_string())
        .join(reservation_id.to_string()))
}

fn upload_staging_path(
    app: &AppHandle,
    account_user_id: &str,
    device_id: &str,
    reservation_id: Uuid,
) -> Result<PathBuf, AppError> {
    Ok(upload_directory(app, account_user_id, device_id, reservation_id)?.join("staging"))
}

fn upload_final_path(
    app: &AppHandle,
    account_user_id: &str,
    device_id: &str,
    reservation_id: Uuid,
) -> Result<PathBuf, AppError> {
    Ok(upload_directory(app, account_user_id, device_id, reservation_id)?.join("content"))
}

async fn remove_upload_directory(
    app: &AppHandle,
    account_user_id: &str,
    device_id: &str,
    reservation_id: &str,
) -> bool {
    let Ok(reservation_id) = parse_uuid(reservation_id) else {
        return false;
    };
    let Ok(directory) = upload_directory(app, account_user_id, device_id, reservation_id) else {
        return false;
    };
    match fs::remove_dir_all(directory).await {
        Ok(()) => true,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => true,
        Err(_) => false,
    }
}

#[cfg(unix)]
fn owner_only_open_options() -> OpenOptions {
    let mut options = OpenOptions::new();
    options.mode(0o600);
    options
}

#[cfg(not(unix))]
fn owner_only_open_options() -> OpenOptions {
    OpenOptions::new()
}

#[cfg(unix)]
async fn set_owner_only_directory(path: &Path) -> Result<(), AppError> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))
        .await
        .map_err(upload_io_error)
}

#[cfg(not(unix))]
async fn set_owner_only_directory(_path: &Path) -> Result<(), AppError> {
    Ok(())
}

fn attachment_media_type(path: &Path) -> Option<&'static str> {
    match path.extension()?.to_str()?.to_ascii_lowercase().as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        "tif" | "tiff" => Some("image/tiff"),
        "pdf" => Some("application/pdf"),
        "json" => Some("application/json"),
        "csv" => Some("text/csv"),
        "md" => Some("text/markdown"),
        "txt" => Some("text/plain"),
        _ => None,
    }
}

fn system_time_string(value: SystemTime) -> String {
    DateTime::<Utc>::from(value).to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

fn now_ms_i64() -> i64 {
    i64::try_from(now_ms()).unwrap_or(i64::MAX)
}

fn duration_ms(value: Duration) -> u64 {
    value.as_millis().try_into().unwrap_or(u64::MAX)
}

fn parse_uuid(value: &str) -> Result<Uuid, AppError> {
    Uuid::parse_str(value).map_err(|_| {
        AppError::new(
            "companion_identifier_invalid",
            "A companion identifier is invalid.",
        )
    })
}

fn upload_record_invalid() -> AppError {
    AppError::new(
        "companion_upload_invalid",
        "A saved phone attachment is invalid.",
    )
}

fn path_invalid() -> AppError {
    AppError::new(
        "companion_browse_invalid",
        "This path is outside the shared folder or is not a supported file.",
    )
}

fn root_changed() -> AppError {
    AppError::new(
        "companion_root_not_found",
        "This shared folder changed on the Mac. Remove it and add it again.",
    )
}

fn browse_io_error(error: std::io::Error) -> AppError {
    if error.kind() == std::io::ErrorKind::NotFound {
        AppError::new(
            "companion_file_not_found",
            "This file or folder is no longer available.",
        )
    } else {
        AppError::new(
            "companion_browse_unavailable",
            "June could not read this shared folder.",
        )
    }
}

fn upload_io_error(_error: std::io::Error) -> AppError {
    AppError::new(
        "companion_upload_unavailable",
        "June could not store this phone attachment.",
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx_sqlite::SqlitePoolOptions;

    async fn test_repositories() -> Repositories {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        crate::db::migrations::run_migrations(&pool).await.unwrap();
        Repositories::new(pool)
    }

    fn test_browse_root(path: &Path) -> BrowseRootRecord {
        let canonical_path = path.canonicalize().unwrap();
        let identity = root_filesystem_identity(&std::fs::metadata(&canonical_path).unwrap())
            .expect("filesystem identity");
        BrowseRootRecord {
            id: Uuid::new_v4(),
            canonical_path,
            display_name: "Shared".to_string(),
            volume_device_id: identity.volume_device_id,
            directory_file_id: identity.directory_file_id,
        }
    }

    #[test]
    fn granted_path_rejects_symlinks_hidden_entries_and_parent_traversal() {
        let directory = tempfile::tempdir().unwrap();
        let root_path = directory.path().join("Shared");
        std::fs::create_dir_all(root_path.join("folder")).unwrap();
        std::fs::write(root_path.join("folder").join("brief.md"), "hello").unwrap();
        std::fs::write(root_path.join(".env"), "secret").unwrap();
        let root = test_browse_root(&root_path);

        assert!(resolve_granted_path(&root, "folder", ExpectedKind::Directory).is_ok());
        assert!(resolve_granted_path(&root, "folder/brief.md", ExpectedKind::File).is_ok());
        assert!(resolve_granted_path(&root, "../outside", ExpectedKind::File).is_err());
        assert!(resolve_granted_path(&root, ".env", ExpectedKind::File).is_err());

        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(
                directory.path(),
                root_path.join("folder").join("outside-link"),
            )
            .unwrap();
            assert!(
                resolve_granted_path(&root, "folder/outside-link", ExpectedKind::Directory)
                    .is_err()
            );
        }
    }

    #[test]
    fn granted_path_rejects_a_changed_volume_or_directory_identity() {
        let directory = tempfile::tempdir().unwrap();
        let root_path = directory.path().join("Shared");
        std::fs::create_dir(&root_path).unwrap();
        let mut root = test_browse_root(&root_path);

        root.volume_device_id.push_str("-different");
        let error = resolve_granted_path(&root, "", ExpectedKind::Directory).unwrap_err();
        assert_eq!(error.code, "companion_root_not_found");

        root = test_browse_root(&root_path);
        root.directory_file_id.push_str("-different");
        let error = resolve_granted_path(&root, "", ExpectedKind::Directory).unwrap_err();
        assert_eq!(error.code, "companion_root_not_found");
    }

    #[tokio::test]
    async fn granted_root_persists_its_volume_and_directory_identity() {
        let repositories = test_repositories().await;
        let directory = tempfile::tempdir().unwrap();
        let root_path = directory.path().join("Shared");
        std::fs::create_dir(&root_path).unwrap();

        let granted = grant_root(&repositories, "usr_browse_identity", &root_path)
            .await
            .unwrap();
        let loaded = list_root_records(&repositories, "usr_browse_identity")
            .await
            .unwrap();

        assert_eq!(loaded, vec![granted]);
        assert!(!loaded[0].volume_device_id.is_empty());
        assert!(!loaded[0].directory_file_id.is_empty());
    }

    #[test]
    fn browse_root_labels_respect_the_authenticated_contract_bound() {
        let directory = tempfile::tempdir().unwrap();
        let root_path = directory
            .path()
            .join("x".repeat(MAX_ROOT_DISPLAY_NAME_BYTES + 1));
        std::fs::create_dir(&root_path).unwrap();

        let error = validate_root(&root_path).unwrap_err();

        assert_eq!(error.code, "companion_root_invalid");
    }

    #[tokio::test]
    async fn upload_reservations_enforce_deduplication_count_and_byte_quotas() {
        let repositories = test_repositories().await;
        let account_user_id = "usr_companion_upload";
        let device_id = Uuid::new_v4().to_string();
        repositories
            .upsert_companion_device(account_user_id, &device_id, "Phone", &[7; 32])
            .await
            .unwrap();

        for index in 0..2 {
            let request = UploadBeginRequest {
                reservation_id: Uuid::new_v4(),
                name: format!("large-{index}.bin"),
                media_type: Some("application/octet-stream".to_string()),
                size_bytes: MAX_UPLOAD_BYTES,
                sha256: "a".repeat(64),
            };
            assert_eq!(
                insert_upload_reservation(
                    &repositories,
                    account_user_id,
                    &device_id,
                    &request,
                    10_000,
                    1,
                )
                .await
                .unwrap(),
                1
            );
            assert_eq!(
                insert_upload_reservation(
                    &repositories,
                    account_user_id,
                    &device_id,
                    &request,
                    10_000,
                    1,
                )
                .await
                .unwrap(),
                0
            );
        }
        let next_request = UploadBeginRequest {
            reservation_id: Uuid::new_v4(),
            name: "next.bin".to_string(),
            media_type: None,
            size_bytes: 1,
            sha256: "b".repeat(64),
        };
        assert_eq!(
            insert_upload_reservation(
                &repositories,
                account_user_id,
                &device_id,
                &next_request,
                10_000,
                1,
            )
            .await
            .unwrap(),
            0
        );

        query("DELETE FROM companion_uploads")
            .execute(&repositories.pool)
            .await
            .unwrap();
        for index in 0..MAX_ACTIVE_UPLOADS_PER_DEVICE {
            let request = UploadBeginRequest {
                reservation_id: Uuid::new_v4(),
                name: format!("small-{index}.txt"),
                media_type: Some("text/plain".to_string()),
                size_bytes: 1,
                sha256: "c".repeat(64),
            };
            assert_eq!(
                insert_upload_reservation(
                    &repositories,
                    account_user_id,
                    &device_id,
                    &request,
                    10_000,
                    1,
                )
                .await
                .unwrap(),
                1
            );
        }
        assert_eq!(
            insert_upload_reservation(
                &repositories,
                account_user_id,
                &device_id,
                &next_request,
                10_000,
                1,
            )
            .await
            .unwrap(),
            0
        );
    }

    #[tokio::test]
    async fn chunk_recovery_accepts_identical_bytes_and_rejects_conflicts() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("staging");
        owner_only_open_options()
            .create(true)
            .read(true)
            .write(true)
            .open(&path)
            .await
            .unwrap();

        append_chunk_file(&path, 0, b"first").await.unwrap();
        append_chunk_file(&path, 0, b"first").await.unwrap();
        assert!(append_chunk_file(&path, 0, b"other").await.is_err());
        append_chunk_file(&path, 5, b"-second").await.unwrap();
        assert_eq!(fs::read(&path).await.unwrap(), b"first-second");
        assert_eq!(
            sha256_file(&path).await.unwrap(),
            "79be082f29fd48f6922ef9e7c161190ba1e076790e82e9fa490b58205b5e9a44"
        );
    }
}
