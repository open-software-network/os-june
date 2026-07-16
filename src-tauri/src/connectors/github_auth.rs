//! GitHub App public-client authentication and installation discovery.
//!
//! GitHub tokens and device codes are secrets: they are never logged, exposed
//! through `Debug`, or included in provider errors. Production endpoints are
//! fixed here; only tests can inject a loopback HTTP server.

use crate::domain::types::AppError;
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::atomic::{AtomicU64, Ordering},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use zeroize::{Zeroize, ZeroizeOnDrop, Zeroizing};

const DEVICE_CODE_URL: &str = "https://github.com/login/device/code";
const ACCESS_TOKEN_URL: &str = "https://github.com/login/oauth/access_token";
const API_BASE_URL: &str = "https://api.github.com";
const GITHUB_API_VERSION: &str = "2026-03-10";
const GITHUB_VERIFICATION_URI: &str = "https://github.com/login/device";
const HTTP_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_PAGES: u32 = 100;
const MAX_INSTALLATIONS: usize = 100;
const MAX_REPOSITORIES: usize = 10_000;
const MAX_DISCOVERY_REQUESTS: usize = 512;
const MAX_RESPONSE_BYTES: usize = 4 * 1024 * 1024;
const MAX_DISCOVERY_BYTES: usize = 32 * 1024 * 1024;

#[derive(Clone, PartialEq, Eq, Serialize, Zeroize, ZeroizeOnDrop)]
#[serde(rename_all = "camelCase")]
pub struct GitHubDevicePrompt {
    pub user_code: String,
    pub verification_uri: String,
    #[zeroize(skip)]
    pub expires_at_unix: i64,
    #[zeroize(skip)]
    pub interval_seconds: u64,
}

impl std::fmt::Debug for GitHubDevicePrompt {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("GitHubDevicePrompt")
            .field("user_code", &"[REDACTED]")
            .field("verification_uri", &self.verification_uri)
            .field("expires_at_unix", &self.expires_at_unix)
            .field("interval_seconds", &self.interval_seconds)
            .finish()
    }
}

#[derive(Zeroize, ZeroizeOnDrop)]
struct PendingDeviceCode {
    device_code: String,
    #[zeroize(skip)]
    interval_seconds: u64,
    #[zeroize(skip)]
    expires_at_unix: i64,
}

impl PendingDeviceCode {
    fn poll_interval(&self) -> Duration {
        Duration::from_secs(self.interval_seconds)
    }

    fn apply_slow_down(&mut self) -> Result<(), AppError> {
        self.interval_seconds = self
            .interval_seconds
            .checked_add(5)
            .ok_or_else(token_exchange_failed)?;
        Ok(())
    }
}

enum PollOutcome {
    Pending,
    SlowDown,
    Authorized(GitHubTokenGrant),
}

impl PollOutcome {
    #[cfg(test)]
    fn test_classification(&self) -> &'static str {
        match self {
            Self::Pending => "github_connect_pending",
            Self::SlowDown => "github_connect_slow_down",
            Self::Authorized(_) => "github_connect_authorized",
        }
    }
}

#[allow(private_interfaces)]
pub enum RefreshOutcome {
    Refreshed(GitHubTokenGrant),
    InvalidGrant,
}

impl std::fmt::Debug for RefreshOutcome {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Refreshed(_) => formatter.write_str("Refreshed([REDACTED])"),
            Self::InvalidGrant => formatter.write_str("InvalidGrant"),
        }
    }
}

impl std::fmt::Debug for PollOutcome {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Pending => formatter.write_str("Pending"),
            Self::SlowDown => formatter.write_str("SlowDown"),
            Self::Authorized(_) => formatter.write_str("Authorized([REDACTED])"),
        }
    }
}

#[derive(Zeroize, ZeroizeOnDrop)]
pub(super) struct GitHubTokenGrant {
    access_token: String,
    refresh_token: String,
    #[zeroize(skip)]
    expires_at_unix: i64,
    #[zeroize(skip)]
    refresh_token_expires_at_unix: i64,
}

struct ActiveGitHubAttempt {
    id: u64,
    cancellation: tokio::sync::watch::Sender<bool>,
    pending: Option<PendingDeviceCode>,
}

pub(super) struct AuthorizedGitHubAttempt {
    pub(super) attempt_id: u64,
    pub(super) cancellation: tokio::sync::watch::Receiver<bool>,
    pub(super) tokens: GitHubTokenGrant,
}

#[cfg(test)]
#[derive(Clone)]
pub(crate) struct GitHubCompletionHook {
    pub(crate) reached: std::sync::Arc<tokio::sync::Notify>,
    pub(crate) resume: std::sync::Arc<tokio::sync::Notify>,
}

impl std::fmt::Debug for AuthorizedGitHubAttempt {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("AuthorizedGitHubAttempt")
            .field("attempt_id", &self.attempt_id)
            .field("tokens", &"[REDACTED]")
            .finish_non_exhaustive()
    }
}

#[derive(Default)]
pub struct GitHubConnectFlow {
    next_attempt_id: AtomicU64,
    active: tokio::sync::Mutex<Option<ActiveGitHubAttempt>>,
    completion_lock: tokio::sync::Mutex<()>,
    #[cfg(test)]
    after_token_hook: std::sync::Mutex<Option<GitHubCompletionHook>>,
}

impl GitHubConnectFlow {
    pub async fn start(
        &self,
        client: &GitHubAuthClient,
        client_id: &str,
    ) -> Result<GitHubDevicePrompt, AppError> {
        let attempt_id = self
            .next_attempt_id
            .fetch_add(1, Ordering::SeqCst)
            .checked_add(1)
            .ok_or_else(state_invalid)?;
        let (cancellation, mut cancellation_receiver) = tokio::sync::watch::channel(false);
        {
            let mut active = self.active.lock().await;
            if let Some(previous) = active.take() {
                let _ = previous.cancellation.send(true);
            }
            *active = Some(ActiveGitHubAttempt {
                id: attempt_id,
                cancellation,
                pending: None,
            });
        }

        let start_result = tokio::select! {
            biased;
            _ = cancellation_receiver.changed() => Err(connect_canceled()),
            result = client.start_device_flow(client_id) => result,
        };
        let (prompt, pending) = match start_result {
            Ok(result) => result,
            Err(error) => {
                self.clear_if_current(attempt_id).await;
                return Err(error);
            }
        };
        let mut active = self.active.lock().await;
        match active.as_mut() {
            Some(attempt) if attempt.id == attempt_id && !*attempt.cancellation.borrow() => {
                attempt.pending = Some(pending);
                Ok(prompt)
            }
            _ => Err(connect_canceled()),
        }
    }

    pub(super) async fn wait(
        &self,
        client: &GitHubAuthClient,
        client_id: &str,
    ) -> Result<AuthorizedGitHubAttempt, AppError> {
        let (attempt_id, mut cancellation, mut pending) = {
            let mut active = self.active.lock().await;
            let attempt = active.as_mut().ok_or_else(connect_canceled)?;
            let pending = attempt.pending.take().ok_or_else(connect_canceled)?;
            (attempt.id, attempt.cancellation.subscribe(), pending)
        };

        loop {
            if *cancellation.borrow() {
                return Err(connect_canceled());
            }
            tokio::select! {
                changed = cancellation.changed() => {
                    if changed.is_err() || *cancellation.borrow() {
                        return Err(connect_canceled());
                    }
                }
                () = tokio::time::sleep(pending.poll_interval()) => {}
            }
            if *cancellation.borrow() {
                return Err(connect_canceled());
            }
            if now_unix() >= pending.expires_at_unix {
                self.clear_if_current(attempt_id).await;
                return Err(connect_expired());
            }

            let outcome = tokio::select! {
                changed = cancellation.changed() => {
                    if changed.is_err() || *cancellation.borrow() {
                        return Err(connect_canceled());
                    }
                    continue;
                }
                outcome = client.poll_device_flow_once(client_id, &pending) => outcome,
            };
            match outcome {
                Ok(PollOutcome::Pending) => {}
                Ok(PollOutcome::SlowDown) => {
                    if let Err(error) = pending.apply_slow_down() {
                        self.clear_if_current(attempt_id).await;
                        return Err(error);
                    }
                }
                Ok(PollOutcome::Authorized(tokens)) => {
                    if !self.is_active(attempt_id).await || *cancellation.borrow() {
                        return Err(connect_canceled());
                    }
                    return Ok(AuthorizedGitHubAttempt {
                        attempt_id,
                        cancellation,
                        tokens,
                    });
                }
                Err(error) => {
                    self.clear_if_current(attempt_id).await;
                    return Err(error);
                }
            }
        }
    }

    pub async fn cancel(&self) -> Result<(), AppError> {
        if let Some(active) = self.active.lock().await.take() {
            let _ = active.cancellation.send(true);
        }
        Ok(())
    }

    pub(super) async fn is_active(&self, attempt_id: u64) -> bool {
        self.active
            .lock()
            .await
            .as_ref()
            .is_some_and(|attempt| attempt.id == attempt_id && !*attempt.cancellation.borrow())
    }

    pub(super) async fn completion_guard(&self) -> tokio::sync::MutexGuard<'_, ()> {
        self.completion_lock.lock().await
    }

    pub(super) async fn finish_if_current(&self, attempt_id: u64) -> bool {
        let mut active = self.active.lock().await;
        if active
            .as_ref()
            .is_some_and(|attempt| attempt.id == attempt_id)
        {
            active.take();
            true
        } else {
            false
        }
    }

    #[cfg(test)]
    pub(crate) fn set_after_token_hook(&self, hook: GitHubCompletionHook) {
        *self.after_token_hook.lock().expect("completion hook") = Some(hook);
    }

    #[cfg(test)]
    pub(super) async fn pause_after_token_for_test(&self) {
        let hook = self
            .after_token_hook
            .lock()
            .expect("completion hook")
            .take();
        if let Some(hook) = hook {
            hook.reached.notify_one();
            hook.resume.notified().await;
        }
    }

    async fn clear_if_current(&self, attempt_id: u64) {
        let mut active = self.active.lock().await;
        if active
            .as_ref()
            .is_some_and(|attempt| attempt.id == attempt_id)
        {
            active.take();
        }
    }

    #[cfg(test)]
    pub(crate) async fn active_attempt_id(&self) -> Option<u64> {
        self.active.lock().await.as_ref().map(|attempt| attempt.id)
    }
}

impl GitHubTokenGrant {
    pub(super) fn access_token(&self) -> &str {
        &self.access_token
    }

    pub(super) fn into_stored(
        mut self,
        github_user_id: String,
    ) -> super::github_store::StoredGitHubTokens {
        super::github_store::StoredGitHubTokens {
            github_user_id,
            access_token: std::mem::take(&mut self.access_token),
            refresh_token: std::mem::take(&mut self.refresh_token),
            expires_at_unix: self.expires_at_unix,
            refresh_token_expires_at_unix: self.refresh_token_expires_at_unix,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DiscoveredGitHubUser {
    pub github_user_id: String,
    pub login: String,
    pub avatar_url: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DiscoveredGitHubInstallation {
    pub installation_id: String,
    pub owner_id: String,
    pub owner_login: String,
    pub owner_type: String,
    pub management_url: String,
    pub repository_selection: String,
    pub permissions: BTreeMap<String, String>,
    pub suspended_at: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DiscoveredGitHubRepository {
    pub repository_id: String,
    pub installation_id: String,
    pub owner_login: String,
    pub name: String,
    pub full_name: String,
    pub is_private: bool,
    pub is_archived: bool,
    pub permissions: BTreeMap<String, bool>,
}

#[derive(Deserialize, Zeroize, ZeroizeOnDrop)]
#[allow(dead_code)]
struct DeviceCodeWire {
    device_code: String,
    user_code: String,
    verification_uri: String,
    #[zeroize(skip)]
    expires_in: u64,
    #[zeroize(skip)]
    interval: u64,
}

#[derive(Deserialize, Zeroize, ZeroizeOnDrop)]
struct TokenErrorWire {
    error: String,
}

#[derive(Deserialize, Zeroize, ZeroizeOnDrop)]
struct TokenSuccessWire {
    access_token: String,
    refresh_token: String,
    #[zeroize(skip)]
    expires_in: u64,
    #[zeroize(skip)]
    refresh_token_expires_in: u64,
}

#[derive(Deserialize)]
struct UserWire {
    #[serde(deserialize_with = "deserialize_numeric_id")]
    id: String,
    login: String,
    #[serde(default)]
    avatar_url: Option<String>,
}

#[derive(Deserialize)]
struct InstallationsWire {
    installations: Vec<InstallationWire>,
}

#[derive(Deserialize)]
struct InstallationWire {
    #[serde(deserialize_with = "deserialize_numeric_id")]
    id: String,
    account: InstallationOwnerWire,
    html_url: String,
    repository_selection: String,
    permissions: BTreeMap<String, String>,
    #[serde(default)]
    suspended_at: Option<String>,
}

#[derive(Deserialize)]
struct InstallationOwnerWire {
    #[serde(deserialize_with = "deserialize_numeric_id")]
    id: String,
    login: String,
    #[serde(rename = "type")]
    owner_type: String,
}

#[derive(Deserialize)]
struct RepositoriesWire {
    repositories: Vec<RepositoryWire>,
}

#[derive(Deserialize)]
struct RepositoryWire {
    #[serde(deserialize_with = "deserialize_numeric_id")]
    id: String,
    owner: RepositoryOwnerWire,
    name: String,
    full_name: String,
    #[serde(rename = "private")]
    is_private: bool,
    #[serde(rename = "archived")]
    is_archived: bool,
    permissions: BTreeMap<String, bool>,
}

#[derive(Deserialize)]
struct RepositoryOwnerWire {
    login: String,
}

#[derive(Default)]
struct DiscoveryBudget {
    requests: usize,
    bytes: usize,
}

impl DiscoveryBudget {
    fn begin_request(&mut self) -> Result<(), AppError> {
        if self.requests >= MAX_DISCOVERY_REQUESTS {
            return Err(result_limit_exceeded());
        }
        self.requests += 1;
        Ok(())
    }

    fn charge_response_bytes(&mut self, bytes: usize) -> Result<(), AppError> {
        let next = self
            .bytes
            .checked_add(bytes)
            .ok_or_else(result_limit_exceeded)?;
        if next > MAX_DISCOVERY_BYTES {
            return Err(result_limit_exceeded());
        }
        self.bytes = next;
        Ok(())
    }
}

#[derive(Clone)]
pub struct GitHubAuthClient {
    http: reqwest::Client,
    #[allow(dead_code)]
    device_code_url: String,
    access_token_url: String,
    api_base_url: String,
}

impl GitHubAuthClient {
    pub fn production() -> Result<Self, AppError> {
        Self::new(
            DEVICE_CODE_URL.to_owned(),
            ACCESS_TOKEN_URL.to_owned(),
            API_BASE_URL.to_owned(),
        )
    }

    #[cfg(test)]
    pub(crate) fn for_test(base_url: &str) -> Result<Self, AppError> {
        let url = reqwest::Url::parse(base_url).map_err(|_| client_build_failed())?;
        let is_loopback = url
            .host_str()
            .and_then(|host| host.parse::<std::net::IpAddr>().ok())
            .is_some_and(|address| address.is_loopback());
        if url.scheme() != "http"
            || !is_loopback
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
            || url.path() != "/"
        {
            return Err(client_build_failed());
        }
        let base = base_url.trim_end_matches('/');
        Self::new(
            format!("{base}/login/device/code"),
            format!("{base}/login/oauth/access_token"),
            base.to_owned(),
        )
    }

    fn new(
        device_code_url: String,
        access_token_url: String,
        api_base_url: String,
    ) -> Result<Self, AppError> {
        let http = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(HTTP_TIMEOUT)
            .pool_idle_timeout(Duration::from_secs(90))
            .tcp_keepalive(Some(Duration::from_secs(30)))
            .user_agent("os-june/0.1")
            .build()
            .map_err(|_| client_build_failed())?;
        Ok(Self {
            http,
            device_code_url,
            access_token_url,
            api_base_url,
        })
    }

    async fn start_device_flow(
        &self,
        client_id: &str,
    ) -> Result<(GitHubDevicePrompt, PendingDeviceCode), AppError> {
        let mut form = device_code_form(client_id);
        let request = self
            .http
            .post(&self.device_code_url)
            .header(reqwest::header::ACCEPT, "application/json")
            .form(&form);
        zeroize_form_values(&mut form);
        let response = request.send().await.map_err(|_| token_exchange_failed())?;
        let status = response.status();
        let body = read_response_bounded(response)
            .await
            .map_err(|_| token_exchange_failed())?;
        if !status.is_success() {
            return Err(token_exchange_failed());
        }
        let mut wire =
            serde_json::from_slice::<DeviceCodeWire>(&body).map_err(|_| token_exchange_failed())?;
        if wire.device_code.is_empty()
            || wire.user_code.is_empty()
            || wire.verification_uri != GITHUB_VERIFICATION_URI
            || wire.expires_in == 0
            || wire.interval == 0
        {
            return Err(token_exchange_failed());
        }
        let expires_at_unix = absolute_expiry(now_unix(), wire.expires_in)?;
        let prompt = GitHubDevicePrompt {
            user_code: std::mem::take(&mut wire.user_code),
            verification_uri: std::mem::take(&mut wire.verification_uri),
            expires_at_unix,
            interval_seconds: wire.interval,
        };
        let pending = PendingDeviceCode {
            device_code: std::mem::take(&mut wire.device_code),
            interval_seconds: wire.interval,
            expires_at_unix,
        };
        Ok((prompt, pending))
    }

    async fn poll_device_flow_once(
        &self,
        client_id: &str,
        pending: &PendingDeviceCode,
    ) -> Result<PollOutcome, AppError> {
        if now_unix() >= pending.expires_at_unix {
            return Err(connect_expired());
        }
        let mut form = device_poll_form(client_id, &pending.device_code);
        let request = self
            .http
            .post(&self.access_token_url)
            .header(reqwest::header::ACCEPT, "application/json")
            .form(&form);
        zeroize_form_values(&mut form);
        let response = request.send().await.map_err(|_| token_exchange_failed())?;
        let status = response.status();
        let body = read_response_bounded(response)
            .await
            .map_err(|_| token_exchange_failed())?;
        if !status.is_success() {
            return Err(token_exchange_failed());
        }
        classify_token_bytes(&body)
    }

    pub async fn refresh_tokens(
        &self,
        client_id: &str,
        refresh_token: &str,
    ) -> Result<RefreshOutcome, AppError> {
        let mut form = refresh_form(client_id, refresh_token);
        let request = self
            .http
            .post(&self.access_token_url)
            .header(reqwest::header::ACCEPT, "application/json")
            .form(&form);
        zeroize_form_values(&mut form);
        let response = request.send().await.map_err(|_| refresh_failed())?;
        let status = response.status();
        let body = read_response_bounded(response)
            .await
            .map_err(|_| refresh_failed())?;
        if let Ok(grant) = token_grant_from_bytes(&body) {
            if status.is_success() {
                return Ok(RefreshOutcome::Refreshed(grant));
            }
            return Err(refresh_failed());
        }
        let error = serde_json::from_slice::<TokenErrorWire>(&body).ok();
        if can_invalidate_refresh(status)
            && error
                .as_ref()
                .is_some_and(|wire| is_invalid_refresh(&wire.error))
        {
            Ok(RefreshOutcome::InvalidGrant)
        } else {
            Err(refresh_failed())
        }
    }

    pub async fn current_user(&self, access_token: &str) -> Result<DiscoveredGitHubUser, AppError> {
        let url = format!("{}/user", self.api_base_url);
        let response = self
            .api_get(&url, access_token)
            .await
            .map_err(|_| request_failed())?;
        let status = response.status();
        let headers = response.headers().clone();
        let body = read_response_bounded(response).await;
        if !status.is_success() {
            return Err(classify_api_error(status, &headers, false));
        }
        let body = body.map_err(|error| match error {
            ResponseReadError::Transport => request_failed(),
            ResponseReadError::Limit => state_invalid(),
        })?;
        let wire = serde_json::from_slice::<UserWire>(&body).map_err(|_| state_invalid())?;
        if wire.login.trim().is_empty() {
            return Err(state_invalid());
        }
        Ok(DiscoveredGitHubUser {
            github_user_id: wire.id,
            login: wire.login,
            avatar_url: wire.avatar_url.filter(|url| is_allowed_avatar_url(url)),
        })
    }

    pub async fn installations_and_repositories(
        &self,
        access_token: &str,
    ) -> Result<
        (
            Vec<DiscoveredGitHubInstallation>,
            Vec<DiscoveredGitHubRepository>,
        ),
        AppError,
    > {
        let mut budget = DiscoveryBudget::default();
        let mut installation_ids = BTreeSet::new();
        let mut installations = Vec::new();
        let mut page = 1_u32;

        loop {
            if page > MAX_PAGES || installations.len() >= MAX_INSTALLATIONS {
                return Err(result_limit_exceeded());
            }
            budget.begin_request()?;
            let url = format!(
                "{}/user/installations?per_page=100&page={page}",
                self.api_base_url
            );
            let response = self
                .api_get(&url, access_token)
                .await
                .map_err(|_| request_failed())?;
            let status = response.status();
            let headers = response.headers().clone();
            let body = read_discovery_response(response, &mut budget).await;
            if !status.is_success() {
                return Err(classify_api_error(status, &headers, true));
            }
            let body = body?;
            let wire =
                serde_json::from_slice::<InstallationsWire>(&body).map_err(|_| state_invalid())?;
            for installation in wire.installations {
                if installations.len() >= MAX_INSTALLATIONS {
                    return Err(result_limit_exceeded());
                }
                let installation = installation_from_wire(installation)?;
                if !installation_ids.insert(installation.installation_id.clone()) {
                    return Err(state_invalid());
                }
                installations.push(installation);
            }
            if !link_has_next(&headers) {
                break;
            }
            if page >= MAX_PAGES || installations.len() >= MAX_INSTALLATIONS {
                return Err(result_limit_exceeded());
            }
            page += 1;
        }

        let mut repository_ids = BTreeSet::new();
        let mut repositories = Vec::new();
        for installation in &installations {
            if installation.suspended_at.is_some() {
                continue;
            }
            let mut page = 1_u32;
            loop {
                if page > MAX_PAGES || repositories.len() >= MAX_REPOSITORIES {
                    return Err(result_limit_exceeded());
                }
                budget.begin_request()?;
                let url = format!(
                    "{}/user/installations/{}/repositories?per_page=100&page={page}",
                    self.api_base_url, installation.installation_id
                );
                let response = self
                    .api_get(&url, access_token)
                    .await
                    .map_err(|_| request_failed())?;
                let status = response.status();
                let headers = response.headers().clone();
                let body = read_discovery_response(response, &mut budget).await;
                if !status.is_success() {
                    return Err(classify_api_error(status, &headers, true));
                }
                let body = body?;
                let wire = serde_json::from_slice::<RepositoriesWire>(&body)
                    .map_err(|_| state_invalid())?;
                for repository in wire.repositories {
                    if repositories.len() >= MAX_REPOSITORIES {
                        return Err(result_limit_exceeded());
                    }
                    let repository =
                        repository_from_wire(repository, installation.installation_id.clone())?;
                    if !repository_ids.insert(repository.repository_id.clone()) {
                        return Err(state_invalid());
                    }
                    repositories.push(repository);
                }
                if !link_has_next(&headers) {
                    break;
                }
                if page >= MAX_PAGES || repositories.len() >= MAX_REPOSITORIES {
                    return Err(result_limit_exceeded());
                }
                page += 1;
            }
        }

        Ok((installations, repositories))
    }

    async fn api_get(
        &self,
        url: &str,
        access_token: &str,
    ) -> Result<reqwest::Response, reqwest::Error> {
        self.http
            .get(url)
            .header(reqwest::header::ACCEPT, "application/vnd.github+json")
            .header("X-GitHub-Api-Version", GITHUB_API_VERSION)
            .bearer_auth(access_token)
            .send()
            .await
    }
}

fn installation_from_wire(
    wire: InstallationWire,
) -> Result<DiscoveredGitHubInstallation, AppError> {
    let installation_id = wire.id;
    if wire.account.login.trim().is_empty()
        || wire.account.owner_type.trim().is_empty()
        || !matches!(wire.repository_selection.as_str(), "all" | "selected")
        || !is_allowed_management_url(&wire.html_url, &installation_id)
    {
        return Err(state_invalid());
    }
    Ok(DiscoveredGitHubInstallation {
        installation_id,
        owner_id: wire.account.id,
        owner_login: wire.account.login,
        owner_type: wire.account.owner_type,
        management_url: wire.html_url,
        repository_selection: wire.repository_selection,
        permissions: wire.permissions,
        suspended_at: wire.suspended_at,
    })
}

fn repository_from_wire(
    wire: RepositoryWire,
    installation_id: String,
) -> Result<DiscoveredGitHubRepository, AppError> {
    if wire.owner.login.trim().is_empty()
        || wire.name.trim().is_empty()
        || wire.full_name.trim().is_empty()
    {
        return Err(state_invalid());
    }
    Ok(DiscoveredGitHubRepository {
        repository_id: wire.id,
        installation_id,
        owner_login: wire.owner.login,
        name: wire.name,
        full_name: wire.full_name,
        is_private: wire.is_private,
        is_archived: wire.is_archived,
        permissions: wire.permissions,
    })
}

fn is_allowed_management_url(raw: &str, installation_id: &str) -> bool {
    let Ok(url) = reqwest::Url::parse(raw) else {
        return false;
    };
    if url.scheme() != "https"
        || url.host_str() != Some("github.com")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return false;
    }
    let Some(segments) = url.path_segments() else {
        return false;
    };
    let segments = segments
        .filter(|segment| !segment.is_empty())
        .collect::<Vec<_>>();
    segments.as_slice() == ["settings", "installations", installation_id]
        || (segments.len() == 5
            && segments[0] == "organizations"
            && !segments[1].is_empty()
            && segments[2] == "settings"
            && segments[3] == "installations"
            && segments[4] == installation_id)
}

fn link_has_next(headers: &reqwest::header::HeaderMap) -> bool {
    headers
        .get_all(reqwest::header::LINK)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(','))
        .any(|link| {
            link.split(';')
                .skip(1)
                .map(str::trim)
                .any(|parameter| parameter == "rel=\"next\"")
        })
}

fn deserialize_numeric_id<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let id = u64::deserialize(deserializer)?;
    Ok(id.to_string())
}

#[allow(dead_code)]
pub(super) fn ensure_installation_active(
    installation: &DiscoveredGitHubInstallation,
) -> Result<(), AppError> {
    if installation.suspended_at.is_some() {
        Err(AppError::new(
            "github_installation_suspended",
            "This GitHub App installation is suspended.",
        ))
    } else {
        Ok(())
    }
}

#[allow(dead_code)]
pub(super) fn classify_repository_removal(
    old_ids: &BTreeSet<String>,
    new_ids: &BTreeSet<String>,
) -> Result<(), AppError> {
    if old_ids.is_subset(new_ids) {
        Ok(())
    } else {
        Err(AppError::new(
            "github_repository_access_removed",
            "Access to one or more GitHub repositories was removed.",
        ))
    }
}

#[allow(dead_code)]
fn device_code_form(client_id: &str) -> Vec<(&'static str, String)> {
    vec![("client_id", client_id.to_owned())]
}

fn refresh_form(client_id: &str, refresh_token: &str) -> Vec<(&'static str, String)> {
    vec![
        ("client_id", client_id.to_owned()),
        ("refresh_token", refresh_token.to_owned()),
        ("grant_type", "refresh_token".to_owned()),
    ]
}

fn zeroize_form_values(form: &mut [(&'static str, String)]) {
    for (_, value) in form {
        value.zeroize();
    }
}

#[allow(dead_code)]
fn device_poll_form(client_id: &str, device_code: &str) -> Vec<(&'static str, String)> {
    vec![
        ("client_id", client_id.to_owned()),
        ("device_code", device_code.to_owned()),
        (
            "grant_type",
            "urn:ietf:params:oauth:grant-type:device_code".to_owned(),
        ),
    ]
}

#[cfg(test)]
fn classify_token_body(body: &str) -> Result<PollOutcome, AppError> {
    classify_token_bytes(body.as_bytes())
}

#[allow(dead_code)]
fn classify_token_bytes(body: &[u8]) -> Result<PollOutcome, AppError> {
    if let Ok(grant) = token_grant_from_bytes(body) {
        return Ok(PollOutcome::Authorized(grant));
    }
    let error =
        serde_json::from_slice::<TokenErrorWire>(body).map_err(|_| token_exchange_failed())?;
    match error.error.as_str() {
        "authorization_pending" => Ok(PollOutcome::Pending),
        "slow_down" => Ok(PollOutcome::SlowDown),
        "access_denied" => Err(AppError::new(
            "github_connect_denied",
            "GitHub access was declined.",
        )),
        "expired_token" => Err(connect_expired()),
        _ => Err(token_exchange_failed()),
    }
}

fn token_grant_from_bytes(body: &[u8]) -> Result<GitHubTokenGrant, AppError> {
    let mut wire =
        serde_json::from_slice::<TokenSuccessWire>(body).map_err(|_| token_exchange_failed())?;
    if wire.access_token.is_empty()
        || wire.refresh_token.is_empty()
        || wire.expires_in == 0
        || wire.refresh_token_expires_in == 0
    {
        return Err(token_exchange_failed());
    }
    let now = now_unix();
    let expires_at_unix = absolute_expiry(now, wire.expires_in)?;
    let refresh_token_expires_at_unix = absolute_expiry(now, wire.refresh_token_expires_in)?;
    Ok(GitHubTokenGrant {
        access_token: std::mem::take(&mut wire.access_token),
        refresh_token: std::mem::take(&mut wire.refresh_token),
        expires_at_unix,
        refresh_token_expires_at_unix,
    })
}

fn absolute_expiry(now: i64, expires_in: u64) -> Result<i64, AppError> {
    now.checked_add(i64::try_from(expires_in).map_err(|_| token_exchange_failed())?)
        .ok_or_else(token_exchange_failed)
}

fn is_invalid_refresh(error: &str) -> bool {
    matches!(
        error,
        "bad_refresh_token"
            | "invalid_grant"
            | "expired_token"
            | "revoked_token"
            | "incorrect_client_credentials"
    )
}

fn can_invalidate_refresh(status: reqwest::StatusCode) -> bool {
    matches!(
        status,
        reqwest::StatusCode::OK | reqwest::StatusCode::BAD_REQUEST
    )
}

fn is_allowed_avatar_url(raw: &str) -> bool {
    reqwest::Url::parse(raw).is_ok_and(|url| {
        url.scheme() == "https"
            && url.host_str() == Some("avatars.githubusercontent.com")
            && url.username().is_empty()
            && url.password().is_none()
            && url.port().is_none()
            && url.fragment().is_none()
    })
}

fn classify_api_error(
    status: reqwest::StatusCode,
    headers: &reqwest::header::HeaderMap,
    is_collection: bool,
) -> AppError {
    if status == reqwest::StatusCode::UNAUTHORIZED {
        return reconnect_required();
    }
    if status == reqwest::StatusCode::TOO_MANY_REQUESTS
        || (status == reqwest::StatusCode::FORBIDDEN && has_rate_limit_signal(headers))
    {
        return rate_limited(headers);
    }
    if status == reqwest::StatusCode::FORBIDDEN {
        return installation_required_with_sso(headers);
    }
    if is_collection && status == reqwest::StatusCode::NOT_FOUND {
        return installation_required();
    }
    if is_collection {
        installation_required()
    } else {
        state_invalid()
    }
}

fn has_rate_limit_signal(headers: &reqwest::header::HeaderMap) -> bool {
    parsed_header_u64(headers, reqwest::header::RETRY_AFTER).is_some()
        || parsed_named_header_u64(headers, "X-RateLimit-Remaining") == Some(0)
}

fn rate_limited(headers: &reqwest::header::HeaderMap) -> AppError {
    let mut details = serde_json::Map::new();
    if let Some(value) = parsed_header_u64(headers, reqwest::header::RETRY_AFTER) {
        details.insert("retryAfterSeconds".into(), value.into());
    }
    if let Some(value) = parsed_named_header_u64(headers, "X-RateLimit-Reset") {
        details.insert("rateLimitResetUnix".into(), value.into());
    }
    if let Some(value) = parsed_named_header_u64(headers, "X-RateLimit-Remaining") {
        details.insert("rateLimitRemaining".into(), value.into());
    }
    AppError {
        code: "github_rate_limited".into(),
        message: "GitHub is temporarily rate limiting requests.".into(),
        details: Some(serde_json::Value::Object(details)),
    }
}

fn parsed_header_u64(
    headers: &reqwest::header::HeaderMap,
    name: reqwest::header::HeaderName,
) -> Option<u64> {
    headers.get(name)?.to_str().ok()?.trim().parse().ok()
}

fn parsed_named_header_u64(
    headers: &reqwest::header::HeaderMap,
    name: &'static str,
) -> Option<u64> {
    headers.get(name)?.to_str().ok()?.trim().parse().ok()
}

fn installation_required_with_sso(headers: &reqwest::header::HeaderMap) -> AppError {
    let Some(value) = headers
        .get("X-GitHub-SSO")
        .and_then(|value| value.to_str().ok())
    else {
        return installation_required();
    };
    let mut details = serde_json::Map::from_iter([(
        "reason".into(),
        serde_json::Value::String("sso_required".into()),
    )]);
    if let Some(url) = value
        .split(';')
        .map(str::trim)
        .find_map(|part| part.strip_prefix("url="))
        .filter(|url| is_allowed_github_url(url))
    {
        details.insert("ssoUrl".into(), serde_json::Value::String(url.to_owned()));
    }
    AppError {
        code: "github_installation_required".into(),
        message: "GitHub requires additional installation access.".into(),
        details: Some(serde_json::Value::Object(details)),
    }
}

fn is_allowed_github_url(raw: &str) -> bool {
    reqwest::Url::parse(raw).is_ok_and(|url| {
        url.scheme() == "https"
            && url.host_str() == Some("github.com")
            && url.username().is_empty()
            && url.password().is_none()
            && url.port().is_none()
            && url.fragment().is_none()
    })
}

#[derive(Debug)]
enum ResponseReadError {
    Transport,
    Limit,
}

async fn read_response_bounded(
    mut response: reqwest::Response,
) -> Result<Zeroizing<Vec<u8>>, ResponseReadError> {
    if response
        .content_length()
        .is_some_and(|length| length > MAX_RESPONSE_BYTES as u64)
    {
        return Err(ResponseReadError::Limit);
    }
    // The accumulator owns partial response bytes across every await. Future
    // cancellation, chunk failures, and limit returns therefore all drop a
    // zeroizing buffer rather than an ordinary Vec.
    let mut body = Zeroizing::new(Vec::new());
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| ResponseReadError::Transport)?
    {
        if body.len().saturating_add(chunk.len()) > MAX_RESPONSE_BYTES {
            return Err(ResponseReadError::Limit);
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

async fn read_discovery_response(
    mut response: reqwest::Response,
    budget: &mut DiscoveryBudget,
) -> Result<Vec<u8>, AppError> {
    if response.content_length().is_some_and(|length| {
        length > MAX_RESPONSE_BYTES as u64
            || usize::try_from(length).map_or(true, |length| {
                budget.bytes.saturating_add(length) > MAX_DISCOVERY_BYTES
            })
    }) {
        return Err(result_limit_exceeded());
    }
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| request_failed())? {
        if body.len().saturating_add(chunk.len()) > MAX_RESPONSE_BYTES {
            return Err(result_limit_exceeded());
        }
        budget.charge_response_bytes(chunk.len())?;
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

fn now_unix() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or(0)
}

fn client_build_failed() -> AppError {
    AppError::new(
        "github_token_exchange_failed",
        "Could not prepare the GitHub connection.",
    )
}

fn token_exchange_failed() -> AppError {
    AppError::new(
        "github_token_exchange_failed",
        "Could not complete the GitHub connection.",
    )
}

fn refresh_failed() -> AppError {
    AppError::new("github_refresh_failed", "Could not refresh GitHub access.")
}

fn request_failed() -> AppError {
    AppError::new(
        "github_request_failed",
        "Could not reach GitHub. Check your connection and try again.",
    )
}

#[allow(dead_code)]
fn connect_expired() -> AppError {
    AppError::new(
        "github_connect_expired",
        "The GitHub connection code expired.",
    )
}

#[allow(dead_code)]
pub(super) fn connect_canceled() -> AppError {
    AppError::new(
        "github_connect_canceled",
        "Connecting to GitHub was canceled.",
    )
}

fn reconnect_required() -> AppError {
    AppError::new(
        "github_reconnect_required",
        "GitHub access expired. Reconnect it in settings.",
    )
}

fn installation_required() -> AppError {
    AppError::new(
        "github_installation_required",
        "GitHub App installation access is required.",
    )
}

fn state_invalid() -> AppError {
    AppError::new(
        "github_state_invalid",
        "GitHub returned invalid connection data.",
    )
}

fn result_limit_exceeded() -> AppError {
    AppError::new(
        "github_result_limit_exceeded",
        "GitHub returned more connection data than June can safely process.",
    )
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::collections::BTreeSet;
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpListener,
    };

    struct CapturedRequest {
        method: String,
        path: String,
        headers: BTreeSet<String>,
        has_expected_public_client_id: bool,
        form_field_names: BTreeSet<String>,
    }

    pub(crate) struct SafeScriptCapture {
        pub(crate) method: String,
        pub(crate) path: String,
        pub(crate) headers: BTreeSet<String>,
        pub(crate) form_field_names: BTreeSet<String>,
        pub(crate) has_expected_client_id: bool,
        pub(crate) has_expected_device_code: bool,
        pub(crate) has_expected_refresh_token: bool,
        pub(crate) has_expected_grant_type: bool,
        pub(crate) has_expected_bearer_token: bool,
    }

    #[derive(Default)]
    pub(crate) struct RequestExpectations {
        pub(crate) client_id: Option<&'static str>,
        pub(crate) device_code: Option<&'static str>,
        pub(crate) refresh_token: Option<&'static str>,
        pub(crate) grant_type: Option<&'static str>,
        pub(crate) bearer_token: Option<&'static str>,
    }

    pub(crate) struct ResponseFixture {
        status: u16,
        headers: Vec<(String, String)>,
        body: String,
        declared_length: Option<usize>,
        chunked: bool,
        allow_early_close: bool,
        block: Option<(
            std::sync::Arc<tokio::sync::Notify>,
            std::sync::Arc<tokio::sync::Notify>,
        )>,
    }

    impl ResponseFixture {
        pub(crate) fn json(status: u16, body: impl Into<String>) -> Self {
            Self {
                status,
                headers: vec![("Content-Type".into(), "application/json".into())],
                body: body.into(),
                declared_length: None,
                chunked: false,
                allow_early_close: false,
                block: None,
            }
        }

        pub(crate) fn with_header(mut self, name: &str, value: &str) -> Self {
            self.headers.push((name.to_owned(), value.to_owned()));
            self
        }

        pub(crate) fn blocked(
            mut self,
            reached: std::sync::Arc<tokio::sync::Notify>,
            resume: std::sync::Arc<tokio::sync::Notify>,
        ) -> Self {
            self.block = Some((reached, resume));
            self.allow_early_close = true;
            self
        }

        fn chunked(mut self) -> Self {
            self.chunked = true;
            self.allow_early_close = true;
            self
        }

        fn allow_early_close(mut self) -> Self {
            self.allow_early_close = true;
            self
        }
    }

    pub(crate) async fn read_safe_request(
        stream: &mut tokio::net::TcpStream,
        expected: &RequestExpectations,
    ) -> SafeScriptCapture {
        let mut bytes = Vec::new();
        let mut buffer = [0_u8; 1024];
        loop {
            let read = stream.read(&mut buffer).await.expect("read request");
            assert!(read > 0, "request closed before its body was complete");
            bytes.extend_from_slice(&buffer[..read]);
            let Some(header_end) = bytes.windows(4).position(|window| window == b"\r\n\r\n") else {
                continue;
            };
            let headers = String::from_utf8_lossy(&bytes[..header_end]);
            let content_length = headers
                .lines()
                .find_map(|line| {
                    let (name, value) = line.split_once(':')?;
                    name.eq_ignore_ascii_case("content-length")
                        .then(|| value.trim().parse::<usize>().ok())
                        .flatten()
                })
                .unwrap_or(0);
            if bytes.len() >= header_end + 4 + content_length {
                break;
            }
        }

        let header_end = bytes
            .windows(4)
            .position(|window| window == b"\r\n\r\n")
            .expect("request headers");
        let header_text = String::from_utf8_lossy(&bytes[..header_end]);
        let mut lines = header_text.lines();
        let request_line = lines.next().expect("request line");
        let mut request_parts = request_line.split_whitespace();
        let method = request_parts.next().unwrap_or_default().to_owned();
        let path = request_parts.next().unwrap_or_default().to_owned();
        let mut authorization = None;
        let headers = lines
            .filter_map(|line| {
                let (name, value) = line.split_once(':')?;
                if name.eq_ignore_ascii_case("authorization") {
                    authorization = Some(value.trim().to_owned());
                    None
                } else {
                    Some(format!("{}: {}", name.to_ascii_lowercase(), value.trim()))
                }
            })
            .collect();
        let body = String::from_utf8_lossy(&bytes[header_end + 4..]);
        let form = body
            .split('&')
            .filter_map(|pair| pair.split_once('='))
            .filter_map(|(key, value)| {
                Some((
                    urlencoding::decode(key).ok()?.into_owned(),
                    urlencoding::decode(value).ok()?.into_owned(),
                ))
            })
            .collect::<Vec<_>>();
        let form_field_names = form
            .iter()
            .map(|(key, _)| key.clone())
            .collect::<BTreeSet<_>>();
        let contains_form_value = |name: &str, expected: Option<&str>| {
            expected.is_some_and(|expected| {
                form.iter()
                    .any(|(key, value)| key == name && value == expected)
            })
        };
        let has_expected_bearer_token = expected.bearer_token.is_some_and(|token| {
            authorization.as_deref() == Some(format!("Bearer {token}").as_str())
        });

        SafeScriptCapture {
            method,
            path,
            headers,
            form_field_names,
            has_expected_client_id: contains_form_value("client_id", expected.client_id),
            has_expected_device_code: contains_form_value("device_code", expected.device_code),
            has_expected_refresh_token: contains_form_value(
                "refresh_token",
                expected.refresh_token,
            ),
            has_expected_grant_type: contains_form_value("grant_type", expected.grant_type),
            has_expected_bearer_token,
        }
    }

    pub(crate) async fn scripted_server(
        script: Vec<(ResponseFixture, RequestExpectations)>,
    ) -> (String, tokio::task::JoinHandle<Vec<SafeScriptCapture>>) {
        let listener = TcpListener::bind(("127.0.0.1", 0))
            .await
            .expect("bind local server");
        let base_url = format!("http://{}", listener.local_addr().expect("server address"));
        let task = tokio::spawn(async move {
            let mut captures = Vec::with_capacity(script.len());
            for (fixture, expected) in script {
                let (mut stream, _) = listener.accept().await.expect("accept request");
                captures.push(read_safe_request(&mut stream, &expected).await);
                let reason = match fixture.status {
                    200 => "OK",
                    400 => "Bad Request",
                    401 => "Unauthorized",
                    403 => "Forbidden",
                    404 => "Not Found",
                    429 => "Too Many Requests",
                    500 => "Internal Server Error",
                    _ => "Response",
                };
                if let Some((reached, resume)) = fixture.block.as_ref() {
                    reached.notify_one();
                    resume.notified().await;
                }
                let mut response = format!("HTTP/1.1 {} {}\r\n", fixture.status, reason);
                for (name, value) in fixture.headers {
                    response.push_str(&format!("{name}: {value}\r\n"));
                }
                if fixture.chunked {
                    response.push_str("Transfer-Encoding: chunked\r\nConnection: close\r\n\r\n");
                    let write_result = async {
                        stream.write_all(response.as_bytes()).await?;
                        for chunk in fixture.body.as_bytes().chunks(64 * 1024) {
                            stream
                                .write_all(format!("{:X}\r\n", chunk.len()).as_bytes())
                                .await?;
                            stream.write_all(chunk).await?;
                            stream.write_all(b"\r\n").await?;
                        }
                        stream.write_all(b"0\r\n\r\n").await
                    }
                    .await;
                    if !fixture.allow_early_close {
                        write_result.expect("write chunked response");
                    }
                } else {
                    response.push_str(&format!(
                        "Content-Length: {}\r\nConnection: close\r\n\r\n",
                        fixture.declared_length.unwrap_or(fixture.body.len())
                    ));
                    response.push_str(&fixture.body);
                    let write_result = stream.write_all(response.as_bytes()).await;
                    if !fixture.allow_early_close {
                        write_result.expect("write response");
                    }
                }
            }
            captures
        });
        (base_url, task)
    }

    async fn write_json_response(
        stream: &mut tokio::net::TcpStream,
        body: &str,
    ) -> std::io::Result<()> {
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(), body
        );
        stream.write_all(response.as_bytes()).await
    }

    async fn delayed_device_server() -> (
        String,
        std::sync::Arc<tokio::sync::Notify>,
        std::sync::Arc<tokio::sync::Notify>,
        tokio::task::JoinHandle<()>,
    ) {
        let listener = TcpListener::bind(("127.0.0.1", 0))
            .await
            .expect("bind delayed device server");
        let base_url = format!("http://{}", listener.local_addr().expect("server address"));
        let first_blocked = std::sync::Arc::new(tokio::sync::Notify::new());
        let first_blocked_for_task = first_blocked.clone();
        let release_first = std::sync::Arc::new(tokio::sync::Notify::new());
        let release_first_for_task = release_first.clone();
        let task = tokio::spawn(async move {
            let (mut first, _) = listener.accept().await.expect("accept first request");
            let expected = RequestExpectations {
                client_id: Some("Iv23example"),
                ..RequestExpectations::default()
            };
            let first_capture = read_safe_request(&mut first, &expected).await;
            assert!(first_capture.has_expected_client_id);
            first_blocked_for_task.notify_one();

            let (mut second, _) = listener.accept().await.expect("accept second request");
            let second_capture = read_safe_request(&mut second, &expected).await;
            assert!(second_capture.has_expected_client_id);
            write_json_response(
                &mut second,
                r#"{"device_code":"new-device","user_code":"NEW-CODE","verification_uri":"https://github.com/login/device","expires_in":900,"interval":5}"#,
            )
            .await
            .expect("write second response");
            release_first_for_task.notified().await;
            write_json_response(
                &mut first,
                r#"{"device_code":"old-device","user_code":"OLD-CODE","verification_uri":"https://github.com/login/device","expires_in":900,"interval":5}"#,
            )
            .await
            .expect("write first response");
        });
        (base_url, first_blocked, release_first, task)
    }

    #[tokio::test]
    async fn a_delayed_first_start_cannot_replace_a_faster_second_start() {
        let (base_url, first_blocked, release_first, server) = delayed_device_server().await;
        let client = GitHubAuthClient::for_test(&base_url).expect("test client");
        let flow = std::sync::Arc::new(GitHubConnectFlow::default());

        let first_flow = flow.clone();
        let first_client = client.clone();
        let first =
            tokio::spawn(async move { first_flow.start(&first_client, "Iv23example").await });
        first_blocked.notified().await;
        let second_flow = flow.clone();
        let second = tokio::spawn(async move { second_flow.start(&client, "Iv23example").await });

        assert_eq!(
            second
                .await
                .expect("second task")
                .expect("new prompt")
                .user_code,
            "NEW-CODE"
        );
        assert_eq!(
            tokio::time::timeout(Duration::from_millis(200), first)
                .await
                .expect("replacement must cancel the blocked first request")
                .expect("first task")
                .expect_err("older start must be canceled")
                .code,
            "github_connect_canceled"
        );
        assert_eq!(flow.active_attempt_id().await, Some(2));
        release_first.notify_one();
        server.await.expect("delayed server");
    }

    #[tokio::test]
    async fn explicit_cancellation_interrupts_a_blocked_device_start_immediately() {
        let reached = std::sync::Arc::new(tokio::sync::Notify::new());
        let resume = std::sync::Arc::new(tokio::sync::Notify::new());
        let fixture = ResponseFixture::json(
            200,
            r#"{"device_code":"device-secret","user_code":"ABCD-EFGH","verification_uri":"https://github.com/login/device","expires_in":900,"interval":5}"#,
        )
        .blocked(reached.clone(), resume.clone());
        let (base_url, server) = scripted_server(vec![(
            fixture,
            RequestExpectations {
                client_id: Some("Iv23example"),
                ..RequestExpectations::default()
            },
        )])
        .await;
        let client = GitHubAuthClient::for_test(&base_url).expect("test client");
        let flow = std::sync::Arc::new(GitHubConnectFlow::default());
        let starting_flow = flow.clone();
        let starting_client = client.clone();
        let start =
            tokio::spawn(async move { starting_flow.start(&starting_client, "Iv23example").await });

        reached.notified().await;
        flow.cancel().await.expect("cancel flow");
        let error = tokio::time::timeout(Duration::from_millis(200), start)
            .await
            .expect("cancellation must not wait for the device endpoint")
            .expect("start task")
            .expect_err("canceled start");
        assert_eq!(error.code, "github_connect_canceled");
        assert_eq!(flow.active_attempt_id().await, None);

        resume.notify_one();
        server.await.expect("blocked device server");
    }

    #[tokio::test]
    async fn explicit_cancellation_interrupts_a_sleeping_poll_immediately() {
        let (base_url, server) = scripted_server(vec![(
            ResponseFixture::json(
                200,
                r#"{"device_code":"device-secret","user_code":"ABCD-EFGH","verification_uri":"https://github.com/login/device","expires_in":900,"interval":60}"#,
            ),
            RequestExpectations {
                client_id: Some("Iv23example"),
                ..RequestExpectations::default()
            },
        )])
        .await;
        let client = GitHubAuthClient::for_test(&base_url).expect("test client");
        let flow = std::sync::Arc::new(GitHubConnectFlow::default());
        flow.start(&client, "Iv23example")
            .await
            .expect("device prompt");
        server.await.expect("device server");

        let waiting_flow = flow.clone();
        let waiting_client = client.clone();
        let wait =
            tokio::spawn(async move { waiting_flow.wait(&waiting_client, "Iv23example").await });
        tokio::time::sleep(Duration::from_millis(20)).await;
        flow.cancel().await.expect("cancel flow");
        let error = tokio::time::timeout(Duration::from_millis(200), wait)
            .await
            .expect("cancellation must not wait for poll interval")
            .expect("wait task")
            .expect_err("canceled wait");
        assert_eq!(error.code, "github_connect_canceled");
        assert_eq!(flow.active_attempt_id().await, None);
    }

    #[tokio::test]
    async fn failed_device_start_clears_the_active_attempt_marker() {
        let client = GitHubAuthClient::for_test("http://127.0.0.1:9").expect("test client");
        let flow = GitHubConnectFlow::default();

        assert_eq!(
            flow.start(&client, "Iv23example")
                .await
                .expect_err("unreachable device endpoint")
                .code,
            "github_token_exchange_failed"
        );
        assert_eq!(flow.active_attempt_id().await, None);
    }

    #[tokio::test]
    async fn denial_returns_no_authorized_attempt() {
        let (base_url, server) = scripted_server(vec![
            (
                ResponseFixture::json(
                    200,
                    r#"{"device_code":"device-secret","user_code":"ABCD-EFGH","verification_uri":"https://github.com/login/device","expires_in":30,"interval":1}"#,
                ),
                RequestExpectations {
                    client_id: Some("Iv23example"),
                    ..RequestExpectations::default()
                },
            ),
            (
                ResponseFixture::json(200, r#"{"error":"access_denied"}"#),
                RequestExpectations {
                    client_id: Some("Iv23example"),
                    device_code: Some("device-secret"),
                    grant_type: Some("urn:ietf:params:oauth:grant-type:device_code"),
                    ..RequestExpectations::default()
                },
            ),
        ])
        .await;
        let client = GitHubAuthClient::for_test(&base_url).expect("test client");
        let flow = GitHubConnectFlow::default();
        flow.start(&client, "Iv23example")
            .await
            .expect("device prompt");
        let error = flow
            .wait(&client, "Iv23example")
            .await
            .expect_err("denied flow");
        assert_eq!(error.code, "github_connect_denied");
        server.await.expect("denial server");
    }

    #[tokio::test]
    async fn local_expiry_returns_no_authorized_attempt_or_poll_request() {
        let (base_url, server) = scripted_server(vec![(
            ResponseFixture::json(
                200,
                r#"{"device_code":"device-secret","user_code":"ABCD-EFGH","verification_uri":"https://github.com/login/device","expires_in":1,"interval":2}"#,
            ),
            RequestExpectations {
                client_id: Some("Iv23example"),
                ..RequestExpectations::default()
            },
        )])
        .await;
        let client = GitHubAuthClient::for_test(&base_url).expect("test client");
        let flow = GitHubConnectFlow::default();
        flow.start(&client, "Iv23example")
            .await
            .expect("device prompt");
        server.await.expect("device server");
        let error = flow
            .wait(&client, "Iv23example")
            .await
            .expect_err("expired flow");
        assert_eq!(error.code, "github_connect_expired");
    }

    async fn capture_device_request(
        listener: TcpListener,
        expected_client_id: &'static str,
    ) -> CapturedRequest {
        let (mut stream, _) = listener.accept().await.expect("accept request");
        let mut bytes = Vec::new();
        let mut buffer = [0_u8; 1024];
        loop {
            let read = stream.read(&mut buffer).await.expect("read request");
            bytes.extend_from_slice(&buffer[..read]);
            let Some(header_end) = bytes.windows(4).position(|window| window == b"\r\n\r\n") else {
                continue;
            };
            let headers = String::from_utf8_lossy(&bytes[..header_end]);
            let content_length = headers
                .lines()
                .find_map(|line| {
                    let (name, value) = line.split_once(':')?;
                    name.eq_ignore_ascii_case("content-length")
                        .then(|| value.trim().parse::<usize>().ok())
                        .flatten()
                })
                .unwrap_or(0);
            if bytes.len() >= header_end + 4 + content_length {
                break;
            }
        }

        let header_end = bytes
            .windows(4)
            .position(|window| window == b"\r\n\r\n")
            .expect("request headers");
        let header_text = String::from_utf8_lossy(&bytes[..header_end]);
        let mut lines = header_text.lines();
        let request_line = lines.next().expect("request line");
        let mut request_parts = request_line.split_whitespace();
        let method = request_parts.next().unwrap_or_default().to_owned();
        let path = request_parts.next().unwrap_or_default().to_owned();
        let headers = lines
            .filter_map(|line| {
                let (name, value) = line.split_once(':')?;
                (!name.eq_ignore_ascii_case("authorization"))
                    .then(|| format!("{}: {}", name.to_ascii_lowercase(), value.trim()))
            })
            .collect();
        let body = String::from_utf8_lossy(&bytes[header_end + 4..]);
        let form = body
            .split('&')
            .filter_map(|pair| pair.split_once('='))
            .collect::<Vec<_>>();
        let form_field_names = form
            .iter()
            .map(|(key, _)| (*key).to_owned())
            .collect::<BTreeSet<_>>();
        let has_expected_public_client_id = form
            .iter()
            .any(|(key, value)| *key == "client_id" && *value == expected_client_id);

        let response_body = r#"{"device_code":"fake-device-code","user_code":"ABCD-EFGH","verification_uri":"https://github.com/login/device","expires_in":900,"interval":5}"#;
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            response_body.len(),
            response_body
        );
        stream
            .write_all(response.as_bytes())
            .await
            .expect("write response");

        CapturedRequest {
            method,
            path,
            headers,
            has_expected_public_client_id,
            form_field_names,
        }
    }

    #[test]
    fn device_and_refresh_forms_never_include_a_secret() {
        let device = device_code_form("Iv23example");
        assert_eq!(device, vec![("client_id", "Iv23example".to_owned())]);

        let refresh = refresh_form("Iv23example", "refresh-value");
        assert!(refresh.iter().any(|(key, _)| *key == "client_id"));
        assert!(refresh.iter().any(|(key, _)| *key == "refresh_token"));
        assert!(refresh.iter().all(|(key, _)| *key != "client_secret"));
    }

    #[test]
    fn production_and_test_endpoint_origins_are_fixed() {
        let production = GitHubAuthClient::production().expect("production client");
        assert_eq!(production.device_code_url, DEVICE_CODE_URL);
        assert_eq!(production.access_token_url, ACCESS_TOKEN_URL);
        assert_eq!(production.api_base_url, API_BASE_URL);
        assert!(GitHubAuthClient::for_test("https://github.com").is_err());
        assert!(GitHubAuthClient::for_test("http://evil.example").is_err());
        assert!(GitHubAuthClient::for_test("http://127.0.0.1:8080/extra").is_err());
    }

    #[test]
    fn polling_errors_map_to_stable_outcomes() {
        assert!(matches!(
            classify_token_body(r#"{"error":"authorization_pending"}"#).unwrap(),
            PollOutcome::Pending
        ));
        assert!(matches!(
            classify_token_body(r#"{"error":"slow_down"}"#).unwrap(),
            PollOutcome::SlowDown
        ));
        assert_eq!(
            classify_token_body(r#"{"error":"access_denied"}"#)
                .unwrap_err()
                .code,
            "github_connect_denied"
        );
        assert_eq!(
            classify_token_body(r#"{"error":"expired_token"}"#)
                .unwrap_err()
                .code,
            "github_connect_expired"
        );
    }

    #[tokio::test]
    async fn device_code_request_is_public_client_only() {
        let listener = TcpListener::bind(("127.0.0.1", 0))
            .await
            .expect("bind local server");
        let base_url = format!("http://{}", listener.local_addr().expect("server address"));
        let server = tokio::spawn(capture_device_request(listener, "Iv23example"));

        let client = GitHubAuthClient::for_test(&base_url).expect("test client");
        let (prompt, _pending) = client
            .start_device_flow("Iv23example")
            .await
            .expect("device flow prompt");
        let request = server.await.expect("server task");

        assert_eq!(request.method, "POST");
        assert_eq!(request.path, "/login/device/code");
        assert!(request.headers.contains("accept: application/json"));
        assert!(request.has_expected_public_client_id);
        assert_eq!(
            request.form_field_names,
            BTreeSet::from(["client_id".into()])
        );
        assert_eq!(prompt.user_code, "ABCD-EFGH");
        assert_eq!(prompt.verification_uri, "https://github.com/login/device");
    }

    fn pending_device() -> PendingDeviceCode {
        PendingDeviceCode {
            device_code: "fake-device-secret".into(),
            interval_seconds: 5,
            expires_at_unix: now_unix() + 900,
        }
    }

    #[tokio::test]
    async fn poll_success_requires_rotating_tokens_and_expiries() {
        let body = r#"{"access_token":"fake-access-token","expires_in":28800,"refresh_token":"fake-refresh-token","refresh_token_expires_in":15811200,"token_type":"bearer"}"#;
        let (base_url, server) = scripted_server(vec![(
            ResponseFixture::json(200, body),
            RequestExpectations {
                client_id: Some("Iv23example"),
                device_code: Some("fake-device-secret"),
                grant_type: Some("urn:ietf:params:oauth:grant-type:device_code"),
                ..Default::default()
            },
        )])
        .await;
        let client = GitHubAuthClient::for_test(&base_url).expect("test client");
        let before = now_unix();
        let outcome = client
            .poll_device_flow_once("Iv23example", &pending_device())
            .await
            .expect("successful poll");
        let PollOutcome::Authorized(grant) = outcome else {
            panic!("expected authorized poll outcome");
        };
        assert!(grant.access_token == "fake-access-token");
        assert!(grant.refresh_token == "fake-refresh-token");
        assert!(grant.expires_at_unix >= before + 28_800);
        assert!(grant.refresh_token_expires_at_unix >= before + 15_811_200);

        let captures = server.await.expect("server task");
        assert_eq!(captures[0].method, "POST");
        assert_eq!(captures[0].path, "/login/oauth/access_token");
        assert!(captures[0].headers.contains("accept: application/json"));
        assert!(captures[0].has_expected_client_id);
        assert!(captures[0].has_expected_device_code);
        assert!(captures[0].has_expected_grant_type);
        assert_eq!(
            captures[0].form_field_names,
            BTreeSet::from([
                "client_id".into(),
                "device_code".into(),
                "grant_type".into()
            ])
        );
    }

    #[tokio::test]
    async fn slow_down_is_a_stable_non_failure_poll_outcome() {
        let (base_url, server) = scripted_server(vec![(
            ResponseFixture::json(200, r#"{"error":"slow_down"}"#),
            RequestExpectations {
                client_id: Some("Iv23example"),
                device_code: Some("fake-device-secret"),
                grant_type: Some("urn:ietf:params:oauth:grant-type:device_code"),
                ..Default::default()
            },
        )])
        .await;
        let client = GitHubAuthClient::for_test(&base_url).expect("test client");
        let outcome = client
            .poll_device_flow_once("Iv23example", &pending_device())
            .await
            .expect("slow down outcome");
        assert_eq!(outcome.test_classification(), "github_connect_slow_down");
        server.await.expect("server task");
    }

    #[tokio::test]
    async fn malformed_token_success_is_sanitized() {
        let (base_url, server) = scripted_server(vec![(
            ResponseFixture::json(
                200,
                r#"{"access_token":"partial-fake-token","expires_in":28800}"#,
            ),
            RequestExpectations::default(),
        )])
        .await;
        let client = GitHubAuthClient::for_test(&base_url).expect("test client");
        let error = client
            .poll_device_flow_once("Iv23example", &pending_device())
            .await
            .expect_err("malformed token response");
        assert_eq!(error.code, "github_token_exchange_failed");
        assert!(!error.message.contains("partial-fake-token"));
        server.await.expect("server task");
    }

    #[tokio::test]
    async fn refresh_rotates_both_tokens_without_a_client_secret() {
        let body = r#"{"access_token":"rotated-access","expires_in":28800,"refresh_token":"rotated-refresh","refresh_token_expires_in":15811200}"#;
        let (base_url, server) = scripted_server(vec![(
            ResponseFixture::json(200, body),
            RequestExpectations {
                client_id: Some("Iv23example"),
                refresh_token: Some("old-fake-refresh"),
                grant_type: Some("refresh_token"),
                ..Default::default()
            },
        )])
        .await;
        let client = GitHubAuthClient::for_test(&base_url).expect("test client");
        let outcome = client
            .refresh_tokens("Iv23example", "old-fake-refresh")
            .await
            .expect("refresh response");
        assert!(matches!(outcome, RefreshOutcome::Refreshed(_)));
        let captures = server.await.expect("server task");
        assert!(captures[0].has_expected_client_id);
        assert!(captures[0].has_expected_refresh_token);
        assert!(captures[0].has_expected_grant_type);
        assert_eq!(
            captures[0].form_field_names,
            BTreeSet::from([
                "client_id".into(),
                "refresh_token".into(),
                "grant_type".into()
            ])
        );
    }

    #[tokio::test]
    async fn bad_refresh_token_is_definitive_but_other_failures_are_sanitized() {
        let (base_url, server) = scripted_server(vec![(
            ResponseFixture::json(400, r#"{"error":"bad_refresh_token"}"#),
            RequestExpectations {
                refresh_token: Some("expired-fake-refresh"),
                ..Default::default()
            },
        )])
        .await;
        let client = GitHubAuthClient::for_test(&base_url).expect("test client");
        assert!(matches!(
            client
                .refresh_tokens("Iv23example", "expired-fake-refresh")
                .await
                .expect("classified refresh"),
            RefreshOutcome::InvalidGrant
        ));
        server.await.expect("server task");

        let (base_url, server) = scripted_server(vec![(
            ResponseFixture::json(200, r#"{"error":"invalid_grant"}"#),
            RequestExpectations::default(),
        )])
        .await;
        let client = GitHubAuthClient::for_test(&base_url).expect("test client");
        assert!(matches!(
            client
                .refresh_tokens("Iv23example", "revoked-fake-refresh")
                .await
                .expect("HTTP 200 invalid grant classification"),
            RefreshOutcome::InvalidGrant
        ));
        server.await.expect("server task");

        for status in [200, 400] {
            let (base_url, server) = scripted_server(vec![(
                ResponseFixture::json(status, r#"{"error":"incorrect_client_credentials"}"#),
                RequestExpectations {
                    refresh_token: Some("revoked-live-refresh"),
                    ..RequestExpectations::default()
                },
            )])
            .await;
            let client = GitHubAuthClient::for_test(&base_url).expect("test client");

            assert!(matches!(
                client
                    .refresh_tokens("Iv23example", "revoked-live-refresh")
                    .await
                    .expect("live revocation must be definitive"),
                RefreshOutcome::InvalidGrant
            ));
            server.await.expect("server task");
        }

        let leaked = "body-must-not-leak";
        let (base_url, server) = scripted_server(vec![(
            ResponseFixture::json(500, leaked),
            RequestExpectations::default(),
        )])
        .await;
        let client = GitHubAuthClient::for_test(&base_url).expect("test client");
        let error = client
            .refresh_tokens("Iv23example", "another-fake-refresh")
            .await
            .expect_err("transient refresh failure");
        assert_eq!(error.code, "github_refresh_failed");
        assert!(!error.message.contains(leaked));
        server.await.expect("server task");

        let (base_url, server) = scripted_server(vec![(
            ResponseFixture::json(
                200,
                r#"{"access_token":"partial-fake-token","refresh_token":""}"#,
            ),
            RequestExpectations::default(),
        )])
        .await;
        let client = GitHubAuthClient::for_test(&base_url).expect("test client");
        let error = client
            .refresh_tokens("Iv23example", "another-fake-refresh")
            .await
            .expect_err("malformed refresh success");
        assert_eq!(error.code, "github_refresh_failed");
        assert!(!error.message.contains("partial-fake-token"));
        server.await.expect("server task");

        for status in [302, 401, 429, 500] {
            let (base_url, server) = scripted_server(vec![(
                ResponseFixture::json(status, r#"{"error":"incorrect_client_credentials"}"#),
                RequestExpectations::default(),
            )])
            .await;
            let client = GitHubAuthClient::for_test(&base_url).expect("test client");
            let error = client
                .refresh_tokens("Iv23example", "revoked-live-refresh")
                .await
                .expect_err("unsafe status must remain transient");
            assert_eq!(error.code, "github_refresh_failed");
            assert!(!error.message.contains("incorrect_client_credentials"));
            server.await.expect("server task");
        }
    }

    #[tokio::test]
    async fn current_user_sends_required_headers_and_filters_avatar_origin() {
        let (base_url, server) = scripted_server(vec![(
            ResponseFixture::json(
                200,
                r#"{"id":123,"login":"octocat","avatar_url":"https://evil.example/avatar.png"}"#,
            ),
            RequestExpectations {
                bearer_token: Some("fake-access-token"),
                ..Default::default()
            },
        )])
        .await;
        let client = GitHubAuthClient::for_test(&base_url).expect("test client");
        let user = client
            .current_user("fake-access-token")
            .await
            .expect("GitHub user");
        assert_eq!(user.github_user_id, "123");
        assert_eq!(user.login, "octocat");
        assert_eq!(user.avatar_url, None);
        let captures = server.await.expect("server task");
        assert_eq!(captures[0].method, "GET");
        assert_eq!(captures[0].path, "/user");
        assert!(captures[0]
            .headers
            .contains("accept: application/vnd.github+json"));
        assert!(captures[0]
            .headers
            .contains("x-github-api-version: 2026-03-10"));
        assert!(captures[0].headers.contains("user-agent: os-june/0.1"));
        assert!(captures[0].has_expected_bearer_token);
    }

    #[tokio::test]
    async fn api_statuses_map_without_exposing_provider_bodies_or_unsafe_headers() {
        let cases = [
            (
                ResponseFixture::json(401, "secret-provider-body"),
                "github_reconnect_required",
            ),
            (
                ResponseFixture::json(403, "secret-provider-body")
                    .with_header("X-GitHub-SSO", "required; url=https://evil.example/steal"),
                "github_installation_required",
            ),
            (
                ResponseFixture::json(403, "secret-provider-body")
                    .with_header("X-RateLimit-Remaining", "0")
                    .with_header("X-RateLimit-Reset", "1770000000"),
                "github_rate_limited",
            ),
            (
                ResponseFixture::json(429, "secret-provider-body").with_header("Retry-After", "17"),
                "github_rate_limited",
            ),
        ];
        for (fixture, expected_code) in cases {
            let (base_url, server) =
                scripted_server(vec![(fixture, RequestExpectations::default())]).await;
            let client = GitHubAuthClient::for_test(&base_url).expect("test client");
            let error = client
                .current_user("fake-access-token")
                .await
                .expect_err("classified API failure");
            assert_eq!(error.code, expected_code);
            assert!(!error.message.contains("secret-provider-body"));
            if expected_code == "github_rate_limited" {
                assert!(error.details.is_some());
            }
            server.await.expect("server task");
        }

        let (base_url, server) = scripted_server(vec![(
            ResponseFixture::json(403, "secret-provider-body")
                .with_header("X-RateLimit-Remaining", "1")
                .with_header("X-RateLimit-Reset", "1770000000")
                .with_header(
                    "X-GitHub-SSO",
                    "required; url=https://github.com/orgs/acme/sso?authorization_request=1",
                ),
            RequestExpectations::default(),
        )])
        .await;
        let client = GitHubAuthClient::for_test(&base_url).expect("test client");
        let error = client
            .current_user("fake-access-token")
            .await
            .expect_err("SSO requirement");
        assert_eq!(error.code, "github_installation_required");
        assert_eq!(
            error
                .details
                .as_ref()
                .and_then(|details| details.get("reason"))
                .and_then(serde_json::Value::as_str),
            Some("sso_required")
        );
        assert_eq!(
            error
                .details
                .as_ref()
                .and_then(|details| details.get("ssoUrl"))
                .and_then(serde_json::Value::as_str),
            Some("https://github.com/orgs/acme/sso?authorization_request=1")
        );
        server.await.expect("server task");
    }

    #[tokio::test]
    async fn api_transport_failures_are_distinct_from_provider_statuses() {
        let listener = TcpListener::bind(("127.0.0.1", 0))
            .await
            .expect("bind dropped-response server");
        let base_url = format!("http://{}", listener.local_addr().expect("server address"));
        let dropped = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.expect("accept dropped request");
            drop(stream);
        });
        let client = GitHubAuthClient::for_test(&base_url).expect("test client");
        let error = client
            .current_user("fake-access-token")
            .await
            .expect_err("dropped current-user response");
        assert_eq!(error.code, "github_request_failed");
        assert_ne!(error.code, "github_reconnect_required");
        dropped.await.expect("dropped-response task");

        let listener = TcpListener::bind(("127.0.0.1", 0))
            .await
            .expect("reserve unreachable address");
        let base_url = format!("http://{}", listener.local_addr().expect("server address"));
        drop(listener);
        let client = GitHubAuthClient::for_test(&base_url).expect("test client");
        let error = client
            .installations_and_repositories("fake-access-token")
            .await
            .expect_err("unreachable installation discovery");
        assert_eq!(error.code, "github_request_failed");
        assert_ne!(error.code, "github_installation_required");

        let mut truncated = ResponseFixture::json(200, r#"{"total_count":0,"installations":[]}"#);
        truncated.declared_length = Some(truncated.body.len() + 128);
        let (base_url, server) = scripted_server(vec![(
            truncated,
            RequestExpectations {
                bearer_token: Some("fake-access-token"),
                ..RequestExpectations::default()
            },
        )])
        .await;
        let client = GitHubAuthClient::for_test(&base_url).expect("test client");
        let error = client
            .installations_and_repositories("fake-access-token")
            .await
            .expect_err("truncated installation discovery");
        assert_eq!(error.code, "github_request_failed");
        assert_ne!(error.code, "github_installation_required");
        server.await.expect("server task");
    }

    #[tokio::test]
    async fn expired_device_codes_fail_without_a_provider_request() {
        let client = GitHubAuthClient::for_test("http://127.0.0.1:9").expect("test client");
        let pending = PendingDeviceCode {
            device_code: "fake-expired-device-code".into(),
            interval_seconds: 5,
            expires_at_unix: now_unix() - 1,
        };
        assert_eq!(
            client
                .poll_device_flow_once("Iv23example", &pending)
                .await
                .expect_err("expired device code")
                .code,
            "github_connect_expired"
        );
    }

    #[test]
    fn slow_down_mutates_only_the_non_secret_poll_interval() {
        let mut pending = pending_device();
        assert_eq!(pending.poll_interval(), Duration::from_secs(5));
        pending.apply_slow_down().expect("first slow down");
        pending.apply_slow_down().expect("second slow down");
        assert_eq!(pending.interval_seconds, 15);
        assert_eq!(pending.poll_interval(), Duration::from_secs(15));
        assert_eq!(connect_canceled().code, "github_connect_canceled");

        pending.interval_seconds = u64::MAX;
        assert_eq!(
            pending
                .apply_slow_down()
                .expect_err("slow-down overflow")
                .code,
            "github_token_exchange_failed"
        );
        assert_eq!(
            absolute_expiry(i64::MAX, 1)
                .expect_err("absolute expiry overflow")
                .code,
            "github_token_exchange_failed"
        );
        assert_eq!(
            absolute_expiry(0, u64::MAX)
                .expect_err("expiry conversion overflow")
                .code,
            "github_token_exchange_failed"
        );
    }

    #[tokio::test]
    async fn bounded_token_reader_returns_a_zeroizing_buffer() {
        fn assert_zeroizing_buffer(_: &Zeroizing<Vec<u8>>) {}

        let (base_url, server) = scripted_server(vec![(
            ResponseFixture::json(200, r#"{"error":"authorization_pending"}"#),
            RequestExpectations::default(),
        )])
        .await;
        let client = GitHubAuthClient::for_test(&base_url).expect("test client");
        let response = client
            .http
            .get(format!("{base_url}/bounded"))
            .send()
            .await
            .expect("fixture response");
        let body = read_response_bounded(response)
            .await
            .expect("bounded response");
        assert_zeroizing_buffer(&body);
        server.await.expect("server task");
    }

    #[test]
    fn secret_bearing_debug_output_is_redacted() {
        let prompt = GitHubDevicePrompt {
            user_code: "ABCD-EFGH".into(),
            verification_uri: GITHUB_VERIFICATION_URI.into(),
            expires_at_unix: 1,
            interval_seconds: 5,
        };
        let prompt_debug = format!("{prompt:?}");
        assert!(!prompt_debug.contains("ABCD-EFGH"));
        assert!(prompt_debug.contains("[REDACTED]"));

        let grant = GitHubTokenGrant {
            access_token: "fake-access-token".into(),
            refresh_token: "fake-refresh-token".into(),
            expires_at_unix: 10,
            refresh_token_expires_at_unix: 20,
        };
        let outcome_debug = format!("{:?}", PollOutcome::Authorized(grant));
        assert!(!outcome_debug.contains("fake-access-token"));
        assert!(!outcome_debug.contains("fake-refresh-token"));
        assert!(outcome_debug.contains("[REDACTED]"));

        let grant = GitHubTokenGrant {
            access_token: "fake-access-token".into(),
            refresh_token: "fake-refresh-token".into(),
            expires_at_unix: 10,
            refresh_token_expires_at_unix: 20,
        };
        let stored = grant.into_stored("123".into());
        assert_eq!(stored.github_user_id, "123");
        assert!(stored.access_token == "fake-access-token");
        assert!(stored.refresh_token == "fake-refresh-token");

        assert!(is_allowed_avatar_url(
            "https://avatars.githubusercontent.com/u/123?v=4"
        ));
        assert!(!is_allowed_avatar_url(
            "https://avatars.githubusercontent.com.evil.example/u/123"
        ));
    }

    fn installation_fixture(
        id: u64,
        owner: &str,
        management_url: String,
        suspended_at: Option<&str>,
    ) -> serde_json::Value {
        serde_json::json!({
            "id": id,
            "account": {"id": id + 10_000, "login": owner, "type": "Organization"},
            "html_url": management_url,
            "repository_selection": "selected",
            "permissions": {"contents": "read", "issues": "write"},
            "suspended_at": suspended_at,
        })
    }

    fn repository_fixture(id: u64, owner: &str, name: &str) -> serde_json::Value {
        serde_json::json!({
            "id": id,
            "owner": {"login": owner},
            "name": name,
            "full_name": format!("{owner}/{name}"),
            "private": true,
            "archived": false,
            "permissions": {"admin": false, "push": true, "pull": true},
        })
    }

    fn collection_body(field: &str, values: Vec<serde_json::Value>) -> String {
        let mut object = serde_json::Map::new();
        object.insert("total_count".into(), values.len().into());
        object.insert(field.into(), serde_json::Value::Array(values));
        serde_json::to_string(&object).expect("serialize fixture")
    }

    fn api_expectation() -> RequestExpectations {
        RequestExpectations {
            bearer_token: Some("fake-access-token"),
            ..Default::default()
        }
    }

    #[tokio::test]
    async fn discovery_uses_june_owned_pages_for_two_page_collections() {
        let installation_one = installation_fixture(
            101,
            "acme",
            "https://github.com/settings/installations/101".into(),
            None,
        );
        let installation_two = installation_fixture(
            202,
            "widgets",
            "https://github.com/organizations/widgets/settings/installations/202".into(),
            None,
        );
        let script = vec![
            (
                ResponseFixture::json(
                    200,
                    collection_body("installations", vec![installation_one]),
                )
                .with_header("Link", "<https://attacker.invalid/arbitrary>; rel=\"next\""),
                api_expectation(),
            ),
            (
                ResponseFixture::json(
                    200,
                    collection_body("installations", vec![installation_two]),
                ),
                api_expectation(),
            ),
            (
                ResponseFixture::json(
                    200,
                    collection_body(
                        "repositories",
                        vec![repository_fixture(1001, "acme", "one")],
                    ),
                )
                .with_header(
                    "Link",
                    "<https://attacker.invalid/repositories>; rel=\"next\"",
                ),
                api_expectation(),
            ),
            (
                ResponseFixture::json(
                    200,
                    collection_body(
                        "repositories",
                        vec![repository_fixture(1002, "acme", "two")],
                    ),
                ),
                api_expectation(),
            ),
            (
                ResponseFixture::json(
                    200,
                    collection_body(
                        "repositories",
                        vec![repository_fixture(2001, "widgets", "three")],
                    ),
                ),
                api_expectation(),
            ),
        ];
        let (base_url, server) = scripted_server(script).await;
        let client = GitHubAuthClient::for_test(&base_url).expect("test client");
        let (installations, repositories) = client
            .installations_and_repositories("fake-access-token")
            .await
            .expect("discovery");
        assert_eq!(
            installations
                .iter()
                .map(|item| item.installation_id.as_str())
                .collect::<Vec<_>>(),
            ["101", "202"]
        );
        assert_eq!(
            repositories
                .iter()
                .map(|item| (item.repository_id.as_str(), item.installation_id.as_str()))
                .collect::<Vec<_>>(),
            [("1001", "101"), ("1002", "101"), ("2001", "202")]
        );
        let captures = server.await.expect("server task");
        assert_eq!(
            captures
                .iter()
                .map(|capture| capture.path.as_str())
                .collect::<Vec<_>>(),
            [
                "/user/installations?per_page=100&page=1",
                "/user/installations?per_page=100&page=2",
                "/user/installations/101/repositories?per_page=100&page=1",
                "/user/installations/101/repositories?per_page=100&page=2",
                "/user/installations/202/repositories?per_page=100&page=1",
            ]
        );
        assert!(captures.iter().all(|capture| {
            capture.has_expected_bearer_token
                && capture
                    .headers
                    .contains("accept: application/vnd.github+json")
                && capture.headers.contains("x-github-api-version: 2026-03-10")
        }));
    }

    #[tokio::test]
    async fn exactly_one_hundred_repositories_only_paginates_with_next_link() {
        for has_next in [false, true] {
            let installation = installation_fixture(
                101,
                "acme",
                "https://github.com/settings/installations/101".into(),
                None,
            );
            let first_page = (0..100)
                .map(|index| repository_fixture(1_000 + index, "acme", &format!("repo-{index}")))
                .collect();
            let mut repository_response =
                ResponseFixture::json(200, collection_body("repositories", first_page));
            if has_next {
                repository_response = repository_response.with_header(
                    "Link",
                    "<https://api.github.com/ignored?page=999>; rel=\"next\"",
                );
            }
            let mut script = vec![
                (
                    ResponseFixture::json(
                        200,
                        collection_body("installations", vec![installation]),
                    ),
                    api_expectation(),
                ),
                (repository_response, api_expectation()),
            ];
            if has_next {
                script.push((
                    ResponseFixture::json(
                        200,
                        collection_body(
                            "repositories",
                            vec![repository_fixture(9_999, "acme", "last")],
                        ),
                    ),
                    api_expectation(),
                ));
            }
            let (base_url, server) = scripted_server(script).await;
            let client = GitHubAuthClient::for_test(&base_url).expect("test client");
            let (_, repositories) = client
                .installations_and_repositories("fake-access-token")
                .await
                .expect("discovery");
            assert_eq!(repositories.len(), if has_next { 101 } else { 100 });
            let captures = server.await.expect("server task");
            assert_eq!(captures.len(), if has_next { 3 } else { 2 });
            if has_next {
                assert_eq!(
                    captures[2].path,
                    "/user/installations/101/repositories?per_page=100&page=2"
                );
            }
        }
    }

    #[tokio::test]
    async fn invalid_verification_and_management_urls_fail_closed() {
        for verification_uri in [
            "http://github.com/login/device",
            "https://evil.example/login/device",
            "https://github.com/login/device?next=evil",
            "https://github.com/login/device#fragment",
            "https://github.com/login/device/extra",
        ] {
            let body = serde_json::json!({
                "device_code": "fake-device-code",
                "user_code": "ABCD-EFGH",
                "verification_uri": verification_uri,
                "expires_in": 900,
                "interval": 5,
            })
            .to_string();
            let (base_url, server) = scripted_server(vec![(
                ResponseFixture::json(200, body),
                RequestExpectations::default(),
            )])
            .await;
            let client = GitHubAuthClient::for_test(&base_url).expect("test client");
            let error = match client.start_device_flow("Iv23example").await {
                Ok(_) => panic!("invalid verification URL was accepted"),
                Err(error) => error,
            };
            assert_eq!(error.code, "github_token_exchange_failed");
            server.await.expect("server task");
        }

        let installation = installation_fixture(
            101,
            "acme",
            "https://evil.example/settings/installations/101".into(),
            None,
        );
        let (base_url, server) = scripted_server(vec![(
            ResponseFixture::json(200, collection_body("installations", vec![installation])),
            api_expectation(),
        )])
        .await;
        let client = GitHubAuthClient::for_test(&base_url).expect("test client");
        assert_eq!(
            client
                .installations_and_repositories("fake-access-token")
                .await
                .expect_err("invalid management URL")
                .code,
            "github_state_invalid"
        );
        server.await.expect("server task");
    }

    #[tokio::test]
    async fn missing_installation_collection_maps_to_setup_recovery() {
        let (base_url, server) = scripted_server(vec![(
            ResponseFixture::json(404, "provider-body-must-not-leak"),
            api_expectation(),
        )])
        .await;
        let client = GitHubAuthClient::for_test(&base_url).expect("test client");
        let error = client
            .installations_and_repositories("fake-access-token")
            .await
            .expect_err("missing collection");
        assert_eq!(error.code, "github_installation_required");
        assert!(!error.message.contains("provider-body-must-not-leak"));
        server.await.expect("server task");
    }

    #[tokio::test]
    async fn duplicate_installation_and_repository_ids_are_rejected() {
        let duplicate_installations = vec![
            installation_fixture(
                101,
                "acme",
                "https://github.com/settings/installations/101".into(),
                None,
            ),
            installation_fixture(
                101,
                "other",
                "https://github.com/settings/installations/101".into(),
                None,
            ),
        ];
        let (base_url, server) = scripted_server(vec![(
            ResponseFixture::json(
                200,
                collection_body("installations", duplicate_installations),
            ),
            api_expectation(),
        )])
        .await;
        let client = GitHubAuthClient::for_test(&base_url).expect("test client");
        assert_eq!(
            client
                .installations_and_repositories("fake-access-token")
                .await
                .expect_err("duplicate installations")
                .code,
            "github_state_invalid"
        );
        server.await.expect("server task");

        let installation = installation_fixture(
            101,
            "acme",
            "https://github.com/settings/installations/101".into(),
            None,
        );
        let duplicate_repositories = vec![
            repository_fixture(1001, "acme", "one"),
            repository_fixture(1001, "acme", "renamed"),
        ];
        let (base_url, server) = scripted_server(vec![
            (
                ResponseFixture::json(200, collection_body("installations", vec![installation])),
                api_expectation(),
            ),
            (
                ResponseFixture::json(200, collection_body("repositories", duplicate_repositories)),
                api_expectation(),
            ),
        ])
        .await;
        let client = GitHubAuthClient::for_test(&base_url).expect("test client");
        assert_eq!(
            client
                .installations_and_repositories("fake-access-token")
                .await
                .expect_err("duplicate repositories")
                .code,
            "github_state_invalid"
        );
        server.await.expect("server task");
    }

    #[tokio::test]
    async fn suspended_installations_are_retained_without_repository_requests() {
        let installation = installation_fixture(
            101,
            "acme",
            "https://github.com/settings/installations/101".into(),
            Some("2026-07-14T00:00:00Z"),
        );
        let (base_url, server) = scripted_server(vec![(
            ResponseFixture::json(200, collection_body("installations", vec![installation])),
            api_expectation(),
        )])
        .await;
        let client = GitHubAuthClient::for_test(&base_url).expect("test client");
        let (installations, repositories) = client
            .installations_and_repositories("fake-access-token")
            .await
            .expect("suspended snapshot");
        assert_eq!(installations.len(), 1);
        assert_eq!(
            installations[0].suspended_at.as_deref(),
            Some("2026-07-14T00:00:00Z")
        );
        assert!(repositories.is_empty());
        assert_eq!(
            ensure_installation_active(&installations[0])
                .expect_err("suspended installation")
                .code,
            "github_installation_suspended"
        );
        assert_eq!(server.await.expect("server task").len(), 1);
    }

    #[tokio::test]
    async fn typed_permission_shapes_reject_provider_type_confusion() {
        let mut installation = installation_fixture(
            101,
            "acme",
            "https://github.com/settings/installations/101".into(),
            None,
        );
        installation["permissions"] = serde_json::json!({"contents": true});
        let (base_url, server) = scripted_server(vec![(
            ResponseFixture::json(200, collection_body("installations", vec![installation])),
            api_expectation(),
        )])
        .await;
        let client = GitHubAuthClient::for_test(&base_url).expect("test client");
        assert_eq!(
            client
                .installations_and_repositories("fake-access-token")
                .await
                .expect_err("boolean installation permission")
                .code,
            "github_state_invalid"
        );
        server.await.expect("server task");

        let installation = installation_fixture(
            101,
            "acme",
            "https://github.com/settings/installations/101".into(),
            None,
        );
        let mut repository = repository_fixture(1001, "acme", "one");
        repository["permissions"] = serde_json::json!({"pull": "read"});
        let (base_url, server) = scripted_server(vec![
            (
                ResponseFixture::json(200, collection_body("installations", vec![installation])),
                api_expectation(),
            ),
            (
                ResponseFixture::json(200, collection_body("repositories", vec![repository])),
                api_expectation(),
            ),
        ])
        .await;
        let client = GitHubAuthClient::for_test(&base_url).expect("test client");
        assert_eq!(
            client
                .installations_and_repositories("fake-access-token")
                .await
                .expect_err("string repository permission")
                .code,
            "github_state_invalid"
        );
        server.await.expect("server task");
    }

    #[tokio::test]
    async fn per_response_installation_and_repository_caps_fail_before_another_request() {
        let oversized = ResponseFixture {
            status: 200,
            headers: vec![("Content-Type".into(), "application/json".into())],
            body: "{}".into(),
            declared_length: Some(MAX_RESPONSE_BYTES + 1),
            chunked: false,
            allow_early_close: true,
            block: None,
        };
        let (base_url, server) = scripted_server(vec![(oversized, api_expectation())]).await;
        let client = GitHubAuthClient::for_test(&base_url).expect("test client");
        assert_eq!(
            client
                .installations_and_repositories("fake-access-token")
                .await
                .expect_err("oversized response")
                .code,
            "github_result_limit_exceeded"
        );
        server.await.expect("server task");

        let chunked_body = format!("{{\"padding\":\"{}\"}}", "x".repeat(MAX_RESPONSE_BYTES));
        let (base_url, server) = scripted_server(vec![(
            ResponseFixture::json(200, chunked_body).chunked(),
            api_expectation(),
        )])
        .await;
        let client = GitHubAuthClient::for_test(&base_url).expect("test client");
        assert_eq!(
            client
                .installations_and_repositories("fake-access-token")
                .await
                .expect_err("chunked oversized response")
                .code,
            "github_result_limit_exceeded"
        );
        assert_eq!(server.await.expect("server task").len(), 1);

        let installations = (1..=MAX_INSTALLATIONS as u64)
            .map(|id| {
                installation_fixture(
                    id,
                    &format!("owner-{id}"),
                    format!("https://github.com/settings/installations/{id}"),
                    Some("2026-07-14T00:00:00Z"),
                )
            })
            .collect();
        let (base_url, server) = scripted_server(vec![(
            ResponseFixture::json(200, collection_body("installations", installations))
                .with_header("Link", "<https://api.github.com/page/2>; rel=\"next\""),
            api_expectation(),
        )])
        .await;
        let client = GitHubAuthClient::for_test(&base_url).expect("test client");
        assert_eq!(
            client
                .installations_and_repositories("fake-access-token")
                .await
                .expect_err("installation cap")
                .code,
            "github_result_limit_exceeded"
        );
        assert_eq!(server.await.expect("server task").len(), 1);

        let installation = installation_fixture(
            101,
            "acme",
            "https://github.com/settings/installations/101".into(),
            None,
        );
        let repositories = (0..=MAX_REPOSITORIES as u64)
            .map(|id| repository_fixture(100_000 + id, "acme", &format!("repo-{id}")))
            .collect();
        let (base_url, server) = scripted_server(vec![
            (
                ResponseFixture::json(200, collection_body("installations", vec![installation])),
                api_expectation(),
            ),
            (
                ResponseFixture::json(200, collection_body("repositories", repositories)),
                api_expectation(),
            ),
        ])
        .await;
        let client = GitHubAuthClient::for_test(&base_url).expect("test client");
        assert_eq!(
            client
                .installations_and_repositories("fake-access-token")
                .await
                .expect_err("repository cap")
                .code,
            "github_result_limit_exceeded"
        );
        server.await.expect("server task");
    }

    #[tokio::test]
    async fn aggregate_discovery_byte_cap_is_enforced_across_http_responses() {
        let installations = (1..=9_u64)
            .map(|id| {
                installation_fixture(
                    id,
                    &format!("owner-{id}"),
                    format!("https://github.com/settings/installations/{id}"),
                    None,
                )
            })
            .collect();
        let mut script = vec![(
            ResponseFixture::json(200, collection_body("installations", installations)),
            api_expectation(),
        )];
        for index in 0..9 {
            let body = serde_json::json!({
                "total_count": 0,
                "repositories": [],
                "padding": "x".repeat(3_800_000),
            })
            .to_string();
            let mut fixture = ResponseFixture::json(200, body);
            if index == 8 {
                fixture = fixture.allow_early_close();
            }
            script.push((fixture, api_expectation()));
        }
        let (base_url, server) = scripted_server(script).await;
        let client = GitHubAuthClient::for_test(&base_url).expect("test client");
        assert_eq!(
            client
                .installations_and_repositories("fake-access-token")
                .await
                .expect_err("aggregate response byte cap")
                .code,
            "github_result_limit_exceeded"
        );
        assert_eq!(server.await.expect("server task").len(), 10);
    }

    #[test]
    fn aggregate_byte_and_repository_removal_classifications_are_stable() {
        let mut budget = DiscoveryBudget::default();
        budget
            .charge_response_bytes(MAX_DISCOVERY_BYTES)
            .expect("exact byte cap");
        assert_eq!(
            budget
                .charge_response_bytes(1)
                .expect_err("aggregate byte cap")
                .code,
            "github_result_limit_exceeded"
        );

        let old = BTreeSet::from(["1".to_owned(), "2".to_owned()]);
        let new = BTreeSet::from(["2".to_owned()]);
        assert_eq!(
            classify_repository_removal(&old, &new)
                .expect_err("removed repository")
                .code,
            "github_repository_access_removed"
        );
        assert!(classify_repository_removal(&new, &old).is_ok());
    }

    #[tokio::test]
    async fn aggregate_discovery_request_cap_is_global_across_installations() {
        let installations = (1..=6_u64)
            .map(|id| {
                installation_fixture(
                    id,
                    &format!("owner-{id}"),
                    format!("https://github.com/settings/installations/{id}"),
                    None,
                )
            })
            .collect();
        let mut script = vec![(
            ResponseFixture::json(200, collection_body("installations", installations)),
            api_expectation(),
        )];
        for installation_index in 0..6 {
            let pages = if installation_index < 5 { 100 } else { 11 };
            for page in 1..=pages {
                let mut response =
                    ResponseFixture::json(200, collection_body("repositories", Vec::new()));
                if (installation_index < 5 && page < 100) || installation_index == 5 {
                    response = response.with_header(
                        "Link",
                        "<https://api.github.com/provider-controlled>; rel=\"next\"",
                    );
                }
                script.push((response, api_expectation()));
            }
        }
        assert_eq!(script.len(), MAX_DISCOVERY_REQUESTS);
        let (base_url, server) = scripted_server(script).await;
        let client = GitHubAuthClient::for_test(&base_url).expect("test client");
        assert_eq!(
            client
                .installations_and_repositories("fake-access-token")
                .await
                .expect_err("aggregate request cap")
                .code,
            "github_result_limit_exceeded"
        );
        assert_eq!(
            server.await.expect("server task").len(),
            MAX_DISCOVERY_REQUESTS
        );
    }
}
