use crate::{
    app_paths::AppPaths,
    domain::types::{AppError, DownloadNoteAudioResponse},
};
use std::{
    collections::HashMap,
    fs::{self, File},
    io::{self, Write},
    path::{Path, PathBuf},
};
use tempfile::NamedTempFile;
use zip::{write::SimpleFileOptions, CompressionMethod, ZipWriter};

const TITLE_MAX_BYTES: usize = 80;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct NoteAudioExportSelection {
    pub note_id: String,
    pub title: String,
    pub sources: Vec<NoteAudioExportSource>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct NoteAudioExportSource {
    pub path: PathBuf,
    pub recording_session_id: String,
    pub source: String,
}

pub(crate) fn unavailable_error() -> AppError {
    AppError::new(
        "note_audio_unavailable",
        "This note does not have audio available to download.",
    )
}

pub(crate) fn export_note_audio(
    app_paths: &AppPaths,
    downloads_dir: &Path,
    selection: NoteAudioExportSelection,
) -> Result<DownloadNoteAudioResponse, AppError> {
    if selection.sources.is_empty() {
        return Err(unavailable_error());
    }

    let NoteAudioExportSelection {
        note_id,
        title,
        sources,
    } = selection;

    // Validate the entire selection before creating an output file. Export is
    // all-or-nothing: a partial archive could look complete while silently
    // omitting one of a note's original Sources.
    let sources = sources
        .into_iter()
        .map(|source| validate_source(app_paths, &note_id, source))
        .collect::<Result<Vec<_>, _>>()?;

    fs::create_dir_all(downloads_dir).map_err(export_io_error)?;
    let title = sanitized_title(&title);
    let extension = if sources.len() == 1 { "wav" } else { "zip" };
    let base_name = format!("{title} audio");
    let mut temporary = NamedTempFile::new_in(downloads_dir).map_err(export_io_error)?;

    if sources.len() == 1 {
        let mut input = File::open(&sources[0].path).map_err(export_io_error)?;
        io::copy(&mut input, temporary.as_file_mut()).map_err(export_io_error)?;
    } else {
        write_archive(temporary.as_file_mut(), &sources)?;
    }
    temporary.as_file_mut().flush().map_err(export_io_error)?;

    let destination = persist_without_overwrite(temporary, downloads_dir, &base_name, extension)?;
    let file_name = destination
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| {
            AppError::new(
                "note_audio_export_failed",
                "The downloaded audio filename is not valid UTF-8.",
            )
        })?
        .to_string();
    Ok(DownloadNoteAudioResponse {
        path: destination.to_string_lossy().into_owned(),
        file_name,
        source_count: sources.len(),
    })
}

fn validate_source(
    app_paths: &AppPaths,
    note_id: &str,
    source: NoteAudioExportSource,
) -> Result<NoteAudioExportSource, AppError> {
    let link_metadata = fs::symlink_metadata(&source.path).map_err(export_io_error)?;
    if link_metadata.file_type().is_symlink() {
        return Err(AppError::new(
            "note_audio_export_denied",
            "A selected audio file is a symbolic link.",
        ));
    }
    let path = app_paths
        .contained_recording_file(&source.path)
        .map_err(export_io_error)?;
    let expected_recording_session_dir = app_paths
        .recording_session_dir(note_id, &source.recording_session_id)
        .map_err(export_io_error)?;
    let canonical_recordings_dir = app_paths
        .recordings_dir
        .canonicalize()
        .map_err(export_io_error)?;
    let expected_note_dir = canonical_recordings_dir.join(note_id);
    let expected_legacy_path =
        expected_note_dir.join(format!("{}.wav", &source.recording_session_id));
    if path == expected_legacy_path {
        return validate_wav_file(source, path);
    }

    let expected_canonical_dir = expected_note_dir.join(&source.recording_session_id);
    if !path.starts_with(&expected_canonical_dir) {
        return Err(AppError::new(
            "note_audio_export_denied",
            "A selected audio file is outside its Recording session directory.",
        ));
    }
    let canonical_recording_session_dir = expected_recording_session_dir
        .canonicalize()
        .map_err(export_io_error)?;
    if canonical_recording_session_dir != expected_canonical_dir {
        return Err(AppError::new(
            "note_audio_export_denied",
            "A selected audio file is outside its Recording session directory.",
        ));
    }
    validate_wav_file(source, path)
}

fn validate_wav_file(
    source: NoteAudioExportSource,
    path: PathBuf,
) -> Result<NoteAudioExportSource, AppError> {
    let metadata = fs::metadata(&path).map_err(export_io_error)?;
    if !metadata.is_file()
        || metadata.len() == 0
        || path
            .extension()
            .and_then(|extension| extension.to_str())
            .map_or(true, |extension| !extension.eq_ignore_ascii_case("wav"))
    {
        return Err(AppError::new(
            "note_audio_export_failed",
            "A selected audio file is not a non-empty WAV file.",
        ));
    }
    Ok(NoteAudioExportSource { path, ..source })
}

fn write_archive(output: &mut File, sources: &[NoteAudioExportSource]) -> Result<(), AppError> {
    let mut archive = ZipWriter::new(output);
    let options = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
    let mut recording_session_number = 0usize;
    let mut previous_recording_session: Option<&str> = None;
    let mut names_per_recording_session = HashMap::<(usize, String), usize>::new();

    for source in sources {
        if previous_recording_session != Some(source.recording_session_id.as_str()) {
            recording_session_number += 1;
            previous_recording_session = Some(&source.recording_session_id);
        }
        let stem = match source.source.as_str() {
            "microphone" => "microphone",
            "system" => "system",
            _ => "audio",
        };
        let duplicate_number = names_per_recording_session
            .entry((recording_session_number, stem.to_string()))
            .and_modify(|count| *count += 1)
            .or_insert(1);
        let suffix = if *duplicate_number == 1 {
            String::new()
        } else {
            format!("-{}", duplicate_number)
        };
        let entry_name = format!("recording-{recording_session_number:03}/{stem}{suffix}.wav");
        archive
            .start_file(entry_name, options)
            .map_err(export_zip_error)?;
        let mut input = File::open(&source.path).map_err(export_io_error)?;
        io::copy(&mut input, &mut archive).map_err(export_io_error)?;
    }
    archive.finish().map_err(export_zip_error)?;
    Ok(())
}

fn persist_without_overwrite(
    mut temporary: NamedTempFile,
    downloads_dir: &Path,
    base_name: &str,
    extension: &str,
) -> Result<PathBuf, AppError> {
    for collision in 0usize.. {
        let suffix = if collision == 0 {
            String::new()
        } else {
            format!(" ({collision})")
        };
        let destination = downloads_dir.join(format!("{base_name}{suffix}.{extension}"));
        match temporary.persist_noclobber(&destination) {
            Ok(_) => return Ok(destination),
            Err(error) if error.error.kind() == io::ErrorKind::AlreadyExists => {
                temporary = error.file;
            }
            Err(error) => return Err(export_io_error(error.error)),
        }
    }
    unreachable!("the collision counter is unbounded")
}

fn sanitized_title(title: &str) -> String {
    let normalized = title
        .chars()
        .map(|character| {
            if character.is_control()
                || matches!(
                    character,
                    '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*'
                )
            {
                ' '
            } else {
                character
            }
        })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    let mut sanitized = String::new();
    for character in normalized.trim_matches(['.', ' ']).chars() {
        if sanitized.len() + character.len_utf8() > TITLE_MAX_BYTES {
            break;
        }
        sanitized.push(character);
    }
    sanitized = sanitized.trim_end_matches(['.', ' ']).to_string();
    if sanitized.is_empty() || is_windows_reserved_name(&sanitized) {
        "Meeting notes".to_string()
    } else {
        sanitized
    }
}

fn is_windows_reserved_name(value: &str) -> bool {
    let stem = value
        .split('.')
        .next()
        .unwrap_or(value)
        .to_ascii_uppercase();
    matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || stem
            .strip_prefix("COM")
            .or_else(|| stem.strip_prefix("LPT"))
            .is_some_and(|suffix| suffix.len() == 1 && matches!(suffix.as_bytes()[0], b'1'..=b'9'))
}

fn export_io_error(error: io::Error) -> AppError {
    if error.kind() == io::ErrorKind::PermissionDenied {
        AppError::new("note_audio_export_denied", error.to_string())
    } else {
        AppError::new("note_audio_export_failed", error.to_string())
    }
}

fn export_zip_error(error: zip::result::ZipError) -> AppError {
    match error {
        zip::result::ZipError::Io(error) => export_io_error(error),
        error => AppError::new("note_audio_export_failed", error.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Cursor, Read};

    fn source(path: PathBuf, recording_session_id: &str, source: &str) -> NoteAudioExportSource {
        NoteAudioExportSource {
            path,
            recording_session_id: recording_session_id.to_string(),
            source: source.to_string(),
        }
    }

    fn fixture() -> (tempfile::TempDir, AppPaths, PathBuf) {
        let temp = tempfile::tempdir().expect("tempdir");
        let paths = AppPaths::from_data_dir(temp.path().join("data")).expect("app paths");
        let downloads = temp.path().join("downloads");
        fs::create_dir_all(&downloads).expect("downloads");
        (temp, paths, downloads)
    }

    const NOTE_ID: &str = "note-a";

    fn recording_file(
        paths: &AppPaths,
        note_id: &str,
        recording_session_id: &str,
        name: &str,
        bytes: &[u8],
    ) -> PathBuf {
        let directory = paths
            .recording_session_dir(note_id, recording_session_id)
            .expect("Recording session directory");
        fs::create_dir_all(&directory).expect("create Recording session directory");
        let path = directory.join(name);
        fs::write(&path, bytes).expect("write source");
        path
    }

    fn selection(title: &str, sources: Vec<NoteAudioExportSource>) -> NoteAudioExportSelection {
        NoteAudioExportSelection {
            note_id: NOTE_ID.to_string(),
            title: title.to_string(),
            sources,
        }
    }

    #[test]
    fn single_source_is_copied_exactly_and_never_overwrites() {
        let (_temp, paths, downloads) = fixture();
        let wav = recording_file(
            &paths,
            NOTE_ID,
            "session-a",
            "microphone.wav",
            b"exact wav bytes",
        );
        fs::write(downloads.join("Planning audio.wav"), b"keep me").expect("collision");

        let result = export_note_audio(
            &paths,
            &downloads,
            selection("Planning", vec![source(wav, "session-a", "microphone")]),
        )
        .expect("export");

        assert_eq!(result.file_name, "Planning audio (1).wav");
        assert_eq!(result.source_count, 1);
        assert_eq!(
            fs::read(result.path).expect("read export"),
            b"exact wav bytes"
        );
        assert_eq!(
            fs::read(downloads.join("Planning audio.wav")).expect("read existing"),
            b"keep me"
        );
    }

    #[test]
    fn multi_source_archive_has_deterministic_names_and_exact_bytes() {
        let (_temp, paths, downloads) = fixture();
        let microphone_a = recording_file(&paths, NOTE_ID, "session-a", "mic-a.wav", b"mic a");
        let microphone_a_duplicate = recording_file(
            &paths,
            NOTE_ID,
            "session-a",
            "mic-a-duplicate.wav",
            b"mic a 2",
        );
        let system_a = recording_file(&paths, NOTE_ID, "session-a", "system-a.wav", b"system a");
        let microphone_b = recording_file(&paths, NOTE_ID, "session-b", "mic-b.wav", b"mic b");

        let result = export_note_audio(
            &paths,
            &downloads,
            selection(
                "Weekly sync",
                vec![
                    source(microphone_a, "session-a", "microphone"),
                    source(microphone_a_duplicate, "session-a", "microphone"),
                    source(system_a, "session-a", "system"),
                    source(microphone_b, "session-b", "microphone"),
                ],
            ),
        )
        .expect("export");

        assert_eq!(result.file_name, "Weekly sync audio.zip");
        assert_eq!(result.source_count, 4);
        let bytes = fs::read(result.path).expect("read archive");
        let mut archive = zip::ZipArchive::new(Cursor::new(bytes)).expect("open archive");
        let expected = [
            ("recording-001/microphone.wav", b"mic a".as_slice()),
            ("recording-001/microphone-2.wav", b"mic a 2".as_slice()),
            ("recording-001/system.wav", b"system a".as_slice()),
            ("recording-002/microphone.wav", b"mic b".as_slice()),
        ];
        assert_eq!(archive.len(), expected.len());
        for (index, (name, expected_bytes)) in expected.iter().enumerate() {
            let mut entry = archive.by_index(index).expect("entry");
            let mut actual = Vec::new();
            entry.read_to_end(&mut actual).expect("entry bytes");
            assert_eq!(entry.name(), *name);
            assert_eq!(actual, *expected_bytes);
            assert_eq!(entry.compression(), CompressionMethod::Stored);
        }
    }

    #[test]
    fn unsafe_empty_long_and_reserved_titles_are_portable() {
        assert_eq!(sanitized_title("  Team: sync?/now.  "), "Team sync now");
        assert_eq!(sanitized_title("<>:\"/\\|?*\0"), "Meeting notes");
        assert_eq!(sanitized_title("CON.txt"), "Meeting notes");
        assert_eq!(sanitized_title(&"a".repeat(100)).len(), TITLE_MAX_BYTES);
        assert!(sanitized_title(&"😀".repeat(100)).len() <= TITLE_MAX_BYTES);
    }

    #[test]
    fn empty_selection_is_unavailable_without_creating_output() {
        let (_temp, paths, downloads) = fixture();
        let error = export_note_audio(&paths, &downloads, selection("Empty", Vec::new()))
            .expect_err("empty selection");
        assert_eq!(error.code, "note_audio_unavailable");
        assert_eq!(fs::read_dir(downloads).expect("downloads").count(), 0);
    }

    #[test]
    fn invalid_source_aborts_without_leaving_output_or_temporary_file() {
        let (_temp, paths, downloads) = fixture();
        let valid = recording_file(&paths, NOTE_ID, "session-a", "valid.wav", b"valid");
        let missing = paths
            .recording_session_dir(NOTE_ID, "session-a")
            .expect("Recording session directory")
            .join("missing.wav");

        let error = export_note_audio(
            &paths,
            &downloads,
            selection(
                "Partial",
                vec![
                    source(valid, "session-a", "microphone"),
                    source(missing, "session-a", "system"),
                ],
            ),
        )
        .expect_err("missing source must fail");

        assert_eq!(error.code, "note_audio_export_failed");
        assert_eq!(fs::read_dir(&downloads).expect("downloads").count(), 0);
    }

    #[test]
    fn outside_and_non_wav_sources_are_rejected() {
        let (temp, paths, downloads) = fixture();
        let outside = temp.path().join("outside.wav");
        fs::write(&outside, b"outside").expect("outside");
        let error = export_note_audio(
            &paths,
            &downloads,
            selection("Outside", vec![source(outside, "session-a", "microphone")]),
        )
        .expect_err("outside must fail");
        assert_eq!(error.code, "note_audio_export_denied");

        let wrong_extension = recording_file(&paths, NOTE_ID, "session-a", "audio.mp3", b"not wav");
        let error = export_note_audio(
            &paths,
            &downloads,
            selection(
                "Wrong format",
                vec![source(wrong_extension, "session-a", "microphone")],
            ),
        )
        .expect_err("non-wav must fail");
        assert_eq!(error.code, "note_audio_export_failed");
        assert_eq!(fs::read_dir(&downloads).expect("downloads").count(), 0);
    }

    #[test]
    fn source_must_stay_inside_the_requested_note_and_recording_session() {
        let (_temp, paths, downloads) = fixture();
        let other_note_source = recording_file(
            &paths,
            "note-b",
            "session-a",
            "microphone.wav",
            b"other note",
        );
        let error = export_note_audio(
            &paths,
            &downloads,
            selection(
                "Cross-note",
                vec![source(other_note_source, "session-a", "microphone")],
            ),
        )
        .expect_err("cross-note Source must fail");
        assert_eq!(error.code, "note_audio_export_denied");

        let other_recording_session_source = recording_file(
            &paths,
            NOTE_ID,
            "session-b",
            "microphone.wav",
            b"other Recording session",
        );
        let error = export_note_audio(
            &paths,
            &downloads,
            selection(
                "Cross-session",
                vec![source(
                    other_recording_session_source,
                    "session-a",
                    "microphone",
                )],
            ),
        )
        .expect_err("cross-Recording-session Source must fail");
        assert_eq!(error.code, "note_audio_export_denied");
        assert_eq!(fs::read_dir(&downloads).expect("downloads").count(), 0);
    }

    #[cfg(unix)]
    #[test]
    fn symbolic_link_source_is_rejected() {
        use std::os::unix::fs::symlink;

        let (_temp, paths, downloads) = fixture();
        let target = recording_file(&paths, NOTE_ID, "session-a", "target.wav", b"target");
        let link = paths
            .recording_session_dir(NOTE_ID, "session-a")
            .expect("Recording session directory")
            .join("link.wav");
        symlink(target, &link).expect("symlink");

        let error = export_note_audio(
            &paths,
            &downloads,
            selection("Link", vec![source(link, "session-a", "microphone")]),
        )
        .expect_err("symlink must fail");
        assert_eq!(error.code, "note_audio_export_denied");
        assert_eq!(fs::read_dir(&downloads).expect("downloads").count(), 0);
    }

    #[test]
    fn exact_legacy_note_recording_path_is_exported() {
        let (_temp, paths, downloads) = fixture();
        let note_directory = paths.recordings_dir.join(NOTE_ID);
        fs::create_dir_all(&note_directory).expect("legacy Note directory");
        let legacy_path = note_directory.join("session-a.wav");
        fs::write(&legacy_path, b"legacy exact bytes").expect("legacy Source");

        let result = export_note_audio(
            &paths,
            &downloads,
            selection(
                "Legacy",
                vec![source(legacy_path, "session-a", "microphone")],
            ),
        )
        .expect("legacy export");

        assert_eq!(result.file_name, "Legacy audio.wav");
        assert_eq!(
            fs::read(result.path).expect("legacy export bytes"),
            b"legacy exact bytes"
        );
    }
}
