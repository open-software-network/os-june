pub mod questions;

use crate::{
    db::repositories::{P3aPendingReport, Repositories},
    domain::types::AppError,
    june_api::{submit_p3a_report, P3aReportRequest as JuneP3aReportRequest},
    p3a::questions::{Question, ALL_QUESTIONS},
};
use chrono::{Datelike, Utc};
use serde::{Deserialize, Serialize};
use std::{fs, path::PathBuf, sync::Mutex};
use tauri::{AppHandle, Manager, State};

const CONSENT_VERSION: u32 = 1;
const P3A_SCHEMA_VERSION: u32 = 1;

pub struct P3aSettingsState {
    path: PathBuf,
    settings: Mutex<P3aSettings>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct P3aSettings {
    pub enabled: bool,
    pub consent_version: u32,
    pub consented_at_week: Option<String>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct P3aSettingsResponse {
    pub settings: P3aSettings,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SetP3aEnabledRequest {
    pub enabled: bool,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct P3aRecordRequest {
    pub question_id: String,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct P3aQuestionDto {
    pub id: &'static str,
    pub prompt: &'static str,
    pub buckets: &'static [&'static str],
    pub decision: &'static str,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct P3aQuestionCatalogResponse {
    pub questions: Vec<P3aQuestionDto>,
}

pub fn setup(app: &mut tauri::App) {
    let path = settings_path(app.handle()).unwrap_or_else(|| PathBuf::from("p3a-settings.json"));
    let settings = load_settings_from_disk(app.handle());
    app.manage(P3aSettingsState {
        path,
        settings: Mutex::new(settings),
    });
}

#[tauri::command]
pub fn p3a_settings(state: State<'_, P3aSettingsState>) -> Result<P3aSettingsResponse, AppError> {
    let settings = state
        .settings
        .lock()
        .map_err(|_| AppError::new("p3a_settings_unavailable", "Settings lock failed."))?
        .clone();
    Ok(P3aSettingsResponse { settings })
}

#[tauri::command]
pub fn p3a_question_catalog() -> P3aQuestionCatalogResponse {
    let questions = ALL_QUESTIONS
        .iter()
        .map(|definition| P3aQuestionDto {
            id: definition.id,
            prompt: definition.prompt,
            buckets: definition.buckets,
            decision: definition.decision,
        })
        .collect();
    P3aQuestionCatalogResponse { questions }
}

#[tauri::command]
pub async fn set_p3a_enabled(
    app: AppHandle,
    state: State<'_, P3aSettingsState>,
    request: SetP3aEnabledRequest,
) -> Result<P3aSettingsResponse, AppError> {
    if !request.enabled {
        clear_local_counters(&app).await?;
    }

    let mut settings = state
        .settings
        .lock()
        .map_err(|_| AppError::new("p3a_settings_unavailable", "Settings lock failed."))?;
    settings.enabled = request.enabled;
    settings.consent_version = CONSENT_VERSION;
    settings.consented_at_week = if request.enabled {
        Some(current_iso_week())
    } else {
        None
    };
    save_settings(&state, &settings)?;
    Ok(P3aSettingsResponse {
        settings: settings.clone(),
    })
}

#[tauri::command]
pub async fn p3a_record(app: AppHandle, request: P3aRecordRequest) -> Result<(), AppError> {
    let question = Question::from_id(request.question_id.trim())
        .ok_or_else(|| AppError::new("p3a_unknown_question", "Unknown telemetry question."))?;
    record_question(&app, question).await
}

pub fn record_question_best_effort(app: AppHandle, question: Question) {
    tokio::spawn(async move {
        if let Err(error) = record_question(&app, question).await {
            tracing::warn!(
                question_id = question.id(),
                error_code = %error.code,
                error_message = %error.message,
                "P3A event record failed"
            );
        }
    });
}

pub async fn record_question(app: &AppHandle, question: Question) -> Result<(), AppError> {
    let state = app.state::<P3aSettingsState>();
    let enabled = state
        .settings
        .lock()
        .map_err(|_| AppError::new("p3a_settings_unavailable", "Settings lock failed."))?
        .enabled;
    if !enabled {
        return Ok(());
    }
    let repos = crate::commands::repositories(app).await?;
    let epoch = current_iso_week();
    repos
        .increment_p3a_counter(question.id(), &epoch, 1)
        .await
        .map_err(|error| AppError::new("p3a_counter_failed", error.to_string()))?;
    flush_pending_event_reports(&repos).await;
    Ok(())
}

async fn flush_pending_event_reports(repos: &Repositories) {
    let pending = match repos.unreported_p3a_counters().await {
        Ok(pending) => pending,
        Err(error) => {
            tracing::warn!(%error, "P3A pending event query failed");
            return;
        }
    };
    for report in pending {
        submit_pending_event_report(repos, report).await;
    }
}

async fn submit_pending_event_report(repos: &Repositories, report: P3aPendingReport) {
    let Some(question) = Question::from_id(&report.question_id) else {
        tracing::warn!(question_id = %report.question_id, "Skipping unknown P3A counter");
        return;
    };

    let pending_events = report.raw_value.saturating_sub(report.reported_value);
    if pending_events == 0 {
        return;
    }

    let mut reported_value = report.reported_value;
    let bucket = question.event_bucket();
    for _ in 0..pending_events {
        if let Err(error) = submit_event_report(question, &report.epoch, bucket).await {
            tracing::warn!(
                question_id = question.id(),
                epoch = %report.epoch,
                bucket,
                error_code = %error.code,
                error_message = %error.message,
                "P3A event upload failed"
            );
            break;
        }
        reported_value = reported_value.saturating_add(1);
    }

    if reported_value == report.reported_value {
        return;
    }

    if let Err(error) = repos
        .mark_p3a_events_reported(question.id(), &report.epoch, reported_value)
        .await
    {
        tracing::warn!(
            question_id = question.id(),
            epoch = %report.epoch,
            reported_value,
            %error,
            "P3A reported event cursor update failed"
        );
    }
}

async fn submit_event_report(question: Question, epoch: &str, bucket: u8) -> Result<(), AppError> {
    submit_p3a_report(JuneP3aReportRequest {
        schema: P3A_SCHEMA_VERSION,
        question_id: question.id().to_string(),
        epoch: epoch.to_owned(),
        platform: current_platform().to_string(),
        version_series: current_version_series(),
        bucket,
    })
    .await
}

async fn clear_local_counters(app: &AppHandle) -> Result<(), AppError> {
    let repos = crate::commands::repositories(app).await?;
    repos
        .clear_p3a_counters()
        .await
        .map_err(|error| AppError::new("p3a_clear_failed", error.to_string()))
}

fn default_settings() -> P3aSettings {
    P3aSettings {
        enabled: false,
        consent_version: CONSENT_VERSION,
        consented_at_week: None,
    }
}

fn settings_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|directory| directory.join("p3a-settings.json"))
}

fn load_settings_from_disk(app: &AppHandle) -> P3aSettings {
    let defaults = default_settings();
    let Some(path) = settings_path(app) else {
        return defaults;
    };
    fs::read_to_string(path)
        .ok()
        .and_then(|settings| serde_json::from_str::<P3aSettings>(&settings).ok())
        .map(sanitize_settings)
        .unwrap_or(defaults)
}

fn sanitize_settings(settings: P3aSettings) -> P3aSettings {
    if settings.enabled {
        P3aSettings {
            enabled: true,
            consent_version: settings.consent_version.max(1),
            consented_at_week: settings
                .consented_at_week
                .filter(|week| is_valid_iso_week(week)),
        }
    } else {
        default_settings()
    }
}

fn save_settings(state: &P3aSettingsState, settings: &P3aSettings) -> Result<(), AppError> {
    if let Some(parent) = state.path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| AppError::new("p3a_settings_save_failed", error.to_string()))?;
    }
    let serialized = serde_json::to_string_pretty(settings)
        .map_err(|error| AppError::new("p3a_settings_save_failed", error.to_string()))?;
    fs::write(&state.path, serialized)
        .map_err(|error| AppError::new("p3a_settings_save_failed", error.to_string()))
}

fn current_iso_week() -> String {
    iso_week_for(Utc::now())
}

fn current_platform() -> &'static str {
    if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(target_os = "windows") {
        "windows"
    } else {
        "linux"
    }
}

fn current_version_series() -> String {
    version_series(env!("CARGO_PKG_VERSION"))
}

fn version_series(version: &str) -> String {
    let mut parts = version.split('.');
    let major = parts.next().and_then(version_number_prefix);
    let minor = parts.next().and_then(version_number_prefix);
    match (major, minor) {
        (Some(major), Some(minor)) => format!("{major}.{minor}.x"),
        _ => version
            .chars()
            .filter(|character| {
                character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '+' | '-')
            })
            .take(32)
            .collect::<String>(),
    }
}

fn version_number_prefix(part: &str) -> Option<&str> {
    let len = part
        .chars()
        .take_while(|character| character.is_ascii_digit())
        .map(char::len_utf8)
        .sum();
    (len > 0).then_some(&part[..len])
}

fn iso_week_for(time: chrono::DateTime<Utc>) -> String {
    let week = time.iso_week();
    format!("{}-W{:02}", week.year(), week.week())
}

fn is_valid_iso_week(value: &str) -> bool {
    let Some((year, week)) = value.split_once("-W") else {
        return false;
    };
    year.len() == 4
        && year.chars().all(|character| character.is_ascii_digit())
        && week.len() == 2
        && week
            .parse::<u32>()
            .is_ok_and(|week| (1..=53).contains(&week))
}

#[cfg(test)]
mod tests {
    use super::{is_valid_iso_week, iso_week_for, sanitize_settings, version_series, P3aSettings};
    use chrono::{TimeZone, Utc};

    #[test]
    fn formats_iso_week() {
        assert_eq!(
            iso_week_for(Utc.with_ymd_and_hms(2026, 7, 7, 12, 0, 0).unwrap()),
            "2026-W28"
        );
    }

    #[test]
    fn formats_version_series() {
        assert_eq!(version_series("0.0.30"), "0.0.x");
        assert_eq!(version_series("1.2.3-beta.1"), "1.2.x");
    }

    #[test]
    fn disabled_settings_drop_consent_week() {
        let settings = sanitize_settings(P3aSettings {
            enabled: false,
            consent_version: 9,
            consented_at_week: Some("2026-W28".to_string()),
        });
        assert!(!settings.enabled);
        assert_eq!(settings.consented_at_week, None);
    }

    #[test]
    fn invalid_consent_week_is_removed() {
        let settings = sanitize_settings(P3aSettings {
            enabled: true,
            consent_version: 1,
            consented_at_week: Some("2026-07-07".to_string()),
        });
        assert!(settings.enabled);
        assert_eq!(settings.consented_at_week, None);
    }

    #[test]
    fn validates_iso_week_shape() {
        assert!(is_valid_iso_week("2026-W28"));
        assert!(!is_valid_iso_week("2026-W00"));
        assert!(!is_valid_iso_week("2026-W54"));
        assert!(!is_valid_iso_week("2026-28"));
    }
}
