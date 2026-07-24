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
  ConnectorPolicyCatalog,
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
  /** Short feature phrase for "This routine can: ..." summaries. */
  feature: string;
};

/** Renderer-only copy. Bundle ownership and scopes come from Rust. */
export const BUNDLE_META: Readonly<Partial<Record<ConnectorScopeBundle, ConnectorBundleMeta>>> =
  Object.freeze({
    gmail_read: {
      label: "Read mail",
      description: "Search and read your email for briefings and triage.",
      feature: "read your mail",
    },
    gmail_draft: {
      label: "Draft replies",
      description: "Write draft replies for you to review. Never sends.",
      feature: "draft replies",
    },
    gmail_modify: {
      label: "Organize mail",
      description: "Label and archive your mail. Never deletes.",
      feature: "label and archive mail",
    },
    gmail_send: {
      label: "Send mail",
      description: "Send email on your behalf. Only used when you allow it per routine.",
      feature: "send mail",
    },
    calendar_read: {
      label: "Read calendar",
      description: "Read your events and find free slots for briefings and prep.",
      feature: "read your calendar",
    },
    calendar_events: {
      label: "Manage calendar",
      description: "Create events and respond to invites on your behalf.",
      feature: "manage your calendar",
    },
    linear_read: {
      label: "Read workspace",
      description: "Read teams, projects, cycles, and issues for planning and status briefs.",
      feature: "read your Linear workspace",
    },
    linear_write: {
      label: "Create and update issues",
      description:
        "Draft issues, comments, and project updates. Nothing is written without your approval.",
      feature: "create and update issues",
    },
    github_read: {
      label: "Read repositories, issues, and pull requests",
      description:
        "Read code, issues, pull requests, and comments in the repositories chosen during GitHub App installation.",
      feature: "read your GitHub repositories",
    },
    github_write: {
      label: "Create and update issues and comments",
      description:
        "June allows drafting issues and comments on your behalf. Every write asks for your approval before it runs.",
      feature: "create and update issues",
    },
  });

export function bundleMeta(bundle: ConnectorScopeBundle): ConnectorBundleMeta {
  return (
    BUNDLE_META[bundle] ?? {
      label: bundle.replace(/_/g, " "),
      description: "Connector capability.",
      feature: bundle.replace(/_/g, " "),
    }
  );
}

/** The feature bundles a provider's connect dialog offers, in display
 * order. */
export function bundlesForProvider(
  policy: ConnectorPolicyCatalog,
  provider: ConnectorProvider,
): ConnectorScopeBundle[] {
  return policy.scopeBundles
    .filter((bundle) => bundle.provider === provider)
    .map((bundle) => bundle.id);
}

export function defaultBundlesForProvider(
  policy: ConnectorPolicyCatalog,
  provider: ConnectorProvider,
): ConnectorScopeBundle[] {
  return (
    policy.providers.find((definition) => definition.id === provider)?.defaultBundles ?? []
  ).slice();
}

/** True when the granted scope set satisfies `needed`, directly or because a
 * broader granted scope implies it. */
function grantsScope(
  policy: ConnectorPolicyCatalog,
  granted: Set<string>,
  needed: string,
): boolean {
  if (granted.has(needed)) return true;
  for (const held of granted) {
    if (policy.scopeImplications.find((entry) => entry.held === held)?.grants.includes(needed)) {
      return true;
    }
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
  policy: ConnectorPolicyCatalog,
  scopeUrls: string[],
  provider: ConnectorProvider,
): ConnectorScopeBundle[] {
  const granted = new Set(scopeUrls);
  return policy.scopeBundles
    .filter((bundle) => bundle.provider === provider)
    .filter((bundle) => bundle.scopeIds.every((scope) => granted.has(scope)))
    .map((bundle) => bundle.id);
}

/** "Read mail, draft replies and calendar" — the human feature list an
 * account's grants render as. */
export function grantedFeatureLabels(
  policy: ConnectorPolicyCatalog,
  scopeUrls: string[],
  provider: ConnectorProvider,
): string[] {
  return bundlesFromScopes(policy, scopeUrls, provider).map((bundle) => bundleMeta(bundle).label);
}

/** True when the account's granted scopes already cover every bundle a routine
 * needs, counting a broader granted scope as covering a narrower need (so a
 * read-only briefing runs on an account that granted calendar write). */
export function scopesCoverBundles(
  policy: ConnectorPolicyCatalog,
  scopeUrls: string[],
  bundles: readonly ConnectorScopeBundle[],
): boolean {
  const granted = new Set(scopeUrls);
  return bundles.every((bundleId) => {
    const bundle = policy.scopeBundles.find((entry) => entry.id === bundleId);
    return Boolean(bundle?.scopeIds.every((scope) => grantsScope(policy, granted, scope)));
  });
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
  github: "GitHub needs you to sign in again before June can use this account.",
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
export function canSelectAutonomous(policy: ConnectorPolicyCatalog, runCount: number): boolean {
  return runCount >= policy.earnedAutonomyMinApprovalRuns;
}

/** Helper text under the trust picker while autonomy is still locked:
 * "Runs 2 more times under approval to unlock autonomous". */
export function autonomyUnlockHint(policy: ConnectorPolicyCatalog, runCount: number): string {
  const remaining = Math.max(0, policy.earnedAutonomyMinApprovalRuns - runCount);
  if (remaining === 0) return "Autonomous is unlocked for this routine.";
  const times = remaining === 1 ? "1 more time" : `${remaining} more times`;
  return `Runs ${times} under approval to unlock autonomous.`;
}

/** Progress label for the detail page: "Run 2 of 3 under approval before
 * autonomy unlocks". Clamped once the threshold is met. */
export function autonomyProgressLabel(policy: ConnectorPolicyCatalog, runCount: number): string {
  if (canSelectAutonomous(policy, runCount)) return "Autonomy unlocked.";
  const threshold = policy.earnedAutonomyMinApprovalRuns;
  const next = Math.min(runCount + 1, threshold);
  return `Run ${next} of ${threshold} under approval before autonomy unlocks.`;
}

// ---------------------------------------------------------------------------
// Trust-mode toolset composition
// ---------------------------------------------------------------------------

/** Renderer projection of one native-owned connector action tool. */
export type ConnectorActionTool = {
  id: string;
  server: string;
  provider: ConnectorProvider;
  label: string;
  grantable: boolean;
};

/** Labels only. Tool/server ownership and grantability come from Rust. */
const ACTION_TOOL_LABELS: Readonly<Record<string, string>> = Object.freeze({
  "june_gmail_actions:create_draft": "Create drafts",
  "june_gmail_actions:send_email": "Send email",
  "june_gmail_actions:modify_labels": "Change labels",
  "june_gmail_actions:archive": "Archive mail",
  "june_gcal_actions:create_event": "Create events",
  "june_gcal_actions:respond_to_invite": "Respond to invites",
  "june_linear_actions:create_issue": "Create issues",
  "june_linear_actions:update_issue": "Update issues",
  "june_linear_actions:add_comment": "Comment on issues",
  "june_linear_actions:create_project_update": "Post project updates",
  "june_notion_actions:notion-create-pages": "Create Notion pages",
  "june_notion_actions:notion-update-page": "Update Notion pages",
  "june_github_actions:create_issue": "Create issue",
  "june_github_actions:update_issue": "Update issue",
  "june_github_actions:add_comment": "Add comment",
});

export function connectorActionTools(policy: ConnectorPolicyCatalog): ConnectorActionTool[] {
  return policy.actionTools.map((tool) => ({
    ...tool,
    label: ACTION_TOOL_LABELS[`${tool.server}:${tool.id}`] ?? tool.id.replace(/[_-]/g, " "),
  }));
}

export function grantableConnectorActionTools(
  policy: ConnectorPolicyCatalog,
): ConnectorActionTool[] {
  return connectorActionTools(policy).filter((tool) => tool.grantable);
}

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
 * Pass the originating server when known: colliding ids resolve to that
 * provider's label. Falls back to a spaced form of the raw name for any
 * unmapped tool. */
export function actionToolLabel(
  policy: ConnectorPolicyCatalog,
  tool: string,
  server?: string,
): string {
  if (server) {
    const qualified = ACTION_TOOL_LABELS[`${server}:${tool}`];
    if (qualified) {
      return qualified;
    }
  }
  const firstIdentity = policy.actionTools.find((entry) => entry.id === tool);
  if (firstIdentity) {
    return (
      ACTION_TOOL_LABELS[`${firstIdentity.server}:${firstIdentity.id}`] ??
      tool.replace(/[_-]/g, " ")
    );
  }
  return tool.replace(/[_-]/g, " ");
}

/** The provider behind a connector MCP server name, for provider marks on the
 * approvals surface. Null for non-connector servers. */
export function providerFromServer(
  policy: ConnectorPolicyCatalog,
  server: string,
): "google" | "linear" | "notion" | "github" | null {
  return (
    policy.serverOwnerPrefixes.find((definition) => server.startsWith(definition.prefix))
      ?.provider ?? null
  );
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
  policy: ConnectorPolicyCatalog,
  trust: RoutineTrustMode,
  options: {
    unrestricted: boolean;
    autonomousServers?: string[];
    routineBrowserServer?: string;
  },
): string[] {
  const base = options.unrestricted
    ? UNRESTRICTED_ROUTINE_TOOLSETS
    : policy.routine.sandboxedBaseToolsets;
  const toolsets = [...base, ...policy.routine.readToolsets];
  if (trust === "approval") toolsets.push(...policy.routine.actionToolsets);
  if (trust === "autonomous") toolsets.push(...(options.autonomousServers ?? []));
  if (options.routineBrowserServer) toolsets.push(options.routineBrowserServer);
  return [...new Set(toolsets)];
}

/**
 * Derives the trust mode a stored job's toolset override implies, for the
 * list badge — no per-row Tauri round trip. Returns null for routines with
 * no connector toolsets at all (nothing to badge).
 */
export function routineTrustModeFromToolsets(
  policy: ConnectorPolicyCatalog,
  enabledToolsets: string[] | undefined,
): RoutineTrustMode | null {
  const toolsets = enabledToolsets ?? [];
  if (
    toolsets.some((toolset) =>
      policy.routine.autonomousServerPrefixes.some((prefix) => toolset.startsWith(prefix)),
    )
  ) {
    return "autonomous";
  }
  if (toolsets.some((toolset) => policy.routine.actionToolsets.includes(toolset))) {
    return "approval";
  }
  if (toolsets.some((toolset) => policy.routine.readToolsets.includes(toolset))) {
    return "read_only";
  }
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
export function triggerRequiredBundles(
  policy: ConnectorPolicyCatalog,
  trigger: TriggerDraft,
): readonly ConnectorScopeBundle[] {
  if (trigger.source === "schedule") return [];
  return (
    policy.triggers.find((definition) => definition.id === trigger.source)?.requiredBundles ?? []
  );
}

/**
 * A one-line warning when the account a connector trigger would subscribe on is
 * connected but lacks the scope its daemon needs, naming the missing access and
 * where to add it. Returns null when the trigger needs no scope, the account
 * already covers it, or no account is connected (the picker shows its own
 * "connect an account" notice in that case).
 */
export function triggerScopeWarning(
  policy: ConnectorPolicyCatalog,
  trigger: TriggerDraft,
  accountScopes: string[] | null,
): string | null {
  const bundles = triggerRequiredBundles(policy, trigger);
  if (bundles.length === 0) return null;
  if (accountScopes == null) return null;
  if (scopesCoverBundles(policy, accountScopes, bundles)) return null;
  const features = bundles.map((bundle) => bundleMeta(bundle).label.toLowerCase()).join(" and ");
  return `This trigger needs ${features} access on your connected Google account. Add it in Settings under Plugins.`;
}

/** Contract check for the renderer-only presentation maps. */
export function missingConnectorPresentationIds(policy: ConnectorPolicyCatalog): string[] {
  const missingBundles = policy.scopeBundles
    .filter((bundle) => !BUNDLE_META[bundle.id])
    .map((bundle) => `bundle:${bundle.id}`);
  const missingActions = policy.actionTools
    .filter((tool) => !ACTION_TOOL_LABELS[`${tool.server}:${tool.id}`])
    .map((tool) => `action:${tool.server}:${tool.id}`);
  return [...missingBundles, ...missingActions];
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
