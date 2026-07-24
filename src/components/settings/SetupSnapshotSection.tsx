import { IconArrowInbox } from "central-icons/IconArrowInbox";
import { IconArrowOutOfBox } from "central-icons/IconArrowOutOfBox";
import { IconBox2 } from "central-icons/IconBox2";
import { IconCircleCheck } from "central-icons/IconCircleCheck";
import { IconCircleInfo } from "central-icons/IconCircleInfo";
import { IconCircleX } from "central-icons/IconCircleX";
import { IconExclamationCircle } from "central-icons/IconExclamationCircle";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  adminTargetForMode,
  createMcpServersEngine,
  requiredSecretId,
  restartHermesRuntime,
  useMcpServersEngine,
  useSetupSnapshotController,
  type DiffEntry,
  type HermesAdminMode,
  type ImportReport,
  type ImportPlanStep,
  type ImportStepResult,
  type SetupSnapshotState,
  type SnapshotRequiredSecret,
} from "../../lib/hermes-admin";
import { hermesBridgeStatus, type HermesBridgeStatus } from "../../lib/tauri";
import { SettingsPageHeader } from "./AppSettings";
import { useConfirmedSettingsProfile } from "./useConfirmedSettingsProfile";

type SetupSnapshotSectionProps = {
  /** The write-access mode whose runtime this page targets. Defaults to the safe
   * sandboxed runtime; the host can point it at Full mode explicitly. */
  mode?: HermesAdminMode;
};

/**
 * June's native setup import/export page (spec 23). It exports a SANITIZED
 * snapshot of the install (profiles, skills, hub installs, MCP servers and
 * filters, toolset readiness) with every secret reduced to a key name, and it
 * imports a snapshot through an ordered, safe flow: preview, diff, ask for the
 * missing secrets, install in safe order, restart, and health check, reporting
 * partial failures.
 *
 * It reuses the spec-14 servers engine (one client, one cache, one lifecycle) so
 * targeting stays explicit and a change elsewhere stays consistent. Secrets are
 * never read into the export and never imported from a file.
 */
export function SetupSnapshotSection({ mode = "sandboxed" }: SetupSnapshotSectionProps) {
  const activeProfile = useConfirmedSettingsProfile(mode);
  if (activeProfile.pending) {
    return <SetupSnapshotView state={PENDING_SETUP_SNAPSHOT_STATE} mode={mode} />;
  }
  return <SetupSnapshotSectionReady mode={mode} profile={activeProfile.name} />;
}

function SetupSnapshotSectionReady({
  mode,
  profile,
}: SetupSnapshotSectionProps & { mode: HermesAdminMode; profile: string }) {
  const [bridge, setBridge] = useState<HermesBridgeStatus>();
  const [bridgeError, setBridgeError] = useState<string>();
  const [bridgeAttempt, setBridgeAttempt] = useState(0);

  useEffect(() => {
    const requestedAttempt = bridgeAttempt;
    let cancelled = false;
    hermesBridgeStatus()
      .then((status) => {
        if (!cancelled && requestedAttempt === bridgeAttempt) {
          setBridge(status);
          setBridgeError(undefined);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setBridgeError(error instanceof Error ? error.message : String(error));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [bridgeAttempt]);

  const retryBridge = useCallback(() => {
    setBridge(undefined);
    setBridgeError(undefined);
    setBridgeAttempt((attempt) => attempt + 1);
  }, []);

  const restartRuntime = useCallback(async () => {
    try {
      const status = await restartHermesRuntime(mode);
      setBridge(status);
      const target = adminTargetForMode(status, mode, profile);
      if (!target) throw new Error("The restarted runtime did not become available.");
      return createMcpServersEngine(target).client;
    } catch (error) {
      // The stop may have landed even if the start failed. Reconcile the page
      // with native reality instead of retaining a dead client.
      try {
        setBridge(await hermesBridgeStatus());
      } catch {
        setBridge(undefined);
      }
      throw error;
    }
  }, [mode, profile]);

  const applyOptions = useMemo(() => ({ restartRuntime }), [restartRuntime]);

  const engine = useMcpServersEngine(bridge, mode, profile);
  const base = useSetupSnapshotController(engine, applyOptions);
  const state: SetupSnapshotState =
    engine === null && bridgeError
      ? {
          ...base,
          status: "error",
          error: bridgeError,
          retryable: true,
          refresh: retryBridge,
        }
      : base;

  return <SetupSnapshotView state={state} mode={mode} />;
}

const PENDING_SETUP_SNAPSHOT_STATE: SetupSnapshotState = {
  status: "loading",
  retryable: false,
  lifecycle: {
    state: "clean",
    label: "Up to date",
    detail: "No pending changes.",
    canRestart: false,
  },
  canExport: false,
  includeSkillConfig: false,
  setIncludeSkillConfig: () => {},
  refresh: () => {},
  buildExport: () => ({
    snapshot: {
      schemaVersion: 1,
      generatedAt: new Date(0).toISOString(),
      profile: "default",
      mode: "sandboxed",
      notes: [],
      profiles: [],
      skills: [],
      mcpServers: [],
      catalogInstalls: [],
      toolFilters: [],
      requiredInputs: [],
      readiness: { toolsets: [] },
    },
    text: "{}",
    filename: "june-setup.json",
  }),
  importPhase: "idle",
  preview: () => {},
  apply: async () => {},
  resetImport: () => {},
};

/**
 * The render-only view, split out so component tests can drive it with a stubbed
 * {@link SetupSnapshotState} (no Tauri, no network) and assert the export
 * wiring, the import preview diff, the secret prompts, and the failure report.
 */
export function SetupSnapshotView({
  state,
  mode = "sandboxed",
}: {
  state: SetupSnapshotState;
  mode?: HermesAdminMode;
}) {
  const isUnavailable = state.status === "unavailable";
  const isErrored = state.status === "error";

  return (
    <section className="settings-group setup-snapshot" aria-labelledby="setup-snapshot-heading">
      <SettingsPageHeader
        id="setup-snapshot-heading"
        title="Import / export"
        blurb={
          <>
            Move a sanitized copy of the active profile's agent setup between June installs. This
            does not export Notes or other June data. Secret values are never included.{" "}
            <ModeNote mode={state.mode ?? mode} profile={state.profile} show={!isUnavailable} />
          </>
        }
      />

      {isUnavailable ? (
        <div className="settings-card setup-snapshot-card">
          <EmptyState
            title="Agent setup is unavailable"
            description="Start June's agent runtime to export or import a setup snapshot."
          />
        </div>
      ) : isErrored ? (
        <div className="settings-card setup-snapshot-card">
          <ErrorState
            message={state.error ?? "Could not load your setup from the agent runtime."}
            retryable={state.retryable}
            onRetry={state.refresh}
          />
        </div>
      ) : (
        <>
          <ExportCard state={state} />
          <ImportCard state={state} />
        </>
      )}
    </section>
  );
}

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
    <span className="setup-snapshot-mode-note">
      Targeting the {modeLabel} runtime
      {profile ? ` (profile ${profile})` : ""}.
    </span>
  );
}

/** The export half: opt into config capture, then download the sanitized
 * snapshot. The bundle is already redacted; this only serializes and saves it. */
function ExportCard({ state }: { state: SetupSnapshotState }) {
  function handleExport() {
    const bundle = state.buildExport(new Date());
    downloadText(bundle.filename, bundle.text);
  }
  return (
    <div className="settings-card setup-snapshot-card setup-snapshot-export">
      <h3 className="setup-snapshot-card-title">
        <IconArrowOutOfBox size={16} ariaHidden />
        Export
      </h3>
      <p className="setup-snapshot-card-body">
        Saves a JSON snapshot of skills, non-secret skill config you opt into, complete MCP
        connection definitions, tool filters, toolset toggles, and external skill directory paths.
      </p>
      <p className="setup-snapshot-exclusions">
        Not included: Notes, Projects, sessions, filing, completion, memories, preferences, profile
        instructions, or secret values.
      </p>
      <label className="setup-snapshot-opt">
        <input
          type="checkbox"
          checked={state.includeSkillConfig}
          onChange={(event) => state.setIncludeSkillConfig(event.currentTarget.checked)}
        />
        <span>
          Include non-secret skill config values. Secret-shaped values are still excluded.
        </span>
      </label>
      <button
        type="button"
        className="primary-action primary-solid setup-snapshot-export-button"
        disabled={!state.canExport}
        onClick={handleExport}
      >
        <IconArrowOutOfBox size={14} ariaHidden />
        Export snapshot
      </button>
    </div>
  );
}

/** The import half: paste/open a snapshot, preview the diff, supply the missing
 * secrets, then apply. */
function ImportCard({ state }: { state: SetupSnapshotState }) {
  const [raw, setRaw] = useState("");
  const [previewKey, setPreviewKey] = useState(0);
  const phase = state.importPhase;

  return (
    <div className="settings-card setup-snapshot-card setup-snapshot-import">
      <h3 className="setup-snapshot-card-title">
        <IconArrowInbox size={16} ariaHidden />
        Import
      </h3>
      <p className="setup-snapshot-card-body">
        Paste a snapshot to preview what it would change before applying. Importing never deletes
        your current skills or servers, and never reads secrets from the file.
      </p>

      <label className="setup-snapshot-paste-label" htmlFor="setup-snapshot-raw">
        Snapshot JSON
      </label>
      <textarea
        id="setup-snapshot-raw"
        className="setup-snapshot-paste"
        value={raw}
        spellCheck={false}
        rows={5}
        placeholder='{ "schemaVersion": 1, ... }'
        onChange={(event) => setRaw(event.currentTarget.value)}
      />
      <div className="setup-snapshot-import-actions">
        <button
          type="button"
          className="primary-action primary-solid setup-snapshot-preview-button"
          disabled={raw.trim().length === 0 || phase === "applying"}
          onClick={() => {
            setPreviewKey((key) => key + 1);
            state.preview(raw);
          }}
        >
          Preview import
        </button>
        {phase !== "idle" ? (
          <button
            type="button"
            className="primary-action setup-snapshot-reset-button"
            onClick={() => {
              setRaw("");
              state.resetImport();
            }}
          >
            Clear
          </button>
        ) : null}
      </div>

      {state.importError ? (
        <p className="setup-snapshot-import-error" role="alert">
          <IconCircleX size={14} ariaHidden />
          {state.importError}
        </p>
      ) : null}

      {phase === "previewed" || phase === "applying" ? (
        <ImportPreview key={previewKey} state={state} />
      ) : null}

      {phase === "applied" && state.report ? <ImportReportView report={state.report} /> : null}
    </div>
  );
}

/** The diff preview plus the secret prompts, gated behind the apply button. */
function ImportPreview({ state }: { state: SetupSnapshotState }) {
  const diff = state.previewDiff;
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [confirmedProfileMismatch, setConfirmedProfileMismatch] = useState(false);

  if (!diff) return null;

  const planChanges = state.previewPlan?.steps.filter((step) => step.disposition !== "skip");
  const changing = diff.entries.filter((entry) => entry.status !== "unchanged");
  const sourceProfile = state.previewSnapshot?.profile ?? "default";
  const targetProfile = state.profile ?? "default";
  const profileMismatch = sourceProfile !== targetProfile;

  return (
    <div className="setup-snapshot-preview">
      <p className="setup-snapshot-preview-summary" role="status">
        <IconCircleInfo size={14} ariaHidden />
        {diff.changeCount === 0
          ? "This snapshot matches your current setup. Nothing to apply."
          : `This import plan has ${diff.changeCount} ${
              diff.changeCount === 1 ? "step" : "steps"
            } to apply or review.`}
      </p>

      {planChanges && planChanges.length > 0 ? (
        <ul className="setup-snapshot-diff">
          {planChanges.map((step) => (
            <PlanRow
              key={`${step.category}:${step.name}:${step.disposition}:${step.detail}`}
              step={step}
            />
          ))}
        </ul>
      ) : changing.length > 0 ? (
        <ul className="setup-snapshot-diff">
          {changing.map((entry) => (
            <DiffRow key={`${entry.category}:${entry.name}`} entry={entry} />
          ))}
        </ul>
      ) : null}

      {profileMismatch ? (
        <label className="setup-snapshot-profile-confirm">
          <input
            type="checkbox"
            checked={confirmedProfileMismatch}
            onChange={(event) => setConfirmedProfileMismatch(event.currentTarget.checked)}
          />
          <span>
            This snapshot came from profile {sourceProfile}. Apply it to the active profile{" "}
            {targetProfile}.
          </span>
        </label>
      ) : null}

      {diff.requiredSecrets.length > 0 ? (
        <SecretPrompts
          secrets={diff.requiredSecrets}
          values={secrets}
          onChange={(id, value) => setSecrets((prev) => ({ ...prev, [id]: value }))}
        />
      ) : null}

      <button
        type="button"
        className="primary-action primary-solid setup-snapshot-apply-button"
        disabled={
          state.importPhase === "applying" ||
          diff.changeCount === 0 ||
          (profileMismatch && !confirmedProfileMismatch)
        }
        onClick={() => void state.apply(secrets)}
      >
        {state.importPhase === "applying" ? "Applying import" : "Apply import"}
      </button>
    </div>
  );
}

function PlanRow({ step }: { step: ImportPlanStep }) {
  return (
    <li className="setup-snapshot-diff-row" data-status={step.disposition}>
      <span className="setup-snapshot-diff-status">{step.disposition}</span>
      <span className="setup-snapshot-diff-name">{step.name}</span>
      <span className="setup-snapshot-diff-detail">{step.detail}</span>
    </li>
  );
}

function DiffRow({ entry }: { entry: DiffEntry }) {
  return (
    <li className="setup-snapshot-diff-row" data-status={entry.status}>
      <span className="setup-snapshot-diff-status">{entry.status}</span>
      <span className="setup-snapshot-diff-name">{entry.name}</span>
      <span className="setup-snapshot-diff-detail">{entry.detail}</span>
    </li>
  );
}

/** Prompts for the secrets an import needs. Values are typed here and passed to
 * apply; they never come from the snapshot file. */
function SecretPrompts({
  secrets,
  values,
  onChange,
}: {
  secrets: readonly SnapshotRequiredSecret[];
  values: Record<string, string>;
  onChange: (id: string, value: string) => void;
}) {
  return (
    <div className="setup-snapshot-secrets">
      <p className="setup-snapshot-secrets-note">
        This snapshot needs secret values it does not carry. Enter the ones you want to apply now.
        Leave a value blank to configure it later.
      </p>
      <ul className="setup-snapshot-secrets-list">
        {secrets.map((secret) => {
          const id = requiredSecretId(secret);
          return (
            <li key={id} className="setup-snapshot-secret">
              <label className="setup-snapshot-secret-label" htmlFor={`secret-${id}`}>
                {secret.owner} · {secret.key}
              </label>
              <input
                id={`secret-${id}`}
                type="password"
                autoComplete="off"
                className="setup-snapshot-secret-input"
                value={values[id] ?? ""}
                placeholder="Leave blank to set later"
                onChange={(event) => onChange(id, event.currentTarget.value)}
              />
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** The post-apply report: every step and its outcome, with partial failures
 * called out so the user knows what to retry. */
function ImportReportView({ report }: { report: ImportReport }) {
  return (
    <div className="setup-snapshot-report" role="status">
      <p className="setup-snapshot-report-summary">
        {report.hadFailures ? (
          <>
            <IconExclamationCircle size={14} ariaHidden />
            Import finished with issues. Review failed or unsupported steps below.
          </>
        ) : (
          <>
            <IconCircleCheck size={14} ariaHidden />
            Import applied. {report.restarted ? "The agent runtime restarted to apply it." : ""}
          </>
        )}
      </p>
      {report.health ? (
        <p className="setup-snapshot-report-health">
          {report.health.gatewayRunning === false
            ? "The agent runtime is not running. Start it to use the imported setup."
            : `The agent runtime is running with ${report.health.enabledServers} of ${report.health.serverCount} servers enabled.`}
        </p>
      ) : null}
      <ul className="setup-snapshot-report-steps">
        {report.steps.map((step) => (
          <ReportStepRow
            key={`${step.category}:${step.name}:${step.status}:${step.detail}`}
            step={step}
          />
        ))}
      </ul>
    </div>
  );
}

function ReportStepRow({ step }: { step: ImportStepResult }) {
  return (
    <li className="setup-snapshot-report-step" data-status={step.status}>
      <StepIcon status={step.status} />
      <span className="setup-snapshot-report-step-name">{step.name}</span>
      <span className="setup-snapshot-report-step-detail">{step.detail}</span>
    </li>
  );
}

function StepIcon({ status }: { status: ImportStepResult["status"] }) {
  if (status === "applied") return <IconCircleCheck size={13} ariaHidden />;
  if (status === "failed") return <IconCircleX size={13} ariaHidden />;
  return <IconCircleInfo size={13} ariaHidden />;
}

// ---------------------------------------------------------------------------
// Shared empty / error surfaces
// ---------------------------------------------------------------------------

function EmptyState({ title, description }: { title: string; description: string }) {
  return (
    <div className="setup-snapshot-empty" role="status">
      <span className="setup-snapshot-empty-icon" aria-hidden>
        <IconBox2 size={22} />
      </span>
      <p className="setup-snapshot-empty-title">{title}</p>
      <p className="setup-snapshot-empty-description">{description}</p>
    </div>
  );
}

function ErrorState({
  message,
  retryable,
  onRetry,
}: {
  message: string;
  retryable: boolean;
  onRetry: () => void;
}) {
  return (
    <div className="setup-snapshot-error" role="alert">
      <span className="setup-snapshot-empty-icon" aria-hidden>
        <IconExclamationCircle size={22} />
      </span>
      <p className="setup-snapshot-empty-title">Couldn't load your setup</p>
      <p className="setup-snapshot-empty-description">{message}</p>
      {retryable ? (
        <button type="button" className="primary-action setup-snapshot-retry" onClick={onRetry}>
          Try again
        </button>
      ) : null}
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
