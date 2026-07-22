//! Model-picker state. The Tauri side persists which transcription /
//! generation models the user selected. Remote provider keys and URLs live in
//! June API; the opt-in "bring your own inference" local model stores an
//! OpenAI-compatible endpoint (any http/https host) here. Advanced users may
//! also store their own Venice API key locally; responses only expose whether
//! one is present, never the key itself.

use crate::domain::types::AppError;
use serde::{Deserialize, Deserializer, Serialize};
use std::{
    collections::BTreeMap,
    fs,
    path::PathBuf,
    sync::{Mutex, OnceLock},
    time::Duration,
};
use tauri::{AppHandle, Manager, State};

pub const PROVIDER_OPENAI: &str = "openai";
pub const PROVIDER_VENICE: &str = "venice";
pub const PROVIDER_LOCAL: &str = "local";
pub const DEFAULT_TRANSCRIPTION_MODEL: &str = "nvidia/parakeet-tdt-0.6b-v3";
pub const DEFAULT_GENERATION_MODEL: &str = "zai-org-glm-5-2";
pub const AUTO_GENERATION_MODEL: &str = "open-software/auto";
const LOCAL_AUTO_VISION_FALLBACK_MODEL: &str = "kimi-k2-6";
pub const DEFAULT_COST_QUALITY: u8 = 100;
pub const DEFAULT_IMAGE_MODEL: &str = "venice-sd35";
pub const DEFAULT_VIDEO_MODEL: &str = "wan-2.2-a14b-text-to-video";
/// Currently curated text-to-video model ids (mirrors `VIDEO_MODELS` in
/// `src/lib/video-models.ts` and the june-api `video_pricing` allowlist). A
/// persisted `video_model` outside this set — for example the delisted Seedance
/// default that older installs saved before it was pulled from Venice — is
/// migrated to `DEFAULT_VIDEO_MODEL` on load so generation keeps working after
/// an update. Keep in sync when the curated list changes.
pub const KNOWN_VIDEO_MODELS: &[&str] = &[
    DEFAULT_VIDEO_MODEL,
    "grok-imagine-text-to-video-private",
    "ltx-2-19b-full-text-to-video",
];
pub const DEFAULT_VIDEO_DURATION: &str = "5s";
pub const DEFAULT_VIDEO_RESOLUTION: &str = "720p";
/// Some models (for example wan-2.2-a14b) reject a queue request that omits
/// `aspect_ratio`, so the fast path injects a default when the caller names none.
pub const DEFAULT_VIDEO_ASPECT_RATIO: &str = "16:9";
const VENICE_API_BASE_URL: &str = "https://api.venice.ai/api/v1";
const VENICE_API_KEY_VERIFY_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_VENICE_API_KEY_CHARS: usize = 4_096;

// Kept exported under the legacy names so existing callers compile until they
// migrate to the names above.
pub use PROVIDER_OPENAI as OPENAI_PROVIDER;
pub use PROVIDER_VENICE as VENICE_PROVIDER;

static MODEL_SETTINGS: OnceLock<Mutex<ProviderModelSettings>> = OnceLock::new();
static HERMES_HOME_DIR: OnceLock<Mutex<Option<PathBuf>>> = OnceLock::new();
static VENICE_VERIFY_HTTP_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

pub struct ProviderSettingsState {
    path: PathBuf,
    hermes_home: PathBuf,
    settings: Mutex<ProviderModelSettings>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProviderModelSettings {
    #[serde(default = "default_transcription_provider")]
    pub transcription_provider: String,
    #[serde(default = "default_generation_provider")]
    pub generation_provider: String,
    #[serde(default = "default_transcription_model")]
    pub transcription_model: String,
    #[serde(default = "default_generation_model")]
    pub generation_model: String,
    #[serde(default = "default_cost_quality")]
    pub cost_quality: u8,
    #[serde(default = "default_generation_model")]
    pub remote_generation_model: String,
    // Defaulted so provider-settings.json files written before image
    // generation existed still deserialize (they predate this field).
    #[serde(default = "default_image_model")]
    pub image_model: String,
    #[serde(default = "default_video_model")]
    pub video_model: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub venice_api_key: Option<String>,
    #[serde(default)]
    pub local_generation: LocalGenerationSettings,
    /// When true, Venice `safe_mode` blurs adult content on generated/edited
    /// images. June defaults it ON; the user opts out via Settings or the
    /// generation-time consent dialog. Defaulted so settings files predating
    /// this field still deserialize to the current default.
    #[serde(default = "default_image_safe_mode")]
    pub image_safe_mode: bool,
    /// When true, the user chose "don't ask again" on the safe-mode consent
    /// dialog: June stops offering to turn safe mode off before
    /// potentially-explicit generations. Reset to false whenever safe mode is
    /// explicitly re-enabled, so re-opting into safety re-arms the prompt.
    #[serde(default)]
    pub image_safe_mode_prompt_dismissed: bool,
    /// True once the user explicitly chose a safe-mode value (Settings toggle
    /// or the consent dialog, both of which land in `set_image_safe_mode`).
    /// Without it, a stored `image_safe_mode` is ignored on load and safe
    /// mode reads its default (on) - files written by pre-JUN-209 builds
    /// carry an incidental `false` the user never picked.
    #[serde(default)]
    pub image_safe_mode_set_by_user: bool,
    /// When true (the default), June streams a live transcript preview while
    /// recording. On builds that carry this setting the preview is billed as
    /// extra usage (ADR-0002 addendum, JUN-375); turning it off stops the
    /// preview lanes entirely, so nothing is sent or billed.
    #[serde(default = "default_live_transcription")]
    pub live_transcription: bool,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub profile_overrides: BTreeMap<String, ProfileModelOverrides>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LocalGenerationSettings {
    pub base_url: String,
    pub model_id: String,
    #[serde(default)]
    pub api_key: String,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProfileModelOverrides {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transcription_provider: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transcription_model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image_model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub video_model: Option<String>,
}

/// The client-facing view of provider settings. The Venice API key is never
/// serialized back — only whether one is configured. The local endpoint's
/// api key is round-tripped so the settings UI can pre-fill and edit it.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProviderModelSettingsDto {
    pub transcription_provider: String,
    pub generation_provider: String,
    pub transcription_model: String,
    pub generation_model: String,
    pub cost_quality: u8,
    pub remote_generation_model: String,
    pub image_model: String,
    pub video_model: String,
    pub venice_api_key_configured: bool,
    pub local_generation: LocalGenerationSettings,
    pub image_safe_mode: bool,
    pub image_safe_mode_prompt_dismissed: bool,
    pub live_transcription: bool,
}

impl From<&ProviderModelSettings> for ProviderModelSettingsDto {
    fn from(settings: &ProviderModelSettings) -> Self {
        Self {
            transcription_provider: settings.transcription_provider.clone(),
            generation_provider: settings.generation_provider.clone(),
            transcription_model: settings.transcription_model.clone(),
            generation_model: settings.generation_model.clone(),
            cost_quality: settings.cost_quality,
            remote_generation_model: settings.remote_generation_model.clone(),
            image_model: settings.image_model.clone(),
            video_model: settings.video_model.clone(),
            venice_api_key_configured: settings
                .venice_api_key
                .as_deref()
                .is_some_and(|value| !value.trim().is_empty()),
            local_generation: settings.local_generation.clone(),
            image_safe_mode: settings.image_safe_mode,
            image_safe_mode_prompt_dismissed: settings.image_safe_mode_prompt_dismissed,
            live_transcription: settings.live_transcription,
        }
    }
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProviderModelSettingsResponse {
    pub settings: ProviderModelSettingsDto,
    pub effective_settings: ProviderModelSettingsDto,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProfileModelOverridesDto {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transcription_provider: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transcription_model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image_model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub video_model: Option<String>,
}

impl From<&ProfileModelOverrides> for ProfileModelOverridesDto {
    fn from(overrides: &ProfileModelOverrides) -> Self {
        Self {
            transcription_provider: overrides.transcription_provider.clone(),
            transcription_model: overrides.transcription_model.clone(),
            image_model: overrides.image_model.clone(),
            video_model: overrides.video_model.clone(),
        }
    }
}

impl From<ProfileModelOverridesDto> for ProfileModelOverrides {
    fn from(overrides: ProfileModelOverridesDto) -> Self {
        Self {
            transcription_provider: normalize_optional_model_field(
                overrides.transcription_provider,
            ),
            transcription_model: normalize_optional_model_field(overrides.transcription_model),
            image_model: normalize_optional_model_field(overrides.image_model),
            video_model: normalize_optional_model_field(overrides.video_model),
        }
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SetVeniceModelRequest {
    pub mode: ModelMode,
    pub model_id: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SetCostQualityRequest {
    pub value: u8,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SaveLocalGenerationSettingsRequest {
    pub base_url: String,
    pub model_id: String,
    #[serde(default)]
    pub api_key: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SetLocalGenerationEnabledRequest {
    pub enabled: bool,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProbeLocalGenerationEndpointRequest {
    pub base_url: String,
    #[serde(default)]
    pub api_key: String,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LocalEndpointProbe {
    pub models: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct VeniceModelsRequest {
    pub mode: ModelMode,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SetVeniceApiKeyRequest {
    pub api_key: String,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct VeniceModelsResponse {
    pub mode: ModelMode,
    pub model_type: String,
    pub selected_model: String,
    pub models: Vec<VeniceModelDto>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct VeniceModelDto {
    pub provider: String,
    pub id: String,
    pub name: String,
    pub model_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub privacy: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pricing: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_tokens: Option<i64>,
    pub traits: Vec<String>,
    pub capabilities: Vec<String>,
    pub price_unit: String,
    pub price_description: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub credits_per_million_seconds: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input_credits_per_million_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_credits_per_million_tokens: Option<u64>,
}

impl From<crate::june_api::ModelDto> for VeniceModelDto {
    fn from(value: crate::june_api::ModelDto) -> Self {
        let pricing = pricing_with_display(value.pricing, &value.price_description);
        Self {
            description: value.description,
            provider: value.provider,
            id: value.id,
            name: value.name,
            model_type: value.model_type,
            privacy: value.privacy,
            pricing: Some(pricing),
            context_tokens: value.context_tokens,
            traits: value.traits,
            capabilities: value.capabilities,
            price_unit: value.price_unit,
            price_description: value.price_description,
            credits_per_million_seconds: value.credits_per_million_seconds,
            input_credits_per_million_tokens: value.input_credits_per_million_tokens,
            output_credits_per_million_tokens: value.output_credits_per_million_tokens,
        }
    }
}

fn pricing_with_display(pricing: Option<serde_json::Value>, display: &str) -> serde_json::Value {
    let display = display.trim();
    match pricing {
        Some(serde_json::Value::Object(mut map)) => {
            if !display.is_empty() {
                map.insert(
                    "display".to_string(),
                    serde_json::Value::String(display.to_string()),
                );
            }
            serde_json::Value::Object(map)
        }
        Some(value) => value,
        None => serde_json::json!({ "display": display }),
    }
}

pub fn configured_transcription_provider() -> String {
    effective_current_settings().transcription_provider
}

pub fn provider_configured() -> bool {
    crate::june_api::configured()
}

pub fn transcription_model() -> String {
    effective_current_settings().transcription_model
}

pub fn generation_model() -> String {
    current_settings().generation_model
}

pub fn cost_quality() -> f64 {
    // Keep the wire value safe even if a user manually edits the settings file
    // after it has been loaded but before a future accessor refactor.
    f64::from(current_settings().cost_quality.min(100)) / 100.0
}

pub fn generation_provider() -> String {
    current_settings().generation_provider
}

pub fn local_generation_settings() -> LocalGenerationSettings {
    current_settings().local_generation
}

pub fn image_model() -> String {
    effective_current_settings().image_model
}

pub fn video_model() -> String {
    effective_current_settings().video_model
}

pub fn venice_api_key() -> Option<String> {
    current_settings().venice_api_key
}

/// Whether Venice safe mode is on for image generation/editing. The default is
/// `true`, so June asks Venice to blur adult content unless the user opts out
/// via Settings or the generation-time consent dialog.
pub fn image_safe_mode() -> bool {
    current_settings().image_safe_mode
}

pub fn image_safe_mode_prompt_dismissed() -> bool {
    current_settings().image_safe_mode_prompt_dismissed
}

pub fn live_transcription() -> bool {
    current_settings().live_transcription
}

/// Context window (tokens) of the configured generation model, looked up in
/// the backend's model catalog and cached per model id. The agent provider
/// proxy advertises it on `/v1/models` so Hermes sizes its history to the
/// real window and compresses proactively, instead of discovering the limit
/// by bouncing off the backend's prompt_too_long rejection. Returns `None`
/// when the catalog is unreachable (offline, signed out) or doesn't report a
/// window for the model — callers degrade by omitting the field, which puts
/// Hermes back on its own probing, exactly the pre-advertisement behavior.
pub async fn generation_model_context_tokens() -> Option<i64> {
    if generation_provider() == PROVIDER_LOCAL {
        return None;
    }
    let model_id = generation_model();
    if let Ok(cache) = context_tokens_cache().lock() {
        if let Some((cached_id, tokens)) = cache.as_ref() {
            if *cached_id == model_id {
                return Some(*tokens);
            }
        }
    }
    let models = crate::june_api::list_models(ModelMode::Generation.api_type())
        .await
        .ok()?;
    let tokens = models
        .into_iter()
        .find(|model| model.id == model_id)?
        .context_tokens?;
    if let Ok(mut cache) = context_tokens_cache().lock() {
        *cache = Some((model_id, tokens));
    }
    Some(tokens)
}

/// One entry only: the generation model changes rarely, and a stale entry
/// for the previous model would otherwise outlive a settings switch.
fn context_tokens_cache() -> &'static Mutex<Option<(String, i64)>> {
    static CACHE: OnceLock<Mutex<Option<(String, i64)>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(None))
}

/// Whether the configured generation model reports vision (image input) support
/// in the backend catalog. Hermes' vision tools only take the native fast path
/// (attach the image straight to the model's context) for providers they
/// recognize OR when `model.supports_vision` is set in `config.yaml`; June's
/// proxy is `provider: custom`, so that override is the only signal, and the
/// spawn path resolves it here (see `render_hermes_config`). Returns `false`
/// when the catalog is unreachable (offline, signed out) or the model reports no
/// vision capability. In local dev, a persisted Auto selection can use the same
/// catalog-backed capability fallback as June API when Auto is absent. The
/// conservative default keeps the prior behavior, where Hermes falls back to
/// its (unconfigured) auxiliary vision LLM.
pub async fn generation_model_supports_vision() -> bool {
    if generation_provider() == PROVIDER_LOCAL {
        return false;
    }
    let model_id = generation_model();
    let Ok(models) = crate::june_api::list_models(ModelMode::Generation.api_type()).await else {
        return false;
    };
    generation_model_supports_vision_from_catalog(
        &model_id,
        crate::os_accounts::local_dev_enabled(),
        models
            .iter()
            .map(|model| (model.id.as_str(), model.capabilities.as_slice())),
    )
}

fn generation_model_supports_vision_from_catalog<'a>(
    model_id: &str,
    local_dev_enabled: bool,
    models: impl IntoIterator<Item = (&'a str, &'a [String])>,
) -> bool {
    let use_local_auto_fallback = local_dev_enabled && model_id == AUTO_GENERATION_MODEL;
    let mut preferred_fallback_is_compatible = false;
    let mut alternate_fallback_is_compatible = false;

    for (catalog_model_id, capabilities) in models {
        if catalog_model_id == model_id {
            return capabilities_include_vision(capabilities);
        }
        if use_local_auto_fallback && capabilities_support_agent_images(capabilities) {
            if catalog_model_id == LOCAL_AUTO_VISION_FALLBACK_MODEL {
                preferred_fallback_is_compatible = true;
            } else {
                alternate_fallback_is_compatible = true;
            }
        }
    }

    preferred_fallback_is_compatible || alternate_fallback_is_compatible
}

/// Mirrors the frontend `modelSupportsImageInput`: key off the authoritative
/// `capabilities` list (never `traits`), matching the normalized `supportsVision`
/// name so a rename to snake_case still resolves.
fn capabilities_include_vision(capabilities: &[String]) -> bool {
    capabilities_include(capabilities, "supportsvision")
}

fn capabilities_support_agent_images(capabilities: &[String]) -> bool {
    capabilities_include_vision(capabilities)
        && (capabilities_include(capabilities, "functioncalling")
            || capabilities_include(capabilities, "toolcalling"))
}

fn capabilities_include(capabilities: &[String], expected: &str) -> bool {
    capabilities.iter().any(|capability| {
        let normalized: String = capability
            .chars()
            .filter(char::is_ascii_alphabetic)
            .map(|ch| ch.to_ascii_lowercase())
            .collect();
        normalized.contains(expected)
    })
}

// Legacy name kept for callers we haven't migrated yet.
pub fn venice_generation_model() -> String {
    generation_model()
}

pub fn transcription_provider_for_model(model: &str) -> &'static str {
    if matches!(
        model.trim(),
        "gpt-4o-mini-transcribe" | "gpt-4o-transcribe" | "whisper-1"
    ) {
        PROVIDER_OPENAI
    } else {
        PROVIDER_VENICE
    }
}

#[tauri::command]
pub fn provider_model_settings(
    state: State<'_, ProviderSettingsState>,
) -> Result<ProviderModelSettingsResponse, AppError> {
    let settings = state
        .settings
        .lock()
        .map_err(|_| AppError::new("provider_settings_unavailable", "Settings lock failed."))?;
    let effective_settings = effective_settings_for_hermes_home(&settings, &state.hermes_home);
    Ok(ProviderModelSettingsResponse {
        settings: ProviderModelSettingsDto::from(&*settings),
        effective_settings: ProviderModelSettingsDto::from(&effective_settings),
    })
}

#[tauri::command]
pub fn profile_model_overrides(
    state: State<'_, ProviderSettingsState>,
    profile: String,
) -> Result<Option<ProfileModelOverridesDto>, AppError> {
    let profile = validate_profile_override_name(&profile)?;
    let settings = state
        .settings
        .lock()
        .map_err(|_| AppError::new("provider_settings_unavailable", "Settings lock failed."))?;
    Ok(settings
        .profile_overrides
        .get(profile)
        .map(ProfileModelOverridesDto::from))
}

#[tauri::command]
pub fn set_profile_model_overrides(
    state: State<'_, ProviderSettingsState>,
    profile: String,
    overrides: ProfileModelOverridesDto,
) -> Result<(), AppError> {
    set_profile_model_overrides_impl(&state, &profile, overrides)
}

fn set_profile_model_overrides_impl(
    state: &ProviderSettingsState,
    profile: &str,
    overrides: ProfileModelOverridesDto,
) -> Result<(), AppError> {
    let profile = validate_profile_override_name(profile)?.to_string();
    update_settings_result(state, |settings| {
        let overrides = ProfileModelOverrides::from(overrides);
        if profile_overrides_empty(&overrides) {
            settings.profile_overrides.remove(&profile);
        } else {
            settings.profile_overrides.insert(profile, overrides);
        }
        Ok(())
    })?;
    Ok(())
}

#[tauri::command]
pub fn delete_profile_model_overrides(
    state: State<'_, ProviderSettingsState>,
    profile: String,
) -> Result<(), AppError> {
    delete_profile_model_overrides_impl(&state, &profile)
}

fn delete_profile_model_overrides_impl(
    state: &ProviderSettingsState,
    profile: &str,
) -> Result<(), AppError> {
    let profile = validate_profile_override_name(profile)?.to_string();
    update_settings(state, |settings| {
        settings.profile_overrides.remove(&profile);
    })?;
    Ok(())
}

#[tauri::command]
pub fn set_venice_model(
    state: State<'_, ProviderSettingsState>,
    request: SetVeniceModelRequest,
) -> Result<ProviderModelSettingsDto, AppError> {
    let model_id = request.model_id.trim();
    if model_id.is_empty() {
        return Err(AppError::new("provider_model_required", "Select a model."));
    }
    update_settings(&state, |settings| match request.mode {
        ModelMode::Transcription => {
            settings.transcription_provider =
                transcription_provider_for_model(model_id).to_string();
            settings.transcription_model = model_id.to_string();
        }
        ModelMode::Generation => {
            settings.generation_provider = PROVIDER_VENICE.to_string();
            settings.generation_model = model_id.to_string();
            settings.remote_generation_model = model_id.to_string();
        }
        ModelMode::Image => settings.image_model = model_id.to_string(),
        ModelMode::Video => settings.video_model = model_id.to_string(),
    })
}

#[tauri::command]
pub fn set_cost_quality(
    state: State<'_, ProviderSettingsState>,
    request: SetCostQualityRequest,
) -> Result<ProviderModelSettingsDto, AppError> {
    if request.value > 100 {
        return Err(AppError::new(
            "cost_quality_invalid",
            "Preference must be from 0 to 100.",
        ));
    }
    update_settings(&state, |settings| settings.cost_quality = request.value)
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SetImageSafeModeRequest {
    pub enabled: bool,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SetLiveTranscriptionRequest {
    pub enabled: bool,
}

#[tauri::command]
pub fn set_live_transcription(
    state: State<'_, ProviderSettingsState>,
    request: SetLiveTranscriptionRequest,
) -> Result<ProviderModelSettingsDto, AppError> {
    set_live_transcription_impl(&state, request)
}

fn set_live_transcription_impl(
    state: &ProviderSettingsState,
    request: SetLiveTranscriptionRequest,
) -> Result<ProviderModelSettingsDto, AppError> {
    update_settings(state, |settings| {
        settings.live_transcription = request.enabled;
    })
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SetImageSafeModePromptDismissedRequest {
    pub dismissed: bool,
}

/// Persists the image safe-mode toggle. On by default; the user can opt out
/// via Settings or the generation-time consent dialog. The value flows into
/// every image generation/edit request from the loopback proxy and the fast
/// path.
#[tauri::command]
pub fn set_image_safe_mode(
    state: State<'_, ProviderSettingsState>,
    request: SetImageSafeModeRequest,
) -> Result<ProviderModelSettingsDto, AppError> {
    set_image_safe_mode_impl(&state, request)
}

fn set_image_safe_mode_impl(
    state: &ProviderSettingsState,
    request: SetImageSafeModeRequest,
) -> Result<ProviderModelSettingsDto, AppError> {
    update_settings(state, |settings| {
        settings.image_safe_mode = request.enabled;
        settings.image_safe_mode_set_by_user = true;
        if request.enabled {
            settings.image_safe_mode_prompt_dismissed = false;
        }
    })
}

#[tauri::command]
pub fn set_image_safe_mode_prompt_dismissed(
    state: State<'_, ProviderSettingsState>,
    request: SetImageSafeModePromptDismissedRequest,
) -> Result<ProviderModelSettingsDto, AppError> {
    set_image_safe_mode_prompt_dismissed_impl(&state, request)
}

fn set_image_safe_mode_prompt_dismissed_impl(
    state: &ProviderSettingsState,
    request: SetImageSafeModePromptDismissedRequest,
) -> Result<ProviderModelSettingsDto, AppError> {
    update_settings(state, |settings| {
        settings.image_safe_mode_prompt_dismissed = request.dismissed;
    })
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GenerateImageRequest {
    pub prompt: String,
    /// Optional model override; falls back to the saved default image model.
    #[serde(default)]
    pub model: Option<String>,
    /// Stable logical request id supplied by the chat orchestration layer.
    #[serde(default)]
    pub request_id: Option<String>,
    /// Optional safe-mode override pinned at turn creation. A retry must replay
    /// the exact request shape June API hashed into its replay-ledger key, so a
    /// settings change between attempt and retry cannot mint a second charge.
    /// Absent falls back to the live saved setting.
    #[serde(default)]
    pub safe_mode: Option<bool>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GenerateVideoRequest {
    pub prompt: String,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub request_id: Option<String>,
    #[serde(default)]
    pub duration: Option<String>,
    #[serde(default)]
    pub resolution: Option<String>,
    #[serde(default)]
    pub aspect_ratio: Option<String>,
    #[serde(default)]
    pub audio: Option<bool>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct VideoStatusRequest {
    pub job_id: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EditImageRequest {
    pub image: String,
    pub prompt: String,
    /// Stable logical request id supplied by the caller.
    #[serde(default)]
    pub request_id: Option<String>,
    #[serde(default)]
    pub mime_type: Option<String>,
    /// Optional edit-model override; absent uses June API's default edit model.
    #[serde(default)]
    pub model: Option<String>,
}

/// Generates an image from a prompt via the June API, defaulting to the saved
/// image model. Provider keys and the upstream call live in June API; this
/// command only resolves the model and forwards the prompt.
#[tauri::command]
pub async fn generate_image(
    request: GenerateImageRequest,
) -> Result<crate::june_api::GeneratedImageDto, AppError> {
    let prompt = request.prompt.trim().to_string();
    if prompt.is_empty() {
        return Err(AppError::new("image_prompt_required", "Enter a prompt."));
    }
    let model = request
        .model
        .map(|model| model.trim().to_string())
        .filter(|model| !model.is_empty())
        .unwrap_or_else(image_model);
    let request_id = request
        .request_id
        .map(|request_id| request_id.trim().to_string())
        .filter(|request_id| !request_id.is_empty());
    let safe_mode = request.safe_mode.unwrap_or_else(image_safe_mode);
    crate::june_api::generate_image(prompt, model, Some(safe_mode), request_id).await
}

/// Edits a source image through June API. Provider keys and the upstream call
/// live in June API; this command only validates and forwards the image bytes.
#[tauri::command]
pub async fn edit_image(
    request: EditImageRequest,
) -> Result<crate::june_api::GeneratedImageDto, AppError> {
    let image = request.image.trim().to_string();
    if image.is_empty() {
        return Err(AppError::new(
            "image_source_required",
            "Choose an image to edit.",
        ));
    }
    let prompt = request.prompt.trim().to_string();
    if prompt.is_empty() {
        return Err(AppError::new(
            "image_prompt_required",
            "Enter an edit instruction.",
        ));
    }
    let model = request
        .model
        .map(|model| model.trim().to_string())
        .filter(|model| !model.is_empty());
    let request_id = request
        .request_id
        .map(|request_id| request_id.trim().to_string())
        .filter(|request_id| !request_id.is_empty());
    let mime_type = request
        .mime_type
        .map(|mime_type| mime_type.trim().to_string())
        .filter(|mime_type| !mime_type.is_empty());
    crate::june_api::edit_image(
        image,
        prompt,
        mime_type,
        model,
        Some(image_safe_mode()),
        request_id,
    )
    .await
}

#[tauri::command]
pub async fn video_generate(
    request: GenerateVideoRequest,
) -> Result<crate::june_api::VideoJobDto, AppError> {
    video_generate_with_enabled(request, crate::feature_flags::VIDEO_GENERATION_ENABLED).await
}

async fn video_generate_with_enabled(
    request: GenerateVideoRequest,
    enabled: bool,
) -> Result<crate::june_api::VideoJobDto, AppError> {
    ensure_video_generation_enabled(enabled)?;
    let prompt = request.prompt.trim().to_string();
    if prompt.is_empty() {
        return Err(AppError::new("video_prompt_required", "Enter a prompt."));
    }
    let model = request
        .model
        .map(|model| model.trim().to_string())
        .filter(|model| !model.is_empty())
        .unwrap_or_else(video_model);
    let request_id = request
        .request_id
        .map(|request_id| request_id.trim().to_string())
        .filter(|request_id| !request_id.is_empty());
    let duration = request
        .duration
        .map(|duration| duration.trim().to_string())
        .filter(|duration| !duration.is_empty())
        .unwrap_or_else(|| DEFAULT_VIDEO_DURATION.to_string());
    let resolution = request
        .resolution
        .map(|resolution| resolution.trim().to_string())
        .filter(|resolution| !resolution.is_empty())
        .or_else(|| Some(DEFAULT_VIDEO_RESOLUTION.to_string()));
    let aspect_ratio = request
        .aspect_ratio
        .map(|aspect_ratio| aspect_ratio.trim().to_string())
        .filter(|aspect_ratio| !aspect_ratio.is_empty())
        .or_else(|| Some(DEFAULT_VIDEO_ASPECT_RATIO.to_string()));
    crate::june_api::video_generate(crate::june_api::VideoGenerateParams {
        prompt,
        model,
        request_id,
        duration,
        resolution,
        aspect_ratio,
        audio: request.audio,
    })
    .await
}

#[tauri::command]
pub async fn video_status(
    app: AppHandle,
    request: VideoStatusRequest,
) -> Result<crate::june_api::VideoStatusDto, AppError> {
    video_status_with_enabled(app, request, crate::feature_flags::VIDEO_GENERATION_ENABLED).await
}

/// Absolute path of the generated-videos directory. Lets the frontend resolve a
/// bare `generated-video-*.mp4` filename (the agent frequently names a finished
/// video by filename only when asked to show it again) to an asset-scoped path
/// the webview can load. Mirrors the directory `june_api::write_video_bytes`
/// and the `june_video` MCP write into.
#[tauri::command]
pub fn generated_video_dir(app: AppHandle) -> Result<String, AppError> {
    let dir = crate::app_paths::app_data_dir(&app)
        .map_err(|error| AppError::new("video_dir_failed", error.to_string()))?
        .join("hermes")
        .join("videos");
    Ok(dir.to_string_lossy().into_owned())
}

async fn video_status_with_enabled(
    app: AppHandle,
    request: VideoStatusRequest,
    enabled: bool,
) -> Result<crate::june_api::VideoStatusDto, AppError> {
    let job_id = video_status_job_id_with_enabled(request, enabled)?;
    crate::june_api::video_status(&app, job_id).await
}

fn video_status_job_id_with_enabled(
    request: VideoStatusRequest,
    enabled: bool,
) -> Result<String, AppError> {
    ensure_video_generation_enabled(enabled)?;
    let job_id = request.job_id.trim().to_string();
    if job_id.is_empty() {
        return Err(AppError::new(
            "video_job_required",
            "Video job id is required.",
        ));
    }
    Ok(job_id)
}

fn ensure_video_generation_enabled(enabled: bool) -> Result<(), AppError> {
    if enabled {
        Ok(())
    } else {
        Err(video_generation_disabled_error())
    }
}

fn video_generation_disabled_error() -> AppError {
    AppError::new(
        "video_generation_disabled",
        "Video generation is not available.",
    )
}

#[tauri::command]
pub async fn set_venice_api_key(
    state: State<'_, ProviderSettingsState>,
    request: SetVeniceApiKeyRequest,
) -> Result<ProviderModelSettingsDto, AppError> {
    let api_key = normalize_api_key(&request.api_key).ok_or_else(|| {
        AppError::new(
            "venice_api_key_required",
            "Enter a Venice API key before saving.",
        )
    })?;
    validate_venice_api_key_format(&api_key)?;
    verify_venice_api_key(&api_key).await?;
    update_settings(&state, |settings| {
        settings.venice_api_key = Some(api_key);
    })
}

#[tauri::command]
pub fn clear_venice_api_key(
    state: State<'_, ProviderSettingsState>,
) -> Result<ProviderModelSettingsDto, AppError> {
    update_settings(&state, |settings| {
        settings.venice_api_key = None;
    })
}

/// Persists the "bring your own inference" endpoint without switching the
/// active provider. Enabling and disabling the local model is a separate
/// command so that saving a draft never silently activates it, and toggling
/// off never rewrites the stored endpoint.
#[tauri::command]
pub fn save_local_generation_settings(
    state: State<'_, ProviderSettingsState>,
    request: SaveLocalGenerationSettingsRequest,
) -> Result<ProviderModelSettingsDto, AppError> {
    save_local_generation_settings_impl(&state, request)
}

fn save_local_generation_settings_impl(
    state: &ProviderSettingsState,
    request: SaveLocalGenerationSettingsRequest,
) -> Result<ProviderModelSettingsDto, AppError> {
    let raw_base_url = request.base_url.trim();
    let model_id = request.model_id.trim().to_string();
    let api_key = request.api_key.trim().to_string();
    let clearing = raw_base_url.is_empty() && model_id.is_empty() && api_key.is_empty();

    // Validate the URL up front so a bad request never mutates stored state.
    let base_url = if clearing {
        String::new()
    } else {
        normalize_local_base_url(raw_base_url)?
    };

    let candidate = LocalGenerationSettings {
        base_url,
        model_id,
        api_key,
    };
    let configured = local_generation_settings_configured(&candidate);

    update_settings_result(state, |settings| {
        let provider_is_local = settings.generation_provider == PROVIDER_LOCAL;
        if provider_is_local && !configured {
            return Err(AppError::new(
                "local_model_in_use",
                "Disable the local model first.",
            ));
        }
        settings.local_generation = candidate.clone();
        if provider_is_local {
            settings.generation_model = candidate.model_id.clone();
        }
        Ok(())
    })
}

/// Switches the active generation provider between the saved local endpoint
/// and the remote Venice default. Never edits the stored local endpoint, so
/// disabling and re-enabling round-trips the same configuration.
#[tauri::command]
pub fn set_local_generation_enabled(
    state: State<'_, ProviderSettingsState>,
    request: SetLocalGenerationEnabledRequest,
) -> Result<ProviderModelSettingsDto, AppError> {
    set_local_generation_enabled_impl(&state, request)
}

fn set_local_generation_enabled_impl(
    state: &ProviderSettingsState,
    request: SetLocalGenerationEnabledRequest,
) -> Result<ProviderModelSettingsDto, AppError> {
    update_settings_result(state, |settings| {
        if request.enabled {
            if !local_generation_settings_configured(&settings.local_generation) {
                return Err(AppError::new(
                    "local_model_not_configured",
                    "Configure a local model endpoint and model ID first.",
                ));
            }
            settings.generation_provider = PROVIDER_LOCAL.to_string();
            settings.generation_model = settings.local_generation.model_id.trim().to_string();
        } else {
            settings.generation_provider = PROVIDER_VENICE.to_string();
            settings.generation_model = non_empty_or(
                settings.remote_generation_model.clone(),
                DEFAULT_GENERATION_MODEL,
            );
        }
        Ok(())
    })
}

/// Lists the models an OpenAI-compatible endpoint advertises, so the settings
/// UI can confirm the endpoint is reachable and offer real model ids. Uses a
/// short timeout because this runs interactively while the user types.
#[tauri::command]
pub async fn probe_local_generation_endpoint(
    request: ProbeLocalGenerationEndpointRequest,
) -> Result<LocalEndpointProbe, AppError> {
    let base_url = normalize_local_base_url(&request.base_url)?;
    let api_key = request.api_key.trim().to_string();
    let url = format!("{base_url}/models");

    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|error| AppError::new("local_endpoint_unreachable", error.to_string()))?;

    let mut request = client.get(&url);
    if !api_key.is_empty() {
        request = request.bearer_auth(&api_key);
    }

    let response = request.send().await.map_err(|_| {
        AppError::new(
            "local_endpoint_unreachable",
            "Could not reach the endpoint. Check the URL and that the server is running.",
        )
    })?;

    let status = response.status();
    if !status.is_success() {
        return Err(AppError::new(
            "local_endpoint_failed",
            format!("The endpoint returned status {}.", status.as_u16()),
        ));
    }

    let body = response.bytes().await.map_err(|_| {
        AppError::new(
            "local_endpoint_unreachable",
            "Could not read the response from the endpoint.",
        )
    })?;
    parse_local_models_response(&body)
}

/// Parses the OpenAI models-list shape `{"data":[{"id":"..."}]}`. Extracted so
/// it can be tested without a network round-trip. Tolerates extra fields.
fn parse_local_models_response(body: &[u8]) -> Result<LocalEndpointProbe, AppError> {
    let value: serde_json::Value = serde_json::from_slice(body).map_err(|_| {
        AppError::new(
            "local_endpoint_invalid_response",
            "The endpoint returned a response we could not read.",
        )
    })?;
    let models = value
        .get("data")
        .and_then(|data| data.as_array())
        .ok_or_else(|| {
            AppError::new(
                "local_endpoint_invalid_response",
                "The endpoint did not return a model list.",
            )
        })?
        .iter()
        .filter_map(|item| item.get("id").and_then(|id| id.as_str()))
        .map(|id| id.to_string())
        .collect();
    Ok(LocalEndpointProbe { models })
}

#[tauri::command]
pub async fn list_venice_models(
    state: State<'_, ProviderSettingsState>,
    request: VeniceModelsRequest,
) -> Result<VeniceModelsResponse, AppError> {
    let model_type = request.mode.api_type();
    let selected_model = selected_model_for_mode(&state, request.mode)?;
    // Image models aren't part of the priced catalog the backend serves (image
    // billing is deferred); the picker uses a curated frontend list instead.
    // Short-circuit so a direct caller never gets unrelated text/asr models
    // back, and we skip a pointless catalog round-trip.
    if request.mode == ModelMode::Image {
        return Ok(VeniceModelsResponse {
            mode: request.mode,
            model_type: model_type.to_string(),
            selected_model,
            models: Vec::new(),
        });
    }
    let mut models = crate::june_api::list_models(model_type)
        .await?
        .into_iter()
        .map(VeniceModelDto::from)
        .collect::<Vec<_>>();
    models.sort_by(|left, right| {
        left.name
            .to_ascii_lowercase()
            .cmp(&right.name.to_ascii_lowercase())
            .then_with(|| left.id.cmp(&right.id))
    });
    Ok(VeniceModelsResponse {
        mode: request.mode,
        model_type: model_type.to_string(),
        selected_model,
        models,
    })
}

pub fn setup(app: &mut tauri::App) {
    let path = provider_settings_path(app.handle())
        .unwrap_or_else(|| PathBuf::from("provider-settings.json"));
    let hermes_home = provider_hermes_home(app.handle()).unwrap_or_else(|| PathBuf::from("hermes"));
    let settings = load_settings_from_disk(app.handle());
    replace_current_settings(settings.clone());
    replace_hermes_home(Some(hermes_home.clone()));
    app.manage(ProviderSettingsState {
        path,
        hermes_home,
        settings: Mutex::new(settings),
    });
}

pub fn load_local_env() {
    crate::os_accounts::load_local_env();
}

fn current_settings() -> ProviderModelSettings {
    settings_store()
        .lock()
        .map(|settings| settings.clone())
        .unwrap_or_else(|_| default_settings())
}

fn effective_current_settings() -> ProviderModelSettings {
    let settings = current_settings();
    hermes_home_store()
        .lock()
        .ok()
        .and_then(|home| home.clone())
        .map(|hermes_home| effective_settings_for_hermes_home(&settings, &hermes_home))
        .unwrap_or(settings)
}

fn settings_store() -> &'static Mutex<ProviderModelSettings> {
    MODEL_SETTINGS.get_or_init(|| Mutex::new(default_settings()))
}

fn hermes_home_store() -> &'static Mutex<Option<PathBuf>> {
    HERMES_HOME_DIR.get_or_init(|| Mutex::new(None))
}

fn replace_current_settings(settings: ProviderModelSettings) {
    if let Ok(mut current) = settings_store().lock() {
        *current = settings;
    }
}

fn replace_hermes_home(path: Option<PathBuf>) {
    if let Ok(mut current) = hermes_home_store().lock() {
        *current = path;
    }
}

/// Test-only hook: installs settings into the process-wide store that
/// `current_settings()` reads, so live integration tests (see
/// `june_api::live_local_tests`) can activate the local provider without a
/// running Tauri app.
#[cfg(test)]
pub(crate) fn replace_current_settings_for_tests(settings: ProviderModelSettings) {
    replace_current_settings(settings);
}

/// Test-only companion to [`replace_current_settings_for_tests`]: the default
/// (remote) settings, for restoring the store after a live test.
#[cfg(test)]
pub(crate) fn default_settings_for_tests() -> ProviderModelSettings {
    default_settings()
}

fn default_settings() -> ProviderModelSettings {
    ProviderModelSettings {
        transcription_provider: PROVIDER_VENICE.to_string(),
        generation_provider: PROVIDER_VENICE.to_string(),
        transcription_model: DEFAULT_TRANSCRIPTION_MODEL.to_string(),
        generation_model: default_generation_model_for_release(),
        cost_quality: DEFAULT_COST_QUALITY,
        remote_generation_model: default_generation_model_for_release(),
        image_model: DEFAULT_IMAGE_MODEL.to_string(),
        video_model: DEFAULT_VIDEO_MODEL.to_string(),
        venice_api_key: None,
        local_generation: LocalGenerationSettings::default(),
        image_safe_mode: true,
        image_safe_mode_prompt_dismissed: false,
        image_safe_mode_set_by_user: false,
        live_transcription: true,
        profile_overrides: BTreeMap::new(),
    }
}

fn default_live_transcription() -> bool {
    true
}

fn default_transcription_provider() -> String {
    PROVIDER_VENICE.to_string()
}

fn default_generation_provider() -> String {
    PROVIDER_VENICE.to_string()
}

fn default_transcription_model() -> String {
    DEFAULT_TRANSCRIPTION_MODEL.to_string()
}

fn default_generation_model() -> String {
    DEFAULT_GENERATION_MODEL.to_string()
}

fn default_cost_quality() -> u8 {
    DEFAULT_COST_QUALITY
}

fn default_generation_model_for_release() -> String {
    let enabled = option_env!("OS_JUNE_AUTO_MODE_DEFAULT")
        .is_some_and(|value| matches!(value.to_ascii_lowercase().as_str(), "1" | "true" | "yes"));
    if enabled {
        AUTO_GENERATION_MODEL.to_string()
    } else {
        DEFAULT_GENERATION_MODEL.to_string()
    }
}

fn default_image_model() -> String {
    DEFAULT_IMAGE_MODEL.to_string()
}

fn default_video_model() -> String {
    DEFAULT_VIDEO_MODEL.to_string()
}

fn default_image_safe_mode() -> bool {
    true
}

fn provider_settings_path(app: &AppHandle) -> Option<PathBuf> {
    crate::app_paths::app_config_dir(app)
        .ok()
        .map(provider_settings_path_from_config_dir)
}

fn provider_settings_path_from_config_dir(directory: PathBuf) -> PathBuf {
    directory.join("provider-settings.json")
}

fn provider_hermes_home(app: &AppHandle) -> Option<PathBuf> {
    crate::app_paths::app_data_dir(app)
        .ok()
        .map(|directory| directory.join("hermes"))
        .inspect(|path| {
            let _ = fs::create_dir_all(path);
        })
}

fn load_settings_from_disk(app: &AppHandle) -> ProviderModelSettings {
    let defaults = default_settings();
    let Some(path) = provider_settings_path(app) else {
        return defaults;
    };

    fs::read_to_string(path)
        .ok()
        .and_then(|settings| serde_json::from_str::<ProviderModelSettings>(&settings).ok())
        .map(|settings| sanitize_settings(settings, &defaults))
        .unwrap_or(defaults)
}

fn sanitize_settings(
    settings: ProviderModelSettings,
    defaults: &ProviderModelSettings,
) -> ProviderModelSettings {
    let transcription_model =
        non_empty_or(settings.transcription_model, &defaults.transcription_model);
    let mut remote_generation_model = non_empty_or(
        settings.remote_generation_model,
        &defaults.remote_generation_model,
    );
    let local_generation = sanitize_local_generation(settings.local_generation);
    let persisted_provider_local = settings.generation_provider == PROVIDER_LOCAL;
    let local_active =
        persisted_provider_local && local_generation_settings_configured(&local_generation);

    let generation_model = if local_active {
        local_generation.model_id.clone()
    } else if persisted_provider_local {
        // Local was selected but is no longer valid. Fall back to the remote
        // model. The persisted `generation_model` holds the stale LOCAL model
        // id, so it must not leak into the remote fallback.
        remote_generation_model.clone()
    } else {
        // Venice, legacy, or missing provider: honor the saved generation model
        // and back-fill remote_generation_model from it.
        let configured = non_empty_or(settings.generation_model, &remote_generation_model);
        remote_generation_model = configured.clone();
        configured
    };

    let image_safe_mode = if settings.image_safe_mode_set_by_user {
        settings.image_safe_mode
    } else {
        true
    };

    ProviderModelSettings {
        transcription_provider: transcription_provider_for_model(&transcription_model).to_string(),
        generation_provider: if local_active {
            PROVIDER_LOCAL.to_string()
        } else {
            PROVIDER_VENICE.to_string()
        },
        transcription_model,
        generation_model,
        cost_quality: settings.cost_quality.min(100),
        remote_generation_model,
        image_model: non_empty_or(settings.image_model, &defaults.image_model),
        video_model: sanitize_video_model(settings.video_model, &defaults.video_model),
        venice_api_key: normalize_api_key_option(settings.venice_api_key),
        local_generation,
        image_safe_mode,
        image_safe_mode_prompt_dismissed: settings.image_safe_mode_prompt_dismissed,
        image_safe_mode_set_by_user: settings.image_safe_mode_set_by_user,
        live_transcription: settings.live_transcription,
        profile_overrides: sanitize_profile_overrides(settings.profile_overrides),
    }
}

fn sanitize_profile_overrides(
    overrides: BTreeMap<String, ProfileModelOverrides>,
) -> BTreeMap<String, ProfileModelOverrides> {
    overrides
        .into_iter()
        .filter_map(|(profile, overrides)| {
            let profile = validate_profile_override_name(&profile).ok()?.to_string();
            let overrides = ProfileModelOverrides {
                transcription_provider: normalize_optional_model_field(
                    overrides.transcription_provider,
                ),
                transcription_model: normalize_optional_model_field(overrides.transcription_model),
                image_model: normalize_optional_model_field(overrides.image_model),
                video_model: normalize_optional_model_field(overrides.video_model),
            };
            (!profile_overrides_empty(&overrides)).then_some((profile, overrides))
        })
        .collect()
}

/// Migrates a persisted video model that is no longer curated (for example the
/// delisted Seedance default older installs saved) to the current default, so an
/// updated install never carries a stale id that June API rejects as
/// `model_not_priced`. A recognized selection is kept; empty falls back to the
/// default like the other model fields.
fn sanitize_video_model(persisted: String, default: &str) -> String {
    let candidate = non_empty_or(persisted, default);
    if KNOWN_VIDEO_MODELS.contains(&candidate.as_str()) {
        candidate
    } else {
        default.to_string()
    }
}

fn normalize_api_key_option(value: Option<String>) -> Option<String> {
    value.and_then(|value| normalize_api_key_for_save(&value))
}

fn normalize_api_key_for_save(value: &str) -> Option<String> {
    let value = normalize_api_key(value)?;
    if value.chars().count() > MAX_VENICE_API_KEY_CHARS || value.chars().any(char::is_control) {
        None
    } else {
        Some(value)
    }
}

fn normalize_api_key(value: &str) -> Option<String> {
    let value = value.trim();
    if value.is_empty() {
        None
    } else {
        Some(value.to_string())
    }
}

fn validate_venice_api_key_format(value: &str) -> Result<(), AppError> {
    if value.chars().count() > MAX_VENICE_API_KEY_CHARS
        || value.chars().any(|character| character.is_control())
    {
        return Err(AppError::new(
            "venice_api_key_invalid",
            "Enter a valid Venice API key.",
        ));
    }
    Ok(())
}

async fn verify_venice_api_key(api_key: &str) -> Result<(), AppError> {
    let url = format!("{VENICE_API_BASE_URL}/models");
    let response = venice_verify_http_client()
        .get(&url)
        .query(&[("type", "text")])
        .bearer_auth(api_key)
        .send()
        .await
        .map_err(|_| {
            AppError::new(
                "venice_api_key_verification_failed",
                "Could not verify the Venice API key. Check your connection and try again.",
            )
        })?;
    match response.status() {
        reqwest::StatusCode::OK => Ok(()),
        reqwest::StatusCode::UNAUTHORIZED | reqwest::StatusCode::FORBIDDEN => Err(AppError::new(
            "venice_api_key_rejected",
            "Venice rejected this API key. Check the key and try again.",
        )),
        _ => Err(AppError::new(
            "venice_api_key_verification_failed",
            "Could not verify the Venice API key. Try again later.",
        )),
    }
}

fn venice_verify_http_client() -> &'static reqwest::Client {
    VENICE_VERIFY_HTTP_CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .no_proxy()
            .timeout(VENICE_API_KEY_VERIFY_TIMEOUT)
            .pool_idle_timeout(Duration::from_secs(90))
            .tcp_keepalive(Some(Duration::from_secs(30)))
            .user_agent("os-june/0.1")
            .build()
            .unwrap_or_else(|_| reqwest::Client::new())
    })
}

fn non_empty_or(value: String, fallback: &str) -> String {
    let value = value.trim();
    if value.is_empty() {
        fallback.to_string()
    } else {
        value.to_string()
    }
}

fn normalize_optional_model_field(value: Option<String>) -> Option<String> {
    value
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn profile_overrides_empty(overrides: &ProfileModelOverrides) -> bool {
    overrides.transcription_provider.is_none()
        && overrides.transcription_model.is_none()
        && overrides.image_model.is_none()
        && overrides.video_model.is_none()
}

pub(crate) fn active_profile_for_hermes_home(hermes_home: &std::path::Path) -> String {
    fs::read_to_string(hermes_home.join("active_profile"))
        .ok()
        .map(|profile| profile.trim().to_string())
        .filter(|profile| !profile.is_empty())
        .unwrap_or_else(|| "default".to_string())
}

fn effective_settings_for_hermes_home(
    settings: &ProviderModelSettings,
    hermes_home: &std::path::Path,
) -> ProviderModelSettings {
    let active_profile = active_profile_for_hermes_home(hermes_home);
    effective_settings_for_profile(settings, &active_profile)
}

fn effective_settings_for_profile(
    settings: &ProviderModelSettings,
    profile: &str,
) -> ProviderModelSettings {
    let mut effective = settings.clone();
    let profile = profile.trim();
    if profile.is_empty() || profile == "default" {
        return effective;
    }
    let Some(overrides) = settings.profile_overrides.get(profile) else {
        return effective;
    };
    if let Some(provider) = overrides.transcription_provider.as_deref() {
        effective.transcription_provider = provider.to_string();
    }
    if let Some(model) = overrides.transcription_model.as_deref() {
        effective.transcription_model = model.to_string();
    }
    if let Some(model) = overrides.image_model.as_deref() {
        effective.image_model = model.to_string();
    }
    if let Some(model) = overrides.video_model.as_deref() {
        effective.video_model = model.to_string();
    }
    effective
}

fn validate_profile_override_name(profile: &str) -> Result<&str, AppError> {
    let profile = profile.trim();
    if profile == "default" {
        return Err(AppError::new(
            "profile_model_overrides_default_profile",
            "The default profile uses global model settings.",
        ));
    }
    if !is_safe_profile_name(profile) {
        return Err(AppError::new(
            "profile_model_overrides_invalid_profile",
            "Invalid Hermes profile.",
        ));
    }
    Ok(profile)
}

fn is_safe_profile_name(name: &str) -> bool {
    if name.is_empty() || name.len() > 64 {
        return false;
    }
    let mut chars = name.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    if !first.is_ascii_alphanumeric() {
        return false;
    }
    name.chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-')
}

fn update_settings(
    state: &ProviderSettingsState,
    update: impl FnOnce(&mut ProviderModelSettings),
) -> Result<ProviderModelSettingsDto, AppError> {
    update_settings_result(state, |settings| {
        update(settings);
        Ok(())
    })
}

/// Like [`update_settings`] but lets the closure reject the change. The closure
/// must perform every fallible check before mutating `settings`, so an early
/// error leaves the persisted state untouched (nothing is saved on `Err`).
fn update_settings_result(
    state: &ProviderSettingsState,
    update: impl FnOnce(&mut ProviderModelSettings) -> Result<(), AppError>,
) -> Result<ProviderModelSettingsDto, AppError> {
    let mut settings = state
        .settings
        .lock()
        .map_err(|_| AppError::new("provider_settings_unavailable", "Settings lock failed."))?;
    update(&mut settings)?;
    save_settings(state, &settings)?;
    replace_current_settings(settings.clone());
    Ok(ProviderModelSettingsDto::from(&*settings))
}

fn save_settings(
    state: &ProviderSettingsState,
    settings: &ProviderModelSettings,
) -> Result<(), AppError> {
    if let Some(parent) = state.path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| AppError::new("provider_settings_save_failed", error.to_string()))?;
    }
    let serialized = serde_json::to_string_pretty(settings)
        .map_err(|error| AppError::new("provider_settings_save_failed", error.to_string()))?;
    fs::write(&state.path, serialized)
        .map_err(|error| AppError::new("provider_settings_save_failed", error.to_string()))
}

fn sanitize_local_generation(settings: LocalGenerationSettings) -> LocalGenerationSettings {
    // Only genuinely unparseable / wrong-scheme values sanitize to empty. A
    // valid http(s) URL is preserved regardless of host (bring your own
    // inference: LAN Ollama, vLLM, etc.).
    let base_url = normalize_local_base_url(&settings.base_url).unwrap_or_default();
    LocalGenerationSettings {
        base_url,
        model_id: settings.model_id.trim().to_string(),
        api_key: settings.api_key.trim().to_string(),
    }
}

fn local_generation_settings_configured(settings: &LocalGenerationSettings) -> bool {
    !settings.base_url.trim().is_empty() && !settings.model_id.trim().is_empty()
}

/// Validates a local model base URL. Accepts any http/https URL that has a
/// host (trailing slashes trimmed). The loopback-only restriction was removed
/// so LAN endpoints work; the frontend surfaces the "requests leave your
/// device" warning.
fn normalize_local_base_url(value: &str) -> Result<String, AppError> {
    let trimmed = value.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return Err(AppError::new(
            "local_model_base_url_required",
            "Enter a local model endpoint.",
        ));
    }
    let parsed = reqwest::Url::parse(trimmed).map_err(|_| {
        AppError::new(
            "local_model_base_url_invalid",
            "Enter a valid local model endpoint.",
        )
    })?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(AppError::new(
            "local_model_base_url_invalid",
            "Use an http or https local model endpoint.",
        ));
    }
    if parsed.host_str().is_none() {
        return Err(AppError::new(
            "local_model_base_url_invalid",
            "Enter a local model endpoint with a host.",
        ));
    }
    Ok(trimmed.to_string())
}

fn selected_model_for_mode(
    state: &ProviderSettingsState,
    mode: ModelMode,
) -> Result<String, AppError> {
    let settings = state
        .settings
        .lock()
        .map_err(|_| AppError::new("provider_settings_unavailable", "Settings lock failed."))?;
    Ok(match mode {
        ModelMode::Transcription => settings.transcription_model.clone(),
        ModelMode::Generation => settings.generation_model.clone(),
        ModelMode::Image => settings.image_model.clone(),
        ModelMode::Video => settings.video_model.clone(),
    })
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ModelMode {
    Transcription,
    Generation,
    Image,
    Video,
}

impl<'de> Deserialize<'de> for ModelMode {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Self::parse(&value).ok_or_else(|| serde::de::Error::custom("unknown provider model mode"))
    }
}

impl ModelMode {
    fn api_type(self) -> &'static str {
        match self {
            Self::Transcription => "asr",
            Self::Generation => "text",
            Self::Image => "image",
            Self::Video => "video",
        }
    }

    fn parse(value: &str) -> Option<Self> {
        match value.trim() {
            "transcription" | "dictation" | "asr" => Some(Self::Transcription),
            "generation" | "notes" | "text" => Some(Self::Generation),
            "image" | "images" => Some(Self::Image),
            "video" | "videos" => Some(Self::Video),
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_settings_path_derives_from_the_isolated_config_dir() {
        let isolated_config_dir = PathBuf::from("/tmp/co.opensoftware.june-dev");

        assert_eq!(
            provider_settings_path_from_config_dir(isolated_config_dir),
            PathBuf::from("/tmp/co.opensoftware.june-dev/provider-settings.json")
        );
    }

    #[test]
    fn legacy_settings_default_cost_quality_to_higher_quality() {
        let settings: ProviderModelSettings =
            serde_json::from_value(serde_json::json!({})).unwrap();
        assert_eq!(settings.cost_quality, 100);
    }

    #[test]
    fn capabilities_include_vision_matches_normalized_supports_vision() {
        // Mirrors the frontend `modelSupportsImageInput`: normalize (lowercase,
        // strip non-letters) then match `supportsvision`, so a rename to
        // snake_case still resolves. Never keys off marketing `traits`.
        assert!(capabilities_include_vision(&["supportsVision".to_string()]));
        assert!(capabilities_include_vision(&[
            "supportsTools".to_string(),
            "supports_vision".to_string(),
        ]));
        assert!(!capabilities_include_vision(&["supportsTools".to_string()]));
        assert!(!capabilities_include_vision(&[]));
    }

    #[test]
    fn generation_vision_uses_selected_catalog_model() {
        let vision = vec!["supportsVision".to_string()];

        assert!(generation_model_supports_vision_from_catalog(
            "vision-model",
            false,
            [("vision-model", vision.as_slice())],
        ));
    }

    #[test]
    fn generation_vision_local_auto_uses_catalog_backed_kimi_when_auto_is_absent() {
        let compatible = vec![
            "supportsVision".to_string(),
            "supportsFunctionCalling".to_string(),
        ];

        assert!(generation_model_supports_vision_from_catalog(
            AUTO_GENERATION_MODEL,
            true,
            [(LOCAL_AUTO_VISION_FALLBACK_MODEL, compatible.as_slice())],
        ));
    }

    #[test]
    fn generation_vision_non_local_auto_does_not_use_kimi_fallback() {
        let compatible = vec![
            "supportsVision".to_string(),
            "supportsFunctionCalling".to_string(),
        ];

        assert!(!generation_model_supports_vision_from_catalog(
            AUTO_GENERATION_MODEL,
            false,
            [(LOCAL_AUTO_VISION_FALLBACK_MODEL, compatible.as_slice())],
        ));
    }

    #[test]
    fn generation_vision_local_auto_rejects_kimi_without_tool_support() {
        let vision_only = vec!["supportsVision".to_string()];

        assert!(!generation_model_supports_vision_from_catalog(
            AUTO_GENERATION_MODEL,
            true,
            [(LOCAL_AUTO_VISION_FALLBACK_MODEL, vision_only.as_slice())],
        ));
    }

    #[test]
    fn generation_vision_local_auto_accepts_an_alternate_compatible_model() {
        let compatible = vec![
            "parent.supportsVision".to_string(),
            "features.toolCalling".to_string(),
        ];

        assert!(generation_model_supports_vision_from_catalog(
            AUTO_GENERATION_MODEL,
            true,
            [("replacement-model", compatible.as_slice())],
        ));
    }

    #[test]
    fn generation_vision_local_auto_without_catalog_fallback_is_false() {
        assert!(!generation_model_supports_vision_from_catalog(
            AUTO_GENERATION_MODEL,
            true,
            std::iter::empty(),
        ));
    }

    #[test]
    fn generation_vision_present_auto_wins_over_local_kimi_fallback() {
        let compatible = vec![
            "supportsVision".to_string(),
            "supportsFunctionCalling".to_string(),
        ];
        let no_capabilities = Vec::new();

        assert!(!generation_model_supports_vision_from_catalog(
            AUTO_GENERATION_MODEL,
            true,
            [
                (LOCAL_AUTO_VISION_FALLBACK_MODEL, compatible.as_slice()),
                (AUTO_GENERATION_MODEL, no_capabilities.as_slice()),
            ],
        ));
    }

    #[test]
    fn generation_vision_local_auto_requires_a_compatible_catalog_model() {
        let no_capabilities = Vec::new();

        assert!(!generation_model_supports_vision_from_catalog(
            AUTO_GENERATION_MODEL,
            true,
            [(LOCAL_AUTO_VISION_FALLBACK_MODEL, no_capabilities.as_slice(),)],
        ));
    }

    #[test]
    fn model_mode_deserializes_canonical_values() {
        assert_eq!(
            serde_json::from_value::<ModelMode>(serde_json::json!("transcription")).unwrap(),
            ModelMode::Transcription
        );
        assert_eq!(
            serde_json::from_value::<ModelMode>(serde_json::json!("generation")).unwrap(),
            ModelMode::Generation
        );
    }

    #[test]
    fn model_mode_deserializes_legacy_aliases() {
        assert_eq!(
            serde_json::from_value::<ModelMode>(serde_json::json!("asr")).unwrap(),
            ModelMode::Transcription
        );
        assert_eq!(
            serde_json::from_value::<ModelMode>(serde_json::json!("notes")).unwrap(),
            ModelMode::Generation
        );
    }

    #[test]
    fn model_mode_deserializes_image() {
        assert_eq!(
            serde_json::from_value::<ModelMode>(serde_json::json!("image")).unwrap(),
            ModelMode::Image
        );
    }

    #[test]
    fn model_mode_deserializes_video() {
        assert_eq!(
            serde_json::from_value::<ModelMode>(serde_json::json!("video")).unwrap(),
            ModelMode::Video
        );
    }

    #[test]
    fn video_generation_guard_returns_disabled_error() {
        let error = ensure_video_generation_enabled(false).unwrap_err();

        assert_eq!(error.code, "video_generation_disabled");
        assert_eq!(error.message, "Video generation is not available.");
        assert!(ensure_video_generation_enabled(true).is_ok());
    }

    #[test]
    fn video_status_returns_disabled_error_before_job_validation() {
        let error = video_status_job_id_with_enabled(
            VideoStatusRequest {
                job_id: "job-123".to_string(),
            },
            false,
        )
        .unwrap_err();

        assert_eq!(error.code, "video_generation_disabled");
        assert_eq!(error.message, "Video generation is not available.");
    }

    #[test]
    fn provider_settings_deserialize_defaults_missing_image_model() {
        // A provider-settings.json written before image generation existed has
        // no `imageModel` field; it must still load with the default.
        let settings: ProviderModelSettings = serde_json::from_value(serde_json::json!({
            "transcriptionProvider": "venice",
            "transcriptionModel": "nvidia/parakeet-tdt-0.6b-v3",
            "generationModel": "zai-org-glm-5-2"
        }))
        .unwrap();
        assert_eq!(settings.image_model, DEFAULT_IMAGE_MODEL);
    }

    #[test]
    fn provider_settings_deserialize_pre_profile_overrides_fixture() {
        let fixture = r#"{
          "transcriptionProvider": "venice",
          "generationProvider": "venice",
          "transcriptionModel": "nvidia/parakeet-tdt-0.6b-v3",
          "generationModel": "zai-org-glm-5-2",
          "remoteGenerationModel": "zai-org-glm-5-2",
          "imageModel": "venice-sd35",
          "localGeneration": {
            "baseUrl": "",
            "modelId": "",
            "apiKey": ""
          },
          "imageSafeMode": true,
          "imageSafeModePromptDismissed": false,
          "imageSafeModeSetByUser": true
        }"#;

        let settings: ProviderModelSettings = serde_json::from_str(fixture).unwrap();
        assert!(settings.profile_overrides.is_empty());

        let round_tripped = serde_json::to_string(&settings).unwrap();
        let reparsed: ProviderModelSettings = serde_json::from_str(&round_tripped).unwrap();
        assert_eq!(reparsed, settings);
        assert!(!round_tripped.contains("profileOverrides"));
    }

    #[test]
    fn default_settings_enable_image_safe_mode_without_prompt_dismissal() {
        let settings = default_settings();

        assert!(settings.image_safe_mode);
        assert!(!settings.image_safe_mode_prompt_dismissed);
        assert!(!settings.image_safe_mode_set_by_user);
    }

    #[test]
    fn provider_settings_deserialize_defaults_missing_image_safe_mode_fields() {
        let settings = serde_json::from_value::<ProviderModelSettings>(serde_json::json!({
            "transcriptionProvider": "venice",
            "transcriptionModel": "nvidia/parakeet-tdt-0.6b-v3",
            "generationModel": "zai-org-glm-5-2",
            "imageModel": "venice-sd35"
        }))
        .unwrap();
        let settings = sanitize_settings(settings, &default_settings());

        assert!(settings.image_safe_mode);
        assert!(!settings.image_safe_mode_prompt_dismissed);
        assert!(!settings.image_safe_mode_set_by_user);
    }

    #[test]
    fn provider_settings_coerces_legacy_image_safe_mode_false_without_user_marker() {
        let settings = serde_json::from_value::<ProviderModelSettings>(serde_json::json!({
            "transcriptionProvider": "venice",
            "transcriptionModel": "nvidia/parakeet-tdt-0.6b-v3",
            "generationModel": "zai-org-glm-5-2",
            "imageModel": "venice-sd35",
            "imageSafeMode": false
        }))
        .unwrap();
        let settings = sanitize_settings(settings, &default_settings());

        assert!(settings.image_safe_mode);
        assert!(!settings.image_safe_mode_set_by_user);
    }

    #[test]
    fn provider_settings_preserves_image_safe_mode_false_with_user_marker() {
        let settings = serde_json::from_value::<ProviderModelSettings>(serde_json::json!({
            "transcriptionProvider": "venice",
            "transcriptionModel": "nvidia/parakeet-tdt-0.6b-v3",
            "generationModel": "zai-org-glm-5-2",
            "imageModel": "venice-sd35",
            "imageSafeMode": false,
            "imageSafeModeSetByUser": true
        }))
        .unwrap();
        let settings = sanitize_settings(settings, &default_settings());

        assert!(!settings.image_safe_mode);
        assert!(settings.image_safe_mode_set_by_user);
    }

    #[test]
    fn default_settings_enable_live_transcription() {
        assert!(default_settings().live_transcription);
    }

    #[test]
    fn provider_settings_deserialize_defaults_missing_live_transcription_field() {
        // Files written by builds before JUN-375 carry no `liveTranscription`
        // key; the serde default keeps the preview on for them.
        let settings = serde_json::from_value::<ProviderModelSettings>(serde_json::json!({
            "transcriptionProvider": "venice",
            "transcriptionModel": "nvidia/parakeet-tdt-0.6b-v3",
            "generationModel": "zai-org-glm-5-2",
            "imageModel": "venice-sd35"
        }))
        .unwrap();

        assert!(settings.live_transcription);
    }

    #[test]
    fn set_live_transcription_persists_the_toggle() {
        let state = test_state();

        let updated =
            set_live_transcription_impl(&state, SetLiveTranscriptionRequest { enabled: false })
                .unwrap();
        assert!(!updated.live_transcription);
        let saved: ProviderModelSettings =
            serde_json::from_str(&fs::read_to_string(&state.path).unwrap()).unwrap();
        assert!(!saved.live_transcription);

        let updated =
            set_live_transcription_impl(&state, SetLiveTranscriptionRequest { enabled: true })
                .unwrap();
        assert!(updated.live_transcription);
        let saved: ProviderModelSettings =
            serde_json::from_str(&fs::read_to_string(&state.path).unwrap()).unwrap();
        assert!(saved.live_transcription);
    }

    #[test]
    fn venice_models_response_serializes_canonical_mode() {
        let response = VeniceModelsResponse {
            mode: ModelMode::Transcription,
            model_type: "asr".to_string(),
            selected_model: "nvidia/parakeet-tdt-0.6b-v3".to_string(),
            models: Vec::new(),
        };

        assert_eq!(
            serde_json::to_value(response).unwrap()["mode"],
            serde_json::json!("transcription")
        );
    }

    #[test]
    fn provider_settings_deserialize_legacy_shape() {
        let settings = serde_json::from_value::<ProviderModelSettings>(serde_json::json!({
            "transcriptionProvider": "venice",
            "transcriptionModel": "nvidia/parakeet-tdt-0.6b-v3",
            "generationModel": "custom-remote-model"
        }))
        .unwrap();
        let sanitized = sanitize_settings(settings, &default_settings());

        assert_eq!(sanitized.generation_provider, PROVIDER_VENICE);
        assert_eq!(sanitized.generation_model, "custom-remote-model");
        assert_eq!(sanitized.remote_generation_model, "custom-remote-model");
    }

    #[test]
    fn venice_api_key_format_treats_credentials_as_opaque() {
        assert!(validate_venice_api_key_format("VENICE_INFERENCE_KEY_valid").is_ok());
        assert!(validate_venice_api_key_format("VENICE_ADMIN_KEY_valid").is_ok());
        assert!(validate_venice_api_key_format("legacy-or-future-key-format").is_ok());
        assert_eq!(
            validate_venice_api_key_format("invalid\tkey")
                .unwrap_err()
                .code,
            "venice_api_key_invalid"
        );
        assert_eq!(
            validate_venice_api_key_format(&"x".repeat(MAX_VENICE_API_KEY_CHARS + 1))
                .unwrap_err()
                .code,
            "venice_api_key_invalid"
        );
    }

    #[test]
    fn sanitize_settings_preserves_legacy_venice_api_key_for_actionable_error() {
        let settings = ProviderModelSettings {
            venice_api_key: Some("not-a-venice-inference-key".to_string()),
            ..default_settings()
        };
        let sanitized = sanitize_settings(settings, &default_settings());

        assert_eq!(
            sanitized.venice_api_key.as_deref(),
            Some("not-a-venice-inference-key")
        );
    }

    #[test]
    fn sanitize_settings_migrates_delisted_video_model_to_default() {
        // Older installs persisted the Seedance default while the video UI was
        // flag-hidden; after it was delisted the stale id must not survive load.
        let settings = ProviderModelSettings {
            video_model: "seedance-2-0-fast-text-to-video".to_string(),
            ..default_settings()
        };
        let sanitized = sanitize_settings(settings, &default_settings());
        assert_eq!(sanitized.video_model, DEFAULT_VIDEO_MODEL);
    }

    #[test]
    fn sanitize_settings_keeps_a_curated_video_model() {
        // A non-default curated id must survive load unchanged — otherwise the
        // allowlist would silently collapse every pick to the default.
        let curated = "grok-imagine-text-to-video-private";
        assert!(KNOWN_VIDEO_MODELS.contains(&curated));
        let settings = ProviderModelSettings {
            video_model: curated.to_string(),
            ..default_settings()
        };
        let sanitized = sanitize_settings(settings, &default_settings());
        assert_eq!(sanitized.video_model, curated);
    }

    #[test]
    fn local_base_url_accepts_any_http_host() {
        assert_eq!(
            normalize_local_base_url("http://localhost:11434/v1").unwrap(),
            "http://localhost:11434/v1"
        );
        // Trailing slashes are trimmed.
        assert_eq!(
            normalize_local_base_url("http://127.0.0.1:1234/v1/").unwrap(),
            "http://127.0.0.1:1234/v1"
        );
        // LAN and public hosts are now allowed (bring your own inference).
        assert_eq!(
            normalize_local_base_url("http://192.168.1.5:11434/v1").unwrap(),
            "http://192.168.1.5:11434/v1"
        );
        assert_eq!(
            normalize_local_base_url("https://example.com/v1").unwrap(),
            "https://example.com/v1"
        );
    }

    #[test]
    fn local_base_url_rejects_empty_and_wrong_scheme() {
        assert_eq!(
            normalize_local_base_url("   ").unwrap_err().code,
            "local_model_base_url_required"
        );
        assert_eq!(
            normalize_local_base_url("ftp://localhost/v1")
                .unwrap_err()
                .code,
            "local_model_base_url_invalid"
        );
        assert_eq!(
            normalize_local_base_url("not a url").unwrap_err().code,
            "local_model_base_url_invalid"
        );
    }

    #[test]
    fn invalid_saved_local_settings_do_not_activate() {
        // A genuinely unparseable base_url cannot activate local generation, and
        // the stale local model id must not leak into the remote fallback.
        let settings = ProviderModelSettings {
            generation_provider: PROVIDER_LOCAL.to_string(),
            generation_model: "llama3.1:8b".to_string(),
            remote_generation_model: "remote-model".to_string(),
            local_generation: LocalGenerationSettings {
                base_url: "not a url".to_string(),
                model_id: "llama3.1:8b".to_string(),
                api_key: String::new(),
            },
            ..default_settings()
        };
        let sanitized = sanitize_settings(settings, &default_settings());

        assert_eq!(sanitized.generation_provider, PROVIDER_VENICE);
        assert_eq!(sanitized.local_generation.base_url, "");
        assert_eq!(sanitized.generation_model, "remote-model");
        assert_eq!(sanitized.remote_generation_model, "remote-model");
    }

    #[test]
    fn lan_local_settings_activate() {
        let settings = ProviderModelSettings {
            generation_provider: PROVIDER_LOCAL.to_string(),
            generation_model: "llama3.1:8b".to_string(),
            remote_generation_model: "remote-model".to_string(),
            local_generation: LocalGenerationSettings {
                base_url: "http://192.168.1.5:11434/v1".to_string(),
                model_id: "llama3.1:8b".to_string(),
                api_key: "secret".to_string(),
            },
            ..default_settings()
        };
        let sanitized = sanitize_settings(settings, &default_settings());

        assert_eq!(sanitized.generation_provider, PROVIDER_LOCAL);
        assert_eq!(sanitized.generation_model, "llama3.1:8b");
        assert_eq!(
            sanitized.local_generation.base_url,
            "http://192.168.1.5:11434/v1"
        );
        assert_eq!(sanitized.local_generation.api_key, "secret");
    }

    #[test]
    fn parse_local_models_response_reads_openai_shape() {
        let body = serde_json::to_vec(&serde_json::json!({
            "object": "list",
            "data": [
                { "id": "llama3.1:8b", "object": "model", "owned_by": "meta" },
                { "id": "qwen2.5:14b" }
            ]
        }))
        .unwrap();
        let probe = parse_local_models_response(&body).unwrap();
        assert_eq!(probe.models, vec!["llama3.1:8b", "qwen2.5:14b"]);
    }

    #[test]
    fn parse_local_models_response_tolerates_missing_ids() {
        let body = serde_json::to_vec(&serde_json::json!({
            "data": [ { "id": "keep" }, { "object": "model" } ]
        }))
        .unwrap();
        let probe = parse_local_models_response(&body).unwrap();
        assert_eq!(probe.models, vec!["keep"]);
    }

    #[test]
    fn parse_local_models_response_rejects_unexpected_shape() {
        assert_eq!(
            parse_local_models_response(b"not json").unwrap_err().code,
            "local_endpoint_invalid_response"
        );
        let body = serde_json::to_vec(&serde_json::json!({ "models": [] })).unwrap();
        assert_eq!(
            parse_local_models_response(&body).unwrap_err().code,
            "local_endpoint_invalid_response"
        );
    }

    fn test_state() -> ProviderSettingsState {
        let dir = std::env::temp_dir().join(format!(
            "os-june-provider-test-{}-{}",
            std::process::id(),
            NEXT_TEST_ID.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        ProviderSettingsState {
            path: dir.join("provider-settings.json"),
            hermes_home: dir.join("hermes"),
            settings: Mutex::new(default_settings()),
        }
    }

    static NEXT_TEST_ID: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

    #[test]
    fn active_profile_defaults_for_missing_empty_and_unreadable_file() {
        let state = test_state();

        assert_eq!(
            active_profile_for_hermes_home(&state.hermes_home),
            "default"
        );

        fs::create_dir_all(&state.hermes_home).unwrap();
        fs::write(state.hermes_home.join("active_profile"), "   \n").unwrap();
        assert_eq!(
            active_profile_for_hermes_home(&state.hermes_home),
            "default"
        );

        fs::remove_file(state.hermes_home.join("active_profile")).unwrap();
        fs::create_dir(state.hermes_home.join("active_profile")).unwrap();
        assert_eq!(
            active_profile_for_hermes_home(&state.hermes_home),
            "default"
        );
    }

    #[test]
    fn profile_overrides_resolve_fallbacks_and_partial_overrides() {
        let state = test_state();
        fs::create_dir_all(&state.hermes_home).unwrap();
        fs::write(state.hermes_home.join("active_profile"), "writing\n").unwrap();

        let mut settings = default_settings();
        settings.transcription_provider = PROVIDER_VENICE.to_string();
        settings.transcription_model = "global-asr".to_string();
        settings.image_model = "global-image".to_string();
        settings.video_model = "global-video".to_string();
        settings.profile_overrides.insert(
            "writing".to_string(),
            ProfileModelOverrides {
                transcription_provider: Some(PROVIDER_OPENAI.to_string()),
                transcription_model: Some("gpt-4o-transcribe".to_string()),
                image_model: None,
                video_model: Some("profile-video".to_string()),
            },
        );

        let effective = effective_settings_for_hermes_home(&settings, &state.hermes_home);
        assert_eq!(effective.transcription_provider, PROVIDER_OPENAI);
        assert_eq!(effective.transcription_model, "gpt-4o-transcribe");
        assert_eq!(effective.image_model, "global-image");
        assert_eq!(effective.video_model, "profile-video");

        fs::write(state.hermes_home.join("active_profile"), "unknown\n").unwrap();
        let effective = effective_settings_for_hermes_home(&settings, &state.hermes_home);
        assert_eq!(effective.transcription_provider, PROVIDER_VENICE);
        assert_eq!(effective.transcription_model, "global-asr");
        assert_eq!(effective.image_model, "global-image");
        assert_eq!(effective.video_model, "global-video");

        fs::remove_file(state.hermes_home.join("active_profile")).unwrap();
        let effective = effective_settings_for_hermes_home(&settings, &state.hermes_home);
        assert_eq!(effective.transcription_model, "global-asr");
    }

    #[test]
    fn profile_overrides_skip_default_profile() {
        let mut settings = default_settings();
        settings.transcription_model = "global-asr".to_string();
        settings.profile_overrides.insert(
            "default".to_string(),
            ProfileModelOverrides {
                transcription_provider: Some(PROVIDER_OPENAI.to_string()),
                transcription_model: Some("profile-asr".to_string()),
                image_model: Some("profile-image".to_string()),
                video_model: Some("profile-video".to_string()),
            },
        );

        let effective = effective_settings_for_profile(&settings, "default");
        assert_eq!(effective.transcription_provider, PROVIDER_VENICE);
        assert_eq!(effective.transcription_model, "global-asr");
        assert_eq!(effective.image_model, DEFAULT_IMAGE_MODEL);
    }

    #[test]
    fn profile_override_commands_write_validate_and_delete() {
        let state = test_state();

        set_profile_model_overrides_impl(
            &state,
            "research",
            ProfileModelOverridesDto {
                transcription_provider: Some(format!(" {PROVIDER_OPENAI} ")),
                transcription_model: Some(" gpt-4o-transcribe ".to_string()),
                image_model: Some(" profile-image ".to_string()),
                video_model: Some(" profile-video ".to_string()),
            },
        )
        .unwrap();

        let saved: ProviderModelSettings =
            serde_json::from_str(&fs::read_to_string(&state.path).unwrap()).unwrap();
        assert_eq!(
            saved
                .profile_overrides
                .get("research")
                .and_then(|overrides| overrides.transcription_provider.as_deref()),
            Some(PROVIDER_OPENAI)
        );
        assert_eq!(
            saved
                .profile_overrides
                .get("research")
                .and_then(|overrides| overrides.transcription_model.as_deref()),
            Some("gpt-4o-transcribe")
        );
        assert_eq!(
            saved
                .profile_overrides
                .get("research")
                .and_then(|overrides| overrides.video_model.as_deref()),
            Some("profile-video")
        );

        set_profile_model_overrides_impl(
            &state,
            "research",
            ProfileModelOverridesDto {
                transcription_provider: None,
                transcription_model: Some("whisper-1".to_string()),
                image_model: None,
                video_model: None,
            },
        )
        .unwrap();
        assert_eq!(
            state
                .settings
                .lock()
                .unwrap()
                .profile_overrides
                .get("research")
                .and_then(|overrides| overrides.transcription_provider.as_deref()),
            None
        );
        assert_eq!(
            state
                .settings
                .lock()
                .unwrap()
                .profile_overrides
                .get("research")
                .and_then(|overrides| overrides.transcription_model.as_deref()),
            Some("whisper-1")
        );

        delete_profile_model_overrides_impl(&state, "research").unwrap();
        assert!(!state
            .settings
            .lock()
            .unwrap()
            .profile_overrides
            .contains_key("research"));

        let error =
            set_profile_model_overrides_impl(&state, "--flag", ProfileModelOverridesDto::default())
                .unwrap_err();
        assert_eq!(error.code, "profile_model_overrides_invalid_profile");
    }

    #[test]
    fn profile_override_commands_reject_default() {
        let state = test_state();

        let error = set_profile_model_overrides_impl(
            &state,
            "default",
            ProfileModelOverridesDto {
                transcription_provider: Some(PROVIDER_OPENAI.to_string()),
                transcription_model: None,
                image_model: None,
                video_model: None,
            },
        )
        .unwrap_err();

        assert_eq!(error.code, "profile_model_overrides_default_profile");
    }

    #[test]
    fn set_image_safe_mode_true_resets_dismissed_prompt() {
        let state = test_state();
        {
            let mut settings = state.settings.lock().unwrap();
            settings.image_safe_mode = false;
            settings.image_safe_mode_prompt_dismissed = true;
        }

        let updated =
            set_image_safe_mode_impl(&state, SetImageSafeModeRequest { enabled: true }).unwrap();

        assert!(updated.image_safe_mode);
        assert!(!updated.image_safe_mode_prompt_dismissed);
        let saved: ProviderModelSettings =
            serde_json::from_str(&fs::read_to_string(&state.path).unwrap()).unwrap();
        assert!(saved.image_safe_mode);
        assert!(!saved.image_safe_mode_prompt_dismissed);
        assert!(saved.image_safe_mode_set_by_user);
    }

    #[test]
    fn set_image_safe_mode_false_persists_user_marker_and_reloads_false() {
        let state = test_state();

        let updated =
            set_image_safe_mode_impl(&state, SetImageSafeModeRequest { enabled: false }).unwrap();

        assert!(!updated.image_safe_mode);
        let saved: ProviderModelSettings =
            serde_json::from_str(&fs::read_to_string(&state.path).unwrap()).unwrap();
        assert!(!saved.image_safe_mode);
        assert!(saved.image_safe_mode_set_by_user);

        let reloaded = sanitize_settings(saved, &default_settings());
        assert!(!reloaded.image_safe_mode);
        assert!(reloaded.image_safe_mode_set_by_user);
    }

    #[test]
    fn set_image_safe_mode_prompt_dismissed_persists_flag_without_touching_user_marker() {
        let state = test_state();
        {
            let mut settings = state.settings.lock().unwrap();
            settings.image_safe_mode_set_by_user = true;
        }

        let updated = set_image_safe_mode_prompt_dismissed_impl(
            &state,
            SetImageSafeModePromptDismissedRequest { dismissed: true },
        )
        .unwrap();

        assert!(updated.image_safe_mode_prompt_dismissed);
        let saved: ProviderModelSettings =
            serde_json::from_str(&fs::read_to_string(&state.path).unwrap()).unwrap();
        assert!(saved.image_safe_mode_prompt_dismissed);
        assert!(saved.image_safe_mode_set_by_user);
    }

    #[test]
    fn save_local_generation_settings_persists_without_activating() {
        let state = test_state();
        let updated = save_local_generation_settings_impl(
            &state,
            SaveLocalGenerationSettingsRequest {
                base_url: "http://192.168.1.5:11434/v1/".to_string(),
                model_id: "  llama3.1:8b  ".to_string(),
                api_key: "  secret  ".to_string(),
            },
        )
        .unwrap();

        // Provider is untouched; endpoint is stored trimmed and normalized.
        assert_eq!(updated.generation_provider, PROVIDER_VENICE);
        assert_eq!(
            updated.local_generation.base_url,
            "http://192.168.1.5:11434/v1"
        );
        assert_eq!(updated.local_generation.model_id, "llama3.1:8b");
        assert_eq!(updated.local_generation.api_key, "secret");
    }

    #[test]
    fn save_local_generation_settings_rejects_invalid_url_without_wiping() {
        let state = test_state();
        // Seed a valid saved endpoint.
        save_local_generation_settings_impl(
            &state,
            SaveLocalGenerationSettingsRequest {
                base_url: "http://localhost:11434/v1".to_string(),
                model_id: "llama3.1:8b".to_string(),
                api_key: String::new(),
            },
        )
        .unwrap();

        let error = save_local_generation_settings_impl(
            &state,
            SaveLocalGenerationSettingsRequest {
                base_url: "not a url".to_string(),
                model_id: "llama3.1:8b".to_string(),
                api_key: String::new(),
            },
        )
        .unwrap_err();
        assert_eq!(error.code, "local_model_base_url_invalid");

        // The previously saved endpoint is intact, not wiped to "".
        let settings = state.settings.lock().unwrap();
        assert_eq!(
            settings.local_generation.base_url,
            "http://localhost:11434/v1"
        );
    }

    #[test]
    fn save_local_generation_settings_blocks_clearing_while_active() {
        let state = test_state();
        save_local_generation_settings_impl(
            &state,
            SaveLocalGenerationSettingsRequest {
                base_url: "http://localhost:11434/v1".to_string(),
                model_id: "llama3.1:8b".to_string(),
                api_key: String::new(),
            },
        )
        .unwrap();
        set_local_generation_enabled_impl(
            &state,
            SetLocalGenerationEnabledRequest { enabled: true },
        )
        .unwrap();

        let error = save_local_generation_settings_impl(
            &state,
            SaveLocalGenerationSettingsRequest {
                base_url: String::new(),
                model_id: String::new(),
                api_key: String::new(),
            },
        )
        .unwrap_err();
        assert_eq!(error.code, "local_model_in_use");

        // Endpoint remains configured after the rejected clear.
        let settings = state.settings.lock().unwrap();
        assert_eq!(settings.local_generation.model_id, "llama3.1:8b");
    }

    #[test]
    fn enable_disable_local_generation_round_trips_without_touching_endpoint() {
        let state = test_state();
        save_local_generation_settings_impl(
            &state,
            SaveLocalGenerationSettingsRequest {
                base_url: "http://localhost:11434/v1".to_string(),
                model_id: "llama3.1:8b".to_string(),
                api_key: "secret".to_string(),
            },
        )
        .unwrap();

        let enabled = set_local_generation_enabled_impl(
            &state,
            SetLocalGenerationEnabledRequest { enabled: true },
        )
        .unwrap();
        assert_eq!(enabled.generation_provider, PROVIDER_LOCAL);
        assert_eq!(enabled.generation_model, "llama3.1:8b");

        let disabled = set_local_generation_enabled_impl(
            &state,
            SetLocalGenerationEnabledRequest { enabled: false },
        )
        .unwrap();
        assert_eq!(disabled.generation_provider, PROVIDER_VENICE);
        assert_eq!(disabled.generation_model, DEFAULT_GENERATION_MODEL);
        // Disabling must NOT touch the stored endpoint.
        assert_eq!(
            disabled.local_generation.base_url,
            "http://localhost:11434/v1"
        );
        assert_eq!(disabled.local_generation.model_id, "llama3.1:8b");
        assert_eq!(disabled.local_generation.api_key, "secret");
    }

    #[test]
    fn enable_local_generation_requires_configuration() {
        let state = test_state();
        let error = set_local_generation_enabled_impl(
            &state,
            SetLocalGenerationEnabledRequest { enabled: true },
        )
        .unwrap_err();
        assert_eq!(error.code, "local_model_not_configured");
    }

    #[test]
    fn api_model_conversion_prefers_retail_price_description_display() {
        let model = VeniceModelDto::from(crate::june_api::ModelDto {
            provider: "openai".to_string(),
            id: "asr-model".to_string(),
            name: "ASR model".to_string(),
            model_type: "asr".to_string(),
            description: None,
            privacy: None,
            pricing: Some(serde_json::json!({ "display": "$0.001/sec audio" })),
            context_tokens: None,
            traits: Vec::new(),
            capabilities: Vec::new(),
            price_unit: "seconds".to_string(),
            price_description: "$0.00006 per second audio".to_string(),
            credits_per_million_seconds: Some(60_000),
            input_credits_per_million_tokens: None,
            output_credits_per_million_tokens: None,
        });

        assert_eq!(
            model.pricing.and_then(|pricing| pricing
                .get("display")
                .and_then(serde_json::Value::as_str)
                .map(str::to_string)),
            Some("$0.00006 per second audio".to_string())
        );
    }
}
