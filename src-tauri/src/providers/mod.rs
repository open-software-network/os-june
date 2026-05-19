pub mod generation;
pub mod mock;
pub mod transcription;

use std::{
    path::{Path, PathBuf},
    sync::OnceLock,
};

pub const OPENAI_PROVIDER: &str = "openai";
pub const MOCK_PROVIDER: &str = "mock";

static ENV_LOADED: OnceLock<()> = OnceLock::new();

pub fn configured_provider() -> String {
    load_local_env();
    let requested = std::env::var("OS_NOTETAKER_PROVIDER")
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    if requested == MOCK_PROVIDER || requested == OPENAI_PROVIDER {
        return requested;
    }
    if openai_api_key().is_some() {
        OPENAI_PROVIDER.to_string()
    } else {
        MOCK_PROVIDER.to_string()
    }
}

pub fn openai_api_key() -> Option<String> {
    load_local_env();
    std::env::var("OPENAI_API_KEY")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

pub fn openai_provider_configured() -> bool {
    openai_api_key().is_some()
}

pub fn load_local_env() {
    ENV_LOADED.get_or_init(|| {
        for candidate in env_candidates() {
            if candidate.exists() {
                let _ = dotenvy::from_path(&candidate);
                break;
            }
        }
    });
}

fn env_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Ok(current_dir) = std::env::current_dir() {
        push_env_candidate(&mut candidates, &current_dir);
        if let Some(parent) = current_dir.parent() {
            push_env_candidate(&mut candidates, parent);
        }
    }
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    push_env_candidate(&mut candidates, &manifest_dir);
    if let Some(parent) = manifest_dir.parent() {
        push_env_candidate(&mut candidates, parent);
    }
    candidates
}

fn push_env_candidate(candidates: &mut Vec<PathBuf>, dir: &Path) {
    let candidate = dir.join(".env");
    if !candidates.contains(&candidate) {
        candidates.push(candidate);
    }
}
