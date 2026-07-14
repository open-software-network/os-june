use std::{
    collections::{HashMap, HashSet},
    future::Future,
    path::{Path, PathBuf},
    pin::Pin,
    sync::{Arc, Mutex},
};

use serde_json::{json, Value};

use crate::{
    domain::types::AppError,
    extension_host::{ExtensionHost, ExtensionResponse},
};

pub(crate) type TransportFuture<'a> =
    Pin<Box<dyn Future<Output = Result<TransportResponse, AppError>> + Send + 'a>>;

pub(crate) trait BrowserTransport: Send + Sync {
    /// Reserve transport-owned startup state before the broker publishes the
    /// session. Managed transports use this to make launch cancellation
    /// visible before their asynchronous startup work begins.
    fn reserve_session(&self, _session_id: &str) -> Result<(), AppError> {
        Ok(())
    }

    fn execute<'a>(&'a self, tool: &'a str, arguments: Value) -> TransportFuture<'a>;

    /// Synchronously terminate a transport-owned session. Managed transports
    /// override this so revoke and app exit kill Chromium even when another
    /// request still holds the session and is awaiting CDP.
    fn terminate_session(&self, _session_id: &str) {}
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(crate) enum BrowserTransportKind {
    Attended,
    /// Reserved for the JUN-289 transport behind this same broker dispatch.
    #[allow(dead_code)]
    Managed,
}

pub(crate) struct TransportResponse {
    data: Value,
    artifact: Option<TransportArtifact>,
}

impl TransportResponse {
    pub(crate) fn data(data: Value) -> Self {
        Self {
            data,
            artifact: None,
        }
    }

    pub(crate) fn artifact(data: Value, artifact: TransportArtifact) -> Self {
        Self {
            data,
            artifact: Some(artifact),
        }
    }
}

pub(crate) struct TransportArtifact {
    pub(crate) kind: String,
    pub(crate) mime_type: String,
    pub(crate) bytes: Vec<u8>,
}

pub(crate) struct ExtensionBrowserTransport {
    host: ExtensionHost,
}

impl ExtensionBrowserTransport {
    pub(crate) fn new(host: ExtensionHost) -> Self {
        Self { host }
    }
}

impl BrowserTransport for ExtensionBrowserTransport {
    fn execute<'a>(&'a self, tool: &'a str, arguments: Value) -> TransportFuture<'a> {
        Box::pin(async move {
            let ExtensionResponse {
                value,
                artifact_bytes,
            } = self.host.request(tool, arguments).await?;
            if value.get("success").and_then(Value::as_bool) != Some(true) {
                return Err(AppError::new(
                    value
                        .get("errorCode")
                        .and_then(Value::as_str)
                        .unwrap_or("extension_request_failed"),
                    value
                        .get("message")
                        .and_then(Value::as_str)
                        .unwrap_or("The browser extension request failed."),
                ));
            }
            let data = value.get("data").cloned().unwrap_or_else(|| json!({}));
            let artifact = match data.get("artifact") {
                Some(metadata) => Some(TransportArtifact {
                    kind: metadata
                        .get("kind")
                        .and_then(Value::as_str)
                        .ok_or_else(|| {
                            AppError::new(
                                "extension_artifact_invalid",
                                "The extension returned invalid artifact metadata.",
                            )
                        })?
                        .to_string(),
                    mime_type: metadata
                        .get("mimeType")
                        .and_then(Value::as_str)
                        .ok_or_else(|| {
                            AppError::new(
                                "extension_artifact_invalid",
                                "The extension returned invalid artifact metadata.",
                            )
                        })?
                        .to_string(),
                    bytes: artifact_bytes.ok_or_else(|| {
                        AppError::new(
                            "extension_artifact_invalid",
                            "The extension returned artifact metadata without artifact bytes.",
                        )
                    })?,
                }),
                None => {
                    if artifact_bytes.is_some() {
                        return Err(AppError::new(
                            "extension_artifact_invalid",
                            "The extension returned artifact bytes without metadata.",
                        ));
                    }
                    None
                }
            };
            Ok(TransportResponse { data, artifact })
        })
    }
}

pub(crate) struct BrowserBroker {
    state: Mutex<BrowserBrokerState>,
    transition_lock: tokio::sync::Mutex<()>,
}

impl Default for BrowserBroker {
    fn default() -> Self {
        Self {
            state: Mutex::new(BrowserBrokerState::default()),
            transition_lock: tokio::sync::Mutex::new(()),
        }
    }
}

#[derive(Default)]
struct BrowserBrokerState {
    access_flag_path: Option<PathBuf>,
    transition_blocked: bool,
    sessions: HashMap<String, BrowserSession>,
    transports: HashMap<BrowserTransportKind, Arc<dyn BrowserTransport>>,
    screenshot_root: Option<PathBuf>,
    artifact_root: Option<PathBuf>,
}

struct BrowserSession {
    transport_kind: BrowserTransportKind,
    tabs: HashSet<i64>,
}

impl Default for BrowserSession {
    fn default() -> Self {
        Self {
            transport_kind: BrowserTransportKind::Attended,
            tabs: HashSet::new(),
        }
    }
}

impl BrowserBroker {
    fn lock(&self) -> std::sync::MutexGuard<'_, BrowserBrokerState> {
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    pub(crate) fn configure_transport(
        &self,
        kind: BrowserTransportKind,
        transport: Arc<dyn BrowserTransport>,
        screenshot_root: PathBuf,
        artifact_root: PathBuf,
    ) {
        let mut state = self.lock();
        state.transports.entry(kind).or_insert(transport);
        state.screenshot_root = Some(screenshot_root);
        state.artifact_root = Some(artifact_root);
    }

    pub(crate) fn set_access_flag_path(&self, path: PathBuf) {
        self.lock().access_flag_path = Some(path);
    }

    pub(crate) async fn lock_transition(&self) -> tokio::sync::MutexGuard<'_, ()> {
        self.transition_lock.lock().await
    }

    pub(crate) async fn set_enabled(&self, enabled: bool) -> Result<(), AppError> {
        let (transports, sessions) = {
            let mut state = self.lock();
            state.transition_blocked = !enabled;
            if enabled {
                return Ok(());
            }
            let transports = state.transports.clone();
            let sessions = state
                .sessions
                .drain()
                .map(|(id, session)| (id.clone(), session.transport_kind))
                .collect::<Vec<_>>();
            (transports, sessions)
        };
        // Kill managed Chromium processes before awaiting any graceful close.
        // This interrupts in-flight CDP commands instead of waiting for them
        // to finish through a revoked grant.
        for (session_id, kind) in &sessions {
            if let Some(transport) = transports.get(kind) {
                transport.terminate_session(session_id);
            }
        }
        let mut first_error = None;
        for (session_id, kind) in &sessions {
            if let Some(transport) = transports.get(kind).cloned() {
                if let Err(error) = transport
                    .execute("close_session", json!({ "session_id": session_id }))
                    .await
                {
                    first_error.get_or_insert(error);
                }
            }
        }
        if let Some(error) = first_error {
            tracing::warn!(
                code = %error.code,
                "browser session teardown failed during access revocation"
            );
        }
        // Revocation must remain durable even if Chrome disappeared before it
        // acknowledged detach. The broker gate is already closed and the
        // caller must still remove the persisted grant and rotate credentials.
        Ok(())
    }

    /// App-exit backstop. Managed transports terminate synchronously so no
    /// in-flight request can keep Chromium or its ephemeral profile alive.
    pub(crate) fn terminate_sessions(&self) {
        let (transports, sessions) = {
            let mut state = self.lock();
            state.transition_blocked = true;
            let transports = state.transports.clone();
            let sessions = state
                .sessions
                .drain()
                .map(|(id, session)| (id, session.transport_kind))
                .collect::<Vec<_>>();
            (transports, sessions)
        };
        for (session_id, kind) in sessions {
            if let Some(transport) = transports.get(&kind) {
                transport.terminate_session(&session_id);
            }
        }
    }

    pub(crate) fn is_enabled(&self) -> bool {
        let state = self.lock();
        !state.transition_blocked
            && state
                .access_flag_path
                .as_ref()
                .is_some_and(|path| path.exists())
    }

    pub(crate) fn active_session_count(&self) -> usize {
        self.lock().sessions.len()
    }

    fn require_enabled(&self) -> Result<(), AppError> {
        if self.is_enabled() {
            Ok(())
        } else {
            Err(AppError::new(
                "browser_access_disabled",
                "Browser use is not enabled.",
            ))
        }
    }

    fn transport(&self, kind: BrowserTransportKind) -> Result<Arc<dyn BrowserTransport>, AppError> {
        self.lock().transports.get(&kind).cloned().ok_or_else(|| {
            AppError::new(
                "browser_transport_unavailable",
                "The selected browser transport is unavailable.",
            )
        })
    }

    pub(crate) async fn execute(
        &self,
        kind: BrowserTransportKind,
        tool: &str,
        mut arguments: Value,
    ) -> Result<Value, AppError> {
        self.require_enabled()?;
        if !matches!(
            tool,
            "start_session"
                | "close_session"
                | "navigate"
                | "snapshot"
                | "screenshot"
                | "list_tabs"
                | "open_tab"
                | "switch_tab"
                | "close_tab"
                | "click"
                | "fill"
                | "press"
                | "back"
                | "accept_shared_tab"
        ) {
            return Err(AppError::new(
                "unknown_browser_tool",
                "Unknown browser tool.",
            ));
        }
        match kind {
            BrowserTransportKind::Attended
                if matches!(
                    tool,
                    "click" | "fill" | "press" | "back" | "accept_shared_tab"
                ) =>
            {
                return Err(AppError::new(
                    "not_implemented",
                    format!("The {tool} browser tool is not implemented yet."),
                ));
            }
            BrowserTransportKind::Managed
                if !matches!(
                    tool,
                    "start_session"
                        | "close_session"
                        | "navigate"
                        | "back"
                        | "snapshot"
                        | "screenshot"
                        | "click"
                        | "fill"
                        | "press"
                ) =>
            {
                return Err(AppError::new(
                    "browser_tool_unavailable",
                    format!("The {tool} browser tool is unavailable on managed sessions."),
                ));
            }
            _ => {}
        }

        let transport = self.transport(kind)?;
        if tool == "start_session" {
            let session_id = uuid::Uuid::new_v4().to_string();
            arguments = json!({ "session_id": &session_id });
            let inserted = {
                transport.reserve_session(&session_id)?;
                let mut state = self.lock();
                let enabled = !state.transition_blocked
                    && state
                        .access_flag_path
                        .as_ref()
                        .is_some_and(|path| path.exists());
                if enabled {
                    state.sessions.insert(
                        session_id.clone(),
                        BrowserSession {
                            transport_kind: kind,
                            tabs: HashSet::new(),
                        },
                    );
                }
                enabled
            };
            if !inserted {
                transport.terminate_session(&session_id);
                let _ = transport
                    .execute("close_session", json!({ "session_id": &session_id }))
                    .await;
                return Err(AppError::new(
                    "browser_access_disabled",
                    "Browser use is not enabled.",
                ));
            }

            if let Err(error) = transport.execute(tool, arguments).await {
                self.lock().sessions.remove(&session_id);
                transport.terminate_session(&session_id);
                return Err(error);
            }
            let still_owned = {
                let state = self.lock();
                !state.transition_blocked
                    && state
                        .sessions
                        .get(&session_id)
                        .is_some_and(|session| session.transport_kind == kind)
            };
            if !still_owned {
                transport.terminate_session(&session_id);
                let _ = transport
                    .execute("close_session", json!({ "session_id": &session_id }))
                    .await;
                return Err(AppError::new(
                    "browser_access_disabled",
                    "Browser use is not enabled.",
                ));
            }
            return Ok(json!({ "sessionId": session_id }));
        }

        let session_id = required_string(&arguments, "session_id")?.to_string();
        {
            let state = self.lock();
            if !state
                .sessions
                .get(&session_id)
                .is_some_and(|session| session.transport_kind == kind)
            {
                return Err(AppError::new(
                    "browser_session_not_found",
                    "Browser session was not found.",
                ));
            }
        }

        if tool == "close_session" {
            transport.execute(tool, arguments).await?;
            self.lock().sessions.remove(&session_id);
            return Ok(json!({ "closed": true }));
        }

        if tool == "navigate" && kind == BrowserTransportKind::Attended {
            validate_attended_url(required_string(&arguments, "url")?)?;
        }

        // Managed sessions have one page and no task-tab surface. Their
        // navigate path deliberately bypasses the attended URL check: the
        // transport enforces the stricter resolve-validate-pin policy instead.
        if kind == BrowserTransportKind::Managed {
            return self.finish_response(transport.execute(tool, arguments).await?);
        }

        if tool == "open_tab" {
            let response = transport.execute(tool, arguments.clone()).await?;
            let tab_id = response
                .data
                .get("tabId")
                .and_then(Value::as_i64)
                .ok_or_else(|| {
                    AppError::new(
                        "extension_response_invalid",
                        "The extension returned no tab id.",
                    )
                })?;
            let accepted = {
                let mut state = self.lock();
                let collision = state
                    .sessions
                    .values()
                    .any(|session| session.tabs.contains(&tab_id));
                if collision {
                    false
                } else if let Some(session) = state.sessions.get_mut(&session_id) {
                    session.tabs.insert(tab_id);
                    true
                } else {
                    false
                }
            };
            if !accepted {
                let _ = transport
                    .execute(
                        "close_tab",
                        json!({ "session_id": session_id, "tab_id": tab_id }),
                    )
                    .await;
                return Err(AppError::new(
                    "extension_tab_collision",
                    "The extension returned a tab id that cannot be owned by this session.",
                ));
            }
            return Ok(response.data);
        }

        if tool != "list_tabs" {
            let tab_id = arguments
                .get("tab_id")
                .and_then(Value::as_i64)
                .ok_or_else(|| AppError::new("invalid_arguments", "tab_id is required."))?;
            let owned = self
                .lock()
                .sessions
                .get(&session_id)
                .is_some_and(|session| session.tabs.contains(&tab_id));
            if !owned {
                return Err(AppError::new(
                    "tab_not_owned",
                    "The tab is not owned by this Browser use session.",
                ));
            }
        }

        let mut response = transport.execute(tool, arguments.clone()).await?;
        if tool == "list_tabs" {
            let owned = self
                .lock()
                .sessions
                .get(&session_id)
                .map(|session| session.tabs.clone())
                .unwrap_or_default();
            let tabs = response
                .data
                .get_mut("tabs")
                .and_then(Value::as_array_mut)
                .ok_or_else(|| {
                    AppError::new(
                        "extension_response_invalid",
                        "The extension returned an invalid task tab list.",
                    )
                })?;
            tabs.retain(|tab| {
                tab.get("tabId")
                    .and_then(Value::as_i64)
                    .is_some_and(|tab_id| owned.contains(&tab_id))
            });
            let active_is_owned = response
                .data
                .get("activeTabId")
                .and_then(Value::as_i64)
                .is_some_and(|tab_id| owned.contains(&tab_id));
            if !active_is_owned {
                if let Some(data) = response.data.as_object_mut() {
                    data.remove("activeTabId");
                }
            }
        }
        if tool == "close_tab" {
            let tab_id = arguments["tab_id"].as_i64().unwrap_or_default();
            if let Some(session) = self.lock().sessions.get_mut(&session_id) {
                session.tabs.remove(&tab_id);
            }
        }
        self.finish_response(response)
    }

    fn finish_response(&self, mut response: TransportResponse) -> Result<Value, AppError> {
        if let Some(artifact) = response.artifact.take() {
            let stored = self.store_artifact(artifact)?;
            let data = response.data.as_object_mut().ok_or_else(|| {
                AppError::new(
                    "browser_transport_invalid",
                    "The browser transport returned invalid response data.",
                )
            })?;
            let stored = stored.as_object().ok_or_else(|| {
                AppError::new(
                    "browser_artifact_unavailable",
                    "Browser artifact storage returned invalid response data.",
                )
            })?;
            data.extend(stored.clone());
        }
        Ok(response.data)
    }

    fn store_artifact(&self, artifact: TransportArtifact) -> Result<Value, AppError> {
        let state = self.lock();
        let (root, extension, media) = match (artifact.kind.as_str(), artifact.mime_type.as_str()) {
            ("screenshot", "image/png") => (state.screenshot_root.as_ref(), "png", true),
            ("snapshot", "application/json") => (state.artifact_root.as_ref(), "json", false),
            _ => {
                return Err(AppError::new(
                    "extension_artifact_invalid",
                    "The browser extension returned an unsupported artifact.",
                ))
            }
        };
        let root = root.ok_or_else(|| {
            AppError::new(
                "browser_artifact_unavailable",
                "Browser artifact storage is unavailable.",
            )
        })?;
        let filename = format!(
            "browser-{}-{}.{}",
            artifact.kind,
            uuid::Uuid::new_v4().simple(),
            extension
        );
        atomic_write(root, &filename, &artifact.bytes)?;
        if media {
            Ok(json!({ "fileReference": filename, "media": format!("MEDIA:{filename}") }))
        } else {
            Ok(json!({ "fileReference": root.join(&filename).to_string_lossy() }))
        }
    }

    #[cfg(test)]
    pub(crate) fn insert_test_session(&self, id: &str) {
        self.lock()
            .sessions
            .insert(id.to_string(), BrowserSession::default());
    }
}

fn validate_attended_url(raw: &str) -> Result<(), AppError> {
    let url = reqwest::Url::parse(raw)
        .map_err(|_| AppError::new("browser_url_invalid", "The browser URL is invalid."))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(AppError::new(
            "browser_url_not_allowed",
            "Browser use can navigate only to HTTP or HTTPS URLs.",
        ));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(AppError::new(
            "browser_url_not_allowed",
            "Browser URLs cannot contain credentials.",
        ));
    }
    Ok(())
}

fn required_string<'a>(arguments: &'a Value, name: &str) -> Result<&'a str, AppError> {
    arguments
        .get(name)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| AppError::new("invalid_arguments", format!("{name} is required.")))
}

fn atomic_write(root: &Path, filename: &str, bytes: &[u8]) -> Result<(), AppError> {
    std::fs::create_dir_all(root)
        .map_err(|error| AppError::new("browser_artifact_write_failed", error.to_string()))?;
    let path = root.join(filename);
    let temporary = root.join(format!(".{filename}.tmp"));
    std::fs::write(&temporary, bytes)
        .map_err(|error| AppError::new("browser_artifact_write_failed", error.to_string()))?;
    std::fs::rename(&temporary, &path)
        .map_err(|error| AppError::new("browser_artifact_write_failed", error.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    struct BlockingTransport {
        entered: Arc<tokio::sync::Notify>,
        release: Arc<tokio::sync::Notify>,
        terminated: Arc<std::sync::atomic::AtomicBool>,
    }

    impl BrowserTransport for BlockingTransport {
        fn execute<'a>(&'a self, tool: &'a str, _arguments: Value) -> TransportFuture<'a> {
            let entered = Arc::clone(&self.entered);
            let release = Arc::clone(&self.release);
            let terminated = Arc::clone(&self.terminated);
            Box::pin(async move {
                if tool == "snapshot" {
                    entered.notify_one();
                    release.notified().await;
                    if terminated.load(std::sync::atomic::Ordering::SeqCst) {
                        return Err(AppError::new(
                            "browser_session_closed",
                            "The managed browser session was terminated.",
                        ));
                    }
                }
                let data = match tool {
                    "open_tab" => json!({ "tabId": 7 }),
                    "list_tabs" => json!({ "tabs": [] }),
                    _ => json!({}),
                };
                Ok(TransportResponse {
                    data,
                    artifact: None,
                })
            })
        }

        fn terminate_session(&self, _session_id: &str) {
            self.terminated
                .store(true, std::sync::atomic::Ordering::SeqCst);
            self.release.notify_waiters();
        }
    }

    struct FailingCloseTransport;

    impl BrowserTransport for FailingCloseTransport {
        fn execute<'a>(&'a self, tool: &'a str, _arguments: Value) -> TransportFuture<'a> {
            Box::pin(async move {
                if tool == "close_session" {
                    return Err(AppError::new(
                        "extension_disconnected",
                        "The browser extension disconnected.",
                    ));
                }
                Ok(TransportResponse {
                    data: json!({}),
                    artifact: None,
                })
            })
        }
    }

    #[cfg(unix)]
    struct StartingProcessState {
        entered: tokio::sync::Notify,
        release: tokio::sync::Notify,
        child: Mutex<Option<std::process::Child>>,
        profile: PathBuf,
        terminated: std::sync::atomic::AtomicBool,
        finished: std::sync::atomic::AtomicBool,
        finished_notify: tokio::sync::Notify,
    }

    #[cfg(unix)]
    struct StartingProcessTransport {
        state: Arc<StartingProcessState>,
    }

    #[cfg(unix)]
    impl StartingProcessTransport {
        fn terminate(state: &StartingProcessState) {
            state
                .terminated
                .store(true, std::sync::atomic::Ordering::SeqCst);
            if let Some(mut child) = state
                .child
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .take()
            {
                let _ = child.kill();
                let _ = child.wait();
            }
            let _ = std::fs::remove_dir_all(&state.profile);
            state.release.notify_waiters();
        }
    }

    #[cfg(unix)]
    impl BrowserTransport for StartingProcessTransport {
        fn execute<'a>(&'a self, tool: &'a str, _arguments: Value) -> TransportFuture<'a> {
            let state = Arc::clone(&self.state);
            Box::pin(async move {
                if tool == "start_session" {
                    std::fs::create_dir_all(&state.profile).expect("starting profile");
                    let child = std::process::Command::new("/bin/sleep")
                        .arg("30")
                        .stdin(std::process::Stdio::null())
                        .stdout(std::process::Stdio::null())
                        .stderr(std::process::Stdio::null())
                        .spawn()
                        .expect("starting browser stand-in");
                    *state
                        .child
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(child);
                    state.entered.notify_one();
                    state.release.notified().await;
                    state
                        .finished
                        .store(true, std::sync::atomic::Ordering::SeqCst);
                    state.finished_notify.notify_waiters();
                    if state.terminated.load(std::sync::atomic::Ordering::SeqCst) {
                        return Err(AppError::new(
                            "browser_session_closed",
                            "The managed browser session was terminated.",
                        ));
                    }
                } else if tool == "close_session" {
                    while !state.finished.load(std::sync::atomic::Ordering::SeqCst) {
                        let notified = state.finished_notify.notified();
                        if state.finished.load(std::sync::atomic::Ordering::SeqCst) {
                            break;
                        }
                        notified.await;
                    }
                }
                Ok(TransportResponse::data(json!({})))
            })
        }

        fn terminate_session(&self, _session_id: &str) {
            Self::terminate(&self.state);
        }
    }

    #[test]
    fn artifact_names_are_broker_minted_and_path_safe() {
        let temp = tempfile::tempdir().expect("tempdir");
        let broker = BrowserBroker::default();
        broker.configure_transport(
            BrowserTransportKind::Attended,
            Arc::new(UnavailableTransport),
            temp.path().join("images"),
            temp.path().join("artifacts"),
        );
        let result = broker
            .store_artifact(TransportArtifact {
                kind: "screenshot".into(),
                mime_type: "image/png".into(),
                bytes: b"png".to_vec(),
            })
            .expect("store");
        let reference = result["fileReference"].as_str().expect("reference");
        assert!(reference.starts_with("browser-screenshot-"));
        assert!(!reference.contains('/'));
        assert!(temp.path().join("images").join(reference).is_file());
    }

    #[test]
    fn attended_url_policy_accepts_web_urls_and_rejects_credentials_and_other_schemes() {
        assert!(validate_attended_url("https://example.com/path?q=1").is_ok());
        assert!(validate_attended_url("http://127.0.0.1/private").is_ok());
        assert_eq!(
            validate_attended_url("file:///tmp/private")
                .expect_err("scheme")
                .code,
            "browser_url_not_allowed"
        );
        assert_eq!(
            validate_attended_url("https://user:secret@example.com")
                .expect_err("credentials")
                .code,
            "browser_url_not_allowed"
        );
    }

    #[tokio::test]
    async fn broker_owns_session_and_tab_lifecycle_and_filters_extension_lists() {
        let temp = tempfile::tempdir().expect("tempdir");
        let flag = temp.path().join("browser-access");
        std::fs::write(&flag, b"1").expect("grant");
        let broker = BrowserBroker::default();
        broker.set_access_flag_path(flag);
        broker.configure_transport(
            BrowserTransportKind::Attended,
            Arc::new(FakeTransport),
            temp.path().join("images"),
            temp.path().join("artifacts"),
        );

        let managed = broker
            .execute(BrowserTransportKind::Managed, "start_session", json!({}))
            .await
            .expect_err("managed transport is not registered in this slice");
        assert_eq!(managed.code, "browser_transport_unavailable");
        broker.configure_transport(
            BrowserTransportKind::Managed,
            Arc::new(FakeTransport),
            temp.path().join("managed-images"),
            temp.path().join("managed-artifacts"),
        );

        let started = broker
            .execute(BrowserTransportKind::Attended, "start_session", json!({}))
            .await
            .expect("start");
        let session_id = started["sessionId"].as_str().expect("session id");
        assert_eq!(broker.active_session_count(), 1);
        let crossed = broker
            .execute(
                BrowserTransportKind::Managed,
                "list_tabs",
                json!({ "session_id": session_id }),
            )
            .await
            .expect_err("sessions cannot cross transports");
        assert_eq!(crossed.code, "browser_tool_unavailable");
        let opened = broker
            .execute(
                BrowserTransportKind::Attended,
                "open_tab",
                json!({ "session_id": session_id }),
            )
            .await
            .expect("open");
        assert_eq!(opened["tabId"], 7);

        let listed = broker
            .execute(
                BrowserTransportKind::Attended,
                "list_tabs",
                json!({ "session_id": session_id }),
            )
            .await
            .expect("list");
        assert_eq!(listed["tabs"].as_array().expect("tabs").len(), 1);
        assert_eq!(listed["tabs"][0]["tabId"], 7);
        assert!(listed.get("activeTabId").is_none());

        let unowned = broker
            .execute(
                BrowserTransportKind::Attended,
                "snapshot",
                json!({ "session_id": session_id, "tab_id": 999 }),
            )
            .await
            .expect_err("unowned");
        assert_eq!(unowned.code, "tab_not_owned");
        let unimplemented = broker
            .execute(
                BrowserTransportKind::Attended,
                "click",
                json!({ "session_id": session_id, "tab_id": 7, "ref": "e0:n1" }),
            )
            .await
            .expect_err("unimplemented");
        assert_eq!(unimplemented.code, "not_implemented");

        broker
            .execute(
                BrowserTransportKind::Attended,
                "close_session",
                json!({ "session_id": session_id }),
            )
            .await
            .expect("close");
        assert_eq!(broker.active_session_count(), 0);
    }

    #[tokio::test]
    async fn every_action_re_reads_the_persisted_browser_access_grant() {
        let temp = tempfile::tempdir().expect("tempdir");
        let flag = temp.path().join("browser-access");
        std::fs::write(&flag, b"1").expect("grant");
        let broker = BrowserBroker::default();
        broker.set_access_flag_path(flag.clone());
        broker.configure_transport(
            BrowserTransportKind::Attended,
            Arc::new(FakeTransport),
            temp.path().join("images"),
            temp.path().join("artifacts"),
        );
        let started = broker
            .execute(BrowserTransportKind::Attended, "start_session", json!({}))
            .await
            .expect("start");
        let session_id = started["sessionId"].as_str().expect("session id");
        std::fs::remove_file(flag).expect("revoke persisted grant");
        let error = broker
            .execute(
                BrowserTransportKind::Attended,
                "list_tabs",
                json!({ "session_id": session_id }),
            )
            .await
            .expect_err("revoked action");
        assert_eq!(error.code, "browser_access_disabled");
    }

    struct UnavailableTransport;
    impl BrowserTransport for UnavailableTransport {
        fn execute<'a>(&'a self, _tool: &'a str, _arguments: Value) -> TransportFuture<'a> {
            Box::pin(async { Err(AppError::new("unavailable", "unavailable")) })
        }
    }

    struct ManagedPolicyTransport {
        navigate_called: Arc<std::sync::atomic::AtomicBool>,
    }

    impl BrowserTransport for ManagedPolicyTransport {
        fn execute<'a>(&'a self, tool: &'a str, _arguments: Value) -> TransportFuture<'a> {
            let navigate_called = Arc::clone(&self.navigate_called);
            Box::pin(async move {
                match tool {
                    "navigate" => {
                        navigate_called.store(true, std::sync::atomic::Ordering::SeqCst);
                        Err(AppError::new(
                            "browser_policy_blocked",
                            "Navigation blocked: the destination is not on the public web.",
                        ))
                    }
                    _ => Ok(TransportResponse::data(json!({}))),
                }
            })
        }
    }

    #[tokio::test]
    async fn managed_dispatch_uses_transport_policy_and_supports_back_and_interactions() {
        let temp = tempfile::tempdir().expect("tempdir");
        let flag = temp.path().join("browser-access");
        std::fs::write(&flag, b"1").expect("grant");
        let navigate_called = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let broker = BrowserBroker::default();
        broker.set_access_flag_path(flag);
        broker.configure_transport(
            BrowserTransportKind::Managed,
            Arc::new(ManagedPolicyTransport {
                navigate_called: Arc::clone(&navigate_called),
            }),
            temp.path().join("images"),
            temp.path().join("artifacts"),
        );
        let started = broker
            .execute(BrowserTransportKind::Managed, "start_session", json!({}))
            .await
            .expect("start managed session");
        let session_id = started["sessionId"].as_str().expect("session id");

        let blocked = broker
            .execute(
                BrowserTransportKind::Managed,
                "navigate",
                json!({ "session_id": session_id, "url": "http://127.0.0.1/private" }),
            )
            .await
            .expect_err("managed transport must apply its public-web policy");
        assert_eq!(blocked.code, "browser_policy_blocked");
        assert!(navigate_called.load(std::sync::atomic::Ordering::SeqCst));

        broker
            .execute(
                BrowserTransportKind::Managed,
                "back",
                json!({ "session_id": session_id }),
            )
            .await
            .expect("managed back is implemented");
        broker
            .execute(
                BrowserTransportKind::Managed,
                "click",
                json!({ "session_id": session_id, "ref": "ref1" }),
            )
            .await
            .expect("managed interaction reaches its transport");
    }

    #[derive(Default)]
    struct ManagedInteractionDispatchTransport {
        epoch: std::sync::atomic::AtomicU64,
        calls: Mutex<Vec<String>>,
    }

    impl BrowserTransport for ManagedInteractionDispatchTransport {
        fn execute<'a>(&'a self, tool: &'a str, arguments: Value) -> TransportFuture<'a> {
            Box::pin(async move {
                if matches!(tool, "click" | "fill" | "press") {
                    self.calls
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner)
                        .push(tool.to_string());
                    let expected = self.epoch.load(std::sync::atomic::Ordering::SeqCst);
                    let reference = arguments["ref"].as_str().unwrap_or_default();
                    if reference == format!("e{expected}:m0:n9") {
                        return Err(AppError::new(
                            "browser_consequential_action_blocked",
                            "The action was refused: consequential actions are not available in routines.",
                        ));
                    }
                    if !reference.starts_with(&format!("e{expected}:")) {
                        return Err(AppError::new(
                            "browser_stale_reference",
                            "The action reference is stale.",
                        ));
                    }
                    let next = self.epoch.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
                    return Ok(TransportResponse::data(json!({
                        "epoch": next,
                        "snapshot": format!("fresh snapshot after {tool}"),
                    })));
                }
                Ok(TransportResponse::data(json!({})))
            })
        }
    }

    #[tokio::test]
    async fn every_managed_interaction_uses_broker_dispatch_and_returns_a_fresh_snapshot() {
        let temp = tempfile::tempdir().expect("tempdir");
        let flag = temp.path().join("browser-access");
        std::fs::write(&flag, b"1").expect("grant");
        let transport = Arc::new(ManagedInteractionDispatchTransport::default());
        let broker = BrowserBroker::default();
        broker.set_access_flag_path(flag);
        broker.configure_transport(
            BrowserTransportKind::Managed,
            transport.clone(),
            temp.path().join("images"),
            temp.path().join("artifacts"),
        );
        let started = broker
            .execute(BrowserTransportKind::Managed, "start_session", json!({}))
            .await
            .expect("start managed session");
        let session_id = started["sessionId"].as_str().expect("session id");

        for (epoch, tool, extra) in [
            (0, "click", json!({})),
            (1, "fill", json!({ "text": "private form value" })),
            (2, "press", json!({ "key": "Escape" })),
        ] {
            let mut arguments = json!({
                "session_id": session_id,
                "ref": format!("e{epoch}:m0:n1"),
            });
            arguments
                .as_object_mut()
                .expect("arguments")
                .extend(extra.as_object().expect("extra").clone());
            let response = broker
                .execute(BrowserTransportKind::Managed, tool, arguments)
                .await
                .unwrap_or_else(|error| panic!("{tool} dispatch failed: {}", error.code));
            assert_eq!(response["epoch"], epoch + 1);
            assert_eq!(response["snapshot"], format!("fresh snapshot after {tool}"));
        }
        assert_eq!(
            *transport
                .calls
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner),
            ["click", "fill", "press"]
        );

        let stale = broker
            .execute(
                BrowserTransportKind::Managed,
                "click",
                json!({ "session_id": session_id, "ref": "e0:m0:n1" }),
            )
            .await
            .expect_err("an older epoch must be refused through broker dispatch");
        assert_eq!(stale.code, "browser_stale_reference");

        let consequential = broker
            .execute(
                BrowserTransportKind::Managed,
                "click",
                json!({ "session_id": session_id, "ref": "e3:m0:n9" }),
            )
            .await
            .expect_err("managed consequential action must be hard-blocked");
        assert_eq!(consequential.code, "browser_consequential_action_blocked");
        assert!(consequential.message.contains("not available in routines"));
    }

    #[tokio::test]
    async fn managed_interactions_are_grant_gated_before_dispatch() {
        let temp = tempfile::tempdir().expect("tempdir");
        let broker = BrowserBroker::default();
        broker.set_access_flag_path(temp.path().join("missing-grant"));
        let transport = Arc::new(ManagedInteractionDispatchTransport::default());
        broker.configure_transport(
            BrowserTransportKind::Managed,
            transport.clone(),
            temp.path().join("images"),
            temp.path().join("artifacts"),
        );

        for tool in ["click", "fill", "press"] {
            let error = broker
                .execute(
                    BrowserTransportKind::Managed,
                    tool,
                    json!({
                        "session_id": "not-authorized",
                        "ref": "e0:m0:n1",
                        "text": "must not be dispatched",
                        "key": "Escape",
                    }),
                )
                .await
                .expect_err("grant is required");
            assert_eq!(error.code, "browser_access_disabled");
        }
        assert!(transport
            .calls
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .is_empty());
    }

    struct FakeTransport;
    impl BrowserTransport for FakeTransport {
        fn execute<'a>(&'a self, tool: &'a str, _arguments: Value) -> TransportFuture<'a> {
            Box::pin(async move {
                let data = match tool {
                    "open_tab" => json!({ "tabId": 7, "url": "about:blank" }),
                    "list_tabs" => json!({
                        "tabs": [
                            { "tabId": 7, "title": "Owned", "url": "about:blank" },
                            { "tabId": 999, "title": "Foreign", "url": "https://private.example" },
                        ],
                        "activeTabId": 999,
                    }),
                    _ => json!({}),
                };
                Ok(TransportResponse {
                    data,
                    artifact: None,
                })
            })
        }
    }

    #[tokio::test]
    async fn revocation_terminates_in_flight_managed_commands() {
        let temp = tempfile::tempdir().expect("tempdir");
        let flag = temp.path().join("browser-access");
        std::fs::write(&flag, b"1").expect("grant");
        let entered = Arc::new(tokio::sync::Notify::new());
        let release = Arc::new(tokio::sync::Notify::new());
        let terminated = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let broker = Arc::new(BrowserBroker::default());
        broker.set_access_flag_path(flag);
        broker.configure_transport(
            BrowserTransportKind::Managed,
            Arc::new(BlockingTransport {
                entered: Arc::clone(&entered),
                release: Arc::clone(&release),
                terminated: Arc::clone(&terminated),
            }),
            temp.path().join("images"),
            temp.path().join("artifacts"),
        );
        let started = broker
            .execute(BrowserTransportKind::Managed, "start_session", json!({}))
            .await
            .expect("start");
        let session_id = started["sessionId"]
            .as_str()
            .expect("session id")
            .to_string();
        let command_broker = Arc::clone(&broker);
        let command_session = session_id.clone();
        let command = tokio::spawn(async move {
            command_broker
                .execute(
                    BrowserTransportKind::Managed,
                    "snapshot",
                    json!({ "session_id": command_session }),
                )
                .await
        });
        entered.notified().await;
        let revoke_broker = Arc::clone(&broker);
        let revoke = tokio::spawn(async move { revoke_broker.set_enabled(false).await });
        tokio::time::timeout(std::time::Duration::from_secs(1), revoke)
            .await
            .expect("revoke must not wait for the in-flight command")
            .expect("revoke task")
            .expect("revoke result");
        let command_error = command
            .await
            .expect("command task")
            .expect_err("managed command must be interrupted by revoke");
        assert_eq!(command_error.code, "browser_session_closed");
        assert!(terminated.load(std::sync::atomic::Ordering::SeqCst));
        assert_eq!(broker.active_session_count(), 0);
        assert!(!broker.is_enabled());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn revocation_terminates_a_managed_session_during_startup() {
        let temp = tempfile::tempdir().expect("tempdir");
        let flag = temp.path().join("browser-access");
        std::fs::write(&flag, b"1").expect("grant");
        let profile = temp.path().join("starting-profile");
        let state = Arc::new(StartingProcessState {
            entered: tokio::sync::Notify::new(),
            release: tokio::sync::Notify::new(),
            child: Mutex::new(None),
            profile: profile.clone(),
            terminated: std::sync::atomic::AtomicBool::new(false),
            finished: std::sync::atomic::AtomicBool::new(false),
            finished_notify: tokio::sync::Notify::new(),
        });
        let broker = Arc::new(BrowserBroker::default());
        broker.set_access_flag_path(flag);
        broker.configure_transport(
            BrowserTransportKind::Managed,
            Arc::new(StartingProcessTransport {
                state: Arc::clone(&state),
            }),
            temp.path().join("images"),
            temp.path().join("artifacts"),
        );

        let start_broker = Arc::clone(&broker);
        let start = tokio::spawn(async move {
            start_broker
                .execute(BrowserTransportKind::Managed, "start_session", json!({}))
                .await
        });
        state.entered.notified().await;

        tokio::time::timeout(std::time::Duration::from_secs(1), broker.set_enabled(false))
            .await
            .expect("revoke must complete during startup")
            .expect("revoke result");

        let process_survived = state
            .child
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .as_mut()
            .is_some_and(|child| child.try_wait().expect("child status").is_none());
        let profile_survived = profile.exists();
        let terminated = state.terminated.load(std::sync::atomic::Ordering::SeqCst);
        let startup_finished = start.is_finished();

        // Always clean up the stand-in before asserting, including on the RED
        // run where the broker cannot see a starting session yet.
        StartingProcessTransport::terminate(&state);
        let _ = tokio::time::timeout(std::time::Duration::from_secs(1), start).await;

        assert!(terminated, "revoke never reached the starting transport");
        assert!(!process_survived, "starting browser survived revoke");
        assert!(!profile_survived, "starting profile survived revoke");
        assert!(startup_finished, "revoke returned before startup finished");
        assert_eq!(broker.active_session_count(), 0);
    }

    #[tokio::test]
    async fn revocation_stays_closed_when_extension_teardown_cannot_acknowledge() {
        let temp = tempfile::tempdir().expect("tempdir");
        let flag = temp.path().join("browser-access");
        std::fs::write(&flag, b"1").expect("grant");
        let broker = BrowserBroker::default();
        broker.set_access_flag_path(flag);
        broker.configure_transport(
            BrowserTransportKind::Attended,
            Arc::new(FailingCloseTransport),
            temp.path().join("images"),
            temp.path().join("artifacts"),
        );
        broker
            .execute(BrowserTransportKind::Attended, "start_session", json!({}))
            .await
            .expect("start");

        broker
            .set_enabled(false)
            .await
            .expect("revoke remains durable after disconnect");

        assert!(!broker.is_enabled());
        assert_eq!(broker.active_session_count(), 0);
    }
}
