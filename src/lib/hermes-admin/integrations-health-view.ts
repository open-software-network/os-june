/**
 * Pure, render-free aggregation for the Unified Integrations Health dashboard
 * (admin surfaces spec 22). It READS the data every landed admin surface already
 * loads (the selected model, the gateway lifecycle, installed skills + their
 * setup badges, toolsets, MCP servers + their diagnostics, pending skill writes,
 * external skill directories) and reduces all of it to:
 *
 * - one prioritized {@link HealthIssue} list, each issue CONCRETE and ACTIONABLE
 *   and carrying the exact Settings tab that fixes it (so the UI can deep-link
 *   "Linear is not authenticated -> Open MCP servers");
 * - a single overall {@link HealthStatus} (Ready / Needs setup / Needs restart /
 *   Needs review / Risky configuration / Broken / Unknown);
 * - the per-area summary counts the header renders;
 * - a SANITIZED {@link IntegrationsHealthReport} bundle for export, which counts
 *   and statuses secrets but NEVER reveals a value. Like the MCP diagnostics
 *   bundle (`buildDiagnosticBundle`) and the setup snapshot, the whole structure
 *   is run through the shared structural redactor as a backstop.
 *
 * This module never talks to Hermes and never mutates anything. It reshapes
 * already-parsed inputs so the priority ordering, the status derivation, and the
 * export redaction are unit-testable without rendering or a network.
 *
 * Copy is sentence case, no em/en-dashes, per June conventions. Code comments are
 * exempt from the dash rule.
 *
 * Cross-prompt note: the "high-risk MCP enabled" signal (spec 19) and the team
 * tap signals (spec 13) are not in this branch yet. They are modeled here as
 * OPTIONAL inputs and only contribute issues when a caller supplies them, so the
 * branch compiles and tests pass standalone and the surfaces light up the day
 * those land.
 */

import { redactForLog } from "./redact";
import { summarizeHealth, type McpHealthSummary } from "./mcp-diagnostics-view";
import { restartPendingFromLifecycle } from "./use-mcp-diagnostics";
import type { GatewayLifecycleSnapshot } from "./gateway-lifecycle";
import type { ExternalDirRow } from "./external-dirs-view";
import type { SkillSetupBadge } from "./skill-setup-view";
import type {
  HermesMcpServerInfo,
  HermesSkillInfo,
  HermesToolsetInfo,
} from "./schemas";

// ---------------------------------------------------------------------------
// Settings tabs an issue can deep-link to. Kept as a string union local to this
// module so the view layer is decoupled from the AppSettings `SettingsTab` type;
// the section component maps these onto the real tab ids when it navigates.
// ---------------------------------------------------------------------------

/** The fixing surface an issue links to. Mirrors the AppSettings tab ids that
 * own each capability. */
export type HealthTarget =
  | "models"
  | "skills"
  | "skill-review"
  | "external-dirs"
  | "mcp"
  | "mcp-diagnostics"
  | "toolsets";

// ---------------------------------------------------------------------------
// Status model
// ---------------------------------------------------------------------------

/** The overall readiness of June's integrations, in the spec's vocabulary. */
export type HealthStatus =
  | "ready" // everything required is configured and applied
  | "needs-setup" // a required secret/config/model is missing
  | "needs-restart" // changes are staged but the gateway has not restarted
  | "needs-review" // agent-authored skill writes await approval
  | "risky-configuration" // a high-risk capability is enabled
  | "broken" // something failed (a connection, an unreachable dir)
  | "unknown"; // no runtime, or nothing loaded yet

/** The severity weight of each status, so a worse area dominates the overall
 * badge. Higher wins. `unknown` is deliberately low so a single not-yet-loaded
 * area does not mask a real "broken" elsewhere. */
const STATUS_WEIGHT: Readonly<Record<HealthStatus, number>> = Object.freeze({
  ready: 0,
  unknown: 1,
  "needs-review": 2,
  "needs-setup": 3,
  "needs-restart": 4,
  "risky-configuration": 5,
  broken: 6,
});

/** Display copy for each overall status. Sentence case, no dashes. */
const STATUS_LABEL: Readonly<Record<HealthStatus, string>> = Object.freeze({
  ready: "Ready",
  "needs-setup": "Needs setup",
  "needs-restart": "Needs restart",
  "needs-review": "Needs review",
  "risky-configuration": "Risky configuration",
  broken: "Broken",
  unknown: "Unknown",
});

/** The tone the badge styles by. */
export type HealthTone = "ready" | "attention" | "error" | "neutral";

const STATUS_TONE: Readonly<Record<HealthStatus, HealthTone>> = Object.freeze({
  ready: "ready",
  "needs-setup": "attention",
  "needs-restart": "attention",
  "needs-review": "attention",
  "risky-configuration": "error",
  broken: "error",
  unknown: "neutral",
});

/** The status label for a status value. */
export function healthStatusLabel(status: HealthStatus): string {
  return STATUS_LABEL[status];
}

/** The badge tone for a status value. */
export function healthStatusTone(status: HealthStatus): HealthTone {
  return STATUS_TONE[status];
}

// ---------------------------------------------------------------------------
// Issues
// ---------------------------------------------------------------------------

/** A stable category key for an issue, for styling, testing, and dedupe. */
export type HealthIssueCode =
  | "model-no-tools" // selected model cannot use tools
  | "model-unknown" // no model selected / capability unknown
  | "gateway-restart-required" // staged changes need a gateway restart
  | "gateway-restart-failed" // a restart attempt failed
  | "skill-missing-secret" // an enabled skill is missing a required secret
  | "skill-missing-config" // an enabled skill is missing required config
  | "skill-pending-review" // agent-authored skill writes await approval
  | "toolset-needs-setup" // an enabled toolset has unmet requirements
  | "mcp-auth-needed" // an enabled MCP server is not authenticated
  | "mcp-failing" // an enabled MCP server failed its last connection
  | "mcp-high-risk" // a high-risk MCP server is enabled (spec 19, optional)
  | "external-dir-missing" // a configured external dir does not exist
  | "external-dir-unreadable"; // a configured external dir is not readable

/** A single readiness problem, with a concrete fix and the surface that fixes
 * it. The status the issue maps the overall badge toward is `status`; the issue
 * list is sorted by `status` weight then by the input order within an area. */
export type HealthIssue = {
  code: HealthIssueCode;
  /** The overall status this issue contributes (drives the headline badge). */
  status: Exclude<HealthStatus, "ready" | "unknown">;
  tone: HealthTone;
  /** Sentence-case statement of the problem, naming the subject. */
  message: string;
  /** Sentence-case next step, phrased as the spec's "-> do this" call. */
  action: string;
  /** The Settings tab to open to fix it. */
  target: HealthTarget;
};

/** The order codes appear within the same status weight, so a stable, readable
 * list results (model first, then gateway, skills, toolsets, MCP, dirs). Lower
 * sorts earlier. */
const CODE_ORDER: Readonly<Record<HealthIssueCode, number>> = Object.freeze({
  "model-no-tools": 0,
  "model-unknown": 1,
  "gateway-restart-failed": 2,
  "gateway-restart-required": 3,
  "skill-pending-review": 4,
  "skill-missing-secret": 5,
  "skill-missing-config": 6,
  "toolset-needs-setup": 7,
  "mcp-failing": 8,
  "mcp-auth-needed": 9,
  "mcp-high-risk": 10,
  "external-dir-missing": 11,
  "external-dir-unreadable": 12,
});

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/** The selected generation model and whether it can call tools. June's agent
 * works entirely through tool calls, so a non-tool model is a hard blocker. */
export type ModelHealthInput = {
  /** The selected model id, empty when none is chosen. */
  id: string;
  /** Display name, when known (falls back to the id). */
  name?: string;
  /** True when the model supports tool calling. `undefined` when the catalog
   * has not loaded yet, so June marks it unknown rather than guessing. */
  supportsTools?: boolean;
};

/** One enabled skill plus its resolved setup badge (from the shared setup
 * overview). A skill with no declared setup has `badge: undefined`. */
export type SkillHealthInput = {
  name: string;
  enabled: boolean;
  badge?: SkillSetupBadge;
};

/** The full set of already-loaded inputs the health view reduces. Every field
 * is what a landed hook already exposes; nothing here triggers a load. */
export type IntegrationsHealthInputs = {
  /** Targeting context, surfaced in the report and the UI mode note. */
  mode?: string;
  profile?: string;
  /** True when no runtime is reachable in the requested mode. The whole
   * dashboard then reads "unknown" rather than "ready". */
  unavailable?: boolean;

  model?: ModelHealthInput;
  lifecycle: GatewayLifecycleSnapshot;
  skills: readonly SkillHealthInput[];
  toolsets: readonly HermesToolsetInfo[];
  mcpServers: readonly HermesMcpServerInfo[];
  /** Count of pending agent-authored skill writes awaiting approval. */
  pendingSkillWrites: number;
  externalDirs: readonly ExternalDirRow[];
  /** The number of configured secrets and the number still missing, COUNTS only
   * (never values). Supplied by the caller from the skill setup / MCP env
   * surfaces; both default to 0 when not provided. */
  secrets?: { configured: number; missing: number };

  /**
   * OPTIONAL high-risk MCP signal (spec 19, built in parallel and not in this
   * branch). When a caller can tell which enabled servers are high risk, it
   * passes their names here and the view raises a "risky configuration" issue.
   * Absent it contributes nothing, so this branch is standalone-correct.
   */
  highRiskMcpServers?: readonly string[];
};

// ---------------------------------------------------------------------------
// Area summaries (the header counts)
// ---------------------------------------------------------------------------

/** Per-area readiness counts the dashboard header renders. */
export type IntegrationsHealthSummary = {
  skills: { total: number; enabled: number; needingSetup: number };
  toolsets: { total: number; enabled: number; needingSetup: number };
  mcp: McpHealthSummary;
  secrets: { configured: number; missing: number };
  pendingSkillWrites: number;
  externalDirs: { total: number; missing: number; unreadable: number };
  highRiskMcp: number;
};

/** The complete derived health model the dashboard renders and exports. */
export type IntegrationsHealth = {
  status: HealthStatus;
  statusLabel: string;
  tone: HealthTone;
  /** True when there is no runtime to read. */
  unavailable: boolean;
  /** The prioritized issue list, worst first; empty when everything is ready. */
  issues: HealthIssue[];
  summary: IntegrationsHealthSummary;
  model?: ModelHealthInput;
  lifecycle: GatewayLifecycleSnapshot;
  mode?: string;
  profile?: string;
};

// ---------------------------------------------------------------------------
// Toolset readiness
// ---------------------------------------------------------------------------

/** Whether an enabled toolset has unmet prerequisites. Uses the explicit
 * `configured` flag when the wire reports it; otherwise falls back to any
 * requirement reported unsatisfied. A toolset with no signal is treated as
 * configured (June never invents a problem). */
function toolsetNeedsSetup(toolset: HermesToolsetInfo): boolean {
  if (!toolset.enabled) return false;
  if (toolset.configured === false) return true;
  const requirements = toolset.requirements ?? [];
  return requirements.some((requirement) => requirement.satisfied === false);
}

// ---------------------------------------------------------------------------
// The aggregator
// ---------------------------------------------------------------------------

/**
 * Reduces the loaded inputs into the full health model. Pure and deterministic:
 * the same inputs always yield the same issues, ordering, and status.
 */
export function buildIntegrationsHealth(
  inputs: IntegrationsHealthInputs,
): IntegrationsHealth {
  const issues: HealthIssue[] = [];
  const restartPending = restartPendingFromLifecycle(inputs.lifecycle);
  const highRisk = new Set(inputs.highRiskMcpServers ?? []);

  // --- Model (a non-tool model blocks the entire agent) -------------------
  if (inputs.model) {
    const modelLabel = inputs.model.name ?? inputs.model.id;
    if (inputs.model.id && inputs.model.supportsTools === false) {
      issues.push({
        code: "model-no-tools",
        status: "needs-setup",
        tone: "error",
        message: `The selected model (${modelLabel}) cannot use tools, so June's agent cannot do its work.`,
        action: "Change to a tool-capable model.",
        target: "models",
      });
    } else if (!inputs.model.id) {
      issues.push({
        code: "model-unknown",
        status: "needs-setup",
        tone: "attention",
        message: "No generation model is selected.",
        action: "Pick a tool-capable model.",
        target: "models",
      });
    }
  }

  // --- Gateway lifecycle --------------------------------------------------
  if (inputs.lifecycle.state === "restart-failed") {
    issues.push({
      code: "gateway-restart-failed",
      status: "broken",
      tone: "error",
      message:
        inputs.lifecycle.error ??
        "The Hermes gateway did not restart, so your latest changes are not applied.",
      action: "Restart the gateway.",
      target: "mcp-diagnostics",
    });
  } else if (
    restartPending &&
    inputs.lifecycle.state !== "restart-in-progress"
  ) {
    issues.push({
      code: "gateway-restart-required",
      status: "needs-restart",
      tone: "attention",
      message:
        "Changes are staged but the Hermes gateway has not restarted, so they are not live yet.",
      action: "Restart the gateway.",
      target: "mcp-diagnostics",
    });
  }

  // --- Skills (only enabled skills can block readiness) -------------------
  for (const skill of inputs.skills) {
    if (!skill.enabled || !skill.badge) continue;
    if (skill.badge.status === "missing-api-key") {
      issues.push({
        code: "skill-missing-secret",
        status: "needs-setup",
        tone: "attention",
        message: `The ${skill.name} skill is enabled but a required secret is missing.`,
        action: "Add the secret.",
        target: "skills",
      });
    } else if (skill.badge.status === "missing-config") {
      issues.push({
        code: "skill-missing-config",
        status: "needs-setup",
        tone: "attention",
        message: `The ${skill.name} skill is enabled but required configuration is missing.`,
        action: "Add the configuration.",
        target: "skills",
      });
    }
  }

  // --- Pending agent-authored skill writes --------------------------------
  if (inputs.pendingSkillWrites > 0) {
    const plural = inputs.pendingSkillWrites === 1 ? "change" : "changes";
    issues.push({
      code: "skill-pending-review",
      status: "needs-review",
      tone: "attention",
      message: `${inputs.pendingSkillWrites} agent-authored skill ${plural} await your review.`,
      action: "Review the pending changes.",
      target: "skill-review",
    });
  }

  // --- Toolsets -----------------------------------------------------------
  for (const toolset of inputs.toolsets) {
    if (toolsetNeedsSetup(toolset)) {
      const label = toolset.label ?? toolset.name;
      issues.push({
        code: "toolset-needs-setup",
        status: "needs-setup",
        tone: "attention",
        message: `The ${label} toolset is enabled but its requirements are not met.`,
        action: "Complete the toolset setup.",
        target: "toolsets",
      });
    }
  }

  // --- MCP servers (only enabled servers block readiness) -----------------
  for (const server of inputs.mcpServers) {
    if (!server.enabled) continue;
    if (server.status === "error") {
      issues.push({
        code: "mcp-failing",
        status: "broken",
        tone: "error",
        message: `The ${server.name} MCP server failed its last connection.`,
        action: "Open MCP diagnostics to fix the connection.",
        target: "mcp-diagnostics",
      });
    }
    if (mcpNeedsAuth(server)) {
      issues.push({
        code: "mcp-auth-needed",
        status: "needs-setup",
        tone: "attention",
        message: `The ${server.name} MCP server is installed but not authenticated.`,
        action: "Open OAuth setup.",
        target: "mcp",
      });
    }
    if (highRisk.has(server.name)) {
      issues.push({
        code: "mcp-high-risk",
        status: "risky-configuration",
        tone: "error",
        message: `The ${server.name} MCP server is high risk and enabled.`,
        action: "Review its permissions and sandbox boundary.",
        target: "mcp",
      });
    }
  }

  // --- External skill directories -----------------------------------------
  for (const dir of inputs.externalDirs) {
    if (dirIsMissing(dir)) {
      issues.push({
        code: "external-dir-missing",
        status: "broken",
        tone: "error",
        message: `The external skill directory ${dir.rawPath} does not exist.`,
        action: "Fix or remove the directory.",
        target: "external-dirs",
      });
    } else if (dir.presence === "unreadable") {
      issues.push({
        code: "external-dir-unreadable",
        status: "broken",
        tone: "error",
        message: `The external skill directory ${dir.rawPath} is not readable.`,
        action: "Fix permissions or remove the directory.",
        target: "external-dirs",
      });
    }
  }

  issues.sort(sortIssues);

  const summary = buildSummary(inputs, restartPending, highRisk);
  const status = inputs.unavailable ? "unknown" : overallStatus(issues);

  return {
    status,
    statusLabel: STATUS_LABEL[status],
    tone: STATUS_TONE[status],
    unavailable: inputs.unavailable === true,
    issues,
    summary,
    model: inputs.model,
    lifecycle: inputs.lifecycle,
    mode: inputs.mode,
    profile: inputs.profile,
  };
}

/** True when a configured external directory is gone: it does not exist, is not
 * a directory, or has an unresolved `${VAR}` in its path. An `unreadable`
 * directory is handled separately (it exists). */
function dirIsMissing(dir: ExternalDirRow): boolean {
  return (
    dir.presence === "missing" ||
    dir.presence === "not-a-directory" ||
    dir.presence === "unresolved"
  );
}

/** True when an enabled MCP server uses auth and is not currently signed in.
 * Mirrors the diagnostics summary: an OAuth-using server that is unauthenticated,
 * expired, or in an unknown auth state (an http-oauth server that has never
 * signed in reports `unknown`) needs sign-in. A `not-required` server never
 * does. */
function mcpNeedsAuth(server: HermesMcpServerInfo): boolean {
  if (server.transport === "stdio") return false;
  if (server.auth === "not-required") return false;
  const usesOauth =
    server.transport === "http-oauth" ||
    server.auth === "authenticated" ||
    server.auth === "unauthenticated" ||
    server.auth === "expired";
  if (!usesOauth) return false;
  return (
    server.auth === "unauthenticated" ||
    server.auth === "expired" ||
    server.auth === "unknown"
  );
}

/** Orders issues worst-first by status weight, then by the per-code order so the
 * list reads predictably within a severity band. */
function sortIssues(a: HealthIssue, b: HealthIssue): number {
  const weight = STATUS_WEIGHT[b.status] - STATUS_WEIGHT[a.status];
  if (weight !== 0) return weight;
  return CODE_ORDER[a.code] - CODE_ORDER[b.code];
}

/** The overall status is the most severe status across all issues, or `ready`
 * when there are none. */
function overallStatus(issues: readonly HealthIssue[]): HealthStatus {
  let status: HealthStatus = "ready";
  for (const issue of issues) {
    if (STATUS_WEIGHT[issue.status] > STATUS_WEIGHT[status]) {
      status = issue.status;
    }
  }
  return status;
}

/** Computes the per-area summary counts. */
function buildSummary(
  inputs: IntegrationsHealthInputs,
  restartPending: boolean,
  highRisk: ReadonlySet<string>,
): IntegrationsHealthSummary {
  const enabledSkills = inputs.skills.filter((skill) => skill.enabled);
  const skillsNeedingSetup = enabledSkills.filter(
    (skill) =>
      skill.badge?.status === "missing-api-key" ||
      skill.badge?.status === "missing-config",
  ).length;

  const enabledToolsets = inputs.toolsets.filter((toolset) => toolset.enabled);
  const toolsetsNeedingSetup = inputs.toolsets.filter(toolsetNeedsSetup).length;

  const dirsMissing = inputs.externalDirs.filter(dirIsMissing).length;
  const dirsUnreadable = inputs.externalDirs.filter(
    (dir) => dir.presence === "unreadable",
  ).length;

  const enabledHighRisk = inputs.mcpServers.filter(
    (server) => server.enabled && highRisk.has(server.name),
  ).length;

  return {
    skills: {
      total: inputs.skills.length,
      enabled: enabledSkills.length,
      needingSetup: skillsNeedingSetup,
    },
    toolsets: {
      total: inputs.toolsets.length,
      enabled: enabledToolsets.length,
      needingSetup: toolsetsNeedingSetup,
    },
    mcp: summarizeHealth(inputs.mcpServers, restartPending),
    secrets: {
      configured: inputs.secrets?.configured ?? 0,
      missing: inputs.secrets?.missing ?? 0,
    },
    pendingSkillWrites: inputs.pendingSkillWrites,
    externalDirs: {
      total: inputs.externalDirs.length,
      missing: dirsMissing,
      unreadable: dirsUnreadable,
    },
    highRiskMcp: enabledHighRisk,
  };
}

// ---------------------------------------------------------------------------
// Sanitized export
// ---------------------------------------------------------------------------

/** The version stamp of the health report schema. */
export const INTEGRATIONS_HEALTH_REPORT_VERSION = 1;

/** The sanitized health report a user exports for support. It carries the
 * overall status, the issue list (codes + safe copy), the per-area counts, and
 * the SECRET COUNTS only. No secret value, no env value, no token can appear:
 * the only secret data is numeric counts, and the whole structure is run through
 * the shared structural redactor as a backstop. */
export type IntegrationsHealthReport = {
  schemaVersion: number;
  generatedAt: string;
  mode: string;
  profile: string;
  status: HealthStatus;
  statusLabel: string;
  /** A clear statement of what the report does and does not contain. */
  notes: string[];
  model?: {
    id: string;
    name?: string;
    supportsTools?: boolean;
  };
  gateway: {
    state: GatewayLifecycleSnapshot["state"];
    label: string;
  };
  summary: IntegrationsHealthSummary;
  issues: Array<{
    code: HealthIssueCode;
    status: HealthIssue["status"];
    message: string;
    action: string;
    target: HealthTarget;
  }>;
};

/**
 * Builds a SANITIZED health report for export. Secrets appear ONLY as the
 * configured/missing counts already in the summary; no value is ever read here.
 * The structural redactor masks anything secret-shaped that slipped into a
 * status message or model name before the report leaves the machine.
 */
export function buildIntegrationsHealthReport(
  health: IntegrationsHealth,
  options: { now?: Date } = {},
): IntegrationsHealthReport {
  const now = options.now ?? new Date();

  // The text-bearing parts are the only place a credential-shaped string could
  // ride (a status message that echoed a token, a model name). Run JUST these
  // through the structural redactor. The numeric summary is counts by
  // construction and carries no value; it is attached AFTER redaction so the
  // redactor (which masks any object under a `secrets`-named key) cannot blank
  // the counts the report exists to show.
  const redactedText = redactForLog({
    model: health.model
      ? {
          id: health.model.id,
          name: health.model.name,
          supportsTools: health.model.supportsTools,
        }
      : undefined,
    gateway: {
      state: health.lifecycle.state,
      label: health.lifecycle.label,
    },
    issues: health.issues.map((issue) => ({
      code: issue.code,
      status: issue.status,
      // A subject name interpolated into a message (a model label, a server
      // name) is almost never a secret, but scrub a credential-shaped run inside
      // the prose defensively so a secret-shaped name cannot ride out in a
      // sentence the structural redactor would treat as ordinary copy.
      message: scrubFreeText(issue.message),
      action: issue.action,
      target: issue.target,
    })),
  }) as Pick<IntegrationsHealthReport, "model" | "gateway" | "issues">;

  return {
    schemaVersion: INTEGRATIONS_HEALTH_REPORT_VERSION,
    generatedAt: now.toISOString(),
    mode: health.mode ?? "sandboxed",
    profile: health.profile ?? "default",
    status: health.status,
    statusLabel: health.statusLabel,
    notes: [
      "Secrets are reported as configured and missing counts only. No secret value, env value, header value, or token is included.",
      "This report aggregates the state of skills, toolsets, MCP servers, the gateway, and the selected model.",
    ],
    model: redactedText.model,
    gateway: redactedText.gateway,
    summary: health.summary,
    issues: redactedText.issues,
  };
}

/** Masks a credential-shaped token embedded in a free-text message before it
 * leaves the machine in the report. Mirrors the diagnostics bundle's scrubber:
 * the structural redactor masks secret-keyed and bare credential-shaped values,
 * but a token printed inline in a sentence rides in prose, so this catches a
 * long, separator-free, alphanumeric run that is not a path/URL. */
function scrubFreeText(value: string): string {
  return value.replace(/\S+/g, (token) => {
    if (token.includes("/") || token.includes("\\") || token.includes("://")) {
      return token;
    }
    // Strip surrounding punctuation (parentheses, trailing period) so a token
    // wrapped like "(sk0123...)" is still recognized.
    const core = token.replace(/^[("']+|[)"'.,]+$/g, "");
    const isLongCredential =
      core.length >= 20 &&
      /^[A-Za-z0-9_-]+$/.test(core) &&
      /[0-9]/.test(core) &&
      /[A-Za-z]/.test(core);
    return isLongCredential ? token.replace(core, "[redacted]") : token;
  });
}

/** Serializes the report to a pretty JSON string for download. */
export function serializeIntegrationsHealthReport(
  report: IntegrationsHealthReport,
): string {
  return JSON.stringify(report, null, 2);
}

/** A stable, filesystem-safe filename for a downloaded report. */
export function integrationsHealthReportFilename(
  profile: string,
  now: Date = new Date(),
): string {
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const safeProfile = profile.replace(/[^a-zA-Z0-9_-]/g, "-");
  return `integrations-health-${safeProfile}-${stamp}.json`;
}
