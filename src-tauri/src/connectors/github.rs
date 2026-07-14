use crate::{
    db::repositories::{
        GitHubConnectionRecord, GitHubInstallationRecord, GitHubRepositoryRecord,
        GitHubSnapshotRecord, Repositories,
    },
    domain::types::AppError,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, HashMap},
    future::Future,
    pin::Pin,
    sync::{Arc, Mutex as StdMutex, OnceLock},
};

use super::{
    github_auth::{
        DiscoveredGitHubInstallation, DiscoveredGitHubRepository, DiscoveredGitHubUser,
        GitHubAuthClient, GitHubConnectFlow, RefreshOutcome,
    },
    github_store::{
        delete_github_tokens, load_github_tokens, store_github_tokens, StoredGitHubTokens,
    },
};

const GITHUB_APP_CLIENT_ID_ENV: &str = "GITHUB_APP_CLIENT_ID";
const GITHUB_APP_SLUG_ENV: &str = "GITHUB_APP_SLUG";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GitHubAppConfig {
    pub client_id: String,
    pub slug: String,
}

impl GitHubAppConfig {
    pub fn installation_url(&self) -> String {
        format!("https://github.com/apps/{}/installations/new", self.slug)
    }
}

fn config_from_values(client_id: String, slug: String) -> Result<GitHubAppConfig, AppError> {
    let client_id = client_id.trim();
    let slug = slug.trim();
    let valid_client_id = (8..=128).contains(&client_id.len())
        && client_id.bytes().all(|byte| byte.is_ascii_alphanumeric());
    let valid_slug = (1..=100).contains(&slug.len())
        && slug
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        && !slug.starts_with('-')
        && !slug.ends_with('-');
    if !valid_client_id || !valid_slug {
        return Err(AppError::new(
            "github_not_configured",
            "GitHub is not configured for this build.",
        ));
    }
    Ok(GitHubAppConfig {
        client_id: client_id.to_owned(),
        slug: slug.to_owned(),
    })
}

pub fn github_app_config() -> Result<GitHubAppConfig, AppError> {
    crate::os_accounts::load_local_env();
    config_from_values(
        super::env_or_build_trimmed(
            GITHUB_APP_CLIENT_ID_ENV,
            option_env!("GITHUB_APP_CLIENT_ID"),
        ),
        super::env_or_build_trimmed(GITHUB_APP_SLUG_ENV, option_env!("GITHUB_APP_SLUG")),
    )
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GitHubConnectionStatus {
    Connected,
    SetupIncomplete,
    ReconnectRequired,
}

impl GitHubConnectionStatus {
    fn as_str(self) -> &'static str {
        match self {
            Self::Connected => "connected",
            Self::SetupIncomplete => "setup_incomplete",
            Self::ReconnectRequired => "reconnect_required",
        }
    }

    fn from_db(value: &str) -> Result<Self, AppError> {
        match value {
            "connected" => Ok(Self::Connected),
            "setup_incomplete" => Ok(Self::SetupIncomplete),
            "reconnect_required" => Ok(Self::ReconnectRequired),
            _ => Err(github_state_invalid()),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitHubRepository {
    pub repository_id: String,
    pub installation_id: String,
    pub owner_login: String,
    pub name: String,
    pub full_name: String,
    pub private: bool,
    pub archived: bool,
    pub permissions: BTreeMap<String, bool>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitHubInstallation {
    pub installation_id: String,
    pub owner_id: String,
    pub owner_login: String,
    pub owner_type: String,
    pub repository_selection: String,
    pub permissions: BTreeMap<String, String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub suspended_at: Option<String>,
    pub repositories: Vec<GitHubRepository>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitHubConnection {
    pub github_user_id: String,
    pub login: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub avatar_url: Option<String>,
    pub status: GitHubConnectionStatus,
    pub installations: Vec<GitHubInstallation>,
}

pub type GitHubVaultFuture<'a, T> = Pin<Box<dyn Future<Output = Result<T, AppError>> + Send + 'a>>;

pub trait GitHubTokenVault: Send + Sync {
    fn load<'a>(
        &'a self,
        github_user_id: &'a str,
    ) -> GitHubVaultFuture<'a, Option<StoredGitHubTokens>>;
    fn store<'a>(
        &'a self,
        github_user_id: &'a str,
        tokens: &'a StoredGitHubTokens,
    ) -> GitHubVaultFuture<'a, ()>;
    fn delete<'a>(&'a self, github_user_id: &'a str) -> GitHubVaultFuture<'a, ()>;
}

pub struct PlatformGitHubTokenVault;

impl GitHubTokenVault for PlatformGitHubTokenVault {
    fn load<'a>(
        &'a self,
        github_user_id: &'a str,
    ) -> GitHubVaultFuture<'a, Option<StoredGitHubTokens>> {
        Box::pin(load_github_tokens(github_user_id))
    }

    fn store<'a>(
        &'a self,
        github_user_id: &'a str,
        tokens: &'a StoredGitHubTokens,
    ) -> GitHubVaultFuture<'a, ()> {
        Box::pin(store_github_tokens(github_user_id, tokens))
    }

    fn delete<'a>(&'a self, github_user_id: &'a str) -> GitHubVaultFuture<'a, ()> {
        Box::pin(delete_github_tokens(github_user_id))
    }
}

const ACCESS_TOKEN_EXPIRY_BUFFER_SECS: i64 = 60;

static REFRESH_LOCKS: OnceLock<StdMutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>> =
    OnceLock::new();

fn refresh_lock_for(github_user_id: &str) -> Arc<tokio::sync::Mutex<()>> {
    let locks = REFRESH_LOCKS.get_or_init(|| StdMutex::new(HashMap::new()));
    let mut locks = locks
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    locks
        .entry(github_user_id.to_owned())
        .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
        .clone()
}

fn now_unix() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or(0)
}

fn access_token_is_fresh(expires_at_unix: i64) -> bool {
    expires_at_unix > now_unix().saturating_add(ACCESS_TOKEN_EXPIRY_BUFFER_SECS)
}

fn github_state_invalid() -> AppError {
    AppError::new(
        "github_state_invalid",
        "Stored GitHub connection data is invalid.",
    )
}

fn github_storage_unavailable() -> AppError {
    AppError::new(
        "github_storage_unavailable",
        "GitHub connection storage is unavailable.",
    )
}

fn github_reconnect_required() -> AppError {
    AppError::new(
        "github_reconnect_required",
        "GitHub access expired. Reconnect it in settings.",
    )
}

fn github_not_connected() -> AppError {
    AppError::new(
        "github_reconnect_required",
        "GitHub is not connected. Connect it in settings.",
    )
}

fn github_connect_canceled() -> AppError {
    AppError::new(
        "github_connect_canceled",
        "Connecting to GitHub was canceled.",
    )
}

async fn cancellation_select<T, F>(
    cancellation: &mut tokio::sync::watch::Receiver<bool>,
    future: F,
) -> Result<T, AppError>
where
    F: Future<Output = Result<T, AppError>>,
{
    if *cancellation.borrow() {
        return Err(github_connect_canceled());
    }
    tokio::select! {
        _ = cancellation.changed() => Err(github_connect_canceled()),
        result = future => result,
    }
}

pub async fn complete_connect(
    flow: &GitHubConnectFlow,
    client: &GitHubAuthClient,
    vault: &dyn GitHubTokenVault,
    repositories: &Repositories,
    config: &GitHubAppConfig,
) -> Result<GitHubConnection, AppError> {
    let authorized = flow.wait(client, &config.client_id).await?;
    let _completion_guard = flow.completion_guard().await;
    let attempt_id = authorized.attempt_id;
    let mut cancellation = authorized.cancellation;
    let tokens = authorized.tokens;
    #[cfg(test)]
    flow.pause_after_token_for_test().await;
    ensure_attempt_active(flow, attempt_id, &cancellation).await?;

    let user = cancellation_select(
        &mut cancellation,
        client.current_user(tokens.access_token()),
    )
    .await?;
    ensure_attempt_active(flow, attempt_id, &cancellation).await?;

    let mut stored = tokens.into_stored(user.github_user_id.clone());
    if !access_token_is_fresh(stored.expires_at_unix) {
        let outcome = cancellation_select(
            &mut cancellation,
            client.refresh_tokens(&config.client_id, &stored.refresh_token),
        )
        .await?;
        stored = match outcome {
            RefreshOutcome::Refreshed(grant) => grant.into_stored(user.github_user_id.clone()),
            RefreshOutcome::InvalidGrant => return Err(github_reconnect_required()),
        };
    }
    ensure_attempt_active(flow, attempt_id, &cancellation).await?;

    let (installations, discovered_repositories) = cancellation_select(
        &mut cancellation,
        client.installations_and_repositories(&stored.access_token),
    )
    .await?;
    ensure_attempt_active(flow, attempt_id, &cancellation).await?;

    let status = status_for_discovery(&installations, &discovered_repositories);
    let (connection_record, installation_records, repository_records) =
        discovery_records(&user, status, &installations, &discovered_repositories)?;
    let old_snapshot = repositories
        .github_snapshot()
        .await
        .map_err(|_| github_storage_unavailable())?;
    let old_tokens = match old_snapshot.as_ref() {
        Some(snapshot) => vault.load(&snapshot.connection.github_user_id).await?,
        None => None,
    };

    ensure_attempt_active(flow, attempt_id, &cancellation).await?;
    vault.store(&user.github_user_id, &stored).await?;
    if ensure_attempt_active(flow, attempt_id, &cancellation)
        .await
        .is_err()
    {
        restore_vault_after_failed_connect(
            vault,
            &user.github_user_id,
            old_snapshot.as_ref(),
            old_tokens.as_ref(),
        )
        .await?;
        return Err(github_connect_canceled());
    }

    if let Some(old) = old_snapshot
        .as_ref()
        .filter(|old| old.connection.github_user_id != user.github_user_id)
    {
        if ensure_attempt_active(flow, attempt_id, &cancellation)
            .await
            .is_err()
        {
            restore_vault_after_failed_connect(
                vault,
                &user.github_user_id,
                old_snapshot.as_ref(),
                old_tokens.as_ref(),
            )
            .await?;
            return Err(github_connect_canceled());
        }
        if let Err(error) = vault.delete(&old.connection.github_user_id).await {
            vault.delete(&user.github_user_id).await?;
            return Err(error);
        }
        if ensure_attempt_active(flow, attempt_id, &cancellation)
            .await
            .is_err()
        {
            restore_vault_after_failed_connect(
                vault,
                &user.github_user_id,
                old_snapshot.as_ref(),
                old_tokens.as_ref(),
            )
            .await?;
            return Err(github_connect_canceled());
        }
    }

    if ensure_attempt_active(flow, attempt_id, &cancellation)
        .await
        .is_err()
    {
        restore_vault_after_failed_connect(
            vault,
            &user.github_user_id,
            old_snapshot.as_ref(),
            old_tokens.as_ref(),
        )
        .await?;
        return Err(github_connect_canceled());
    }
    if repositories
        .replace_github_snapshot(
            &connection_record,
            &installation_records,
            &repository_records,
        )
        .await
        .is_err()
    {
        restore_vault_after_failed_connect(
            vault,
            &user.github_user_id,
            old_snapshot.as_ref(),
            old_tokens.as_ref(),
        )
        .await?;
        return Err(github_storage_unavailable());
    }
    if !flow.is_active(attempt_id).await || *cancellation.borrow() {
        restore_snapshot(repositories, old_snapshot.as_ref(), &user.github_user_id).await?;
        restore_vault_after_failed_connect(
            vault,
            &user.github_user_id,
            old_snapshot.as_ref(),
            old_tokens.as_ref(),
        )
        .await?;
        return Err(github_connect_canceled());
    }
    if !flow.finish_if_current(attempt_id).await {
        restore_snapshot(repositories, old_snapshot.as_ref(), &user.github_user_id).await?;
        restore_vault_after_failed_connect(
            vault,
            &user.github_user_id,
            old_snapshot.as_ref(),
            old_tokens.as_ref(),
        )
        .await?;
        return Err(github_connect_canceled());
    }

    connection_from_snapshot(GitHubSnapshotRecord {
        connection: connection_record,
        installations: installation_records,
        repositories: repository_records,
    })
}

async fn ensure_attempt_active(
    flow: &GitHubConnectFlow,
    attempt_id: u64,
    cancellation: &tokio::sync::watch::Receiver<bool>,
) -> Result<(), AppError> {
    if *cancellation.borrow() || !flow.is_active(attempt_id).await {
        Err(github_connect_canceled())
    } else {
        Ok(())
    }
}

async fn restore_vault_after_failed_connect(
    vault: &dyn GitHubTokenVault,
    new_user_id: &str,
    old_snapshot: Option<&GitHubSnapshotRecord>,
    old_tokens: Option<&StoredGitHubTokens>,
) -> Result<(), AppError> {
    match (old_snapshot, old_tokens) {
        (Some(old), Some(tokens)) if old.connection.github_user_id == new_user_id => {
            vault.store(new_user_id, tokens).await
        }
        (Some(old), Some(tokens)) => {
            vault.store(&old.connection.github_user_id, tokens).await?;
            vault.delete(new_user_id).await
        }
        _ => vault.delete(new_user_id).await,
    }
}

async fn restore_snapshot(
    repositories: &Repositories,
    old_snapshot: Option<&GitHubSnapshotRecord>,
    new_user_id: &str,
) -> Result<(), AppError> {
    match old_snapshot {
        Some(old) => {
            repositories
                .replace_github_snapshot(&old.connection, &old.installations, &old.repositories)
                .await
        }
        None => repositories.delete_github_state(new_user_id).await,
    }
    .map_err(|_| github_storage_unavailable())
}

pub async fn connection_get(
    vault: &dyn GitHubTokenVault,
    repositories: &Repositories,
) -> Result<Option<GitHubConnection>, AppError> {
    let Some(snapshot) = repositories
        .github_snapshot()
        .await
        .map_err(|_| github_storage_unavailable())?
    else {
        return Ok(None);
    };
    let mut connection = connection_from_snapshot(snapshot.clone())?;
    let valid_custody = match vault.load(&snapshot.connection.github_user_id).await {
        Ok(Some(tokens)) => tokens.github_user_id == snapshot.connection.github_user_id,
        Ok(None) => false,
        Err(error) if error.code == "github_token_store_invalid" => false,
        Err(error) => return Err(error),
    };
    if !valid_custody {
        repositories
            .set_github_connection_status(
                &snapshot.connection.github_user_id,
                GitHubConnectionStatus::ReconnectRequired.as_str(),
            )
            .await
            .map_err(|_| github_storage_unavailable())?;
        connection.status = GitHubConnectionStatus::ReconnectRequired;
    }
    Ok(Some(connection))
}

pub async fn installations_refresh(
    client: &GitHubAuthClient,
    vault: &dyn GitHubTokenVault,
    repositories: &Repositories,
    config: &GitHubAppConfig,
) -> Result<GitHubConnection, AppError> {
    installations_refresh_with_force(
        client,
        vault,
        repositories,
        config,
        consume_debug_force_refresh_once(),
    )
    .await
}

async fn installations_refresh_with_force(
    client: &GitHubAuthClient,
    vault: &dyn GitHubTokenVault,
    repositories: &Repositories,
    config: &GitHubAppConfig,
    force_token_refresh: bool,
) -> Result<GitHubConnection, AppError> {
    let snapshot = repositories
        .github_snapshot()
        .await
        .map_err(|_| github_storage_unavailable())?
        .ok_or_else(github_not_connected)?;
    let github_user_id = snapshot.connection.github_user_id.clone();
    let tokens = usable_tokens(
        client,
        vault,
        repositories,
        config,
        &github_user_id,
        force_token_refresh,
    )
    .await?;

    let discovery = client
        .installations_and_repositories(&tokens.access_token)
        .await;
    let (installations, discovered_repositories) = match discovery {
        Ok(discovery) => discovery,
        Err(error) if error.code == "github_reconnect_required" => {
            let refreshed =
                usable_tokens(client, vault, repositories, config, &github_user_id, true).await?;
            match client
                .installations_and_repositories(&refreshed.access_token)
                .await
            {
                Ok(discovery) => discovery,
                Err(second) if second.code == "github_reconnect_required" => {
                    return terminal_reconnect(vault, repositories, &github_user_id).await;
                }
                Err(second) => return Err(second),
            }
        }
        Err(error) => return Err(error),
    };

    let user = DiscoveredGitHubUser {
        github_user_id: github_user_id.clone(),
        login: snapshot.connection.login,
        avatar_url: snapshot.connection.avatar_url,
    };
    let status = status_for_discovery(&installations, &discovered_repositories);
    let (connection_record, installation_records, repository_records) =
        discovery_records(&user, status, &installations, &discovered_repositories)?;
    repositories
        .replace_github_snapshot(
            &connection_record,
            &installation_records,
            &repository_records,
        )
        .await
        .map_err(|_| github_storage_unavailable())?;
    connection_from_snapshot(GitHubSnapshotRecord {
        connection: connection_record,
        installations: installation_records,
        repositories: repository_records,
    })
}

async fn usable_tokens(
    client: &GitHubAuthClient,
    vault: &dyn GitHubTokenVault,
    repositories: &Repositories,
    config: &GitHubAppConfig,
    github_user_id: &str,
    force_refresh: bool,
) -> Result<StoredGitHubTokens, AppError> {
    let lock = refresh_lock_for(github_user_id);
    let _guard = lock.lock().await;
    let stored = match vault.load(github_user_id).await {
        Ok(Some(tokens)) if tokens.github_user_id == github_user_id => tokens,
        Ok(_) => return terminal_reconnect(vault, repositories, github_user_id).await,
        Err(error) if error.code == "github_token_store_invalid" => {
            return terminal_reconnect(vault, repositories, github_user_id).await;
        }
        Err(error) => return Err(error),
    };
    if stored.refresh_token_expires_at_unix <= now_unix() {
        return terminal_reconnect(vault, repositories, github_user_id).await;
    }
    if !force_refresh && access_token_is_fresh(stored.expires_at_unix) {
        return Ok(stored);
    }

    let outcome = client
        .refresh_tokens(&config.client_id, &stored.refresh_token)
        .await?;
    let rotated = match outcome {
        RefreshOutcome::Refreshed(grant) => grant.into_stored(github_user_id.to_owned()),
        RefreshOutcome::InvalidGrant => {
            return terminal_reconnect(vault, repositories, github_user_id).await;
        }
    };
    if vault.store(github_user_id, &rotated).await.is_err() {
        let _ = vault.delete(github_user_id).await;
        mark_reconnect_required(repositories, github_user_id).await?;
        return Err(github_reconnect_required());
    }
    Ok(rotated)
}

async fn terminal_reconnect<T>(
    vault: &dyn GitHubTokenVault,
    repositories: &Repositories,
    github_user_id: &str,
) -> Result<T, AppError> {
    let _ = vault.delete(github_user_id).await;
    mark_reconnect_required(repositories, github_user_id).await?;
    Err(github_reconnect_required())
}

async fn mark_reconnect_required(
    repositories: &Repositories,
    github_user_id: &str,
) -> Result<(), AppError> {
    repositories
        .set_github_connection_status(
            github_user_id,
            GitHubConnectionStatus::ReconnectRequired.as_str(),
        )
        .await
        .map_err(|_| github_storage_unavailable())
}

#[cfg(debug_assertions)]
fn consume_debug_force_refresh_once() -> bool {
    use std::sync::atomic::{AtomicBool, Ordering};
    static CONSUMED: AtomicBool = AtomicBool::new(false);
    super::env_truthy("OS_JUNE_GITHUB_FORCE_REFRESH_ONCE")
        && CONSUMED
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
}

#[cfg(not(debug_assertions))]
fn consume_debug_force_refresh_once() -> bool {
    false
}

pub async fn disconnect(
    vault: &dyn GitHubTokenVault,
    repositories: &Repositories,
) -> Result<(), AppError> {
    let Some(snapshot) = repositories
        .github_snapshot()
        .await
        .map_err(|_| github_storage_unavailable())?
    else {
        return Ok(());
    };
    let github_user_id = snapshot.connection.github_user_id;
    vault.delete(&github_user_id).await?;
    repositories
        .delete_github_state(&github_user_id)
        .await
        .map_err(|_| github_storage_unavailable())
}

fn status_for_discovery(
    installations: &[DiscoveredGitHubInstallation],
    repositories: &[DiscoveredGitHubRepository],
) -> GitHubConnectionStatus {
    let has_accessible_repository = repositories.iter().any(|repository| {
        installations.iter().any(|installation| {
            installation.installation_id == repository.installation_id
                && installation.suspended_at.is_none()
        })
    });
    if has_accessible_repository {
        GitHubConnectionStatus::Connected
    } else {
        GitHubConnectionStatus::SetupIncomplete
    }
}

fn discovery_records(
    user: &DiscoveredGitHubUser,
    status: GitHubConnectionStatus,
    installations: &[DiscoveredGitHubInstallation],
    repositories: &[DiscoveredGitHubRepository],
) -> Result<
    (
        GitHubConnectionRecord,
        Vec<GitHubInstallationRecord>,
        Vec<GitHubRepositoryRecord>,
    ),
    AppError,
> {
    let refreshed_at = crate::db::repositories::timestamp();
    let installation_records = installations
        .iter()
        .map(|installation| {
            Ok(GitHubInstallationRecord {
                installation_id: installation.installation_id.clone(),
                github_user_id: user.github_user_id.clone(),
                owner_id: installation.owner_id.clone(),
                owner_login: installation.owner_login.clone(),
                owner_type: installation.owner_type.clone(),
                management_url: installation.management_url.clone(),
                repository_selection: installation.repository_selection.clone(),
                permissions_json: serde_json::to_string(&installation.permissions)
                    .map_err(|_| github_state_invalid())?,
                suspended_at: installation.suspended_at.clone(),
                last_refreshed_at: refreshed_at.clone(),
            })
        })
        .collect::<Result<Vec<_>, AppError>>()?;
    let repository_records = repositories
        .iter()
        .map(|repository| {
            Ok(GitHubRepositoryRecord {
                repository_id: repository.repository_id.clone(),
                installation_id: repository.installation_id.clone(),
                owner_login: repository.owner_login.clone(),
                name: repository.name.clone(),
                full_name: repository.full_name.clone(),
                is_private: repository.is_private,
                is_archived: repository.is_archived,
                permissions_json: serde_json::to_string(&repository.permissions)
                    .map_err(|_| github_state_invalid())?,
            })
        })
        .collect::<Result<Vec<_>, AppError>>()?;
    Ok((
        GitHubConnectionRecord {
            github_user_id: user.github_user_id.clone(),
            login: user.login.clone(),
            avatar_url: user.avatar_url.clone(),
            status: status.as_str().to_owned(),
        },
        installation_records,
        repository_records,
    ))
}

fn connection_from_snapshot(snapshot: GitHubSnapshotRecord) -> Result<GitHubConnection, AppError> {
    let mut installations = Vec::with_capacity(snapshot.installations.len());
    let mut installation_indexes = HashMap::new();
    for record in snapshot.installations {
        if record.github_user_id != snapshot.connection.github_user_id
            || installation_indexes.contains_key(&record.installation_id)
        {
            return Err(github_state_invalid());
        }
        let permissions =
            serde_json::from_str::<BTreeMap<String, String>>(&record.permissions_json)
                .map_err(|_| github_state_invalid())?;
        installation_indexes.insert(record.installation_id.clone(), installations.len());
        installations.push(GitHubInstallation {
            installation_id: record.installation_id,
            owner_id: record.owner_id,
            owner_login: record.owner_login,
            owner_type: record.owner_type,
            repository_selection: record.repository_selection,
            permissions,
            suspended_at: record.suspended_at,
            repositories: Vec::new(),
        });
    }
    for record in snapshot.repositories {
        let Some(index) = installation_indexes.get(&record.installation_id).copied() else {
            return Err(github_state_invalid());
        };
        let permissions = serde_json::from_str::<BTreeMap<String, bool>>(&record.permissions_json)
            .map_err(|_| github_state_invalid())?;
        installations[index].repositories.push(GitHubRepository {
            repository_id: record.repository_id,
            installation_id: record.installation_id,
            owner_login: record.owner_login,
            name: record.name,
            full_name: record.full_name,
            private: record.is_private,
            archived: record.is_archived,
            permissions,
        });
    }
    Ok(GitHubConnection {
        github_user_id: snapshot.connection.github_user_id,
        login: snapshot.connection.login,
        avatar_url: snapshot.connection.avatar_url,
        status: GitHubConnectionStatus::from_db(&snapshot.connection.status)?,
        installations,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        connectors::{
            github_auth::{
                tests::{
                    read_safe_request, scripted_server, RequestExpectations, ResponseFixture,
                    SafeScriptCapture,
                },
                GitHubAuthClient, GitHubCompletionHook, GitHubConnectFlow,
            },
            github_store::StoredGitHubTokens,
        },
        db::repositories::{
            GitHubConnectionRecord, GitHubInstallationRecord, GitHubRepositoryRecord,
            GitHubSnapshotReplaceHook, Repositories,
        },
    };
    use std::{
        collections::HashMap,
        sync::{
            atomic::{AtomicBool, Ordering},
            Mutex,
        },
    };
    use tokio::io::AsyncWriteExt;

    #[derive(Default)]
    struct InMemoryGitHubTokenVault {
        tokens: tokio::sync::Mutex<HashMap<String, StoredGitHubTokens>>,
        operations: Mutex<Vec<String>>,
        fail_next_store: AtomicBool,
        fail_delete_for: Mutex<Option<String>>,
        load_error: Mutex<Option<AppError>>,
        store_hook: Mutex<
            Option<(
                std::sync::Arc<tokio::sync::Notify>,
                std::sync::Arc<tokio::sync::Notify>,
            )>,
        >,
    }

    impl InMemoryGitHubTokenVault {
        async fn insert(&self, tokens: StoredGitHubTokens) {
            self.tokens
                .lock()
                .await
                .insert(tokens.github_user_id.clone(), tokens);
        }

        async fn token(&self, github_user_id: &str) -> Option<StoredGitHubTokens> {
            self.tokens.lock().await.get(github_user_id).cloned()
        }

        async fn is_empty(&self) -> bool {
            self.tokens.lock().await.is_empty()
        }

        fn operations(&self) -> Vec<String> {
            self.operations.lock().expect("vault operations").clone()
        }

        fn fail_next_store(&self) {
            self.fail_next_store.store(true, Ordering::SeqCst);
        }

        fn fail_load_as_invalid(&self) {
            *self.load_error.lock().expect("load error") = Some(AppError::new(
                "github_token_store_invalid",
                "Stored GitHub tokens are invalid.",
            ));
        }

        fn fail_delete(&self) {
            *self.fail_delete_for.lock().expect("delete failure") = Some("123".into());
        }

        fn fail_delete_for(&self, github_user_id: &str) {
            *self.fail_delete_for.lock().expect("delete failure") = Some(github_user_id.to_owned());
        }

        fn block_next_store(
            &self,
            reached: std::sync::Arc<tokio::sync::Notify>,
            resume: std::sync::Arc<tokio::sync::Notify>,
        ) {
            *self.store_hook.lock().expect("store hook") = Some((reached, resume));
        }
    }

    impl GitHubTokenVault for InMemoryGitHubTokenVault {
        fn load<'a>(
            &'a self,
            github_user_id: &'a str,
        ) -> GitHubVaultFuture<'a, Option<StoredGitHubTokens>> {
            Box::pin(async move {
                self.operations
                    .lock()
                    .expect("vault operations")
                    .push(format!("load:{github_user_id}"));
                if let Some(error) = self.load_error.lock().expect("load error").clone() {
                    return Err(error);
                }
                Ok(self.tokens.lock().await.get(github_user_id).cloned())
            })
        }

        fn store<'a>(
            &'a self,
            github_user_id: &'a str,
            tokens: &'a StoredGitHubTokens,
        ) -> GitHubVaultFuture<'a, ()> {
            Box::pin(async move {
                self.operations
                    .lock()
                    .expect("vault operations")
                    .push(format!("store:{github_user_id}"));
                let hook = self.store_hook.lock().expect("store hook").take();
                if let Some((reached, resume)) = hook {
                    reached.notify_one();
                    resume.notified().await;
                }
                if self.fail_next_store.swap(false, Ordering::SeqCst) {
                    return Err(AppError::new("test_vault_failed", "Test vault failed."));
                }
                self.tokens
                    .lock()
                    .await
                    .insert(github_user_id.to_owned(), tokens.clone());
                Ok(())
            })
        }

        fn delete<'a>(&'a self, github_user_id: &'a str) -> GitHubVaultFuture<'a, ()> {
            Box::pin(async move {
                self.operations
                    .lock()
                    .expect("vault operations")
                    .push(format!("delete:{github_user_id}"));
                if self
                    .fail_delete_for
                    .lock()
                    .expect("delete failure")
                    .as_deref()
                    == Some(github_user_id)
                {
                    return Err(AppError::new("test_vault_failed", "Test vault failed."));
                }
                self.tokens.lock().await.remove(github_user_id);
                Ok(())
            })
        }
    }

    async fn test_repositories() -> Repositories {
        let pool = sqlx_sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .expect("sqlite memory");
        crate::db::migrations::run_migrations(&pool)
            .await
            .expect("migrations");
        Repositories::new(pool)
    }

    fn config() -> GitHubAppConfig {
        GitHubAppConfig {
            client_id: "Iv23example".to_owned(),
            slug: "june-staging".to_owned(),
        }
    }

    fn now_unix() -> i64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("system clock")
            .as_secs() as i64
    }

    fn stored_tokens(
        github_user_id: &str,
        access_token: &str,
        refresh_token: &str,
        expires_at_unix: i64,
    ) -> StoredGitHubTokens {
        StoredGitHubTokens {
            github_user_id: github_user_id.to_owned(),
            access_token: access_token.to_owned(),
            refresh_token: refresh_token.to_owned(),
            expires_at_unix,
            refresh_token_expires_at_unix: now_unix() + 86_400,
        }
    }

    fn device_fixture() -> (ResponseFixture, RequestExpectations) {
        (
            ResponseFixture::json(
                200,
                r#"{"device_code":"device-secret","user_code":"ABCD-EFGH","verification_uri":"https://github.com/login/device","expires_in":60,"interval":1}"#,
            ),
            RequestExpectations {
                client_id: Some("Iv23example"),
                ..RequestExpectations::default()
            },
        )
    }

    fn token_fixture() -> (ResponseFixture, RequestExpectations) {
        (
            ResponseFixture::json(
                200,
                r#"{"access_token":"access-one","refresh_token":"refresh-one","expires_in":28800,"refresh_token_expires_in":15811200}"#,
            ),
            RequestExpectations {
                client_id: Some("Iv23example"),
                device_code: Some("device-secret"),
                grant_type: Some("urn:ietf:params:oauth:grant-type:device_code"),
                ..RequestExpectations::default()
            },
        )
    }

    fn user_fixture(
        github_user_id: &str,
        login: &str,
        bearer: &'static str,
    ) -> (ResponseFixture, RequestExpectations) {
        (
            ResponseFixture::json(
                200,
                format!(
                    r#"{{"id":{github_user_id},"login":"{login}","avatar_url":"https://avatars.githubusercontent.com/u/{github_user_id}"}}"#
                ),
            ),
            RequestExpectations {
                bearer_token: Some(bearer),
                ..RequestExpectations::default()
            },
        )
    }

    fn installations_fixture(
        bearer: &'static str,
        suspended_at: Option<&str>,
        permissions: &str,
    ) -> (ResponseFixture, RequestExpectations) {
        let suspended = suspended_at
            .map(|value| format!(r#""{value}""#))
            .unwrap_or_else(|| "null".to_owned());
        (
            ResponseFixture::json(
                200,
                format!(
                    r#"{{"installations":[{{"id":456,"account":{{"id":321,"login":"open-software-network","type":"Organization"}},"html_url":"https://github.com/organizations/open-software-network/settings/installations/456","repository_selection":"selected","permissions":{permissions},"suspended_at":{suspended}}}]}}"#
                ),
            ),
            RequestExpectations {
                bearer_token: Some(bearer),
                ..RequestExpectations::default()
            },
        )
    }

    fn repositories_fixture(
        bearer: &'static str,
        repositories: &str,
    ) -> (ResponseFixture, RequestExpectations) {
        (
            ResponseFixture::json(200, format!(r#"{{"repositories":{repositories}}}"#)),
            RequestExpectations {
                bearer_token: Some(bearer),
                ..RequestExpectations::default()
            },
        )
    }

    fn repository_json(id: u64, name: &str, permissions: &str) -> String {
        format!(
            r#"{{"id":{id},"owner":{{"login":"open-software-network"}},"name":"{name}","full_name":"open-software-network/{name}","private":true,"archived":false,"permissions":{permissions}}}"#
        )
    }

    fn refresh_fixture(
        old_refresh: &'static str,
        new_access: &str,
        new_refresh: &str,
    ) -> (ResponseFixture, RequestExpectations) {
        (
            ResponseFixture::json(
                200,
                format!(
                    r#"{{"access_token":"{new_access}","refresh_token":"{new_refresh}","expires_in":28800,"refresh_token_expires_in":15811200}}"#
                ),
            ),
            RequestExpectations {
                client_id: Some("Iv23example"),
                refresh_token: Some(old_refresh),
                grant_type: Some("refresh_token"),
                ..RequestExpectations::default()
            },
        )
    }

    async fn concurrent_refresh_server(
        repository: String,
    ) -> (String, tokio::task::JoinHandle<Vec<SafeScriptCapture>>) {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .expect("bind concurrent refresh server");
        let base_url = format!("http://{}", listener.local_addr().expect("server address"));
        let task = tokio::spawn(async move {
            let mut captures = Vec::new();
            for _ in 0..5 {
                let (mut stream, _) = listener.accept().await.expect("accept request");
                let capture = read_safe_request(&mut stream, &RequestExpectations::default()).await;
                let body = if capture.path == "/login/oauth/access_token" {
                    r#"{"access_token":"access-new","refresh_token":"refresh-new","expires_in":28800,"refresh_token_expires_in":15811200}"#.to_owned()
                } else if capture.path.starts_with("/user/installations?") {
                    r#"{"installations":[{"id":456,"account":{"id":321,"login":"open-software-network","type":"Organization"},"html_url":"https://github.com/organizations/open-software-network/settings/installations/456","repository_selection":"selected","permissions":{"contents":"read"},"suspended_at":null}]}"#.to_owned()
                } else if capture
                    .path
                    .starts_with("/user/installations/456/repositories?")
                {
                    format!(r#"{{"repositories":[{repository}]}}"#)
                } else {
                    panic!("unexpected safe request path: {}", capture.path);
                };
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(), body
                );
                stream
                    .write_all(response.as_bytes())
                    .await
                    .expect("write routed response");
                captures.push(capture);
            }
            captures
        });
        (base_url, task)
    }

    fn unauthorized_fixture(bearer: &'static str) -> (ResponseFixture, RequestExpectations) {
        (
            ResponseFixture::json(401, r#"{"message":"not shown"}"#),
            RequestExpectations {
                bearer_token: Some(bearer),
                ..RequestExpectations::default()
            },
        )
    }

    async fn seed_snapshot(
        repositories: &Repositories,
        github_user_id: &str,
        status: &str,
        suspended_at: Option<&str>,
        repository_permissions: Option<&str>,
    ) {
        let installation = GitHubInstallationRecord {
            installation_id: "456".into(),
            github_user_id: github_user_id.into(),
            owner_id: "321".into(),
            owner_login: "open-software-network".into(),
            owner_type: "Organization".into(),
            management_url:
                "https://github.com/organizations/open-software-network/settings/installations/456"
                    .into(),
            repository_selection: "selected".into(),
            permissions_json: r#"{"contents":"read"}"#.into(),
            suspended_at: suspended_at.map(str::to_owned),
            last_refreshed_at: "2026-07-15T00:00:00Z".into(),
        };
        let cached_repositories = repository_permissions
            .map(|permissions| GitHubRepositoryRecord {
                repository_id: "789".into(),
                installation_id: "456".into(),
                owner_login: "open-software-network".into(),
                name: "test-repo".into(),
                full_name: "open-software-network/test-repo".into(),
                is_private: true,
                is_archived: false,
                permissions_json: permissions.into(),
            })
            .into_iter()
            .collect::<Vec<_>>();
        repositories
            .replace_github_snapshot(
                &GitHubConnectionRecord {
                    github_user_id: github_user_id.into(),
                    login: if github_user_id == "123" {
                        "octocat".into()
                    } else {
                        "hubot".into()
                    },
                    avatar_url: None,
                    status: status.into(),
                },
                &[installation],
                &cached_repositories,
            )
            .await
            .expect("seed GitHub snapshot");
    }

    async fn complete_fixture(
        discovery: Vec<(ResponseFixture, RequestExpectations)>,
    ) -> (GitHubConnection, InMemoryGitHubTokenVault, Repositories) {
        let mut script = vec![device_fixture(), token_fixture()];
        script.extend(discovery);
        let (base_url, server) = scripted_server(script).await;
        let client = GitHubAuthClient::for_test(&base_url).expect("test client");
        let flow = GitHubConnectFlow::default();
        let vault = InMemoryGitHubTokenVault::default();
        let repositories = test_repositories().await;
        flow.start(&client, &config().client_id)
            .await
            .expect("device prompt");
        let connection = complete_connect(&flow, &client, &vault, &repositories, &config())
            .await
            .expect("complete connection");
        server.await.expect("fixture server");
        (connection, vault, repositories)
    }

    #[test]
    fn config_requires_both_public_identifiers() {
        assert_eq!(
            config_from_values("".into(), "june-staging".into())
                .unwrap_err()
                .code,
            "github_not_configured"
        );
        assert_eq!(
            config_from_values("Iv23example".into(), "".into())
                .unwrap_err()
                .code,
            "github_not_configured"
        );
    }

    #[test]
    fn config_builds_installation_url_from_slug() {
        let config =
            config_from_values("Iv23lihKGi1yIb8QZm9L".into(), "june-staging".into()).unwrap();
        assert_eq!(
            config.installation_url(),
            "https://github.com/apps/june-staging/installations/new"
        );
    }

    #[test]
    fn config_rejects_values_that_can_change_the_github_origin_or_path() {
        assert!(config_from_values("bad client".into(), "june-staging".into()).is_err());
        assert!(config_from_values("Iv23example".into(), "../login".into()).is_err());
        assert!(config_from_values("Iv23example".into(), "-june".into()).is_err());
    }

    #[tokio::test]
    async fn authorization_stores_by_stable_user_id_and_returns_connected() {
        let repository = repository_json(789, "test-repo", r#"{"pull":true}"#);
        let (connection, vault, repositories) = complete_fixture(vec![
            user_fixture("123", "octocat", "access-one"),
            installations_fixture("access-one", None, r#"{"contents":"read"}"#),
            repositories_fixture("access-one", &format!("[{repository}]")),
        ])
        .await;

        assert_eq!(connection.github_user_id, "123");
        assert_eq!(connection.status, GitHubConnectionStatus::Connected);
        assert_eq!(
            connection.installations[0].repositories[0].repository_id,
            "789"
        );
        assert!(vault.token("123").await.is_some());
        assert_eq!(
            connection_get(&vault, &repositories)
                .await
                .expect("cached connection"),
            Some(connection)
        );
    }

    #[tokio::test]
    async fn authorization_without_repositories_is_setup_incomplete_but_persists() {
        let (connection, vault, repositories) = complete_fixture(vec![
            user_fixture("123", "octocat", "access-one"),
            installations_fixture("access-one", None, r#"{"contents":"read"}"#),
            repositories_fixture("access-one", "[]"),
        ])
        .await;

        assert_eq!(connection.status, GitHubConnectionStatus::SetupIncomplete);
        assert!(vault.token("123").await.is_some());
        assert!(repositories.github_snapshot().await.unwrap().is_some());
    }

    #[tokio::test]
    async fn suspended_only_installation_is_retained_and_setup_incomplete() {
        let (connection, vault, _) = complete_fixture(vec![
            user_fixture("123", "octocat", "access-one"),
            installations_fixture(
                "access-one",
                Some("2026-07-15T00:00:00Z"),
                r#"{"contents":"read"}"#,
            ),
        ])
        .await;

        assert_eq!(connection.status, GitHubConnectionStatus::SetupIncomplete);
        assert_eq!(connection.installations.len(), 1);
        assert!(connection.installations[0].suspended_at.is_some());
        assert!(connection.installations[0].repositories.is_empty());
        assert!(vault.token("123").await.is_some());
    }

    #[tokio::test]
    async fn missing_keychain_entry_marks_cached_connection_reconnect_required() {
        let repositories = test_repositories().await;
        repositories
            .replace_github_snapshot(
                &GitHubConnectionRecord {
                    github_user_id: "123".into(),
                    login: "octocat".into(),
                    avatar_url: None,
                    status: "connected".into(),
                },
                &[],
                &[],
            )
            .await
            .unwrap();
        let vault = InMemoryGitHubTokenVault::default();

        let connection = connection_get(&vault, &repositories)
            .await
            .expect("cached connection")
            .expect("connection");
        assert_eq!(connection.status, GitHubConnectionStatus::ReconnectRequired);
        assert_eq!(
            repositories
                .github_snapshot()
                .await
                .unwrap()
                .unwrap()
                .connection
                .status,
            "reconnect_required"
        );
    }

    #[tokio::test]
    async fn invalid_or_mismatched_keychain_payload_marks_cached_connection_reconnect_required() {
        let repositories = test_repositories().await;
        seed_snapshot(&repositories, "123", "connected", None, None).await;
        let vault = InMemoryGitHubTokenVault::default();
        vault.fail_load_as_invalid();

        let connection = connection_get(&vault, &repositories)
            .await
            .expect("cached connection")
            .expect("connection");
        assert_eq!(connection.status, GitHubConnectionStatus::ReconnectRequired);
        assert_eq!(
            repositories
                .github_snapshot()
                .await
                .unwrap()
                .unwrap()
                .connection
                .status,
            "reconnect_required"
        );
    }

    #[tokio::test]
    async fn malformed_permissions_and_orphan_repositories_fail_closed() {
        let snapshot = crate::db::repositories::GitHubSnapshotRecord {
            connection: GitHubConnectionRecord {
                github_user_id: "123".into(),
                login: "octocat".into(),
                avatar_url: None,
                status: "connected".into(),
            },
            installations: vec![GitHubInstallationRecord {
                installation_id: "456".into(),
                github_user_id: "123".into(),
                owner_id: "321".into(),
                owner_login: "open-software-network".into(),
                owner_type: "Organization".into(),
                management_url: "https://github.com/organizations/open-software-network/settings/installations/456".into(),
                repository_selection: "selected".into(),
                permissions_json: "not-json".into(),
                suspended_at: None,
                last_refreshed_at: "2026-07-15T00:00:00Z".into(),
            }],
            repositories: vec![GitHubRepositoryRecord {
                repository_id: "789".into(),
                installation_id: "missing".into(),
                owner_login: "open-software-network".into(),
                name: "test-repo".into(),
                full_name: "open-software-network/test-repo".into(),
                is_private: true,
                is_archived: false,
                permissions_json: "{}".into(),
            }],
        };

        assert_eq!(
            connection_from_snapshot(snapshot).unwrap_err().code,
            "github_state_invalid"
        );
    }

    #[test]
    fn orphan_repository_with_otherwise_valid_permissions_fails_closed() {
        let snapshot = crate::db::repositories::GitHubSnapshotRecord {
            connection: GitHubConnectionRecord {
                github_user_id: "123".into(),
                login: "octocat".into(),
                avatar_url: None,
                status: "connected".into(),
            },
            installations: vec![GitHubInstallationRecord {
                installation_id: "456".into(),
                github_user_id: "123".into(),
                owner_id: "321".into(),
                owner_login: "open-software-network".into(),
                owner_type: "Organization".into(),
                management_url: "https://github.com/organizations/open-software-network/settings/installations/456".into(),
                repository_selection: "selected".into(),
                permissions_json: r#"{"contents":"read"}"#.into(),
                suspended_at: None,
                last_refreshed_at: "2026-07-15T00:00:00Z".into(),
            }],
            repositories: vec![GitHubRepositoryRecord {
                repository_id: "789".into(),
                installation_id: "missing".into(),
                owner_login: "open-software-network".into(),
                name: "test-repo".into(),
                full_name: "open-software-network/test-repo".into(),
                is_private: true,
                is_archived: false,
                permissions_json: r#"{"pull":true}"#.into(),
            }],
        };

        assert_eq!(
            connection_from_snapshot(snapshot).unwrap_err().code,
            "github_state_invalid"
        );
    }

    #[tokio::test]
    async fn near_expiry_refreshes_before_discovery_and_rotates_both_tokens() {
        let repositories = test_repositories().await;
        seed_snapshot(
            &repositories,
            "123",
            "connected",
            None,
            Some(r#"{"pull":true}"#),
        )
        .await;
        let vault = InMemoryGitHubTokenVault::default();
        vault
            .insert(stored_tokens(
                "123",
                "access-old",
                "refresh-old",
                now_unix() + 30,
            ))
            .await;
        let repository = repository_json(789, "test-repo", r#"{"pull":true}"#);
        let (base_url, server) = scripted_server(vec![
            refresh_fixture("refresh-old", "access-new", "refresh-new"),
            installations_fixture("access-new", None, r#"{"contents":"read"}"#),
            repositories_fixture("access-new", &format!("[{repository}]")),
        ])
        .await;
        let client = GitHubAuthClient::for_test(&base_url).expect("test client");

        let connection = installations_refresh(&client, &vault, &repositories, &config())
            .await
            .expect("refresh installations");
        assert_eq!(connection.status, GitHubConnectionStatus::Connected);
        let rotated = vault.token("123").await.expect("rotated tokens");
        assert_eq!(rotated.access_token, "access-new");
        assert_eq!(rotated.refresh_token, "refresh-new");
        let captures = server.await.expect("refresh server");
        assert_eq!(captures.len(), 3);
    }

    #[tokio::test]
    async fn disconnect_is_secret_first_and_preserves_rows_when_secret_delete_fails() {
        let repositories = test_repositories().await;
        seed_snapshot(&repositories, "123", "connected", None, None).await;
        let vault = InMemoryGitHubTokenVault::default();
        vault
            .insert(stored_tokens(
                "123",
                "access-old",
                "refresh-old",
                now_unix() + 3600,
            ))
            .await;
        vault.fail_delete();

        assert!(disconnect(&vault, &repositories).await.is_err());
        assert!(vault.token("123").await.is_some());
        assert!(repositories.github_snapshot().await.unwrap().is_some());
        assert_eq!(vault.operations()[0], "delete:123");
    }

    #[tokio::test]
    async fn connecting_a_second_user_replaces_snapshot_then_removes_old_custody() {
        let repositories = test_repositories().await;
        seed_snapshot(&repositories, "123", "connected", None, None).await;
        let vault = InMemoryGitHubTokenVault::default();
        vault
            .insert(stored_tokens(
                "123",
                "old-access",
                "old-refresh",
                now_unix() + 3600,
            ))
            .await;
        let repository = repository_json(789, "test-repo", r#"{"pull":true}"#);
        let (base_url, server) = scripted_server(vec![
            device_fixture(),
            token_fixture(),
            user_fixture("999", "hubot", "access-one"),
            installations_fixture("access-one", None, r#"{"contents":"read"}"#),
            repositories_fixture("access-one", &format!("[{repository}]")),
        ])
        .await;
        let client = GitHubAuthClient::for_test(&base_url).unwrap();
        let flow = GitHubConnectFlow::default();
        flow.start(&client, &config().client_id).await.unwrap();

        let connection = complete_connect(&flow, &client, &vault, &repositories, &config())
            .await
            .unwrap();
        assert_eq!(connection.github_user_id, "999");
        assert!(vault.token("123").await.is_none());
        assert!(vault.token("999").await.is_some());
        assert_eq!(
            vault.operations(),
            vec!["load:123", "store:999", "delete:123"]
        );
        server.await.unwrap();
    }

    #[tokio::test]
    async fn old_custody_delete_failure_removes_new_token_and_preserves_snapshot() {
        let repositories = test_repositories().await;
        seed_snapshot(&repositories, "123", "connected", None, None).await;
        let vault = InMemoryGitHubTokenVault::default();
        vault
            .insert(stored_tokens(
                "123",
                "old-access",
                "old-refresh",
                now_unix() + 3600,
            ))
            .await;
        vault.fail_delete_for("123");
        let repository = repository_json(789, "test-repo", r#"{"pull":true}"#);
        let (base_url, server) = scripted_server(vec![
            device_fixture(),
            token_fixture(),
            user_fixture("999", "hubot", "access-one"),
            installations_fixture("access-one", None, r#"{"contents":"read"}"#),
            repositories_fixture("access-one", &format!("[{repository}]")),
        ])
        .await;
        let client = GitHubAuthClient::for_test(&base_url).unwrap();
        let flow = GitHubConnectFlow::default();
        flow.start(&client, &config().client_id).await.unwrap();

        assert!(
            complete_connect(&flow, &client, &vault, &repositories, &config())
                .await
                .is_err()
        );
        assert!(vault.token("123").await.is_some());
        assert!(vault.token("999").await.is_none());
        assert_eq!(
            repositories
                .github_snapshot()
                .await
                .unwrap()
                .unwrap()
                .connection
                .github_user_id,
            "123"
        );
        server.await.unwrap();
    }

    #[tokio::test]
    async fn concurrent_near_expiry_refreshes_issue_one_provider_refresh() {
        let repositories = test_repositories().await;
        seed_snapshot(&repositories, "123", "connected", None, None).await;
        let vault = std::sync::Arc::new(InMemoryGitHubTokenVault::default());
        vault
            .insert(stored_tokens(
                "123",
                "access-old",
                "refresh-old",
                now_unix() + 30,
            ))
            .await;
        let repository = repository_json(789, "test-repo", r#"{"pull":true}"#);
        let (base_url, server) = concurrent_refresh_server(repository).await;
        let client = std::sync::Arc::new(GitHubAuthClient::for_test(&base_url).unwrap());
        let repositories = std::sync::Arc::new(repositories);
        let first = {
            let client = client.clone();
            let vault = vault.clone();
            let repositories = repositories.clone();
            tokio::spawn(async move {
                installations_refresh(&client, vault.as_ref(), &repositories, &config()).await
            })
        };
        let second = {
            let client = client.clone();
            let vault = vault.clone();
            let repositories = repositories.clone();
            tokio::spawn(async move {
                installations_refresh(&client, vault.as_ref(), &repositories, &config()).await
            })
        };
        first.await.unwrap().unwrap();
        second.await.unwrap().unwrap();
        let captures = server.await.unwrap();
        assert_eq!(
            captures
                .iter()
                .filter(|capture| capture.path == "/login/oauth/access_token")
                .count(),
            1
        );
    }

    #[tokio::test]
    async fn discovery_unauthorized_refreshes_once_then_terminally_reconnects() {
        let repositories = test_repositories().await;
        seed_snapshot(&repositories, "123", "connected", None, None).await;
        let vault = InMemoryGitHubTokenVault::default();
        vault
            .insert(stored_tokens(
                "123",
                "access-old",
                "refresh-old",
                now_unix() + 3600,
            ))
            .await;
        let (base_url, server) = scripted_server(vec![
            unauthorized_fixture("access-old"),
            refresh_fixture("refresh-old", "access-new", "refresh-new"),
            unauthorized_fixture("access-new"),
        ])
        .await;
        let client = GitHubAuthClient::for_test(&base_url).unwrap();

        let error = installations_refresh(&client, &vault, &repositories, &config())
            .await
            .unwrap_err();
        assert_eq!(error.code, "github_reconnect_required");
        assert!(vault.is_empty().await);
        assert_eq!(
            repositories
                .github_snapshot()
                .await
                .unwrap()
                .unwrap()
                .connection
                .status,
            "reconnect_required"
        );
        assert_eq!(server.await.unwrap().len(), 3);
    }

    #[tokio::test]
    async fn unauthorized_then_invalid_grant_skips_second_discovery() {
        let repositories = test_repositories().await;
        seed_snapshot(&repositories, "123", "connected", None, None).await;
        let vault = InMemoryGitHubTokenVault::default();
        vault
            .insert(stored_tokens(
                "123",
                "access-old",
                "refresh-old",
                now_unix() + 3600,
            ))
            .await;
        let (base_url, server) = scripted_server(vec![
            unauthorized_fixture("access-old"),
            (
                ResponseFixture::json(400, r#"{"error":"bad_refresh_token"}"#),
                RequestExpectations {
                    client_id: Some("Iv23example"),
                    refresh_token: Some("refresh-old"),
                    grant_type: Some("refresh_token"),
                    ..RequestExpectations::default()
                },
            ),
        ])
        .await;
        let client = GitHubAuthClient::for_test(&base_url).unwrap();

        assert_eq!(
            installations_refresh(&client, &vault, &repositories, &config())
                .await
                .unwrap_err()
                .code,
            "github_reconnect_required"
        );
        assert!(vault.is_empty().await);
        assert_eq!(server.await.unwrap().len(), 2);
    }

    #[tokio::test]
    async fn transient_refresh_failure_preserves_token_and_good_snapshot() {
        let repositories = test_repositories().await;
        seed_snapshot(
            &repositories,
            "123",
            "connected",
            None,
            Some(r#"{"pull":true}"#),
        )
        .await;
        let original = repositories.github_snapshot().await.unwrap().unwrap();
        let vault = InMemoryGitHubTokenVault::default();
        vault
            .insert(stored_tokens(
                "123",
                "access-old",
                "refresh-old",
                now_unix() + 30,
            ))
            .await;
        let (base_url, server) = scripted_server(vec![(
            ResponseFixture::json(500, r#"{"error":"bad_refresh_token"}"#),
            RequestExpectations {
                client_id: Some("Iv23example"),
                refresh_token: Some("refresh-old"),
                grant_type: Some("refresh_token"),
                ..RequestExpectations::default()
            },
        )])
        .await;
        let client = GitHubAuthClient::for_test(&base_url).unwrap();

        assert_eq!(
            installations_refresh(&client, &vault, &repositories, &config())
                .await
                .unwrap_err()
                .code,
            "github_refresh_failed"
        );
        assert_eq!(vault.token("123").await.unwrap().access_token, "access-old");
        assert_eq!(
            repositories.github_snapshot().await.unwrap().unwrap(),
            original
        );
        server.await.unwrap();
    }

    #[tokio::test]
    async fn rotated_token_store_failure_deletes_stale_pair_and_marks_reconnect() {
        let repositories = test_repositories().await;
        seed_snapshot(&repositories, "123", "connected", None, None).await;
        let vault = InMemoryGitHubTokenVault::default();
        vault
            .insert(stored_tokens(
                "123",
                "access-old",
                "refresh-old",
                now_unix() + 30,
            ))
            .await;
        vault.fail_next_store();
        let (base_url, server) = scripted_server(vec![refresh_fixture(
            "refresh-old",
            "access-new",
            "refresh-new",
        )])
        .await;
        let client = GitHubAuthClient::for_test(&base_url).unwrap();

        assert_eq!(
            installations_refresh(&client, &vault, &repositories, &config())
                .await
                .unwrap_err()
                .code,
            "github_reconnect_required"
        );
        assert!(vault.is_empty().await);
        assert_eq!(
            repositories
                .github_snapshot()
                .await
                .unwrap()
                .unwrap()
                .connection
                .status,
            "reconnect_required"
        );
        server.await.unwrap();
    }

    #[tokio::test]
    async fn mismatched_keychain_identity_is_terminal_without_provider_request() {
        let repositories = test_repositories().await;
        seed_snapshot(&repositories, "123", "connected", None, None).await;
        let vault = InMemoryGitHubTokenVault::default();
        vault.tokens.lock().await.insert(
            "123".into(),
            stored_tokens("999", "wrong-access", "wrong-refresh", now_unix() + 3600),
        );
        let client = GitHubAuthClient::for_test("http://127.0.0.1:9").unwrap();

        assert_eq!(
            installations_refresh(&client, &vault, &repositories, &config())
                .await
                .unwrap_err()
                .code,
            "github_reconnect_required"
        );
        assert!(vault.token("123").await.is_none());
    }

    #[tokio::test]
    async fn database_failure_restores_old_custody_and_leaves_no_new_orphan() {
        let repositories = test_repositories().await;
        seed_snapshot(&repositories, "123", "connected", None, None).await;
        let original = repositories.github_snapshot().await.unwrap().unwrap();
        repositories.fail_next_github_snapshot_replace();
        let vault = InMemoryGitHubTokenVault::default();
        vault
            .insert(stored_tokens(
                "123",
                "old-access",
                "old-refresh",
                now_unix() + 3600,
            ))
            .await;
        let repository = repository_json(789, "test-repo", r#"{"pull":true}"#);
        let (base_url, server) = scripted_server(vec![
            device_fixture(),
            token_fixture(),
            user_fixture("999", "hubot", "access-one"),
            installations_fixture("access-one", None, r#"{"contents":"read"}"#),
            repositories_fixture("access-one", &format!("[{repository}]")),
        ])
        .await;
        let client = GitHubAuthClient::for_test(&base_url).unwrap();
        let flow = GitHubConnectFlow::default();
        flow.start(&client, &config().client_id).await.unwrap();

        assert_eq!(
            complete_connect(&flow, &client, &vault, &repositories, &config())
                .await
                .unwrap_err()
                .code,
            "github_storage_unavailable"
        );
        let old = vault.token("123").await.unwrap();
        assert_eq!(old.access_token, "old-access");
        assert_eq!(old.refresh_token, "old-refresh");
        assert!(vault.token("999").await.is_none());
        assert_eq!(
            repositories.github_snapshot().await.unwrap().unwrap(),
            original
        );
        server.await.unwrap();
    }

    #[tokio::test]
    async fn same_user_database_failure_restores_the_previous_rotating_pair() {
        let repositories = test_repositories().await;
        seed_snapshot(&repositories, "123", "connected", None, None).await;
        repositories.fail_next_github_snapshot_replace();
        let vault = InMemoryGitHubTokenVault::default();
        vault
            .insert(stored_tokens(
                "123",
                "old-access",
                "old-refresh",
                now_unix() + 3600,
            ))
            .await;
        let repository = repository_json(789, "test-repo", r#"{"pull":true}"#);
        let (base_url, server) = scripted_server(vec![
            device_fixture(),
            token_fixture(),
            user_fixture("123", "octocat", "access-one"),
            installations_fixture("access-one", None, r#"{"contents":"read"}"#),
            repositories_fixture("access-one", &format!("[{repository}]")),
        ])
        .await;
        let client = GitHubAuthClient::for_test(&base_url).unwrap();
        let flow = GitHubConnectFlow::default();
        flow.start(&client, &config().client_id).await.unwrap();

        assert!(
            complete_connect(&flow, &client, &vault, &repositories, &config())
                .await
                .is_err()
        );
        let restored = vault.token("123").await.unwrap();
        assert_eq!(restored.access_token, "old-access");
        assert_eq!(restored.refresh_token, "old-refresh");
        server.await.unwrap();
    }

    #[tokio::test]
    async fn transient_request_failure_preserves_valid_custody_and_snapshot() {
        let repositories = test_repositories().await;
        seed_snapshot(
            &repositories,
            "123",
            "connected",
            None,
            Some(r#"{"pull":true}"#),
        )
        .await;
        let original = repositories.github_snapshot().await.unwrap().unwrap();
        let vault = InMemoryGitHubTokenVault::default();
        vault
            .insert(stored_tokens(
                "123",
                "access-valid",
                "refresh-valid",
                now_unix() + 3600,
            ))
            .await;
        let client = GitHubAuthClient::for_test("http://127.0.0.1:9").unwrap();

        assert_eq!(
            installations_refresh(&client, &vault, &repositories, &config())
                .await
                .unwrap_err()
                .code,
            "github_request_failed"
        );
        assert_eq!(
            vault.token("123").await.unwrap().access_token,
            "access-valid"
        );
        assert_eq!(
            repositories.github_snapshot().await.unwrap().unwrap(),
            original
        );
    }

    #[tokio::test]
    async fn refresh_replaces_removed_repositories_downgrades_permissions_and_retains_suspension() {
        let repositories = test_repositories().await;
        seed_snapshot(
            &repositories,
            "123",
            "connected",
            None,
            Some(r#"{"pull":true,"push":true}"#),
        )
        .await;
        let vault = InMemoryGitHubTokenVault::default();
        vault
            .insert(stored_tokens(
                "123",
                "access-valid",
                "refresh-valid",
                now_unix() + 3600,
            ))
            .await;

        let downgraded = repository_json(789, "test-repo", r#"{"pull":true,"push":false}"#);
        let (base_url, server) = scripted_server(vec![
            installations_fixture("access-valid", None, r#"{"contents":"read"}"#),
            repositories_fixture("access-valid", &format!("[{downgraded}]")),
        ])
        .await;
        let client = GitHubAuthClient::for_test(&base_url).unwrap();
        let connection = installations_refresh(&client, &vault, &repositories, &config())
            .await
            .unwrap();
        assert_eq!(
            connection.installations[0].repositories[0]
                .permissions
                .get("push"),
            Some(&false)
        );
        server.await.unwrap();

        let (base_url, server) = scripted_server(vec![
            installations_fixture("access-valid", None, r#"{"contents":"read"}"#),
            repositories_fixture("access-valid", "[]"),
        ])
        .await;
        let client = GitHubAuthClient::for_test(&base_url).unwrap();
        let removed = installations_refresh(&client, &vault, &repositories, &config())
            .await
            .unwrap();
        assert_eq!(removed.status, GitHubConnectionStatus::SetupIncomplete);
        assert!(removed.installations[0].repositories.is_empty());
        server.await.unwrap();

        let (base_url, server) = scripted_server(vec![installations_fixture(
            "access-valid",
            Some("2026-07-15T00:00:00Z"),
            r#"{"contents":"read"}"#,
        )])
        .await;
        let client = GitHubAuthClient::for_test(&base_url).unwrap();
        let suspended = installations_refresh(&client, &vault, &repositories, &config())
            .await
            .unwrap();
        assert!(suspended.installations[0].suspended_at.is_some());
        assert!(suspended.installations[0].repositories.is_empty());
        server.await.unwrap();
    }

    #[tokio::test]
    async fn forced_refresh_rotates_once_while_normal_fresh_path_does_not_rotate() {
        let repositories = test_repositories().await;
        seed_snapshot(&repositories, "123", "connected", None, None).await;
        let vault = InMemoryGitHubTokenVault::default();
        vault
            .insert(stored_tokens(
                "123",
                "access-old",
                "refresh-old",
                now_unix() + 3600,
            ))
            .await;
        let repository = repository_json(789, "test-repo", r#"{"pull":true}"#);
        let (base_url, server) = scripted_server(vec![
            refresh_fixture("refresh-old", "access-new", "refresh-new"),
            installations_fixture("access-new", None, r#"{"contents":"read"}"#),
            repositories_fixture("access-new", &format!("[{repository}]")),
        ])
        .await;
        let client = GitHubAuthClient::for_test(&base_url).unwrap();
        installations_refresh_with_force(&client, &vault, &repositories, &config(), true)
            .await
            .unwrap();
        assert_eq!(
            server
                .await
                .unwrap()
                .iter()
                .filter(|request| request.path == "/login/oauth/access_token")
                .count(),
            1
        );

        let (base_url, server) = scripted_server(vec![
            installations_fixture("access-new", None, r#"{"contents":"read"}"#),
            repositories_fixture("access-new", &format!("[{repository}]")),
        ])
        .await;
        let client = GitHubAuthClient::for_test(&base_url).unwrap();
        installations_refresh_with_force(&client, &vault, &repositories, &config(), false)
            .await
            .unwrap();
        assert!(server
            .await
            .unwrap()
            .iter()
            .all(|request| request.path != "/login/oauth/access_token"));
    }

    #[tokio::test]
    async fn successful_disconnect_removes_secret_and_all_cached_rows() {
        let repositories = test_repositories().await;
        seed_snapshot(
            &repositories,
            "123",
            "connected",
            None,
            Some(r#"{"pull":true}"#),
        )
        .await;
        let vault = InMemoryGitHubTokenVault::default();
        vault
            .insert(stored_tokens(
                "123",
                "access-valid",
                "refresh-valid",
                now_unix() + 3600,
            ))
            .await;

        disconnect(&vault, &repositories).await.unwrap();
        assert!(vault.is_empty().await);
        assert!(repositories.github_snapshot().await.unwrap().is_none());
        assert_eq!(vault.operations(), vec!["delete:123"]);
    }

    #[tokio::test]
    async fn cancellation_after_token_issuance_leaves_no_custody_or_rows() {
        let reached = std::sync::Arc::new(tokio::sync::Notify::new());
        let resume = std::sync::Arc::new(tokio::sync::Notify::new());
        let (base_url, server) = scripted_server(vec![device_fixture(), token_fixture()]).await;
        let client = std::sync::Arc::new(GitHubAuthClient::for_test(&base_url).unwrap());
        let flow = std::sync::Arc::new(GitHubConnectFlow::default());
        flow.set_after_token_hook(GitHubCompletionHook {
            reached: reached.clone(),
            resume: resume.clone(),
        });
        let vault = std::sync::Arc::new(InMemoryGitHubTokenVault::default());
        let repositories = std::sync::Arc::new(test_repositories().await);
        flow.start(&client, &config().client_id).await.unwrap();
        let completion = {
            let flow = flow.clone();
            let client = client.clone();
            let vault = vault.clone();
            let repositories = repositories.clone();
            tokio::spawn(async move {
                complete_connect(&flow, &client, vault.as_ref(), &repositories, &config()).await
            })
        };
        reached.notified().await;
        flow.cancel().await.unwrap();
        resume.notify_one();

        assert_eq!(
            completion.await.unwrap().unwrap_err().code,
            "github_connect_canceled"
        );
        assert!(vault.is_empty().await);
        assert!(repositories.github_snapshot().await.unwrap().is_none());
        server.await.unwrap();
    }

    #[tokio::test]
    async fn cancellation_during_user_lookup_interrupts_provider_await_without_state() {
        let reached = std::sync::Arc::new(tokio::sync::Notify::new());
        let resume = std::sync::Arc::new(tokio::sync::Notify::new());
        let blocked_user = (
            user_fixture("123", "octocat", "access-one")
                .0
                .blocked(reached.clone(), resume.clone()),
            user_fixture("123", "octocat", "access-one").1,
        );
        let (base_url, server) =
            scripted_server(vec![device_fixture(), token_fixture(), blocked_user]).await;
        let client = std::sync::Arc::new(GitHubAuthClient::for_test(&base_url).unwrap());
        let flow = std::sync::Arc::new(GitHubConnectFlow::default());
        let vault = std::sync::Arc::new(InMemoryGitHubTokenVault::default());
        let repositories = std::sync::Arc::new(test_repositories().await);
        flow.start(&client, &config().client_id).await.unwrap();
        let completion = {
            let flow = flow.clone();
            let client = client.clone();
            let vault = vault.clone();
            let repositories = repositories.clone();
            tokio::spawn(async move {
                complete_connect(&flow, &client, vault.as_ref(), &repositories, &config()).await
            })
        };
        reached.notified().await;
        flow.cancel().await.unwrap();
        let error = tokio::time::timeout(std::time::Duration::from_millis(300), completion)
            .await
            .expect("user lookup cancellation")
            .unwrap()
            .unwrap_err();
        resume.notify_one();

        assert_eq!(error.code, "github_connect_canceled");
        assert!(vault.is_empty().await);
        assert!(repositories.github_snapshot().await.unwrap().is_none());
        server.await.unwrap();
    }

    #[tokio::test]
    async fn cancellation_during_installation_discovery_interrupts_without_state() {
        let reached = std::sync::Arc::new(tokio::sync::Notify::new());
        let resume = std::sync::Arc::new(tokio::sync::Notify::new());
        let installation = installations_fixture("access-one", None, r#"{"contents":"read"}"#);
        let blocked_installation = (
            installation.0.blocked(reached.clone(), resume.clone()),
            installation.1,
        );
        let (base_url, server) = scripted_server(vec![
            device_fixture(),
            token_fixture(),
            user_fixture("123", "octocat", "access-one"),
            blocked_installation,
        ])
        .await;
        let client = std::sync::Arc::new(GitHubAuthClient::for_test(&base_url).unwrap());
        let flow = std::sync::Arc::new(GitHubConnectFlow::default());
        let vault = std::sync::Arc::new(InMemoryGitHubTokenVault::default());
        let repositories = std::sync::Arc::new(test_repositories().await);
        flow.start(&client, &config().client_id).await.unwrap();
        let completion = {
            let flow = flow.clone();
            let client = client.clone();
            let vault = vault.clone();
            let repositories = repositories.clone();
            tokio::spawn(async move {
                complete_connect(&flow, &client, vault.as_ref(), &repositories, &config()).await
            })
        };
        reached.notified().await;
        flow.cancel().await.unwrap();
        let error = tokio::time::timeout(std::time::Duration::from_millis(300), completion)
            .await
            .expect("discovery cancellation")
            .unwrap()
            .unwrap_err();
        resume.notify_one();

        assert_eq!(error.code, "github_connect_canceled");
        assert!(vault.is_empty().await);
        assert!(repositories.github_snapshot().await.unwrap().is_none());
        server.await.unwrap();
    }

    #[tokio::test]
    async fn cancellation_while_keychain_store_completes_is_compensated() {
        let reached = std::sync::Arc::new(tokio::sync::Notify::new());
        let resume = std::sync::Arc::new(tokio::sync::Notify::new());
        let repository = repository_json(789, "test-repo", r#"{"pull":true}"#);
        let (base_url, server) = scripted_server(vec![
            device_fixture(),
            token_fixture(),
            user_fixture("123", "octocat", "access-one"),
            installations_fixture("access-one", None, r#"{"contents":"read"}"#),
            repositories_fixture("access-one", &format!("[{repository}]")),
        ])
        .await;
        let client = std::sync::Arc::new(GitHubAuthClient::for_test(&base_url).unwrap());
        let flow = std::sync::Arc::new(GitHubConnectFlow::default());
        let vault = std::sync::Arc::new(InMemoryGitHubTokenVault::default());
        vault.block_next_store(reached.clone(), resume.clone());
        let repositories = std::sync::Arc::new(test_repositories().await);
        flow.start(&client, &config().client_id).await.unwrap();
        let completion = {
            let flow = flow.clone();
            let client = client.clone();
            let vault = vault.clone();
            let repositories = repositories.clone();
            tokio::spawn(async move {
                complete_connect(&flow, &client, vault.as_ref(), &repositories, &config()).await
            })
        };
        reached.notified().await;
        flow.cancel().await.unwrap();
        resume.notify_one();

        assert_eq!(
            completion.await.unwrap().unwrap_err().code,
            "github_connect_canceled"
        );
        assert!(vault.is_empty().await);
        assert!(repositories.github_snapshot().await.unwrap().is_none());
        assert_eq!(vault.operations(), vec!["store:123", "delete:123"]);
        server.await.unwrap();
    }

    #[tokio::test]
    async fn cancellation_before_sqlite_commit_compensates_committed_state_and_custody() {
        let reached = std::sync::Arc::new(tokio::sync::Notify::new());
        let resume = std::sync::Arc::new(tokio::sync::Notify::new());
        let repository = repository_json(789, "test-repo", r#"{"pull":true}"#);
        let (base_url, server) = scripted_server(vec![
            device_fixture(),
            token_fixture(),
            user_fixture("123", "octocat", "access-one"),
            installations_fixture("access-one", None, r#"{"contents":"read"}"#),
            repositories_fixture("access-one", &format!("[{repository}]")),
        ])
        .await;
        let client = std::sync::Arc::new(GitHubAuthClient::for_test(&base_url).unwrap());
        let flow = std::sync::Arc::new(GitHubConnectFlow::default());
        let vault = std::sync::Arc::new(InMemoryGitHubTokenVault::default());
        let repositories = std::sync::Arc::new(test_repositories().await);
        repositories.block_next_github_snapshot_commit(GitHubSnapshotReplaceHook {
            reached: reached.clone(),
            resume: resume.clone(),
        });
        flow.start(&client, &config().client_id).await.unwrap();
        let completion = {
            let flow = flow.clone();
            let client = client.clone();
            let vault = vault.clone();
            let repositories = repositories.clone();
            tokio::spawn(async move {
                complete_connect(&flow, &client, vault.as_ref(), &repositories, &config()).await
            })
        };
        reached.notified().await;
        flow.cancel().await.unwrap();
        resume.notify_one();

        assert_eq!(
            completion.await.unwrap().unwrap_err().code,
            "github_connect_canceled"
        );
        assert!(vault.is_empty().await);
        assert!(repositories.github_snapshot().await.unwrap().is_none());
        server.await.unwrap();
    }
}
