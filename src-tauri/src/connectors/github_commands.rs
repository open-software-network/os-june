//! Narrow Tauri boundary for GitHub connection state.
//!
//! Provider clients and token custody are constructed inside each command.
//! React receives only public device-flow fields and non-secret connection
//! snapshots; it can select an installation by stable id but never supply a
//! token, device code, or URL.

use crate::domain::types::AppError;

use super::{
    github::{self, github_app_config, GitHubConnection, PlatformGitHubTokenVault},
    github_auth::{GitHubAuthClient, GitHubConnectFlow, GitHubDevicePrompt},
};

fn redact_storage_error(_error: sqlx::Error) -> AppError {
    AppError::new(
        "github_storage_unavailable",
        "GitHub connection storage is unavailable.",
    )
}

fn installation_required_error() -> AppError {
    AppError::new(
        "github_installation_required",
        "GitHub App installation access is required.",
    )
}

fn github_refresh_changes_connector_state(result: &Result<GitHubConnection, AppError>) -> bool {
    result.is_ok()
        || result
            .as_ref()
            .is_err_and(|error| error.code == "github_reconnect_required")
}

#[tauri::command]
pub async fn github_connect_start(
    _app: tauri::AppHandle,
    flow: tauri::State<'_, GitHubConnectFlow>,
) -> Result<GitHubDevicePrompt, AppError> {
    let config = github_app_config()?;
    let client = GitHubAuthClient::production()?;
    let prompt = flow.start(&client, &config.client_id).await?;
    if let Err(error) = crate::os_accounts::open_in_browser(&prompt.verification_uri) {
        let _ = flow.cancel().await;
        return Err(error);
    }
    Ok(prompt)
}

#[tauri::command]
pub async fn github_connect_wait(
    app: tauri::AppHandle,
    flow: tauri::State<'_, GitHubConnectFlow>,
) -> Result<GitHubConnection, AppError> {
    let config = github_app_config()?;
    let client = GitHubAuthClient::production()?;
    let vault = PlatformGitHubTokenVault;
    let repositories = crate::commands::repositories(&app).await?;
    let connection =
        github::complete_connect(&flow, &client, &vault, &repositories, &config).await?;
    super::emit_connectors_changed(&app);
    Ok(connection)
}

#[tauri::command]
pub async fn github_connect_cancel(
    flow: tauri::State<'_, GitHubConnectFlow>,
) -> Result<(), AppError> {
    flow.cancel().await
}

#[tauri::command]
pub async fn github_connection_get(
    app: tauri::AppHandle,
) -> Result<Option<GitHubConnection>, AppError> {
    let repositories = crate::commands::repositories(&app).await?;
    github::connection_get(&PlatformGitHubTokenVault, &repositories).await
}

#[tauri::command]
pub async fn github_installations_refresh(
    app: tauri::AppHandle,
) -> Result<GitHubConnection, AppError> {
    let config = github_app_config()?;
    let client = GitHubAuthClient::production()?;
    let vault = PlatformGitHubTokenVault;
    let repositories = crate::commands::repositories(&app).await?;
    let result = github::installations_refresh(&client, &vault, &repositories, &config).await;
    if github_refresh_changes_connector_state(&result) {
        super::emit_connectors_changed(&app);
    }
    result
}

#[tauri::command]
pub async fn github_installation_open(
    app: tauri::AppHandle,
    installation_id: Option<String>,
) -> Result<(), AppError> {
    let url = match installation_id {
        Some(installation_id) => {
            let repositories = crate::commands::repositories(&app).await?;
            repositories
                .get_github_installation(&installation_id)
                .await
                .map_err(redact_storage_error)?
                .ok_or_else(installation_required_error)?
                .management_url
        }
        None => github_app_config()?.installation_url(),
    };
    crate::os_accounts::open_in_browser(&url)
}

#[tauri::command]
pub async fn github_disconnect(
    app: tauri::AppHandle,
    flow: tauri::State<'_, GitHubConnectFlow>,
) -> Result<(), AppError> {
    flow.cancel().await?;
    let repositories = crate::commands::repositories(&app).await?;
    github::disconnect(&PlatformGitHubTokenVault, &repositories).await?;
    super::emit_connectors_changed(&app);
    Ok(())
}

#[cfg(test)]
mod tests {
    use crate::{
        connectors::{
            github::{
                GitHubConnection, GitHubConnectionStatus, GitHubInstallation, GitHubRepository,
            },
            github_auth::GitHubDevicePrompt,
        },
        domain::types::AppError,
    };
    use std::collections::{BTreeMap, BTreeSet};

    #[test]
    fn device_prompt_serializes_only_public_fields() {
        let value = serde_json::to_value(GitHubDevicePrompt {
            user_code: "ABCD-EFGH".into(),
            verification_uri: "https://github.com/login/device".into(),
            expires_at_unix: 2_000_000_000,
            interval_seconds: 5,
        })
        .unwrap();

        assert_eq!(
            value
                .as_object()
                .unwrap()
                .keys()
                .cloned()
                .collect::<BTreeSet<_>>(),
            BTreeSet::from([
                "expiresAtUnix".into(),
                "intervalSeconds".into(),
                "userCode".into(),
                "verificationUri".into(),
            ])
        );
        assert!(value.get("deviceCode").is_none());
        assert!(value.get("accessToken").is_none());
        assert!(value.get("refreshToken").is_none());
    }

    #[test]
    fn connection_serializes_every_id_as_a_string() {
        let value = serde_json::to_value(GitHubConnection {
            github_user_id: "9007199254740993".into(),
            login: "octocat".into(),
            avatar_url: Some("https://avatars.githubusercontent.com/u/1".into()),
            status: GitHubConnectionStatus::Connected,
            installations: vec![GitHubInstallation {
                installation_id: "9007199254740995".into(),
                owner_id: "9007199254740997".into(),
                owner_login: "open-software-network".into(),
                owner_type: "Organization".into(),
                repository_selection: "selected".into(),
                permissions: BTreeMap::from([("contents".into(), "read".into())]),
                suspended_at: None,
                repositories: vec![GitHubRepository {
                    repository_id: "9007199254740999".into(),
                    installation_id: "9007199254740995".into(),
                    owner_login: "open-software-network".into(),
                    name: "test-repo".into(),
                    full_name: "open-software-network/test-repo".into(),
                    private: true,
                    archived: false,
                    permissions: BTreeMap::from([("pull".into(), true)]),
                }],
            }],
        })
        .unwrap();

        assert!(value["githubUserId"].is_string());
        assert!(value["installations"][0]["installationId"].is_string());
        assert!(value["installations"][0]["ownerId"].is_string());
        assert!(value["installations"][0]["repositories"][0]["repositoryId"].is_string());
        assert!(value["installations"][0]["repositories"][0]["installationId"].is_string());
    }

    #[test]
    fn storage_errors_are_redacted_at_the_command_boundary() {
        let error = super::redact_storage_error(sqlx::Error::Protocol(
            "device-code-secret access-token-secret".into(),
        ));
        let serialized = serde_json::to_string(&error).unwrap();

        assert_eq!(error.code, "github_storage_unavailable");
        assert_eq!(error.message, "GitHub connection storage is unavailable.");
        assert!(!serialized.contains("device-code-secret"));
        assert!(!serialized.contains("access-token-secret"));
    }

    #[test]
    fn refresh_event_is_emitted_only_when_connector_state_can_change() {
        let connected = GitHubConnection {
            github_user_id: "123".into(),
            login: "octocat".into(),
            avatar_url: None,
            status: GitHubConnectionStatus::Connected,
            installations: Vec::new(),
        };
        assert!(super::github_refresh_changes_connector_state(&Ok(
            connected
        )));
        assert!(super::github_refresh_changes_connector_state(&Err(
            AppError::new(
                "github_reconnect_required",
                "GitHub access expired. Reconnect it in settings.",
            )
        )));
        assert!(!super::github_refresh_changes_connector_state(&Err(
            AppError::new("github_refresh_failed", "Could not refresh GitHub access.",)
        )));
    }
}
