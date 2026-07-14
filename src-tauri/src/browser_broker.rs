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

type TransportFuture<'a> =
    Pin<Box<dyn Future<Output = Result<TransportResponse, AppError>> + Send + 'a>>;

pub(crate) trait BrowserTransport: Send + Sync {
    fn execute<'a>(&'a self, tool: &'a str, arguments: Value) -> TransportFuture<'a>;
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

struct TransportArtifact {
    kind: String,
    mime_type: String,
    bytes: Vec<u8>,
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
    policy_gate: tokio::sync::RwLock<()>,
    transition_lock: tokio::sync::Mutex<()>,
}

impl Default for BrowserBroker {
    fn default() -> Self {
        Self {
            state: Mutex::new(BrowserBrokerState::default()),
            policy_gate: tokio::sync::RwLock::new(()),
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
        state.transports.insert(kind, transport);
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
        let _transition = self.policy_gate.write().await;
        let (transports, sessions) = {
            let mut state = self.lock();
            state.transition_blocked = !enabled;
            if enabled {
                return Ok(());
            }
            let transports = state.transports.clone();
            let sessions = state
                .sessions
                .iter()
                .map(|(id, session)| (id.clone(), session.transport_kind))
                .collect::<Vec<_>>();
            (transports, sessions)
        };
        let mut first_error = None;
        for (session_id, kind) in sessions {
            if let Some(transport) = transports.get(&kind).cloned() {
                if let Err(error) = transport
                    .execute("session_close", json!({ "session_id": session_id }))
                    .await
                {
                    first_error.get_or_insert(error);
                }
            }
        }
        self.lock().sessions.clear();
        if let Some(error) = first_error {
            tracing::warn!(
                code = %error.code,
                message = %error.message,
                "browser session teardown failed during access revocation"
            );
        }
        // Revocation must remain durable even if Chrome disappeared before it
        // acknowledged detach. The broker gate is already closed and the
        // caller must still remove the persisted grant and rotate credentials.
        Ok(())
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
        let _operation = self.policy_gate.read().await;
        self.require_enabled()?;
        if matches!(
            tool,
            "click" | "fill" | "press" | "back" | "tab_accept_shared"
        ) {
            return Err(AppError::new(
                "not_implemented",
                format!("The {tool} browser tool is not implemented yet."),
            ));
        }
        if !matches!(
            tool,
            "session_start"
                | "session_close"
                | "navigate"
                | "snapshot"
                | "screenshot"
                | "tabs_list"
                | "tab_open"
                | "tab_switch"
                | "tab_close"
        ) {
            return Err(AppError::new(
                "unknown_browser_tool",
                "Unknown browser tool.",
            ));
        }

        let transport = self.transport(kind)?;
        if tool == "session_start" {
            let session_id = uuid::Uuid::new_v4().to_string();
            arguments = json!({ "session_id": session_id });
            transport.execute(tool, arguments).await?;
            self.lock().sessions.insert(
                session_id.clone(),
                BrowserSession {
                    transport_kind: kind,
                    tabs: HashSet::new(),
                },
            );
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

        if tool == "session_close" {
            transport.execute(tool, arguments).await?;
            self.lock().sessions.remove(&session_id);
            return Ok(json!({ "closed": true }));
        }

        if tool == "navigate" {
            validate_attended_url(required_string(&arguments, "url")?)?;
        }

        if tool == "tab_open" {
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
                        "tab_close",
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

        if tool != "tabs_list" {
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
        if tool == "tabs_list" {
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
        if tool == "tab_close" {
            let tab_id = arguments["tab_id"].as_i64().unwrap_or_default();
            if let Some(session) = self.lock().sessions.get_mut(&session_id) {
                session.tabs.remove(&tab_id);
            }
        }
        if let Some(artifact) = response.artifact {
            return self.store_artifact(artifact);
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
    }

    impl BrowserTransport for BlockingTransport {
        fn execute<'a>(&'a self, tool: &'a str, _arguments: Value) -> TransportFuture<'a> {
            let entered = Arc::clone(&self.entered);
            let release = Arc::clone(&self.release);
            Box::pin(async move {
                if tool == "snapshot" {
                    entered.notify_one();
                    release.notified().await;
                }
                let data = match tool {
                    "tab_open" => json!({ "tabId": 7 }),
                    "tabs_list" => json!({ "tabs": [] }),
                    _ => json!({}),
                };
                Ok(TransportResponse {
                    data,
                    artifact: None,
                })
            })
        }
    }

    struct FailingCloseTransport;

    impl BrowserTransport for FailingCloseTransport {
        fn execute<'a>(&'a self, tool: &'a str, _arguments: Value) -> TransportFuture<'a> {
            Box::pin(async move {
                if tool == "session_close" {
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
            .execute(BrowserTransportKind::Managed, "session_start", json!({}))
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
            .execute(BrowserTransportKind::Attended, "session_start", json!({}))
            .await
            .expect("start");
        let session_id = started["sessionId"].as_str().expect("session id");
        assert_eq!(broker.active_session_count(), 1);
        let crossed = broker
            .execute(
                BrowserTransportKind::Managed,
                "tabs_list",
                json!({ "session_id": session_id }),
            )
            .await
            .expect_err("sessions cannot cross transports");
        assert_eq!(crossed.code, "browser_session_not_found");
        let opened = broker
            .execute(
                BrowserTransportKind::Attended,
                "tab_open",
                json!({ "session_id": session_id }),
            )
            .await
            .expect("open");
        assert_eq!(opened["tabId"], 7);

        let listed = broker
            .execute(
                BrowserTransportKind::Attended,
                "tabs_list",
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
                "session_close",
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
            .execute(BrowserTransportKind::Attended, "session_start", json!({}))
            .await
            .expect("start");
        let session_id = started["sessionId"].as_str().expect("session id");
        std::fs::remove_file(flag).expect("revoke persisted grant");
        let error = broker
            .execute(
                BrowserTransportKind::Attended,
                "tabs_list",
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

    struct FakeTransport;
    impl BrowserTransport for FakeTransport {
        fn execute<'a>(&'a self, tool: &'a str, _arguments: Value) -> TransportFuture<'a> {
            Box::pin(async move {
                let data = match tool {
                    "tab_open" => json!({ "tabId": 7, "url": "about:blank" }),
                    "tabs_list" => json!({
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
    async fn revocation_waits_for_in_flight_commands_before_closing_sessions() {
        let temp = tempfile::tempdir().expect("tempdir");
        let flag = temp.path().join("browser-access");
        std::fs::write(&flag, b"1").expect("grant");
        let entered = Arc::new(tokio::sync::Notify::new());
        let release = Arc::new(tokio::sync::Notify::new());
        let broker = Arc::new(BrowserBroker::default());
        broker.set_access_flag_path(flag);
        broker.configure_transport(
            BrowserTransportKind::Attended,
            Arc::new(BlockingTransport {
                entered: Arc::clone(&entered),
                release: Arc::clone(&release),
            }),
            temp.path().join("images"),
            temp.path().join("artifacts"),
        );
        let started = broker
            .execute(BrowserTransportKind::Attended, "session_start", json!({}))
            .await
            .expect("start");
        let session_id = started["sessionId"]
            .as_str()
            .expect("session id")
            .to_string();
        broker
            .execute(
                BrowserTransportKind::Attended,
                "tab_open",
                json!({ "session_id": session_id }),
            )
            .await
            .expect("open");

        let command_broker = Arc::clone(&broker);
        let command_session = session_id.clone();
        let command = tokio::spawn(async move {
            command_broker
                .execute(
                    BrowserTransportKind::Attended,
                    "snapshot",
                    json!({ "session_id": command_session, "tab_id": 7 }),
                )
                .await
        });
        entered.notified().await;
        let revoke_broker = Arc::clone(&broker);
        let mut revoke = tokio::spawn(async move { revoke_broker.set_enabled(false).await });
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(25), &mut revoke)
                .await
                .is_err(),
            "revoke must wait for the active browser operation"
        );
        release.notify_one();
        command
            .await
            .expect("command task")
            .expect("command result");
        revoke.await.expect("revoke task").expect("revoke result");
        assert_eq!(broker.active_session_count(), 0);
        assert!(!broker.is_enabled());
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
            .execute(BrowserTransportKind::Attended, "session_start", json!({}))
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
