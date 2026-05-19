pub mod generation;
pub mod mock;
pub mod transcription;

pub const OPENAI_PROVIDER: &str = "openai";
pub const MOCK_PROVIDER: &str = "mock";

pub fn configured_provider() -> String {
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
    std::env::var("OPENAI_API_KEY")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

pub fn openai_provider_configured() -> bool {
    openai_api_key().is_some()
}
