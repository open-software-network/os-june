//! Tauri commands for connectors, routine trust modes, and event triggers.
//! Registered in lib.rs after the os_accounts block. Request/response
//! payloads are camelCase, matching the existing command structs.

use crate::db::repositories::{ConnectorGrant, Repositories, RoutineTrustRecord};
use crate::domain::types::AppError;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

use super::{
    begin_connect, disconnect, list_accounts, scopes::ScopeBundle, ConnectFlow, ConnectorAccount,
    ConnectorAccountStatus,
};

/// A routine earns autonomy only after this many completed approval-mode
/// runs. The frontend gates too; this is the backstop.
const EARNED_AUTONOMY_MIN_APPROVAL_RUNS: i64 = 3;

const TRUST_MODES: &[&str] = &["read_only", "approval", "autonomous"];
const TRIGGER_KINDS: &[&str] = &["email_received", "event_upcoming"];

/// Mutating tools autonomy can grant, grouped by connector provider. The
/// bridge mints one auto MCP server per provider that has at least one
/// granted tool. Any tool not listed here is ignored for grant purposes
/// (read-only tools never need a grant).
const GMAIL_AUTONOMOUS_TOOLS: &[&str] = &["create_draft", "send_email", "modify_labels", "archive"];
const GCAL_AUTONOMOUS_TOOLS: &[&str] = &["create_event", "respond_to_invite"];

#[tauri::command]
pub async fn connectors_list(app: tauri::AppHandle) -> Result<Vec<ConnectorAccount>, AppError> {
    list_accounts(&app).await
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorsConnectRequest {
    /// Bundle names: "gmail_read" | "gmail_draft" | "gmail_send" |
    /// "calendar_events".
    pub scopes: Vec<String>,
    /// Existing account email for incremental scope escalation.
    #[serde(default)]
    pub login_hint: Option<String>,
}

#[tauri::command]
pub async fn connectors_connect(
    app: tauri::AppHandle,
    flow: tauri::State<'_, ConnectFlow>,
    request: ConnectorsConnectRequest,
) -> Result<ConnectorAccount, AppError> {
    let bundles = parse_bundles(&request.scopes)?;
    begin_connect(&app, &flow, &bundles, request.login_hint.as_deref()).await
}

#[tauri::command]
pub fn connectors_cancel_connect(flow: tauri::State<'_, ConnectFlow>) -> Result<(), AppError> {
    super::cancel_connect(&flow);
    Ok(())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorsDisconnectRequest {
    pub account_id: String,
    /// Also revoke the grant at Google (best-effort) instead of only
    /// removing local custody.
    #[serde(default)]
    pub revoke: bool,
}

#[tauri::command]
pub async fn connectors_disconnect(
    app: tauri::AppHandle,
    request: ConnectorsDisconnectRequest,
) -> Result<(), AppError> {
    disconnect(&app, &request.account_id, request.revoke).await
}

// --- Routine trust modes -----------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutineTrustDto {
    pub trust_mode: String,
    pub approval_run_count: i64,
    pub autonomous_tools: Vec<String>,
    /// Names of the per-job auto MCP servers minted for the current
    /// autonomous grants (`june_<provider>_auto_<jobid8>`), sorted. Empty
    /// unless the routine is autonomous with granted mutating tools.
    pub autonomous_servers: Vec<String>,
}

#[tauri::command]
pub async fn routine_trust_get(
    app: tauri::AppHandle,
    job_id: String,
) -> Result<Option<RoutineTrustDto>, AppError> {
    let repos = crate::commands::repositories(&app).await?;
    let Some(record) = repos.routine_trust_get(&job_id).await? else {
        return Ok(None);
    };
    // Reflect the persisted grants so the UI shows the right toolset
    // composition on load.
    let servers = grant_server_names(&repos, &job_id).await?;
    Ok(Some(trust_dto(record, servers)))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutineTrustSetRequest {
    pub job_id: String,
    /// "read_only" | "approval" | "autonomous".
    pub trust_mode: String,
    /// Per-tool autonomy grants; only meaningful for "autonomous". Omitted
    /// means keep the existing grants.
    #[serde(default)]
    pub autonomous_tools: Option<Vec<String>>,
}

#[tauri::command]
pub async fn routine_trust_set(
    app: tauri::AppHandle,
    request: RoutineTrustSetRequest,
) -> Result<RoutineTrustDto, AppError> {
    validate_trust_mode(&request.trust_mode)?;
    let repos = crate::commands::repositories(&app).await?;
    let existing = repos.routine_trust_get(&request.job_id).await?;
    if request.trust_mode == "autonomous" {
        let run_count = existing
            .as_ref()
            .map(|record| record.approval_run_count)
            .unwrap_or(0);
        if !autonomy_earned(run_count) {
            return Err(AppError::new(
                "routine_trust_not_earned",
                format!(
                    "This routine needs {EARNED_AUTONOMY_MIN_APPROVAL_RUNS} completed approval runs before it can act on its own."
                ),
            ));
        }
    }
    let autonomous_tools = request.autonomous_tools.unwrap_or_else(|| {
        existing
            .map(|record| record.autonomous_tools)
            .unwrap_or_default()
    });
    let record = repos
        .routine_trust_set(&request.job_id, &request.trust_mode, &autonomous_tools)
        .await?;
    // Autonomy grant minting is the choke point for session-blind
    // attribution: an autonomous routine gets a per-provider grant (token +
    // tool names) that the bridge carries into a per-job auto MCP server.
    let servers = if record.trust_mode == "autonomous" {
        mint_autonomy_grants(&app, &repos, &record).await?
    } else {
        repos.delete_connector_grants(&record.job_id).await?;
        Vec::new()
    };
    Ok(trust_dto(record, servers))
}

/// Called after an approval-mode run completes; increments the earned-run
/// counter that unlocks autonomy.
#[tauri::command]
pub async fn routine_trust_record_run(
    app: tauri::AppHandle,
    job_id: String,
) -> Result<RoutineTrustDto, AppError> {
    let repos = crate::commands::repositories(&app).await?;
    let record = repos.routine_trust_record_run(&job_id).await?;
    let servers = grant_server_names(&repos, &job_id).await?;
    Ok(trust_dto(record, servers))
}

/// Build the trust DTO from a persisted record plus its current auto-server
/// names.
fn trust_dto(record: RoutineTrustRecord, autonomous_servers: Vec<String>) -> RoutineTrustDto {
    RoutineTrustDto {
        trust_mode: record.trust_mode,
        approval_run_count: record.approval_run_count,
        autonomous_tools: record.autonomous_tools,
        autonomous_servers,
    }
}

/// Sorted names of the auto MCP servers backing a job's current grants.
async fn grant_server_names(repos: &Repositories, job_id: &str) -> Result<Vec<String>, AppError> {
    let mut names: Vec<String> = repos
        .connector_grants_for_job(job_id)
        .await?
        .into_iter()
        .map(|grant| grant.server_name)
        .collect();
    names.sort();
    Ok(names)
}

/// The provider whose auto server owns a granted tool, or None for tools
/// that never need a grant.
fn provider_for_tool(tool: &str) -> Option<&'static str> {
    if GMAIL_AUTONOMOUS_TOOLS.contains(&tool) {
        Some("gmail")
    } else if GCAL_AUTONOMOUS_TOOLS.contains(&tool) {
        Some("gcal")
    } else {
        None
    }
}

/// First 8 chars of a sanitized job id (lowercase, `[a-z0-9]` only). Shared
/// deterministically with the frontend/bridge server-name pattern.
fn jobid8(job_id: &str) -> String {
    job_id
        .chars()
        .map(|ch| ch.to_ascii_lowercase())
        .filter(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit())
        .take(8)
        .collect()
}

fn tools_match(existing: &[String], wanted: &[String]) -> bool {
    let mut existing = existing.to_vec();
    let mut wanted = wanted.to_vec();
    existing.sort();
    wanted.sort();
    existing == wanted
}

/// Mint (or preserve) the per-provider autonomy grants for a routine that is
/// now autonomous.
///
/// Re-mint policy: the grant token is reused for a provider whose granted
/// tool set is unchanged, so an unrelated edit does not churn the token and
/// force a runtime restart; the token is re-minted only when that provider's
/// tools actually change. Providers no longer granted are dropped. Returns
/// the minted server names, sorted.
///
/// Account resolution is best-effort: the first connected account's email.
/// When none is connected the grant is still written with an empty
/// `account_id` (the bridge simply will not spawn a usable server); this is
/// not an error, so setting autonomy before connecting an account still
/// succeeds.
async fn mint_autonomy_grants(
    app: &tauri::AppHandle,
    repos: &Repositories,
    record: &RoutineTrustRecord,
) -> Result<Vec<String>, AppError> {
    let account_id = first_connected_account_email(app).await;
    let jobid8 = jobid8(&record.job_id);

    // Granted mutating tools grouped by provider (deduped, sorted, ordered).
    let mut by_provider: BTreeMap<&'static str, Vec<String>> = BTreeMap::new();
    for tool in &record.autonomous_tools {
        if let Some(provider) = provider_for_tool(tool) {
            let entry = by_provider.entry(provider).or_default();
            if !entry.iter().any(|existing| existing == tool) {
                entry.push(tool.clone());
            }
        }
    }
    for tools in by_provider.values_mut() {
        tools.sort();
    }

    // Existing grants (pre-change), so an unchanged provider keeps its token.
    let existing: BTreeMap<String, ConnectorGrant> = repos
        .connector_grants_for_job(&record.job_id)
        .await?
        .into_iter()
        .map(|grant| (grant.provider.clone(), grant))
        .collect();

    // Recreate the job's grants for exactly the current provider set. This
    // drops providers no longer granted; tokens are carried over where the
    // tool set matched.
    repos.delete_connector_grants(&record.job_id).await?;
    let created_at = crate::db::repositories::timestamp();
    let mut server_names = Vec::with_capacity(by_provider.len());
    for (provider, tools) in &by_provider {
        let server_name = format!("june_{provider}_auto_{jobid8}");
        let token = match existing.get(*provider) {
            Some(previous) if tools_match(&previous.tools, tools) => previous.token.clone(),
            _ => super::random_b64url(32),
        };
        let grant = ConnectorGrant {
            job_id: record.job_id.clone(),
            provider: (*provider).to_string(),
            server_name: server_name.clone(),
            token,
            tools: tools.clone(),
            account_id: account_id.clone(),
        };
        repos.set_connector_grant(&grant, &created_at).await?;
        server_names.push(server_name);
    }
    server_names.sort();
    Ok(server_names)
}

async fn first_connected_account_email(app: &tauri::AppHandle) -> String {
    match list_accounts(app).await {
        Ok(accounts) => accounts
            .into_iter()
            .find(|account| account.status == ConnectorAccountStatus::Connected)
            .map(|account| account.email)
            .unwrap_or_default(),
        // Never fail the trust change on an account-enumeration hiccup; the
        // grant is still written and can be re-minted once an account exists.
        Err(_) => String::new(),
    }
}

// --- Connector triggers --------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorTriggerDto {
    pub id: String,
    pub job_id: String,
    pub kind: String,
    pub account_id: String,
    pub config: serde_json::Value,
    pub created_at: String,
}

#[tauri::command]
pub async fn connector_triggers_list(
    app: tauri::AppHandle,
    job_id: Option<String>,
) -> Result<Vec<ConnectorTriggerDto>, AppError> {
    let repos = crate::commands::repositories(&app).await?;
    let records = repos.list_connector_triggers(job_id.as_deref()).await?;
    Ok(records
        .into_iter()
        .map(|record| ConnectorTriggerDto {
            config: serde_json::from_str(&record.config)
                .unwrap_or(serde_json::Value::Object(Default::default())),
            id: record.id,
            job_id: record.job_id,
            kind: record.kind,
            account_id: record.account_id,
            created_at: record.created_at,
        })
        .collect())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorTriggerSetRequest {
    pub job_id: String,
    /// "email_received" | "event_upcoming".
    pub kind: String,
    pub account_id: String,
    /// Trigger-specific settings (e.g. a Gmail query, a lead-time window).
    #[serde(default)]
    pub config: Option<serde_json::Value>,
}

#[tauri::command]
pub async fn connector_trigger_set(
    app: tauri::AppHandle,
    request: ConnectorTriggerSetRequest,
) -> Result<ConnectorTriggerDto, AppError> {
    validate_trigger_kind(&request.kind)?;
    let repos = crate::commands::repositories(&app).await?;
    if repos
        .get_connector_account(&request.account_id)
        .await?
        .is_none()
    {
        return Err(AppError::new(
            "connector_account_not_found",
            "That Google account is not connected.",
        ));
    }
    let config = request
        .config
        .unwrap_or(serde_json::Value::Object(Default::default()));
    let config_json = serde_json::to_string(&config)
        .map_err(|e| AppError::new("connector_trigger_invalid_config", e.to_string()))?;
    let record = repos
        .set_connector_trigger(
            &request.job_id,
            &request.kind,
            &request.account_id,
            &config_json,
        )
        .await?;
    Ok(ConnectorTriggerDto {
        config,
        id: record.id,
        job_id: record.job_id,
        kind: record.kind,
        account_id: record.account_id,
        created_at: record.created_at,
    })
}

#[tauri::command]
pub async fn connector_trigger_delete(app: tauri::AppHandle, id: String) -> Result<(), AppError> {
    let repos = crate::commands::repositories(&app).await?;
    // Idempotent: deleting an already-deleted trigger is not an error.
    repos.delete_connector_trigger(&id).await?;
    Ok(())
}

// --- Validation helpers -----------------------------------------------------------

fn parse_bundles(names: &[String]) -> Result<Vec<ScopeBundle>, AppError> {
    if names.is_empty() {
        return Err(AppError::new(
            "connector_unknown_scope_bundle",
            "At least one scope bundle is required.",
        ));
    }
    names
        .iter()
        .map(|name| {
            ScopeBundle::from_name(name).ok_or_else(|| {
                AppError::new(
                    "connector_unknown_scope_bundle",
                    format!("Unknown scope bundle \"{name}\"."),
                )
            })
        })
        .collect()
}

fn validate_trust_mode(mode: &str) -> Result<(), AppError> {
    if TRUST_MODES.contains(&mode) {
        Ok(())
    } else {
        Err(AppError::new(
            "routine_trust_invalid_mode",
            format!("Unknown trust mode \"{mode}\"."),
        ))
    }
}

fn validate_trigger_kind(kind: &str) -> Result<(), AppError> {
    if TRIGGER_KINDS.contains(&kind) {
        Ok(())
    } else {
        Err(AppError::new(
            "connector_trigger_invalid_kind",
            format!("Unknown trigger kind \"{kind}\"."),
        ))
    }
}

fn autonomy_earned(approval_run_count: i64) -> bool {
    approval_run_count >= EARNED_AUTONOMY_MIN_APPROVAL_RUNS
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_known_bundles_and_rejects_unknown() {
        let bundles = parse_bundles(&["gmail_read".to_string(), "calendar_events".to_string()])
            .expect("known bundles");
        assert_eq!(
            bundles,
            vec![ScopeBundle::GmailRead, ScopeBundle::CalendarEvents]
        );

        let error = parse_bundles(&["gmail_everything".to_string()]).unwrap_err();
        assert_eq!(error.code, "connector_unknown_scope_bundle");
        let error = parse_bundles(&[]).unwrap_err();
        assert_eq!(error.code, "connector_unknown_scope_bundle");
    }

    #[test]
    fn trust_mode_validation() {
        assert!(validate_trust_mode("read_only").is_ok());
        assert!(validate_trust_mode("approval").is_ok());
        assert!(validate_trust_mode("autonomous").is_ok());
        assert_eq!(
            validate_trust_mode("yolo").unwrap_err().code,
            "routine_trust_invalid_mode"
        );
    }

    #[test]
    fn trigger_kind_validation() {
        assert!(validate_trigger_kind("email_received").is_ok());
        assert!(validate_trigger_kind("event_upcoming").is_ok());
        assert_eq!(
            validate_trigger_kind("webhook").unwrap_err().code,
            "connector_trigger_invalid_kind"
        );
    }

    #[test]
    fn autonomy_needs_three_approval_runs() {
        assert!(!autonomy_earned(0));
        assert!(!autonomy_earned(2));
        assert!(autonomy_earned(3));
        assert!(autonomy_earned(10));
    }

    #[test]
    fn maps_tools_to_providers() {
        assert_eq!(provider_for_tool("create_draft"), Some("gmail"));
        assert_eq!(provider_for_tool("send_email"), Some("gmail"));
        assert_eq!(provider_for_tool("modify_labels"), Some("gmail"));
        assert_eq!(provider_for_tool("archive"), Some("gmail"));
        assert_eq!(provider_for_tool("create_event"), Some("gcal"));
        assert_eq!(provider_for_tool("respond_to_invite"), Some("gcal"));
        // Read-only or unknown tools need no grant.
        assert_eq!(provider_for_tool("read_thread"), None);
        assert_eq!(provider_for_tool("list_events"), None);
    }

    #[test]
    fn jobid8_sanitizes_and_truncates() {
        assert_eq!(jobid8("Job-ABC-123456789"), "jobabc12");
        assert_eq!(jobid8("cron_job_42"), "cronjob4");
        assert_eq!(jobid8("ab"), "ab");
        assert_eq!(jobid8("UUID-1234"), "uuid1234");
        // Deterministic.
        assert_eq!(jobid8("job-1"), jobid8("job-1"));
    }

    #[test]
    fn server_name_pattern_matches_contract() {
        let jobid8 = jobid8("job-1");
        assert_eq!(format!("june_gmail_auto_{jobid8}"), "june_gmail_auto_job1");
        assert_eq!(format!("june_gcal_auto_{jobid8}"), "june_gcal_auto_job1");
    }

    #[test]
    fn tools_match_is_order_independent() {
        assert!(tools_match(
            &["send_email".to_string(), "create_draft".to_string()],
            &["create_draft".to_string(), "send_email".to_string()],
        ));
        assert!(!tools_match(
            &["create_draft".to_string()],
            &["create_draft".to_string(), "send_email".to_string()],
        ));
    }
}
