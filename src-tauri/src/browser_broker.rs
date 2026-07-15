use std::{
    collections::{HashMap, HashSet},
    future::Future,
    path::{Path, PathBuf},
    pin::Pin,
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::{
    browser::policy::{classify_managed_action, ActionClass, InteractiveElement, ManagedAction},
    db::repositories::Repositories,
    domain::types::AppError,
    extension_host::{ExtensionHost, ExtensionResponse},
};

pub(crate) const BROWSER_APPROVALS_CHANGED_EVENT: &str = "june://browser-approvals-changed";
const BROWSER_APPROVAL_TIMEOUT_MS: u64 = 600_000;

fn constant_time_eq(left: &str, right: &str) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.as_bytes()
        .iter()
        .zip(right.as_bytes())
        .fold(0_u8, |difference, (left, right)| {
            difference | (left ^ right)
        })
        == 0
}

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

impl BrowserTransportKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Attended => "attended",
            Self::Managed => "managed",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BrowserOutcomeClass {
    TargetState,
    Artifact,
    ActionReceipt,
}

impl BrowserOutcomeClass {
    fn for_tool(tool: &str) -> Option<Self> {
        match tool {
            "navigate" | "back" => Some(Self::TargetState),
            "snapshot" | "screenshot" => Some(Self::Artifact),
            "click" | "fill" | "press" => Some(Self::ActionReceipt),
            _ => None,
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::TargetState => "target_state",
            Self::Artifact => "artifact",
            Self::ActionReceipt => "action_receipt",
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BrowserTransportPolicy {
    pub attended_enabled: bool,
    pub managed_enabled: bool,
}

impl Default for BrowserTransportPolicy {
    fn default() -> Self {
        Self {
            attended_enabled: true,
            managed_enabled: true,
        }
    }
}

#[derive(Clone)]
struct BrowserOutcomeDeclaration {
    id: String,
    session_id: String,
    outcome_class: Option<BrowserOutcomeClass>,
}

impl BrowserTransportPolicy {
    fn enabled(self, kind: BrowserTransportKind) -> bool {
        match kind {
            BrowserTransportKind::Attended => self.attended_enabled,
            BrowserTransportKind::Managed => self.managed_enabled,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum BrowserBrokerContext {
    Attended,
    Routine(String),
}

impl BrowserBrokerContext {
    fn transport_kind(&self) -> BrowserTransportKind {
        match self {
            Self::Attended => BrowserTransportKind::Attended,
            Self::Routine(_) => BrowserTransportKind::Managed,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RoutineBrowserGrant {
    pub(crate) job_id: String,
    pub(crate) server_name: String,
    pub(crate) token: String,
    pub(crate) enabled: bool,
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
            let failure_message = extension_failure_message(tool, &arguments);
            let ExtensionResponse {
                value,
                artifact_bytes,
            } = self.host.request(tool, arguments).await?;
            if value.get("success").and_then(Value::as_bool) != Some(true) {
                return Err(extension_request_error(failure_message, &value));
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
    action_lock: tokio::sync::Mutex<()>,
}

impl Default for BrowserBroker {
    fn default() -> Self {
        Self {
            state: Mutex::new(BrowserBrokerState::default()),
            transition_lock: tokio::sync::Mutex::new(()),
            action_lock: tokio::sync::Mutex::new(()),
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
    pending_approvals: HashMap<String, PendingBrowserAction>,
    pending_by_action: HashMap<BrowserActionKey, String>,
    resolved_actions: HashMap<BrowserActionKey, BrowserActionOutcome>,
    approvals_changed: Option<Arc<dyn Fn() + Send + Sync>>,
    routine_grants: Vec<RoutineBrowserGrant>,
    outcome_repository: Option<Repositories>,
    transport_policy: BrowserTransportPolicy,
}

struct BrowserSession {
    transport_kind: BrowserTransportKind,
    routine_id: Option<String>,
    tabs: HashSet<i64>,
    allowed_origins: HashSet<String>,
}

impl Default for BrowserSession {
    fn default() -> Self {
        Self {
            transport_kind: BrowserTransportKind::Attended,
            routine_id: None,
            tabs: HashSet::new(),
            allowed_origins: HashSet::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct BrowserActionKey {
    session_id: String,
    tab_id: i64,
    tool: String,
    reference: String,
    value: String,
}

#[derive(Clone)]
struct PendingBrowserAction {
    approval_id: String,
    key: BrowserActionKey,
    origin: String,
    element: InteractiveElement,
    requested_at_ms: u64,
    ledger_action_id: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BrowserActionOutcome {
    Executed,
    Declined,
    Stale,
    NotExecuted,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingBrowserApproval {
    pub approval_id: String,
    pub site: String,
    pub action: String,
    pub element_label: String,
    pub requested_at_ms: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AttendedReferenceInspection {
    element: InteractiveElement,
    url: String,
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

    pub(crate) fn configure_outcome_repository(&self, repositories: Repositories) {
        self.lock().outcome_repository = Some(repositories);
    }

    pub(crate) fn set_access_flag_path(&self, path: PathBuf) {
        self.lock().access_flag_path = Some(path);
    }

    pub(crate) fn set_approvals_changed_notifier(&self, notifier: Arc<dyn Fn() + Send + Sync>) {
        self.lock().approvals_changed = Some(notifier);
    }

    fn notify_approvals_changed(&self) {
        let notifier = self.lock().approvals_changed.clone();
        if let Some(notifier) = notifier {
            notifier();
        }
    }

    pub(crate) fn replace_routine_grants(&self, grants: Vec<RoutineBrowserGrant>) {
        self.lock().routine_grants = grants;
    }

    pub(crate) fn set_routine_grant(&self, grant: RoutineBrowserGrant) {
        let mut state = self.lock();
        state
            .routine_grants
            .retain(|existing| existing.job_id != grant.job_id);
        state.routine_grants.push(grant);
    }

    pub(crate) fn remove_routine_grant(&self, job_id: &str) -> Option<RoutineBrowserGrant> {
        let mut state = self.lock();
        let index = state
            .routine_grants
            .iter()
            .position(|grant| grant.job_id == job_id)?;
        Some(state.routine_grants.remove(index))
    }

    pub(crate) fn routine_grant_for_token(&self, token: &str) -> Option<RoutineBrowserGrant> {
        self.lock()
            .routine_grants
            .iter()
            .find(|grant| constant_time_eq(&grant.token, token))
            .cloned()
    }

    fn require_routine_opt_in(&self, job_id: &str, tool: &str) -> Result<(), AppError> {
        if self
            .lock()
            .routine_grants
            .iter()
            .any(|grant| grant.job_id == job_id && grant.enabled)
        {
            Ok(())
        } else {
            Err(AppError::new(
                "browser_routine_not_opted_in",
                format!(
                    "The {tool} browser operation was refused because this routine has not been granted browsing."
                ),
            ))
        }
    }

    pub(crate) async fn lock_transition(&self) -> tokio::sync::MutexGuard<'_, ()> {
        self.transition_lock.lock().await
    }

    pub(crate) async fn set_enabled(&self, enabled: bool) -> Result<(), AppError> {
        let _action = self.action_lock.lock().await;
        let (transports, sessions, cancelled) = {
            let mut state = self.lock();
            state.transition_blocked = !enabled;
            if enabled {
                return Ok(());
            }
            let cancelled = state
                .pending_approvals
                .drain()
                .map(|(_, pending)| pending)
                .collect::<Vec<_>>();
            state.pending_by_action.clear();
            state.resolved_actions.clear();
            let transports = state.transports.clone();
            let sessions = state
                .sessions
                .drain()
                .map(|(id, session)| (id.clone(), session.transport_kind))
                .collect::<Vec<_>>();
            (transports, sessions, cancelled)
        };
        if !cancelled.is_empty() {
            self.notify_approvals_changed();
        }
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
        // The grant and every live session are already gone. Ledger writes are
        // intentionally best-effort from here so a database failure cannot
        // keep a revoked browser attachment alive or block credential cleanup.
        for pending in &cancelled {
            match self
                .finish_approval(
                    pending,
                    "cancelled_by_task_end",
                    "browser_action_cancelled_by_task_end",
                )
                .await
            {
                Ok(()) => {
                    tracing::info!(action_id = %pending.approval_id, outcome = "cancelled_by_task_end", "browser approval state changed");
                }
                Err(error) => {
                    tracing::warn!(
                        action_id = %pending.approval_id,
                        code = %error.code,
                        "browser approval cancellation ledger write failed after revocation"
                    );
                }
            }
        }
        // Revocation must remain durable even if Chrome disappeared before it
        // acknowledged detach. The broker gate is already closed and the
        // caller must still remove the persisted grant and rotate credentials.
        Ok(())
    }

    pub(crate) fn transport_policy(&self) -> BrowserTransportPolicy {
        self.lock().transport_policy
    }

    /// Apply the last successfully fetched remote policy. The in-memory gate
    /// closes before transport teardown begins, and only sessions owned by a
    /// newly disabled transport are removed.
    pub(crate) async fn set_transport_policy(&self, policy: BrowserTransportPolicy) {
        let _action = self.action_lock.lock().await;
        let (transports, sessions, approvals_changed) = {
            let mut state = self.lock();
            state.transport_policy = policy;
            let session_ids = state
                .sessions
                .iter()
                .filter(|(_, session)| !policy.enabled(session.transport_kind))
                .map(|(id, _)| id.clone())
                .collect::<Vec<_>>();
            let sessions = session_ids
                .into_iter()
                .filter_map(|id| {
                    state
                        .sessions
                        .remove(&id)
                        .map(|session| (id, session.transport_kind))
                })
                .collect::<Vec<_>>();
            let approvals_changed = if policy.attended_enabled {
                false
            } else {
                let changed = !state.pending_approvals.is_empty();
                state.pending_approvals.clear();
                state.pending_by_action.clear();
                state.resolved_actions.clear();
                changed
            };
            (state.transports.clone(), sessions, approvals_changed)
        };
        if approvals_changed {
            self.notify_approvals_changed();
        }
        for (session_id, kind) in &sessions {
            if let Some(transport) = transports.get(kind) {
                transport.terminate_session(session_id);
            }
        }
        for (session_id, kind) in sessions {
            if let Some(transport) = transports.get(&kind) {
                if let Err(error) = transport
                    .execute("close_session", json!({ "session_id": session_id }))
                    .await
                {
                    tracing::warn!(
                        code = %error.code,
                        transport = kind.as_str(),
                        "browser session teardown failed after remote transport disable"
                    );
                }
            }
        }
    }

    /// App-exit backstop. Managed transports terminate synchronously so no
    /// in-flight request can keep Chromium or its ephemeral profile alive.
    pub(crate) fn terminate_sessions(&self) {
        let (transports, sessions, approvals_changed) = {
            let mut state = self.lock();
            state.transition_blocked = true;
            let approvals_changed = !state.pending_approvals.is_empty();
            state.pending_approvals.clear();
            state.pending_by_action.clear();
            state.resolved_actions.clear();
            let transports = state.transports.clone();
            let sessions = state
                .sessions
                .drain()
                .map(|(id, session)| (id, session.transport_kind))
                .collect::<Vec<_>>();
            (transports, sessions, approvals_changed)
        };
        if approvals_changed {
            self.notify_approvals_changed();
        }
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

    pub(crate) async fn release_tab(&self, tab_id: i64) -> Result<bool, AppError> {
        let _action = self.action_lock.lock().await;
        let (released, cancelled) = {
            let mut state = self.lock();
            let mut released = false;
            let session_ids = state
                .sessions
                .iter_mut()
                .filter_map(|(session_id, session)| {
                    session.tabs.remove(&tab_id).then(|| {
                        released = true;
                        session_id.clone()
                    })
                })
                .collect::<HashSet<_>>();
            let cancelled = remove_actions_matching(&mut state, |key| {
                key.tab_id == tab_id && session_ids.contains(&key.session_id)
            });
            (released, cancelled)
        };
        for pending in &cancelled {
            self.finish_approval(
                pending,
                "cancelled_by_task_end",
                "browser_action_cancelled_by_task_end",
            )
            .await?;
            tracing::info!(action_id = %pending.approval_id, outcome = "cancelled_by_task_end", "browser approval state changed");
        }
        if !cancelled.is_empty() {
            self.notify_approvals_changed();
        }
        Ok(released)
    }

    pub(crate) async fn pending_approvals(&self) -> Result<Vec<PendingBrowserApproval>, AppError> {
        let _action = self.action_lock.lock().await;
        self.prune_expired_approvals().await?;
        let mut pending = self
            .lock()
            .pending_approvals
            .values()
            .map(|entry| PendingBrowserApproval {
                approval_id: entry.approval_id.clone(),
                site: entry.origin.clone(),
                action: entry.key.tool.clone(),
                element_label: if entry.element.label.trim().is_empty() {
                    "Unlabelled element".to_string()
                } else {
                    entry.element.label.clone()
                },
                requested_at_ms: entry.requested_at_ms,
            })
            .collect::<Vec<_>>();
        pending.sort_by_key(|entry| entry.requested_at_ms);
        Ok(pending)
    }

    async fn prune_expired_approvals(&self) -> Result<(), AppError> {
        let expired = {
            let state = self.lock();
            let now = now_ms();
            state
                .pending_approvals
                .iter()
                .filter(|(_, pending)| {
                    now.saturating_sub(pending.requested_at_ms) >= BROWSER_APPROVAL_TIMEOUT_MS
                })
                .map(|(_, pending)| pending.clone())
                .collect::<Vec<_>>()
        };
        for pending in &expired {
            self.finish_approval(pending, "expired", "browser_approval_expired")
                .await?;
        }
        if !expired.is_empty() {
            let mut state = self.lock();
            for pending in &expired {
                state.pending_approvals.remove(&pending.approval_id);
                state.pending_by_action.remove(&pending.key);
                state
                    .resolved_actions
                    .insert(pending.key.clone(), BrowserActionOutcome::NotExecuted);
                tracing::info!(action_id = %pending.approval_id, outcome = "expired", "browser approval state changed");
            }
            drop(state);
            self.notify_approvals_changed();
        }
        Ok(())
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

    fn require_transport_enabled(
        &self,
        kind: BrowserTransportKind,
        tool: &str,
        arguments: &Value,
        routine_id: Option<&str>,
    ) -> Result<(), AppError> {
        if self.lock().transport_policy.enabled(kind) {
            return Ok(());
        }
        let mut details = json!({
            "operation": tool,
            "transport": kind.as_str(),
        });
        if let Some(session_id) = arguments.get("session_id").and_then(Value::as_str) {
            details["sessionId"] = json!(session_id);
        }
        if let Some(routine_id) = routine_id {
            details["routineId"] = json!(routine_id);
        }
        let mut error = AppError::new(
            "browser_transport_disabled_remotely",
            "This browser capability is temporarily disabled.",
        );
        error.details = Some(details);
        Err(error)
    }

    fn transport(&self, kind: BrowserTransportKind) -> Result<Arc<dyn BrowserTransport>, AppError> {
        self.lock().transports.get(&kind).cloned().ok_or_else(|| {
            AppError::new(
                "browser_transport_unavailable",
                "The selected browser transport is unavailable.",
            )
        })
    }

    fn outcome_repository(&self) -> Result<Option<Repositories>, AppError> {
        let repository = self.lock().outcome_repository.clone();
        #[cfg(not(test))]
        if repository.is_none() {
            return Err(AppError::new(
                "browser_outcome_ledger_unavailable",
                "The browser outcome ledger is unavailable.",
            ));
        }
        Ok(repository)
    }

    async fn declare_outcome(
        &self,
        kind: BrowserTransportKind,
        tool: &str,
        session_id: &str,
    ) -> Result<BrowserOutcomeDeclaration, AppError> {
        let declaration = BrowserOutcomeDeclaration {
            id: uuid::Uuid::new_v4().to_string(),
            session_id: session_id.to_string(),
            outcome_class: BrowserOutcomeClass::for_tool(tool),
        };
        if let Some(repository) = self.outcome_repository()? {
            repository
                .declare_browser_action(
                    &declaration.id,
                    tool,
                    kind.as_str(),
                    session_id,
                    declaration.outcome_class.map(BrowserOutcomeClass::as_str),
                )
                .await
                .map_err(outcome_ledger_error)?;
        }
        Ok(declaration)
    }

    async fn evaluate_outcome(
        &self,
        declaration: &BrowserOutcomeDeclaration,
        result_kind: &str,
        result_code_class: Option<&str>,
        outcome_verified: bool,
    ) {
        let Ok(Some(repository)) = self.outcome_repository() else {
            return;
        };
        if let Err(error) = repository
            .evaluate_browser_action(
                &declaration.id,
                result_kind,
                result_code_class,
                outcome_verified,
            )
            .await
        {
            tracing::error!(
                action_id = %declaration.id,
                error = %error,
                "browser outcome evaluation persistence failed"
            );
        }
    }

    async fn finish_declared_response(
        &self,
        declaration: &BrowserOutcomeDeclaration,
        response: Result<TransportResponse, AppError>,
    ) -> Result<Value, AppError> {
        match response {
            Ok(response) => {
                let verified = match declaration.outcome_class {
                    Some(BrowserOutcomeClass::Artifact) => response.artifact.is_some(),
                    Some(BrowserOutcomeClass::TargetState | BrowserOutcomeClass::ActionReceipt) => {
                        true
                    }
                    None => false,
                };
                match self.finish_response(response) {
                    Ok(value) => {
                        self.evaluate_outcome(declaration, "executed", None, verified)
                            .await;
                        Ok(value)
                    }
                    Err(error) => {
                        self.evaluate_outcome(
                            declaration,
                            "transport_error",
                            Some(&error.code),
                            false,
                        )
                        .await;
                        Err(error)
                    }
                }
            }
            Err(error) => {
                let result_kind = if is_broker_refusal_code(&error.code) {
                    "refused"
                } else {
                    "transport_error"
                };
                self.evaluate_outcome(declaration, result_kind, Some(&error.code), false)
                    .await;
                Err(error)
            }
        }
    }

    async fn park_outcome(
        &self,
        declaration: &BrowserOutcomeDeclaration,
        approval_id: &str,
    ) -> Result<(), AppError> {
        if let Some(repository) = self.outcome_repository()? {
            repository
                .park_browser_approval(&declaration.id, approval_id, &declaration.session_id)
                .await
                .map_err(outcome_ledger_error)?;
        }
        Ok(())
    }

    async fn record_approval_event(
        &self,
        pending: &PendingBrowserAction,
        event_kind: &str,
    ) -> Result<(), AppError> {
        if let Some(repository) = self.outcome_repository()? {
            repository
                .record_browser_approval_event(
                    &pending.ledger_action_id,
                    &pending.approval_id,
                    &pending.key.session_id,
                    event_kind,
                )
                .await
                .map_err(outcome_ledger_error)?;
        }
        Ok(())
    }

    async fn finish_approval(
        &self,
        pending: &PendingBrowserAction,
        event_kind: &str,
        result_code_class: &str,
    ) -> Result<(), AppError> {
        if let Some(repository) = self.outcome_repository()? {
            repository
                .finish_browser_approval(
                    &pending.ledger_action_id,
                    &pending.approval_id,
                    &pending.key.session_id,
                    event_kind,
                    result_code_class,
                )
                .await
                .map_err(outcome_ledger_error)?;
        }
        Ok(())
    }

    pub(crate) async fn execute_for(
        &self,
        context: BrowserBrokerContext,
        tool: &str,
        arguments: Value,
    ) -> Result<Value, AppError> {
        self.require_enabled()?;
        let kind = context.transport_kind();
        self.require_transport_enabled(
            kind,
            tool,
            &arguments,
            match &context {
                BrowserBrokerContext::Attended => None,
                BrowserBrokerContext::Routine(job_id) => Some(job_id.as_str()),
            },
        )?;
        let routine_id = match &context {
            BrowserBrokerContext::Attended => None,
            BrowserBrokerContext::Routine(job_id) => {
                self.require_routine_opt_in(job_id, tool)?;
                Some(job_id.as_str())
            }
        };
        self.execute_inner(kind, routine_id, tool, arguments).await
    }

    #[cfg(test)]
    pub(crate) async fn execute(
        &self,
        kind: BrowserTransportKind,
        tool: &str,
        arguments: Value,
    ) -> Result<Value, AppError> {
        self.require_enabled()?;
        self.require_transport_enabled(kind, tool, &arguments, None)?;
        self.execute_inner(kind, None, tool, arguments).await
    }

    async fn execute_inner(
        &self,
        kind: BrowserTransportKind,
        routine_id: Option<&str>,
        tool: &str,
        mut arguments: Value,
    ) -> Result<Value, AppError> {
        self.require_enabled()?;
        self.require_transport_enabled(kind, tool, &arguments, routine_id)?;
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
            BrowserTransportKind::Attended if tool == "back" => {
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
            let declaration = self.declare_outcome(kind, tool, &session_id).await?;
            arguments = json!({ "session_id": &session_id });
            let inserted = {
                if let Err(error) = transport.reserve_session(&session_id) {
                    self.evaluate_outcome(
                        &declaration,
                        "transport_error",
                        Some(&error.code),
                        false,
                    )
                    .await;
                    return Err(error);
                }
                let mut state = self.lock();
                let enabled = !state.transition_blocked
                    && state.transport_policy.enabled(kind)
                    && state
                        .access_flag_path
                        .as_ref()
                        .is_some_and(|path| path.exists());
                if enabled {
                    state.sessions.insert(
                        session_id.clone(),
                        BrowserSession {
                            transport_kind: kind,
                            routine_id: routine_id.map(str::to_string),
                            tabs: HashSet::new(),
                            allowed_origins: HashSet::new(),
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
                self.evaluate_outcome(
                    &declaration,
                    "refused",
                    Some("browser_access_disabled"),
                    false,
                )
                .await;
                return Err(AppError::new(
                    "browser_access_disabled",
                    "Browser use is not enabled.",
                ));
            }

            if let Err(error) = transport.execute(tool, arguments).await {
                self.lock().sessions.remove(&session_id);
                transport.terminate_session(&session_id);
                self.evaluate_outcome(
                    &declaration,
                    if is_broker_refusal_code(&error.code) {
                        "refused"
                    } else {
                        "transport_error"
                    },
                    Some(&error.code),
                    false,
                )
                .await;
                return Err(error);
            }
            let still_owned = {
                let state = self.lock();
                !state.transition_blocked
                    && state.transport_policy.enabled(kind)
                    && state.sessions.get(&session_id).is_some_and(|session| {
                        session.transport_kind == kind
                            && session.routine_id.as_deref() == routine_id
                    })
            };
            if !still_owned {
                transport.terminate_session(&session_id);
                let _ = transport
                    .execute("close_session", json!({ "session_id": &session_id }))
                    .await;
                self.evaluate_outcome(
                    &declaration,
                    "refused",
                    Some("browser_access_disabled"),
                    false,
                )
                .await;
                return Err(AppError::new(
                    "browser_access_disabled",
                    "Browser use is not enabled.",
                ));
            }
            self.evaluate_outcome(&declaration, "executed", None, false)
                .await;
            return Ok(json!({ "sessionId": session_id }));
        }

        let session_id = required_string(&arguments, "session_id")?.to_string();
        {
            let state = self.lock();
            if !state.sessions.get(&session_id).is_some_and(|session| {
                session.transport_kind == kind && session.routine_id.as_deref() == routine_id
            }) {
                return Err(AppError::new(
                    "browser_session_not_found",
                    "Browser session was not found.",
                ));
            }
        }

        if tool == "close_session" {
            let _action = self.action_lock.lock().await;
            let declaration = self.declare_outcome(kind, tool, &session_id).await?;
            let close_result = transport.execute(tool, arguments).await;
            let cancelled = {
                let mut state = self.lock();
                state.sessions.remove(&session_id);
                remove_actions_matching(&mut state, |key| key.session_id == session_id)
            };
            for pending in &cancelled {
                self.finish_approval(
                    pending,
                    "cancelled_by_task_end",
                    "browser_action_cancelled_by_task_end",
                )
                .await?;
                tracing::info!(action_id = %pending.approval_id, outcome = "cancelled_by_task_end", "browser approval state changed");
            }
            if !cancelled.is_empty() {
                self.notify_approvals_changed();
            }
            self.finish_declared_response(&declaration, close_result)
                .await?;
            return Ok(json!({ "closed": true }));
        }

        if tool == "accept_shared_tab" {
            required_string(&arguments, "share_id")?;
        }

        // Managed sessions have one page and no task-tab surface. Their
        // navigate path deliberately bypasses the attended URL check: the
        // transport enforces the stricter resolve-validate-pin policy instead.
        if kind == BrowserTransportKind::Managed {
            let declaration = self.declare_outcome(kind, tool, &session_id).await?;
            return self
                .finish_declared_response(&declaration, transport.execute(tool, arguments).await)
                .await;
        }

        if matches!(tool, "open_tab" | "accept_shared_tab") {
            let declaration = self.declare_outcome(kind, tool, &session_id).await?;
            let response = match transport.execute(tool, arguments.clone()).await {
                Ok(response) => response,
                Err(error) => {
                    self.evaluate_outcome(
                        &declaration,
                        "transport_error",
                        Some(&error.code),
                        false,
                    )
                    .await;
                    return Err(error);
                }
            };
            let Some(tab_id) = response.data.get("tabId").and_then(Value::as_i64) else {
                let error = AppError::new(
                    "extension_response_invalid",
                    "The extension returned no tab id.",
                );
                self.evaluate_outcome(&declaration, "transport_error", Some(&error.code), false)
                    .await;
                return Err(error);
            };
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
                let error = AppError::new(
                    "extension_tab_collision",
                    "The extension returned a tab id that cannot belong to this session.",
                );
                self.evaluate_outcome(&declaration, "transport_error", Some(&error.code), false)
                    .await;
                return Err(error);
            }
            self.evaluate_outcome(&declaration, "executed", None, false)
                .await;
            return Ok(response.data);
        }

        if matches!(tool, "click" | "fill" | "press") {
            return self
                .execute_attended_interaction(transport, tool, arguments)
                .await;
        }

        let declaration = self.declare_outcome(kind, tool, &session_id).await?;
        if tool == "navigate" {
            if let Err(error) = required_string(&arguments, "url").and_then(validate_attended_url) {
                self.evaluate_outcome(&declaration, "refused", Some(&error.code), false)
                    .await;
                return Err(error);
            }
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
                let error = AppError::new(
                    "tab_not_owned",
                    "The tab is not owned by this Browser use session.",
                );
                self.evaluate_outcome(&declaration, "refused", Some(&error.code), false)
                    .await;
                return Err(error);
            }
        }

        let _action = if matches!(tool, "navigate" | "close_tab") {
            Some(self.action_lock.lock().await)
        } else {
            None
        };
        let response = async {
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
            let cancelled = {
                let mut state = self.lock();
                if let Some(session) = state.sessions.get_mut(&session_id) {
                    session.tabs.remove(&tab_id);
                }
                remove_actions_matching(&mut state, |key| {
                    key.session_id == session_id && key.tab_id == tab_id
                })
            };
            for pending in &cancelled {
                self.finish_approval(
                    pending,
                    "cancelled_by_task_end",
                    "browser_action_cancelled_by_task_end",
                )
                .await?;
                tracing::info!(action_id = %pending.approval_id, outcome = "cancelled_by_task_end", "browser approval state changed");
            }
            if !cancelled.is_empty() {
                self.notify_approvals_changed();
            }
        }
            Ok::<TransportResponse, AppError>(response)
        }
        .await;
        self.finish_declared_response(&declaration, response).await
    }

    async fn execute_attended_interaction(
        &self,
        transport: Arc<dyn BrowserTransport>,
        tool: &str,
        arguments: Value,
    ) -> Result<Value, AppError> {
        let _action = self.action_lock.lock().await;
        self.prune_expired_approvals().await?;
        let key = browser_action_key(tool, &arguments)?;
        if let Some(outcome) = self.lock().resolved_actions.get(&key).cloned() {
            return resolved_action_result(outcome);
        }
        if let Some(approval_id) = self.lock().pending_by_action.get(&key).cloned() {
            return Ok(parked_action_result(&approval_id));
        }

        let declaration = self
            .declare_outcome(BrowserTransportKind::Attended, tool, &key.session_id)
            .await?;

        let inspection = match inspect_attended_reference(transport.as_ref(), &arguments).await {
            Ok(inspection) => inspection,
            Err(error) => {
                self.evaluate_outcome(&declaration, "transport_error", Some(&error.code), false)
                    .await;
                return Err(error);
            }
        };
        let origin = match normalized_origin(&inspection.url) {
            Ok(origin) => origin,
            Err(error) => {
                self.evaluate_outcome(&declaration, "refused", Some(&error.code), false)
                    .await;
                return Err(error);
            }
        };
        let action = match managed_action(tool, &key.value) {
            Ok(action) => action,
            Err(error) => {
                self.evaluate_outcome(&declaration, "refused", Some(&error.code), false)
                    .await;
                return Err(error);
            }
        };
        match classify_managed_action(action, &inspection.element) {
            ActionClass::SensitiveField => {
                let error = AppError::new(
                    "browser_human_takeover_required",
                    "This field requires you to take over in the browser tab.",
                );
                self.evaluate_outcome(&declaration, "refused", Some(&error.code), false)
                    .await;
                return Err(error);
            }
            ActionClass::Routine => {
                return self
                    .finish_declared_response(
                        &declaration,
                        act_on_attended_reference(
                            transport.as_ref(),
                            tool,
                            arguments,
                            &inspection.element,
                        )
                        .await,
                    )
                    .await;
            }
            ActionClass::Consequential => {}
        }

        let site_allowed = self
            .lock()
            .sessions
            .get(&key.session_id)
            .is_some_and(|session| session.allowed_origins.contains(&origin));
        if site_allowed {
            return self
                .finish_declared_response(
                    &declaration,
                    act_on_attended_reference(
                        transport.as_ref(),
                        tool,
                        arguments,
                        &inspection.element,
                    )
                    .await,
                )
                .await;
        }

        let approval_id = uuid::Uuid::new_v4().simple().to_string();
        let pending = PendingBrowserAction {
            approval_id: approval_id.clone(),
            key: key.clone(),
            origin,
            element: inspection.element,
            requested_at_ms: now_ms(),
            ledger_action_id: declaration.id.clone(),
        };
        self.park_outcome(&declaration, &approval_id).await?;
        {
            let mut state = self.lock();
            state.pending_by_action.insert(key, approval_id.clone());
            state.pending_approvals.insert(approval_id.clone(), pending);
        }
        tracing::info!(action_id = %approval_id, outcome = "parked", "browser approval state changed");
        self.notify_approvals_changed();
        Ok(parked_action_result(&approval_id))
    }

    pub(crate) async fn respond_to_approval(
        &self,
        approval_id: &str,
        approve: bool,
        allow_site: bool,
    ) -> Result<(), AppError> {
        let _action = self.action_lock.lock().await;
        let pending = {
            let state = self.lock();
            let Some(pending) = state.pending_approvals.get(approval_id).cloned() else {
                return Err(AppError::new(
                    "browser_approval_not_found",
                    "That browser approval is no longer pending.",
                ));
            };
            pending
        };
        let declaration = BrowserOutcomeDeclaration {
            id: pending.ledger_action_id.clone(),
            session_id: pending.key.session_id.clone(),
            outcome_class: Some(BrowserOutcomeClass::ActionReceipt),
        };

        if now_ms().saturating_sub(pending.requested_at_ms) >= BROWSER_APPROVAL_TIMEOUT_MS {
            self.finish_approval(&pending, "expired", "browser_approval_expired")
                .await?;
            {
                let mut state = self.lock();
                state.pending_approvals.remove(approval_id);
                state.pending_by_action.remove(&pending.key);
                state
                    .resolved_actions
                    .insert(pending.key, BrowserActionOutcome::NotExecuted);
            }
            tracing::info!(action_id = %approval_id, outcome = "expired", "browser approval state changed");
            self.notify_approvals_changed();
            return Err(AppError::new(
                "browser_approval_expired",
                "The browser action was not executed because the approval expired.",
            ));
        }

        if !approve {
            self.finish_approval(&pending, "declined", "browser_action_declined")
                .await?;
            {
                let mut state = self.lock();
                state.pending_approvals.remove(approval_id);
                state.pending_by_action.remove(&pending.key);
                state
                    .resolved_actions
                    .insert(pending.key, BrowserActionOutcome::Declined);
            }
            tracing::info!(action_id = %approval_id, outcome = "declined", "browser approval state changed");
            self.notify_approvals_changed();
            return Ok(());
        }

        {
            let mut state = self.lock();
            state.pending_approvals.remove(approval_id);
            state.pending_by_action.remove(&pending.key);
        }
        self.notify_approvals_changed();

        if let Err(error) = self.require_enabled() {
            self.evaluate_outcome(&declaration, "refused", Some(&error.code), false)
                .await;
            return Err(error);
        }
        if let Err(error) = self.require_transport_enabled(
            BrowserTransportKind::Attended,
            "approve_action",
            &json!({ "session_id": &pending.key.session_id }),
            None,
        ) {
            self.evaluate_outcome(&declaration, "refused", Some(&error.code), false)
                .await;
            return Err(error);
        }
        let transport = {
            let state = self.lock();
            match state.sessions.get(&pending.key.session_id) {
                None => Err(AppError::new(
                    "browser_action_not_executed",
                    "The browser action was not executed because its task ended.",
                )),
                Some(session)
                    if session.transport_kind != BrowserTransportKind::Attended
                        || !session.tabs.contains(&pending.key.tab_id) =>
                {
                    Err(AppError::new(
                    "browser_action_not_executed",
                    "The browser action was not executed because its tab is no longer available.",
                    ))
                }
                Some(_) => state
                    .transports
                    .get(&BrowserTransportKind::Attended)
                    .cloned()
                    .ok_or_else(|| {
                        AppError::new(
                            "browser_action_not_executed",
                            "The browser action was not executed because its transport is unavailable.",
                        )
                    }),
            }
        };
        let transport = match transport {
            Ok(transport) => transport,
            Err(error) => {
                self.evaluate_outcome(&declaration, "refused", Some(&error.code), false)
                    .await;
                return Err(error);
            }
        };

        let arguments = action_arguments(&pending.key);
        let execution = async {
            let inspection = inspect_attended_reference(transport.as_ref(), &arguments).await?;
            if inspection.element != pending.element
                || normalized_origin(&inspection.url)? != pending.origin
                || classify_managed_action(
                    managed_action(&pending.key.tool, &pending.key.value)?,
                    &inspection.element,
                ) != ActionClass::Consequential
            {
                return Err(AppError::new(
                    "browser_stale_reference",
                    "The browser action was not executed because the element changed.",
                ));
            }
            let response = act_on_attended_reference(
                transport.as_ref(),
                &pending.key.tool,
                arguments,
                &pending.element,
            )
            .await?;
            self.finish_response(response)?;
            Ok::<(), AppError>(())
        }
        .await;

        match execution {
            Ok(()) => {
                {
                    let mut state = self.lock();
                    if allow_site {
                        if let Some(session) = state.sessions.get_mut(&pending.key.session_id) {
                            session.allowed_origins.insert(pending.origin.clone());
                        }
                    }
                    state
                        .resolved_actions
                        .insert(pending.key.clone(), BrowserActionOutcome::Executed);
                }
                // Record the irreversible in-memory outcome before fallible
                // ledger bookkeeping. A retry must never execute the action a
                // second time just because the approval receipt could not be
                // persisted.
                self.record_approval_event(&pending, "approved").await?;
                self.evaluate_outcome(&declaration, "executed", None, true)
                    .await;
                tracing::info!(action_id = %approval_id, outcome = "approved", "browser approval state changed");
                Ok(())
            }
            Err(error) => {
                let outcome = if error.code == "browser_stale_reference" {
                    BrowserActionOutcome::Stale
                } else {
                    BrowserActionOutcome::NotExecuted
                };
                self.lock().resolved_actions.insert(pending.key, outcome);
                let result_kind = if is_broker_refusal_code(&error.code) {
                    "refused"
                } else {
                    "transport_error"
                };
                self.evaluate_outcome(&declaration, result_kind, Some(&error.code), false)
                    .await;
                Err(error)
            }
        }
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

fn browser_action_key(tool: &str, arguments: &Value) -> Result<BrowserActionKey, AppError> {
    let value = match tool {
        "click" => String::new(),
        "fill" => arguments
            .get("text")
            .and_then(Value::as_str)
            .ok_or_else(|| AppError::new("invalid_arguments", "text is required."))?
            .to_string(),
        "press" => required_string(arguments, "key")?.to_string(),
        _ => {
            return Err(AppError::new(
                "unknown_browser_tool",
                "Unknown browser interaction tool.",
            ))
        }
    };
    Ok(BrowserActionKey {
        session_id: required_string(arguments, "session_id")?.to_string(),
        tab_id: arguments
            .get("tab_id")
            .and_then(Value::as_i64)
            .ok_or_else(|| AppError::new("invalid_arguments", "tab_id is required."))?,
        tool: tool.to_string(),
        reference: required_string(arguments, "ref")?.to_string(),
        value,
    })
}

fn action_arguments(key: &BrowserActionKey) -> Value {
    let mut arguments = json!({
        "session_id": key.session_id,
        "tab_id": key.tab_id,
        "ref": key.reference,
    });
    match key.tool.as_str() {
        "fill" => arguments["text"] = Value::String(key.value.clone()),
        "press" => arguments["key"] = Value::String(key.value.clone()),
        _ => {}
    }
    arguments
}

fn managed_action<'a>(tool: &str, value: &'a str) -> Result<ManagedAction<'a>, AppError> {
    match tool {
        "click" => Ok(ManagedAction::Click),
        "fill" => Ok(ManagedAction::Fill),
        "press" => Ok(ManagedAction::Press(value)),
        _ => Err(AppError::new(
            "unknown_browser_tool",
            "Unknown browser interaction tool.",
        )),
    }
}

async fn inspect_attended_reference(
    transport: &dyn BrowserTransport,
    arguments: &Value,
) -> Result<AttendedReferenceInspection, AppError> {
    let response = transport
        .execute(
            "inspect_reference",
            json!({
                "session_id": required_string(arguments, "session_id")?,
                "tab_id": arguments.get("tab_id").and_then(Value::as_i64).ok_or_else(|| {
                    AppError::new("invalid_arguments", "tab_id is required.")
                })?,
                "ref": required_string(arguments, "ref")?,
            }),
        )
        .await?;
    serde_json::from_value(response.data).map_err(|_| {
        AppError::new(
            "extension_response_invalid",
            "The extension returned invalid element facts.",
        )
    })
}

async fn act_on_attended_reference(
    transport: &dyn BrowserTransport,
    tool: &str,
    mut arguments: Value,
    expected: &InteractiveElement,
) -> Result<TransportResponse, AppError> {
    arguments["expected"] = serde_json::to_value(expected).map_err(|_| {
        AppError::new(
            "browser_reference_failed",
            "The browser action could not verify the element.",
        )
    })?;
    transport.execute(tool, arguments).await
}

fn normalized_origin(raw: &str) -> Result<String, AppError> {
    let url = reqwest::Url::parse(raw).map_err(|_| {
        AppError::new(
            "browser_stale_reference",
            "The browser action was not executed because the tab location changed.",
        )
    })?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return Err(AppError::new(
            "browser_stale_reference",
            "The browser action was not executed because the tab location changed.",
        ));
    }
    Ok(url.origin().ascii_serialization())
}

fn parked_action_result(approval_id: &str) -> Value {
    json!({
        "parked": true,
        "actionId": approval_id,
        "message": "Waiting for your approval in June.",
    })
}

fn resolved_action_result(outcome: BrowserActionOutcome) -> Result<Value, AppError> {
    match outcome {
        BrowserActionOutcome::Executed => Ok(json!({ "executed": true })),
        BrowserActionOutcome::Declined => Err(AppError::new(
            "browser_action_declined",
            "The browser action was not executed because the user declined it.",
        )),
        BrowserActionOutcome::Stale => Err(AppError::new(
            "browser_stale_reference",
            "The browser action was not executed because the element changed.",
        )),
        BrowserActionOutcome::NotExecuted => Err(AppError::new(
            "browser_action_not_executed",
            "The browser action was not executed.",
        )),
    }
}

fn remove_actions_matching(
    state: &mut BrowserBrokerState,
    predicate: impl Fn(&BrowserActionKey) -> bool,
) -> Vec<PendingBrowserAction> {
    let pending_ids = state
        .pending_approvals
        .iter()
        .filter(|(_, pending)| predicate(&pending.key))
        .map(|(id, _)| id.clone())
        .collect::<Vec<_>>();
    let mut removed = Vec::with_capacity(pending_ids.len());
    for id in &pending_ids {
        if let Some(pending) = state.pending_approvals.remove(id) {
            state.pending_by_action.remove(&pending.key);
            removed.push(pending);
        }
    }
    state.resolved_actions.retain(|key, _| !predicate(key));
    removed
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn outcome_ledger_error(error: sqlx::Error) -> AppError {
    tracing::error!(error = %error, "browser outcome ledger persistence failed");
    AppError::new(
        "browser_outcome_ledger_failed",
        "The browser outcome could not be recorded.",
    )
}

fn is_broker_refusal_code(code: &str) -> bool {
    matches!(
        code,
        "browser_access_disabled"
            | "browser_routine_not_opted_in"
            | "browser_policy_blocked"
            | "browser_consequential_action_blocked"
            | "browser_sensitive_field_blocked"
            | "browser_human_takeover_required"
            | "browser_url_invalid"
            | "browser_url_not_allowed"
            | "browser_tool_unavailable"
            | "browser_action_declined"
            | "browser_action_not_executed"
            | "browser_approval_expired"
            | "browser_stale_reference"
            | "tab_not_owned"
    )
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

fn extension_request_error(message: String, response: &Value) -> AppError {
    let code = response
        .get("errorCode")
        .and_then(Value::as_str)
        .filter(|code| {
            matches!(
                *code,
                "session_exists"
                    | "session_not_found"
                    | "tab_not_owned"
                    | "invalid_arguments"
                    | "navigation_failed"
                    | "navigation_timeout"
                    | "tab_open_failed"
                    | "snapshot_invalidated"
                    | "screenshot_failed"
                    | "browser_reference_invalid"
                    | "browser_stale_reference"
                    | "browser_action_unsupported"
                    | "not_implemented"
                    | "share_not_found"
                    | "tab_already_owned"
            )
        })
        .unwrap_or("extension_request_failed");
    AppError::new(code, message)
}

fn extension_failure_message(tool: &str, arguments: &Value) -> String {
    let session_id = arguments.get("session_id").and_then(Value::as_str);
    let tab_id = arguments.get("tab_id").and_then(Value::as_i64);
    match (session_id, tab_id) {
        (Some(session_id), Some(tab_id)) => {
            format!("Browser operation {tool} failed for session {session_id} on tab {tab_id}.")
        }
        (Some(session_id), None) => {
            format!("Browser operation {tool} failed for session {session_id}.")
        }
        _ => format!("Browser operation {tool} failed."),
    }
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

    async fn test_outcome_repositories() -> Repositories {
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
        let scheme = validate_attended_url("file:///tmp/private-page-text")
            .expect_err("scheme must be refused");
        assert_eq!(scheme.code, "browser_url_not_allowed");
        assert!(!scheme.message.contains("private-page-text"));

        let credentials = validate_attended_url("https://user:secret@example.com/field-value")
            .expect_err("credentials must be refused");
        assert_eq!(credentials.code, "browser_url_not_allowed");
        assert!(!credentials.message.contains("example.com"));
        assert!(!credentials.message.contains("secret"));
        assert!(!credentials.message.contains("field-value"));
    }

    #[test]
    fn extension_failure_omits_message_and_argument_content() {
        let arguments = json!({
            "session_id": "session-123",
            "tab_id": 42,
            "url": "https://private.example/secret",
            "text": "field-value-123",
        });
        let response = json!({
            "success": false,
            "errorCode": "navigation_failed",
            "message": "Page text from https://private.example/secret: field-value-123",
        });

        let error =
            extension_request_error(extension_failure_message("navigate", &arguments), &response);

        assert_eq!(error.code, "navigation_failed");
        assert!(error.message.contains("navigate"));
        assert!(error.message.contains("session-123"));
        assert!(error.message.contains("tab 42"));
        assert!(!error.message.contains("private.example"));
        assert!(!error.message.contains("Page text"));
        assert!(!error.message.contains("field-value-123"));
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
        let shared = broker
            .execute(
                BrowserTransportKind::Attended,
                "accept_shared_tab",
                json!({ "session_id": session_id, "share_id": "one-use-share" }),
            )
            .await
            .expect("accept explicitly shared tab");
        assert_eq!(shared["tabId"], 8);
        assert!(broker.release_tab(8).await.expect("release shared tab"));
        let revoked = broker
            .execute(
                BrowserTransportKind::Attended,
                "snapshot",
                json!({ "session_id": session_id, "tab_id": 8 }),
            )
            .await
            .expect_err("a user-revoked shared tab stops being actionable");
        assert_eq!(revoked.code, "tab_not_owned");
        broker
            .execute(
                BrowserTransportKind::Attended,
                "accept_shared_tab",
                json!({ "session_id": session_id, "share_id": "replacement-share" }),
            )
            .await
            .expect("the user can explicitly share the tab again");

        let listed = broker
            .execute(
                BrowserTransportKind::Attended,
                "list_tabs",
                json!({ "session_id": session_id }),
            )
            .await
            .expect("list");
        assert_eq!(listed["tabs"].as_array().expect("tabs").len(), 2);
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
                "back",
                json!({ "session_id": session_id, "tab_id": 7 }),
            )
            .await
            .expect_err("back stays out of scope");
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

    struct OutcomeLedgerTransport {
        repositories: Repositories,
        declarations_seen: std::sync::atomic::AtomicUsize,
    }

    impl BrowserTransport for OutcomeLedgerTransport {
        fn execute<'a>(&'a self, tool: &'a str, arguments: Value) -> TransportFuture<'a> {
            Box::pin(async move {
                if matches!(tool, "navigate" | "screenshot" | "click" | "fill") {
                    let session_id = required_string(&arguments, "session_id")?;
                    let rows = self
                        .repositories
                        .browser_action_outcomes_for_session(session_id)
                        .await
                        .map_err(outcome_ledger_error)?;
                    let declared = rows
                        .iter()
                        .rev()
                        .find(|row| row.operation == tool)
                        .expect("outcome is declared before transport dispatch");
                    assert_eq!(declared.result_kind, "pending");
                    assert!(declared.evaluated_at.is_none());
                    self.declarations_seen
                        .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                }
                match tool {
                    "screenshot" => Ok(TransportResponse::artifact(
                        json!({}),
                        TransportArtifact {
                            kind: "screenshot".into(),
                            mime_type: "image/png".into(),
                            bytes: b"sentinel screenshot body".to_vec(),
                        },
                    )),
                    "click" => Err(AppError::new(
                        "browser_consequential_action_blocked",
                        "The managed browser refused the action.",
                    )),
                    "fill" => Err(AppError::new(
                        "browser_command_failed",
                        "The browser transport failed.",
                    )),
                    _ => Ok(TransportResponse::data(json!({}))),
                }
            })
        }
    }

    async fn managed_outcome_broker() -> (
        tempfile::TempDir,
        BrowserBroker,
        Arc<OutcomeLedgerTransport>,
        Repositories,
        String,
    ) {
        let temp = tempfile::tempdir().expect("tempdir");
        let flag = temp.path().join("browser-access");
        std::fs::write(&flag, b"1").expect("grant");
        let repositories = test_outcome_repositories().await;
        let transport = Arc::new(OutcomeLedgerTransport {
            repositories: repositories.clone(),
            declarations_seen: std::sync::atomic::AtomicUsize::new(0),
        });
        let broker = BrowserBroker::default();
        broker.set_access_flag_path(flag);
        broker.configure_outcome_repository(repositories.clone());
        broker.configure_transport(
            BrowserTransportKind::Managed,
            transport.clone(),
            temp.path().join("images"),
            temp.path().join("artifacts"),
        );
        broker.set_routine_grant(RoutineBrowserGrant {
            job_id: "job-1".into(),
            server_name: "june_browser_routine_job1".into(),
            token: "token".into(),
            enabled: true,
        });
        let started = broker
            .execute_for(
                BrowserBrokerContext::Routine("job-1".into()),
                "start_session",
                json!({}),
            )
            .await
            .expect("start managed session");
        let session_id = started["sessionId"]
            .as_str()
            .expect("session id")
            .to_string();
        (temp, broker, transport, repositories, session_id)
    }

    #[tokio::test]
    async fn managed_transport_confirmations_verify_predeclared_outcomes() {
        let (_temp, broker, transport, repositories, session_id) = managed_outcome_broker().await;
        broker
            .execute_for(
                BrowserBrokerContext::Routine("job-1".into()),
                "navigate",
                json!({
                    "session_id": &session_id,
                    "url": "https://sentinel.invalid/private",
                }),
            )
            .await
            .expect("navigate");
        broker
            .execute_for(
                BrowserBrokerContext::Routine("job-1".into()),
                "screenshot",
                json!({ "session_id": &session_id }),
            )
            .await
            .expect("screenshot");

        assert_eq!(
            transport
                .declarations_seen
                .load(std::sync::atomic::Ordering::SeqCst),
            2
        );
        let rows = repositories
            .browser_action_outcomes_for_session(&session_id)
            .await
            .expect("ledger rows");
        let navigate = rows
            .iter()
            .find(|row| row.operation == "navigate")
            .expect("navigate row");
        assert_eq!(navigate.outcome_class.as_deref(), Some("target_state"));
        assert!(navigate.outcome_verified);
        let screenshot = rows
            .iter()
            .find(|row| row.operation == "screenshot")
            .expect("screenshot row");
        assert_eq!(screenshot.outcome_class.as_deref(), Some("artifact"));
        assert!(screenshot.outcome_verified);
        assert!(!format!("{rows:?}").contains("sentinel.invalid"));
        assert!(!format!("{rows:?}").contains("sentinel screenshot body"));
    }

    #[tokio::test]
    async fn agent_lied_case_records_policy_and_transport_failures_without_success() {
        let (_temp, broker, transport, repositories, session_id) = managed_outcome_broker().await;
        let refused = broker
            .execute_for(
                BrowserBrokerContext::Routine("job-1".into()),
                "click",
                json!({ "session_id": &session_id, "ref": "sentinel-label" }),
            )
            .await
            .expect_err("policy refusal");
        assert_eq!(refused.code, "browser_consequential_action_blocked");
        let failed = broker
            .execute_for(
                BrowserBrokerContext::Routine("job-1".into()),
                "fill",
                json!({
                    "session_id": &session_id,
                    "ref": "sentinel-label",
                    "text": "sentinel-field-value",
                }),
            )
            .await
            .expect_err("transport error");
        assert_eq!(failed.code, "browser_command_failed");

        assert_eq!(
            transport
                .declarations_seen
                .load(std::sync::atomic::Ordering::SeqCst),
            2
        );
        let rows = repositories
            .browser_action_outcomes_for_session(&session_id)
            .await
            .expect("ledger rows");
        let click = rows
            .iter()
            .find(|row| row.operation == "click")
            .expect("click row");
        assert_eq!(click.result_kind, "refused");
        assert_eq!(
            click.result_code_class.as_deref(),
            Some("browser_consequential_action_blocked")
        );
        let fill = rows
            .iter()
            .find(|row| row.operation == "fill")
            .expect("fill row");
        assert_eq!(fill.result_kind, "transport_error");
        assert_eq!(
            fill.result_code_class.as_deref(),
            Some("browser_command_failed")
        );
        assert!(rows.iter().all(|row| !row.outcome_verified));
        let serialized = format!("{rows:?}");
        assert!(!serialized.contains("sentinel-label"));
        assert!(!serialized.contains("sentinel-field-value"));
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
                    "accept_shared_tab" => json!({ "tabId": 8, "shared": true }),
                    "list_tabs" => json!({
                        "tabs": [
                            { "tabId": 7, "title": "Owned", "url": "about:blank" },
                            { "tabId": 8, "title": "Shared", "url": "https://example.com" },
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
    async fn remote_transport_policy_refuses_each_transport_independently() {
        let temp = tempfile::tempdir().expect("tempdir");
        let flag = temp.path().join("browser-access");
        std::fs::write(&flag, b"1").expect("grant");
        let broker = BrowserBroker::default();
        broker.set_access_flag_path(flag);
        for kind in [
            BrowserTransportKind::Attended,
            BrowserTransportKind::Managed,
        ] {
            broker.configure_transport(
                kind,
                Arc::new(FakeTransport),
                temp.path().join(format!("{}-images", kind.as_str())),
                temp.path().join(format!("{}-artifacts", kind.as_str())),
            );
        }
        broker.set_routine_grant(RoutineBrowserGrant {
            job_id: "routine-1".into(),
            server_name: "june_browser_routine_1".into(),
            token: "routine-token".into(),
            enabled: true,
        });

        broker
            .set_transport_policy(BrowserTransportPolicy {
                attended_enabled: false,
                managed_enabled: true,
            })
            .await;
        let attended = broker
            .execute_for(
                BrowserBrokerContext::Attended,
                "start_session",
                json!({ "url": "https://private.example/secret" }),
            )
            .await
            .expect_err("attended transport must be disabled");
        assert_eq!(attended.code, "browser_transport_disabled_remotely");
        assert_eq!(
            attended
                .details
                .as_ref()
                .and_then(|value| value["operation"].as_str()),
            Some("start_session")
        );
        assert!(!attended.message.contains("private.example"));
        broker
            .execute_for(
                BrowserBrokerContext::Routine("routine-1".into()),
                "start_session",
                json!({}),
            )
            .await
            .expect("managed transport stays enabled");

        broker
            .set_transport_policy(BrowserTransportPolicy {
                attended_enabled: true,
                managed_enabled: false,
            })
            .await;
        broker
            .execute_for(BrowserBrokerContext::Attended, "start_session", json!({}))
            .await
            .expect("attended transport stays enabled");
        let managed = broker
            .execute_for(
                BrowserBrokerContext::Routine("routine-1".into()),
                "start_session",
                json!({}),
            )
            .await
            .expect_err("managed transport must be disabled");
        assert_eq!(managed.code, "browser_transport_disabled_remotely");
        assert_eq!(
            managed
                .details
                .as_ref()
                .and_then(|value| value["routineId"].as_str()),
            Some("routine-1")
        );

        broker
            .set_transport_policy(BrowserTransportPolicy {
                attended_enabled: false,
                managed_enabled: false,
            })
            .await;
        for context in [
            BrowserBrokerContext::Attended,
            BrowserBrokerContext::Routine("routine-1".into()),
        ] {
            let error = broker
                .execute_for(context, "start_session", json!({}))
                .await
                .expect_err("both transports must be disabled");
            assert_eq!(error.code, "browser_transport_disabled_remotely");
        }
    }

    #[derive(Default)]
    struct TeardownTrackingTransport {
        closed: std::sync::atomic::AtomicUsize,
        terminated: std::sync::atomic::AtomicUsize,
    }

    impl BrowserTransport for TeardownTrackingTransport {
        fn execute<'a>(&'a self, tool: &'a str, _arguments: Value) -> TransportFuture<'a> {
            Box::pin(async move {
                if tool == "close_session" {
                    self.closed
                        .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                }
                Ok(TransportResponse::data(json!({})))
            })
        }

        fn terminate_session(&self, _session_id: &str) {
            self.terminated
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        }
    }

    #[tokio::test]
    async fn remote_kill_ends_only_live_sessions_for_that_transport() {
        let temp = tempfile::tempdir().expect("tempdir");
        let flag = temp.path().join("browser-access");
        std::fs::write(&flag, b"1").expect("grant");
        let attended = Arc::new(TeardownTrackingTransport::default());
        let managed = Arc::new(TeardownTrackingTransport::default());
        let broker = BrowserBroker::default();
        broker.set_access_flag_path(flag);
        broker.configure_transport(
            BrowserTransportKind::Attended,
            attended.clone(),
            temp.path().join("attended-images"),
            temp.path().join("attended-artifacts"),
        );
        broker.configure_transport(
            BrowserTransportKind::Managed,
            managed.clone(),
            temp.path().join("managed-images"),
            temp.path().join("managed-artifacts"),
        );
        broker
            .execute(BrowserTransportKind::Attended, "start_session", json!({}))
            .await
            .expect("attended start");
        let managed_session = broker
            .execute(BrowserTransportKind::Managed, "start_session", json!({}))
            .await
            .expect("managed start");

        broker
            .set_transport_policy(BrowserTransportPolicy {
                attended_enabled: false,
                managed_enabled: true,
            })
            .await;

        assert_eq!(broker.active_session_count(), 1);
        assert_eq!(
            attended
                .terminated
                .load(std::sync::atomic::Ordering::SeqCst),
            1
        );
        assert_eq!(attended.closed.load(std::sync::atomic::Ordering::SeqCst), 1);
        assert_eq!(
            managed.terminated.load(std::sync::atomic::Ordering::SeqCst),
            0
        );
        assert_eq!(managed.closed.load(std::sync::atomic::Ordering::SeqCst), 0);
        broker
            .execute(
                BrowserTransportKind::Managed,
                "snapshot",
                json!({ "session_id": managed_session["sessionId"] }),
            )
            .await
            .expect("managed session remains live");
    }

    struct AttendedInteractionTransport {
        element: Mutex<InteractiveElement>,
        url: Mutex<String>,
        action_count: std::sync::atomic::AtomicUsize,
        closed: std::sync::atomic::AtomicUsize,
        terminated: std::sync::atomic::AtomicUsize,
    }

    impl AttendedInteractionTransport {
        fn consequential(label: &str) -> Self {
            Self {
                element: Mutex::new(InteractiveElement {
                    tag: "button".into(),
                    input_type: "button".into(),
                    label: label.into(),
                    ..InteractiveElement::default()
                }),
                url: Mutex::new("https://example.com:443/checkout".into()),
                action_count: std::sync::atomic::AtomicUsize::new(0),
                closed: std::sync::atomic::AtomicUsize::new(0),
                terminated: std::sync::atomic::AtomicUsize::new(0),
            }
        }

        fn set_element(&self, element: InteractiveElement) {
            *self
                .element
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner) = element;
        }

        fn set_url(&self, url: &str) {
            *self
                .url
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner) = url.to_string();
        }

        fn action_count(&self) -> usize {
            self.action_count.load(std::sync::atomic::Ordering::SeqCst)
        }
    }

    impl BrowserTransport for AttendedInteractionTransport {
        fn execute<'a>(&'a self, tool: &'a str, arguments: Value) -> TransportFuture<'a> {
            Box::pin(async move {
                let data = match tool {
                    "open_tab" => json!({ "tabId": 7, "url": "about:blank" }),
                    "inspect_reference" => json!({
                        "element": self.element.lock().unwrap_or_else(std::sync::PoisonError::into_inner).clone(),
                        "url": self.url.lock().unwrap_or_else(std::sync::PoisonError::into_inner).clone(),
                    }),
                    "click" | "fill" | "press" => {
                        let expected = serde_json::from_value::<InteractiveElement>(
                            arguments.get("expected").cloned().unwrap_or(Value::Null),
                        )
                        .map_err(|_| AppError::new("invalid_arguments", "expected is required"))?;
                        let current = self
                            .element
                            .lock()
                            .unwrap_or_else(std::sync::PoisonError::into_inner)
                            .clone();
                        if current != expected {
                            return Err(AppError::new(
                                "browser_stale_reference",
                                "The element changed.",
                            ));
                        }
                        self.action_count
                            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                        json!({ "epoch": 1, "snapshot": "fresh snapshot" })
                    }
                    "close_session" => {
                        self.closed
                            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                        json!({})
                    }
                    _ => json!({}),
                };
                Ok(TransportResponse::data(data))
            })
        }

        fn terminate_session(&self, _session_id: &str) {
            self.terminated
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        }
    }

    async fn attended_interaction_broker(
        label: &str,
    ) -> (
        tempfile::TempDir,
        BrowserBroker,
        Arc<AttendedInteractionTransport>,
        String,
        Repositories,
    ) {
        let temp = tempfile::tempdir().expect("tempdir");
        let flag = temp.path().join("browser-access");
        std::fs::write(&flag, b"1").expect("grant");
        let transport = Arc::new(AttendedInteractionTransport::consequential(label));
        let repositories = test_outcome_repositories().await;
        let broker = BrowserBroker::default();
        broker.set_access_flag_path(flag);
        broker.configure_outcome_repository(repositories.clone());
        broker.configure_transport(
            BrowserTransportKind::Attended,
            transport.clone(),
            temp.path().join("images"),
            temp.path().join("artifacts"),
        );
        let started = broker
            .execute(BrowserTransportKind::Attended, "start_session", json!({}))
            .await
            .expect("start attended session");
        let session_id = started["sessionId"]
            .as_str()
            .expect("session id")
            .to_string();
        broker
            .execute(
                BrowserTransportKind::Attended,
                "open_tab",
                json!({ "session_id": &session_id }),
            )
            .await
            .expect("open task tab");
        (temp, broker, transport, session_id, repositories)
    }

    fn click_arguments(session_id: &str, reference: &str) -> Value {
        json!({ "session_id": session_id, "tab_id": 7, "ref": reference })
    }

    #[tokio::test]
    async fn consequential_action_parks_then_approve_executes_exactly_once() {
        let (_temp, broker, transport, session_id, repositories) =
            attended_interaction_broker("Purchase sentinel element label").await;
        transport.set_url("https://sentinel.invalid/private?value=sentinel-field-value");
        let arguments = click_arguments(&session_id, "e0:n1");
        let parked = broker
            .execute(BrowserTransportKind::Attended, "click", arguments.clone())
            .await
            .expect("park consequential click");
        assert_eq!(parked["parked"], true);
        assert_eq!(transport.action_count(), 0);
        let approval_id = parked["actionId"].as_str().expect("action id");
        assert_eq!(broker.pending_approvals().await.expect("pending").len(), 1);

        broker
            .respond_to_approval(approval_id, true, false)
            .await
            .expect("approve");
        assert_eq!(transport.action_count(), 1);
        assert!(broker
            .pending_approvals()
            .await
            .expect("pending")
            .is_empty());

        let replay = broker
            .execute(BrowserTransportKind::Attended, "click", arguments)
            .await
            .expect("completed action replay");
        assert_eq!(replay["executed"], true);
        assert_eq!(transport.action_count(), 1);

        let counts = repositories.browser_outcome_counts().await.expect("counts");
        assert_eq!(counts.parked, 1);
        assert_eq!(counts.approved, 1);
        assert_eq!(counts.verified_successes, 1);
        let rows = repositories
            .browser_action_outcomes_for_session(&session_id)
            .await
            .expect("ledger rows");
        let click = rows
            .iter()
            .find(|row| row.operation == "click")
            .expect("click row");
        assert_eq!(click.outcome_class.as_deref(), Some("action_receipt"));
        assert_eq!(click.result_kind, "executed");
        assert!(click.outcome_verified);
        let serialized = format!("{rows:?}");
        for sentinel in [
            "sentinel.invalid",
            "sentinel element label",
            "sentinel-field-value",
        ] {
            assert!(!serialized.contains(sentinel));
        }
    }

    #[tokio::test]
    async fn approved_action_replay_stays_idempotent_when_ledger_write_fails() {
        let (_temp, broker, transport, session_id, repositories) =
            attended_interaction_broker("Purchase now").await;
        let arguments = click_arguments(&session_id, "e0:n1");
        let parked = broker
            .execute(BrowserTransportKind::Attended, "click", arguments.clone())
            .await
            .expect("park");
        repositories.pool.close().await;

        let error = broker
            .respond_to_approval(parked["actionId"].as_str().unwrap(), true, false)
            .await
            .expect_err("approval receipt write must fail");
        assert_eq!(error.code, "browser_outcome_ledger_failed");
        assert_eq!(transport.action_count(), 1);

        broker.configure_outcome_repository(test_outcome_repositories().await);
        let replay = broker
            .execute(BrowserTransportKind::Attended, "click", arguments)
            .await
            .expect("completed action replay");
        assert_eq!(replay["executed"], true);
        assert_eq!(transport.action_count(), 1);
        assert!(broker
            .pending_approvals()
            .await
            .expect("pending")
            .is_empty());
    }

    #[tokio::test]
    async fn consequential_action_decline_never_executes_and_replays_stable_refusal() {
        let (_temp, broker, transport, session_id, repositories) =
            attended_interaction_broker("Delete account").await;
        let arguments = click_arguments(&session_id, "e0:n1");
        let parked = broker
            .execute(BrowserTransportKind::Attended, "click", arguments.clone())
            .await
            .expect("park");
        broker
            .respond_to_approval(parked["actionId"].as_str().unwrap(), false, false)
            .await
            .expect("decline");
        assert_eq!(transport.action_count(), 0);
        let refusal = broker
            .execute(BrowserTransportKind::Attended, "click", arguments)
            .await
            .expect_err("declined action stays declined");
        assert_eq!(refusal.code, "browser_action_declined");
        assert_eq!(transport.action_count(), 0);
        let counts = repositories.browser_outcome_counts().await.expect("counts");
        assert_eq!(counts.parked, 1);
        assert_eq!(counts.declined, 1);
        assert_eq!(counts.verified_successes, 0);
    }

    #[tokio::test]
    async fn task_end_cancels_parked_action_without_execution() {
        let (_temp, broker, transport, session_id, repositories) =
            attended_interaction_broker("Publish post").await;
        let parked = broker
            .execute(
                BrowserTransportKind::Attended,
                "click",
                click_arguments(&session_id, "e0:n1"),
            )
            .await
            .expect("park");
        broker
            .execute(
                BrowserTransportKind::Attended,
                "close_session",
                json!({ "session_id": session_id }),
            )
            .await
            .expect("end task");
        assert!(broker
            .pending_approvals()
            .await
            .expect("pending")
            .is_empty());
        let refusal = broker
            .respond_to_approval(parked["actionId"].as_str().unwrap(), true, false)
            .await
            .expect_err("ended task cannot approve");
        assert_eq!(refusal.code, "browser_approval_not_found");
        assert_eq!(transport.action_count(), 0);
        let counts = repositories.browser_outcome_counts().await.expect("counts");
        assert_eq!(counts.parked, 1);
        assert_eq!(counts.cancelled_by_task_end, 1);
        assert_eq!(counts.verified_successes, 0);
    }

    #[tokio::test]
    async fn expired_approval_is_retired_without_execution() {
        let (_temp, broker, transport, session_id, repositories) =
            attended_interaction_broker("Publish post").await;
        let arguments = click_arguments(&session_id, "e0:n1");
        let parked = broker
            .execute(BrowserTransportKind::Attended, "click", arguments.clone())
            .await
            .expect("park");
        let approval_id = parked["actionId"].as_str().unwrap();
        broker
            .lock()
            .pending_approvals
            .get_mut(approval_id)
            .expect("pending approval")
            .requested_at_ms = now_ms().saturating_sub(BROWSER_APPROVAL_TIMEOUT_MS);

        assert!(broker
            .pending_approvals()
            .await
            .expect("pending")
            .is_empty());
        let refusal = broker
            .execute(BrowserTransportKind::Attended, "click", arguments)
            .await
            .expect_err("expired action stays unexecuted");
        assert_eq!(refusal.code, "browser_action_not_executed");
        assert_eq!(transport.action_count(), 0);
        let counts = repositories.browser_outcome_counts().await.expect("counts");
        assert_eq!(counts.parked, 1);
        assert_eq!(counts.expired, 1);
        assert_eq!(counts.verified_successes, 0);
    }

    #[tokio::test]
    async fn grant_revoke_retires_parked_action_without_execution() {
        let (_temp, broker, transport, session_id, repositories) =
            attended_interaction_broker("Send message").await;
        let parked = broker
            .execute(
                BrowserTransportKind::Attended,
                "click",
                click_arguments(&session_id, "e0:n1"),
            )
            .await
            .expect("park");
        broker.set_enabled(false).await.expect("revoke");
        assert!(broker
            .pending_approvals()
            .await
            .expect("pending")
            .is_empty());
        let refusal = broker
            .respond_to_approval(parked["actionId"].as_str().unwrap(), true, false)
            .await
            .expect_err("revoked action cannot be approved");
        assert_eq!(refusal.code, "browser_approval_not_found");
        assert_eq!(transport.action_count(), 0);
        let counts = repositories.browser_outcome_counts().await.expect("counts");
        assert_eq!(counts.parked, 1);
        assert_eq!(counts.cancelled_by_task_end, 1);
        assert_eq!(counts.verified_successes, 0);
    }

    #[tokio::test]
    async fn grant_revoke_tears_down_sessions_when_ledger_write_fails() {
        let (_temp, broker, transport, session_id, repositories) =
            attended_interaction_broker("Send message").await;
        broker
            .execute(
                BrowserTransportKind::Attended,
                "click",
                click_arguments(&session_id, "e0:n1"),
            )
            .await
            .expect("park");
        repositories.pool.close().await;

        broker
            .set_enabled(false)
            .await
            .expect("revocation remains authoritative");

        assert_eq!(broker.active_session_count(), 0);
        assert_eq!(
            transport
                .terminated
                .load(std::sync::atomic::Ordering::SeqCst),
            1
        );
        assert_eq!(
            transport.closed.load(std::sync::atomic::Ordering::SeqCst),
            1
        );
        assert!(broker
            .pending_approvals()
            .await
            .expect("pending")
            .is_empty());
    }

    #[tokio::test]
    async fn site_allow_skips_parking_then_expires_with_task() {
        let (_temp, broker, transport, session_id, _repositories) =
            attended_interaction_broker("Send message").await;
        let first = broker
            .execute(
                BrowserTransportKind::Attended,
                "click",
                click_arguments(&session_id, "e0:n1"),
            )
            .await
            .expect("first park");
        broker
            .respond_to_approval(first["actionId"].as_str().unwrap(), true, true)
            .await
            .expect("approve site");

        let allowed = broker
            .execute(
                BrowserTransportKind::Attended,
                "click",
                click_arguments(&session_id, "e1:n2"),
            )
            .await
            .expect("same origin is allowed");
        assert!(allowed.get("parked").is_none());
        assert_eq!(transport.action_count(), 2);

        broker
            .execute(
                BrowserTransportKind::Attended,
                "close_session",
                json!({ "session_id": session_id }),
            )
            .await
            .expect("close first task");
        let restarted = broker
            .execute(BrowserTransportKind::Attended, "start_session", json!({}))
            .await
            .expect("start second task");
        let second_session = restarted["sessionId"].as_str().unwrap();
        broker
            .execute(
                BrowserTransportKind::Attended,
                "open_tab",
                json!({ "session_id": second_session }),
            )
            .await
            .expect("open second task tab");
        let parked_again = broker
            .execute(
                BrowserTransportKind::Attended,
                "click",
                click_arguments(second_session, "e0:n1"),
            )
            .await
            .expect("new task parks again");
        assert_eq!(parked_again["parked"], true);
        assert_eq!(transport.action_count(), 2);
    }

    #[tokio::test]
    async fn site_allow_uses_exact_normalized_origin_not_subdomains_or_other_ports() {
        let (_temp, broker, transport, session_id, _repositories) =
            attended_interaction_broker("Confirm purchase").await;
        let first = broker
            .execute(
                BrowserTransportKind::Attended,
                "click",
                click_arguments(&session_id, "e0:n1"),
            )
            .await
            .expect("park first origin");
        broker
            .respond_to_approval(first["actionId"].as_str().unwrap(), true, true)
            .await
            .expect("allow exact origin");

        transport.set_url("https://checkout.example.com/next");
        let subdomain = broker
            .execute(
                BrowserTransportKind::Attended,
                "click",
                click_arguments(&session_id, "e1:n2"),
            )
            .await
            .expect("subdomain request");
        assert_eq!(subdomain["parked"], true);

        broker
            .respond_to_approval(subdomain["actionId"].as_str().unwrap(), false, false)
            .await
            .expect("decline subdomain");
        transport.set_url("https://example.com:444/next");
        let other_port = broker
            .execute(
                BrowserTransportKind::Attended,
                "click",
                click_arguments(&session_id, "e1:n3"),
            )
            .await
            .expect("other port request");
        assert_eq!(other_port["parked"], true);
        assert_eq!(transport.action_count(), 1);
    }

    #[tokio::test]
    async fn sensitive_text_input_requires_human_takeover_and_never_dispatches_input() {
        let (_temp, broker, transport, session_id, _repositories) =
            attended_interaction_broker("Password").await;
        transport.set_element(InteractiveElement {
            tag: "input".into(),
            input_type: "password".into(),
            label: "Password".into(),
            ..InteractiveElement::default()
        });
        for (tool, arguments) in [
            (
                "fill",
                json!({
                    "session_id": &session_id,
                    "tab_id": 7,
                    "ref": "e0:n1",
                    "text": "never dispatched",
                }),
            ),
            (
                "press",
                json!({
                    "session_id": &session_id,
                    "tab_id": 7,
                    "ref": "e0:n1",
                    "key": "a",
                }),
            ),
        ] {
            let refusal = broker
                .execute(BrowserTransportKind::Attended, tool, arguments)
                .await
                .expect_err("sensitive input");
            assert_eq!(refusal.code, "browser_human_takeover_required");
            assert!(refusal.message.contains("take over"));
        }
        assert_eq!(transport.action_count(), 0);
        assert!(broker
            .pending_approvals()
            .await
            .expect("pending")
            .is_empty());
    }

    #[tokio::test]
    async fn approve_after_element_facts_change_aborts_without_execution() {
        let (_temp, broker, transport, session_id, _repositories) =
            attended_interaction_broker("Purchase now").await;
        let parked = broker
            .execute(
                BrowserTransportKind::Attended,
                "click",
                click_arguments(&session_id, "e0:n1"),
            )
            .await
            .expect("park");
        transport.set_element(InteractiveElement {
            tag: "button".into(),
            input_type: "button".into(),
            label: "Read details".into(),
            ..InteractiveElement::default()
        });
        let refusal = broker
            .respond_to_approval(parked["actionId"].as_str().unwrap(), true, false)
            .await
            .expect_err("changed facts must abort");
        assert_eq!(refusal.code, "browser_stale_reference");
        assert_eq!(transport.action_count(), 0);
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
