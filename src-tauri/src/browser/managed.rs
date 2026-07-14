//! The managed transport: a headless ephemeral browser session behind the
//! JUN-291 `june_browser` transport seam (JUN-289, the routines track of ADR
//! 0017).
//!
//! One session = one detected system Chromium-family browser launched headless
//! against a fresh throwaway profile, every connection routed through the
//! per-session pinning proxy (`super::proxy`), driven over the CDP pipe
//! (`super::cdp`). Interaction commands resolve only references minted by the
//! latest snapshot. Rust classifies each referenced element before execution;
//! consequential classes are refused because nobody is present to approve.
//!
//! Teardown is Drop-based and layered: [`LaunchedBrowser`] kills the process,
//! [`EphemeralProfile`] deletes the profile, and `PinningProxy` stops its
//! listener. Graceful close, revoke, idle timeout, crash, and app exit all end
//! by dropping (or explicitly closing) the session, so the profile is gone on
//! every path; a startup sweep of the profiles root covers an app that died
//! without dropping anything.
//!
//! Privacy (JUN-316): nothing here logs, prints, or traces URLs, page text,
//! snapshot bodies, or screenshots. Errors name the operation and a session
//! id, never content.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::time::{Duration, Instant};

use base64::Engine as _;
use serde_json::{json, Value};

use crate::browser_broker::{
    BrowserTransport, TransportArtifact, TransportFuture, TransportResponse,
};
use crate::domain::types::AppError;

use super::cdp::CdpClient;
use super::launcher::{self, EphemeralProfile, LaunchedBrowser};
use super::policy::{
    classify_managed_action, resolve_validated, validate_final_public_url,
    validate_public_http_url, ActionClass, InteractiveElement, ManagedAction, PolicyConfig,
    Resolver, SystemResolver,
};
use super::proxy::PinningProxy;

/// How long a navigation may take before the transport stops waiting for the
/// load event and reads whatever the page has become (many pages render
/// usefully long before `load` fires, so this is a wait bound, not a failure).
const LOAD_EVENT_TIMEOUT: Duration = Duration::from_secs(25);

/// Snapshots larger than this travel as a file reference instead of inline
/// text (the contract-wide shape for big payloads, matching the
/// native-messaging size cap on the attended transport).
const SNAPSHOT_INLINE_MAX_BYTES: usize = 200 * 1024;

/// Managed browser processes are intentionally scarce: a runaway routine must
/// not be able to fork an unbounded Chromium fleet.
const MAX_MANAGED_SESSIONS: usize = 2;

/// Managed sessions that have not executed a tool for five minutes are
/// terminated and their profiles deleted.
const MANAGED_SESSION_IDLE_TIMEOUT: Duration = Duration::from_secs(300);

const MANAGED_SESSION_REAPER_INTERVAL: Duration = Duration::from_secs(30);

/// Everything a managed session needs from the broker environment.
pub struct ManagedSessionConfig {
    /// Root directory for this session's artifacts (screenshots, oversized
    /// snapshots). The session creates its own subdirectory under it.
    pub artifacts_root: PathBuf,
    /// Always `PolicyConfig::default()` in production. Tests and the env-gated
    /// E2E harness may allow loopback so fixtures are reachable.
    pub policy: PolicyConfig,
    /// The resolver handed to policy checks and the pinning proxy.
    /// `SystemResolver` in production; injectable for the E2E harness.
    pub resolver: Arc<dyn Resolver>,
}

impl ManagedSessionConfig {
    pub fn production(artifacts_root: PathBuf) -> Self {
        Self {
            artifacts_root,
            policy: PolicyConfig::default(),
            resolver: Arc::new(SystemResolver),
        }
    }
}

/// Starts a managed browser session: detect, profile, proxy, launch, attach.
/// Fails with the actionable no-browser message when no Chromium-family
/// browser is installed.
pub async fn start_managed_session(
    config: ManagedSessionConfig,
) -> Result<Arc<ManagedBrowserSession>, AppError> {
    start_managed_session_with_id(
        config,
        uuid::Uuid::new_v4().to_string(),
        Arc::new(StartingManagedSession::default()),
    )
    .await
}

async fn start_managed_session_with_id(
    config: ManagedSessionConfig,
    id: String,
    starting: Arc<StartingManagedSession>,
) -> Result<Arc<ManagedBrowserSession>, AppError> {
    let detected = launcher::detect_browser()
        .ok_or_else(|| AppError::new("browser_not_found", launcher::NO_BROWSER_MESSAGE))?;

    let profile = EphemeralProfile::create().map_err(|_| start_failed("profile"))?;

    let proxy = PinningProxy::start(Arc::clone(&config.resolver), config.policy.clone())
        .await
        .map_err(|_| start_failed("proxy"))?;

    let mut browser = launcher::launch(&detected.path, profile.path(), proxy.port())
        .map_err(|_| start_failed("launch"))?;
    let (cdp_read, cdp_write) = browser
        .take_cdp_pipes()
        .ok_or_else(|| start_failed("pipes"))?;
    let resources = Arc::new(ManagedSessionResources {
        proxy,
        browser: Mutex::new(browser),
        profile,
        closed: AtomicBool::new(false),
    });
    starting.attach(Arc::clone(&resources))?;
    let cdp = CdpClient::start(cdp_read, cdp_write);

    // Attach to a fresh page target. These calls fail (browser_closed) if the
    // browser died on startup, which also covers a binary that is not actually
    // a Chromium.
    let created = cdp
        .call(None, "Target.createTarget", json!({ "url": "about:blank" }))
        .await
        .map_err(tool_error)?;
    let target_id = created
        .get("targetId")
        .and_then(|value| value.as_str())
        .ok_or_else(|| start_failed("target"))?
        .to_string();
    let attached = cdp
        .call(
            None,
            "Target.attachToTarget",
            json!({ "targetId": target_id, "flatten": true }),
        )
        .await
        .map_err(tool_error)?;
    let cdp_session_id = attached
        .get("sessionId")
        .and_then(|value| value.as_str())
        .ok_or_else(|| start_failed("attach"))?
        .to_string();

    cdp.call(Some(&cdp_session_id), "Page.enable", json!({}))
        .await
        .map_err(tool_error)?;
    cdp.call(Some(&cdp_session_id), "Runtime.enable", json!({}))
        .await
        .map_err(tool_error)?;

    let session = Arc::new(ManagedBrowserSession {
        id,
        cdp,
        cdp_session_id,
        policy: config.policy,
        resolver: config.resolver,
        resources,
        epoch: AtomicU64::new(0),
        last_used: Mutex::new(Instant::now()),
    });

    if starting.is_cancelled() {
        session.teardown();
        return Err(session_closed(&session.id));
    }

    // Crash watcher: if the browser process ends (the CDP pipe closes), tear
    // the session down promptly so the profile does not wait for registry
    // eviction. Holds a Weak so the watcher never keeps a session alive.
    let weak: Weak<ManagedBrowserSession> = Arc::downgrade(&session);
    let mut closed_rx = session.cdp.closed();
    tokio::spawn(async move {
        while !*closed_rx.borrow() {
            if closed_rx.changed().await.is_err() {
                break;
            }
        }
        if let Some(session) = weak.upgrade() {
            session.teardown();
        }
    });

    Ok(session)
}

/// A live managed browser session. All teardown paths converge on
/// [`ManagedBrowserSession::teardown`]; Drop of the owned guards is the
/// backstop when it never ran.
pub struct ManagedBrowserSession {
    id: String,
    cdp: CdpClient,
    cdp_session_id: String,
    policy: PolicyConfig,
    resolver: Arc<dyn Resolver>,
    resources: Arc<ManagedSessionResources>,
    /// Navigation epoch: bumped when a navigation starts, so snapshot
    /// references minted before it are identifiably stale. Interaction tools
    /// (JUN-294, attended transport) must refuse references from an older
    /// epoch instead of acting on the wrong element.
    epoch: AtomicU64,
    last_used: Mutex<Instant>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReferenceInspection {
    status: String,
    #[serde(default)]
    element: Option<InteractiveElement>,
}

#[derive(Debug, serde::Deserialize)]
struct ReferenceActionResult {
    status: String,
}

struct ManagedSessionResources {
    proxy: PinningProxy,
    browser: Mutex<LaunchedBrowser>,
    profile: EphemeralProfile,
    closed: AtomicBool,
}

impl ManagedSessionResources {
    fn teardown(&self) {
        if self.closed.swap(true, Ordering::SeqCst) {
            return;
        }
        if let Ok(mut browser) = self.browser.lock() {
            browser.kill();
        }
        self.proxy.shutdown();
        self.profile.delete();
    }
}

#[derive(Default)]
struct StartingManagedSession {
    cancelled: AtomicBool,
    begun: AtomicBool,
    finished: AtomicBool,
    finished_notify: tokio::sync::Notify,
    resources: Mutex<Option<Arc<ManagedSessionResources>>>,
}

impl StartingManagedSession {
    fn begin(&self) -> Result<(), AppError> {
        self.begun.store(true, Ordering::SeqCst);
        if self.is_cancelled() {
            self.finish();
            return Err(session_closed("starting"));
        }
        Ok(())
    }

    fn attach(&self, resources: Arc<ManagedSessionResources>) -> Result<(), AppError> {
        let mut slot = self
            .resources
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if self.cancelled.load(Ordering::SeqCst) {
            drop(slot);
            resources.teardown();
            return Err(session_closed("starting"));
        }
        *slot = Some(resources);
        Ok(())
    }

    fn terminate(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
        if let Some(resources) = self
            .resources
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .as_ref()
            .cloned()
        {
            resources.teardown();
        }
        if !self.begun.load(Ordering::SeqCst) {
            self.finish();
        }
    }

    fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }

    fn finish(&self) {
        if !self.finished.swap(true, Ordering::SeqCst) {
            self.finished_notify.notify_waiters();
        }
    }

    async fn wait_finished(&self) {
        while !self.finished.load(Ordering::SeqCst) {
            let notified = self.finished_notify.notified();
            if self.finished.load(Ordering::SeqCst) {
                break;
            }
            notified.await;
        }
    }
}

struct StartingCompletionGuard(Arc<StartingManagedSession>);

impl Drop for StartingCompletionGuard {
    fn drop(&mut self) {
        self.0.finish();
    }
}

impl ManagedBrowserSession {
    /// The broker-facing session id (a fresh uuid, not the CDP session id).
    pub fn id(&self) -> &str {
        &self.id
    }

    /// The ephemeral profile directory, exposed so the E2E harness can prove
    /// teardown deleted it. The path is app-owned scratch, not page content.
    pub fn profile_path(&self) -> PathBuf {
        self.resources.profile.path().to_path_buf()
    }

    /// The browser process id while it is running, exposed so the E2E harness
    /// can kill the process and prove the crash watcher tears the session
    /// down. `None` once the process has been reaped.
    pub fn browser_pid(&self) -> Option<u32> {
        let mut browser = self.resources.browser.lock().ok()?;
        if browser.try_wait_exited() {
            None
        } else {
            browser.pid()
        }
    }

    /// Kills the browser, stops the proxy, and deletes the profile. Idempotent
    /// and synchronous, so revoke, crash, idle timeout, and app exit can all
    /// call it (or rely on Drop, which repeats the same work via the guards).
    fn teardown(&self) {
        self.resources.teardown();
    }

    fn touch(&self) {
        if let Ok(mut last_used) = self.last_used.lock() {
            *last_used = Instant::now();
        }
    }

    fn ensure_open(&self) -> Result<(), AppError> {
        if self.resources.closed.load(Ordering::SeqCst) {
            return Err(session_closed(&self.id));
        }
        Ok(())
    }

    pub async fn navigate(&self, raw_url: &str) -> Result<Value, AppError> {
        self.ensure_open()?;
        self.touch();
        // Pre-navigation refusal: scheme/host policy plus a resolve-validate
        // pass, so a blocked destination is refused before the browser is
        // asked to do anything. The proxy re-runs the same validation pinned
        // at connection time for this and every later hop.
        let validated = validate_public_http_url(raw_url).map_err(policy_error)?;
        resolve_validated(
            validated.host(),
            validated.port(),
            self.resolver.as_ref(),
            &self.policy,
        )
        .await
        .map_err(policy_error)?;

        let started = Instant::now();
        // References minted before this navigation are stale from here on.
        self.epoch.fetch_add(1, Ordering::SeqCst);

        // Subscribe to the load event before navigating so a fast page cannot
        // fire it between the navigate call and the wait.
        let mut events = self.cdp.events();

        let navigated = self
            .cdp
            .call(
                Some(&self.cdp_session_id),
                "Page.navigate",
                json!({ "url": raw_url }),
            )
            .await
            .map_err(tool_error)?;

        if let Some(error_text) = navigated.get("errorText").and_then(|value| value.as_str()) {
            if !error_text.is_empty() {
                // A connection the proxy refused surfaces as a generic net
                // error in the browser; the proxy's block ring tells us the
                // refusal was policy, not the network.
                if self.resources.proxy.blocked_since(started).is_some() {
                    return Err(AppError::new(
                        "browser_policy_blocked",
                        "Navigation blocked: the destination is not on the public web. \
                         The managed browser reaches only the public web.",
                    ));
                }
                return Err(AppError::new(
                    "browser_navigation_failed",
                    format!("The page could not be loaded ({error_text})."),
                ));
            }
        }

        self.wait_for_load(&mut events, LOAD_EVENT_TIMEOUT).await;

        // Post-navigation re-check: redirects re-enter the proxy's pinned
        // validation, so a redirect to a blocked destination already failed to
        // connect; this re-validates the final URL as defense in depth and
        // parks the page back on about:blank if it somehow landed somewhere
        // non-public.
        let final_url = self.evaluate_string("location.href").await?;
        if final_url != "about:blank" {
            if let Err(violation) =
                validate_final_public_url(&final_url, self.resolver.as_ref(), &self.policy).await
            {
                self.epoch.fetch_add(1, Ordering::SeqCst);
                let _ = self
                    .cdp
                    .call(
                        Some(&self.cdp_session_id),
                        "Page.navigate",
                        json!({ "url": "about:blank" }),
                    )
                    .await;
                return Err(policy_error(violation));
            }
        }

        let title = self.evaluate_string("document.title").await.ok();
        Ok(json!({
            "url": final_url,
            "title": title.filter(|title| !title.is_empty()),
        }))
    }

    pub async fn back(&self) -> Result<Value, AppError> {
        self.ensure_open()?;
        self.touch();
        let history = self
            .cdp
            .call(
                Some(&self.cdp_session_id),
                "Page.getNavigationHistory",
                json!({}),
            )
            .await
            .map_err(tool_error)?;
        let current_index = history
            .get("currentIndex")
            .and_then(|value| value.as_u64())
            .unwrap_or(0) as usize;
        let entries = history
            .get("entries")
            .and_then(|value| value.as_array())
            .cloned()
            .unwrap_or_default();
        if current_index == 0 || entries.is_empty() {
            return Err(AppError::new(
                "browser_history_empty",
                "There is no earlier page in this session's history.",
            ));
        }
        let entry_id = entries
            .get(current_index - 1)
            .and_then(|entry| entry.get("id"))
            .and_then(|value| value.as_u64())
            .ok_or_else(|| {
                AppError::new(
                    "browser_history_empty",
                    "There is no earlier page in this session's history.",
                )
            })?;

        self.epoch.fetch_add(1, Ordering::SeqCst);
        let mut events = self.cdp.events();
        self.cdp
            .call(
                Some(&self.cdp_session_id),
                "Page.navigateToHistoryEntry",
                json!({ "entryId": entry_id }),
            )
            .await
            .map_err(tool_error)?;
        self.wait_for_load(&mut events, Duration::from_secs(10))
            .await;

        let url = self.evaluate_string("location.href").await?;
        let title = self.evaluate_string("document.title").await.ok();
        Ok(json!({
            "url": url,
            "title": title.filter(|title| !title.is_empty()),
        }))
    }

    pub async fn snapshot(&self) -> Result<(u64, String), AppError> {
        self.ensure_open()?;
        self.touch();
        let epoch = self.epoch.load(Ordering::SeqCst);
        let expression =
            format!("(() => {{ window.__juneSnapshotEpoch = {epoch}; return {SNAPSHOT_JS}; }})()");
        self.evaluate_string(&expression)
            .await
            .map(|snapshot| (epoch, snapshot))
    }

    async fn interact(
        &self,
        operation: &str,
        reference: &str,
        value: &str,
    ) -> Result<(), AppError> {
        self.ensure_open()?;
        self.touch();
        let expected_epoch = reference_epoch(reference).ok_or_else(|| {
            reference_error("browser_reference_invalid", operation, &self.id, reference)
        })?;
        if expected_epoch != self.epoch.load(Ordering::SeqCst) {
            return Err(reference_error(
                "browser_stale_reference",
                operation,
                &self.id,
                reference,
            ));
        }

        let inspection: ReferenceInspection = self
            .call_function_on_document(INSPECT_REFERENCE_JS, json!([reference]))
            .await
            .map_err(|_| {
                reference_error("browser_reference_failed", operation, &self.id, reference)
            })?;
        if inspection.status != "ok" {
            return Err(reference_error(
                reference_status_code(&inspection.status),
                operation,
                &self.id,
                reference,
            ));
        }
        let element = inspection.element.ok_or_else(|| {
            reference_error("browser_reference_failed", operation, &self.id, reference)
        })?;
        let action = match operation {
            "click" => ManagedAction::Click,
            "fill" => ManagedAction::Fill,
            "press" => ManagedAction::Press(value),
            _ => {
                return Err(reference_error(
                    "browser_reference_failed",
                    operation,
                    &self.id,
                    reference,
                ))
            }
        };
        match classify_managed_action(action, &element) {
            ActionClass::Routine => {}
            ActionClass::Consequential => {
                return Err(AppError::new(
                    "browser_consequential_action_blocked",
                    format!(
                        "The {operation} action for reference {reference} in session {} was refused: consequential actions are not available in routines.",
                        self.id
                    ),
                ));
            }
            ActionClass::SensitiveField => {
                return Err(AppError::new(
                    "browser_sensitive_field_blocked",
                    format!(
                        "The {operation} action for reference {reference} in session {} was refused: sensitive fields are not available for automation.",
                        self.id
                    ),
                ));
            }
        }

        let mut events = self.cdp.events();
        let expected = serde_json::to_value(&element).map_err(|_| {
            reference_error("browser_reference_failed", operation, &self.id, reference)
        })?;
        let result: ReferenceActionResult = self
            .call_function_on_document(
                ACT_ON_REFERENCE_JS,
                json!([operation, reference, value, expected]),
            )
            .await
            .map_err(|_| {
                reference_error("browser_reference_failed", operation, &self.id, reference)
            })?;
        if result.status != "ok" {
            return Err(reference_error(
                reference_status_code(&result.status),
                operation,
                &self.id,
                reference,
            ));
        }

        if operation == "press" {
            let text = if value.chars().count() == 1 {
                value
            } else {
                ""
            };
            for event_type in ["keyDown", "keyUp"] {
                self.cdp
                    .call(
                        Some(&self.cdp_session_id),
                        "Input.dispatchKeyEvent",
                        json!({ "type": event_type, "key": value, "text": text }),
                    )
                    .await
                    .map_err(|_| {
                        reference_error("browser_reference_failed", operation, &self.id, reference)
                    })?;
            }
        }

        // Every successful action consumes the whole reference set. The fresh
        // snapshot returned by the transport below mints the next epoch.
        self.epoch.fetch_add(1, Ordering::SeqCst);
        if matches!(operation, "click" | "press") && element.tag.eq_ignore_ascii_case("a") {
            self.wait_for_load(&mut events, Duration::from_secs(10))
                .await;
            let final_url = self.evaluate_string("location.href").await.map_err(|_| {
                reference_error("browser_reference_failed", operation, &self.id, reference)
            })?;
            if final_url != "about:blank"
                && validate_final_public_url(&final_url, self.resolver.as_ref(), &self.policy)
                    .await
                    .is_err()
            {
                self.epoch.fetch_add(1, Ordering::SeqCst);
                let _ = self
                    .cdp
                    .call(
                        Some(&self.cdp_session_id),
                        "Page.navigate",
                        json!({ "url": "about:blank" }),
                    )
                    .await;
                return Err(AppError::new(
                    "browser_policy_blocked",
                    format!(
                        "The {operation} action for reference {reference} in session {} was refused (browser_policy_blocked): the destination is not on the public web.",
                        self.id
                    ),
                ));
            }
        }
        Ok(())
    }

    pub async fn click(&self, reference: &str) -> Result<(), AppError> {
        self.interact("click", reference, "").await
    }

    pub async fn fill(&self, reference: &str, text: &str) -> Result<(), AppError> {
        self.interact("fill", reference, text).await
    }

    pub async fn press(&self, reference: &str, key: &str) -> Result<(), AppError> {
        self.interact("press", reference, key).await
    }

    pub async fn screenshot(&self) -> Result<ManagedScreenshot, AppError> {
        self.ensure_open()?;
        self.touch();
        let captured = self
            .cdp
            .call(
                Some(&self.cdp_session_id),
                "Page.captureScreenshot",
                json!({ "format": "png" }),
            )
            .await
            .map_err(tool_error)?;
        let data = captured
            .get("data")
            .and_then(|value| value.as_str())
            .ok_or_else(|| artifact_error("screenshot", &self.id))?;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(data)
            .map_err(|_| artifact_error("screenshot", &self.id))?;

        let metrics = self
            .cdp
            .call(
                Some(&self.cdp_session_id),
                "Page.getLayoutMetrics",
                json!({}),
            )
            .await
            .map_err(tool_error)?;
        let viewport = metrics.get("cssVisualViewport");
        let width = viewport
            .and_then(|viewport| viewport.get("clientWidth"))
            .and_then(|value| value.as_f64())
            .unwrap_or(0.0) as u32;
        let height = viewport
            .and_then(|viewport| viewport.get("clientHeight"))
            .and_then(|value| value.as_f64())
            .unwrap_or(0.0) as u32;

        Ok(ManagedScreenshot {
            bytes,
            width,
            height,
        })
    }

    /// Waits for the next `Page.loadEventFired` on this session, tolerating a
    /// timeout: a page that never fires `load` is still readable.
    async fn wait_for_load(
        &self,
        events: &mut tokio::sync::broadcast::Receiver<super::cdp::CdpEvent>,
        timeout: Duration,
    ) {
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            let event = tokio::time::timeout_at(deadline, events.recv()).await;
            match event {
                Ok(Ok(event)) => {
                    if event.method == "Page.loadEventFired"
                        && event.session_id.as_deref() == Some(self.cdp_session_id.as_str())
                    {
                        return;
                    }
                }
                Ok(Err(tokio::sync::broadcast::error::RecvError::Lagged(_))) => continue,
                Ok(Err(tokio::sync::broadcast::error::RecvError::Closed)) | Err(_) => return,
            }
        }
    }

    /// Evaluates a JS expression and returns its string value.
    async fn evaluate_string(&self, expression: &str) -> Result<String, AppError> {
        let evaluated = self
            .cdp
            .call(
                Some(&self.cdp_session_id),
                "Runtime.evaluate",
                json!({ "expression": expression, "returnByValue": true }),
            )
            .await
            .map_err(tool_error)?;
        evaluated
            .get("result")
            .and_then(|result| result.get("value"))
            .and_then(|value| value.as_str())
            .map(|value| value.to_string())
            .ok_or_else(|| {
                AppError::new(
                    "browser_command_failed",
                    format!("The page could not be read in session {}.", self.id),
                )
            })
    }

    async fn call_function_on_document<T: serde::de::DeserializeOwned>(
        &self,
        function_declaration: &str,
        arguments: Value,
    ) -> Result<T, AppError> {
        let document = self
            .cdp
            .call(
                Some(&self.cdp_session_id),
                "Runtime.evaluate",
                json!({ "expression": "document" }),
            )
            .await
            .map_err(tool_error)?;
        let object_id = document
            .get("result")
            .and_then(|result| result.get("objectId"))
            .and_then(Value::as_str)
            .ok_or_else(|| {
                AppError::new("browser_command_failed", "The browser page is unavailable.")
            })?;
        let arguments = arguments
            .as_array()
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .map(|value| json!({ "value": value }))
            .collect::<Vec<_>>();
        let response = self
            .cdp
            .call(
                Some(&self.cdp_session_id),
                "Runtime.callFunctionOn",
                json!({
                    "objectId": object_id,
                    "functionDeclaration": function_declaration,
                    "arguments": arguments,
                    "returnByValue": true,
                }),
            )
            .await
            .map_err(tool_error)?;
        let value = response
            .get("result")
            .and_then(|result| result.get("value"))
            .cloned()
            .ok_or_else(|| {
                AppError::new(
                    "browser_command_failed",
                    "The browser action returned no result.",
                )
            })?;
        serde_json::from_value(value).map_err(|_| {
            AppError::new(
                "browser_command_failed",
                "The browser action returned an invalid result.",
            )
        })
    }

    pub async fn close(&self) {
        self.teardown();
    }

    fn idle_seconds(&self) -> u64 {
        self.last_used
            .lock()
            .map(|last_used| last_used.elapsed().as_secs())
            .unwrap_or(0)
    }

    fn is_closed(&self) -> bool {
        self.resources.closed.load(Ordering::SeqCst)
    }
}

/// Raw screenshot captured by the managed engine. The broker owns persistence
/// and converts these bytes to the canonical file-reference response.
pub struct ManagedScreenshot {
    pub bytes: Vec<u8>,
    pub width: u32,
    pub height: u32,
}

/// JUN-291 transport adapter. It owns managed-session lifecycle while the
/// broker owns authorization, transport selection, and artifact persistence.
pub(crate) struct ManagedBrowserTransport {
    inner: Arc<ManagedTransportInner>,
}

struct ManagedTransportInner {
    config: ManagedSessionConfig,
    sessions: Mutex<HashMap<String, Arc<ManagedBrowserSession>>>,
    starting: Mutex<HashMap<String, Arc<StartingManagedSession>>>,
    start_lock: tokio::sync::Mutex<()>,
}

impl ManagedBrowserTransport {
    pub(crate) fn production(artifacts_root: PathBuf) -> Self {
        Self::new(ManagedSessionConfig::production(artifacts_root))
    }

    fn new(config: ManagedSessionConfig) -> Self {
        let inner = Arc::new(ManagedTransportInner {
            config,
            sessions: Mutex::new(HashMap::new()),
            starting: Mutex::new(HashMap::new()),
            start_lock: tokio::sync::Mutex::new(()),
        });
        spawn_idle_reaper(&inner);
        Self { inner }
    }

    fn sessions(&self) -> std::sync::MutexGuard<'_, HashMap<String, Arc<ManagedBrowserSession>>> {
        self.inner
            .sessions
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn session(&self, session_id: &str) -> Result<Arc<ManagedBrowserSession>, AppError> {
        let mut sessions = self.sessions();
        sessions.retain(|_, session| !session.is_closed());
        sessions.get(session_id).cloned().ok_or_else(|| {
            AppError::new(
                "browser_session_not_found",
                format!("Managed browser session {session_id} was not found."),
            )
        })
    }

    fn starting(&self) -> std::sync::MutexGuard<'_, HashMap<String, Arc<StartingManagedSession>>> {
        self.inner
            .starting
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn reserve_session(&self, session_id: &str) -> Result<(), AppError> {
        let active = {
            let mut sessions = self.sessions();
            sessions.retain(|_, session| !session.is_closed());
            sessions.len()
        };
        let mut starting = self.starting();
        if active + starting.len() >= MAX_MANAGED_SESSIONS {
            return Err(AppError::new(
                "browser_session_limit",
                "Too many managed browser sessions are open. Close one first.",
            ));
        }
        starting.insert(
            session_id.to_string(),
            Arc::new(StartingManagedSession::default()),
        );
        Ok(())
    }

    async fn start_session(&self, session_id: &str) -> Result<TransportResponse, AppError> {
        let _start = self.inner.start_lock.lock().await;
        let starting = self
            .starting()
            .get(session_id)
            .cloned()
            .ok_or_else(|| session_closed(session_id))?;
        if let Err(error) = starting.begin() {
            self.starting().remove(session_id);
            return Err(error);
        }
        let _completion = StartingCompletionGuard(Arc::clone(&starting));
        let config = ManagedSessionConfig {
            artifacts_root: self.inner.config.artifacts_root.clone(),
            policy: self.inner.config.policy.clone(),
            resolver: Arc::clone(&self.inner.config.resolver),
        };
        let result =
            start_managed_session_with_id(config, session_id.to_string(), Arc::clone(&starting))
                .await;
        let session = match result {
            Ok(session) if !starting.is_cancelled() => session,
            Ok(session) => {
                session.teardown();
                self.starting().remove(session_id);
                return Err(session_closed(session_id));
            }
            Err(error) => {
                self.starting().remove(session_id);
                return Err(error);
            }
        };
        self.sessions()
            .insert(session_id.to_string(), Arc::clone(&session));
        self.starting().remove(session_id);
        if session.is_closed() {
            self.sessions().remove(session_id);
            return Err(session_closed(session_id));
        }
        Ok(TransportResponse::data(json!({})))
    }

    fn terminate_session(&self, session_id: &str) {
        if let Some(starting) = self.starting().get(session_id).cloned() {
            starting.terminate();
        }
        if let Some(session) = self.sessions().remove(session_id) {
            session.teardown();
        }
    }

    async fn close_session(&self, session_id: &str) {
        let starting = self.starting().get(session_id).cloned();
        self.terminate_session(session_id);
        if let Some(starting) = starting {
            starting.wait_finished().await;
            self.starting().remove(session_id);
        }
    }

    async fn snapshot_response(
        &self,
        session: &ManagedBrowserSession,
    ) -> Result<TransportResponse, AppError> {
        let (epoch, snapshot) = session.snapshot().await?;
        if snapshot.len() <= SNAPSHOT_INLINE_MAX_BYTES {
            Ok(TransportResponse::data(json!({
                "epoch": epoch,
                "snapshot": snapshot,
            })))
        } else {
            let bytes = serde_json::to_vec(&json!({
                "epoch": epoch,
                "snapshot": snapshot,
            }))
            .map_err(|_| artifact_error("snapshot", session.id()))?;
            Ok(TransportResponse::artifact(
                json!({ "epoch": epoch }),
                TransportArtifact {
                    kind: "snapshot".to_string(),
                    mime_type: "application/json".to_string(),
                    bytes,
                },
            ))
        }
    }
}

impl BrowserTransport for ManagedBrowserTransport {
    fn reserve_session(&self, session_id: &str) -> Result<(), AppError> {
        ManagedBrowserTransport::reserve_session(self, session_id)
    }

    fn execute<'a>(&'a self, tool: &'a str, arguments: Value) -> TransportFuture<'a> {
        Box::pin(async move {
            let session_id = required_argument(&arguments, "session_id")?;
            match tool {
                "start_session" => self.start_session(session_id).await,
                "close_session" => {
                    self.close_session(session_id).await;
                    Ok(TransportResponse::data(json!({ "closed": true })))
                }
                "navigate" => {
                    let url = required_argument(&arguments, "url")?;
                    let data = self.session(session_id)?.navigate(url).await?;
                    Ok(TransportResponse::data(data))
                }
                "back" => {
                    let data = self.session(session_id)?.back().await?;
                    Ok(TransportResponse::data(data))
                }
                "snapshot" => {
                    let session = self.session(session_id)?;
                    self.snapshot_response(&session).await
                }
                "click" => {
                    let reference = required_argument(&arguments, "ref")?;
                    let session = self.session(session_id)?;
                    session.click(reference).await?;
                    self.snapshot_response(&session).await
                }
                "fill" => {
                    let reference = required_argument(&arguments, "ref")?;
                    let text = string_argument(&arguments, "text")?;
                    let session = self.session(session_id)?;
                    session.fill(reference, text).await?;
                    self.snapshot_response(&session).await
                }
                "press" => {
                    let reference = required_argument(&arguments, "ref")?;
                    let key = required_argument(&arguments, "key")?;
                    let session = self.session(session_id)?;
                    session.press(reference, key).await?;
                    self.snapshot_response(&session).await
                }
                "screenshot" => {
                    let screenshot = self.session(session_id)?.screenshot().await?;
                    Ok(TransportResponse::artifact(
                        json!({
                            "width": screenshot.width,
                            "height": screenshot.height,
                        }),
                        TransportArtifact {
                            kind: "screenshot".to_string(),
                            mime_type: "image/png".to_string(),
                            bytes: screenshot.bytes,
                        },
                    ))
                }
                _ => Err(AppError::new(
                    "browser_tool_unavailable",
                    format!("The {tool} browser tool is unavailable on managed sessions."),
                )),
            }
        })
    }

    fn terminate_session(&self, session_id: &str) {
        ManagedBrowserTransport::terminate_session(self, session_id);
    }
}

impl Drop for ManagedTransportInner {
    fn drop(&mut self) {
        let starting = self
            .starting
            .get_mut()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .drain()
            .map(|(_, starting)| starting)
            .collect::<Vec<_>>();
        for starting in starting {
            starting.terminate();
        }
        let sessions = self
            .sessions
            .get_mut()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .drain()
            .map(|(_, session)| session)
            .collect::<Vec<_>>();
        for session in sessions {
            session.teardown();
        }
    }
}

fn spawn_idle_reaper(inner: &Arc<ManagedTransportInner>) {
    let weak = Arc::downgrade(inner);
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(MANAGED_SESSION_REAPER_INTERVAL).await;
            let Some(inner) = weak.upgrade() else {
                return;
            };
            let expired = {
                let mut sessions = inner
                    .sessions
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                let expired = sessions
                    .iter()
                    .filter(|(_, session)| {
                        session.is_closed()
                            || session.idle_seconds() >= MANAGED_SESSION_IDLE_TIMEOUT.as_secs()
                    })
                    .map(|(id, _)| id.clone())
                    .collect::<Vec<_>>();
                expired
                    .into_iter()
                    .filter_map(|id| sessions.remove(&id))
                    .collect::<Vec<_>>()
            };
            for session in expired {
                session.teardown();
            }
        }
    });
}

fn required_argument<'a>(arguments: &'a Value, name: &str) -> Result<&'a str, AppError> {
    arguments
        .get(name)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| AppError::new("invalid_arguments", format!("{name} is required.")))
}

fn string_argument<'a>(arguments: &'a Value, name: &str) -> Result<&'a str, AppError> {
    arguments
        .get(name)
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::new("invalid_arguments", format!("{name} is required.")))
}

fn start_failed(stage: &str) -> AppError {
    // The stage is an internal noun (profile/proxy/launch/pipes/target), never
    // content; it makes "it did not start" actionable in a bug report.
    AppError::new(
        "browser_start_failed",
        format!("The managed browser could not be started ({stage})."),
    )
}

fn session_closed(session_id: &str) -> AppError {
    AppError::new(
        "browser_session_closed",
        format!("Browser session {session_id} is closed. Start a new one with start_session."),
    )
}

fn tool_error(error: super::cdp::CdpError) -> AppError {
    AppError::new("browser_command_failed", error.message)
}

fn policy_error(violation: super::policy::PolicyViolation) -> AppError {
    AppError::new("browser_policy_blocked", violation.to_string())
}

fn artifact_error(operation: &str, session_id: &str) -> AppError {
    AppError::new(
        "browser_command_failed",
        format!("The {operation} could not be saved for session {session_id}."),
    )
}

fn reference_epoch(reference: &str) -> Option<u64> {
    let epoch = reference.strip_prefix('e')?.split(':').next()?;
    epoch.parse().ok()
}

fn reference_status_code(status: &str) -> &'static str {
    match status {
        "stale" | "changed" | "missing" => "browser_stale_reference",
        "invalid" => "browser_reference_invalid",
        "unsupported" => "browser_action_unsupported",
        _ => "browser_reference_failed",
    }
}

fn reference_error(code: &str, operation: &str, session_id: &str, reference: &str) -> AppError {
    AppError::new(
        code,
        format!(
            "The {operation} action for reference {reference} in session {session_id} was refused ({code})."
        ),
    )
}

/// The snapshot extraction script: visible page text plus interactive elements
/// tagged with epoch-scoped references. The elements are stashed in one page
/// state object, and a MutationObserver invalidates that entire object on any
/// DOM mutation. This deliberately uses coarse invalidation: it may require a
/// new snapshot after an unrelated mutation, but can never retarget an old
/// reference to a different element.
const SNAPSHOT_JS: &str = r#"(() => {
  const MAX_REFS = 800;
  const MAX_TEXT = 150000;
  const epoch = Number(window.__juneSnapshotEpoch || 0);
  const mutationVersion = Number(window.__juneMutationVersion || 0);
  const lines = [];
  lines.push("URL: " + location.href);
  lines.push("Title: " + document.title);
  const selector = [
    "a[href]", "button", "input", "textarea", "select", "summary",
    "[role=button]", "[role=link]", "[role=tab]", "[role=menuitem]",
    "[role=checkbox]", "[role=radio]", "[role=combobox]", "[role=textbox]",
    "[role=searchbox]", "[contenteditable]", "[onclick]",
  ].join(", ");
  const visible = (el) => {
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  const refs = [];
  const FORM_CONTROLS = new Set(["input", "textarea", "select"]);
  const VALUE_ROLES = new Set(["textbox", "combobox", "searchbox"]);
  const valueRole = (el) => (el.getAttribute("role") || "").toLowerCase();
  const isValueControl = (el) =>
    FORM_CONTROLS.has(el.tagName.toLowerCase()) ||
    el.isContentEditable ||
    VALUE_ROLES.has(valueRole(el));
  const labelText = (root) => {
    const parts = [];
    const walk = (node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        parts.push(node.nodeValue || "");
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE || isValueControl(node)) return;
      for (const child of node.childNodes) walk(child);
    };
    walk(root);
    return parts.join(" ").trim().replace(/\s+/g, " ");
  };
  const accessibleLabel = (el) => {
    const labelledBy = (el.getAttribute("aria-labelledby") || "")
      .split(/\s+/)
      .filter(Boolean)
      .map((id) => {
        const label = document.getElementById(id);
        return label ? labelText(label) : "";
      })
      .join(" ");
    const labels = el.labels
      ? Array.from(el.labels).map((label) => labelText(label)).join(" ")
      : "";
    return (
      el.getAttribute("aria-label") ||
      labelledBy ||
      labels ||
      el.getAttribute("placeholder") ||
      el.getAttribute("name") ||
      ""
    ).trim().replace(/\s+/g, " ").slice(0, 120);
  };
  const elementFacts = (el) => ({
    tag: el.tagName.toLowerCase(),
    inputType: (el.getAttribute("type") || "").toLowerCase(),
    role: (el.getAttribute("role") || "").toLowerCase(),
    name: el.getAttribute("name") || "",
    id: el.id || "",
    label: accessibleLabel(el) || (el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 120),
    autocomplete: el.getAttribute("autocomplete") || "",
    inForm: Boolean(el.closest("form")),
    contentEditable: Boolean(el.isContentEditable),
  });
  const reference = (n) => "e" + epoch + ":m" + mutationVersion + ":n" + n;
  const describe = (el, n) => {
    const tag = el.tagName.toLowerCase();
    const type = el.getAttribute("type");
    const role = valueRole(el);
    const label = accessibleLabel(el);
    const isControl = isValueControl(el);
    // Control values are untrusted page data that may contain secrets. Expose
    // only the accessible label, implementation type, and a generic state.
    const raw = isControl ? "" : sanitizedText(el);
    const text = raw.trim().replace(/\s+/g, " ").slice(0, 120);
    const href = tag === "a" ? (el.getAttribute("href") || "").slice(0, 300) : "";
    let out = "[" + reference(n) + "] <" + tag + (type ? " type=" + type : "") + (role ? " role=" + role : "") + ">";
    if (isControl) {
      out += " " + controlPlaceholder(el, label);
      return out;
    }
    if (text) out += " " + text;
    else if (label) out += " (" + label + ")";
    if (href) out += " -> " + href;
    return out;
  };
  const controlPlaceholder = (el, knownLabel) => {
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute("type") || "").toLowerCase();
    const role = valueRole(el);
    const label = knownLabel === undefined ? accessibleLabel(el) : knownLabel;
    const kind = role || type || (el.isContentEditable ? "contenteditable" : tag);
    const filled = type === "checkbox" || type === "radio"
      ? Boolean(el.checked)
      : Boolean(
          ("value" in el && el.value) ||
          (el.textContent || "").trim() ||
          el.getAttribute("aria-valuetext") ||
          el.getAttribute("aria-valuenow")
        );
    let value = "(value hidden";
    if (label) value += ": " + label;
    value += ", " + kind + (filled ? ", filled)" : ", empty)");
    return value;
  };
  const BLOCK_TAGS = new Set([
    "address", "article", "aside", "blockquote", "div", "dl", "fieldset",
    "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header",
    "hr", "li", "main", "nav", "ol", "p", "pre", "section", "table", "ul",
  ]);
  const walkSanitizedText = (node, parts) => {
    if (node.nodeType === Node.TEXT_NODE) {
      parts.push(node.nodeValue || "");
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node;
    const style = window.getComputedStyle(el);
    if (
      style.display === "none" ||
      style.visibility === "hidden" ||
      el.getAttribute("aria-hidden") === "true"
    ) return;
    if (isValueControl(el)) {
      parts.push(" " + controlPlaceholder(el) + " ");
      return;
    }
    const tag = el.tagName.toLowerCase();
    if (tag === "br") {
      parts.push("\n");
      return;
    }
    const block = BLOCK_TAGS.has(tag);
    if (block) parts.push("\n");
    for (const child of el.childNodes) walkSanitizedText(child, parts);
    if (block) parts.push("\n");
  };
  const sanitizedText = (root) => {
    const parts = [];
    walkSanitizedText(root, parts);
    return parts
      .join("")
      .replace(/[\t\f\v ]+/g, " ")
      .replace(/ *\n */g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  };
  const interactive = [];
  for (const el of document.querySelectorAll(selector)) {
    if (interactive.length >= MAX_REFS) break;
    if (!visible(el)) continue;
    refs.push(el);
    interactive.push(describe(el, refs.length));
  }
  if (window.__juneSnapshotObserver) window.__juneSnapshotObserver.disconnect();
  const state = {
    epoch,
    mutationVersion,
    refs,
    elements: refs.map(elementFacts),
    valid: true,
  };
  window.__juneSnapshotState = state;
  const observer = new MutationObserver(() => {
    window.__juneMutationVersion = Number(window.__juneMutationVersion || 0) + 1;
    state.valid = false;
    observer.disconnect();
  });
  if (document.documentElement) {
    observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });
  }
  window.__juneSnapshotObserver = observer;
  lines.push("");
  lines.push("Interactive elements (" + interactive.length + "):");
  lines.push(...interactive);
  lines.push("");
  lines.push("Page text:");
  const text = document.body ? sanitizedText(document.body) : "";
  lines.push(text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) + "\n[truncated]" : text);
  return lines.join("\n");
})()"#;

const INSPECT_REFERENCE_JS: &str = r#"function(reference) {
  const match = /^e(\d+):m(\d+):n(\d+)$/.exec(reference);
  if (!match) return {status: "invalid"};
  const state = window.__juneSnapshotState;
  if (!state || !state.valid) return {status: "stale"};
  if (state.epoch !== Number(match[1]) || state.mutationVersion !== Number(match[2])) {
    return {status: "stale"};
  }
  const index = Number(match[3]) - 1;
  const el = state.refs[index];
  if (!el || !el.isConnected) return {status: "missing"};
  return {status: "ok", element: state.elements[index]};
}"#;

const ACT_ON_REFERENCE_JS: &str = r#"function(operation, reference, value, expected) {
  const match = /^e(\d+):m(\d+):n(\d+)$/.exec(reference);
  if (!match) return {status: "invalid"};
  const state = window.__juneSnapshotState;
  if (!state || !state.valid) return {status: "stale"};
  if (state.epoch !== Number(match[1]) || state.mutationVersion !== Number(match[2])) {
    return {status: "stale"};
  }
  const index = Number(match[3]) - 1;
  const el = state.refs[index];
  if (!el || !el.isConnected) return {status: "missing"};
  const labelText = (root) => {
    const parts = [];
    const walk = (node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        parts.push(node.nodeValue || "");
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      const tag = node.tagName.toLowerCase();
      const role = (node.getAttribute("role") || "").toLowerCase();
      if (["input", "textarea", "select"].includes(tag) || node.isContentEditable || ["textbox", "combobox", "searchbox"].includes(role)) return;
      for (const child of node.childNodes) walk(child);
    };
    walk(root);
    return parts.join(" ").trim().replace(/\s+/g, " ");
  };
  const accessibleLabel = (node) => {
    const labelledBy = (node.getAttribute("aria-labelledby") || "")
      .split(/\s+/)
      .filter(Boolean)
      .map((id) => {
        const label = document.getElementById(id);
        return label ? labelText(label) : "";
      })
      .join(" ");
    const labels = node.labels
      ? Array.from(node.labels).map((label) => labelText(label)).join(" ")
      : "";
    return (
      node.getAttribute("aria-label") || labelledBy || labels ||
      node.getAttribute("placeholder") || node.getAttribute("name") || ""
    ).trim().replace(/\s+/g, " ").slice(0, 120);
  };
  const current = {
    tag: el.tagName.toLowerCase(),
    inputType: (el.getAttribute("type") || "").toLowerCase(),
    role: (el.getAttribute("role") || "").toLowerCase(),
    name: el.getAttribute("name") || "",
    id: el.id || "",
    label: accessibleLabel(el) || (el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 120),
    autocomplete: el.getAttribute("autocomplete") || "",
    inForm: Boolean(el.closest("form")),
    contentEditable: Boolean(el.isContentEditable),
  };
  if (Object.keys(current).some((key) => current[key] !== expected[key])) {
    return {status: "changed"};
  }
  if (operation === "click") {
    el.click();
  } else if (operation === "fill") {
    if (!("value" in el) && !el.isContentEditable) return {status: "unsupported"};
    el.focus();
    if (el.isContentEditable) el.textContent = value;
    else el.value = value;
    el.dispatchEvent(new Event("input", {bubbles: true}));
    el.dispatchEvent(new Event("change", {bubbles: true}));
  } else if (operation === "press") {
    el.focus();
  } else {
    return {status: "unsupported"};
  }
  state.valid = false;
  return {status: "ok"};
}"#;

#[cfg(test)]
mod interaction_tests {
    use super::*;

    #[test]
    fn reference_epoch_parser_refuses_malformed_and_distinguishes_old_epochs() {
        assert_eq!(reference_epoch("e12:m4:n7"), Some(12));
        assert_eq!(reference_epoch("ref7"), None);
        assert_eq!(reference_epoch("eold:m4:n7"), None);
        assert_ne!(reference_epoch("e1:m0:n1"), reference_epoch("e2:m0:n1"));
    }
}
