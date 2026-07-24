//! Direct native connector tools for the June-owned agent runtime.
//!
//! The TypeScript harness sees only these function descriptors. Every call is
//! dispatched here, where June resolves a Keychain-held token and uses the
//! provider client directly. This deliberately does not call the legacy
//! connector approval registry: mutations are paused by the SDK through each
//! descriptor's `requiresApproval` flag, then reach this module exactly once
//! after the durable agent-run approval has been resolved.

use crate::{
    connectors::{
        self,
        policy::{
            self, CALENDAR_EVENTS, CALENDAR_READONLY, GITHUB_READ, GITHUB_WRITE, GMAIL_COMPOSE,
            GMAIL_READONLY, GMAIL_SEND, LINEAR_READ, LINEAR_WRITE,
        },
        ConnectorAccount, ConnectorAccountStatus, ConnectorProvider,
    },
    domain::types::AppError,
};
use chrono::{DateTime, Utc};
use serde::Deserialize;
use serde_json::{json, Map, Value};
use tauri::AppHandle;

const PROVIDER_LINEAR: &str = "linear";
const PROVIDER_GITHUB: &str = "github";

#[derive(Clone, Copy)]
struct Capability {
    name: &'static str,
    description: &'static str,
    provider: ConnectorProvider,
    required_scope: &'static str,
    mutation: bool,
    needs_selected_teams: bool,
}

const CAPABILITIES: &[Capability] = &[
    Capability {
        name: "search_threads",
        description: "Search connected Gmail threads and return compact summaries.",
        provider: ConnectorProvider::Google,
        required_scope: GMAIL_READONLY,
        mutation: false,
        needs_selected_teams: false,
    },
    Capability {
        name: "read_thread",
        description: "Read the messages and plain-text bodies in one connected Gmail thread.",
        provider: ConnectorProvider::Google,
        required_scope: GMAIL_READONLY,
        mutation: false,
        needs_selected_teams: false,
    },
    Capability {
        name: "list_unread",
        description: "List unread messages from the connected Gmail inbox.",
        provider: ConnectorProvider::Google,
        required_scope: GMAIL_READONLY,
        mutation: false,
        needs_selected_teams: false,
    },
    Capability {
        name: "create_draft",
        description: "Create a Gmail draft. The user must approve this action.",
        provider: ConnectorProvider::Google,
        required_scope: GMAIL_COMPOSE,
        mutation: true,
        needs_selected_teams: false,
    },
    Capability {
        name: "send_email",
        description: "Send an email through Gmail. The user must approve this action.",
        provider: ConnectorProvider::Google,
        required_scope: GMAIL_SEND,
        mutation: true,
        needs_selected_teams: false,
    },
    Capability {
        name: "list_events",
        description: "List events from a connected Google calendar.",
        provider: ConnectorProvider::Google,
        required_scope: CALENDAR_READONLY,
        mutation: false,
        needs_selected_teams: false,
    },
    Capability {
        name: "get_event",
        description: "Read one event from a connected Google calendar.",
        provider: ConnectorProvider::Google,
        required_scope: CALENDAR_READONLY,
        mutation: false,
        needs_selected_teams: false,
    },
    Capability {
        name: "find_free_slots",
        description: "Find free time in a connected Google calendar.",
        provider: ConnectorProvider::Google,
        required_scope: CALENDAR_READONLY,
        mutation: false,
        needs_selected_teams: false,
    },
    Capability {
        name: "create_event",
        description: "Create a Google calendar event. The user must approve this action.",
        provider: ConnectorProvider::Google,
        required_scope: CALENDAR_EVENTS,
        mutation: true,
        needs_selected_teams: false,
    },
    Capability {
        name: "list_repositories",
        description: "List repositories available through the connected GitHub App.",
        provider: ConnectorProvider::Github,
        required_scope: GITHUB_READ,
        mutation: false,
        needs_selected_teams: false,
    },
    Capability {
        name: "get_pull_request",
        description: "Read one pull request from the connected GitHub account.",
        provider: ConnectorProvider::Github,
        required_scope: GITHUB_READ,
        mutation: false,
        needs_selected_teams: false,
    },
    Capability {
        name: "list_projects",
        description: "List Linear projects in the connected workspace's selected teams.",
        provider: ConnectorProvider::Linear,
        required_scope: LINEAR_READ,
        mutation: false,
        needs_selected_teams: true,
    },
];

/// Build a fresh catalog from the non-secret account index. It is invoked for
/// every start, retry, and resume so reconnects, scope changes, and selected
/// team changes cannot leave an old tool available in a later run.
pub async fn descriptors(app: &AppHandle) -> Result<Vec<Value>, AppError> {
    let accounts = connectors::list_runtime_accounts(app).await?;
    Ok(descriptors_from_accounts(&accounts))
}

fn descriptors_from_accounts(accounts: &[ConnectorAccount]) -> Vec<Value> {
    let mut descriptors = CAPABILITIES
        .iter()
        .filter_map(|capability| {
            let ids = eligible_account_ids(
                accounts,
                capability.provider,
                capability.required_scope,
                capability.needs_selected_teams,
            );
            (!ids.is_empty()).then(|| account_descriptor(*capability, ids))
        })
        .collect::<Vec<_>>();

    let linear_read = eligible_account_ids(accounts, ConnectorProvider::Linear, LINEAR_READ, true);
    let github_read = eligible_account_ids(accounts, ConnectorProvider::Github, GITHUB_READ, false);
    if !linear_read.is_empty() || !github_read.is_empty() {
        let providers = provider_choices(!linear_read.is_empty(), !github_read.is_empty());
        let ids = [linear_read, github_read].concat();
        descriptors.extend([
            provider_descriptor(
                "search_issues",
                "Search issues in Linear selected teams or GitHub repositories.",
                &providers,
                ids.clone(),
                false,
            ),
            provider_descriptor(
                "get_issue",
                "Read one Linear or GitHub issue.",
                &providers,
                ids.clone(),
                false,
            ),
            provider_descriptor(
                "list_issue_comments",
                "List comments on one Linear or GitHub issue.",
                &providers,
                ids,
                false,
            ),
        ]);
    }
    let linear_write =
        eligible_account_ids(accounts, ConnectorProvider::Linear, LINEAR_WRITE, true);
    let github_write =
        eligible_account_ids(accounts, ConnectorProvider::Github, GITHUB_WRITE, false);
    if !linear_write.is_empty() || !github_write.is_empty() {
        let providers = provider_choices(!linear_write.is_empty(), !github_write.is_empty());
        let ids = [linear_write, github_write].concat();
        descriptors.extend([
            provider_descriptor(
                "create_issue",
                "Create a Linear or GitHub issue. The user must approve this action.",
                &providers,
                ids.clone(),
                true,
            ),
            provider_descriptor(
                "update_issue",
                "Update a Linear or GitHub issue. The user must approve this action.",
                &providers,
                ids.clone(),
                true,
            ),
            provider_descriptor(
                "add_comment",
                "Add a Linear or GitHub issue comment. The user must approve this action.",
                &providers,
                ids,
                true,
            ),
        ]);
    }
    if !eligible_account_ids(accounts, ConnectorProvider::Linear, LINEAR_WRITE, true).is_empty() {
        descriptors.push(account_descriptor(
            Capability { name: "create_project_update", description: "Create a Linear project update in a selected team. The user must approve this action.", provider: ConnectorProvider::Linear, required_scope: LINEAR_WRITE, mutation: true, needs_selected_teams: true },
            eligible_account_ids(accounts, ConnectorProvider::Linear, LINEAR_WRITE, true),
        ));
    }
    descriptors
}

fn provider_choices(linear: bool, github: bool) -> Vec<&'static str> {
    [
        linear.then_some(PROVIDER_LINEAR),
        github.then_some(PROVIDER_GITHUB),
    ]
    .into_iter()
    .flatten()
    .collect()
}

fn eligible_account_ids(
    accounts: &[ConnectorAccount],
    provider: ConnectorProvider,
    scope: &str,
    needs_selected_teams: bool,
) -> Vec<String> {
    accounts
        .iter()
        .filter(|account| {
            account.provider == provider
                && account.status == ConnectorAccountStatus::Connected
                && account
                    .scopes
                    .iter()
                    .any(|held| policy::scope_grants(held, scope))
                && (!needs_selected_teams || !account.selected_teams.is_empty())
        })
        .map(|account| account.account_id.clone())
        .collect()
}

fn account_descriptor(capability: Capability, account_ids: Vec<String>) -> Value {
    let (mut properties, mut required) = input_schema(capability.name);
    properties.insert(
        "accountId".to_string(),
        json!({ "type": "string", "enum": account_ids }),
    );
    required.push("accountId");
    descriptor(
        capability.name,
        capability.description,
        properties,
        required,
        capability.mutation,
    )
}

fn provider_descriptor(
    name: &str,
    description: &str,
    providers: &[&str],
    account_ids: Vec<String>,
    mutation: bool,
) -> Value {
    let (mut properties, mut required) = input_schema(name);
    properties.insert(
        "provider".to_string(),
        json!({ "type": "string", "enum": providers }),
    );
    properties.insert(
        "accountId".to_string(),
        json!({ "type": "string", "enum": account_ids }),
    );
    required.extend(["provider", "accountId"]);
    descriptor(name, description, properties, required, mutation)
}

fn input_schema(name: &str) -> (Map<String, Value>, Vec<&'static str>) {
    let mut properties = Map::new();
    let mut required = Vec::new();
    let string = || json!({ "type": "string" });
    let integer = || json!({ "type": "integer" });
    let strings = || json!({ "type": "array", "items": { "type": "string" } });
    match name {
        "search_threads" | "list_unread" => {
            properties.insert("query".into(), string());
            properties.insert("maxResults".into(), integer());
            properties.insert("pageToken".into(), string());
        }
        "read_thread" => {
            properties.insert("threadId".into(), string());
            required.push("threadId");
        }
        "create_draft" | "send_email" => {
            properties.insert("to".into(), strings());
            properties.insert("cc".into(), strings());
            properties.insert("subject".into(), string());
            properties.insert("bodyText".into(), string());
            properties.insert("inReplyTo".into(), string());
            properties.insert("references".into(), string());
            properties.insert("threadId".into(), string());
            required.extend(["to", "subject", "bodyText"]);
        }
        "list_events" => {
            properties.insert("calendarId".into(), string());
            properties.insert("timeMin".into(), string());
            properties.insert("timeMax".into(), string());
            properties.insert("maxResults".into(), integer());
            properties.insert("pageToken".into(), string());
        }
        "get_event" => {
            properties.insert("calendarId".into(), string());
            properties.insert("eventId".into(), string());
            required.push("eventId");
        }
        "find_free_slots" => {
            properties.insert("timeMin".into(), string());
            properties.insert("timeMax".into(), string());
            properties.insert("calendarIds".into(), strings());
            properties.insert("workingStartHour".into(), integer());
            properties.insert("workingEndHour".into(), integer());
            properties.insert("utcOffsetMinutes".into(), integer());
            properties.insert("minSlotMinutes".into(), integer());
            required.extend(["timeMin", "timeMax"]);
        }
        "create_event" => {
            properties.insert("calendarId".into(), string());
            properties.insert("summary".into(), string());
            properties.insert("description".into(), string());
            properties.insert("location".into(), string());
            properties.insert("startRfc3339".into(), string());
            properties.insert("endRfc3339".into(), string());
            properties.insert("attendeeEmails".into(), strings());
            required.extend(["summary", "startRfc3339", "endRfc3339"]);
        }
        "get_pull_request" => {
            properties.insert("owner".into(), string());
            properties.insert("repo".into(), string());
            properties.insert("number".into(), integer());
            required.extend(["owner", "repo", "number"]);
        }
        "search_issues" => {
            properties.insert("query".into(), string());
            properties.insert("stateType".into(), string());
            properties.insert("assigneeId".into(), string());
            properties.insert("first".into(), integer());
        }
        "get_issue" | "list_issue_comments" => {
            properties.insert("issueId".into(), string());
            properties.insert("owner".into(), string());
            properties.insert("repo".into(), string());
            properties.insert("number".into(), integer());
            properties.insert("first".into(), integer());
        }
        "create_issue" => {
            properties.insert("teamId".into(), string());
            properties.insert("owner".into(), string());
            properties.insert("repo".into(), string());
            properties.insert("title".into(), string());
            properties.insert("description".into(), string());
            properties.insert("body".into(), string());
            properties.insert("priority".into(), integer());
            properties.insert("assigneeId".into(), string());
            properties.insert("projectId".into(), string());
            properties.insert("labels".into(), strings());
            required.push("title");
        }
        "update_issue" => {
            properties.insert("issueId".into(), string());
            properties.insert("owner".into(), string());
            properties.insert("repo".into(), string());
            properties.insert("number".into(), integer());
            properties.insert("title".into(), string());
            properties.insert("description".into(), string());
            properties.insert("body".into(), string());
            properties.insert("stateId".into(), string());
            properties.insert("priority".into(), integer());
            properties.insert("assigneeId".into(), string());
            properties.insert("projectId".into(), string());
            properties.insert("cycleId".into(), string());
            properties.insert("labels".into(), strings());
        }
        "add_comment" => {
            properties.insert("issueId".into(), string());
            properties.insert("owner".into(), string());
            properties.insert("repo".into(), string());
            properties.insert("number".into(), integer());
            properties.insert("body".into(), string());
            required.push("body");
        }
        "create_project_update" => {
            properties.insert("projectId".into(), string());
            properties.insert("body".into(), string());
            properties.insert(
                "health".into(),
                json!({ "type": "string", "enum": ["onTrack", "atRisk", "offTrack"] }),
            );
            required.extend(["projectId", "body"]);
        }
        _ => {}
    }
    (properties, required)
}

fn descriptor(
    name: &str,
    description: &str,
    properties: Map<String, Value>,
    required: Vec<&str>,
    requires_approval: bool,
) -> Value {
    json!({
        "name": name,
        "description": description,
        "parameters": { "type": "object", "properties": properties, "required": required, "additionalProperties": false },
        "requiresApproval": requires_approval,
    })
}

/// Returns `Ok(None)` for a non-connector tool. A matching native tool is
/// always re-authorized from live account state rather than trusting the
/// descriptor emitted at run start.
pub async fn dispatch(
    app: &AppHandle,
    name: &str,
    arguments: Value,
) -> Result<Option<Value>, AppError> {
    let result = match name {
        "search_threads" => gmail_search_threads(app, arguments).await,
        "read_thread" => gmail_read_thread(app, arguments).await,
        "list_unread" => gmail_list_unread(app, arguments).await,
        "create_draft" => gmail_create_draft(app, arguments).await,
        "send_email" => gmail_send_email(app, arguments).await,
        "list_events" => calendar_list_events(app, arguments).await,
        "get_event" => calendar_get_event(app, arguments).await,
        "find_free_slots" => calendar_find_free_slots(app, arguments).await,
        "create_event" => calendar_create_event(app, arguments).await,
        "list_repositories" => github_list_repositories(app, arguments).await,
        "get_pull_request" => github_get_pull_request(app, arguments).await,
        "list_projects" => linear_list_projects(app, arguments).await,
        "search_issues" => issues_search(app, arguments).await,
        "get_issue" => issues_get(app, arguments).await,
        "list_issue_comments" => issues_comments(app, arguments).await,
        "create_issue" => issues_create(app, arguments).await,
        "update_issue" => issues_update(app, arguments).await,
        "add_comment" => issues_add_comment(app, arguments).await,
        "create_project_update" => linear_create_project_update(app, arguments).await,
        _ => return Ok(None),
    }?;
    Ok(Some(result))
}

async fn authorized_account(
    app: &AppHandle,
    account_id: &str,
    provider: ConnectorProvider,
    scope: &str,
    teams: bool,
) -> Result<ConnectorAccount, AppError> {
    let account = connectors::list_runtime_accounts(app)
        .await?
        .into_iter()
        .find(|account| account.account_id == account_id && account.provider == provider)
        .ok_or_else(|| {
            AppError::new(
                "connector_not_connected",
                "This connector account is not connected.",
            )
        })?;
    if account.status != ConnectorAccountStatus::Connected {
        return Err(AppError::new(
            "connector_reconnect_required",
            "Reconnect this connector account in settings.",
        ));
    }
    if !account
        .scopes
        .iter()
        .any(|held| policy::scope_grants(held, scope))
    {
        return Err(AppError::new(
            "connector_scope_missing",
            "This connector account does not have the required permission.",
        ));
    }
    if teams && account.selected_teams.is_empty() {
        return Err(AppError::new(
            "linear_teams_not_selected",
            "Select at least one Linear team in settings.",
        ));
    }
    Ok(account)
}

fn json_error(error: serde_json::Error) -> AppError {
    AppError::new("agent_connector_invalid_response", error.to_string())
}

/// Provider clients define their own `From<ProviderError> for AppError`
/// conversions. Keep every provider error on that reviewed, sanitized path;
/// JSON handling above is intentionally separate because it is local input or
/// serialization failure, not an upstream response.
fn app_error<E>(error: E) -> AppError
where
    AppError: From<E>,
{
    AppError::from(error)
}
fn required(arguments: &Value, field: &str) -> Result<String, AppError> {
    arguments
        .get(field)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .ok_or_else(|| AppError::new("invalid_arguments", format!("{field} is required.")))
}
fn optional(arguments: &Value, field: &str) -> Option<String> {
    arguments
        .get(field)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}
fn number(arguments: &Value, field: &str) -> Option<u32> {
    arguments
        .get(field)
        .and_then(Value::as_u64)
        .and_then(|value| u32::try_from(value).ok())
}
fn account_id(arguments: &Value) -> Result<String, AppError> {
    required(arguments, "accountId")
}
fn as_value(value: impl serde::Serialize) -> Result<Value, AppError> {
    serde_json::to_value(value).map_err(json_error)
}

async fn google_token(app: &AppHandle, arguments: &Value, scope: &str) -> Result<String, AppError> {
    let account = authorized_account(
        app,
        &account_id(arguments)?,
        ConnectorProvider::Google,
        scope,
        false,
    )
    .await?;
    connectors::google_access_token(app, &account.account_id).await
}

async fn gmail_search_threads(app: &AppHandle, arguments: Value) -> Result<Value, AppError> {
    let token = google_token(app, &arguments, GMAIL_READONLY).await?;
    as_value(
        crate::connectors::google::list_threads(
            &token,
            optional(&arguments, "query").as_deref(),
            number(&arguments, "maxResults"),
            optional(&arguments, "pageToken").as_deref(),
        )
        .await
        .map_err(app_error)?,
    )
}
async fn gmail_read_thread(app: &AppHandle, arguments: Value) -> Result<Value, AppError> {
    let token = google_token(app, &arguments, GMAIL_READONLY).await?;
    as_value(
        crate::connectors::google::read_thread(&token, &required(&arguments, "threadId")?)
            .await
            .map_err(app_error)?,
    )
}
async fn gmail_list_unread(app: &AppHandle, arguments: Value) -> Result<Value, AppError> {
    let token = google_token(app, &arguments, GMAIL_READONLY).await?;
    as_value(
        crate::connectors::google::list_unread(
            &token,
            number(&arguments, "maxResults"),
            optional(&arguments, "pageToken").as_deref(),
        )
        .await
        .map_err(app_error)?,
    )
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EmailArgs {
    to: Vec<String>,
    #[serde(default)]
    cc: Vec<String>,
    subject: String,
    body_text: String,
    #[serde(default)]
    in_reply_to: Option<String>,
    #[serde(default)]
    references: Option<String>,
    #[serde(default)]
    thread_id: Option<String>,
}
fn email(args: EmailArgs) -> crate::connectors::google::OutgoingEmail {
    crate::connectors::google::OutgoingEmail {
        to: args.to,
        cc: args.cc,
        subject: args.subject,
        body_text: args.body_text,
        in_reply_to: args.in_reply_to,
        references: args.references,
        thread_id: args.thread_id,
    }
}
async fn gmail_create_draft(app: &AppHandle, arguments: Value) -> Result<Value, AppError> {
    let email_args: EmailArgs = serde_json::from_value(arguments.clone()).map_err(json_error)?;
    let token = google_token(app, &arguments, GMAIL_COMPOSE).await?;
    as_value(
        crate::connectors::google::create_draft(&token, &email(email_args))
            .await
            .map_err(app_error)?,
    )
}
async fn gmail_send_email(app: &AppHandle, arguments: Value) -> Result<Value, AppError> {
    let email_args: EmailArgs = serde_json::from_value(arguments.clone()).map_err(json_error)?;
    let token = google_token(app, &arguments, GMAIL_SEND).await?;
    as_value(
        crate::connectors::google::send_email(&token, &email(email_args))
            .await
            .map_err(app_error)?,
    )
}

async fn calendar_list_events(app: &AppHandle, arguments: Value) -> Result<Value, AppError> {
    let token = google_token(app, &arguments, CALENDAR_READONLY).await?;
    let params = crate::connectors::google::ListEventsParams {
        calendar_id: optional(&arguments, "calendarId"),
        time_min: optional(&arguments, "timeMin"),
        time_max: optional(&arguments, "timeMax"),
        max_results: number(&arguments, "maxResults"),
        page_token: optional(&arguments, "pageToken"),
        sync_token: None,
    };
    as_value(
        crate::connectors::google::list_events(&token, &params)
            .await
            .map_err(app_error)?,
    )
}
async fn calendar_get_event(app: &AppHandle, arguments: Value) -> Result<Value, AppError> {
    let token = google_token(app, &arguments, CALENDAR_READONLY).await?;
    as_value(
        crate::connectors::google::get_event(
            &token,
            optional(&arguments, "calendarId").as_deref(),
            &required(&arguments, "eventId")?,
        )
        .await
        .map_err(app_error)?,
    )
}
async fn calendar_find_free_slots(app: &AppHandle, arguments: Value) -> Result<Value, AppError> {
    let token = google_token(app, &arguments, CALENDAR_READONLY).await?;
    let time_min = parse_time(&required(&arguments, "timeMin")?)?;
    let time_max = parse_time(&required(&arguments, "timeMax")?)?;
    let calendar_ids = arguments
        .get("calendarIds")
        .and_then(Value::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect::<Vec<String>>()
        })
        .unwrap_or_default();
    let busy = crate::connectors::google::freebusy(
        &token,
        &time_min.to_rfc3339(),
        &time_max.to_rfc3339(),
        &calendar_ids,
    )
    .await
    .map_err(app_error)?;
    let params = crate::connectors::google::FreeSlotParams {
        time_min,
        time_max,
        working_start_hour: number(&arguments, "workingStartHour").unwrap_or(9),
        working_end_hour: number(&arguments, "workingEndHour").unwrap_or(17),
        utc_offset_minutes: arguments
            .get("utcOffsetMinutes")
            .and_then(Value::as_i64)
            .unwrap_or(0) as i32,
        min_slot_minutes: arguments
            .get("minSlotMinutes")
            .and_then(Value::as_i64)
            .unwrap_or(30),
    };
    as_value(crate::connectors::google::find_free_slots(&params, &busy))
}
fn parse_time(value: &str) -> Result<DateTime<Utc>, AppError> {
    DateTime::parse_from_rfc3339(value)
        .map(|time| time.with_timezone(&Utc))
        .map_err(|_| {
            AppError::new(
                "invalid_arguments",
                "Calendar times must be RFC 3339 timestamps.",
            )
        })
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EventArgs {
    #[serde(default)]
    calendar_id: Option<String>,
    summary: String,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    location: Option<String>,
    start_rfc3339: String,
    end_rfc3339: String,
    #[serde(default)]
    attendee_emails: Vec<String>,
}
async fn calendar_create_event(app: &AppHandle, arguments: Value) -> Result<Value, AppError> {
    let event: EventArgs = serde_json::from_value(arguments.clone()).map_err(json_error)?;
    let token = google_token(app, &arguments, CALENDAR_EVENTS).await?;
    let payload = crate::connectors::google::NewEvent {
        summary: event.summary,
        description: event.description,
        location: event.location,
        start_rfc3339: event.start_rfc3339,
        end_rfc3339: event.end_rfc3339,
        attendee_emails: event.attendee_emails,
    };
    as_value(
        crate::connectors::google::insert_event(&token, event.calendar_id.as_deref(), &payload)
            .await
            .map_err(app_error)?,
    )
}

async fn github_token(app: &AppHandle, arguments: &Value, scope: &str) -> Result<String, AppError> {
    let account = authorized_account(
        app,
        &account_id(arguments)?,
        ConnectorProvider::Github,
        scope,
        false,
    )
    .await?;
    connectors::github_access_token(app, &account.account_id).await
}
async fn github_list_repositories(app: &AppHandle, arguments: Value) -> Result<Value, AppError> {
    let token = github_token(app, &arguments, GITHUB_READ).await?;
    as_value(
        crate::connectors::github::list_repositories(&token)
            .await
            .map_err(app_error)?,
    )
}
async fn github_get_pull_request(app: &AppHandle, arguments: Value) -> Result<Value, AppError> {
    let token = github_token(app, &arguments, GITHUB_READ).await?;
    as_value(
        crate::connectors::github::get_pull_request(
            &token,
            &required(&arguments, "owner")?,
            &required(&arguments, "repo")?,
            parse_number(&arguments)?,
        )
        .await
        .map_err(app_error)?,
    )
}

async fn linear_token_and_teams(
    app: &AppHandle,
    arguments: &Value,
    scope: &str,
) -> Result<(String, Vec<String>), AppError> {
    let account = authorized_account(
        app,
        &account_id(arguments)?,
        ConnectorProvider::Linear,
        scope,
        true,
    )
    .await?;
    let teams = connectors::linear_granted_team_ids(app, &account.account_id).await?;
    Ok((
        connectors::linear_access_token(app, &account.account_id).await?,
        teams,
    ))
}
async fn linear_list_projects(app: &AppHandle, arguments: Value) -> Result<Value, AppError> {
    let (token, teams) = linear_token_and_teams(app, &arguments, LINEAR_READ).await?;
    as_value(
        crate::connectors::linear::list_projects(&token, &teams)
            .await
            .map_err(app_error)?,
    )
}

fn issue_provider(arguments: &Value) -> Result<&str, AppError> {
    match required(arguments, "provider")?.as_str() {
        PROVIDER_LINEAR => Ok(PROVIDER_LINEAR),
        PROVIDER_GITHUB => Ok(PROVIDER_GITHUB),
        _ => Err(AppError::new(
            "invalid_arguments",
            "provider must be linear or github.",
        )),
    }
}
async fn issues_search(app: &AppHandle, arguments: Value) -> Result<Value, AppError> {
    match issue_provider(&arguments)? {
        PROVIDER_LINEAR => {
            let (token, teams) = linear_token_and_teams(app, &arguments, LINEAR_READ).await?;
            let params = crate::connectors::linear::IssueSearchParams {
                query: optional(&arguments, "query"),
                team_ids: teams,
                state_type: optional(&arguments, "stateType"),
                assignee_id: optional(&arguments, "assigneeId"),
                first: number(&arguments, "first"),
            };
            as_value(
                crate::connectors::linear::search_issues(&token, &params)
                    .await
                    .map_err(app_error)?,
            )
        }
        PROVIDER_GITHUB => {
            let token = github_token(app, &arguments, GITHUB_READ).await?;
            as_value(
                crate::connectors::github::search_issues(
                    &token,
                    &required(&arguments, "query")?,
                    number(&arguments, "first"),
                )
                .await
                .map_err(app_error)?,
            )
        }
        _ => unreachable!(),
    }
}
async fn issues_get(app: &AppHandle, arguments: Value) -> Result<Value, AppError> {
    match issue_provider(&arguments)? {
        PROVIDER_LINEAR => {
            let (token, teams) = linear_token_and_teams(app, &arguments, LINEAR_READ).await?;
            let issue =
                crate::connectors::linear::get_issue(&token, &required(&arguments, "issueId")?)
                    .await
                    .map_err(app_error)?;
            connectors::linear_require_any_team_granted(
                std::slice::from_ref(&issue.team_id),
                &teams,
            )?;
            as_value(issue)
        }
        PROVIDER_GITHUB => {
            let token = github_token(app, &arguments, GITHUB_READ).await?;
            as_value(
                crate::connectors::github::get_issue(
                    &token,
                    &required(&arguments, "owner")?,
                    &required(&arguments, "repo")?,
                    parse_number(&arguments)?,
                )
                .await
                .map_err(app_error)?,
            )
        }
        _ => unreachable!(),
    }
}
async fn issues_comments(app: &AppHandle, arguments: Value) -> Result<Value, AppError> {
    match issue_provider(&arguments)? {
        PROVIDER_LINEAR => {
            let (token, teams) = linear_token_and_teams(app, &arguments, LINEAR_READ).await?;
            let (team, comments) = crate::connectors::linear::list_issue_comments(
                &token,
                &required(&arguments, "issueId")?,
                number(&arguments, "first"),
            )
            .await
            .map_err(app_error)?;
            connectors::linear_require_any_team_granted(&[team], &teams)?;
            as_value(comments)
        }
        PROVIDER_GITHUB => {
            let token = github_token(app, &arguments, GITHUB_READ).await?;
            as_value(
                crate::connectors::github::list_issue_comments(
                    &token,
                    &required(&arguments, "owner")?,
                    &required(&arguments, "repo")?,
                    parse_number(&arguments)?,
                    number(&arguments, "first"),
                )
                .await
                .map_err(app_error)?,
            )
        }
        _ => unreachable!(),
    }
}
fn parse_number(arguments: &Value) -> Result<u64, AppError> {
    arguments
        .get("number")
        .and_then(Value::as_u64)
        .ok_or_else(|| AppError::new("invalid_arguments", "number must be an integer."))
}

async fn issues_create(app: &AppHandle, arguments: Value) -> Result<Value, AppError> {
    match issue_provider(&arguments)? {
        PROVIDER_LINEAR => {
            let (token, teams) = linear_token_and_teams(app, &arguments, LINEAR_WRITE).await?;
            let team_id = required(&arguments, "teamId")?;
            connectors::linear_require_team_granted(&team_id, &teams)?;
            let project_id = optional(&arguments, "projectId");
            if let Some(project_id) = project_id.as_deref() {
                let project_teams =
                    crate::connectors::linear::get_project_team_ids(&token, project_id)
                        .await
                        .map_err(app_error)?;
                connectors::linear_require_any_team_granted(&project_teams, &teams)?;
            }
            let input = crate::connectors::linear::LinearIssueCreate {
                id: uuid::Uuid::new_v4().to_string(),
                team_id,
                title: required(&arguments, "title")?,
                description: optional(&arguments, "description"),
                priority: arguments.get("priority").and_then(Value::as_i64),
                assignee_id: optional(&arguments, "assigneeId"),
                project_id,
            };
            as_value(
                crate::connectors::linear::create_issue(&token, input)
                    .await
                    .map_err(app_error)?,
            )
        }
        PROVIDER_GITHUB => {
            let token = github_token(app, &arguments, GITHUB_WRITE).await?;
            let labels = string_list(&arguments, "labels");
            as_value(
                crate::connectors::github::create_issue(
                    &token,
                    &required(&arguments, "owner")?,
                    &required(&arguments, "repo")?,
                    &required(&arguments, "title")?,
                    optional(&arguments, "body").as_deref(),
                    labels.as_deref(),
                )
                .await
                .map_err(app_error)?,
            )
        }
        _ => unreachable!(),
    }
}
async fn issues_update(app: &AppHandle, arguments: Value) -> Result<Value, AppError> {
    match issue_provider(&arguments)? {
        PROVIDER_LINEAR => {
            let (token, teams) = linear_token_and_teams(app, &arguments, LINEAR_WRITE).await?;
            let issue_id = required(&arguments, "issueId")?;
            let current = crate::connectors::linear::get_issue(&token, &issue_id)
                .await
                .map_err(app_error)?;
            connectors::linear_require_any_team_granted(&[current.team_id], &teams)?;
            let project_id = optional(&arguments, "projectId");
            if let Some(project_id) = project_id.as_deref() {
                let project_teams =
                    crate::connectors::linear::get_project_team_ids(&token, project_id)
                        .await
                        .map_err(app_error)?;
                connectors::linear_require_any_team_granted(&project_teams, &teams)?;
            }
            let input = crate::connectors::linear::LinearIssueUpdate {
                title: optional(&arguments, "title"),
                description: optional(&arguments, "description"),
                state_id: optional(&arguments, "stateId"),
                priority: arguments.get("priority").and_then(Value::as_i64),
                assignee_id: optional(&arguments, "assigneeId"),
                project_id,
                cycle_id: optional(&arguments, "cycleId"),
            };
            as_value(
                crate::connectors::linear::update_issue(&token, &issue_id, input)
                    .await
                    .map_err(app_error)?,
            )
        }
        PROVIDER_GITHUB => {
            let token = github_token(app, &arguments, GITHUB_WRITE).await?;
            let labels = string_list(&arguments, "labels");
            as_value(
                crate::connectors::github::update_issue(
                    &token,
                    &required(&arguments, "owner")?,
                    &required(&arguments, "repo")?,
                    parse_number(&arguments)?,
                    optional(&arguments, "title").as_deref(),
                    optional(&arguments, "body").as_deref(),
                    labels.as_deref(),
                )
                .await
                .map_err(app_error)?,
            )
        }
        _ => unreachable!(),
    }
}
async fn issues_add_comment(app: &AppHandle, arguments: Value) -> Result<Value, AppError> {
    match issue_provider(&arguments)? {
        PROVIDER_LINEAR => {
            let (token, teams) = linear_token_and_teams(app, &arguments, LINEAR_WRITE).await?;
            let issue_id = required(&arguments, "issueId")?;
            let issue = crate::connectors::linear::get_issue(&token, &issue_id)
                .await
                .map_err(app_error)?;
            connectors::linear_require_any_team_granted(&[issue.team_id], &teams)?;
            let input = crate::connectors::linear::LinearCommentCreate {
                id: uuid::Uuid::new_v4().to_string(),
                issue_id,
                body: required(&arguments, "body")?,
            };
            as_value(
                crate::connectors::linear::add_comment(&token, input)
                    .await
                    .map_err(app_error)?,
            )
        }
        PROVIDER_GITHUB => {
            let token = github_token(app, &arguments, GITHUB_WRITE).await?;
            as_value(
                crate::connectors::github::add_comment(
                    &token,
                    &required(&arguments, "owner")?,
                    &required(&arguments, "repo")?,
                    parse_number(&arguments)?,
                    &required(&arguments, "body")?,
                )
                .await
                .map_err(app_error)?,
            )
        }
        _ => unreachable!(),
    }
}
async fn linear_create_project_update(
    app: &AppHandle,
    arguments: Value,
) -> Result<Value, AppError> {
    let (token, teams) = linear_token_and_teams(app, &arguments, LINEAR_WRITE).await?;
    let project_id = required(&arguments, "projectId")?;
    let project_teams = crate::connectors::linear::get_project_team_ids(&token, &project_id)
        .await
        .map_err(app_error)?;
    connectors::linear_require_any_team_granted(&project_teams, &teams)?;
    let input = crate::connectors::linear::LinearProjectUpdateCreate {
        id: uuid::Uuid::new_v4().to_string(),
        project_id,
        body: required(&arguments, "body")?,
        health: optional(&arguments, "health"),
    };
    as_value(
        crate::connectors::linear::create_project_update(&token, input)
            .await
            .map_err(app_error)?,
    )
}
fn string_list(arguments: &Value, field: &str) -> Option<Vec<String>> {
    arguments
        .get(field)
        .and_then(Value::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn account(provider: ConnectorProvider, scopes: &[&str], teams: usize) -> ConnectorAccount {
        ConnectorAccount {
            account_id: format!("{provider:?}-account"),
            provider,
            email: "account@example.test".into(),
            scopes: scopes.iter().map(|scope| (*scope).into()).collect(),
            status: ConnectorAccountStatus::Connected,
            workspace_name: None,
            workspace_url_key: None,
            selected_teams: (0..teams)
                .map(|index| crate::connectors::SelectedTeamDto {
                    id: format!("team-{index}"),
                    key: "ENG".into(),
                    name: "Engineering".into(),
                })
                .collect(),
        }
    }
    fn named(catalog: &[Value], name: &str) -> Value {
        catalog
            .iter()
            .find(|tool| tool["name"] == name)
            .cloned()
            .expect("tool present")
    }
    #[test]
    fn catalog_only_exposes_granted_connected_provider_tools() {
        let catalog = descriptors_from_accounts(&[
            account(
                ConnectorProvider::Google,
                &[GMAIL_READONLY, CALENDAR_READONLY],
                0,
            ),
            account(ConnectorProvider::Linear, &[LINEAR_READ], 0),
            account(ConnectorProvider::Github, &[GITHUB_READ], 0),
        ]);
        assert!(catalog.iter().any(|tool| tool["name"] == "search_threads"));
        assert!(catalog.iter().any(|tool| tool["name"] == "list_events"));
        assert!(catalog
            .iter()
            .any(|tool| tool["name"] == "list_repositories"));
        assert!(!catalog.iter().any(|tool| tool["name"] == "list_projects"));
        assert!(!catalog.iter().any(|tool| tool["name"] == "create_event"));
    }
    #[test]
    fn mutation_descriptors_require_sdk_approval_and_keep_provider_choices_bounded() {
        let catalog = descriptors_from_accounts(&[
            account(ConnectorProvider::Linear, &[LINEAR_WRITE], 1),
            account(ConnectorProvider::Github, &[GITHUB_WRITE], 0),
        ]);
        let create = named(&catalog, "create_issue");
        assert_eq!(create["requiresApproval"], true);
        assert_eq!(
            create["parameters"]["properties"]["provider"]["enum"],
            json!(["linear", "github"])
        );
        assert_eq!(
            create["parameters"]["properties"]["accountId"]["enum"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
    }
    #[test]
    fn stale_or_unselected_linear_accounts_are_not_advertised() {
        let mut stale = account(ConnectorProvider::Linear, &[LINEAR_READ, LINEAR_WRITE], 1);
        stale.status = ConnectorAccountStatus::ReconnectRequired;
        let unselected = account(ConnectorProvider::Linear, &[LINEAR_READ, LINEAR_WRITE], 0);
        let catalog = descriptors_from_accounts(&[stale, unselected]);
        assert!(!catalog.iter().any(|tool| tool["name"] == "search_issues"));
        assert!(!catalog.iter().any(|tool| tool["name"] == "create_issue"));
    }
}
