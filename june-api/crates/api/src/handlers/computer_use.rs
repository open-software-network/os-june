use crate::{ApiResponse, JUNE_APP_VERSION_HEADER, JUNE_MACOS_VERSION_HEADER, state::ApiState};
use axum::{Json, extract::State, http::HeaderMap};
use june_config::ComputerUseConfig;
use serde::Serialize;

const CACHE_TTL_SECONDS: u64 = 300;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputerUseRolloutDto {
    pub enabled: bool,
    pub reason: Option<&'static str>,
    pub cache_ttl_seconds: u64,
}

pub(crate) async fn rollout(
    State(state): State<ApiState>,
    headers: HeaderMap,
) -> Json<ApiResponse<ComputerUseRolloutDto>> {
    let june_version = header(&headers, JUNE_APP_VERSION_HEADER);
    let macos_version = header(&headers, JUNE_MACOS_VERSION_HEADER);
    Json(ApiResponse::ok(rollout_decision(
        state.computer_use(),
        june_version,
        macos_version,
    )))
}

fn header<'a>(headers: &'a HeaderMap, name: &str) -> &'a str {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .trim()
}

fn rollout_decision(
    config: &ComputerUseConfig,
    june_version: &str,
    macos_version: &str,
) -> ComputerUseRolloutDto {
    let reason = if !config.enabled {
        Some("global")
    } else if version_is_disabled(june_version, &config.disabled_june_versions) {
        Some("june_version")
    } else if version_is_disabled(macos_version, &config.disabled_macos_versions) {
        Some("macos_version")
    } else {
        None
    };
    ComputerUseRolloutDto {
        enabled: reason.is_none(),
        reason,
        cache_ttl_seconds: CACHE_TTL_SECONDS,
    }
}

fn version_is_disabled(version: &str, patterns: &[String]) -> bool {
    !version.is_empty()
        && patterns.iter().any(|pattern| {
            let pattern = pattern.trim();
            pattern == "*"
                || pattern == version
                || pattern
                    .strip_suffix('*')
                    .is_some_and(|prefix| !prefix.is_empty() && version.starts_with(prefix))
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rollout_can_be_killed_globally_or_by_either_version() {
        let mut config = ComputerUseConfig::default();
        assert!(rollout_decision(&config, "0.0.33", "15.5.1").enabled);

        config.disabled_june_versions = vec!["0.0.*".to_string()];
        let june = rollout_decision(&config, "0.0.33", "15.5.1");
        assert!(!june.enabled);
        assert_eq!(june.reason, Some("june_version"));

        config.disabled_june_versions.clear();
        config.disabled_macos_versions = vec!["15.5.*".to_string()];
        let macos = rollout_decision(&config, "0.0.33", "15.5.1");
        assert!(!macos.enabled);
        assert_eq!(macos.reason, Some("macos_version"));

        config.disabled_macos_versions.clear();
        config.enabled = false;
        assert_eq!(
            rollout_decision(&config, "0.0.33", "15.5.1").reason,
            Some("global")
        );
    }

    #[test]
    fn missing_or_nonmatching_versions_do_not_trigger_a_scoped_rule() {
        let config = ComputerUseConfig {
            disabled_june_versions: vec!["0.0.32".to_string()],
            disabled_macos_versions: vec!["14.*".to_string()],
            ..ComputerUseConfig::default()
        };
        assert!(rollout_decision(&config, "", "").enabled);
        assert!(rollout_decision(&config, "0.0.33", "15.0").enabled);
    }
}
