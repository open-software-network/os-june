/**
 * Pure, render-free view logic for the private Google connectors (local
 * mode): scope-bundle metadata, account status labels, trust-mode metadata
 * and earned-autonomy gating, the trust-mode to Hermes toolset composition,
 * event-trigger metadata, and the biography generation prompt.
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
  /** The Google scope URLs the bundle grants. Mirrors ScopeBundle::scopes()
   * in src-tauri/src/connectors/scopes.rs; keep in sync. */
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
  });

export const ALL_SCOPE_BUNDLES: readonly ConnectorScopeBundle[] = Object.freeze([
  "gmail_read",
  "gmail_draft",
  "gmail_modify",
  "gmail_send",
  "calendar_read",
  "calendar_events",
]);

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

/** Maps an account's granted Google scope URLs back to the feature bundles it
 * explicitly holds, in registry order. Exact match (not superset): this drives
 * display and reconnect, which should reflect what was actually granted, not
 * what a broader scope could stand in for. Unknown URLs (identity scopes,
 * future grants) are ignored: the UI shows features, not raw scopes. */
export function bundlesFromScopes(scopeUrls: string[]): ConnectorScopeBundle[] {
  const granted = new Set(scopeUrls);
  return ALL_SCOPE_BUNDLES.filter((bundle) =>
    BUNDLE_META[bundle].scopeUrls.every((url) => granted.has(url)),
  );
}

/** "Read mail, draft replies and calendar" — the human feature list an
 * account's grants render as. */
export function grantedFeatureLabels(scopeUrls: string[]): string[] {
  return bundlesFromScopes(scopeUrls).map((bundle) => BUNDLE_META[bundle].label);
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

const STATUS_META: Readonly<Record<ConnectorAccountStatus, ConnectorStatusMeta>> = Object.freeze({
  connected: {
    label: "Connected",
    tone: "ok",
    blurb: "This account is ready. Tokens stay in your Mac's Keychain.",
  },
  reconnect_required: {
    label: "Reconnect needed",
    tone: "attention",
    blurb: "Google needs you to sign in again before June can use this account.",
  },
});

export function accountStatusMeta(status: ConnectorAccountStatus): ConnectorStatusMeta {
  return STATUS_META[status];
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

/** Read-only connector MCP servers: ambient for every routine. */
export const CONNECTOR_READ_TOOLSETS = ["june_gmail", "june_gcal"];

/** Action connector MCP servers: every mutating call parks for approval in
 * the Rust proxy. */
export const CONNECTOR_ACTION_TOOLSETS = ["june_gmail_actions", "june_gcal_actions"];

/** One grantable connector action tool, for the autonomous grant checklist.
 * `id` is the raw tool name the Rust proxy consults grants by. */
export type ConnectorActionTool = {
  id: string;
  server: string;
  label: string;
};

export const CONNECTOR_ACTION_TOOLS: readonly ConnectorActionTool[] = Object.freeze([
  { id: "create_draft", server: "june_gmail_actions", label: "Create drafts" },
  { id: "send_email", server: "june_gmail_actions", label: "Send email" },
  { id: "modify_labels", server: "june_gmail_actions", label: "Change labels" },
  { id: "archive", server: "june_gmail_actions", label: "Archive mail" },
  { id: "create_event", server: "june_gcal_actions", label: "Create events" },
  { id: "respond_to_invite", server: "june_gcal_actions", label: "Respond to invites" },
]);

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

// ---------------------------------------------------------------------------
// Biography
// ---------------------------------------------------------------------------

/**
 * The one-shot agent prompt behind "Build my profile". Instructs the agent to
 * gather from local context plus the connector READ tools only, keep the
 * local-only framing, and emit the profile as a single fenced markdown block
 * so the UI can extract and store it.
 */
export function biographyPrompt(): string {
  return [
    "Build a short professional profile of me, for my eyes only. The profile is saved only on this Mac. Do not send, share, or store it anywhere else.",
    "Sources: use the june_context tools to review my notes and past sessions, and the gmail and gcal read tools (search_threads, read_thread, list_unread, list_events, get_event) to learn my role, the people I work with most, my current projects, and my typical week. Use read tools only: do not draft, send, label, or change anything.",
    "Write the profile as concise markdown: who I am, what I am working on, key people and how we collaborate, recurring commitments, and anything a great assistant should remember.",
    'When you are done, output the profile as one single fenced code block tagged "markdown" (```markdown ... ```), with no other fenced blocks in your final message, so June can save it.',
  ].join("\n\n");
}

/**
 * Extracts the profile from an agent's final message: the contents of a
 * single fenced ```markdown block. Falls back to a bare ``` block when the
 * tag is missing, and to null when there is no fenced block at all.
 */
export function extractBiographyMarkdown(text: string): string | null {
  const tagged = text.match(/```markdown\r?\n([\s\S]*?)```/);
  if (tagged) return tagged[1].trim() || null;
  const bare = text.match(/```\r?\n([\s\S]*?)```/);
  if (bare) return bare[1].trim() || null;
  return null;
}
