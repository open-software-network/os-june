//! Authoritative native policy for private connectors.
//!
//! This module owns the bundle/provider/scope registry, scope implications,
//! provider availability and defaults, routine connector toolsets, earned
//! autonomy threshold, and action-tool ownership. The renderer receives a
//! serializable projection through the additive `connectors_policy` command
//! and keeps only presentation copy keyed by these stable ids.

use super::ConnectorProvider;
use serde::Serialize;

/// Baseline identity scopes requested on every Google connect so the granted
/// account can be keyed by email (the id_token carries the email claim).
pub const OPENID: &str = "openid";
pub const EMAIL: &str = "email";

pub const GMAIL_READONLY: &str = "https://www.googleapis.com/auth/gmail.readonly";
pub const GMAIL_COMPOSE: &str = "https://www.googleapis.com/auth/gmail.compose";
pub const GMAIL_SEND: &str = "https://www.googleapis.com/auth/gmail.send";
/// Apply/remove labels and archive (users.messages.modify / threads.modify).
/// Google requires gmail.modify for these; readonly/compose/send cannot label.
pub const GMAIL_MODIFY: &str = "https://www.googleapis.com/auth/gmail.modify";
/// Read-only calendar for briefings and meeting prep. calendar.events grants
/// write ("view and edit events"), so read-only routines must not request it.
pub const CALENDAR_READONLY: &str = "https://www.googleapis.com/auth/calendar.readonly";
pub const CALENDAR_EVENTS: &str = "https://www.googleapis.com/auth/calendar.events";

/// Linear scopes are short names, not URLs. `read` is always granted (and
/// always requested: identity resolution and the teams listing need it);
/// `write` covers the v1 mutation set because Linear has no granular scope
/// for issue updates or project updates (see the spike doc).
pub const LINEAR_READ: &str = "read";
pub const LINEAR_WRITE: &str = "write";

/// GitHub June-side grant markers. These are NOT provider OAuth scopes.
pub const GITHUB_READ: &str = "read";
pub const GITHUB_WRITE: &str = "write";

pub const BASELINE_SCOPES: &[&str] = &[OPENID, EMAIL];

/// Runs completed under approval mode before autonomous trust is eligible.
pub const EARNED_AUTONOMY_MIN_APPROVAL_RUNS: i64 = 3;

/// Trust-mode wire ids accepted by the native command surface.
pub const TRUST_MODES: &[&str] = &["read_only", "approval", "autonomous"];

/// The native toolsets a sandboxed routine receives before connector servers
/// are added. The Hermes bridge uses this same slice when it renders cron
/// policy, and the renderer receives it in the catalog for explicit per-job
/// overrides.
pub const SANDBOXED_ROUTINE_BASE_TOOLSETS: &[&str] = &[
    "web",
    "vision",
    "todo",
    "memory",
    "session_search",
    "context_engine",
];

pub const JUNE_GMAIL_SERVER: &str = "june_gmail";
pub const JUNE_GMAIL_ACTIONS_SERVER: &str = "june_gmail_actions";
pub const JUNE_GCAL_SERVER: &str = "june_gcal";
pub const JUNE_GCAL_ACTIONS_SERVER: &str = "june_gcal_actions";
pub const JUNE_LINEAR_SERVER: &str = "june_linear";
pub const JUNE_LINEAR_ACTIONS_SERVER: &str = "june_linear_actions";
pub const JUNE_NOTION_SERVER: &str = "june_notion";
pub const JUNE_NOTION_ACTIONS_SERVER: &str = "june_notion_actions";
pub const JUNE_GITHUB_SERVER: &str = "june_github";
pub const JUNE_GITHUB_ACTIONS_SERVER: &str = "june_github_actions";

const GMAIL_AUTO_SERVER_PREFIX: &str = "june_gmail_auto_";
const GCAL_AUTO_SERVER_PREFIX: &str = "june_gcal_auto_";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct ScopeBundleDefinition {
    id: &'static str,
    provider: ConnectorProvider,
    scopes: &'static [&'static str],
    selected_by_default: bool,
}

const SCOPE_BUNDLE_DEFINITIONS: &[ScopeBundleDefinition] = &[
    ScopeBundleDefinition {
        id: "gmail_read",
        provider: ConnectorProvider::Google,
        scopes: &[GMAIL_READONLY],
        selected_by_default: true,
    },
    ScopeBundleDefinition {
        id: "gmail_draft",
        provider: ConnectorProvider::Google,
        scopes: &[GMAIL_COMPOSE],
        selected_by_default: false,
    },
    ScopeBundleDefinition {
        id: "gmail_modify",
        provider: ConnectorProvider::Google,
        scopes: &[GMAIL_MODIFY],
        selected_by_default: false,
    },
    ScopeBundleDefinition {
        id: "gmail_send",
        provider: ConnectorProvider::Google,
        scopes: &[GMAIL_SEND],
        selected_by_default: false,
    },
    ScopeBundleDefinition {
        id: "calendar_read",
        provider: ConnectorProvider::Google,
        scopes: &[CALENDAR_READONLY],
        selected_by_default: true,
    },
    ScopeBundleDefinition {
        id: "calendar_events",
        provider: ConnectorProvider::Google,
        scopes: &[CALENDAR_EVENTS],
        selected_by_default: false,
    },
    ScopeBundleDefinition {
        id: "linear_read",
        provider: ConnectorProvider::Linear,
        scopes: &[LINEAR_READ],
        selected_by_default: true,
    },
    ScopeBundleDefinition {
        id: "linear_write",
        provider: ConnectorProvider::Linear,
        scopes: &[LINEAR_WRITE],
        selected_by_default: false,
    },
    ScopeBundleDefinition {
        id: "github_read",
        provider: ConnectorProvider::Github,
        scopes: &[GITHUB_READ],
        selected_by_default: true,
    },
    ScopeBundleDefinition {
        id: "github_write",
        provider: ConnectorProvider::Github,
        scopes: &[GITHUB_WRITE],
        selected_by_default: false,
    },
];

/// Parsed feature bundle used by connect and scope-escalation commands.
/// It is a handle into the one static definition table rather than a second
/// enum-to-policy mapping.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ScopeBundle(&'static ScopeBundleDefinition);

impl ScopeBundle {
    pub fn all() -> impl Iterator<Item = Self> {
        SCOPE_BUNDLE_DEFINITIONS.iter().map(Self)
    }

    pub fn from_name(name: &str) -> Option<Self> {
        SCOPE_BUNDLE_DEFINITIONS
            .iter()
            .find(|definition| definition.id == name)
            .map(Self)
    }

    pub fn name(&self) -> &'static str {
        self.0.id
    }

    pub fn scopes(&self) -> &'static [&'static str] {
        self.0.scopes
    }

    pub fn provider(&self) -> ConnectorProvider {
        self.0.provider
    }
}

#[derive(Debug, Clone, Copy)]
struct ScopeImplicationDefinition {
    held: &'static str,
    grants: &'static [&'static str],
}

const SCOPE_IMPLICATIONS: &[ScopeImplicationDefinition] = &[
    ScopeImplicationDefinition {
        held: GMAIL_MODIFY,
        grants: &[GMAIL_READONLY, GMAIL_COMPOSE],
    },
    ScopeImplicationDefinition {
        held: CALENDAR_EVENTS,
        grants: &[CALENDAR_READONLY],
    },
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ConnectorConnectFlow {
    Oauth,
    HostedMcp,
}

#[derive(Debug, Clone, Copy)]
struct ProviderDefinition {
    provider: ConnectorProvider,
    connect_flow: ConnectorConnectFlow,
    enabled: bool,
}

/// Presentation order is policy: Google, Linear, GitHub, then the dedicated
/// hosted Notion flow. All remain enabled on the platforms June ships today.
const PROVIDER_DEFINITIONS: &[ProviderDefinition] = &[
    ProviderDefinition {
        provider: ConnectorProvider::Google,
        connect_flow: ConnectorConnectFlow::Oauth,
        enabled: true,
    },
    ProviderDefinition {
        provider: ConnectorProvider::Linear,
        connect_flow: ConnectorConnectFlow::Oauth,
        enabled: true,
    },
    ProviderDefinition {
        provider: ConnectorProvider::Github,
        connect_flow: ConnectorConnectFlow::Oauth,
        enabled: true,
    },
    ProviderDefinition {
        provider: ConnectorProvider::Notion,
        connect_flow: ConnectorConnectFlow::HostedMcp,
        enabled: true,
    },
];

#[derive(Debug, Clone, Copy)]
struct ConnectorTriggerDefinition {
    id: &'static str,
    provider: ConnectorProvider,
    required_bundles: &'static [&'static str],
}

const CONNECTOR_TRIGGER_DEFINITIONS: &[ConnectorTriggerDefinition] = &[
    ConnectorTriggerDefinition {
        id: "email_received",
        provider: ConnectorProvider::Google,
        required_bundles: &["gmail_read"],
    },
    ConnectorTriggerDefinition {
        id: "event_upcoming",
        provider: ConnectorProvider::Google,
        required_bundles: &["calendar_read"],
    },
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ConnectorServerKind {
    Read,
    Action,
}

#[derive(Debug, Clone, Copy)]
struct ConnectorServerDefinition {
    id: &'static str,
    provider: ConnectorProvider,
    kind: ConnectorServerKind,
    /// Prefix for native-generated variants that belong to this server
    /// family. Notion has no generated variants in the current policy.
    dynamic_prefix: Option<&'static str>,
    autonomous_prefix: Option<&'static str>,
}

const CONNECTOR_SERVER_DEFINITIONS: &[ConnectorServerDefinition] = &[
    ConnectorServerDefinition {
        id: JUNE_GMAIL_SERVER,
        provider: ConnectorProvider::Google,
        kind: ConnectorServerKind::Read,
        dynamic_prefix: Some("june_gmail_"),
        autonomous_prefix: None,
    },
    ConnectorServerDefinition {
        id: JUNE_GMAIL_ACTIONS_SERVER,
        provider: ConnectorProvider::Google,
        kind: ConnectorServerKind::Action,
        dynamic_prefix: None,
        autonomous_prefix: Some(GMAIL_AUTO_SERVER_PREFIX),
    },
    ConnectorServerDefinition {
        id: JUNE_GCAL_SERVER,
        provider: ConnectorProvider::Google,
        kind: ConnectorServerKind::Read,
        dynamic_prefix: Some("june_gcal_"),
        autonomous_prefix: None,
    },
    ConnectorServerDefinition {
        id: JUNE_GCAL_ACTIONS_SERVER,
        provider: ConnectorProvider::Google,
        kind: ConnectorServerKind::Action,
        dynamic_prefix: None,
        autonomous_prefix: Some(GCAL_AUTO_SERVER_PREFIX),
    },
    ConnectorServerDefinition {
        id: JUNE_LINEAR_SERVER,
        provider: ConnectorProvider::Linear,
        kind: ConnectorServerKind::Read,
        dynamic_prefix: Some("june_linear_"),
        autonomous_prefix: None,
    },
    ConnectorServerDefinition {
        id: JUNE_LINEAR_ACTIONS_SERVER,
        provider: ConnectorProvider::Linear,
        kind: ConnectorServerKind::Action,
        dynamic_prefix: None,
        autonomous_prefix: None,
    },
    ConnectorServerDefinition {
        id: JUNE_NOTION_SERVER,
        provider: ConnectorProvider::Notion,
        kind: ConnectorServerKind::Read,
        dynamic_prefix: None,
        autonomous_prefix: None,
    },
    ConnectorServerDefinition {
        id: JUNE_NOTION_ACTIONS_SERVER,
        provider: ConnectorProvider::Notion,
        kind: ConnectorServerKind::Action,
        dynamic_prefix: None,
        autonomous_prefix: None,
    },
    ConnectorServerDefinition {
        id: JUNE_GITHUB_SERVER,
        provider: ConnectorProvider::Github,
        kind: ConnectorServerKind::Read,
        dynamic_prefix: Some("june_github_"),
        autonomous_prefix: None,
    },
    ConnectorServerDefinition {
        id: JUNE_GITHUB_ACTIONS_SERVER,
        provider: ConnectorProvider::Github,
        kind: ConnectorServerKind::Action,
        dynamic_prefix: None,
        autonomous_prefix: None,
    },
];

/// Prefix ownership preserves the renderer's provider-mark behavior for base,
/// action, and potential provider-specific server names. Only the explicit
/// autonomous prefixes above imply autonomous trust.
fn server_owner_definitions() -> impl Iterator<Item = &'static ConnectorServerDefinition> {
    CONNECTOR_SERVER_DEFINITIONS
        .iter()
        .filter(|definition| definition.kind == ConnectorServerKind::Read)
}

#[derive(Debug, Clone, Copy)]
struct ActionToolDefinition {
    id: &'static str,
    server: &'static str,
    /// Internal provider key used in minted auto-server names. `None` means
    /// the tool is approval-only and can never resolve autonomous.
    autonomy_provider: Option<&'static str>,
}

const ACTION_TOOL_DEFINITIONS: &[ActionToolDefinition] = &[
    ActionToolDefinition {
        id: "create_draft",
        server: JUNE_GMAIL_ACTIONS_SERVER,
        autonomy_provider: Some("gmail"),
    },
    ActionToolDefinition {
        id: "send_email",
        server: JUNE_GMAIL_ACTIONS_SERVER,
        autonomy_provider: Some("gmail"),
    },
    ActionToolDefinition {
        id: "modify_labels",
        server: JUNE_GMAIL_ACTIONS_SERVER,
        autonomy_provider: Some("gmail"),
    },
    ActionToolDefinition {
        id: "archive",
        server: JUNE_GMAIL_ACTIONS_SERVER,
        autonomy_provider: Some("gmail"),
    },
    ActionToolDefinition {
        id: "create_event",
        server: JUNE_GCAL_ACTIONS_SERVER,
        autonomy_provider: Some("gcal"),
    },
    ActionToolDefinition {
        id: "respond_to_invite",
        server: JUNE_GCAL_ACTIONS_SERVER,
        autonomy_provider: Some("gcal"),
    },
    ActionToolDefinition {
        id: "create_issue",
        server: JUNE_LINEAR_ACTIONS_SERVER,
        autonomy_provider: None,
    },
    ActionToolDefinition {
        id: "update_issue",
        server: JUNE_LINEAR_ACTIONS_SERVER,
        autonomy_provider: None,
    },
    ActionToolDefinition {
        id: "add_comment",
        server: JUNE_LINEAR_ACTIONS_SERVER,
        autonomy_provider: None,
    },
    ActionToolDefinition {
        id: "create_project_update",
        server: JUNE_LINEAR_ACTIONS_SERVER,
        autonomy_provider: None,
    },
    ActionToolDefinition {
        id: "notion-create-pages",
        server: JUNE_NOTION_ACTIONS_SERVER,
        autonomy_provider: None,
    },
    ActionToolDefinition {
        id: "notion-update-page",
        server: JUNE_NOTION_ACTIONS_SERVER,
        autonomy_provider: None,
    },
    ActionToolDefinition {
        id: "create_issue",
        server: JUNE_GITHUB_ACTIONS_SERVER,
        autonomy_provider: None,
    },
    ActionToolDefinition {
        id: "update_issue",
        server: JUNE_GITHUB_ACTIONS_SERVER,
        autonomy_provider: None,
    },
    ActionToolDefinition {
        id: "add_comment",
        server: JUNE_GITHUB_ACTIONS_SERVER,
        autonomy_provider: None,
    },
];

fn server_definition(server: &str) -> Option<&'static ConnectorServerDefinition> {
    CONNECTOR_SERVER_DEFINITIONS
        .iter()
        .find(|definition| definition.id == server)
}

/// The autonomy provider owning this grantable tool id. Non-grantable and
/// unknown tools return `None`, so they can never mint an autonomous server.
/// Table validation guarantees every grantable id is globally unique.
pub fn autonomy_provider_for_tool(tool: &str) -> Option<&'static str> {
    ACTION_TOOL_DEFINITIONS
        .iter()
        .find(|definition| definition.id == tool && definition.autonomy_provider.is_some())
        .and_then(|definition| definition.autonomy_provider)
}

pub fn provider_for_server_name(server: &str) -> Option<ConnectorProvider> {
    server_owner_definitions()
        .find(|definition| server.starts_with(definition.id))
        .map(|definition| definition.provider)
}

pub fn is_connector_server_name(server: &str) -> bool {
    CONNECTOR_SERVER_DEFINITIONS
        .iter()
        .any(|definition| definition.id == server)
        || CONNECTOR_SERVER_DEFINITIONS
            .iter()
            .filter_map(|definition| definition.dynamic_prefix)
            .any(|prefix| server.starts_with(prefix))
}

pub fn autonomy_earned(approval_run_count: i64) -> bool {
    approval_run_count >= EARNED_AUTONOMY_MIN_APPROVAL_RUNS
}

pub fn is_trigger_kind(kind: &str) -> bool {
    CONNECTOR_TRIGGER_DEFINITIONS
        .iter()
        .any(|definition| definition.id == kind)
}

/// Full scope set to request on the Google auth URL for a set of bundles.
pub fn requested_scopes(bundles: &[ScopeBundle]) -> Vec<&'static str> {
    let mut scopes: Vec<&'static str> = Vec::new();
    for scope in BASELINE_SCOPES {
        if !scopes.contains(scope) {
            scopes.push(scope);
        }
    }
    for bundle in bundles {
        for scope in bundle.scopes() {
            if !scopes.contains(scope) {
                scopes.push(scope);
            }
        }
    }
    scopes
}

/// Full scope set to request on the Linear auth URL for a set of bundles.
pub fn requested_linear_scopes(bundles: &[ScopeBundle]) -> Vec<&'static str> {
    let mut scopes: Vec<&'static str> = vec![LINEAR_READ];
    for bundle in bundles {
        for scope in bundle.scopes() {
            if !scopes.contains(scope) {
                scopes.push(scope);
            }
        }
    }
    scopes
}

/// Full set of June-side grant markers to store for a GitHub connect.
pub fn requested_github_scopes(bundles: &[ScopeBundle]) -> Vec<&'static str> {
    let mut scopes: Vec<&'static str> = vec![GITHUB_READ];
    for bundle in bundles {
        for scope in bundle.scopes() {
            if !scopes.contains(scope) {
                scopes.push(scope);
            }
        }
    }
    scopes
}

/// True when a granted scope satisfies a needed scope, directly or because a
/// broader scope implies it.
pub fn scope_grants(held: &str, needed: &str) -> bool {
    held == needed
        || SCOPE_IMPLICATIONS
            .iter()
            .any(|implication| implication.held == held && implication.grants.contains(&needed))
}

/// Incremental-auth helper: feature scopes wanted but not already granted.
pub fn missing_scopes(granted: &[String], wanted: &[ScopeBundle]) -> Vec<&'static str> {
    let mut missing: Vec<&'static str> = Vec::new();
    for bundle in wanted {
        for &scope in bundle.scopes() {
            let already_granted = granted.iter().any(|held| scope_grants(held, scope));
            if !already_granted && !missing.contains(&scope) {
                missing.push(scope);
            }
        }
    }
    missing
}

/// Scope set to persist for a completed grant, preserving prior scopes when a
/// provider omits the response scope field during incremental authorization.
pub fn resolve_granted_scopes(
    grant_scope: Option<&str>,
    requested: &[&str],
    existing: Option<&[String]>,
) -> Vec<String> {
    if let Some(scopes) = grant_scope
        .map(|scope| {
            scope
                .split_whitespace()
                .map(str::to_string)
                .collect::<Vec<String>>()
        })
        .filter(|scopes| !scopes.is_empty())
    {
        return scopes;
    }
    let mut union: Vec<String> = requested.iter().map(|scope| scope.to_string()).collect();
    if let Some(existing) = existing {
        for scope in existing {
            if !union.contains(scope) {
                union.push(scope.clone());
            }
        }
    }
    union
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorProviderPolicyDto {
    pub id: ConnectorProvider,
    pub connect_flow: ConnectorConnectFlow,
    pub enabled: bool,
    pub default_bundles: Vec<&'static str>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScopeBundlePolicyDto {
    pub id: &'static str,
    pub provider: ConnectorProvider,
    pub scope_ids: &'static [&'static str],
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScopeImplicationDto {
    pub held: &'static str,
    pub grants: &'static [&'static str],
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorServerPolicyDto {
    pub id: &'static str,
    pub provider: ConnectorProvider,
    pub kind: &'static str,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerOwnerPrefixDto {
    pub prefix: &'static str,
    pub provider: ConnectorProvider,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorActionToolPolicyDto {
    pub id: &'static str,
    pub server: &'static str,
    pub provider: ConnectorProvider,
    pub grantable: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorTriggerPolicyDto {
    pub id: &'static str,
    pub provider: ConnectorProvider,
    pub required_bundles: &'static [&'static str],
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutineConnectorPolicyDto {
    pub sandboxed_base_toolsets: &'static [&'static str],
    pub read_toolsets: Vec<&'static str>,
    pub action_toolsets: Vec<&'static str>,
    pub autonomous_server_prefixes: Vec<&'static str>,
}

/// Stable, presentation-free projection consumed by React.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorPolicyCatalog {
    pub version: u32,
    pub providers: Vec<ConnectorProviderPolicyDto>,
    pub scope_bundles: Vec<ScopeBundlePolicyDto>,
    pub scope_implications: Vec<ScopeImplicationDto>,
    pub servers: Vec<ConnectorServerPolicyDto>,
    pub server_owner_prefixes: Vec<ServerOwnerPrefixDto>,
    pub action_tools: Vec<ConnectorActionToolPolicyDto>,
    pub triggers: Vec<ConnectorTriggerPolicyDto>,
    pub routine: RoutineConnectorPolicyDto,
    pub earned_autonomy_min_approval_runs: i64,
}

pub fn catalog() -> ConnectorPolicyCatalog {
    ConnectorPolicyCatalog {
        version: 1,
        providers: PROVIDER_DEFINITIONS
            .iter()
            .map(|definition| ConnectorProviderPolicyDto {
                id: definition.provider,
                connect_flow: definition.connect_flow,
                enabled: definition.enabled,
                default_bundles: SCOPE_BUNDLE_DEFINITIONS
                    .iter()
                    .filter(|bundle| {
                        bundle.provider == definition.provider && bundle.selected_by_default
                    })
                    .map(|bundle| bundle.id)
                    .collect(),
            })
            .collect(),
        scope_bundles: SCOPE_BUNDLE_DEFINITIONS
            .iter()
            .map(|definition| ScopeBundlePolicyDto {
                id: definition.id,
                provider: definition.provider,
                scope_ids: definition.scopes,
            })
            .collect(),
        scope_implications: SCOPE_IMPLICATIONS
            .iter()
            .map(|definition| ScopeImplicationDto {
                held: definition.held,
                grants: definition.grants,
            })
            .collect(),
        servers: CONNECTOR_SERVER_DEFINITIONS
            .iter()
            .map(|definition| ConnectorServerPolicyDto {
                id: definition.id,
                provider: definition.provider,
                kind: match definition.kind {
                    ConnectorServerKind::Read => "read",
                    ConnectorServerKind::Action => "action",
                },
            })
            .collect(),
        server_owner_prefixes: server_owner_definitions()
            .map(|definition| ServerOwnerPrefixDto {
                prefix: definition.id,
                provider: definition.provider,
            })
            .collect(),
        action_tools: ACTION_TOOL_DEFINITIONS
            .iter()
            .map(|definition| {
                let server = server_definition(definition.server)
                    .expect("connector action tool server must be registered");
                ConnectorActionToolPolicyDto {
                    id: definition.id,
                    server: definition.server,
                    provider: server.provider,
                    grantable: definition.autonomy_provider.is_some(),
                }
            })
            .collect(),
        triggers: CONNECTOR_TRIGGER_DEFINITIONS
            .iter()
            .map(|definition| ConnectorTriggerPolicyDto {
                id: definition.id,
                provider: definition.provider,
                required_bundles: definition.required_bundles,
            })
            .collect(),
        routine: RoutineConnectorPolicyDto {
            sandboxed_base_toolsets: SANDBOXED_ROUTINE_BASE_TOOLSETS,
            read_toolsets: CONNECTOR_SERVER_DEFINITIONS
                .iter()
                .filter(|server| server.kind == ConnectorServerKind::Read)
                .map(|server| server.id)
                .collect(),
            action_toolsets: CONNECTOR_SERVER_DEFINITIONS
                .iter()
                .filter(|server| server.kind == ConnectorServerKind::Action)
                .map(|server| server.id)
                .collect(),
            autonomous_server_prefixes: CONNECTOR_SERVER_DEFINITIONS
                .iter()
                .filter_map(|server| server.autonomous_prefix)
                .collect(),
        },
        earned_autonomy_min_approval_runs: EARNED_AUTONOMY_MIN_APPROVAL_RUNS,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    fn owned(scopes: &[&str]) -> Vec<String> {
        scopes.iter().map(|scope| scope.to_string()).collect()
    }

    fn bundle(name: &str) -> ScopeBundle {
        ScopeBundle::from_name(name).expect("known bundle")
    }

    #[test]
    fn catalog_tables_are_total_unique_and_internally_consistent() {
        let mut providers = HashSet::new();
        for definition in PROVIDER_DEFINITIONS {
            assert!(
                providers.insert(definition.provider.as_str()),
                "duplicate provider id"
            );
        }

        let mut bundle_ids = HashSet::new();
        for definition in SCOPE_BUNDLE_DEFINITIONS {
            assert!(bundle_ids.insert(definition.id), "duplicate bundle id");
            assert!(!definition.scopes.is_empty());
            assert!(PROVIDER_DEFINITIONS.iter().any(|provider| {
                provider.provider == definition.provider
                    && provider.connect_flow == ConnectorConnectFlow::Oauth
            }));
        }

        let mut servers = HashSet::new();
        let mut dynamic_prefixes = HashSet::new();
        for definition in CONNECTOR_SERVER_DEFINITIONS {
            assert!(servers.insert(definition.id), "duplicate server id");
            if let Some(prefix) = definition.dynamic_prefix {
                assert_eq!(definition.kind, ConnectorServerKind::Read);
                assert!(prefix.starts_with(definition.id));
                assert!(dynamic_prefixes.insert(prefix), "duplicate dynamic prefix");
            }
        }

        let mut action_identities = HashSet::new();
        let mut grantable_ids = HashSet::new();
        for definition in ACTION_TOOL_DEFINITIONS {
            assert!(
                action_identities.insert((definition.server, definition.id)),
                "duplicate action identity"
            );
            let server = server_definition(definition.server).expect("registered action server");
            assert_eq!(server.kind, ConnectorServerKind::Action);
            if definition.autonomy_provider.is_some() {
                assert!(
                    grantable_ids.insert(definition.id),
                    "grantable ids must be globally unique"
                );
                assert_eq!(server.provider, ConnectorProvider::Google);
            }
        }

        let known_scopes: HashSet<&str> = SCOPE_BUNDLE_DEFINITIONS
            .iter()
            .flat_map(|definition| definition.scopes.iter().copied())
            .collect();
        for implication in SCOPE_IMPLICATIONS {
            assert!(known_scopes.contains(implication.held));
            assert!(implication
                .grants
                .iter()
                .all(|scope| known_scopes.contains(scope)));
        }

        for trigger in CONNECTOR_TRIGGER_DEFINITIONS {
            assert!(!trigger.required_bundles.is_empty());
            assert!(trigger.required_bundles.iter().all(|bundle_id| {
                SCOPE_BUNDLE_DEFINITIONS
                    .iter()
                    .any(|bundle| bundle.id == *bundle_id && bundle.provider == trigger.provider)
            }));
        }
    }

    #[test]
    fn projection_contains_every_native_policy_entry() {
        let catalog = catalog();
        assert_eq!(catalog.providers.len(), PROVIDER_DEFINITIONS.len());
        assert_eq!(catalog.scope_bundles.len(), SCOPE_BUNDLE_DEFINITIONS.len());
        assert_eq!(catalog.scope_implications.len(), SCOPE_IMPLICATIONS.len());
        assert_eq!(catalog.servers.len(), CONNECTOR_SERVER_DEFINITIONS.len());
        assert_eq!(
            catalog.server_owner_prefixes.len(),
            server_owner_definitions().count()
        );
        assert_eq!(catalog.action_tools.len(), ACTION_TOOL_DEFINITIONS.len());
        assert_eq!(catalog.triggers.len(), CONNECTOR_TRIGGER_DEFINITIONS.len());
        assert_eq!(
            catalog.earned_autonomy_min_approval_runs,
            EARNED_AUTONOMY_MIN_APPROVAL_RUNS
        );
        assert_eq!(
            catalog.routine.read_toolsets,
            vec![
                JUNE_GMAIL_SERVER,
                JUNE_GCAL_SERVER,
                JUNE_LINEAR_SERVER,
                JUNE_NOTION_SERVER,
                JUNE_GITHUB_SERVER
            ]
        );
        assert_eq!(
            catalog.routine.action_toolsets,
            vec![
                JUNE_GMAIL_ACTIONS_SERVER,
                JUNE_GCAL_ACTIONS_SERVER,
                JUNE_LINEAR_ACTIONS_SERVER,
                JUNE_NOTION_ACTIONS_SERVER,
                JUNE_GITHUB_ACTIONS_SERVER
            ]
        );
    }

    #[test]
    fn provider_defaults_preserve_current_connect_policy() {
        let catalog = catalog();
        let defaults = |provider| {
            catalog
                .providers
                .iter()
                .find(|entry| entry.id == provider)
                .expect("provider")
                .default_bundles
                .clone()
        };
        assert_eq!(
            defaults(ConnectorProvider::Google),
            vec!["gmail_read", "calendar_read"]
        );
        assert_eq!(defaults(ConnectorProvider::Linear), vec!["linear_read"]);
        assert_eq!(defaults(ConnectorProvider::Github), vec!["github_read"]);
        assert!(defaults(ConnectorProvider::Notion).is_empty());
    }

    #[test]
    fn non_grantable_tools_never_resolve_autonomous() {
        for definition in ACTION_TOOL_DEFINITIONS
            .iter()
            .filter(|definition| definition.autonomy_provider.is_none())
        {
            assert_eq!(autonomy_provider_for_tool(definition.id), None);
        }
        assert_eq!(autonomy_provider_for_tool("create_draft"), Some("gmail"));
        assert_eq!(autonomy_provider_for_tool("create_event"), Some("gcal"));
        assert_eq!(autonomy_provider_for_tool("read_thread"), None);
    }

    #[test]
    fn server_identity_and_generated_name_rules_preserve_current_policy() {
        assert_eq!(
            provider_for_server_name(JUNE_GCAL_ACTIONS_SERVER),
            Some(ConnectorProvider::Google)
        );
        assert_eq!(
            provider_for_server_name("june_linear_future"),
            Some(ConnectorProvider::Linear)
        );
        assert!(is_connector_server_name(JUNE_NOTION_ACTIONS_SERVER));
        assert!(is_connector_server_name("june_gmail_auto_job"));
        assert!(is_connector_server_name("june_github_future"));
        assert!(!is_connector_server_name("june_notion_future"));
        assert!(!is_connector_server_name("web"));
    }

    #[test]
    fn bundle_names_round_trip_through_the_table() {
        for bundle in ScopeBundle::all() {
            assert_eq!(ScopeBundle::from_name(bundle.name()), Some(bundle));
        }
        assert_eq!(ScopeBundle::from_name("gmail"), None);
    }

    #[test]
    fn requested_scopes_include_baseline_and_dedupe() {
        let scopes = requested_scopes(&[bundle("gmail_read"), bundle("gmail_read")]);
        assert_eq!(scopes, vec![OPENID, EMAIL, GMAIL_READONLY]);
    }

    #[test]
    fn missing_scopes_and_implications_preserve_current_grant_rules() {
        let granted = owned(&[GMAIL_MODIFY, CALENDAR_EVENTS]);
        assert!(missing_scopes(
            &granted,
            &[
                bundle("gmail_read"),
                bundle("gmail_draft"),
                bundle("calendar_read")
            ]
        )
        .is_empty());
        assert_eq!(
            missing_scopes(&owned(&[GMAIL_READONLY]), &[bundle("gmail_modify")]),
            vec![GMAIL_MODIFY]
        );
    }

    #[test]
    fn resolve_granted_scopes_unions_existing_when_response_omits_scope() {
        let requested = vec![OPENID, EMAIL, GMAIL_READONLY];
        let existing = owned(&[OPENID, EMAIL, CALENDAR_EVENTS]);
        assert_eq!(
            resolve_granted_scopes(None, &requested, Some(&existing)),
            vec![OPENID, EMAIL, GMAIL_READONLY, CALENDAR_EVENTS]
        );
    }

    #[test]
    fn provider_specific_requests_preserve_baselines() {
        assert_eq!(
            requested_linear_scopes(&[bundle("linear_write")]),
            vec![LINEAR_READ, LINEAR_WRITE]
        );
        assert_eq!(
            requested_github_scopes(&[bundle("github_write")]),
            vec![GITHUB_READ, GITHUB_WRITE]
        );
        assert_eq!(
            requested_scopes(&[bundle("calendar_read")]),
            vec![OPENID, EMAIL, CALENDAR_READONLY]
        );
    }

    #[test]
    fn catalog_serializes_as_the_additive_camel_case_contract() {
        let value = serde_json::to_value(catalog()).expect("serialize catalog");
        assert_eq!(value["version"], 1);
        assert_eq!(value["earnedAutonomyMinApprovalRuns"], 3);
        assert_eq!(value["providers"][0]["id"], "google");
        assert_eq!(value["providers"][0]["connectFlow"], "oauth");
        assert_eq!(value["scopeBundles"][0]["id"], "gmail_read");
        assert_eq!(value["actionTools"][0]["server"], JUNE_GMAIL_ACTIONS_SERVER);
        assert_eq!(value["triggers"][0]["requiredBundles"][0], "gmail_read");
    }

    #[test]
    fn committed_renderer_snapshot_matches_native_catalog() {
        let snapshot = include_str!("../../../src/test/fixtures/connector-policy.json");
        let snapshot: serde_json::Value =
            serde_json::from_str(snapshot).expect("parse committed connector policy snapshot");
        let native = serde_json::to_value(catalog()).expect("serialize native connector policy");

        assert_eq!(
            snapshot, native,
            "refresh the shared connector policy snapshot after changing the native catalog"
        );
    }
}
