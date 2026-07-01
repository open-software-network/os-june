//! Model-picker state. The Tauri side persists which transcription /
//! generation models the user selected. Advanced users may also store their
//! own Venice API key locally; responses only expose whether one is present.

use crate::domain::types::AppError;
use serde::{Deserialize, Deserializer, Serialize};
use std::{
    fs,
    path::PathBuf,
    sync::{Mutex, OnceLock},
};
use tauri::{AppHandle, Manager, State};

pub const PROVIDER_OPENAI: &str = "openai";
pub const PROVIDER_VENICE: &str = "venice";
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
    pub transcription_model: String,
    pub generation_model: String,
    // Defaulted so provider-settings.json files written before image
    // generation existed still deserialize (they predate this field).
    #[serde(default = "default_image_model")]
    pub image_model: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub venice_api_key: Option<String>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProviderModelSettingsDto {
    pub transcription_provider: String,
    pub transcription_model: String,
    pub generation_model: String,
    pub image_model: String,
    pub venice_api_key_configured: bool,
}

impl From<&ProviderModelSettings> for ProviderModelSettingsDto {
    fn from(settings: &ProviderModelSettings) -> Self {
        Self {
            transcription_provider: settings.transcription_provider.clone(),
            transcription_model: settings.transcription_model.clone(),
            generation_model: settings.generation_model.clone(),
            image_model: settings.image_model.clone(),
            venice_api_key_configured: settings
                .venice_api_key
                .as_deref()
                .is_some_and(|value| !value.trim().is_empty()),
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
                map.entry("display".to_string())
                    .or_insert_with(|| serde_json::Value::String(display.to_string()));
            }
            serde_json::Value::Object(map)
        }
        Some(value) => value,
        None => serde_json::json!({ "display": display }),
    }
}

pub fn configured_provider() -> String {
    PROVIDER_VENICE.to_string()
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
        ModelMode::Generation => settings.generation_model = model_id.to_string(),
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

fn default_settings() -> ProviderModelSettings {
    ProviderModelSettings {
        transcription_provider: PROVIDER_VENICE.to_string(),
        transcription_model: DEFAULT_TRANSCRIPTION_MODEL.to_string(),
        generation_model: DEFAULT_GENERATION_MODEL.to_string(),
        image_model: DEFAULT_IMAGE_MODEL.to_string(),
        venice_api_key: None,
    }
}

fn default_transcription_provider() -> String {
    PROVIDER_VENICE.to_string()
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
        .map(|settings| {
            let transcription_model =
                non_empty_or(settings.transcription_model, &defaults.transcription_model);
            ProviderModelSettings {
                transcription_provider: transcription_provider_for_model(&transcription_model)
                    .to_string(),
                transcription_model,
                generation_model: non_empty_or(
                    settings.generation_model,
                    &defaults.generation_model,
                ),
                image_model: non_empty_or(settings.image_model, &defaults.image_model),
                venice_api_key: normalize_api_key_option(settings.venice_api_key),
            }
        })
        .unwrap_or(defaults)
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
    let mut settings = state
        .settings
        .lock()
        .map_err(|_| AppError::new("provider_settings_unavailable", "Settings lock failed."))?;
    update(&mut settings);
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
}
