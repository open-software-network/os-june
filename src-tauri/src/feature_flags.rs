/// Video kill switch. On now that video generation launches; keep in lockstep
/// with the frontend `VIDEO_GENERATION_ENABLED` in src/lib/feature-flags.ts.
pub const VIDEO_GENERATION_ENABLED: bool = true;

/// Browser use kill switch. Off until the Chrome Web Store item exists (the
/// manual 0.1.0 bootstrap in docs/release-extension.md): without a store
/// listing there is no extension for users to install, so every Browser use
/// surface stays hidden and the grant cannot be enabled. Keep in lockstep
/// with the frontend `BROWSER_USE_ENABLED` in src/lib/feature-flags.ts.
pub const BROWSER_USE_ENABLED: bool = false;
