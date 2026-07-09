#[cfg(target_os = "macos")]
pub use crate::audio::system_macos::{
    helper_permission_check, system_audio_readiness, SystemAudioCapture,
    SYSTEM_AUDIO_PERMISSION_PROBE_TIMEOUT,
};

#[cfg(target_os = "windows")]
pub use crate::audio::system_windows::{
    helper_permission_check, system_audio_readiness, SystemAudioCapture,
    SYSTEM_AUDIO_PERMISSION_PROBE_TIMEOUT,
};

#[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
pub use unsupported::{
    helper_permission_check, system_audio_readiness, SystemAudioCapture,
    SYSTEM_AUDIO_PERMISSION_PROBE_TIMEOUT,
};

#[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
mod unsupported {
    use crate::domain::types::{AppError, AudioLevelDto, RecordingSource, SourceReadinessDto};
    use std::{path::PathBuf, time::Duration};

    pub const SYSTEM_AUDIO_PERMISSION_PROBE_TIMEOUT: Duration = Duration::from_secs(1);

    pub struct SystemAudioCapture;

    impl SystemAudioCapture {
        pub fn start(
            _partial_path: PathBuf,
            _final_path: PathBuf,
            _timeline_offset: Duration,
        ) -> Result<Self, AppError> {
            Err(unsupported_error())
        }

        pub fn pause(&mut self) {}

        pub fn resume(&mut self) {}

        pub fn status(&self) -> (AudioLevelDto, i64, Option<String>) {
            (AudioLevelDto::default(), 0, Some(unsupported_message()))
        }

        pub fn stop(self) -> Result<PathBuf, AppError> {
            Err(unsupported_error())
        }
    }

    pub fn system_audio_readiness() -> SourceReadinessDto {
        SourceReadinessDto {
            source: RecordingSource::System,
            required: true,
            ready: false,
            permission_state: "unsupported".to_string(),
            device_available: false,
            capture_available: false,
            recovery_action: None,
            message: Some(unsupported_message()),
        }
    }

    pub fn helper_permission_check() -> Result<(), AppError> {
        Err(unsupported_error())
    }

    fn unsupported_error() -> AppError {
        AppError::new("system_audio_unsupported", unsupported_message())
    }

    fn unsupported_message() -> String {
        "System audio capture is not supported on this platform.".to_string()
    }
}
