use std::{
    io::{Error, ErrorKind},
    path::{Component, Path, PathBuf},
};

#[derive(Debug, Clone)]
pub struct AppPaths {
    pub data_dir: PathBuf,
    pub database_path: PathBuf,
    pub recordings_dir: PathBuf,
}

impl AppPaths {
    pub fn from_data_dir(data_dir: PathBuf) -> std::io::Result<Self> {
        let recordings_dir = data_dir.join("recordings");
        std::fs::create_dir_all(&recordings_dir)?;
        Ok(Self {
            database_path: data_dir.join("notes.sqlite3"),
            data_dir,
            recordings_dir,
        })
    }

    pub fn recording_session_dir(
        &self,
        note_id: &str,
        session_id: &str,
    ) -> std::io::Result<PathBuf> {
        validate_recording_component("note_id", note_id)?;
        validate_recording_component("session_id", session_id)?;
        Ok(self.recordings_dir.join(note_id).join(session_id))
    }

    pub fn contained_recording_file(&self, path: impl AsRef<Path>) -> std::io::Result<PathBuf> {
        let path = path.as_ref();
        let canonical_path = path.canonicalize()?;
        let canonical_recordings = self.recordings_dir.canonicalize()?;
        if canonical_path.starts_with(&canonical_recordings) {
            Ok(canonical_path)
        } else {
            Err(Error::new(
                ErrorKind::PermissionDenied,
                "recording path is outside the app recordings directory",
            ))
        }
    }

    pub fn remove_recording_file(&self, path: impl AsRef<Path>) -> std::io::Result<()> {
        let path = path.as_ref();
        match self.contained_recording_file(path) {
            Ok(path) => std::fs::remove_file(path),
            Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error),
        }
    }
}

fn validate_recording_component(field: &'static str, value: &str) -> std::io::Result<()> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_')
        || Path::new(value)
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(Error::new(
            ErrorKind::InvalidInput,
            format!("{field} is not a valid recording path component"),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::AppPaths;

    #[test]
    fn recording_session_dir_rejects_path_traversal_components() {
        let temp = tempfile::tempdir().expect("tempdir");
        let paths = AppPaths::from_data_dir(temp.path().join("data")).expect("paths");

        assert!(paths
            .recording_session_dir("../outside", "session")
            .is_err());
        assert!(paths
            .recording_session_dir("/tmp/outside", "session")
            .is_err());
        assert!(paths
            .recording_session_dir("note", "session/child")
            .is_err());
    }

    #[test]
    fn contained_recording_file_rejects_symlink_escape() {
        let temp = tempfile::tempdir().expect("tempdir");
        let paths = AppPaths::from_data_dir(temp.path().join("data")).expect("paths");
        let outside = temp.path().join("outside.wav");
        std::fs::write(&outside, b"outside").expect("outside");
        let inside_link = paths.recordings_dir.join("linked.wav");

        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&outside, &inside_link).expect("symlink");
            assert!(paths.contained_recording_file(&inside_link).is_err());
        }
    }
}
