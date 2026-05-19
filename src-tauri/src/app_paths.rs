use std::path::PathBuf;

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
}
