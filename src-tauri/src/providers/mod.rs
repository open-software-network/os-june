pub mod generation;
pub mod mock;
pub mod transcription;

use std::{
    path::{Path, PathBuf},
    sync::OnceLock,
};

pub const OPENAI_PROVIDER: &str = "openai";
pub const VENICE_PROVIDER: &str = "venice";
pub const MOCK_PROVIDER: &str = "mock";
pub const DEFAULT_VENICE_API_BASE_URL: &str = "https://api.venice.ai/api/v1";

static ENV_LOADED: OnceLock<()> = OnceLock::new();

pub fn configured_provider() -> String {
    load_local_env();
    let requested = std::env::var("OS_NOTETAKER_PROVIDER")
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    if is_supported_provider(&requested) {
        return requested;
    }
    if openai_api_key().is_some() {
        OPENAI_PROVIDER.to_string()
    } else if venice_api_key().is_some() {
        VENICE_PROVIDER.to_string()
    } else {
        MOCK_PROVIDER.to_string()
    }
}

fn is_supported_provider(provider: &str) -> bool {
    matches!(provider, MOCK_PROVIDER | OPENAI_PROVIDER | VENICE_PROVIDER)
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

pub fn venice_api_key() -> Option<String> {
    load_local_env();
    std::env::var("VENICE_API_KEY")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

pub fn provider_configured() -> bool {
    match configured_provider().as_str() {
        OPENAI_PROVIDER => openai_api_key().is_some(),
        VENICE_PROVIDER => venice_api_key().is_some(),
        _ => false,
    }
}

pub fn venice_api_base_url() -> String {
    load_local_env();
    std::env::var("VENICE_API_BASE_URL")
        .ok()
        .map(|value| value.trim().trim_end_matches('/').to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| DEFAULT_VENICE_API_BASE_URL.to_string())
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

#[cfg(test)]
mod tests {
    use super::{is_supported_provider, MOCK_PROVIDER, OPENAI_PROVIDER, VENICE_PROVIDER};

    #[test]
    fn venice_is_a_supported_provider() {
        assert!(is_supported_provider(MOCK_PROVIDER));
        assert!(is_supported_provider(OPENAI_PROVIDER));
        assert!(is_supported_provider(VENICE_PROVIDER));
        assert!(!is_supported_provider("unknown"));
    }
}
