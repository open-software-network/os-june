//! Trust-mode approval enforcement for connector actions.
//!
//! Every mutating connector route (Gmail send/draft/modify/archive, Calendar
//! create/respond) passes through [`gate_action`] BEFORE the mutation runs.
//! The decision is made in Rust, at the choke point, never by prompting the
//! model:
//!
//! - A routine in `read_only` mode is denied outright.
//! - A routine in `autonomous` mode with the tool explicitly granted runs
//!   without interruption.
//! - Everything else parks: the action is registered in a process-global
//!   pending-approval registry, a `june://connector-approvals-changed` event
//!   fires, and the call blocks until the user approves or declines in the UI,
//!   or a 600s timeout elapses.
//!
//! Interactive chat and biography sessions carry no job id, so they always
//! park: an action call from chat prompts the user too.
//!
//! Previews stored for the UI contain only mutation-target metadata assembled
//! by the Rust proxy. Recipient addresses and object identifiers are preserved
//! because hiding them would make the approval meaningless; message bodies,
//! event descriptions, grant tokens, and Google tokens never reach here.

use crate::domain::types::AppError;
use rand::{distributions::Alphanumeric, Rng};
use serde::Serialize;
use std::{
    collections::HashMap,
    sync::{Mutex, OnceLock},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter};
use tokio::sync::oneshot;

/// How long a parked action waits for the user before it gives up. Matches the
/// connector OAuth login window so a slow-but-real approval is never cut short.
const APPROVAL_TIMEOUT: Duration = Duration::from_secs(600);
const APPROVALS_CHANGED_EVENT: &str = "june://connector-approvals-changed";

/// The outcome of gating a mutating connector action.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ActionDecision {
    Allow,
    /// The action must not run; the reason is a short human string the model
    /// receives as a clean tool error.
    Deny(String),
}

/// What the proxy hands to [`gate_action`] for one mutating call. `account_id`
/// is the connected Google account email. `grant_token` is present only for a
/// per-job earned-autonomy (auto) server; the base action servers, chat, and
/// biography leave it `None`, so their calls always park.
pub struct ActionRequest<'a> {
    pub grant_token: Option<&'a str>,
    pub account_id: &'a str,
    pub server: &'a str,
    pub tool: &'a str,
    pub summary: String,
    pub args_preview: String,
}

/// A parked action awaiting the user's decision.
#[derive(Clone)]
struct PendingApproval {
    approval_id: String,
    tool: String,
    server: String,
    account_email: String,
    summary: String,
    args_preview: String,
    requested_at_ms: u64,
}

struct PendingEntry {
    approval: PendingApproval,
    responder: oneshot::Sender<bool>,
}

static REGISTRY: OnceLock<Mutex<HashMap<String, PendingEntry>>> = OnceLock::new();

fn registry() -> &'static Mutex<HashMap<String, PendingEntry>> {
    REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Decide whether a mutating connector action may run. The proxy is
/// session-blind, so the ONLY autonomous signal is the grant token an auto
/// server carries: a valid token whose grant covers this tool and account runs
/// without parking. Everything else (the base action servers, chat, biography,
/// a stale or mismatched token) parks until the user responds or the wait times
/// out. Read-only enforcement lives at the toolset layer (a read-only routine
/// never gets an action server), so there is no read-only branch here.
pub async fn gate_action(app: &AppHandle, request: ActionRequest<'_>) -> ActionDecision {
    if action_is_authorized(app, request.grant_token, request.account_id, request.tool).await {
        return ActionDecision::Allow;
    }
    park(app, request).await
}

/// Whether a per-routine grant lets this action bypass the approval surface.
/// The proxy uses this before loading human-readable message/event metadata so
/// autonomous calls do not make a redundant read solely to build an approval
/// card that will never be shown. Any lookup failure is fail-closed.
pub async fn action_is_authorized(
    app: &AppHandle,
    grant_token: Option<&str>,
    account_id: &str,
    tool: &str,
) -> bool {
    let Some(token) = grant_token.filter(|token| !token.is_empty()) else {
        return false;
    };
    let Ok(repos) = crate::commands::repositories(app).await else {
        return false;
    };
    let Ok(Some(grant)) = repos.find_connector_grant_by_token(token).await else {
        return false;
    };
    grant_authorizes(&grant, account_id, tool)
}

/// A grant authorizes a call only when it is bound to the SAME (non-empty)
/// account and the tool is in its granted set. A token that resolves to a grant
/// for a different account or an ungranted tool falls through to parking.
fn grant_authorizes(
    grant: &crate::db::repositories::ConnectorGrant,
    account_id: &str,
    tool: &str,
) -> bool {
    !account_id.is_empty()
        && grant.account_id == account_id
        && grant.tools.iter().any(|granted| granted == tool)
}

async fn park(app: &AppHandle, request: ActionRequest<'_>) -> ActionDecision {
    let approval_id = random_approval_id();
    let (responder, receiver) = oneshot::channel();
    let approval = PendingApproval {
        approval_id: approval_id.clone(),
        tool: request.tool.to_string(),
        server: request.server.to_string(),
        account_email: request.account_id.to_string(),
        summary: sanitize_preview(&request.summary),
        args_preview: sanitize_preview(&request.args_preview),
        requested_at_ms: now_ms(),
    };
    {
        let mut reg = registry()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        reg.insert(
            approval_id.clone(),
            PendingEntry {
                approval,
                responder,
            },
        );
    }
    emit_changed(app);

    let decision = match tokio::time::timeout(APPROVAL_TIMEOUT, receiver).await {
        Ok(Ok(true)) => ActionDecision::Allow,
        Ok(Ok(false)) => ActionDecision::Deny("The user declined this action.".to_string()),
        // Sender dropped without a value: treat as cancelled.
        Ok(Err(_)) => ActionDecision::Deny("The approval was cancelled.".to_string()),
        Err(_) => ActionDecision::Deny("Approval timed out.".to_string()),
    };
    // On a send the responder already removed the entry; on timeout/cancel we
    // remove it here so a stale card never lingers in the tray.
    if remove_entry(&approval_id).is_some() {
        emit_changed(app);
    }
    decision
}

fn remove_entry(approval_id: &str) -> Option<PendingEntry> {
    registry()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .remove(approval_id)
}

fn pending_count() -> usize {
    registry()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .len()
}

fn emit_changed(app: &AppHandle) {
    let _ = app.emit(
        APPROVALS_CHANGED_EVENT,
        serde_json::json!({ "pendingCount": pending_count() }),
    );
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn random_approval_id() -> String {
    rand::thread_rng()
        .sample_iter(&Alphanumeric)
        .take(32)
        .map(char::from)
        .collect()
}

/// Collapse line breaks/control whitespace so untrusted metadata cannot forge
/// extra UI rows. The producer deliberately omits bodies and credentials and
/// bounds the complete preview before it reaches this module; target addresses
/// and identifiers stay intact for informed consent.
fn sanitize_preview(preview: &str) -> String {
    preview.split_whitespace().collect::<Vec<_>>().join(" ")
}

// --- Commands ----------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingConnectorApproval {
    pub approval_id: String,
    pub tool: String,
    pub server: String,
    pub account_email: String,
    pub summary: String,
    pub args_preview: String,
    pub requested_at_ms: u64,
}

#[tauri::command]
pub fn connector_approvals_pending() -> Result<Vec<PendingConnectorApproval>, AppError> {
    let reg = registry()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut pending: Vec<PendingConnectorApproval> = reg
        .values()
        .map(|entry| {
            let approval = &entry.approval;
            PendingConnectorApproval {
                approval_id: approval.approval_id.clone(),
                tool: approval.tool.clone(),
                server: approval.server.clone(),
                account_email: approval.account_email.clone(),
                summary: approval.summary.clone(),
                args_preview: approval.args_preview.clone(),
                requested_at_ms: approval.requested_at_ms,
            }
        })
        .collect();
    pending.sort_by_key(|approval| approval.requested_at_ms);
    Ok(pending)
}

/// `approval_id` and `approve` are discrete command arguments (Tauri maps the
/// JS camelCase `approvalId` to this snake_case name), matching the
/// `connector_approval_respond({ approvalId, approve })` shape the frontend
/// invokes with.
#[tauri::command]
pub fn connector_approval_respond(
    app: AppHandle,
    approval_id: String,
    approve: bool,
) -> Result<(), AppError> {
    let Some(entry) = remove_entry(&approval_id) else {
        return Err(AppError::new(
            "connector_approval_not_found",
            "That approval is no longer pending.",
        ));
    };
    // A dropped receiver means the action already timed out; that is not an
    // error the UI needs to see.
    let _ = entry.responder.send(approve);
    emit_changed(&app);
    Ok(())
}

/// Resolve a specific set of pending approvals at once, matching the frontend's
/// `connector_approvals_respond_all({ approve, approvalIds })` shape. Only the
/// ids the tray actually rendered are answered: an action enqueued after the UI
/// snapshotted its list is left pending so a bulk approve can never wave through
/// an action the user never saw.
#[tauri::command]
pub fn connector_approvals_respond_all(
    app: AppHandle,
    approve: bool,
    approval_ids: Vec<String>,
) -> Result<(), AppError> {
    respond_to_ids(&approval_ids, approve);
    emit_changed(&app);
    Ok(())
}

/// Answer only the named approvals, returning how many were still pending.
/// Anything not named (for example an action enqueued after the tray snapshot)
/// is left in the registry untouched. Split out so the selection logic is
/// testable without a Tauri `AppHandle`.
fn respond_to_ids(approval_ids: &[String], approve: bool) -> usize {
    let mut resolved = 0;
    for approval_id in approval_ids {
        if let Some(entry) = remove_entry(approval_id) {
            let _ = entry.responder.send(approve);
            resolved += 1;
        }
    }
    resolved
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_preview_preserves_targets_and_collapses_lines() {
        let sanitized = sanitize_preview(
            "To: ada@example.com, bob@corp.io\nMessage: 18f3abc0123456789\tSubject: hi",
        );
        assert_eq!(
            sanitized,
            "To: ada@example.com, bob@corp.io Message: 18f3abc0123456789 Subject: hi"
        );
    }

    #[test]
    fn short_plain_text_is_unchanged() {
        assert_eq!(
            sanitize_preview("Subject: Weekly sync"),
            "Subject: Weekly sync"
        );
    }

    fn grant(account: &str, tools: &[&str]) -> crate::db::repositories::ConnectorGrant {
        crate::db::repositories::ConnectorGrant {
            job_id: "job123456".to_string(),
            provider: "gmail".to_string(),
            server_name: "june_gmail_auto_job12345".to_string(),
            token: "grant-token".to_string(),
            tools: tools.iter().map(|tool| tool.to_string()).collect(),
            account_id: account.to_string(),
        }
    }

    #[test]
    fn grant_authorizes_only_matching_account_and_granted_tool() {
        let grant = grant("user@example.com", &["send_email", "create_draft"]);

        // Valid: same account, granted tool -> allowed (gate_action returns
        // Allow without parking).
        assert!(grant_authorizes(&grant, "user@example.com", "send_email"));

        // Mismatched account -> would park.
        assert!(!grant_authorizes(&grant, "other@example.com", "send_email"));
        // Ungranted tool -> would park.
        assert!(!grant_authorizes(&grant, "user@example.com", "archive"));
        // Empty account -> would park.
        assert!(!grant_authorizes(&grant, "", "send_email"));
    }

    fn park_test_entry(approval_id: &str) -> oneshot::Receiver<bool> {
        let (responder, receiver) = oneshot::channel();
        let approval = PendingApproval {
            approval_id: approval_id.to_string(),
            tool: "send_email".to_string(),
            server: "june_gmail_actions".to_string(),
            account_email: "user@example.com".to_string(),
            summary: String::new(),
            args_preview: String::new(),
            requested_at_ms: 0,
        };
        registry()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(
                approval_id.to_string(),
                PendingEntry {
                    approval,
                    responder,
                },
            );
        receiver
    }

    #[test]
    fn respond_to_ids_answers_only_named_and_leaves_others_pending() {
        // Unique ids keep this isolated from any other test touching the global
        // registry.
        let seen = "respond-all-seen-1";
        let unseen = "respond-all-unseen-1";
        let mut seen_rx = park_test_entry(seen);
        let _unseen_rx = park_test_entry(unseen);

        // Approve only the id the tray rendered.
        let resolved = respond_to_ids(&[seen.to_string()], true);
        assert_eq!(resolved, 1);

        // The rendered action got its approval...
        assert_eq!(seen_rx.try_recv(), Ok(true));
        // ...and the action enqueued after the snapshot is still pending.
        let mut reg = registry()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        assert!(reg.contains_key(unseen));
        assert!(!reg.contains_key(seen));
        reg.remove(unseen);
    }
}
