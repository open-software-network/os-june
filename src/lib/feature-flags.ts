// Kill switch from the RC hide (PR #555). On again now that JUN-171 closes the
// gaps that kept image generation out of the release: fast-path images enter
// the model's context, and generation/editing work as LLM tools.
export const IMAGE_GENERATION_ENABLED = true;

// Kill switch for the /video fast path and the agent video tools. On now that
// video generation launches; keep in lockstep with the Rust
// VIDEO_GENERATION_ENABLED in src-tauri/src/feature_flags.rs.
export const VIDEO_GENERATION_ENABLED = true;

// Kill switch for Browser use. Off until the Chrome Web Store item exists
// (the manual 0.1.0 bootstrap in docs/release-extension.md): without a store
// listing there is no extension to install, so the Connectors capability row,
// the routine opt-in, and the in-chat request card all stay hidden. Keep in
// lockstep with the Rust BROWSER_USE_ENABLED in src-tauri/src/feature_flags.rs.
export const BROWSER_USE_ENABLED = false;
