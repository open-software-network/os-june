pub mod generation;
pub mod transcription;

use crate::domain::types::AppError;
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
};
use tauri::{AppHandle, Manager, State};

pub const VENICE_PROVIDER: &str = "venice";
pub const DEFAULT_VENICE_API_BASE_URL: &str = "https://api.venice.ai/api/v1";
pub const DEFAULT_VENICE_TRANSCRIPTION_MODEL: &str = "nvidia/parakeet-tdt-0.6b-v3";
pub const DEFAULT_VENICE_GENERATION_MODEL: &str = "zai-org-glm-5";

static ENV_LOADED: OnceLock<()> = OnceLock::new();
static PROVIDER_MODEL_SETTINGS: OnceLock<Mutex<ProviderModelSettings>> = OnceLock::new();

pub struct ProviderSettingsState {
    path: PathBuf,
    settings: Mutex<ProviderModelSettings>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProviderModelSettings {
    pub transcription_model: String,
    pub generation_model: String,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProviderModelSettingsResponse {
    pub settings: ProviderModelSettings,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SetVeniceModelRequest {
    pub mode: String,
    pub model_id: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct VeniceModelsRequest {
    pub mode: String,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct VeniceModelsResponse {
    pub mode: String,
    pub model_type: String,
    pub selected_model: String,
    pub models: Vec<VeniceModelDto>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct VeniceModelDto {
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
}

pub fn configured_provider() -> String {
    load_local_env();
    VENICE_PROVIDER.to_string()
}

pub fn venice_api_key() -> Option<String> {
    load_local_env();
    std::env::var("VENICE_API_KEY")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

pub fn provider_configured() -> bool {
    venice_api_key().is_some()
}

pub fn venice_api_base_url() -> String {
    load_local_env();
    std::env::var("VENICE_API_BASE_URL")
        .ok()
        .map(|value| value.trim().trim_end_matches('/').to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| DEFAULT_VENICE_API_BASE_URL.to_string())
}

pub fn venice_transcription_model() -> String {
    current_provider_model_settings().transcription_model
}

pub fn venice_generation_model() -> String {
    current_provider_model_settings().generation_model
}

#[tauri::command]
pub fn provider_model_settings(
    state: State<'_, ProviderSettingsState>,
) -> Result<ProviderModelSettingsResponse, AppError> {
    Ok(ProviderModelSettingsResponse {
        settings: state
            .settings
            .lock()
            .map_err(|_| AppError::new("provider_settings_unavailable", "Settings lock failed."))?
            .clone(),
    })
}

#[tauri::command]
pub fn set_venice_model(
    state: State<'_, ProviderSettingsState>,
    request: SetVeniceModelRequest,
) -> Result<ProviderModelSettings, AppError> {
    let mode = model_mode(&request.mode)?;
    let model_id = request.model_id.trim();
    if model_id.is_empty() {
        return Err(AppError::new(
            "provider_model_required",
            "Select a Venice model.",
        ));
    }
    update_provider_settings(&state, |settings| match mode {
        ModelMode::Transcription => settings.transcription_model = model_id.to_string(),
        ModelMode::Generation => settings.generation_model = model_id.to_string(),
    })
}

#[tauri::command]
pub async fn list_venice_models(
    state: State<'_, ProviderSettingsState>,
    request: VeniceModelsRequest,
) -> Result<VeniceModelsResponse, AppError> {
    let mode = model_mode(&request.mode)?;
    let model_type = mode.venice_type();
    let selected_model = selected_model_for_mode(&state, mode)?;
    let api_key = venice_api_key().ok_or_else(|| {
        AppError::new(
            "provider_not_configured",
            "VENICE_API_KEY is required to load Venice models.",
        )
    })?;
    let response = reqwest::Client::new()
        .get(format!("{}/models", venice_api_base_url()))
        .query(&[("type", model_type)])
        .bearer_auth(api_key)
        .send()
        .await
        .map_err(|error| AppError::new("provider_request_failed", error.to_string()))?;
    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|error| AppError::new("provider_request_failed", error.to_string()))?;
    if !status.is_success() {
        return Err(AppError::new(
            "provider_request_failed",
            format!("Venice models request failed with status {status}: {body}"),
        ));
    }
    let parsed: VeniceModelsApiResponse = serde_json::from_str(&body)
        .map_err(|error| AppError::new("provider_response_invalid", error.to_string()))?;
    let mut models = venice_model_items(parsed, model_type);
    models.sort_by(|left, right| {
        left.name
            .to_ascii_lowercase()
            .cmp(&right.name.to_ascii_lowercase())
            .then_with(|| left.id.cmp(&right.id))
    });
    Ok(VeniceModelsResponse {
        mode: mode.as_str().to_string(),
        model_type: model_type.to_string(),
        selected_model,
        models,
    })
}

pub fn setup(app: &mut tauri::App) {
    let path = provider_settings_path(app.handle())
        .unwrap_or_else(|| PathBuf::from("provider-settings.json"));
    let settings = load_provider_settings(app.handle());
    replace_current_provider_model_settings(settings.clone());
    app.manage(ProviderSettingsState {
        path,
        settings: Mutex::new(settings),
    });
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

fn current_provider_model_settings() -> ProviderModelSettings {
    provider_model_settings_store()
        .lock()
        .map(|settings| settings.clone())
        .unwrap_or_else(|_| default_provider_model_settings())
}

fn provider_model_settings_store() -> &'static Mutex<ProviderModelSettings> {
    PROVIDER_MODEL_SETTINGS.get_or_init(|| Mutex::new(default_provider_model_settings()))
}

fn replace_current_provider_model_settings(settings: ProviderModelSettings) {
    if let Ok(mut current) = provider_model_settings_store().lock() {
        *current = settings;
    }
}

fn default_provider_model_settings() -> ProviderModelSettings {
    load_local_env();
    ProviderModelSettings {
        transcription_model: env_value("VENICE_TRANSCRIPTION_MODEL")
            .unwrap_or_else(|| DEFAULT_VENICE_TRANSCRIPTION_MODEL.to_string()),
        generation_model: env_value("VENICE_GENERATION_MODEL")
            .unwrap_or_else(|| DEFAULT_VENICE_GENERATION_MODEL.to_string()),
    }
}

fn env_value(key: &str) -> Option<String> {
    std::env::var(key)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn provider_settings_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|directory| directory.join("provider-settings.json"))
}

fn load_provider_settings(app: &AppHandle) -> ProviderModelSettings {
    let defaults = default_provider_model_settings();
    let Some(path) = provider_settings_path(app) else {
        return defaults;
    };

    fs::read_to_string(path)
        .ok()
        .and_then(|settings| serde_json::from_str::<ProviderModelSettings>(&settings).ok())
        .map(|settings| ProviderModelSettings {
            transcription_model: non_empty_or(
                settings.transcription_model,
                &defaults.transcription_model,
            ),
            generation_model: non_empty_or(settings.generation_model, &defaults.generation_model),
        })
        .unwrap_or(defaults)
}

fn non_empty_or(value: String, fallback: &str) -> String {
    let value = value.trim();
    if value.is_empty() {
        fallback.to_string()
    } else {
        value.to_string()
    }
}

fn update_provider_settings(
    state: &ProviderSettingsState,
    update: impl FnOnce(&mut ProviderModelSettings),
) -> Result<ProviderModelSettings, AppError> {
    let mut settings = state
        .settings
        .lock()
        .map_err(|_| AppError::new("provider_settings_unavailable", "Settings lock failed."))?;
    update(&mut settings);
    save_provider_settings(state, &settings)?;
    replace_current_provider_model_settings(settings.clone());
    Ok(settings.clone())
}

fn save_provider_settings(
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
    })
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ModelMode {
    Transcription,
    Generation,
}

impl ModelMode {
    fn as_str(self) -> &'static str {
        match self {
            Self::Transcription => "transcription",
            Self::Generation => "generation",
        }
    }

    fn venice_type(self) -> &'static str {
        match self {
            Self::Transcription => "asr",
            Self::Generation => "text",
        }
    }
}

fn model_mode(value: &str) -> Result<ModelMode, AppError> {
    match value.trim() {
        "transcription" | "dictation" | "asr" => Ok(ModelMode::Transcription),
        "generation" | "notes" | "text" => Ok(ModelMode::Generation),
        _ => Err(AppError::new(
            "provider_model_mode_invalid",
            "Unknown Venice model mode.",
        )),
    }
}

#[derive(Debug, Deserialize)]
struct VeniceModelsApiResponse {
    data: Vec<VeniceModelApiItem>,
}

#[derive(Debug, Deserialize)]
struct VeniceModelApiItem {
    id: String,
    #[serde(rename = "type")]
    model_type: String,
    model_spec: Option<VeniceModelSpec>,
}

#[derive(Debug, Deserialize)]
struct VeniceModelSpec {
    name: Option<String>,
    description: Option<String>,
    privacy: Option<String>,
    pricing: Option<serde_json::Value>,
    #[serde(rename = "availableContextTokens")]
    available_context_tokens: Option<i64>,
    capabilities: Option<serde_json::Value>,
    traits: Option<Vec<String>>,
    offline: Option<bool>,
}

fn venice_model_items(response: VeniceModelsApiResponse, model_type: &str) -> Vec<VeniceModelDto> {
    response
        .data
        .into_iter()
        .filter(|model| model.model_type == model_type)
        .filter(|model| model.model_spec.as_ref().and_then(|spec| spec.offline) != Some(true))
        .map(|model| {
            let spec = model.model_spec;
            let name = spec
                .as_ref()
                .and_then(|spec| spec.name.as_deref())
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .unwrap_or(&model.id)
                .to_string();
            let description = spec.as_ref().and_then(|spec| {
                spec.description
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(ToString::to_string)
            });
            let privacy = spec.as_ref().and_then(|spec| {
                spec.privacy
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(ToString::to_string)
            });
            let pricing = spec.as_ref().and_then(|spec| spec.pricing.clone());
            let context_tokens = spec.as_ref().and_then(|spec| spec.available_context_tokens);
            let traits = spec
                .as_ref()
                .and_then(|spec| spec.traits.clone())
                .unwrap_or_default();
            let capabilities = spec
                .as_ref()
                .and_then(|spec| spec.capabilities.as_ref())
                .map(capability_names)
                .unwrap_or_default();
            VeniceModelDto {
                id: model.id,
                name,
                model_type: model.model_type,
                description,
                privacy,
                pricing,
                context_tokens,
                traits,
                capabilities,
            }
        })
        .collect()
}

fn capability_names(value: &serde_json::Value) -> Vec<String> {
    let mut names = Vec::new();
    collect_capability_names(value, "", &mut names);
    names.sort();
    names.dedup();
    names
}

fn collect_capability_names(value: &serde_json::Value, prefix: &str, names: &mut Vec<String>) {
    let serde_json::Value::Object(map) = value else {
        return;
    };
    for (key, value) in map {
        let name = if prefix.is_empty() {
            key.to_string()
        } else {
            format!("{prefix}.{key}")
        };
        match value {
            serde_json::Value::Bool(true) => names.push(name),
            serde_json::Value::Object(_) => collect_capability_names(value, &name, names),
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        configured_provider, venice_model_items, VeniceModelsApiResponse, VENICE_PROVIDER,
    };

    #[test]
    fn venice_is_the_only_configured_provider() {
        assert_eq!(configured_provider(), VENICE_PROVIDER);
    }

    #[test]
    fn parses_online_models_for_requested_type() {
        let response: VeniceModelsApiResponse = serde_json::from_value(serde_json::json!({
            "data": [
                {
                    "id": "text-model",
                    "type": "text",
                    "model_spec": {
                        "name": "Text Model",
                        "description": "Writes notes",
                        "privacy": "private",
                        "pricing": {
                            "input": { "usd": 0.15 },
                            "output": { "usd": 0.60 }
                        },
                        "availableContextTokens": 32768,
                        "capabilities": {
                            "supportsFunctionCalling": true,
                            "supportsVision": false,
                            "nested": { "enabled": true }
                        },
                        "traits": ["default"],
                        "offline": false
                    }
                },
                {
                    "id": "offline-text-model",
                    "type": "text",
                    "model_spec": {
                        "name": "Offline",
                        "offline": true
                    }
                },
                {
                    "id": "asr-model",
                    "type": "asr",
                    "model_spec": {
                        "name": "ASR Model",
                        "offline": false
                    }
                }
            ]
        }))
        .expect("models response");

        let models = venice_model_items(response, "text");

        assert_eq!(models.len(), 1);
        assert_eq!(models[0].id, "text-model");
        assert_eq!(models[0].name, "Text Model");
        assert_eq!(models[0].privacy.as_deref(), Some("private"));
        assert_eq!(models[0].context_tokens, Some(32768));
        assert_eq!(models[0].traits, vec!["default"]);
        assert_eq!(
            models[0].capabilities,
            vec!["nested.enabled", "supportsFunctionCalling"]
        );
        assert!(models[0].pricing.is_some());
    }
}
