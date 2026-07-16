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
    sync::{Arc, Mutex as StdMutex, OnceLock, Weak},
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
const REQUIRED_GITHUB_READ_PERMISSIONS: [&str; 6] = [
    "metadata",
    "contents",
    "issues",
    "pull_requests",
    "checks",
    "statuses",
];

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

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct EligibleGitHubRepository {
    pub repository_id: String,
    pub installation_id: String,
    pub owner_login: String,
    pub name: String,
    pub full_name: String,
    pub private: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct GitHubToolEligibility {
    pub github_user_id: String,
    pub repositories: Vec<EligibleGitHubRepository>,
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

static CONNECTION_OPERATION_LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
static REFRESH_LOCKS: OnceLock<StdMutex<HashMap<String, Weak<tokio::sync::Mutex<()>>>>> =
    OnceLock::new();

fn connection_operation_lock() -> &'static tokio::sync::Mutex<()> {
    CONNECTION_OPERATION_LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
}

/// Binding lock order: flow-local completion guard, authorization gate,
/// connection operation lock, per-user refresh lock, then storage/provider work.
pub(crate) fn github_authorization_gate() -> &'static tokio::sync::RwLock<()> {
    static GATE: OnceLock<tokio::sync::RwLock<()>> = OnceLock::new();
    GATE.get_or_init(|| tokio::sync::RwLock::new(()))
}

fn refresh_lock_for(github_user_id: &str) -> Arc<tokio::sync::Mutex<()>> {
    let locks = REFRESH_LOCKS.get_or_init(|| StdMutex::new(HashMap::new()));
    let mut locks = locks
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    locks.retain(|_, lock| lock.strong_count() > 0);
    if let Some(lock) = locks.get(github_user_id).and_then(Weak::upgrade) {
        return lock;
    }
    let lock = Arc::new(tokio::sync::Mutex::new(()));
    locks.insert(github_user_id.to_owned(), Arc::downgrade(&lock));
    lock
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

fn github_setup_required() -> AppError {
    AppError::new(
        "github_setup_required",
        "GitHub setup is incomplete. Refresh it in settings.",
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

type GitHubDiscovery = (
    Vec<DiscoveredGitHubInstallation>,
    Vec<DiscoveredGitHubRepository>,
);

enum DiscoveryRefreshContext<'a> {
    Authorized {
        client_id: &'a str,
        github_user_id: &'a str,
        cancellation: &'a mut tokio::sync::watch::Receiver<bool>,
    },
    Stored {
        vault: &'a dyn GitHubTokenVault,
        repositories: &'a Repositories,
        config: &'a GitHubAppConfig,
        github_user_id: &'a str,
    },
}

impl DiscoveryRefreshContext<'_> {
    async fn discover(
        &mut self,
        client: &GitHubAuthClient,
        access_token: &str,
    ) -> Result<GitHubDiscovery, AppError> {
        match self {
            Self::Authorized { cancellation, .. } => {
                cancellation_select(
                    cancellation,
                    client.installations_and_repositories(access_token),
                )
                .await
            }
            Self::Stored { .. } => client.installations_and_repositories(access_token).await,
        }
    }

    async fn refresh_after_unauthorized(
        &mut self,
        client: &GitHubAuthClient,
        rejected: &StoredGitHubTokens,
    ) -> Result<StoredGitHubTokens, AppError> {
        match self {
            Self::Authorized {
                client_id,
                github_user_id,
                cancellation,
            } => {
                let outcome = cancellation_select(
                    cancellation,
                    client.refresh_tokens(client_id, &rejected.refresh_token),
                )
                .await?;
                match outcome {
                    RefreshOutcome::Refreshed(grant) => {
                        Ok(grant.into_stored((*github_user_id).to_owned()))
                    }
                    RefreshOutcome::InvalidGrant => Err(github_reconnect_required()),
                }
            }
            Self::Stored {
                vault,
                repositories,
                config,
                github_user_id,
            } => {
                usable_tokens_after_unauthorized(
                    client,
                    *vault,
                    repositories,
                    config,
                    github_user_id,
                    &rejected.access_token,
                )
                .await
            }
        }
    }

    async fn terminal_reconnect(&mut self) -> Result<(), AppError> {
        match self {
            Self::Authorized { .. } => Err(github_reconnect_required()),
            Self::Stored {
                vault,
                repositories,
                github_user_id,
                ..
            } => terminal_reconnect(*vault, repositories, github_user_id).await,
        }
    }
}

async fn discover_with_one_refresh(
    client: &GitHubAuthClient,
    mut tokens: StoredGitHubTokens,
    context: &mut DiscoveryRefreshContext<'_>,
) -> Result<(StoredGitHubTokens, GitHubDiscovery), AppError> {
    match context.discover(client, &tokens.access_token).await {
        Ok(discovery) => Ok((tokens, discovery)),
        Err(error) if error.code == "github_reconnect_required" => {
            tokens = context.refresh_after_unauthorized(client, &tokens).await?;
            match context.discover(client, &tokens.access_token).await {
                Ok(discovery) => Ok((tokens, discovery)),
                Err(second) if second.code == "github_reconnect_required" => {
                    context.terminal_reconnect().await?;
                    Err(github_reconnect_required())
                }
                Err(second) => Err(second),
            }
        }
        Err(error) => Err(error),
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
    // The device-flow wait stays outside the binding lock order. Once the
    // flow-local completion guard is held, follow the order documented at the
    // authorization gate definition.
    let _completion_guard = flow.completion_guard().await;
    let _authorization_guard = github_authorization_gate().write().await;
    let _operation_guard = connection_operation_lock().lock().await;
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

    let mut discovery_context = DiscoveryRefreshContext::Authorized {
        client_id: &config.client_id,
        github_user_id: &user.github_user_id,
        cancellation: &mut cancellation,
    };
    let (next_stored, (installations, discovered_repositories)) =
        discover_with_one_refresh(client, stored, &mut discovery_context).await?;
    stored = next_stored;
    ensure_attempt_active(flow, attempt_id, &cancellation).await?;

    let status = status_for_discovery(&installations, &discovered_repositories);
    let (connection_record, installation_records, repository_records) =
        discovery_records(&user, status, &installations, &discovered_repositories)?;
    let old_snapshot = repositories
        .github_snapshot()
        .await
        .map_err(|_| github_storage_unavailable())?;
    let old_tokens = match old_snapshot.as_ref() {
        Some(snapshot) => vault
            .load(&snapshot.connection.github_user_id)
            .await?
            .filter(|tokens| tokens.github_user_id == snapshot.connection.github_user_id),
        None => None,
    };

    ensure_attempt_active(flow, attempt_id, &cancellation).await?;
    let mut compensation_state = ConnectCompensationState {
        new_custody_may_exist: true,
        old_custody_deleted: false,
        snapshot_replaced: false,
    };
    if vault.store(&user.github_user_id, &stored).await.is_err() {
        return Err(compensated_connect_error(
            vault,
            repositories,
            &user.github_user_id,
            old_snapshot.as_ref(),
            old_tokens.as_ref(),
            compensation_state,
            github_storage_unavailable(),
        )
        .await);
    }
    if ensure_attempt_active(flow, attempt_id, &cancellation)
        .await
        .is_err()
    {
        return Err(compensated_connect_error(
            vault,
            repositories,
            &user.github_user_id,
            old_snapshot.as_ref(),
            old_tokens.as_ref(),
            compensation_state,
            github_connect_canceled(),
        )
        .await);
    }

    if let Some(old) = old_snapshot
        .as_ref()
        .filter(|old| old.connection.github_user_id != user.github_user_id)
    {
        if ensure_attempt_active(flow, attempt_id, &cancellation)
            .await
            .is_err()
        {
            return Err(compensated_connect_error(
                vault,
                repositories,
                &user.github_user_id,
                old_snapshot.as_ref(),
                old_tokens.as_ref(),
                compensation_state,
                github_connect_canceled(),
            )
            .await);
        }
        if vault.delete(&old.connection.github_user_id).await.is_err() {
            return Err(compensated_connect_error(
                vault,
                repositories,
                &user.github_user_id,
                old_snapshot.as_ref(),
                old_tokens.as_ref(),
                compensation_state,
                github_storage_unavailable(),
            )
            .await);
        }
        compensation_state.old_custody_deleted = true;
        if ensure_attempt_active(flow, attempt_id, &cancellation)
            .await
            .is_err()
        {
            return Err(compensated_connect_error(
                vault,
                repositories,
                &user.github_user_id,
                old_snapshot.as_ref(),
                old_tokens.as_ref(),
                compensation_state,
                github_connect_canceled(),
            )
            .await);
        }
    }

    if ensure_attempt_active(flow, attempt_id, &cancellation)
        .await
        .is_err()
    {
        return Err(compensated_connect_error(
            vault,
            repositories,
            &user.github_user_id,
            old_snapshot.as_ref(),
            old_tokens.as_ref(),
            compensation_state,
            github_connect_canceled(),
        )
        .await);
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
        return Err(compensated_connect_error(
            vault,
            repositories,
            &user.github_user_id,
            old_snapshot.as_ref(),
            old_tokens.as_ref(),
            compensation_state,
            github_storage_unavailable(),
        )
        .await);
    }
    compensation_state.snapshot_replaced = true;
    if !flow.is_active(attempt_id).await || *cancellation.borrow() {
        return Err(compensated_connect_error(
            vault,
            repositories,
            &user.github_user_id,
            old_snapshot.as_ref(),
            old_tokens.as_ref(),
            compensation_state,
            github_connect_canceled(),
        )
        .await);
    }
    if !flow.finish_if_current(attempt_id).await {
        return Err(compensated_connect_error(
            vault,
            repositories,
            &user.github_user_id,
            old_snapshot.as_ref(),
            old_tokens.as_ref(),
            compensation_state,
            github_connect_canceled(),
        )
        .await);
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

#[derive(Clone, Copy)]
struct ConnectCompensationState {
    new_custody_may_exist: bool,
    old_custody_deleted: bool,
    snapshot_replaced: bool,
}

async fn compensated_connect_error(
    vault: &dyn GitHubTokenVault,
    repositories: &Repositories,
    new_user_id: &str,
    old_snapshot: Option<&GitHubSnapshotRecord>,
    old_tokens: Option<&StoredGitHubTokens>,
    state: ConnectCompensationState,
    original_error: AppError,
) -> AppError {
    if compensate_failed_connect(
        vault,
        repositories,
        new_user_id,
        old_snapshot,
        old_tokens,
        state,
    )
    .await
    {
        original_error
    } else {
        github_storage_unavailable()
    }
}

async fn compensate_failed_connect(
    vault: &dyn GitHubTokenVault,
    repositories: &Repositories,
    new_user_id: &str,
    old_snapshot: Option<&GitHubSnapshotRecord>,
    old_tokens: Option<&StoredGitHubTokens>,
    state: ConnectCompensationState,
) -> bool {
    let mut restored_consistently = true;

    if state.snapshot_replaced
        && restore_snapshot(repositories, old_snapshot, new_user_id)
            .await
            .is_err()
    {
        restored_consistently = false;
    }

    if state.new_custody_may_exist {
        match old_snapshot {
            Some(old) if old.connection.github_user_id == new_user_id => match old_tokens {
                Some(tokens) => {
                    if vault.store(new_user_id, tokens).await.is_err() {
                        restored_consistently = false;
                        if vault.delete(new_user_id).await.is_err() {
                            restored_consistently = false;
                        }
                    }
                }
                None => {
                    restored_consistently = false;
                    if vault.delete(new_user_id).await.is_err() {
                        restored_consistently = false;
                    }
                }
            },
            Some(old) => {
                if old_tokens.is_none() {
                    restored_consistently = false;
                }
                if state.old_custody_deleted {
                    match old_tokens {
                        Some(tokens) => {
                            if vault
                                .store(&old.connection.github_user_id, tokens)
                                .await
                                .is_err()
                            {
                                restored_consistently = false;
                            }
                        }
                        None => restored_consistently = false,
                    }
                }
                if vault.delete(new_user_id).await.is_err() {
                    restored_consistently = false;
                }
            }
            None => {
                if vault.delete(new_user_id).await.is_err() {
                    restored_consistently = false;
                }
            }
        }
    }

    if !restored_consistently && !mark_surviving_snapshot_reconnect(repositories).await {
        return false;
    }
    restored_consistently
}

async fn mark_surviving_snapshot_reconnect(repositories: &Repositories) -> bool {
    match repositories.github_snapshot().await {
        Ok(Some(snapshot)) => repositories
            .set_github_connection_status(
                &snapshot.connection.github_user_id,
                GitHubConnectionStatus::ReconnectRequired.as_str(),
            )
            .await
            .is_ok(),
        Ok(None) => true,
        Err(_) => false,
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
    let _authorization_guard = github_authorization_gate().write().await;
    let _operation_guard = connection_operation_lock().lock().await;
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
    let _authorization_guard = github_authorization_gate().write().await;
    let _operation_guard = connection_operation_lock().lock().await;
    let snapshot = repositories
        .github_snapshot()
        .await
        .map_err(|_| github_storage_unavailable())?
        .ok_or_else(github_not_connected)?;
    if GitHubConnectionStatus::from_db(&snapshot.connection.status)?
        == GitHubConnectionStatus::ReconnectRequired
    {
        return Err(github_reconnect_required());
    }
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

    let mut discovery_context = DiscoveryRefreshContext::Stored {
        vault,
        repositories,
        config,
        github_user_id: &github_user_id,
    };
    let (_, (installations, discovered_repositories)) =
        discover_with_one_refresh(client, tokens, &mut discovery_context).await?;

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
    usable_tokens_inner(
        client,
        vault,
        repositories,
        config,
        github_user_id,
        force_refresh,
        None,
    )
    .await
}

async fn usable_tokens_after_unauthorized(
    client: &GitHubAuthClient,
    vault: &dyn GitHubTokenVault,
    repositories: &Repositories,
    config: &GitHubAppConfig,
    github_user_id: &str,
    rejected_access_token: &str,
) -> Result<StoredGitHubTokens, AppError> {
    usable_tokens_inner(
        client,
        vault,
        repositories,
        config,
        github_user_id,
        false,
        Some(rejected_access_token),
    )
    .await
}

async fn usable_tokens_inner(
    client: &GitHubAuthClient,
    vault: &dyn GitHubTokenVault,
    repositories: &Repositories,
    config: &GitHubAppConfig,
    github_user_id: &str,
    force_refresh: bool,
    rejected_access_token: Option<&str>,
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
    if rejected_access_token.is_some_and(|rejected| stored.access_token != rejected) {
        return Ok(stored);
    }
    if rejected_access_token.is_none()
        && !force_refresh
        && access_token_is_fresh(stored.expires_at_unix)
    {
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
    let _authorization_guard = github_authorization_gate().write().await;
    let _operation_guard = connection_operation_lock().lock().await;
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
                && installation_has_required_read_permissions(&installation.permissions)
        })
    });
    if has_accessible_repository {
        GitHubConnectionStatus::Connected
    } else {
        GitHubConnectionStatus::SetupIncomplete
    }
}

fn permission_grants_read(value: Option<&String>) -> bool {
    matches!(value.map(String::as_str), Some("read" | "write"))
}

pub(crate) fn installation_has_required_read_permissions(
    permissions: &BTreeMap<String, String>,
) -> bool {
    REQUIRED_GITHUB_READ_PERMISSIONS
        .iter()
        .all(|key| permission_grants_read(permissions.get(*key)))
}

fn valid_numeric_github_id(value: &str) -> bool {
    !value.is_empty()
        && value.bytes().all(|byte| byte.is_ascii_digit())
        && value.parse::<u64>().is_ok_and(|value| value > 0)
}

#[allow(dead_code)]
pub(crate) async fn github_tool_eligibility(
    vault: &dyn GitHubTokenVault,
    repositories: &Repositories,
) -> Result<GitHubToolEligibility, AppError> {
    let _authorization_guard = github_authorization_gate().read().await;
    let snapshot = repositories
        .github_snapshot()
        .await
        .map_err(|_| github_storage_unavailable())?
        .ok_or_else(github_not_connected)?;
    let expected_user_id = snapshot.connection.github_user_id.clone();
    let eligibility = github_tool_eligibility_from_snapshot(&snapshot, &expected_user_id)?;
    match vault.load(&expected_user_id).await {
        Ok(Some(tokens)) if tokens.github_user_id == expected_user_id => Ok(eligibility),
        Ok(_) => Err(github_reconnect_required()),
        Err(error) if error.code == "github_token_store_invalid" => {
            Err(github_reconnect_required())
        }
        Err(_) => Err(github_storage_unavailable()),
    }
}

#[allow(dead_code)]
pub(crate) fn github_tool_eligibility_from_snapshot(
    snapshot: &GitHubSnapshotRecord,
    expected_user_id: &str,
) -> Result<GitHubToolEligibility, AppError> {
    if snapshot.connection.github_user_id != expected_user_id
        || !valid_numeric_github_id(expected_user_id)
    {
        return Err(github_reconnect_required());
    }
    match GitHubConnectionStatus::from_db(&snapshot.connection.status)
        .map_err(|_| github_storage_unavailable())?
    {
        GitHubConnectionStatus::Connected => {}
        GitHubConnectionStatus::SetupIncomplete => return Err(github_setup_required()),
        GitHubConnectionStatus::ReconnectRequired => return Err(github_reconnect_required()),
    }

    let mut installations = HashMap::with_capacity(snapshot.installations.len());
    for installation in &snapshot.installations {
        if installation.github_user_id != expected_user_id
            || !valid_numeric_github_id(&installation.installation_id)
            || !valid_numeric_github_id(&installation.owner_id)
            || installation.owner_login.is_empty()
            || installations.contains_key(&installation.installation_id)
        {
            return Err(github_storage_unavailable());
        }
        let permissions =
            serde_json::from_str::<BTreeMap<String, String>>(&installation.permissions_json)
                .map_err(|_| github_storage_unavailable())?;
        installations.insert(&installation.installation_id, (installation, permissions));
    }

    let mut eligible_repositories = Vec::new();
    let mut seen_repository_ids = std::collections::HashSet::new();
    for repository in &snapshot.repositories {
        if !valid_numeric_github_id(&repository.repository_id)
            || !valid_numeric_github_id(&repository.installation_id)
            || repository.owner_login.is_empty()
            || repository.name.is_empty()
            || repository.full_name != format!("{}/{}", repository.owner_login, repository.name)
            || !seen_repository_ids.insert(&repository.repository_id)
        {
            return Err(github_storage_unavailable());
        }
        serde_json::from_str::<BTreeMap<String, bool>>(&repository.permissions_json)
            .map_err(|_| github_storage_unavailable())?;
        let Some((installation, permissions)) = installations.get(&repository.installation_id)
        else {
            return Err(github_storage_unavailable());
        };
        if installation.suspended_at.is_some()
            || !installation_has_required_read_permissions(permissions)
        {
            continue;
        }
        eligible_repositories.push(EligibleGitHubRepository {
            repository_id: repository.repository_id.clone(),
            installation_id: repository.installation_id.clone(),
            owner_login: repository.owner_login.clone(),
            name: repository.name.clone(),
            full_name: repository.full_name.clone(),
            private: repository.is_private,
        });
    }

    if eligible_repositories.is_empty() {
        return Err(github_setup_required());
    }
    Ok(GitHubToolEligibility {
        github_user_id: expected_user_id.to_owned(),
        repositories: eligible_repositories,
    })
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
            atomic::{AtomicBool, AtomicUsize, Ordering},
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
        load_hook: Mutex<
            Option<(
                std::sync::Arc<tokio::sync::Notify>,
                std::sync::Arc<tokio::sync::Notify>,
            )>,
        >,
        store_hook: Mutex<
            Option<(
                std::sync::Arc<tokio::sync::Notify>,
                std::sync::Arc<tokio::sync::Notify>,
            )>,
        >,
        delete_hook: Mutex<
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

        fn block_next_load_after_observation(
            &self,
            reached: std::sync::Arc<tokio::sync::Notify>,
            resume: std::sync::Arc<tokio::sync::Notify>,
        ) {
            *self.load_hook.lock().expect("load hook") = Some((reached, resume));
        }

        fn block_next_delete(
            &self,
            reached: std::sync::Arc<tokio::sync::Notify>,
            resume: std::sync::Arc<tokio::sync::Notify>,
        ) {
            *self.delete_hook.lock().expect("delete hook") = Some((reached, resume));
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
                let observed = self.tokens.lock().await.get(github_user_id).cloned();
                let hook = self.load_hook.lock().expect("load hook").take();
                if let Some((reached, resume)) = hook {
                    reached.notify_one();
                    resume.notified().await;
                }
                Ok(observed)
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
                let hook = self.delete_hook.lock().expect("delete hook").take();
                if let Some((reached, resume)) = hook {
                    reached.notify_one();
                    resume.notified().await;
                }
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

    async fn stale_discovery_server(
        first_reached: std::sync::Arc<tokio::sync::Notify>,
        release_first: std::sync::Arc<tokio::sync::Notify>,
    ) -> (String, tokio::task::JoinHandle<()>) {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .expect("bind stale discovery server");
        let base_url = format!("http://{}", listener.local_addr().expect("server address"));
        let installation_request = std::sync::Arc::new(AtomicUsize::new(0));
        let task = tokio::spawn(async move {
            let mut handlers = Vec::new();
            for _ in 0..3 {
                let (mut stream, _) = listener.accept().await.expect("accept discovery request");
                let installation_request = installation_request.clone();
                let first_reached = first_reached.clone();
                let release_first = release_first.clone();
                handlers.push(tokio::spawn(async move {
                    let capture = read_safe_request(
                        &mut stream,
                        &RequestExpectations {
                            bearer_token: Some("access-old"),
                            ..RequestExpectations::default()
                        },
                    )
                    .await;
                    assert!(capture.has_expected_bearer_token);
                    let body = if capture.path.starts_with("/user/installations?") {
                        let ordinal = installation_request.fetch_add(1, Ordering::SeqCst);
                        if ordinal == 0 {
                            first_reached.notify_one();
                            release_first.notified().await;
                            r#"{"installations":[{"id":456,"account":{"id":321,"login":"open-software-network","type":"Organization"},"html_url":"https://github.com/organizations/open-software-network/settings/installations/456","repository_selection":"selected","permissions":{"contents":"read"},"suspended_at":null}]}"#.to_owned()
                        } else {
                            r#"{"installations":[{"id":456,"account":{"id":321,"login":"open-software-network","type":"Organization"},"html_url":"https://github.com/organizations/open-software-network/settings/installations/456","repository_selection":"selected","permissions":{"contents":"read"},"suspended_at":"2026-07-15T00:00:00Z"}]}"#.to_owned()
                        }
                    } else if capture
                        .path
                        .starts_with("/user/installations/456/repositories?")
                    {
                        let repository =
                            repository_json(789, "test-repo", r#"{"pull":true}"#);
                        format!(r#"{{"repositories":[{repository}]}}"#)
                    } else {
                        panic!("unexpected stale discovery path: {}", capture.path);
                    };
                    let response = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                        body.len(),
                        body
                    );
                    stream
                        .write_all(response.as_bytes())
                        .await
                        .expect("write stale discovery response");
                }));
            }
            for handler in handlers {
                handler.await.expect("stale discovery handler");
            }
        });
        (base_url, task)
    }

    async fn refresh_counting_server() -> (
        String,
        std::sync::Arc<AtomicUsize>,
        tokio::sync::watch::Sender<bool>,
        tokio::task::JoinHandle<()>,
    ) {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .expect("bind refresh counting server");
        let base_url = format!("http://{}", listener.local_addr().expect("server address"));
        let refresh_count = std::sync::Arc::new(AtomicUsize::new(0));
        let refresh_count_for_task = refresh_count.clone();
        let (shutdown, mut shutdown_receiver) = tokio::sync::watch::channel(false);
        let task = tokio::spawn(async move {
            loop {
                let accepted = tokio::select! {
                    _ = shutdown_receiver.changed() => break,
                    accepted = listener.accept() => accepted,
                };
                let (mut stream, _) = accepted.expect("accept refresh request");
                let capture = read_safe_request(
                    &mut stream,
                    &RequestExpectations {
                        client_id: Some("Iv23example"),
                        refresh_token: Some("refresh-old"),
                        grant_type: Some("refresh_token"),
                        ..RequestExpectations::default()
                    },
                )
                .await;
                assert_eq!(capture.path, "/login/oauth/access_token");
                let ordinal = refresh_count_for_task.fetch_add(1, Ordering::SeqCst);
                let (access, refresh) = if ordinal == 0 {
                    ("access-new", "refresh-new")
                } else {
                    ("access-newer", "refresh-newer")
                };
                let body = format!(
                    r#"{{"access_token":"{access}","refresh_token":"{refresh}","expires_in":28800,"refresh_token_expires_in":15811200}}"#
                );
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body
                );
                stream
                    .write_all(response.as_bytes())
                    .await
                    .expect("write refresh response");
            }
        });
        (base_url, refresh_count, shutdown, task)
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

    fn read_permissions(value: &str) -> BTreeMap<String, String> {
        [
            "metadata",
            "contents",
            "issues",
            "pull_requests",
            "checks",
            "statuses",
        ]
        .into_iter()
        .map(|permission| (permission.to_owned(), value.to_owned()))
        .collect()
    }

    fn required_read_permissions_json() -> &'static str {
        r#"{"metadata":"read","contents":"read","issues":"read","pull_requests":"read","checks":"read","statuses":"read"}"#
    }

    fn discovered_installation(
        installation_id: &str,
        permissions: BTreeMap<String, String>,
        suspended_at: Option<&str>,
    ) -> DiscoveredGitHubInstallation {
        DiscoveredGitHubInstallation {
            installation_id: installation_id.to_owned(),
            owner_id: "321".to_owned(),
            owner_login: "open-software-network".to_owned(),
            owner_type: "Organization".to_owned(),
            management_url:
                "https://github.com/organizations/open-software-network/settings/installations/456"
                    .to_owned(),
            repository_selection: "selected".to_owned(),
            permissions,
            suspended_at: suspended_at.map(str::to_owned),
        }
    }

    fn discovered_repository(
        repository_id: &str,
        installation_id: &str,
        name: &str,
    ) -> DiscoveredGitHubRepository {
        DiscoveredGitHubRepository {
            repository_id: repository_id.to_owned(),
            installation_id: installation_id.to_owned(),
            owner_login: "open-software-network".to_owned(),
            name: name.to_owned(),
            full_name: format!("open-software-network/{name}"),
            is_private: true,
            is_archived: false,
            permissions: BTreeMap::from([("pull".to_owned(), true)]),
        }
    }

    #[test]
    fn status_requires_every_github_read_permission() {
        let repository = discovered_repository("789", "456", "test-repo");

        for granted_level in ["read", "write"] {
            let installations = [discovered_installation(
                "456",
                read_permissions(granted_level),
                None,
            )];
            assert_eq!(
                status_for_discovery(&installations, std::slice::from_ref(&repository)),
                GitHubConnectionStatus::Connected,
                "{granted_level} grants read eligibility"
            );
        }

        for missing_permission in [
            "metadata",
            "contents",
            "issues",
            "pull_requests",
            "checks",
            "statuses",
        ] {
            let mut permissions = read_permissions("read");
            permissions.remove(missing_permission);
            let installations = [discovered_installation("456", permissions, None)];
            assert_eq!(
                status_for_discovery(&installations, std::slice::from_ref(&repository)),
                GitHubConnectionStatus::SetupIncomplete,
                "missing {missing_permission} must fail closed"
            );
        }

        for denied_permission in [
            "metadata",
            "contents",
            "issues",
            "pull_requests",
            "checks",
            "statuses",
        ] {
            let mut permissions = read_permissions("read");
            permissions.insert(denied_permission.to_owned(), "none".to_owned());
            let installations = [discovered_installation("456", permissions, None)];
            assert_eq!(
                status_for_discovery(&installations, std::slice::from_ref(&repository)),
                GitHubConnectionStatus::SetupIncomplete,
                "none for {denied_permission} must fail closed"
            );
        }

        let suspended = [discovered_installation(
            "456",
            read_permissions("read"),
            Some("2026-07-16T00:00:00Z"),
        )];
        assert_eq!(
            status_for_discovery(&suspended, std::slice::from_ref(&repository)),
            GitHubConnectionStatus::SetupIncomplete
        );

        let eligible = discovered_installation("456", read_permissions("read"), None);
        assert_eq!(
            status_for_discovery(std::slice::from_ref(&eligible), &[]),
            GitHubConnectionStatus::SetupIncomplete
        );

        let awaiting_approval = discovered_installation(
            "999",
            BTreeMap::from([("metadata".to_owned(), "read".to_owned())]),
            None,
        );
        let repositories = [
            repository,
            discovered_repository("987", "999", "awaiting-approval"),
        ];
        assert_eq!(
            status_for_discovery(&[eligible, awaiting_approval], &repositories),
            GitHubConnectionStatus::Connected
        );
    }

    fn installation_record(
        installation_id: &str,
        permissions: BTreeMap<String, String>,
        suspended_at: Option<&str>,
    ) -> GitHubInstallationRecord {
        GitHubInstallationRecord {
            installation_id: installation_id.to_owned(),
            github_user_id: "123".to_owned(),
            owner_id: "321".to_owned(),
            owner_login: "open-software-network".to_owned(),
            owner_type: "Organization".to_owned(),
            management_url: format!(
                "https://github.com/organizations/open-software-network/settings/installations/{installation_id}"
            ),
            repository_selection: "selected".to_owned(),
            permissions_json: serde_json::to_string(&permissions).expect("permission JSON"),
            suspended_at: suspended_at.map(str::to_owned),
            last_refreshed_at: "2026-07-16T00:00:00Z".to_owned(),
        }
    }

    fn repository_record(
        repository_id: &str,
        installation_id: &str,
        name: &str,
    ) -> GitHubRepositoryRecord {
        GitHubRepositoryRecord {
            repository_id: repository_id.to_owned(),
            installation_id: installation_id.to_owned(),
            owner_login: "open-software-network".to_owned(),
            name: name.to_owned(),
            full_name: format!("open-software-network/{name}"),
            is_private: true,
            is_archived: false,
            permissions_json: r#"{"pull":true}"#.to_owned(),
        }
    }

    fn eligibility_snapshot() -> GitHubSnapshotRecord {
        GitHubSnapshotRecord {
            connection: GitHubConnectionRecord {
                github_user_id: "123".to_owned(),
                login: "octocat".to_owned(),
                avatar_url: None,
                status: "connected".to_owned(),
            },
            installations: vec![
                installation_record("456", read_permissions("read"), None),
                installation_record(
                    "654",
                    read_permissions("read"),
                    Some("2026-07-16T00:00:00Z"),
                ),
                installation_record("999", read_permissions("read"), None),
            ],
            repositories: vec![
                repository_record("789", "456", "test-repo"),
                repository_record("987", "654", "suspended-repo"),
            ],
        }
    }

    #[test]
    fn tool_eligibility_excludes_suspended_and_unselected_repositories() {
        let eligibility = github_tool_eligibility_from_snapshot(&eligibility_snapshot(), "123")
            .expect("eligible snapshot");

        assert_eq!(eligibility.github_user_id, "123");
        assert_eq!(
            eligibility.repositories,
            vec![EligibleGitHubRepository {
                repository_id: "789".to_owned(),
                installation_id: "456".to_owned(),
                owner_login: "open-software-network".to_owned(),
                name: "test-repo".to_owned(),
                full_name: "open-software-network/test-repo".to_owned(),
                private: true,
            }]
        );

        let mut no_eligible = eligibility_snapshot();
        no_eligible.repositories.remove(0);
        let error = github_tool_eligibility_from_snapshot(&no_eligible, "123")
            .expect_err("suspended and unselected repositories fail closed");
        assert_eq!(error.code, "github_setup_required");
    }

    #[tokio::test]
    async fn tool_eligibility_requires_present_credential_and_valid_snapshot() {
        let repositories = test_repositories().await;
        let snapshot = eligibility_snapshot();
        repositories
            .replace_github_snapshot(
                &snapshot.connection,
                &snapshot.installations,
                &snapshot.repositories,
            )
            .await
            .expect("seed eligibility snapshot");
        let vault = InMemoryGitHubTokenVault::default();

        let missing = github_tool_eligibility(&vault, &repositories)
            .await
            .expect_err("missing custody must fail closed");
        assert_eq!(missing.code, "github_reconnect_required");

        vault
            .insert(stored_tokens(
                "123",
                "fixture-access",
                "fixture-refresh",
                now_unix() + 3_600,
            ))
            .await;
        let eligible = github_tool_eligibility(&vault, &repositories)
            .await
            .expect("present matching custody");
        assert_eq!(eligible.repositories.len(), 1);

        let mut invalid = snapshot;
        invalid.repositories[0].full_name = "different-owner/test-repo".to_owned();
        let error = github_tool_eligibility_from_snapshot(&invalid, "123")
            .expect_err("mismatched repository identity must fail closed");
        assert_eq!(error.code, "github_storage_unavailable");
    }

    #[tokio::test]
    async fn disconnect_waits_for_an_inflight_github_read_lease() {
        let repositories = test_repositories().await;
        seed_snapshot(&repositories, "123", "connected", None, None).await;
        let vault = std::sync::Arc::new(InMemoryGitHubTokenVault::default());
        vault
            .insert(stored_tokens(
                "123",
                "fixture-access",
                "fixture-refresh",
                now_unix() + 3_600,
            ))
            .await;
        let delete_reached = std::sync::Arc::new(tokio::sync::Notify::new());
        let release_delete = std::sync::Arc::new(tokio::sync::Notify::new());
        vault.block_next_delete(delete_reached.clone(), release_delete.clone());

        let read_lease = github_authorization_gate().read().await;
        let repositories_for_disconnect = repositories.clone();
        let vault_for_disconnect = vault.clone();
        let disconnect_task = tokio::spawn(async move {
            disconnect(vault_for_disconnect.as_ref(), &repositories_for_disconnect).await
        });

        assert!(
            tokio::time::timeout(
                std::time::Duration::from_millis(50),
                delete_reached.notified()
            )
            .await
            .is_err(),
            "disconnect must remain behind the shared authorization lease"
        );

        drop(read_lease);
        tokio::time::timeout(std::time::Duration::from_secs(1), delete_reached.notified())
            .await
            .expect("disconnect acquires the authorization writer");
        release_delete.notify_one();
        tokio::time::timeout(std::time::Duration::from_secs(1), disconnect_task)
            .await
            .expect("disconnect completes after read lease release")
            .expect("disconnect task")
            .expect("disconnect succeeds");
    }

    #[tokio::test]
    async fn queued_disconnect_prevents_a_later_github_read_lease() {
        let repositories = test_repositories().await;
        seed_snapshot(&repositories, "123", "connected", None, None).await;
        let vault = std::sync::Arc::new(InMemoryGitHubTokenVault::default());
        vault
            .insert(stored_tokens(
                "123",
                "fixture-access",
                "fixture-refresh",
                now_unix() + 3_600,
            ))
            .await;
        let delete_reached = std::sync::Arc::new(tokio::sync::Notify::new());
        let release_delete = std::sync::Arc::new(tokio::sync::Notify::new());
        vault.block_next_delete(delete_reached.clone(), release_delete.clone());

        let first_read = github_authorization_gate().read().await;
        let repositories_for_disconnect = repositories.clone();
        let vault_for_disconnect = vault.clone();
        let disconnect_task = tokio::spawn(async move {
            disconnect(vault_for_disconnect.as_ref(), &repositories_for_disconnect).await
        });
        tokio::task::yield_now().await;

        let (later_read_acquired, mut later_read_receiver) = tokio::sync::oneshot::channel();
        let later_read = tokio::spawn(async move {
            let _lease = github_authorization_gate().read().await;
            let _ = later_read_acquired.send(());
        });
        drop(first_read);

        tokio::time::timeout(std::time::Duration::from_secs(1), delete_reached.notified())
            .await
            .expect("queued disconnect wins the authorization writer");
        assert!(
            tokio::time::timeout(
                std::time::Duration::from_millis(50),
                &mut later_read_receiver
            )
            .await
            .is_err(),
            "a later reader must not overtake the queued disconnect"
        );

        release_delete.notify_one();
        tokio::time::timeout(std::time::Duration::from_secs(1), disconnect_task)
            .await
            .expect("disconnect completes")
            .expect("disconnect task")
            .expect("disconnect succeeds");
        tokio::time::timeout(std::time::Duration::from_secs(1), later_read_receiver)
            .await
            .expect("later read acquires after disconnect")
            .expect("later read signal");
        later_read.await.expect("later read task");
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
            installations_fixture("access-one", None, required_read_permissions_json()),
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
    async fn initial_connect_401_refreshes_once_then_discovers_and_commits() {
        let repository = repository_json(789, "test-repo", r#"{"pull":true}"#);
        let (base_url, server) = scripted_server(vec![
            device_fixture(),
            token_fixture(),
            user_fixture("123", "octocat", "access-one"),
            unauthorized_fixture("access-one"),
            refresh_fixture("refresh-one", "access-two", "refresh-two"),
            installations_fixture("access-two", None, required_read_permissions_json()),
            repositories_fixture("access-two", &format!("[{repository}]")),
        ])
        .await;
        let client = GitHubAuthClient::for_test(&base_url).unwrap();
        let flow = GitHubConnectFlow::default();
        let vault = InMemoryGitHubTokenVault::default();
        let repositories = test_repositories().await;
        flow.start(&client, &config().client_id).await.unwrap();

        let connection = complete_connect(&flow, &client, &vault, &repositories, &config())
            .await
            .expect("connect after one discovery refresh");
        assert_eq!(connection.status, GitHubConnectionStatus::Connected);
        let stored = vault.token("123").await.expect("rotated custody");
        assert_eq!(stored.access_token, "access-two");
        assert_eq!(stored.refresh_token, "refresh-two");
        assert_eq!(server.await.unwrap().len(), 7);
    }

    #[tokio::test]
    async fn initial_connect_401_then_invalid_grant_leaves_no_state() {
        let (base_url, server) = scripted_server(vec![
            device_fixture(),
            token_fixture(),
            user_fixture("123", "octocat", "access-one"),
            unauthorized_fixture("access-one"),
            (
                ResponseFixture::json(400, r#"{"error":"bad_refresh_token"}"#),
                RequestExpectations {
                    client_id: Some("Iv23example"),
                    refresh_token: Some("refresh-one"),
                    grant_type: Some("refresh_token"),
                    ..RequestExpectations::default()
                },
            ),
        ])
        .await;
        let client = GitHubAuthClient::for_test(&base_url).unwrap();
        let flow = GitHubConnectFlow::default();
        let vault = InMemoryGitHubTokenVault::default();
        let repositories = test_repositories().await;
        flow.start(&client, &config().client_id).await.unwrap();

        assert_eq!(
            complete_connect(&flow, &client, &vault, &repositories, &config())
                .await
                .unwrap_err()
                .code,
            "github_reconnect_required"
        );
        assert!(vault.is_empty().await);
        assert!(repositories.github_snapshot().await.unwrap().is_none());
        assert_eq!(
            tokio::time::timeout(std::time::Duration::from_millis(300), server)
                .await
                .expect("invalid-grant request must be consumed")
                .unwrap()
                .len(),
            5
        );
    }

    #[tokio::test]
    async fn initial_connect_second_401_leaves_no_state() {
        let (base_url, server) = scripted_server(vec![
            device_fixture(),
            token_fixture(),
            user_fixture("123", "octocat", "access-one"),
            unauthorized_fixture("access-one"),
            refresh_fixture("refresh-one", "access-two", "refresh-two"),
            unauthorized_fixture("access-two"),
        ])
        .await;
        let client = GitHubAuthClient::for_test(&base_url).unwrap();
        let flow = GitHubConnectFlow::default();
        let vault = InMemoryGitHubTokenVault::default();
        let repositories = test_repositories().await;
        flow.start(&client, &config().client_id).await.unwrap();

        assert_eq!(
            complete_connect(&flow, &client, &vault, &repositories, &config())
                .await
                .unwrap_err()
                .code,
            "github_reconnect_required"
        );
        assert!(vault.is_empty().await);
        assert!(repositories.github_snapshot().await.unwrap().is_none());
        assert_eq!(
            tokio::time::timeout(std::time::Duration::from_millis(300), server)
                .await
                .expect("second unauthorized request must be consumed")
                .unwrap()
                .len(),
            6
        );
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
    async fn stale_connection_get_cannot_mark_a_successful_same_user_reconnect_terminal() {
        let repositories = std::sync::Arc::new(test_repositories().await);
        seed_snapshot(&repositories, "123", "connected", None, None).await;
        let vault = std::sync::Arc::new(InMemoryGitHubTokenVault::default());
        let getter_reached = std::sync::Arc::new(tokio::sync::Notify::new());
        let resume_getter = std::sync::Arc::new(tokio::sync::Notify::new());
        vault.block_next_load_after_observation(getter_reached.clone(), resume_getter.clone());
        let getter = {
            let vault = vault.clone();
            let repositories = repositories.clone();
            tokio::spawn(async move { connection_get(vault.as_ref(), &repositories).await })
        };
        getter_reached.notified().await;

        let token_reached = std::sync::Arc::new(tokio::sync::Notify::new());
        let release_token = std::sync::Arc::new(tokio::sync::Notify::new());
        let user_reached = std::sync::Arc::new(tokio::sync::Notify::new());
        let release_user = std::sync::Arc::new(tokio::sync::Notify::new());
        let token = token_fixture();
        let blocked_token = (
            token
                .0
                .blocked(token_reached.clone(), release_token.clone()),
            token.1,
        );
        let user = user_fixture("123", "octocat", "access-one");
        let blocked_user = (
            user.0.blocked(user_reached.clone(), release_user.clone()),
            user.1,
        );
        let repository = repository_json(789, "test-repo", r#"{"pull":true}"#);
        let (base_url, server) = scripted_server(vec![
            device_fixture(),
            blocked_token,
            blocked_user,
            installations_fixture("access-one", None, required_read_permissions_json()),
            repositories_fixture("access-one", &format!("[{repository}]")),
        ])
        .await;
        let client = std::sync::Arc::new(GitHubAuthClient::for_test(&base_url).unwrap());
        let flow = std::sync::Arc::new(GitHubConnectFlow::default());
        flow.start(&client, &config().client_id).await.unwrap();
        let reconnect = {
            let flow = flow.clone();
            let client = client.clone();
            let vault = vault.clone();
            let repositories = repositories.clone();
            tokio::spawn(async move {
                complete_connect(&flow, &client, vault.as_ref(), &repositories, &config()).await
            })
        };
        token_reached.notified().await;
        release_token.notify_one();

        let reconnect_reached_user_while_getter_paused = tokio::time::timeout(
            std::time::Duration::from_millis(200),
            user_reached.notified(),
        )
        .await
        .is_ok();
        if reconnect_reached_user_while_getter_paused {
            release_user.notify_one();
            reconnect.await.unwrap().unwrap();
            resume_getter.notify_one();
            getter.await.unwrap().unwrap();
        } else {
            resume_getter.notify_one();
            getter.await.unwrap().unwrap();
            user_reached.notified().await;
            release_user.notify_one();
            reconnect.await.unwrap().unwrap();
        }

        assert_eq!(
            repositories
                .github_snapshot()
                .await
                .unwrap()
                .unwrap()
                .connection
                .status,
            "connected"
        );
        assert!(
            !reconnect_reached_user_while_getter_paused,
            "reconnect must wait for the connection read and status decision"
        );
        server.await.unwrap();
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
    async fn actual_sqlite_orphan_repository_is_surfaced_and_rejected() {
        let repositories = test_repositories().await;
        seed_snapshot(&repositories, "123", "connected", None, None).await;
        let mut connection = repositories.pool.acquire().await.unwrap();
        sqlx::query::query("PRAGMA foreign_keys = OFF")
            .execute(&mut *connection)
            .await
            .unwrap();
        sqlx::query::query(
            "INSERT INTO github_repositories
               (repository_id, installation_id, owner_login, name, full_name, is_private,
                is_archived, permissions_json, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind("orphan")
        .bind("missing-installation")
        .bind("open-software-network")
        .bind("orphan")
        .bind("open-software-network/orphan")
        .bind(1_i64)
        .bind(0_i64)
        .bind(r#"{"pull":true}"#)
        .bind("2026-07-15T00:00:00Z")
        .execute(&mut *connection)
        .await
        .unwrap();
        sqlx::query::query("PRAGMA foreign_keys = ON")
            .execute(&mut *connection)
            .await
            .unwrap();
        drop(connection);
        let vault = InMemoryGitHubTokenVault::default();
        vault
            .insert(stored_tokens(
                "123",
                "access-old",
                "refresh-old",
                now_unix() + 3600,
            ))
            .await;

        assert_eq!(
            connection_get(&vault, &repositories)
                .await
                .unwrap_err()
                .code,
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
            installations_fixture("access-new", None, required_read_permissions_json()),
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
    async fn older_discovery_cannot_overwrite_a_newer_suspension_and_removal() {
        let repositories = std::sync::Arc::new(test_repositories().await);
        seed_snapshot(
            &repositories,
            "123",
            "connected",
            None,
            Some(r#"{"pull":true}"#),
        )
        .await;
        let vault = std::sync::Arc::new(InMemoryGitHubTokenVault::default());
        vault
            .insert(stored_tokens(
                "123",
                "access-old",
                "refresh-old",
                now_unix() + 3600,
            ))
            .await;
        let first_reached = std::sync::Arc::new(tokio::sync::Notify::new());
        let release_first = std::sync::Arc::new(tokio::sync::Notify::new());
        let (base_url, server) =
            stale_discovery_server(first_reached.clone(), release_first.clone()).await;
        let client = std::sync::Arc::new(GitHubAuthClient::for_test(&base_url).unwrap());
        let first = {
            let client = client.clone();
            let vault = vault.clone();
            let repositories = repositories.clone();
            tokio::spawn(async move {
                installations_refresh(&client, vault.as_ref(), &repositories, &config()).await
            })
        };
        first_reached.notified().await;
        let mut second = {
            let client = client.clone();
            let vault = vault.clone();
            let repositories = repositories.clone();
            tokio::spawn(async move {
                installations_refresh(&client, vault.as_ref(), &repositories, &config()).await
            })
        };

        let second_finished_early =
            tokio::time::timeout(std::time::Duration::from_millis(100), &mut second).await;
        release_first.notify_one();
        first.await.unwrap().unwrap();
        match second_finished_early {
            Ok(result) => result.unwrap().unwrap(),
            Err(_) => second.await.unwrap().unwrap(),
        };

        let snapshot = repositories.github_snapshot().await.unwrap().unwrap();
        assert_eq!(snapshot.connection.status, "setup_incomplete");
        assert!(snapshot.installations[0].suspended_at.is_some());
        assert!(snapshot.repositories.is_empty());
        server.await.unwrap();
    }

    #[tokio::test]
    async fn concurrent_401_refreshes_rotate_a_rejected_token_generation_once() {
        let repositories = std::sync::Arc::new(test_repositories().await);
        seed_snapshot(&repositories, "123", "connected", None, None).await;
        let vault = std::sync::Arc::new(InMemoryGitHubTokenVault::default());
        vault
            .insert(stored_tokens(
                "123",
                "access-old",
                "refresh-old",
                now_unix() + 3600,
            ))
            .await;
        let (base_url, refresh_count, shutdown, server) = refresh_counting_server().await;
        let client = std::sync::Arc::new(GitHubAuthClient::for_test(&base_url).unwrap());
        let config = config();

        let first = usable_tokens_after_unauthorized(
            &client,
            vault.as_ref(),
            &repositories,
            &config,
            "123",
            "access-old",
        );
        let second = usable_tokens_after_unauthorized(
            &client,
            vault.as_ref(),
            &repositories,
            &config,
            "123",
            "access-old",
        );
        let (first, second) = tokio::join!(first, second);
        assert_eq!(first.unwrap().access_token, "access-new");
        assert_eq!(second.unwrap().access_token, "access-new");
        assert_eq!(refresh_count.load(Ordering::SeqCst), 1);

        shutdown.send(true).unwrap();
        server.await.unwrap();
    }

    #[tokio::test]
    async fn refresh_lock_registry_prunes_historical_users_after_last_guard_drops() {
        let _operation_guard = connection_operation_lock().lock().await;
        let historical_user = "registry-lifecycle-historical";
        let current_user = "registry-lifecycle-current";
        let historical_lock = refresh_lock_for(historical_user);
        let historical_observer = std::sync::Arc::downgrade(&historical_lock);
        drop(historical_lock);

        let current_lock = refresh_lock_for(current_user);
        assert!(historical_observer.upgrade().is_none());
        let registry = REFRESH_LOCKS
            .get()
            .expect("refresh registry")
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        assert!(!registry.contains_key(historical_user));
        assert!(registry.contains_key(current_user));
        drop(registry);
        drop(current_lock);
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
    async fn live_revocation_deletes_custody_and_marks_reconnect_without_rediscovery() {
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
                "access-revoked",
                "refresh-revoked",
                now_unix() + 3_600,
            ))
            .await;
        let (base_url, server) = scripted_server(vec![
            unauthorized_fixture("access-revoked"),
            (
                ResponseFixture::json(200, r#"{"error":"incorrect_client_credentials"}"#),
                RequestExpectations {
                    client_id: Some("Iv23example"),
                    refresh_token: Some("refresh-revoked"),
                    grant_type: Some("refresh_token"),
                    ..RequestExpectations::default()
                },
            ),
        ])
        .await;
        let client = GitHubAuthClient::for_test(&base_url).expect("test client");

        let error = installations_refresh(&client, &vault, &repositories, &config())
            .await
            .expect_err("revoked authorization must require reconnect");

        assert_eq!(error.code, "github_reconnect_required");
        assert!(vault.token("123").await.is_none());
        let snapshot = repositories.github_snapshot().await.unwrap().unwrap();
        assert_eq!(snapshot.connection.status, "reconnect_required");
        assert_eq!(snapshot.repositories.len(), 1);
        let captures = server.await.expect("server task");
        assert_eq!(
            captures.len(),
            2,
            "must not retry discovery after terminal refresh"
        );
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
    async fn reconnect_required_blocks_reuse_after_rotation_store_and_delete_failures() {
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
        vault.fail_delete_for("123");
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
        server.await.unwrap();
        assert!(vault.token("123").await.is_some());
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

        let operations_before_retry = vault.operations();
        let unreachable = GitHubAuthClient::for_test("http://127.0.0.1:9").unwrap();
        assert_eq!(
            installations_refresh(&unreachable, &vault, &repositories, &config())
                .await
                .unwrap_err()
                .code,
            "github_reconnect_required"
        );
        assert_eq!(vault.operations(), operations_before_retry);
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

    #[tokio::test]
    async fn disconnect_waits_for_in_flight_refresh_and_prevents_snapshot_resurrection() {
        let repositories = std::sync::Arc::new(test_repositories().await);
        seed_snapshot(&repositories, "123", "connected", None, None).await;
        let vault = std::sync::Arc::new(InMemoryGitHubTokenVault::default());
        vault
            .insert(stored_tokens(
                "123",
                "access-old",
                "refresh-old",
                now_unix() + 3600,
            ))
            .await;
        let reached = std::sync::Arc::new(tokio::sync::Notify::new());
        let resume = std::sync::Arc::new(tokio::sync::Notify::new());
        let installation = installations_fixture("access-old", None, r#"{"contents":"read"}"#);
        let blocked_installation = (
            installation.0.blocked(reached.clone(), resume.clone()),
            installation.1,
        );
        let repository = repository_json(789, "test-repo", r#"{"pull":true}"#);
        let (base_url, server) = scripted_server(vec![
            blocked_installation,
            repositories_fixture("access-old", &format!("[{repository}]")),
        ])
        .await;
        let client = std::sync::Arc::new(GitHubAuthClient::for_test(&base_url).unwrap());
        let refresh = {
            let client = client.clone();
            let vault = vault.clone();
            let repositories = repositories.clone();
            tokio::spawn(async move {
                installations_refresh(&client, vault.as_ref(), &repositories, &config()).await
            })
        };
        reached.notified().await;

        let mut disconnect_task = {
            let vault = vault.clone();
            let repositories = repositories.clone();
            tokio::spawn(async move { disconnect(vault.as_ref(), &repositories).await })
        };
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(100), &mut disconnect_task)
                .await
                .is_err(),
            "disconnect must wait for the complete refresh state transition"
        );
        resume.notify_one();

        refresh.await.unwrap().unwrap();
        disconnect_task.await.unwrap().unwrap();
        assert!(vault.is_empty().await);
        assert!(repositories.github_snapshot().await.unwrap().is_none());
        server.await.unwrap();
    }

    #[tokio::test]
    async fn disconnect_waits_for_canceled_connect_compensation() {
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

        let mut disconnect_task = {
            let vault = vault.clone();
            let repositories = repositories.clone();
            tokio::spawn(async move { disconnect(vault.as_ref(), &repositories).await })
        };
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(100), &mut disconnect_task)
                .await
                .is_err(),
            "disconnect must wait until canceled completion removes issued custody"
        );
        resume.notify_one();

        assert_eq!(
            completion.await.unwrap().unwrap_err().code,
            "github_connect_canceled"
        );
        disconnect_task.await.unwrap().unwrap();
        assert!(vault.is_empty().await);
        assert!(repositories.github_snapshot().await.unwrap().is_none());
        server.await.unwrap();
    }

    #[tokio::test]
    async fn snapshot_restore_failure_still_restores_old_custody_and_marks_reconnect() {
        let repositories = std::sync::Arc::new(test_repositories().await);
        seed_snapshot(&repositories, "123", "connected", None, None).await;
        let vault = std::sync::Arc::new(InMemoryGitHubTokenVault::default());
        vault
            .insert(stored_tokens(
                "123",
                "old-access",
                "old-refresh",
                now_unix() + 3600,
            ))
            .await;
        let reached = std::sync::Arc::new(tokio::sync::Notify::new());
        let resume = std::sync::Arc::new(tokio::sync::Notify::new());
        repositories.block_next_github_snapshot_commit(GitHubSnapshotReplaceHook {
            reached: reached.clone(),
            resume: resume.clone(),
        });
        let repository = repository_json(789, "new-repo", r#"{"pull":true}"#);
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
        repositories.fail_next_github_snapshot_replace();
        flow.cancel().await.unwrap();
        resume.notify_one();

        assert_eq!(
            completion.await.unwrap().unwrap_err().code,
            "github_storage_unavailable"
        );
        assert_eq!(vault.token("123").await.unwrap().access_token, "old-access");
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
        assert_eq!(
            vault.operations(),
            vec!["load:123", "store:123", "store:123"]
        );
        server.await.unwrap();
    }

    #[tokio::test]
    async fn same_user_old_token_restore_failure_deletes_new_pair_and_marks_reconnect() {
        let repositories = std::sync::Arc::new(test_repositories().await);
        seed_snapshot(&repositories, "123", "connected", None, None).await;
        let vault = std::sync::Arc::new(InMemoryGitHubTokenVault::default());
        vault
            .insert(stored_tokens(
                "123",
                "old-access",
                "old-refresh",
                now_unix() + 3600,
            ))
            .await;
        let reached = std::sync::Arc::new(tokio::sync::Notify::new());
        let resume = std::sync::Arc::new(tokio::sync::Notify::new());
        repositories.block_next_github_snapshot_commit(GitHubSnapshotReplaceHook {
            reached: reached.clone(),
            resume: resume.clone(),
        });
        let repository = repository_json(789, "new-repo", r#"{"pull":true}"#);
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
        vault.fail_next_store();
        flow.cancel().await.unwrap();
        resume.notify_one();

        assert_eq!(
            completion.await.unwrap().unwrap_err().code,
            "github_storage_unavailable"
        );
        assert!(vault.token("123").await.is_none());
        assert_eq!(
            vault.operations(),
            vec!["load:123", "store:123", "store:123", "delete:123"]
        );
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
    async fn different_user_cleanup_attempts_new_delete_after_old_restore_failure() {
        let repositories = std::sync::Arc::new(test_repositories().await);
        seed_snapshot(&repositories, "123", "connected", None, None).await;
        let vault = std::sync::Arc::new(InMemoryGitHubTokenVault::default());
        vault
            .insert(stored_tokens(
                "123",
                "old-access",
                "old-refresh",
                now_unix() + 3600,
            ))
            .await;
        let reached = std::sync::Arc::new(tokio::sync::Notify::new());
        let resume = std::sync::Arc::new(tokio::sync::Notify::new());
        repositories.block_next_github_snapshot_commit(GitHubSnapshotReplaceHook {
            reached: reached.clone(),
            resume: resume.clone(),
        });
        let repository = repository_json(789, "new-repo", r#"{"pull":true}"#);
        let (base_url, server) = scripted_server(vec![
            device_fixture(),
            token_fixture(),
            user_fixture("999", "hubot", "access-one"),
            installations_fixture("access-one", None, r#"{"contents":"read"}"#),
            repositories_fixture("access-one", &format!("[{repository}]")),
        ])
        .await;
        let client = std::sync::Arc::new(GitHubAuthClient::for_test(&base_url).unwrap());
        let flow = std::sync::Arc::new(GitHubConnectFlow::default());
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
        vault.fail_next_store();
        vault.fail_delete_for("999");
        flow.cancel().await.unwrap();
        resume.notify_one();

        assert_eq!(
            completion.await.unwrap().unwrap_err().code,
            "github_storage_unavailable"
        );
        assert!(vault.token("123").await.is_none());
        assert!(vault.token("999").await.is_some());
        assert_eq!(
            vault.operations(),
            vec![
                "load:123",
                "store:999",
                "delete:123",
                "store:123",
                "delete:999",
            ]
        );
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
    async fn cancellation_before_old_delete_marks_missing_old_custody_reconnect() {
        let repositories = std::sync::Arc::new(test_repositories().await);
        seed_snapshot(&repositories, "123", "connected", None, None).await;
        let vault = std::sync::Arc::new(InMemoryGitHubTokenVault::default());
        let reached = std::sync::Arc::new(tokio::sync::Notify::new());
        let resume = std::sync::Arc::new(tokio::sync::Notify::new());
        vault.block_next_store(reached.clone(), resume.clone());
        let repository = repository_json(789, "new-repo", r#"{"pull":true}"#);
        let (base_url, server) = scripted_server(vec![
            device_fixture(),
            token_fixture(),
            user_fixture("999", "hubot", "access-one"),
            installations_fixture("access-one", None, r#"{"contents":"read"}"#),
            repositories_fixture("access-one", &format!("[{repository}]")),
        ])
        .await;
        let client = std::sync::Arc::new(GitHubAuthClient::for_test(&base_url).unwrap());
        let flow = std::sync::Arc::new(GitHubConnectFlow::default());
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
            "github_storage_unavailable"
        );
        assert!(vault.token("999").await.is_none());
        let snapshot = repositories.github_snapshot().await.unwrap().unwrap();
        assert_eq!(snapshot.connection.github_user_id, "123");
        assert_eq!(snapshot.connection.status, "reconnect_required");
        server.await.unwrap();
    }

    #[tokio::test]
    async fn failed_new_store_marks_surviving_snapshot_with_missing_custody_reconnect() {
        let repositories = test_repositories().await;
        seed_snapshot(&repositories, "123", "connected", None, None).await;
        let vault = InMemoryGitHubTokenVault::default();
        vault.fail_next_store();
        let repository = repository_json(789, "new-repo", r#"{"pull":true}"#);
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
        assert!(vault.token("999").await.is_none());
        let snapshot = repositories.github_snapshot().await.unwrap().unwrap();
        assert_eq!(snapshot.connection.github_user_id, "123");
        assert_eq!(snapshot.connection.status, "reconnect_required");
        server.await.unwrap();
    }

    #[tokio::test]
    async fn mismatched_old_custody_is_not_restored_during_different_user_rollback() {
        let repositories = std::sync::Arc::new(test_repositories().await);
        seed_snapshot(&repositories, "123", "connected", None, None).await;
        let vault = std::sync::Arc::new(InMemoryGitHubTokenVault::default());
        vault.tokens.lock().await.insert(
            "123".into(),
            stored_tokens("777", "wrong-access", "wrong-refresh", now_unix() + 3600),
        );
        let reached = std::sync::Arc::new(tokio::sync::Notify::new());
        let resume = std::sync::Arc::new(tokio::sync::Notify::new());
        repositories.block_next_github_snapshot_commit(GitHubSnapshotReplaceHook {
            reached: reached.clone(),
            resume: resume.clone(),
        });
        let repository = repository_json(789, "new-repo", r#"{"pull":true}"#);
        let (base_url, server) = scripted_server(vec![
            device_fixture(),
            token_fixture(),
            user_fixture("999", "hubot", "access-one"),
            installations_fixture("access-one", None, r#"{"contents":"read"}"#),
            repositories_fixture("access-one", &format!("[{repository}]")),
        ])
        .await;
        let client = std::sync::Arc::new(GitHubAuthClient::for_test(&base_url).unwrap());
        let flow = std::sync::Arc::new(GitHubConnectFlow::default());
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
            "github_storage_unavailable"
        );
        assert!(vault.token("123").await.is_none());
        assert!(vault.token("999").await.is_none());
        let snapshot = repositories.github_snapshot().await.unwrap().unwrap();
        assert_eq!(snapshot.connection.github_user_id, "123");
        assert_eq!(snapshot.connection.status, "reconnect_required");
        server.await.unwrap();
    }
}
