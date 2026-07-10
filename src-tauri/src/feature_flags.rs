/// Video kill switch. On now that video generation launches; keep in lockstep
/// with the frontend `VIDEO_GENERATION_ENABLED` in src/lib/feature-flags.ts.
pub const VIDEO_GENERATION_ENABLED: bool = true;

/// Persona recognition is available in development for the real-recording
/// quality loop. Release builds stay off until ADR-0016's cross-recording
/// quality gate is recorded; the build-time override is the deliberate ship
/// switch once that evidence exists.
pub fn persona_recognition_enabled() -> bool {
    cfg!(debug_assertions) || option_env!("JUNE_ENABLE_PERSONA_RECOGNITION") == Some("1")
}
