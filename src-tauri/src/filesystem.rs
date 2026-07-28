use std::{
    fs, io,
    path::{Path, PathBuf},
};

/// Strips the Win32 file namespace prefix (`\\?\` or `\\?\UNC\`) that
/// `Path::canonicalize` adds on Windows so paths shown to the AI model or UI
/// are ordinary drive or UNC paths. On non-Windows targets the path is
/// returned unchanged.
#[cfg(windows)]
pub(crate) fn normalize_path_for_external_use(path: &Path) -> PathBuf {
    let path = path.to_string_lossy();
    if let Some(unc) = path.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{unc}"));
    }
    if let Some(drive_path) = path.strip_prefix(r"\\?\") {
        return PathBuf::from(drive_path);
    }
    PathBuf::from(path.as_ref())
}

#[cfg(not(windows))]
pub(crate) fn normalize_path_for_external_use(path: &Path) -> PathBuf {
    path.to_path_buf()
}

#[cfg(windows)]
pub(crate) fn replace_file(temp_path: &Path, path: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows::core::PCWSTR;
    use windows::Win32::Storage::FileSystem::{
        MoveFileExW, ReplaceFileW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
        REPLACEFILE_WRITE_THROUGH,
    };
    let temp: Vec<u16> = temp_path.as_os_str().encode_wide().chain(Some(0)).collect();
    let target: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    unsafe {
        if path.exists() {
            ReplaceFileW(
                PCWSTR(target.as_ptr()),
                PCWSTR(temp.as_ptr()),
                PCWSTR::null(),
                REPLACEFILE_WRITE_THROUGH,
                None,
                None,
            )
        } else {
            MoveFileExW(
                PCWSTR(temp.as_ptr()),
                PCWSTR(target.as_ptr()),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
            )
        }
    }
    .map_err(|_| io::Error::last_os_error())
}

#[cfg(not(windows))]
pub(crate) fn replace_file(temp_path: &Path, path: &Path) -> io::Result<()> {
    fs::rename(temp_path, path)
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn normalizes_windows_verbatim_paths_for_external_use() {
        assert_eq!(
            normalize_path_for_external_use(Path::new(r"\\?\C:\Users\example\Vault")),
            PathBuf::from(r"C:\Users\example\Vault")
        );
        assert_eq!(
            normalize_path_for_external_use(Path::new(r"\\?\UNC\server\share\Vault")),
            PathBuf::from(r"\\server\share\Vault")
        );
    }
}
