use figment::{
    Figment,
    providers::{Env, Format, Serialized, Toml},
};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fmt::{self, Debug},
};
use thiserror::Error;

const REDACTED: &str = "<redacted>";

#[derive(Clone, Deserialize, Serialize)]
pub struct AppConfig {
    pub server: ServerConfig,
    pub os_accounts: OsAccountsConfig,
    pub upstreams: UpstreamsConfig,
    pub pricing: BTreeMap<String, ModelPriceConfig>,
}

impl Debug for AppConfig {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("AppConfig")
            .field("server", &self.server)
            .field("os_accounts", &self.os_accounts)
            .field("upstreams", &self.upstreams)
            .field("pricing", &self.pricing)
            .finish()
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ServerConfig {
    pub host: String,
    pub port: u16,
    pub request_timeout_secs: u64,
    pub max_audio_bytes: usize,
    pub max_json_bytes: usize,
}

#[derive(Clone, Deserialize, Serialize)]
pub struct OsAccountsConfig {
    pub api_url: String,
    pub app_api_key: String,
    pub iss: String,
    pub aud: String,
    pub jwks_refresh_secs: u64,
    pub jwks_miss_min_backoff_secs: u64,
    pub authorize_hold_ttl_note_transcribe_secs: u64,
    pub authorize_hold_ttl_note_generate_secs: u64,
    pub authorize_hold_ttl_dictate_transcribe_secs: u64,
    pub authorize_hold_ttl_dictate_cleanup_secs: u64,
    /// Skip per-request estimation entirely and authorize this many credits
    /// for every metered action. Trades a bigger Hold (and thus a tighter
    /// max concurrency per user) for not needing to probe audio duration or
    /// pre-count tokens. Set via `SCRIBE__OS_ACCOUNTS__FLAT_ESTIMATE_CREDITS`.
    pub flat_estimate_credits: u64,
}

impl Debug for OsAccountsConfig {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("OsAccountsConfig")
            .field("api_url", &self.api_url)
            .field("app_api_key", &REDACTED)
            .field("iss", &self.iss)
            .field("aud", &self.aud)
            .field("jwks_refresh_secs", &self.jwks_refresh_secs)
            .field(
                "jwks_miss_min_backoff_secs",
                &self.jwks_miss_min_backoff_secs,
            )
            .field(
                "authorize_hold_ttl_note_transcribe_secs",
                &self.authorize_hold_ttl_note_transcribe_secs,
            )
            .field(
                "authorize_hold_ttl_note_generate_secs",
                &self.authorize_hold_ttl_note_generate_secs,
            )
            .field(
                "authorize_hold_ttl_dictate_transcribe_secs",
                &self.authorize_hold_ttl_dictate_transcribe_secs,
            )
            .field(
                "authorize_hold_ttl_dictate_cleanup_secs",
                &self.authorize_hold_ttl_dictate_cleanup_secs,
            )
            .field("flat_estimate_credits", &self.flat_estimate_credits)
            .finish()
    }
}

#[derive(Clone, Deserialize, Serialize)]
pub struct UpstreamsConfig {
    pub openai: UpstreamConfig,
    pub venice: UpstreamConfig,
}

impl Debug for UpstreamsConfig {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("UpstreamsConfig")
            .field("openai", &self.openai)
            .field("venice", &self.venice)
            .finish()
    }
}

#[derive(Clone, Deserialize, Serialize)]
pub struct UpstreamConfig {
    #[serde(default)]
    pub api_key: String,
    pub base_url: String,
}

impl Debug for UpstreamConfig {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("UpstreamConfig")
            .field("api_key", &REDACTED)
            .field("base_url", &self.base_url)
            .finish()
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ModelProvider {
    Openai,
    Venice,
}

impl ModelProvider {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Openai => "openai",
            Self::Venice => "venice",
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ModelType {
    Asr,
    Text,
}

impl ModelType {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Asr => "asr",
            Self::Text => "text",
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PriceUnit {
    Seconds,
    Tokens,
}

impl PriceUnit {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Seconds => "seconds",
            Self::Tokens => "tokens",
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ModelPriceConfig {
    pub unit: PriceUnit,
    #[serde(default)]
    pub credits_per_million_seconds: Option<u64>,
    #[serde(default)]
    pub input_credits_per_million_tokens: Option<u64>,
    #[serde(default)]
    pub output_credits_per_million_tokens: Option<u64>,
    pub provider: ModelProvider,
    pub model_type: ModelType,
    pub display_name: String,
}

impl Default for AppConfig {
    fn default() -> Self {
        let mut pricing = BTreeMap::new();
        pricing.insert(
            "gpt-4o-mini-transcribe".to_string(),
            ModelPriceConfig {
                unit: PriceUnit::Seconds,
                credits_per_million_seconds: Some(1_000_000),
                input_credits_per_million_tokens: None,
                output_credits_per_million_tokens: None,
                provider: ModelProvider::Openai,
                model_type: ModelType::Asr,
                display_name: "GPT-4o mini transcribe".to_string(),
            },
        );
        pricing.insert(
            "nvidia/parakeet-tdt-0.6b-v3".to_string(),
            ModelPriceConfig {
                unit: PriceUnit::Seconds,
                credits_per_million_seconds: Some(100_000),
                input_credits_per_million_tokens: None,
                output_credits_per_million_tokens: None,
                provider: ModelProvider::Venice,
                model_type: ModelType::Asr,
                display_name: "Parakeet TDT 0.6B v3".to_string(),
            },
        );
        pricing.insert(
            "zai-org-glm-5".to_string(),
            ModelPriceConfig {
                unit: PriceUnit::Tokens,
                credits_per_million_seconds: None,
                input_credits_per_million_tokens: Some(1_000),
                output_credits_per_million_tokens: Some(3_200),
                provider: ModelProvider::Venice,
                model_type: ModelType::Text,
                display_name: "GLM 5".to_string(),
            },
        );
        Self {
            server: ServerConfig {
                host: "127.0.0.1".to_string(),
                port: 8080,
                request_timeout_secs: 30,
                max_audio_bytes: 26_214_400,
                max_json_bytes: 524_288,
            },
            os_accounts: OsAccountsConfig {
                api_url: "http://127.0.0.1:3000".to_string(),
                app_api_key: String::new(),
                iss: "os-accounts-dev".to_string(),
                aud: "scribe-api-dev".to_string(),
                jwks_refresh_secs: 300,
                jwks_miss_min_backoff_secs: 5,
                authorize_hold_ttl_note_transcribe_secs: 60,
                authorize_hold_ttl_note_generate_secs: 300,
                authorize_hold_ttl_dictate_transcribe_secs: 30,
                authorize_hold_ttl_dictate_cleanup_secs: 30,
                flat_estimate_credits: 250,
            },
            upstreams: UpstreamsConfig {
                openai: UpstreamConfig {
                    api_key: String::new(),
                    base_url: "https://api.openai.com/v1".to_string(),
                },
                venice: UpstreamConfig {
                    api_key: String::new(),
                    base_url: "https://api.venice.ai/api/v1".to_string(),
                },
            },
            pricing,
        }
    }
}

#[derive(Debug, Error)]
pub enum ConfigError {
    #[error(transparent)]
    Figment(#[from] Box<figment::Error>),
    #[error("invalid pricing for model `{model}`: {reason}")]
    InvalidPricing { model: String, reason: String },
}

pub fn load() -> Result<AppConfig, ConfigError> {
    let config: AppConfig = Figment::new()
        .merge(Serialized::defaults(AppConfig::default()))
        .merge(Toml::file("config.toml"))
        .merge(Env::prefixed("SCRIBE__").split("__"))
        .extract()
        .map_err(Box::new)
        .map_err(ConfigError::from)?;
    validate(&config)?;
    Ok(config)
}

fn validate(config: &AppConfig) -> Result<(), ConfigError> {
    for (model_id, pricing) in &config.pricing {
        let expected_unit = match pricing.model_type {
            ModelType::Asr => PriceUnit::Seconds,
            ModelType::Text => PriceUnit::Tokens,
        };
        if pricing.unit != expected_unit {
            return Err(ConfigError::InvalidPricing {
                model: model_id.clone(),
                reason: format!(
                    "model_type `{}` requires unit `{}`, got `{}`",
                    pricing.model_type.as_str(),
                    expected_unit.as_str(),
                    pricing.unit.as_str()
                ),
            });
        }
        match pricing.model_type {
            ModelType::Asr => {
                validate_positive_rate(
                    model_id,
                    pricing.credits_per_million_seconds,
                    "credits_per_million_seconds",
                )?;
            }
            ModelType::Text => {
                validate_positive_rate(
                    model_id,
                    pricing.input_credits_per_million_tokens,
                    "input_credits_per_million_tokens",
                )?;
                validate_positive_rate(
                    model_id,
                    pricing.output_credits_per_million_tokens,
                    "output_credits_per_million_tokens",
                )?;
            }
        }
    }
    Ok(())
}

fn validate_positive_rate(
    model_id: &str,
    value: Option<u64>,
    field: &str,
) -> Result<(), ConfigError> {
    match value {
        Some(value) if value > 0 => Ok(()),
        _ => Err(ConfigError::InvalidPricing {
            model: model_id.to_string(),
            reason: format!("{field} must be > 0"),
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::{AppConfig, ModelPriceConfig, ModelProvider, ModelType, PriceUnit, validate};
    use pretty_assertions::assert_eq;
    use std::collections::BTreeMap;

    #[test]
    fn config_debug_redacts_secrets() {
        let mut config = AppConfig::default();
        config.os_accounts.app_api_key = "osk_secret_value".to_string();
        config.upstreams.openai.api_key = "sk-secret".to_string();
        config.upstreams.venice.api_key = "vc-secret".to_string();
        let dump = format!("{config:?}");
        assert!(
            !dump.contains("osk_secret_value"),
            "app_api_key leaked in Debug: {dump}"
        );
        assert!(!dump.contains("sk-secret"));
        assert!(!dump.contains("vc-secret"));
        assert!(dump.contains("<redacted>"));
    }

    #[test]
    fn validate_rejects_asr_model_with_token_unit() {
        let mut pricing = BTreeMap::new();
        pricing.insert(
            "bad-asr".to_string(),
            ModelPriceConfig {
                unit: PriceUnit::Tokens,
                credits_per_million_seconds: None,
                input_credits_per_million_tokens: Some(1),
                output_credits_per_million_tokens: Some(1),
                provider: ModelProvider::Venice,
                model_type: ModelType::Asr,
                display_name: "bad".to_string(),
            },
        );
        let config = AppConfig {
            pricing,
            ..AppConfig::default()
        };

        let result = validate(&config);

        assert!(result.is_err(), "expected validation error");
    }

    #[test]
    fn validate_rejects_zero_rate() {
        let mut pricing = BTreeMap::new();
        pricing.insert(
            "free-asr".to_string(),
            ModelPriceConfig {
                unit: PriceUnit::Seconds,
                credits_per_million_seconds: Some(0),
                input_credits_per_million_tokens: None,
                output_credits_per_million_tokens: None,
                provider: ModelProvider::Openai,
                model_type: ModelType::Asr,
                display_name: "free".to_string(),
            },
        );
        let config = AppConfig {
            pricing,
            ..AppConfig::default()
        };

        let result = validate(&config);

        assert!(result.is_err());
    }

    #[test]
    fn validate_passes_for_default() {
        assert_eq!(validate(&AppConfig::default()).is_ok(), true);
    }
}
