//! Model-picker state. The Tauri side persists which transcription /
//! generation models the user selected. Remote provider keys and URLs live in
//! June API; the opt-in "bring your own inference" local model stores an
//! OpenAI-compatible endpoint (any http/https host) here. Advanced users may
//! also store their own Venice API key locally; responses only expose whether
//! one is present, never the key itself.

use crate::domain::types::AppError;
use serde::{Deserialize, Deserializer, Serialize};
use std::{
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
pub const DEFAULT_IMAGE_MODEL: &str = "venice-sd35";
const MAX_VENICE_API_KEY_CHARS: usize = 4_096;

// Kept exported under the legacy names so existing callers compile until they
// migrate to the names above.
pub use PROVIDER_OPENAI as OPENAI_PROVIDER;
pub use PROVIDER_VENICE as VENICE_PROVIDER;

static MODEL_SETTINGS: OnceLock<Mutex<ProviderModelSettings>> = OnceLock::new();

pub struct ProviderSettingsState {
    path: PathBuf,
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
    #[serde(default = "default_generation_model")]
    pub remote_generation_model: String,
    // Defaulted so provider-settings.json files written before image
    // generation existed still deserialize (they predate this field).
    #[serde(default = "default_image_model")]
    pub image_model: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub venice_api_key: Option<String>,
    #[serde(default)]
    pub local_generation: LocalGenerationSettings,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LocalGenerationSettings {
    pub base_url: String,
    pub model_id: String,
    #[serde(default)]
    pub api_key: String,
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
    pub remote_generation_model: String,
    pub image_model: String,
    pub venice_api_key_configured: bool,
    pub local_generation: LocalGenerationSettings,
}

impl From<&ProviderModelSettings> for ProviderModelSettingsDto {
    fn from(settings: &ProviderModelSettings) -> Self {
        Self {
            transcription_provider: settings.transcription_provider.clone(),
            generation_provider: settings.generation_provider.clone(),
            transcription_model: settings.transcription_model.clone(),
            generation_model: settings.generation_model.clone(),
            remote_generation_model: settings.remote_generation_model.clone(),
            image_model: settings.image_model.clone(),
            venice_api_key_configured: settings
                .venice_api_key
                .as_deref()
                .is_some_and(|value| !value.trim().is_empty()),
            local_generation: settings.local_generation.clone(),
        }
    }
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProviderModelSettingsResponse {
    pub settings: ProviderModelSettingsDto,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SetVeniceModelRequest {
    pub mode: ModelMode,
    pub model_id: String,
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
    current_settings().transcription_provider
}

pub fn provider_configured() -> bool {
    crate::june_api::configured()
}

pub fn transcription_model() -> String {
    current_settings().transcription_model
}

pub fn generation_model() -> String {
    current_settings().generation_model
}

pub fn generation_provider() -> String {
    current_settings().generation_provider
}

pub fn local_generation_settings() -> LocalGenerationSettings {
    current_settings().local_generation
}

pub fn image_model() -> String {
    current_settings().image_model
}

pub fn venice_api_key() -> Option<String> {
    current_settings().venice_api_key
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
    Ok(ProviderModelSettingsResponse {
        settings: ProviderModelSettingsDto::from(&*settings),
    })
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
    })
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GenerateImageRequest {
    pub prompt: String,
    /// Optional model override; falls back to the saved default image model.
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
    crate::june_api::generate_image(prompt, model).await
}

#[tauri::command]
pub fn set_venice_api_key(
    state: State<'_, ProviderSettingsState>,
    request: SetVeniceApiKeyRequest,
) -> Result<ProviderModelSettingsDto, AppError> {
    let api_key = normalize_api_key_for_save(&request.api_key).ok_or_else(|| {
        AppError::new(
            "venice_api_key_required",
            "Enter a Venice API key before saving.",
        )
    })?;
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
    let settings = load_settings_from_disk(app.handle());
    replace_current_settings(settings.clone());
    app.manage(ProviderSettingsState {
        path,
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

fn settings_store() -> &'static Mutex<ProviderModelSettings> {
    MODEL_SETTINGS.get_or_init(|| Mutex::new(default_settings()))
}

fn replace_current_settings(settings: ProviderModelSettings) {
    if let Ok(mut current) = settings_store().lock() {
        *current = settings;
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
        generation_model: DEFAULT_GENERATION_MODEL.to_string(),
        remote_generation_model: DEFAULT_GENERATION_MODEL.to_string(),
        image_model: DEFAULT_IMAGE_MODEL.to_string(),
        venice_api_key: None,
        local_generation: LocalGenerationSettings::default(),
    }
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

fn default_image_model() -> String {
    DEFAULT_IMAGE_MODEL.to_string()
}

fn provider_settings_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|directory| directory.join("provider-settings.json"))
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

    ProviderModelSettings {
        transcription_provider: transcription_provider_for_model(&transcription_model).to_string(),
        generation_provider: if local_active {
            PROVIDER_LOCAL.to_string()
        } else {
            PROVIDER_VENICE.to_string()
        },
        transcription_model,
        generation_model,
        remote_generation_model,
        image_model: non_empty_or(settings.image_model, &defaults.image_model),
        venice_api_key: normalize_api_key_option(settings.venice_api_key),
        local_generation,
    }
}

fn normalize_api_key_option(value: Option<String>) -> Option<String> {
    value.and_then(|value| normalize_api_key_for_save(&value))
}

fn normalize_api_key_for_save(value: &str) -> Option<String> {
    let value = normalize_api_key(value)?;
    if value.chars().count() > MAX_VENICE_API_KEY_CHARS
        || value.chars().any(|character| character.is_control())
    {
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

fn non_empty_or(value: String, fallback: &str) -> String {
    let value = value.trim();
    if value.is_empty() {
        fallback.to_string()
    } else {
        value.to_string()
    }
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
    })
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ModelMode {
    Transcription,
    Generation,
    Image,
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
        }
    }

    fn parse(value: &str) -> Option<Self> {
        match value.trim() {
            "transcription" | "dictation" | "asr" => Some(Self::Transcription),
            "generation" | "notes" | "text" => Some(Self::Generation),
            "image" | "images" => Some(Self::Image),
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn model_mode_rejects_unknown_values() {
        assert!(serde_json::from_value::<ModelMode>(serde_json::json!("video")).is_err());
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
            settings: Mutex::new(default_settings()),
        }
    }

    static NEXT_TEST_ID: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

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
