//! Fallback system-audio backend for platforms without a native implementation.
//!
//! macOS uses `system_macos`, Windows uses `system_windows`, and a Linux
//! backend slots in the same way (its module would be gated in `audio::mod` and
//! narrow this stub's `cfg` to `not(any(macos, windows, linux))`). Until then,
//! any other OS reports system audio as unsupported and never constructs a
//! capture. The API mirrors the real backends so `audio::capture` compiles
//! unchanged.

use crate::domain::types::{AppError, AudioLevelDto, RecordingSource, SourceReadinessDto};
use std::path::PathBuf;
use std::time::Duration;

pub struct SystemAudioCapture {
    _never: std::convert::Infallible,
}

impl SystemAudioCapture {
    pub fn start(
        _partial_path: PathBuf,
        _final_path: PathBuf,
        _timeline_offset: Duration,
    ) -> Result<Self, AppError> {
        Err(AppError::new(
            "system_audio_unavailable",
            "System audio capture is not supported on this platform.",
        ))
    }

    pub fn pause(&mut self) {
        match self._never {}
    }

    pub fn resume(&mut self) {
        match self._never {}
    }

    pub fn status(&self) -> (AudioLevelDto, i64, Option<String>) {
        match self._never {}
    }

    pub fn stop(self) -> Result<PathBuf, AppError> {
        match self._never {}
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
        message: Some("System audio capture is not supported on this platform.".to_string()),
    }
}

pub fn helper_permission_check() -> Result<(), AppError> {
    Err(AppError::new(
        "system_audio_unavailable",
        "System audio capture is not supported on this platform.",
    ))
}
