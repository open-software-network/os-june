import { IconArrowInbox } from "central-icons/IconArrowInbox";
import { IconArrowRotateClockwise } from "central-icons/IconArrowRotateClockwise";
import { IconCircleCheck } from "central-icons/IconCircleCheck";
import { IconCircleInfo } from "central-icons/IconCircleInfo";
import { IconCircleX } from "central-icons/IconCircleX";
import { IconExclamationCircle } from "central-icons/IconExclamationCircle";
import { IconHeartBeat } from "central-icons/IconHeartBeat";
import {
  buildIntegrationsHealthReport,
  integrationsHealthReportFilename,
  serializeIntegrationsHealthReport,
  useIntegrationsHealth,
  type HealthIssue,
  type HealthTarget,
  type HealthTone,
  type IntegrationsHealth,
} from "../../lib/hermes-admin";
import type { HermesAdminMode } from "../../lib/hermes-admin";

/** The Settings tab a health issue links to. The {@link HealthTarget} union is a
 * subset of the AppSettings `SettingsTab` ids, so the mapping is the identity;
 * keeping it explicit documents the contract and gives the section a typed
 * navigate callback without importing the full tab type. */
export type IntegrationsHealthTarget = HealthTarget;

type IntegrationsHealthSectionProps = {
  /** The write-access mode whose runtime this dashboard reads. Defaults to the
   * safe sandboxed runtime; the host can point it at Full mode explicitly. */
  mode?: HermesAdminMode;
  /** Opens the Settings tab that fixes an issue. The host (the sidebar settings
   * nav) wires this to its tab switcher so an issue deep-links to its surface. */
  onNavigate?: (target: IntegrationsHealthTarget) => void;
};

/**
 * June's Unified Integrations Health dashboard (admin surfaces spec 22). It
 * aggregates readiness across the selected model, the gateway lifecycle,
 * installed skills + their setup, toolsets, MCP servers + diagnostics, pending
 * skill writes, secret counts, and external skill directories into one overall
 * status and a prioritized, deep-linking issue list. It reads every landed admin
 * surface and never mutates one. The exported report is sanitized: secrets are
 * counted, never revealed.
 */
export function IntegrationsHealthSection({
  mode = "sandboxed",
  onNavigate,
}: IntegrationsHealthSectionProps) {
  const health = useIntegrationsHealth(mode);
  return (
    <IntegrationsHealthView
      health={health}
      mode={mode}
      onNavigate={onNavigate}
    />
  );
}

/**
 * The render-only view, split out so component tests can drive it with a stubbed
 * {@link IntegrationsHealth} (no Tauri, no network) and assert the status badge,
 * the issue ordering, the deep-link targets, and the export wiring.
 */
export function IntegrationsHealthView({
  health,
  mode = "sandboxed",
  onNavigate,
}: {
  health: IntegrationsHealth;
  mode?: HermesAdminMode;
  onNavigate?: (target: IntegrationsHealthTarget) => void;
}) {
  const isUnavailable = health.unavailable;
  const hasIssues = health.issues.length > 0;

  return (
    <section
      className="settings-group integrations-health"
      aria-labelledby="integrations-health-heading"
    >
      <h2 id="integrations-health-heading" className="settings-group-heading">
        Integrations health
      </h2>
      <p className="settings-group-description">
        See whether June's agent is ready to work across your model, skills,
        toolsets, MCP servers, and gateway.{" "}
        <ModeNote
          mode={health.mode === "unrestricted" ? "unrestricted" : mode}
          profile={health.profile}
          show={!isUnavailable}
        />
      </p>

      <div className="settings-card integrations-health-card">
        {isUnavailable ? (
          <EmptyState
            title="Hermes is not running"
            description="Start Hermes to check whether your integrations are ready."
          />
        ) : (
          <>
            <Overview health={health} />
            {hasIssues ? (
              <ul className="integrations-health-issues">
                {health.issues.map((issue, index) => (
                  <IssueRow
                    key={`${issue.code}-${index}`}
                    issue={issue}
                    onNavigate={onNavigate}
                  />
                ))}
              </ul>
            ) : (
              <p className="integrations-health-clear" role="status">
                <IconCircleCheck size={14} ariaHidden />
                Everything is ready. No action needed.
              </p>
            )}
          </>
        )}
      </div>
    </section>
  );
}

/** The overall status badge, the per-area summary counts, and the export. */
function Overview({ health }: { health: IntegrationsHealth }) {
  return (
    <div className="integrations-health-overview">
      <div className="integrations-health-status" data-tone={health.tone}>
        <IconHeartBeat size={18} ariaHidden />
        <span className="integrations-health-status-label">
          {health.statusLabel}
        </span>
      </div>
      <SummaryCounts health={health} />
      <div className="integrations-health-actions">
        <ExportButton health={health} />
      </div>
    </div>
  );
}

/** The per-area readiness counts. */
function SummaryCounts({ health }: { health: IntegrationsHealth }) {
  const { summary, model } = health;
  return (
    <div
      className="integrations-health-counts"
      role="group"
      aria-label="Readiness summary"
    >
      <Count
        label="Model tools"
        value={
          model?.supportsTools === undefined
            ? "Unknown"
            : model.supportsTools
              ? "Supported"
              : "Unsupported"
        }
        tone={
          model?.supportsTools === undefined
            ? "neutral"
            : model.supportsTools
              ? "ok"
              : "error"
        }
      />
      <Count
        label="Skills enabled"
        value={`${summary.skills.enabled}/${summary.skills.total}`}
        tone={summary.skills.needingSetup > 0 ? "attention" : "ok"}
      />
      <Count
        label="Toolsets enabled"
        value={`${summary.toolsets.enabled}/${summary.toolsets.total}`}
        tone={summary.toolsets.needingSetup > 0 ? "attention" : "ok"}
      />
      <Count
        label="MCP enabled"
        value={`${summary.mcp.enabled}/${summary.mcp.total}`}
        tone={
          summary.mcp.failing > 0
            ? "error"
            : summary.mcp.authNeeded > 0
              ? "attention"
              : "ok"
        }
      />
      <Count
        label="Secrets configured"
        value={String(summary.secrets.configured)}
        tone={summary.secrets.missing > 0 ? "attention" : "ok"}
      />
      {summary.secrets.missing > 0 ? (
        <Count
          label="Secrets missing"
          value={String(summary.secrets.missing)}
          tone="attention"
        />
      ) : null}
      {summary.pendingSkillWrites > 0 ? (
        <Count
          label="Pending reviews"
          value={String(summary.pendingSkillWrites)}
          tone="attention"
        />
      ) : null}
      {summary.highRiskMcp > 0 ? (
        <Count
          label="High risk MCP"
          value={String(summary.highRiskMcp)}
          tone="error"
        />
      ) : null}
      {summary.externalDirs.total > 0 ? (
        <Count
          label="External dirs"
          value={String(summary.externalDirs.total)}
          tone={
            summary.externalDirs.missing > 0 ||
            summary.externalDirs.unreadable > 0
              ? "error"
              : "ok"
          }
        />
      ) : null}
    </div>
  );
}

function Count({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: "ok" | "neutral" | "error" | "attention";
}) {
  return (
    <span className="integrations-health-count" data-tone={tone}>
      <span className="integrations-health-count-value">{value}</span>
      <span className="integrations-health-count-label">{label}</span>
    </span>
  );
}

/** One issue row: the problem, the concrete fix, and a deep-link to its tab. */
function IssueRow({
  issue,
  onNavigate,
}: {
  issue: HealthIssue;
  onNavigate?: (target: IntegrationsHealthTarget) => void;
}) {
  return (
    <li className="integrations-health-issue" data-tone={issue.tone}>
      <IssueIcon tone={issue.tone} />
      <div className="integrations-health-issue-body">
        <span className="integrations-health-issue-message">
          {issue.message}
        </span>
        <span className="integrations-health-issue-action">{issue.action}</span>
      </div>
      <button
        type="button"
        className="integrations-health-issue-link"
        onClick={() => onNavigate?.(issue.target)}
        aria-label={`${issue.action} Open ${LINK_LABEL[issue.target]}.`}
      >
        {LINK_LABEL[issue.target]}
      </button>
    </li>
  );
}

/** The button copy for each fixing surface. Sentence case, no dashes. */
const LINK_LABEL: Readonly<Record<HealthTarget, string>> = Object.freeze({
  models: "Open models",
  skills: "Open installed skills",
  "skill-review": "Open pending changes",
  "external-dirs": "Open external directories",
  mcp: "Open MCP servers",
  "mcp-diagnostics": "Open MCP diagnostics",
  toolsets: "Open toolsets",
});

/** Builds the sanitized report and triggers a download. The report is already
 * redacted; this only serializes and saves it. */
function ExportButton({ health }: { health: IntegrationsHealth }) {
  function handleExport() {
    const now = new Date();
    const report = buildIntegrationsHealthReport(health, { now });
    const text = serializeIntegrationsHealthReport(report);
    const filename = integrationsHealthReportFilename(
      health.profile ?? "default",
      now,
    );
    downloadText(filename, text);
  }
  return (
    <button
      type="button"
      className="integrations-health-export"
      onClick={handleExport}
    >
      <IconArrowInbox size={14} ariaHidden />
      Export health report
    </button>
  );
}

/** The sandbox/full-mode + profile context line. */
function ModeNote({
  mode,
  profile,
  show,
}: {
  mode: HermesAdminMode;
  profile?: string;
  show: boolean;
}) {
  if (!show) return null;
  const modeLabel = mode === "unrestricted" ? "Full mode" : "Sandboxed";
  return (
    <span className="integrations-health-mode-note">
      Targeting the {modeLabel} runtime
      {profile ? ` (profile ${profile})` : ""}.
    </span>
  );
}

function IssueIcon({ tone }: { tone: HealthTone }) {
  if (tone === "error") return <IconCircleX size={14} ariaHidden />;
  if (tone === "attention")
    return <IconExclamationCircle size={14} ariaHidden />;
  return <IconCircleInfo size={14} ariaHidden />;
}

function EmptyState({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div className="integrations-health-empty" role="status">
      <span className="integrations-health-empty-icon" aria-hidden>
        <IconHeartBeat size={22} />
      </span>
      <p className="integrations-health-empty-title">{title}</p>
      <p className="integrations-health-empty-description">{description}</p>
    </div>
  );
}

/** Triggers a client-side download of a text file. Guarded so a non-browser
 * (test) environment is a no-op rather than a crash. */
function downloadText(filename: string, text: string): void {
  if (
    typeof document === "undefined" ||
    typeof URL === "undefined" ||
    typeof URL.createObjectURL !== "function"
  ) {
    return;
  }
  const blob = new Blob([text], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}
