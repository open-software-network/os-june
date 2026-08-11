use crate::{
    agent_runtime::{AgentArtifactDto, AgentRepository},
    db::repositories::Repositories,
    domain::types::AppError,
};
use clovy_companion_protocol::{
    validate_media_type, MediaChunk, MediaKind, MediaResultReference, MAX_MEDIA_BYTES,
    MAX_MEDIA_CHUNK_BYTES, MAX_MEDIA_DIMENSION_PX, MAX_MEDIA_DURATION_MS, MAX_MEDIA_REFERENCES,
};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs::{File, OpenOptions},
    io::{BufReader, Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager};

const MAX_SESSION_MEDIA_REFERENCES: usize = 800;
const MAX_CACHED_TRANSFERS: usize = 16;
const TRANSFER_IDLE_TTL: Duration = Duration::from_secs(30 * 60);
const TRANSFER_CLEANUP_INTERVAL: Duration = Duration::from_secs(60);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompanionMediaProjection {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
    pub created_at: String,
    pub reference: MediaResultReference,
}

#[derive(Debug, Clone)]
pub struct ResolvedMediaArtifact {
    id: String,
    session_id: String,
    run_id: Option<String>,
    created_at: String,
    path: PathBuf,
    workspace_path: PathBuf,
    media_type: String,
    kind: MediaKind,
    expected_size_bytes: u64,
}

#[derive(Clone)]
struct CachedTransfer {
    file: Arc<File>,
    artifact_id: String,
    path: PathBuf,
    size_bytes: u64,
    sha256: String,
    touched_at: Instant,
}

#[derive(Default)]
pub struct MediaTransferCache {
    entries: HashMap<String, CachedTransfer>,
}

pub(super) fn start_cleanup(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(TRANSFER_CLEANUP_INTERVAL).await;
            let runtime = app.state::<super::CompanionRuntime>();
            match runtime.media_transfers.lock() {
                Ok(mut cache) => cache.prune(),
                Err(_) => tracing::warn!("companion media cache cleanup lock failed"),
            };
        }
    });
}

pub(super) fn clear_cache(app: &AppHandle) {
    clear_transfer_cache(&app.state::<super::CompanionRuntime>().media_transfers);
}

pub(super) fn clear_transfer_cache(cache: &std::sync::Mutex<MediaTransferCache>) {
    if let Ok(mut cache) = cache.lock() {
        cache.entries.clear();
    }
}

pub async fn session_projections(
    repositories: &Repositories,
    stored_session_id: &str,
) -> Result<Vec<CompanionMediaProjection>, AppError> {
    projections(repositories, stored_session_id, None).await
}

pub async fn run_references(
    repositories: &Repositories,
    stored_session_id: &str,
    run_id: &str,
) -> Result<Vec<MediaResultReference>, AppError> {
    Ok(projections(repositories, stored_session_id, Some(run_id))
        .await?
        .into_iter()
        .map(|projection| projection.reference)
        .take(MAX_MEDIA_REFERENCES)
        .collect())
}

async fn projections(
    repositories: &Repositories,
    stored_session_id: &str,
    run_id: Option<&str>,
) -> Result<Vec<CompanionMediaProjection>, AppError> {
    let artifacts = resolve_media_artifacts(repositories, stored_session_id, run_id).await?;
    Ok(inspect_projections(artifacts).await)
}

async fn inspect_projections(
    artifacts: Vec<ResolvedMediaArtifact>,
) -> Vec<CompanionMediaProjection> {
    let mut projections = Vec::with_capacity(artifacts.len());
    for artifact in artifacts {
        match inspect_reference(artifact.clone()).await {
            Ok(Some(reference)) => projections.push(CompanionMediaProjection {
                run_id: artifact.run_id,
                created_at: artifact.created_at,
                reference,
            }),
            Ok(None) => {}
            Err(error) => {
                tracing::warn!(
                    artifact_id = artifact.id,
                    code = %error.code,
                    "skipping unavailable companion media artifact"
                );
            }
        }
    }
    projections
}

pub async fn resolve_fetch_artifact(
    repositories: &Repositories,
    stored_session_id: &str,
    artifact_id: &str,
) -> Result<ResolvedMediaArtifact, AppError> {
    resolve_media_artifacts(repositories, stored_session_id, None)
        .await?
        .into_iter()
        .find(|artifact| artifact.id == artifact_id)
        .ok_or_else(media_unavailable)
}

pub async fn read_chunk(
    cache: &std::sync::Mutex<MediaTransferCache>,
    cache_scope: &str,
    artifact: ResolvedMediaArtifact,
    offset_bytes: u64,
) -> Result<MediaChunk, AppError> {
    let cache_key = format!("{cache_scope}\0{}\0{}", artifact.session_id, artifact.id);
    let cached = {
        let mut cache = cache
            .lock()
            .map_err(|_| media_error("The companion media cache is unavailable."))?;
        cache.prune();
        cache.entries.get_mut(&cache_key).and_then(|entry| {
            if entry.path == artifact.path && entry.size_bytes == artifact.expected_size_bytes {
                entry.touched_at = Instant::now();
                Some(entry.clone())
            } else {
                None
            }
        })
    };
    let transfer = match cached {
        Some(transfer) => transfer,
        None => {
            let transfer = prepare_transfer(artifact).await?;
            let mut cache = cache
                .lock()
                .map_err(|_| media_error("The companion media cache is unavailable."))?;
            cache.prune();
            if cache.entries.len() >= MAX_CACHED_TRANSFERS {
                if let Some(oldest) = cache
                    .entries
                    .iter()
                    .min_by_key(|(_, entry)| entry.touched_at)
                    .map(|(key, _)| key.clone())
                {
                    cache.entries.remove(&oldest);
                }
            }
            cache.entries.insert(cache_key, transfer.clone());
            transfer
        }
    };
    if offset_bytes >= transfer.size_bytes {
        return Err(AppError::new(
            "companion_media_chunk_invalid",
            "The requested media offset is outside the artifact.",
        ));
    }
    let remaining = transfer.size_bytes - offset_bytes;
    let read_len = remaining.min(MAX_MEDIA_CHUNK_BYTES as u64) as usize;
    let file = Arc::clone(&transfer.file);
    let bytes = tokio::task::spawn_blocking(move || -> std::io::Result<Vec<u8>> {
        let mut bytes = vec![0; read_len];
        read_exact_at(&file, &mut bytes, offset_bytes)?;
        Ok(bytes)
    })
    .await
    .map_err(|_| media_error("The companion media read stopped unexpectedly."))?
    .map_err(|_| media_unavailable())?;
    let complete = offset_bytes.saturating_add(bytes.len() as u64) == transfer.size_bytes;
    Ok(MediaChunk {
        artifact_id: transfer.artifact_id,
        offset_bytes,
        total_size_bytes: transfer.size_bytes,
        sha256: transfer.sha256,
        bytes,
        complete,
    })
}

#[cfg(unix)]
fn read_exact_at(file: &File, bytes: &mut [u8], offset: u64) -> std::io::Result<()> {
    use std::os::unix::fs::FileExt;
    file.read_exact_at(bytes, offset)
}

#[cfg(windows)]
fn read_exact_at(file: &File, bytes: &mut [u8], offset: u64) -> std::io::Result<()> {
    use std::os::windows::fs::FileExt;
    let mut read = 0;
    while read < bytes.len() {
        let count = file.seek_read(&mut bytes[read..], offset + read as u64)?;
        if count == 0 {
            return Err(std::io::ErrorKind::UnexpectedEof.into());
        }
        read += count;
    }
    Ok(())
}

#[cfg(not(any(unix, windows)))]
fn read_exact_at(file: &File, bytes: &mut [u8], offset: u64) -> std::io::Result<()> {
    let mut file = file.try_clone()?;
    file.seek(SeekFrom::Start(offset))?;
    file.read_exact(bytes)
}

impl MediaTransferCache {
    fn prune(&mut self) {
        self.prune_at(Instant::now());
    }

    fn prune_at(&mut self, now: Instant) {
        self.entries.retain(|_, entry| {
            now.saturating_duration_since(entry.touched_at) <= TRANSFER_IDLE_TTL
        });
    }

    #[cfg(test)]
    pub(super) fn insert_test_transfer(&mut self, path: PathBuf) {
        self.entries.insert(
            "test-transfer".to_string(),
            CachedTransfer {
                file: Arc::new(File::open(&path).expect("open test transfer")),
                artifact_id: "artifact".to_string(),
                path,
                size_bytes: 1,
                sha256: "0".repeat(64),
                touched_at: Instant::now(),
            },
        );
    }

    #[cfg(test)]
    pub(super) fn test_transfer_count(&self) -> usize {
        self.entries.len()
    }
}

async fn resolve_media_artifacts(
    repositories: &Repositories,
    stored_session_id: &str,
    run_id: Option<&str>,
) -> Result<Vec<ResolvedMediaArtifact>, AppError> {
    let repository = AgentRepository::new(repositories.pool.clone());
    let session = repository
        .get_session(stored_session_id)
        .await
        .map_err(|_| media_unavailable())?;
    let workspace_path = session
        .workspace_path
        .map(PathBuf::from)
        .ok_or_else(media_unavailable)?;
    let artifacts = repository
        .artifacts(stored_session_id)
        .await
        .map_err(AppError::from)?;
    let mut resolved = artifacts
        .into_iter()
        .filter_map(|artifact| resolved_artifact(artifact, &workspace_path, run_id))
        .collect::<Vec<_>>();
    if resolved.len() > MAX_SESSION_MEDIA_REFERENCES {
        resolved.drain(..resolved.len() - MAX_SESSION_MEDIA_REFERENCES);
    }
    Ok(resolved)
}

fn resolved_artifact(
    artifact: AgentArtifactDto,
    workspace_path: &Path,
    run_id: Option<&str>,
) -> Option<ResolvedMediaArtifact> {
    if !artifact.available
        || artifact.provenance != "tool"
        || run_id.is_some_and(|run_id| artifact.run_id.as_deref() != Some(run_id))
    {
        return None;
    }
    let media_type = artifact.mime_type?.trim().to_ascii_lowercase();
    let kind = if media_type.starts_with("image/") {
        MediaKind::Image
    } else if media_type.starts_with("video/") {
        MediaKind::Video
    } else {
        return None;
    };
    validate_media_type(&media_type, kind).ok()?;
    let expected_size_bytes = u64::try_from(artifact.size_bytes?).ok()?;
    if expected_size_bytes == 0 || expected_size_bytes > MAX_MEDIA_BYTES {
        return None;
    }
    Some(ResolvedMediaArtifact {
        id: artifact.id,
        session_id: artifact.session_id,
        run_id: artifact.run_id,
        created_at: artifact.created_at,
        path: PathBuf::from(artifact.path),
        workspace_path: workspace_path.to_path_buf(),
        media_type,
        kind,
        expected_size_bytes,
    })
}

async fn inspect_reference(
    artifact: ResolvedMediaArtifact,
) -> Result<Option<MediaResultReference>, AppError> {
    tokio::task::spawn_blocking(move || {
        let file = open_validated_artifact(&artifact)?;
        let (width_px, height_px, duration_ms) = match artifact.kind {
            MediaKind::Image => {
                let dimensions = imagesize::reader_size(BufReader::new(
                    file.try_clone().map_err(|_| media_unavailable())?,
                ))
                .map_err(|_| media_unavailable())?;
                let width = u32::try_from(dimensions.width).ok();
                let height = u32::try_from(dimensions.height).ok();
                match (width, height) {
                    (Some(width), Some(height))
                        if width > 0
                            && width <= MAX_MEDIA_DIMENSION_PX
                            && height > 0
                            && height <= MAX_MEDIA_DIMENSION_PX =>
                    {
                        (Some(width), Some(height), None)
                    }
                    _ => return Ok(None),
                }
            }
            MediaKind::Video => {
                let metadata = inspect_mp4(file.try_clone().map_err(|_| media_unavailable())?)
                    .map_err(|_| media_unavailable())?;
                if !metadata.recognized {
                    return Ok(None);
                }
                (metadata.width_px, metadata.height_px, metadata.duration_ms)
            }
        };
        Ok(Some(MediaResultReference {
            artifact_id: artifact.id,
            kind: artifact.kind,
            media_type: artifact.media_type,
            width_px,
            height_px,
            duration_ms,
            size_bytes: artifact.expected_size_bytes,
        }))
    })
    .await
    .map_err(|_| media_error("The companion media inspection stopped unexpectedly."))?
}

async fn prepare_transfer(artifact: ResolvedMediaArtifact) -> Result<CachedTransfer, AppError> {
    tokio::task::spawn_blocking(move || {
        let file = open_validated_artifact(&artifact)?;
        let mut reader = file.try_clone().map_err(|_| media_unavailable())?;
        let mut digest = Sha256::new();
        let mut buffer = [0_u8; 64 * 1024];
        loop {
            let count = reader.read(&mut buffer).map_err(|_| media_unavailable())?;
            if count == 0 {
                break;
            }
            digest.update(&buffer[..count]);
        }
        Ok(CachedTransfer {
            file: Arc::new(file),
            artifact_id: artifact.id,
            path: artifact.path,
            size_bytes: artifact.expected_size_bytes,
            sha256: format!("{:x}", digest.finalize()),
            touched_at: Instant::now(),
        })
    })
    .await
    .map_err(|_| media_error("The companion media transfer stopped unexpectedly."))?
}

fn open_validated_artifact(artifact: &ResolvedMediaArtifact) -> Result<File, AppError> {
    let workspace = artifact
        .workspace_path
        .canonicalize()
        .map_err(|_| media_unavailable())?;
    let link_metadata =
        std::fs::symlink_metadata(&artifact.path).map_err(|_| media_unavailable())?;
    if link_metadata.file_type().is_symlink() || !link_metadata.is_file() {
        return Err(media_unavailable());
    }
    let path = artifact
        .path
        .canonicalize()
        .map_err(|_| media_unavailable())?;
    if !path.starts_with(&workspace) {
        return Err(media_unavailable());
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
        options.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    }
    let file = options.open(&path).map_err(|_| media_unavailable())?;
    let handle_metadata = file.metadata().map_err(|_| media_unavailable())?;
    let current_path = path.canonicalize().map_err(|_| media_unavailable())?;
    if !current_path.starts_with(&workspace) {
        return Err(media_unavailable());
    }
    let path_metadata = std::fs::metadata(&current_path).map_err(|_| media_unavailable())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if handle_metadata.dev() != path_metadata.dev()
            || handle_metadata.ino() != path_metadata.ino()
        {
            return Err(media_unavailable());
        }
    }
    if !handle_metadata.is_file()
        || handle_metadata.len() != artifact.expected_size_bytes
        || handle_metadata.len() == 0
        || handle_metadata.len() > MAX_MEDIA_BYTES
    {
        return Err(media_unavailable());
    }
    Ok(file)
}

#[derive(Debug, Default, PartialEq, Eq)]
struct Mp4Metadata {
    recognized: bool,
    width_px: Option<u32>,
    height_px: Option<u32>,
    duration_ms: Option<u64>,
}

#[derive(Debug)]
struct BoxHeader {
    kind: [u8; 4],
    content_start: u64,
    end: u64,
}

fn inspect_mp4(mut file: File) -> std::io::Result<Mp4Metadata> {
    let file_len = file.metadata()?.len();
    let mut offset = 0;
    let mut metadata = Mp4Metadata::default();
    while let Some(header) = read_box_header(&mut file, offset, file_len)? {
        if &header.kind == b"ftyp" {
            metadata.recognized = true;
        } else if &header.kind == b"moov" {
            inspect_moov(&mut file, &header, &mut metadata)?;
        }
        if header.end <= offset {
            break;
        }
        offset = header.end;
    }
    Ok(metadata)
}

fn inspect_moov(
    file: &mut File,
    moov: &BoxHeader,
    metadata: &mut Mp4Metadata,
) -> std::io::Result<()> {
    let mut offset = moov.content_start;
    while let Some(header) = read_box_header(file, offset, moov.end)? {
        match &header.kind {
            b"mvhd" => metadata.duration_ms = read_mvhd_duration(file, &header)?,
            b"trak" => {
                if let Some((width, height)) = inspect_video_track(file, &header)? {
                    metadata.width_px = Some(width);
                    metadata.height_px = Some(height);
                }
            }
            _ => {}
        }
        if header.end <= offset {
            break;
        }
        offset = header.end;
    }
    Ok(())
}

fn inspect_video_track(file: &mut File, track: &BoxHeader) -> std::io::Result<Option<(u32, u32)>> {
    let mut offset = track.content_start;
    let mut dimensions = None;
    let mut video_handler = false;
    while let Some(header) = read_box_header(file, offset, track.end)? {
        match &header.kind {
            b"tkhd" => dimensions = read_tkhd_dimensions(file, &header)?,
            b"mdia" => video_handler = mdia_is_video(file, &header)?,
            _ => {}
        }
        if header.end <= offset {
            break;
        }
        offset = header.end;
    }
    Ok(video_handler.then_some(dimensions).flatten())
}

fn mdia_is_video(file: &mut File, mdia: &BoxHeader) -> std::io::Result<bool> {
    let mut offset = mdia.content_start;
    while let Some(header) = read_box_header(file, offset, mdia.end)? {
        if &header.kind == b"hdlr" && header.end.saturating_sub(header.content_start) >= 12 {
            let mut bytes = [0_u8; 12];
            file.seek(SeekFrom::Start(header.content_start))?;
            file.read_exact(&mut bytes)?;
            return Ok(&bytes[8..12] == b"vide");
        }
        if header.end <= offset {
            break;
        }
        offset = header.end;
    }
    Ok(false)
}

fn read_mvhd_duration(file: &mut File, header: &BoxHeader) -> std::io::Result<Option<u64>> {
    let payload_len = header.end.saturating_sub(header.content_start);
    let mut prefix = [0_u8; 32];
    let needed = payload_len.min(prefix.len() as u64) as usize;
    file.seek(SeekFrom::Start(header.content_start))?;
    file.read_exact(&mut prefix[..needed])?;
    let (timescale, duration) = match prefix.first().copied() {
        Some(0) if needed >= 20 => (
            u32::from_be_bytes(prefix[12..16].try_into().unwrap()) as u64,
            u32::from_be_bytes(prefix[16..20].try_into().unwrap()) as u64,
        ),
        Some(1) if needed >= 32 => (
            u32::from_be_bytes(prefix[20..24].try_into().unwrap()) as u64,
            u64::from_be_bytes(prefix[24..32].try_into().unwrap()),
        ),
        _ => return Ok(None),
    };
    if timescale == 0 {
        return Ok(None);
    }
    let duration_ms = u64::try_from(u128::from(duration) * 1_000 / u128::from(timescale)).ok();
    Ok(duration_ms.filter(|duration_ms| *duration_ms > 0 && *duration_ms <= MAX_MEDIA_DURATION_MS))
}

fn read_tkhd_dimensions(
    file: &mut File,
    header: &BoxHeader,
) -> std::io::Result<Option<(u32, u32)>> {
    if header.end.saturating_sub(header.content_start) < 8 {
        return Ok(None);
    }
    let mut dimensions = [0_u8; 8];
    file.seek(SeekFrom::Start(header.end - 8))?;
    file.read_exact(&mut dimensions)?;
    let width = u32::from_be_bytes(dimensions[..4].try_into().unwrap()) >> 16;
    let height = u32::from_be_bytes(dimensions[4..].try_into().unwrap()) >> 16;
    Ok((width > 0
        && width <= MAX_MEDIA_DIMENSION_PX
        && height > 0
        && height <= MAX_MEDIA_DIMENSION_PX)
        .then_some((width, height)))
}

fn read_box_header(
    file: &mut File,
    offset: u64,
    parent_end: u64,
) -> std::io::Result<Option<BoxHeader>> {
    if offset.saturating_add(8) > parent_end {
        return Ok(None);
    }
    let mut base = [0_u8; 8];
    file.seek(SeekFrom::Start(offset))?;
    file.read_exact(&mut base)?;
    let size_32 = u32::from_be_bytes(base[..4].try_into().unwrap());
    let kind = base[4..8].try_into().unwrap();
    let (size, header_len) = match size_32 {
        0 => (parent_end - offset, 8_u64),
        1 => {
            if offset.saturating_add(16) > parent_end {
                return Err(std::io::ErrorKind::InvalidData.into());
            }
            let mut extended = [0_u8; 8];
            file.read_exact(&mut extended)?;
            (u64::from_be_bytes(extended), 16)
        }
        size => (u64::from(size), 8),
    };
    let end = offset
        .checked_add(size)
        .filter(|end| size >= header_len && *end <= parent_end)
        .ok_or(std::io::ErrorKind::InvalidData)?;
    Ok(Some(BoxHeader {
        kind,
        content_start: offset + header_len,
        end,
    }))
}

fn media_unavailable() -> AppError {
    AppError::new(
        "companion_media_not_found",
        "That generated media is no longer available.",
    )
}

fn media_error(message: &str) -> AppError {
    AppError::new("companion_media_unavailable", message)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn artifact_with_media_type(media_type: &str) -> AgentArtifactDto {
        AgentArtifactDto {
            id: "artifact-1".to_string(),
            session_id: "session-1".to_string(),
            run_id: Some("run-1".to_string()),
            item_id: None,
            provenance: "tool".to_string(),
            action: "generate_image".to_string(),
            path: "/tmp/artifact".to_string(),
            original_path: None,
            display_name: None,
            mime_type: Some(media_type.to_string()),
            size_bytes: Some(1),
            available: true,
            created_at: "2026-07-28T00:00:00Z".to_string(),
        }
    }

    #[test]
    fn idle_media_handles_expire_without_another_fetch() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("cached.png");
        std::fs::write(&path, b"cached").unwrap();
        let now = Instant::now();
        let mut cache = MediaTransferCache::default();
        cache.entries.insert(
            "account\0device\0session\0artifact".to_string(),
            CachedTransfer {
                file: Arc::new(File::open(&path).unwrap()),
                artifact_id: "artifact".to_string(),
                path,
                size_bytes: 6,
                sha256: "0".repeat(64),
                touched_at: now
                    .checked_sub(TRANSFER_IDLE_TTL + Duration::from_secs(1))
                    .unwrap(),
            },
        );

        cache.prune_at(now);

        assert!(cache.entries.is_empty());
    }

    #[test]
    fn concrete_media_producer_uses_the_protocol_mime_grammar() {
        let workspace = Path::new("/tmp");
        for media_type in ["image/x%25", "image/x'y*z`|~"] {
            let artifact = resolved_artifact(
                artifact_with_media_type(media_type),
                workspace,
                Some("run-1"),
            )
            .expect("valid protocol media type");
            assert_eq!(artifact.media_type, media_type);
            assert_eq!(artifact.kind, MediaKind::Image);
        }

        assert!(resolved_artifact(
            artifact_with_media_type("image/svg/xml"),
            workspace,
            Some("run-1")
        )
        .is_none());
    }

    fn mp4_box(kind: &[u8; 4], payload: &[u8]) -> Vec<u8> {
        let mut bytes = Vec::with_capacity(payload.len() + 8);
        bytes.extend_from_slice(&u32::try_from(payload.len() + 8).unwrap().to_be_bytes());
        bytes.extend_from_slice(kind);
        bytes.extend_from_slice(payload);
        bytes
    }

    #[test]
    fn parses_mp4_dimensions_and_duration_from_video_track() {
        let ftyp = mp4_box(b"ftyp", b"isom\0\0\0\0isom");
        let mut mvhd_payload = vec![0; 20];
        mvhd_payload[12..16].copy_from_slice(&1_000_u32.to_be_bytes());
        mvhd_payload[16..20].copy_from_slice(&5_000_u32.to_be_bytes());
        let mvhd = mp4_box(b"mvhd", &mvhd_payload);

        let mut tkhd_payload = vec![0; 84];
        tkhd_payload[76..80].copy_from_slice(&(1_280_u32 << 16).to_be_bytes());
        tkhd_payload[80..84].copy_from_slice(&(720_u32 << 16).to_be_bytes());
        let tkhd = mp4_box(b"tkhd", &tkhd_payload);
        let mut hdlr_payload = vec![0; 12];
        hdlr_payload[8..12].copy_from_slice(b"vide");
        let mdia = mp4_box(b"mdia", &mp4_box(b"hdlr", &hdlr_payload));
        let mut trak_payload = tkhd;
        trak_payload.extend_from_slice(&mdia);
        let trak = mp4_box(b"trak", &trak_payload);
        let mut moov_payload = mvhd;
        moov_payload.extend_from_slice(&trak);
        let moov = mp4_box(b"moov", &moov_payload);

        let mut file = tempfile::tempfile().unwrap();
        file.write_all(&ftyp).unwrap();
        file.write_all(&moov).unwrap();
        file.seek(SeekFrom::Start(0)).unwrap();

        assert_eq!(
            inspect_mp4(file).unwrap(),
            Mp4Metadata {
                recognized: true,
                width_px: Some(1_280),
                height_px: Some(720),
                duration_ms: Some(5_000),
            }
        );
    }

    #[test]
    fn rejects_a_symbolic_link_even_when_it_points_inside_the_workspace() {
        let directory = tempfile::tempdir().unwrap();
        let target = directory.path().join("image.png");
        std::fs::write(&target, [1, 2, 3]).unwrap();
        let link = directory.path().join("linked.png");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&target, &link).unwrap();
        #[cfg(windows)]
        std::os::windows::fs::symlink_file(&target, &link).unwrap();
        let artifact = ResolvedMediaArtifact {
            id: "artifact-1".to_string(),
            session_id: "session-1".to_string(),
            run_id: Some("run-1".to_string()),
            created_at: "2026-07-28T00:00:00Z".to_string(),
            path: link,
            workspace_path: directory.path().to_path_buf(),
            media_type: "image/png".to_string(),
            kind: MediaKind::Image,
            expected_size_bytes: 3,
        };
        assert!(open_validated_artifact(&artifact).is_err());
    }

    #[tokio::test]
    async fn transfer_cache_keeps_the_validated_file_handle_and_digest() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("video.mp4");
        std::fs::write(&path, b"original").unwrap();
        let artifact = ResolvedMediaArtifact {
            id: "artifact-1".to_string(),
            session_id: "session-1".to_string(),
            run_id: Some("run-1".to_string()),
            created_at: "2026-07-28T00:00:00Z".to_string(),
            path: path.clone(),
            workspace_path: directory.path().to_path_buf(),
            media_type: "video/mp4".to_string(),
            kind: MediaKind::Video,
            expected_size_bytes: 8,
        };
        let transfer = prepare_transfer(artifact).await.unwrap();
        let replacement = directory.path().join("replacement.mp4");
        std::fs::write(&replacement, b"replaced").unwrap();
        #[cfg(unix)]
        std::fs::rename(replacement, path).unwrap();
        #[cfg(windows)]
        {
            std::fs::remove_file(&path).unwrap();
            std::fs::rename(replacement, path).unwrap();
        }
        let mut bytes = vec![0; transfer.size_bytes as usize];
        read_exact_at(&transfer.file, &mut bytes, 0).unwrap();
        assert_eq!(bytes, b"original");
        assert_eq!(
            transfer.sha256,
            "0682c5f2076f099c34cfdd15a9e063849ed437a49677e6fcc5b4198c76575be5"
        );
    }

    #[tokio::test]
    async fn reads_bounded_chunks_with_one_digest_and_explicit_completion() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("image.png");
        let mut source = vec![7_u8; MAX_MEDIA_CHUNK_BYTES];
        source.extend_from_slice(b"tail");
        std::fs::write(&path, &source).unwrap();
        let artifact = ResolvedMediaArtifact {
            id: "artifact-1".to_string(),
            session_id: "session-1".to_string(),
            run_id: Some("run-1".to_string()),
            created_at: "2026-07-28T00:00:00Z".to_string(),
            path,
            workspace_path: directory.path().to_path_buf(),
            media_type: "image/png".to_string(),
            kind: MediaKind::Image,
            expected_size_bytes: source.len() as u64,
        };
        let cache = std::sync::Mutex::new(MediaTransferCache::default());

        let first = read_chunk(&cache, "account\0device", artifact.clone(), 0)
            .await
            .unwrap();
        let second = read_chunk(
            &cache,
            "account\0device",
            artifact,
            MAX_MEDIA_CHUNK_BYTES as u64,
        )
        .await
        .unwrap();

        assert_eq!(first.bytes.len(), MAX_MEDIA_CHUNK_BYTES);
        assert!(!first.complete);
        assert_eq!(second.bytes, b"tail");
        assert!(second.complete);
        assert_eq!(first.sha256, second.sha256);
        assert_eq!(first.total_size_bytes, source.len() as u64);
        assert_eq!(second.offset_bytes, MAX_MEDIA_CHUNK_BYTES as u64);
    }

    #[tokio::test]
    async fn unavailable_artifact_does_not_hide_a_valid_media_projection() {
        let directory = tempfile::tempdir().unwrap();
        let valid_path = directory.path().join("valid.png");
        // A complete 1x1 transparent PNG.
        std::fs::write(
            &valid_path,
            [
                137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0,
                1, 8, 6, 0, 0, 0, 31, 21, 196, 137, 0, 0, 0, 13, 73, 68, 65, 84, 8, 215, 99, 96, 0,
                0, 0, 2, 0, 1, 226, 33, 188, 51, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130,
            ],
        )
        .unwrap();
        let valid_size = std::fs::metadata(&valid_path).unwrap().len();
        let artifact = |id: &str, path: PathBuf, size| ResolvedMediaArtifact {
            id: id.to_string(),
            session_id: "session-1".to_string(),
            run_id: Some("run-1".to_string()),
            created_at: "2026-07-28T00:00:00Z".to_string(),
            path,
            workspace_path: directory.path().to_path_buf(),
            media_type: "image/png".to_string(),
            kind: MediaKind::Image,
            expected_size_bytes: size,
        };

        let projections = inspect_projections(vec![
            artifact("missing", directory.path().join("missing.png"), 1),
            artifact("valid", valid_path, valid_size),
        ])
        .await;

        assert_eq!(projections.len(), 1);
        assert_eq!(projections[0].reference.artifact_id, "valid");
    }
}
