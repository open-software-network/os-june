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
    pub attestation: AttestationConfig,
    #[serde(default)]
    pub issue_reports: IssueReportsConfig,
    pub pricing: BTreeMap<String, ModelPriceConfig>,
}

impl Debug for AppConfig {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("AppConfig")
            .field("server", &self.server)
            .field("os_accounts", &self.os_accounts)
            .field("upstreams", &self.upstreams)
            .field("attestation", &self.attestation)
            .field("issue_reports", &self.issue_reports)
            .field("pricing", &self.pricing)
            .finish()
    }
}

/// Where user-submitted issue reports get forwarded. Every section is
/// optional: with os-platform configured, reports become Issues in the
/// tracker; else with a webhook, a JSON POST; else they land in the
/// structured logs only.
#[derive(Clone, Deserialize, Serialize)]
pub struct IssueReportsConfig {
    /// Receives each report as a JSON POST. Often embeds a secret token
    /// (Slack/Discord-style webhooks), hence the redacted Debug. Set via
    /// `SCRIBE__ISSUE_REPORTS__WEBHOOK_URL`.
    #[serde(default)]
    pub webhook_url: String,
    /// Base URL of the os-platform (fellow) API, e.g.
    /// `https://api.platform.opensoftware.co`. Empty disables the
    /// tracker sink. `SCRIBE__ISSUE_REPORTS__OS_PLATFORM_API_URL`.
    #[serde(default)]
    pub os_platform_api_url: String,
    /// fellow API key (`osk_…`) of the reporting bot user — that user
    /// must be a member of the target Org/Project. Redacted Debug.
    /// `SCRIBE__ISSUE_REPORTS__OS_PLATFORM_API_KEY`.
    #[serde(default)]
    pub os_platform_api_key: String,
    /// Target Org handle (or opaque `org_…` id).
    #[serde(default)]
    pub os_platform_org: String,
    /// Target Project handle (or opaque `prj_…` id).
    #[serde(default)]
    pub os_platform_project: String,
    /// Label slug attached to every report Issue.
    #[serde(default = "default_issue_report_label")]
    pub os_platform_label: String,
    /// Reward asset symbol for the zero-reward Issue (e.g. "POINTS").
    /// Issues are bounties under the hood, and creation fails when neither
    /// the Project nor the Org has a default reward asset — naming one here
    /// sidesteps that. Empty omits the field and relies on the defaults.
    #[serde(default)]
    pub os_platform_reward_asset: String,
}

fn default_issue_report_label() -> String {
    "bug".to_string()
}

impl Default for IssueReportsConfig {
    fn default() -> Self {
        Self {
            webhook_url: String::new(),
            os_platform_api_url: String::new(),
            os_platform_api_key: String::new(),
            os_platform_org: String::new(),
            os_platform_project: String::new(),
            os_platform_label: default_issue_report_label(),
            os_platform_reward_asset: String::new(),
        }
    }
}

impl Debug for IssueReportsConfig {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("IssueReportsConfig")
            .field(
                "webhook_url",
                if self.webhook_url.is_empty() {
                    &"<unset>"
                } else {
                    &REDACTED
                },
            )
            .field("os_platform_api_url", &self.os_platform_api_url)
            .field(
                "os_platform_api_key",
                if self.os_platform_api_key.is_empty() {
                    &"<unset>"
                } else {
                    &REDACTED
                },
            )
            .field("os_platform_org", &self.os_platform_org)
            .field("os_platform_project", &self.os_platform_project)
            .field("os_platform_label", &self.os_platform_label)
            .field("os_platform_reward_asset", &self.os_platform_reward_asset)
            .finish()
    }
}

/// Public facts the `/verify` attestation page reports. Nothing here is a
/// secret; all fields have working defaults so local builds need no setup.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct AttestationConfig {
    /// Full git commit the running image was built from. Stamped into the
    /// image env by the Docker build (`ARG GIT_SHA`); empty for local builds.
    #[serde(default)]
    pub source_commit: String,
    pub source_repo_url: String,
    pub image_repo: String,
    pub trust_center_url: String,
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
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub privacy: Option<String>,
    #[serde(default)]
    pub pricing: Option<serde_json::Value>,
    #[serde(default)]
    pub context_tokens: Option<i64>,
    #[serde(default)]
    pub traits: Vec<String>,
    #[serde(default)]
    pub capabilities: Vec<String>,
}

#[derive(Clone, Copy)]
struct TextModelFallback {
    id: &'static str,
    display_name: &'static str,
    input_credits_per_million_tokens: u64,
    output_credits_per_million_tokens: u64,
    context_tokens: i64,
    capabilities: &'static [&'static str],
}

/// Built-in pricing fallback, used only when the live Venice catalog can't be
/// reached at startup so metered charges still settle. The catalog carries the
/// authoritative numbers and extends over this on every boot. Split out of
/// `AppConfig::default` to keep that constructor under the line limit.
fn default_pricing() -> BTreeMap<String, ModelPriceConfig> {
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
            description: Some("Fast OpenAI speech-to-text model.".to_string()),
            privacy: Some("anonymized".to_string()),
            pricing: Some(serde_json::json!({ "display": "$0.001/sec audio" })),
            context_tokens: Some(16_000),
            traits: vec!["prompt".to_string()],
            capabilities: Vec::new(),
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
            description: None,
            privacy: Some("private".to_string()),
            pricing: None,
            context_tokens: None,
            traits: Vec::new(),
            capabilities: Vec::new(),
        },
    );
    // Fallback pricing for the default and suggested text models, used only
    // when the live Venice catalog can't be reached at startup so metered
    // charges still settle. The live catalog (which carries the authoritative
    // numbers) extends over this on every boot. Keep the GLM 5.2 entry in sync
    // with DEFAULT_GENERATION_MODEL in the Tauri providers module.
    for model in [
        TextModelFallback {
            id: "zai-org-glm-5-2",
            display_name: "GLM 5.2",
            input_credits_per_million_tokens: 1_750,
            output_credits_per_million_tokens: 5_500,
            context_tokens: 200_000,
            capabilities: &[
                "supportsFunctionCalling",
                "supportsReasoning",
                "supportsReasoningEffort",
                "supportsResponseSchema",
                "supportsWebSearch",
            ],
        },
        TextModelFallback {
            id: "kimi-k2-6",
            display_name: "Kimi K2.6",
            input_credits_per_million_tokens: 850,
            output_credits_per_million_tokens: 4_660,
            context_tokens: 256_000,
            capabilities: &["supportsFunctionCalling"],
        },
        TextModelFallback {
            id: "zai-org-glm-5-1",
            display_name: "GLM 5.1",
            input_credits_per_million_tokens: 1_750,
            output_credits_per_million_tokens: 5_500,
            context_tokens: 200_000,
            capabilities: &[
                "supportsFunctionCalling",
                "supportsReasoning",
                "supportsReasoningEffort",
                "supportsResponseSchema",
                "supportsWebSearch",
            ],
        },
        TextModelFallback {
            id: "zai-org-glm-5",
            display_name: "GLM 5",
            input_credits_per_million_tokens: 1_000,
            output_credits_per_million_tokens: 3_200,
            context_tokens: 198_000,
            capabilities: &["supportsFunctionCalling"],
        },
    ] {
        pricing.insert(model.id.to_string(), text_model_config(model));
    }
    pricing
}

fn text_model_config(model: TextModelFallback) -> ModelPriceConfig {
    ModelPriceConfig {
        unit: PriceUnit::Tokens,
        credits_per_million_seconds: None,
        input_credits_per_million_tokens: Some(model.input_credits_per_million_tokens),
        output_credits_per_million_tokens: Some(model.output_credits_per_million_tokens),
        provider: ModelProvider::Venice,
        model_type: ModelType::Text,
        display_name: model.display_name.to_string(),
        description: None,
        privacy: Some("private".to_string()),
        pricing: None,
        context_tokens: Some(model.context_tokens),
        traits: Vec::new(),
        capabilities: model
            .capabilities
            .iter()
            .map(|capability| (*capability).to_string())
            .collect(),
    }
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            server: ServerConfig {
                host: "127.0.0.1".to_string(),
                port: 8080,
                request_timeout_secs: 600,
                max_audio_bytes: 26_214_400,
                max_json_bytes: 524_288,
            },
            os_accounts: OsAccountsConfig {
                api_url: String::new(),
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
            attestation: AttestationConfig {
                source_commit: String::new(),
                source_repo_url: "https://github.com/open-software-network/os-scribe".to_string(),
                image_repo: "ghcr.io/open-software-network/scribe-api".to_string(),
                trust_center_url:
                    "https://trust.phala.com/app/15f8d2fd586da8b99c6082b3c2cba64127ceeb8c"
                        .to_string(),
            },
            issue_reports: IssueReportsConfig::default(),
            pricing: default_pricing(),
        }
    }
}

#[derive(Debug, Error)]
pub enum ConfigError {
    #[error(transparent)]
    Figment(#[from] Box<figment::Error>),
    #[error("missing required config `{field}`")]
    MissingRequired { field: &'static str },
    #[error("invalid required config `{field}`: {reason}")]
    InvalidRequired {
        field: &'static str,
        reason: &'static str,
    },
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
    validate_required_text("os_accounts.api_url", &config.os_accounts.api_url)?;
    validate_required_secret(
        "os_accounts.app_api_key",
        &config.os_accounts.app_api_key,
        "osk_REPLACE_ME",
    )?;

    let uses_openai = config
        .pricing
        .values()
        .any(|pricing| pricing.provider == ModelProvider::Openai);
    let uses_venice = config
        .pricing
        .values()
        .any(|pricing| pricing.provider == ModelProvider::Venice);
    if uses_openai {
        validate_required_text(
            "upstreams.openai.base_url",
            &config.upstreams.openai.base_url,
        )?;
        validate_required_secret(
            "upstreams.openai.api_key",
            &config.upstreams.openai.api_key,
            "sk_REPLACE_ME",
        )?;
    }
    if uses_venice {
        validate_required_text(
            "upstreams.venice.base_url",
            &config.upstreams.venice.base_url,
        )?;
        validate_required_secret(
            "upstreams.venice.api_key",
            &config.upstreams.venice.api_key,
            "VENICE_API_KEY_REPLACE_ME",
        )?;
    }

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

fn validate_required_text(field: &'static str, value: &str) -> Result<(), ConfigError> {
    if value.trim().is_empty() {
        return Err(ConfigError::MissingRequired { field });
    }
    Ok(())
}

fn validate_required_secret(
    field: &'static str,
    value: &str,
    placeholder: &'static str,
) -> Result<(), ConfigError> {
    validate_required_text(field, value)?;
    if value.trim() == placeholder {
        return Err(ConfigError::InvalidRequired {
            field,
            reason: "placeholder value must be replaced",
        });
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

    fn valid_config() -> AppConfig {
        let mut config = AppConfig::default();
        config.os_accounts.api_url = "http://127.0.0.1:3000".to_string();
        config.os_accounts.app_api_key = "osk_test".to_string();
        config.upstreams.openai.api_key = "sk-test".to_string();
        config.upstreams.venice.api_key = "venice-test".to_string();
        config
    }

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
                description: None,
                privacy: None,
                pricing: None,
                context_tokens: None,
                traits: Vec::new(),
                capabilities: Vec::new(),
            },
        );
        let config = AppConfig {
            pricing,
            ..valid_config()
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
                description: None,
                privacy: None,
                pricing: None,
                context_tokens: None,
                traits: Vec::new(),
                capabilities: Vec::new(),
            },
        );
        let config = AppConfig {
            pricing,
            ..valid_config()
        };

        let result = validate(&config);

        assert!(result.is_err());
    }

    #[test]
    fn validate_passes_for_complete_config() {
        assert_eq!(validate(&valid_config()).is_ok(), true);
    }

    #[test]
    fn validate_rejects_missing_os_accounts_key() {
        let mut config = valid_config();
        config.os_accounts.app_api_key = String::new();

        let result = validate(&config);

        assert!(result.is_err());
    }

    #[test]
    fn validate_rejects_provider_placeholder_key() {
        let mut config = valid_config();
        config.upstreams.venice.api_key = "VENICE_API_KEY_REPLACE_ME".to_string();

        let result = validate(&config);

        assert!(result.is_err());
    }
}
