/**
 * Pure, render-free view logic for the private connectors (Google, Linear)
 * in local mode: scope-bundle metadata, account status labels, trust-mode
 * metadata and earned-autonomy gating, the trust-mode to Hermes toolset
 * composition, and event-trigger metadata.
 *
 * Kept separate from the React components and the Tauri bindings (mirroring
 * the hermes-admin/*-view.ts split) so all of it is unit-testable without a
 * Tauri runtime. Copy is sentence case, no em/en dashes, per June rules.
 */

import { IconBolt } from "central-icons/IconBolt";
import { IconChecklist } from "central-icons/IconChecklist";
import { IconEyeOpen } from "central-icons/IconEyeOpen";
import { errorCode } from "./errors";
import { UNRESTRICTED_ROUTINE_TOOLSETS } from "./hermes-routines";
import type {
  ConnectorAccountStatus,
  ConnectorProvider,
  ConnectorScopeBundle,
  ConnectorTriggerKind,
  RoutineTrustMode,
} from "./tauri";

// ---------------------------------------------------------------------------
// Scope bundles
// ---------------------------------------------------------------------------

export type ConnectorBundleMeta = {
  /** Checkbox label in the connect dialog. Sentence case. */
  label: string;
  /** One-line supporting copy under the label. */
  description: string;
  /** The provider scope identifiers the bundle grants: Google's full auth
   * URLs, Linear's short scope names. Mirrors ScopeBundle::scopes() in
   * src-tauri/src/connectors/scopes.rs; keep in sync. */
  scopeUrls: string[];
  /** Short feature phrase for "This routine can: ..." summaries. */
  feature: string;
};

export const BUNDLE_META: Readonly<Record<ConnectorScopeBundle, ConnectorBundleMeta>> =
  Object.freeze({
    gmail_read: {
      label: "Read mail",
      description: "Search and read your email for briefings and triage.",
      scopeUrls: ["https://www.googleapis.com/auth/gmail.readonly"],
      feature: "read your mail",
    },
    gmail_draft: {
      label: "Draft replies",
      description: "Write draft replies for you to review. Never sends.",
      scopeUrls: ["https://www.googleapis.com/auth/gmail.compose"],
      feature: "draft replies",
    },
    gmail_modify: {
      label: "Organize mail",
      description: "Label and archive your mail. Never deletes.",
      scopeUrls: ["https://www.googleapis.com/auth/gmail.modify"],
      feature: "label and archive mail",
    },
    gmail_send: {
      label: "Send mail",
      description: "Send email on your behalf. Only used when you allow it per routine.",
      scopeUrls: ["https://www.googleapis.com/auth/gmail.send"],
      feature: "send mail",
    },
    calendar_read: {
      label: "Read calendar",
      description: "Read your events and find free slots for briefings and prep.",
      scopeUrls: ["https://www.googleapis.com/auth/calendar.readonly"],
      feature: "read your calendar",
    },
    calendar_events: {
      label: "Manage calendar",
      description: "Create events and respond to invites on your behalf.",
      scopeUrls: ["https://www.googleapis.com/auth/calendar.events"],
      feature: "manage your calendar",
    },
    linear_read: {
      label: "Read workspace",
      description: "Read teams, projects, cycles, and issues for planning and status briefs.",
      scopeUrls: ["read"],
      feature: "read your Linear workspace",
    },
    linear_write: {
      label: "Create and update issues",
      description:
        "Draft issues, comments, and project updates. Nothing is written without your approval.",
      scopeUrls: ["write"],
      feature: "create and update issues",
    },
  });

/** The six Google feature bundles, in the order the connect dialog lists
 * them. */
export const GOOGLE_SCOPE_BUNDLES: readonly ConnectorScopeBundle[] = Object.freeze([
  "gmail_read",
  "gmail_draft",
  "gmail_modify",
  "gmail_send",
  "calendar_read",
  "calendar_events",
]);

/** The two Linear feature bundles, in the order the connect dialog lists
 * them. */
export const LINEAR_SCOPE_BUNDLES: readonly ConnectorScopeBundle[] = Object.freeze([
  "linear_read",
  "linear_write",
]);

/** The feature bundles a provider's connect dialog offers, in display
 * order. */
export function bundlesForProvider(provider: ConnectorProvider): readonly ConnectorScopeBundle[] {
  return provider === "linear" ? LINEAR_SCOPE_BUNDLES : GOOGLE_SCOPE_BUNDLES;
}

/** A granted Google scope implies these narrower scope needs: a write scope
 * already grants the matching read, so an account with `calendar.events` need
 * not be re-prompted for `calendar.readonly`, and `gmail.modify` covers read
 * and draft. Used for the "can this routine run" gate, not for display. */
const SCOPE_IMPLICATIONS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  "https://www.googleapis.com/auth/gmail.modify": [
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/gmail.compose",
  ],
  "https://www.googleapis.com/auth/calendar.events": [
    "https://www.googleapis.com/auth/calendar.readonly",
  ],
});

/** True when the granted scope set satisfies `needed`, directly or because a
 * broader granted scope implies it. */
function grantsScope(granted: Set<string>, needed: string): boolean {
  if (granted.has(needed)) return true;
  for (const held of granted) {
    if (SCOPE_IMPLICATIONS[held]?.includes(needed)) return true;
  }
  return false;
}

/** Maps an account's granted scope identifiers back to the feature bundles it
 * explicitly holds, in registry order, scoped to that account's provider so a
 * hypothetical scope-string collision across providers can never cross-match.
 * Exact match (not superset): this drives display and reconnect, which should
 * reflect what was actually granted, not what a broader scope could stand in
 * for. Unknown identifiers (identity scopes, future grants) are ignored: the
 * UI shows features, not raw scopes. */
export function bundlesFromScopes(
  scopeUrls: string[],
  provider: ConnectorProvider,
): ConnectorScopeBundle[] {
  const granted = new Set(scopeUrls);
  return bundlesForProvider(provider).filter((bundle) =>
    BUNDLE_META[bundle].scopeUrls.every((url) => granted.has(url)),
  );
}

/** "Read mail, draft replies and calendar" — the human feature list an
 * account's grants render as. */
export function grantedFeatureLabels(scopeUrls: string[], provider: ConnectorProvider): string[] {
  return bundlesFromScopes(scopeUrls, provider).map((bundle) => BUNDLE_META[bundle].label);
}

/** True when the account's granted scopes already cover every bundle a routine
 * needs, counting a broader granted scope as covering a narrower need (so a
 * read-only briefing runs on an account that granted calendar write). */
export function scopesCoverBundles(
  scopeUrls: string[],
  bundles: readonly ConnectorScopeBundle[],
): boolean {
  const granted = new Set(scopeUrls);
  return bundles.every((bundle) =>
    BUNDLE_META[bundle].scopeUrls.every((url) => grantsScope(granted, url)),
  );
}

// ---------------------------------------------------------------------------
// Account status
// ---------------------------------------------------------------------------

export type ConnectorStatusMeta = {
  label: string;
  tone: "ok" | "attention";
  blurb: string;
};

const STATUS_LABELS: Readonly<
  Record<ConnectorAccountStatus, { label: string; tone: "ok" | "attention" }>
> = Object.freeze({
  connected: { label: "Connected", tone: "ok" },
  reconnect_required: { label: "Reconnect needed", tone: "attention" },
  unavailable: { label: "Status unavailable", tone: "attention" },
});

/** Connected blurb is shared across providers; reconnect names the provider
 * and what it gates ("this account" for Google, "this workspace" for
 * Linear) so the prompt reads correctly for either. */
const CONNECTED_BLURB = "This account is ready. Tokens stay in your Mac's Keychain.";

const RECONNECT_BLURB: Readonly<Record<ConnectorProvider, string>> = Object.freeze({
  google: "Google needs you to sign in again before June can use this account.",
  linear: "Linear needs you to sign in again before June can use this workspace.",
  notion: "Notion needs you to connect again before June can use its hosted MCP tools.",
});
const UNAVAILABLE_BLURB = "June could not confirm the Notion connection. Try again in a moment.";

function accountStatusBlurb(status: ConnectorAccountStatus, provider: ConnectorProvider): string {
  if (status === "reconnect_required") return RECONNECT_BLURB[provider];
  if (status === "unavailable") return UNAVAILABLE_BLURB;
  return CONNECTED_BLURB;
}

export function accountStatusMeta(
  status: ConnectorAccountStatus,
  provider: ConnectorProvider,
): ConnectorStatusMeta {
  const { label, tone } = STATUS_LABELS[status];
  return { label, tone, blurb: accountStatusBlurb(status, provider) };
}

/** True for the Rust "connector_not_configured" error: this build ships no
 * Google OAuth client id, so the connect flow cannot start. An expected
 * condition (dev builds), not a failure toast. */
export function isConnectorNotConfiguredError(err: unknown): boolean {
  return errorCode(err) === "connector_not_configured";
}

// ---------------------------------------------------------------------------
// Trust modes
// ---------------------------------------------------------------------------

export type TrustModeMeta = {
  label: string;
  description: string;
  icon: typeof IconBolt;
};

/** Whether a trust save changed the rendered connector runtime enough to need a
 * restart. Two cases: a provider was added or removed (auto server names
 * differ), or an autonomous routine's granted tools changed within a provider.
 * In the second case the server name is unchanged but `routine_trust_set`
 * re-mints the grant token and rewrites `tools.include`, so the live MCP process
 * would keep a stale token/filter (added tools missing, previously granted tools
 * falling back to approval) until some later restart. */
export function autonomyRuntimeNeedsRestart(input: {
  previousServers: readonly string[];
  nextServers: readonly string[];
  trustMode: RoutineTrustMode;
  previousTools: readonly string[];
  nextTools: readonly string[];
}): boolean {
  const differ = (a: readonly string[], b: readonly string[]) =>
    JSON.stringify([...a].sort()) !== JSON.stringify([...b].sort());
  return (
    differ(input.previousServers, input.nextServers) ||
    (input.trustMode === "autonomous" && differ(input.previousTools, input.nextTools))
  );
}

export const TRUST_MODE_META: Readonly<Record<RoutineTrustMode, TrustModeMeta>> = Object.freeze({
  read_only: {
    label: "Read only",
    description: "The routine can read mail and calendar but never change anything.",
    icon: IconEyeOpen,
  },
  approval: {
    label: "Approval",
    description: "Drafts, sends, and event changes wait for your approval before they run.",
    icon: IconChecklist,
  },
  autonomous: {
    label: "Autonomous",
    description: "Tools you grant run without asking. Unlocked after a few runs under approval.",
    icon: IconBolt,
  },
});

/**
 * Runs completed under approval mode before autonomous unlocks (earned
 * autonomy). The gate counts successful runs while the routine is in approval
 * mode, not individually approved actions: the connector proxy is session
 * blind (it gates on the grant token alone, with no run or job identity), so it
 * cannot attribute a specific approval to a specific run. The copy below says
 * "under approval" rather than "approved" to match what is actually counted.
 */
export const AUTONOMY_RUN_THRESHOLD = 3;

export function canSelectAutonomous(runCount: number): boolean {
  return runCount >= AUTONOMY_RUN_THRESHOLD;
}

/** Helper text under the trust picker while autonomy is still locked:
 * "Runs 2 more times under approval to unlock autonomous". */
export function autonomyUnlockHint(runCount: number): string {
  const remaining = Math.max(0, AUTONOMY_RUN_THRESHOLD - runCount);
  if (remaining === 0) return "Autonomous is unlocked for this routine.";
  const times = remaining === 1 ? "1 more time" : `${remaining} more times`;
  return `Runs ${times} under approval to unlock autonomous.`;
}

/** Progress label for the detail page: "Run 2 of 3 under approval before
 * autonomy unlocks". Clamped once the threshold is met. */
export function autonomyProgressLabel(runCount: number): string {
  if (canSelectAutonomous(runCount)) return "Autonomy unlocked.";
  const next = Math.min(runCount + 1, AUTONOMY_RUN_THRESHOLD);
  return `Run ${next} of ${AUTONOMY_RUN_THRESHOLD} under approval before autonomy unlocks.`;
}

// ---------------------------------------------------------------------------
// Trust-mode toolset composition
// ---------------------------------------------------------------------------

/** The sandboxed cron default toolsets. Duplicated from
 * CRON_SANDBOXED_TOOLSETS in hermes_bridge.rs (the Rust side renders this
 * list into config.yaml); keep in sync. */
export const SANDBOXED_ROUTINE_BASE_TOOLSETS = [
  "web",
  "vision",
  "todo",
  "memory",
  "session_search",
  "context_engine",
];

/** Read-only connector MCP servers: ambient for every routine. Linear reads
 * are team-enforced in Rust (the proxy checks the caller's selected-team
 * grant on every team-scoped route), so `june_linear` is safe to grant
 * ambiently just like the Google read servers rather than gating it behind
 * trust mode. */
export const CONNECTOR_READ_TOOLSETS = ["june_gmail", "june_gcal", "june_linear", "june_notion"];

/** Action connector MCP servers: every mutating call parks for approval in
 * the Rust proxy. Linear has no autonomous mode in v1 (see `grantable` on
 * `ConnectorActionTool`), but its actions server still parks for approval
 * like the Google ones, so it belongs in this list too. */
export const CONNECTOR_ACTION_TOOLSETS = [
  "june_gmail_actions",
  "june_gcal_actions",
  "june_linear_actions",
  "june_notion_actions",
];

/** One connector action tool, for the approvals-surface label lookup
 * (`actionToolLabel`) and the autonomous grant checklist. `id` is the raw
 * tool name the Rust proxy consults grants by. `grantable` is false for
 * every Linear tool: Linear has no autonomous mode in v1, so its tools get
 * approvals-surface labels but must never appear in the earned-autonomy
 * grant checklist (only the checklist consumer filters on this field). */
export type ConnectorActionTool = {
  id: string;
  server: string;
  label: string;
  grantable: boolean;
};

export const CONNECTOR_ACTION_TOOLS: readonly ConnectorActionTool[] = Object.freeze([
  { id: "create_draft", server: "june_gmail_actions", label: "Create drafts", grantable: true },
  { id: "send_email", server: "june_gmail_actions", label: "Send email", grantable: true },
  { id: "modify_labels", server: "june_gmail_actions", label: "Change labels", grantable: true },
  { id: "archive", server: "june_gmail_actions", label: "Archive mail", grantable: true },
  { id: "create_event", server: "june_gcal_actions", label: "Create events", grantable: true },
  {
    id: "respond_to_invite",
    server: "june_gcal_actions",
    label: "Respond to invites",
    grantable: true,
  },
  {
    id: "create_issue",
    server: "june_linear_actions",
    label: "Create issues",
    grantable: false,
  },
  {
    id: "update_issue",
    server: "june_linear_actions",
    label: "Update issues",
    grantable: false,
  },
  {
    id: "add_comment",
    server: "june_linear_actions",
    label: "Comment on issues",
    grantable: false,
  },
  {
    id: "create_project_update",
    server: "june_linear_actions",
    label: "Post project updates",
    grantable: false,
  },
  {
    id: "notion-create-pages",
    server: "june_notion_actions",
    label: "Create Notion pages",
    grantable: false,
  },
  {
    id: "notion-update-page",
    server: "june_notion_actions",
    label: "Update Notion pages",
    grantable: false,
  },
]);

/** The connector action tools eligible for the earned-autonomy grant
 * checklist. Linear tools are excluded: Linear has no autonomous mode in
 * v1, so they must never be offered as grantable even though they have
 * approvals-surface labels above. */
export const GRANTABLE_CONNECTOR_ACTION_TOOLS: readonly ConnectorActionTool[] = Object.freeze(
  CONNECTOR_ACTION_TOOLS.filter((tool) => tool.grantable),
);

const ACTION_TOOL_LABELS: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(CONNECTOR_ACTION_TOOLS.map((tool) => [tool.id, tool.label])),
);

/** A scheduled run that counts toward earned autonomy: one the routine
 * finished without failing. Active runs and error/cancelled runs do not count
 * ("run correctly under approval"). Field names cover both the snake_case and
 * camelCase shapes the session record can arrive in. */
export function isCreditableRun(run: {
  active?: boolean;
  is_active?: boolean;
  status?: string;
  ended_at?: string | null;
  endedAt?: string | null;
}): boolean {
  if (run.active || run.is_active) return false;
  const ended = run.ended_at ?? run.endedAt;
  if (!ended) return false;
  const status = (run.status ?? "").toLowerCase();
  return status !== "failed" && status !== "error" && status !== "cancelled";
}

/** A human label for a connector action tool id, for the approvals surface.
 * Falls back to a spaced form of the raw name for any unmapped tool. */
export function actionToolLabel(tool: string): string {
  return ACTION_TOOL_LABELS[tool] ?? tool.replace(/_/g, " ");
}

/** The provider behind a connector MCP server name, for provider marks on the
 * approvals surface. Null for non-connector servers. */
export function providerFromServer(server: string): "google" | "linear" | "notion" | null {
  if (server.startsWith("june_gmail") || server.startsWith("june_gcal")) return "google";
  if (server.startsWith("june_linear")) return "linear";
  if (server.startsWith("june_notion")) return "notion";
  return null;
}

/**
 * Composes a routine's enabled_toolsets for a trust mode, per the connectors
 * design:
 * - read_only: the base list (sandboxed cron default or the unrestricted
 *   override) plus the read servers only;
 * - approval: read servers plus the actions servers (calls park for
 *   approval in the Rust proxy);
 * - autonomous: read servers plus the per-job auto servers minted by
 *   routine_trust_set — the actions servers are swapped OUT, so anything
 *   not granted stays unavailable rather than silently parking.
 */
export function routineToolsetsFor(
  trust: RoutineTrustMode,
  options: { unrestricted: boolean; autonomousServers?: string[] },
): string[] {
  const base = options.unrestricted
    ? UNRESTRICTED_ROUTINE_TOOLSETS
    : SANDBOXED_ROUTINE_BASE_TOOLSETS;
  const toolsets = [...base, ...CONNECTOR_READ_TOOLSETS];
  if (trust === "approval") toolsets.push(...CONNECTOR_ACTION_TOOLSETS);
  if (trust === "autonomous") toolsets.push(...(options.autonomousServers ?? []));
  return [...new Set(toolsets)];
}

const AUTO_SERVER_PATTERN = /^june_(?:gmail|gcal)_auto_/;

/**
 * Derives the trust mode a stored job's toolset override implies, for the
 * list badge — no per-row Tauri round trip. Returns null for routines with
 * no connector toolsets at all (nothing to badge).
 */
export function routineTrustModeFromToolsets(
  enabledToolsets: string[] | undefined,
): RoutineTrustMode | null {
  const toolsets = enabledToolsets ?? [];
  if (toolsets.some((toolset) => AUTO_SERVER_PATTERN.test(toolset))) return "autonomous";
  if (toolsets.some((toolset) => CONNECTOR_ACTION_TOOLSETS.includes(toolset))) return "approval";
  if (toolsets.some((toolset) => CONNECTOR_READ_TOOLSETS.includes(toolset))) return "read_only";
  return null;
}

// ---------------------------------------------------------------------------
// Event triggers
// ---------------------------------------------------------------------------

export type TriggerMeta = {
  label: string;
  description: string;
  /** Config keys the trigger's kind carries in ConnectorTrigger.config. */
  configFields: string[];
};

export const TRIGGER_META: Readonly<Record<ConnectorTriggerKind, TriggerMeta>> = Object.freeze({
  email_received: {
    label: "When new email arrives",
    description: "Runs when new mail lands in the connected inbox.",
    configFields: [],
  },
  event_upcoming: {
    label: "Before an upcoming meeting",
    description: "Runs a set number of minutes before a calendar event starts.",
    configFields: ["leadMinutes", "externalOnly"],
  },
});

/** The routine editor's "When" model: a plain schedule, or a connector event
 * trigger. Kept out of ScheduleDraft on purpose — events never encode into
 * the cron string; the daemon fires the (paused) job directly. */
export type TriggerDraft =
  | { source: "schedule" }
  | { source: "email_received" }
  | { source: "event_upcoming"; leadMinutes: number; externalOnly: boolean };

export const DEFAULT_EVENT_LEAD_MINUTES = 30;

/**
 * The connector scope bundle a connector event trigger's daemon must be able to
 * call on the account it subscribes on: a Gmail read to poll for new mail, a
 * calendar read to poll upcoming events. Schedules poll nothing, so they need
 * none. Drives the create/edit gate so a trigger can't be saved against an
 * account whose token lacks the scope the daemon will call, which would leave
 * the routine silently never firing (the Gmail history / calendar list call
 * fails on the missing scope).
 */
export function triggerRequiredBundles(trigger: TriggerDraft): readonly ConnectorScopeBundle[] {
  switch (trigger.source) {
    case "email_received":
      return ["gmail_read"];
    case "event_upcoming":
      return ["calendar_read"];
    default:
      return [];
  }
}

/**
 * A one-line warning when the account a connector trigger would subscribe on is
 * connected but lacks the scope its daemon needs, naming the missing access and
 * where to add it. Returns null when the trigger needs no scope, the account
 * already covers it, or no account is connected (the picker shows its own
 * "connect an account" notice in that case).
 */
export function triggerScopeWarning(
  trigger: TriggerDraft,
  accountScopes: string[] | null,
): string | null {
  const bundles = triggerRequiredBundles(trigger);
  if (bundles.length === 0) return null;
  if (accountScopes == null) return null;
  if (scopesCoverBundles(accountScopes, bundles)) return null;
  const features = bundles.map((bundle) => BUNDLE_META[bundle].label.toLowerCase()).join(" and ");
  return `This trigger needs ${features} access on your connected Google account. Add it in Settings under Connectors.`;
}

/**
 * The schedule an event-triggered routine is created with. Event routines
 * still need a Hermes cron record underneath (the trigger daemon fires them
 * via the cron trigger action), so they get a far-future one-time schedule
 * and are paused right after creation — the daemon re-pauses after each
 * fire, and the distant date guarantees the scheduler itself never runs it.
 */
export function eventTriggerScheduleDraft(): { schedule: string; paused: true } {
  return { schedule: "2099-01-01T09:00:00Z", paused: true };
}

/** Builds the config payload connector_trigger_set expects for a draft. */
export function triggerConfigFromDraft(
  draft: Exclude<TriggerDraft, { source: "schedule" }>,
): Record<string, unknown> {
  if (draft.source === "event_upcoming") {
    return { leadMinutes: draft.leadMinutes, externalOnly: draft.externalOnly };
  }
  return {};
}
