pub mod capture;
pub mod live_preview;
pub mod recovery;
pub mod turns;
pub mod validation;
pub mod waveform;

// Per-platform system-audio backends. Each exposes the same `SystemAudioCapture`
// type plus `system_audio_readiness` / `helper_permission_check`, re-exported
// below under one path so `capture.rs` and `commands.rs` are platform agnostic.
#[cfg(target_os = "linux")]
mod system_linux;
#[cfg(target_os = "macos")]
mod system_macos;
#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
mod system_stub;
#[cfg(target_os = "windows")]
mod system_windows;

// Shared wall-clock alignment / level math for the non-macOS backends. Compiled
// on every host so its cross-platform unit tests run under the macOS CI gate.
mod system_timeline;

#[cfg(target_os = "linux")]
pub use system_linux::{helper_permission_check, system_audio_readiness, SystemAudioCapture};
#[cfg(target_os = "macos")]
pub use system_macos::{helper_permission_check, system_audio_readiness, SystemAudioCapture};
#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
pub use system_stub::{helper_permission_check, system_audio_readiness, SystemAudioCapture};
#[cfg(target_os = "windows")]
pub use system_windows::{helper_permission_check, system_audio_readiness, SystemAudioCapture};
