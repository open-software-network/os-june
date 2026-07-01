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
use url::Url;

const REDACTED: &str = "<redacted>";
pub const LOCAL_DEV_BEARER_TOKEN_PLACEHOLDER: &str = "local-dev-token";
pub const OPENAI_API_KEY_PLACEHOLDER: &str = "sk_REPLACE_ME";
pub const VENICE_API_KEY_PLACEHOLDER: &str = "VENICE_API_KEY_REPLACE_ME";

#[derive(Clone, Deserialize, Serialize)]
pub struct AppConfig {
    pub server: ServerConfig,
    #[serde(default)]
    pub local_dev: LocalDevConfig,
    pub os_accounts: OsAccountsConfig,
    pub upstreams: UpstreamsConfig,
    pub attestation: AttestationConfig,
    #[serde(default)]
    pub issue_reports: IssueReportsConfig,
    pub pricing: BTreeMap<String, ModelPriceConfig>,
    /// Flat credits charged per generated image, keyed by image model id. Kept
    /// separate from `pricing` (the text/ASR catalog) so image models never leak
    /// into the served model pickers. A model absent here is rejected at the
    /// `/image/generate` boundary (`model_not_priced`), so the settings picker
    /// must only offer models listed here. `$1 = 1000 credits`; values are the
    /// Venice per-image cost with margin (e.g. SD3.5 costs about $0.01,
    /// charged 20).
    #[serde(default = "default_image_pricing")]
    pub image_pricing: BTreeMap<String, u64>,
}

impl Debug for AppConfig {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("AppConfig")
            .field("server", &self.server)
            .field("local_dev", &self.local_dev)
            .field("os_accounts", &self.os_accounts)
            .field("upstreams", &self.upstreams)
            .field("attestation", &self.attestation)
            .field("issue_reports", &self.issue_reports)
            .field("pricing", &self.pricing)
            .field("image_pricing", &self.image_pricing)
            .finish()
    }
}

/// Where user-submitted issue reports get forwarded. The destination defaults
/// to the June bug reports project in os-platform; only the bot API key is
/// environment specific. Without that key, reports land in structured logs only.
#[derive(Clone, Deserialize, Serialize)]
pub struct IssueReportsConfig {
    /// Base URL of the os-platform (fellow) API.
    #[serde(default = "default_issue_report_api_url")]
    pub os_platform_api_url: String,
    /// os-platform API key of the reporting bot user — that user
    /// must be a member of the target Org/Project. Redacted Debug.
    /// `JUNE__ISSUE_REPORTS__OS_PLATFORM_API_KEY`.
    #[serde(default)]
    pub os_platform_api_key: String,
    /// Target Org handle (or opaque `org_…` id).
    #[serde(default = "default_issue_report_org")]
    pub os_platform_org: String,
    /// Target Project handle (or opaque `prj_…` id).
    #[serde(default = "default_issue_report_project")]
    pub os_platform_project: String,
    /// Label slug attached to every report Issue.
    #[serde(default = "default_issue_report_label")]
    pub os_platform_label: String,
    /// Reward asset symbol for the zero-reward Issue (e.g. "POINTS").
    /// Issues are bounties under the hood, and creation fails when neither
    /// the Project nor the Org has a default reward asset — naming one here
    /// sidesteps that. Empty omits the field and relies on the defaults.
    #[serde(default = "default_issue_report_reward_asset")]
    pub os_platform_reward_asset: String,
}

fn default_issue_report_api_url() -> String {
    "https://app.opensoftware.co/api".to_string()
}

fn default_issue_report_org() -> String {
    "june".to_string()
}

fn default_issue_report_project() -> String {
    "bug-reports".to_string()
}

fn default_issue_report_label() -> String {
    "bug".to_string()
}

fn default_issue_report_reward_asset() -> String {
    "POINTS".to_string()
}

impl Default for IssueReportsConfig {
    fn default() -> Self {
        Self {
            os_platform_api_url: default_issue_report_api_url(),
            os_platform_api_key: String::new(),
            os_platform_org: default_issue_report_org(),
            os_platform_project: default_issue_report_project(),
            os_platform_label: default_issue_report_label(),
            os_platform_reward_asset: default_issue_report_reward_asset(),
        }
    }
}

impl Debug for IssueReportsConfig {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("IssueReportsConfig")
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
pub struct LocalDevConfig {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default = "default_local_dev_bearer_token")]
    pub bearer_token: String,
    #[serde(default = "default_local_dev_user_id")]
    pub user_id: String,
}

fn default_local_dev_bearer_token() -> String {
    LOCAL_DEV_BEARER_TOKEN_PLACEHOLDER.to_string()
}

fn default_local_dev_user_id() -> String {
    "usr_local_dev".to_string()
}

impl Default for LocalDevConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            bearer_token: default_local_dev_bearer_token(),
            user_id: default_local_dev_user_id(),
        }
    }
}

impl Debug for LocalDevConfig {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("LocalDevConfig")
            .field("enabled", &self.enabled)
            .field(
                "bearer_token",
                if self.bearer_token.is_empty() {
                    &"<unset>"
                } else {
                    &REDACTED
                },
            )
            .field("user_id", &self.user_id)
            .finish()
    }
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
    /// Maximum audio duration accepted by no-charge live preview requests.
    /// Desktop chunks are shorter; this server cap prevents arbitrary-length
    /// preview transcription if a client replays the public endpoint.
    pub note_transcribe_preview_max_audio_secs: u64,
    /// Skip per-request estimation entirely and authorize this many credits
    /// for every metered action. Trades a bigger Hold (and thus a tighter
    /// max concurrency per user) for not needing to probe audio duration or
    /// pre-count tokens. Set via `JUNE__OS_ACCOUNTS__FLAT_ESTIMATE_CREDITS`.
    pub flat_estimate_credits: u64,
    /// Flat credits charged per Venice web search (`/v1/web/search`). Venice
    /// bills roughly $0.01 (about 10 credits) per request; the surplus covers
    /// overhead. The authorize estimate and the settled charge are both this
    /// amount, since the upstream call is flat priced.
    pub web_search_credits: u64,
    /// Flat credits charged per Venice web fetch (`/v1/web/fetch`). Same ~$0.01
    /// upstream cost as search.
    pub web_fetch_credits: u64,
    /// Hold TTL for the metered web search and web fetch actions.
    pub authorize_hold_ttl_web_secs: u64,
    /// Hold TTL for the metered image generation action.
    pub authorize_hold_ttl_image_secs: u64,
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
            .field(
                "note_transcribe_preview_max_audio_secs",
                &self.note_transcribe_preview_max_audio_secs,
            )
            .field("flat_estimate_credits", &self.flat_estimate_credits)
            .field("web_search_credits", &self.web_search_credits)
            .field("web_fetch_credits", &self.web_fetch_credits)
            .field(
                "authorize_hold_ttl_web_secs",
                &self.authorize_hold_ttl_web_secs,
            )
            .field(
                "authorize_hold_ttl_image_secs",
                &self.authorize_hold_ttl_image_secs,
            )
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
///
/// Usage credit prices include June's 1.25x retail multiplier over upstream
/// cost. `$1 = 1000 credits`.
fn default_pricing() -> BTreeMap<String, ModelPriceConfig> {
    let mut pricing = BTreeMap::new();
    pricing.insert(
        "gpt-4o-mini-transcribe".to_string(),
        ModelPriceConfig {
            unit: PriceUnit::Seconds,
            credits_per_million_seconds: Some(1_250_000),
            input_credits_per_million_tokens: None,
            output_credits_per_million_tokens: None,
            provider: ModelProvider::Openai,
            model_type: ModelType::Asr,
            display_name: "GPT-4o mini transcribe".to_string(),
            description: Some("Fast OpenAI speech-to-text model.".to_string()),
            privacy: Some("anonymized".to_string()),
            pricing: Some(serde_json::json!({ "display": "$0.00125/sec audio" })),
            context_tokens: Some(16_000),
            traits: vec!["prompt".to_string()],
            capabilities: Vec::new(),
        },
    );
    pricing.insert(
        "nvidia/parakeet-tdt-0.6b-v3".to_string(),
        ModelPriceConfig {
            unit: PriceUnit::Seconds,
            credits_per_million_seconds: Some(125_000),
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
            input_credits_per_million_tokens: 2_188,
            output_credits_per_million_tokens: 6_875,
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
            input_credits_per_million_tokens: 1_063,
            output_credits_per_million_tokens: 5_825,
            context_tokens: 256_000,
            // Kimi K2.6 is natively multimodal (Venice `supportsVision`), so it
            // is the image-input fallback the frontend switches to when an image
            // is attached to a non-vision model. Declare vision here too so that
            // fallback still resolves when the live Venice catalog can't be
            // reached at boot and only these built-in defaults are available.
            capabilities: &[
                "supportsFunctionCalling",
                "supportsVision",
                "supportsMultipleImages",
            ],
        },
        TextModelFallback {
            id: "zai-org-glm-5-1",
            display_name: "GLM 5.1",
            input_credits_per_million_tokens: 2_188,
            output_credits_per_million_tokens: 6_875,
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
            input_credits_per_million_tokens: 1_250,
            output_credits_per_million_tokens: 4_000,
            context_tokens: 198_000,
            capabilities: &["supportsFunctionCalling"],
        },
    ] {
        pricing.insert(model.id.to_string(), text_model_config(model));
    }
    pricing
}

/// Per-image credit price for the curated Venice image models June offers. Keep
/// the ids in sync with `IMAGE_MODELS` in the frontend (`src/lib/image-models.ts`)
/// and `DEFAULT_IMAGE_MODEL` in the Tauri providers module — every id here must
/// be a current Venice image model (verified against the models list), or
/// generation fails `image_generation_rejected`. Values are the Venice per-image
/// cost with a ~2x margin (mirroring the flat web-tool pricing): SD3.5 ~$0.01 ->
/// 20, Chroma ~$0.01 -> 20, Qwen Image ~$0.03 -> 60, FLUX 2 Pro ~$0.03 -> 60.
/// `$1 = 1000 credits`.
fn default_image_pricing() -> BTreeMap<String, u64> {
    BTreeMap::from([
        ("venice-sd35".to_string(), 20),
        ("flux-2-pro".to_string(), 60),
        ("qwen-image".to_string(), 60),
        ("chroma".to_string(), 20),
    ])
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
            local_dev: LocalDevConfig::default(),
            os_accounts: OsAccountsConfig {
                api_url: String::new(),
                app_api_key: String::new(),
                iss: "os-accounts-dev".to_string(),
                aud: "june-api-dev".to_string(),
                jwks_refresh_secs: 300,
                jwks_miss_min_backoff_secs: 5,
                authorize_hold_ttl_note_transcribe_secs: 60,
                authorize_hold_ttl_note_generate_secs: 300,
                authorize_hold_ttl_dictate_transcribe_secs: 30,
                authorize_hold_ttl_dictate_cleanup_secs: 30,
                note_transcribe_preview_max_audio_secs: 30,
                flat_estimate_credits: 250,
                web_search_credits: 20,
                web_fetch_credits: 20,
                authorize_hold_ttl_web_secs: 30,
                authorize_hold_ttl_image_secs: 60,
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
                source_repo_url: "https://github.com/open-software-network/os-june".to_string(),
                image_repo: "ghcr.io/open-software-network/june-api".to_string(),
                trust_center_url:
                    "https://trust.phala.com/app/6514acb0e08dc4825e2b6e22a46f0ed0ff455b54"
                        .to_string(),
            },
            issue_reports: IssueReportsConfig::default(),
            pricing: default_pricing(),
            image_pricing: default_image_pricing(),
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
        .merge(Env::prefixed("JUNE__").split("__"))
        .extract()
        .map_err(Box::new)
        .map_err(ConfigError::from)?;
    validate(&config)?;
    Ok(config)
}

const LEGACY_OS_ACCOUNTS_APP_API_KEY_PLACEHOLDER: &str = concat!("osk", "_REPLACE_ME");
const LEGACY_OPENAI_API_KEY_PLACEHOLDER: &str = concat!("sk", "_REPLACE_ME");
const OS_ACCOUNTS_APP_API_KEY_PLACEHOLDERS: &[&str] = &[
    "REPLACE_WITH_OS_ACCOUNTS_APP_API_KEY",
    LEGACY_OS_ACCOUNTS_APP_API_KEY_PLACEHOLDER,
];
const OPENAI_API_KEY_PLACEHOLDERS: &[&str] = &[
    "REPLACE_WITH_OPENAI_API_KEY",
    LEGACY_OPENAI_API_KEY_PLACEHOLDER,
];
const VENICE_API_KEY_PLACEHOLDERS: &[&str] = &["VENICE_API_KEY_REPLACE_ME"];
const LOCAL_DEV_BEARER_TOKEN_PLACEHOLDERS: &[&str] = &[LOCAL_DEV_BEARER_TOKEN_PLACEHOLDER];

fn validate(config: &AppConfig) -> Result<(), ConfigError> {
    if config.local_dev.enabled {
        validate_local_dev_bearer_token(config)?;
        validate_required_text("local_dev.user_id", &config.local_dev.user_id)?;
        if !config.local_dev.user_id.starts_with("usr_") {
            return Err(ConfigError::InvalidRequired {
                field: "local_dev.user_id",
                reason: "must start with usr_",
            });
        }
    } else {
        validate_absolute_http_url("os_accounts.api_url", &config.os_accounts.api_url)?;
        validate_required_secret(
            "os_accounts.app_api_key",
            &config.os_accounts.app_api_key,
            OS_ACCOUNTS_APP_API_KEY_PLACEHOLDERS,
        )?;
    }
    validate_positive_config(
        "os_accounts.note_transcribe_preview_max_audio_secs",
        config.os_accounts.note_transcribe_preview_max_audio_secs,
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
        if !config.local_dev.enabled {
            validate_required_secret(
                "upstreams.openai.api_key",
                &config.upstreams.openai.api_key,
                OPENAI_API_KEY_PLACEHOLDERS,
            )?;
        }
    }
    if uses_venice {
        validate_required_text(
            "upstreams.venice.base_url",
            &config.upstreams.venice.base_url,
        )?;
        if !config.local_dev.enabled {
            validate_required_secret(
                "upstreams.venice.api_key",
                &config.upstreams.venice.api_key,
                VENICE_API_KEY_PLACEHOLDERS,
            )?;
        }
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
    validate_image_pricing(config)?;
    Ok(())
}

/// A zero per-image price would silently generate for free — reject it like the
/// per-model rate validation so a misconfigured price fails fast.
fn validate_image_pricing(config: &AppConfig) -> Result<(), ConfigError> {
    for (model_id, credits) in &config.image_pricing {
        if *credits == 0 {
            return Err(ConfigError::InvalidPricing {
                model: model_id.clone(),
                reason: "credits_per_image must be > 0".to_string(),
            });
        }
    }
    Ok(())
}

fn validate_local_dev_bearer_token(config: &AppConfig) -> Result<(), ConfigError> {
    if is_loopback_host(&config.server.host) {
        validate_required_text("local_dev.bearer_token", &config.local_dev.bearer_token)
    } else {
        validate_required_secret(
            "local_dev.bearer_token",
            &config.local_dev.bearer_token,
            LOCAL_DEV_BEARER_TOKEN_PLACEHOLDERS,
        )
    }
}

fn is_loopback_host(host: &str) -> bool {
    matches!(host.trim(), "127.0.0.1" | "localhost" | "::1")
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
    placeholders: &[&str],
) -> Result<(), ConfigError> {
    validate_required_text(field, value)?;
    if placeholders
        .iter()
        .any(|placeholder| value.trim() == *placeholder)
    {
        return Err(ConfigError::InvalidRequired {
            field,
            reason: "placeholder value must be replaced",
        });
    }
    Ok(())
}

fn validate_absolute_http_url(field: &'static str, value: &str) -> Result<(), ConfigError> {
    validate_required_text(field, value)?;
    let parsed = Url::parse(value.trim()).map_err(|_| ConfigError::InvalidRequired {
        field,
        reason: "must be an absolute http or https URL",
    })?;
    if matches!(parsed.scheme(), "http" | "https") && parsed.has_host() {
        return Ok(());
    }
    Err(ConfigError::InvalidRequired {
        field,
        reason: "must be an absolute http or https URL",
    })
}

fn validate_positive_config(field: &'static str, value: u64) -> Result<(), ConfigError> {
    if value == 0 {
        return Err(ConfigError::InvalidRequired {
            field,
            reason: "must be > 0",
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
    use super::{
        AppConfig, ConfigError, ModelPriceConfig, ModelProvider, ModelType,
        OPENAI_API_KEY_PLACEHOLDERS, OS_ACCOUNTS_APP_API_KEY_PLACEHOLDERS, PriceUnit,
        VENICE_API_KEY_PLACEHOLDERS, validate,
    };
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

    fn packaged_config_toml() -> AppConfig {
        use figment::{
            Figment,
            providers::{Format, Serialized, Toml},
        };
        let toml_path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../config.toml");
        Figment::new()
            .merge(Serialized::defaults(AppConfig::default()))
            .merge(Toml::file(toml_path))
            .extract::<AppConfig>()
            .unwrap_or_default()
    }

    #[test]
    fn default_kimi_declares_vision_but_glm_does_not() {
        // Kimi K2.6 is the image-input fallback the app switches to, so it must
        // read as vision-capable even from these built-in defaults, before the
        // live Venice catalog loads (JUN-165). The non-vision GLM defaults must
        // not claim vision, or the fallback could land on one of them.
        let config = AppConfig::default();
        let declares_vision = |id: &str| {
            config
                .pricing
                .get(id)
                .is_some_and(|model| model.capabilities.iter().any(|c| c == "supportsVision"))
        };
        assert!(
            declares_vision("kimi-k2-6"),
            "kimi-k2-6 default capabilities should declare supportsVision"
        );
        assert!(
            config.pricing.contains_key("zai-org-glm-5-2"),
            "zai-org-glm-5-2 should be present in default pricing"
        );
        assert!(
            !declares_vision("zai-org-glm-5-2"),
            "GLM 5.2 default must not claim vision"
        );
    }

    #[test]
    fn packaged_config_toml_keeps_kimi_vision_in_sync() {
        // config.toml overrides default_pricing() via Figment and ships in the
        // Docker image, so it is what `/models` serves when the live Venice
        // catalog is unreachable. It must agree that Kimi is a vision model, or
        // the image-attach fallback breaks in the packaged build (JUN-165).
        let config = packaged_config_toml();
        // A TOML-only model proves config.toml actually merged, so a failed
        // load can't make the vision assertion below pass on the default alone.
        assert!(
            config
                .pricing
                .contains_key("nvidia-nemotron-3-nano-30b-a3b"),
            "packaged config.toml did not merge"
        );
        let kimi_declares_vision = config
            .pricing
            .get("kimi-k2-6")
            .is_some_and(|model| model.capabilities.iter().any(|c| c == "supportsVision"));
        assert!(
            kimi_declares_vision,
            "packaged config.toml must declare supportsVision for kimi-k2-6"
        );
    }

    #[test]
    fn packaged_config_toml_includes_usage_margin() {
        let config = packaged_config_toml();

        assert_eq!(
            config
                .pricing
                .get("gpt-4o-mini-transcribe")
                .and_then(|model| model.credits_per_million_seconds),
            Some(1_250_000)
        );
        assert_eq!(
            config
                .pricing
                .get("zai-org-glm-5-2")
                .and_then(|model| model.input_credits_per_million_tokens),
            Some(2_188)
        );
        assert_eq!(
            config
                .pricing
                .get("zai-org-glm-5-2")
                .and_then(|model| model.output_credits_per_million_tokens),
            Some(6_875)
        );
        assert_eq!(
            config
                .pricing
                .get("nvidia-nemotron-3-nano-30b-a3b")
                .and_then(|model| model.input_credits_per_million_tokens),
            Some(88)
        );
    }

    #[test]
    fn config_debug_redacts_secrets() {
        let mut config = AppConfig::default();
        config.os_accounts.app_api_key = "app_api_key_secret_value".to_string();
        config.local_dev.bearer_token = "local-secret-token".to_string();
        config.upstreams.openai.api_key = "sk-secret".to_string();
        config.upstreams.venice.api_key = "vc-secret".to_string();
        let dump = format!("{config:?}");
        assert!(
            !dump.contains("app_api_key_secret_value"),
            "app_api_key leaked in Debug: {dump}"
        );
        assert!(!dump.contains("local-secret-token"));
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
    fn validate_rejects_zero_preview_audio_cap() {
        let mut config = valid_config();
        config.os_accounts.note_transcribe_preview_max_audio_secs = 0;

        let result = validate(&config);

        assert!(result.is_err());
    }

    #[test]
    fn validate_rejects_zero_image_price() {
        // A zero per-image price would silently generate for free; reject it.
        let mut config = valid_config();
        config.image_pricing.insert("free-image".to_string(), 0);

        let result = validate(&config);

        assert!(result.is_err());
    }

    #[test]
    fn default_config_prices_the_curated_image_models() {
        let config = valid_config();
        for model in ["venice-sd35", "flux-2-pro", "qwen-image", "chroma"] {
            assert!(
                config.image_pricing.get(model).is_some_and(|c| *c > 0),
                "missing image price for {model}"
            );
        }
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
    fn validate_rejects_schemeless_os_accounts_api_url() {
        let mut config = valid_config();
        config.os_accounts.api_url = "accounts.opensoftware.co/api".to_string();

        let result = validate(&config);

        assert!(matches!(
            result,
            Err(ConfigError::InvalidRequired {
                field: "os_accounts.api_url",
                reason: "must be an absolute http or https URL"
            })
        ));
    }

    #[test]
    fn validate_rejects_os_accounts_placeholder_keys() {
        for placeholder in OS_ACCOUNTS_APP_API_KEY_PLACEHOLDERS {
            let mut config = valid_config();
            config.os_accounts.app_api_key = (*placeholder).to_string();

            let result = validate(&config);

            assert!(result.is_err(), "accepted placeholder: {placeholder}");
        }
    }

    #[test]
    fn validate_rejects_provider_placeholder_keys() {
        for placeholder in OPENAI_API_KEY_PLACEHOLDERS {
            let mut config = valid_config();
            config.upstreams.openai.api_key = (*placeholder).to_string();

            let result = validate(&config);

            assert!(result.is_err(), "accepted placeholder: {placeholder}");
        }
        for placeholder in VENICE_API_KEY_PLACEHOLDERS {
            let mut config = valid_config();
            config.upstreams.venice.api_key = (*placeholder).to_string();

            let result = validate(&config);

            assert!(result.is_err(), "accepted placeholder: {placeholder}");
        }
    }

    #[test]
    fn validate_local_dev_skips_os_accounts_requirements() {
        let mut config = AppConfig::default();
        config.local_dev.enabled = true;
        config.upstreams.venice.api_key = "venice-test".to_string();

        let result = validate(&config);

        assert!(result.is_ok());
    }

    #[test]
    fn validate_local_dev_allows_missing_provider_keys() {
        let mut config = AppConfig::default();
        config.local_dev.enabled = true;
        config.upstreams.openai.api_key = String::new();
        config.upstreams.venice.api_key = "VENICE_API_KEY_REPLACE_ME".to_string();

        let result = validate(&config);

        assert!(result.is_ok());
    }

    #[test]
    fn validate_local_dev_rejects_blank_bearer_token() {
        let mut config = AppConfig::default();
        config.local_dev.enabled = true;
        config.local_dev.bearer_token = "  ".to_string();

        let result = validate(&config);

        assert!(result.is_err());
    }

    #[test]
    fn validate_local_dev_rejects_default_bearer_token_on_non_loopback_host() {
        let mut config = AppConfig::default();
        config.local_dev.enabled = true;
        config.server.host = "0.0.0.0".to_string();

        let result = validate(&config);

        assert!(result.is_err());
    }

    #[test]
    fn validate_local_dev_rejects_non_user_id() {
        let mut config = AppConfig::default();
        config.local_dev.enabled = true;
        config.local_dev.user_id = "local_dev".to_string();

        let result = validate(&config);

        assert!(result.is_err());
    }
}
