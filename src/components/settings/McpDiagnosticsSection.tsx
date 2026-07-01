import { IconArrowInbox } from "central-icons/IconArrowInbox";
import { IconArrowRotateClockwise } from "central-icons/IconArrowRotateClockwise";
import { IconCircleCheck } from "central-icons/IconCircleCheck";
import { IconCircleInfo } from "central-icons/IconCircleInfo";
import { IconCircleX } from "central-icons/IconCircleX";
import { IconExclamationCircle } from "central-icons/IconExclamationCircle";
import { IconMagnifyingGlass } from "central-icons/IconMagnifyingGlass";
import { IconServer1 } from "central-icons/IconServer1";
import { useEffect, useMemo, useState } from "react";
import {
  authMeta,
  diagnosticBundleFilename,
  redactedEnv,
  redactedHeaders,
  serializeDiagnosticBundle,
  statusMeta,
  transportMeta,
  useMcpDiagnosticsController,
  useMcpServersEngine,
  type HermesAdminMode,
  type McpDiagnosticsState,
  type ServerDiagnostics,
} from "../../lib/hermes-admin";
import { hermesBridgeStatus, type HermesBridgeStatus } from "../../lib/tauri";
import { AdminNotifications } from "./AdminNotifications";

type McpDiagnosticsSectionProps = {
  /** The write-access mode whose runtime this page targets. Defaults to the safe
   * sandboxed runtime; the host can point it at Full mode explicitly. */
  mode?: HermesAdminMode;
};

/**
 * June's native MCP diagnostics page (spec 18). It explains, per server and for
 * the whole install, exactly why MCP-backed tools are or are not available to
 * the agent: enabled state, auth/token status, last test result, discovered
 * server-native tools (test-time discovery), the derived registered tool names,
 * the include/exclude policy and resulting allowed tools, resource/prompt
 * utility availability, missing config, timeouts, and a gateway-restart / stale
 * inventory warning.
 *
 * It reuses the spec-14 servers engine (one client, one cache, one lifecycle) so
 * a test here, a restart elsewhere, or a profile switch all stay consistent. It
 * never mutates a server beyond running its test probe. Secrets are never
 * surfaced, and the support export is sanitized through the shared redactor.
 */
export function McpDiagnosticsSection({
  mode = "sandboxed",
}: McpDiagnosticsSectionProps) {
  const [bridge, setBridge] = useState<HermesBridgeStatus>();
  const [bridgeError, setBridgeError] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    hermesBridgeStatus()
      .then((status) => {
        if (!cancelled) setBridge(status);
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setBridgeError(
            error instanceof Error ? error.message : String(error),
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const engine = useMcpServersEngine(bridge, mode);
  const base = useMcpDiagnosticsController(engine);
  const state: McpDiagnosticsState =
    engine === null && bridgeError
      ? { ...base, status: "error", error: bridgeError, retryable: true }
      : base;

  return <McpDiagnosticsView state={state} mode={mode} />;
}

/**
 * The render-only view, split out so component tests can drive it with a stubbed
 * {@link McpDiagnosticsState} (no Tauri, no network) and assert the summary,
 * the per-server diagnostics, the reason chain, and the export wiring.
 */
export function McpDiagnosticsView({
  state,
  mode = "sandboxed",
}: {
  state: McpDiagnosticsState;
  mode?: HermesAdminMode;
}) {
  const isUnavailable = state.status === "unavailable";
  const isErrored = state.status === "error";
  const isLoadingFirst = state.status === "loading";
  const hasServers = state.servers.length > 0;

  return (
    <section
      className="settings-group mcp-diagnostics"
      aria-labelledby="mcp-diagnostics-heading"
    >
      <h2 id="mcp-diagnostics-heading" className="settings-group-heading">
        MCP diagnostics
      </h2>
      <p className="settings-group-description">
        See exactly why MCP tools are or are not available to your sessions.{" "}
        <ModeNote
          mode={state.mode ?? mode}
          profile={state.profile}
          show={!isUnavailable}
        />
      </p>

      {!isUnavailable && state.restartPending ? (
        <div
          className="mcp-diagnostics-stale"
          data-tone="warning"
          role="status"
        >
          <span className="mcp-diagnostics-stale-eyebrow">
            <IconCircleInfo size={15} ariaHidden />
            Restart required
          </span>
          <span className="mcp-diagnostics-stale-body">
            This shows the last known tool inventory. Restart the Hermes gateway
            to rebuild it with your latest changes.
          </span>
        </div>
      ) : null}

      <AdminNotifications
        notifications={state.notifications}
        onDismiss={state.dismissNotification}
      />

      {!isUnavailable && !isErrored && hasServers ? (
        <SummaryBar state={state} />
      ) : null}

      <div className="settings-card mcp-diagnostics-card">
        {isUnavailable ? (
          <EmptyState
            title="Hermes is not running"
            description="Start Hermes to diagnose the MCP servers your sessions can use."
          />
        ) : isErrored ? (
          <ErrorState
            message={state.error ?? "Could not load MCP servers from Hermes."}
            retryable={state.retryable}
            onRetry={state.refresh}
          />
        ) : isLoadingFirst ? (
          <Loading />
        ) : !hasServers ? (
          <EmptyState
            title="No MCP servers"
            description="Add a server on the MCP servers page to diagnose its tools here."
          />
        ) : (
          <>
            <ReasonChain state={state} />
            <ul className="mcp-diagnostics-list">
              {state.servers.map((diagnostics) => (
                <DiagnosticsRow
                  key={diagnostics.server.name}
                  diagnostics={diagnostics}
                  testing={state.testing.has(diagnostics.server.name)}
                  onTest={() => state.test(diagnostics.server.name)}
                />
              ))}
            </ul>
          </>
        )}
      </div>
    </section>
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
    <span className="mcp-diagnostics-mode-note">
      Targeting the {modeLabel} runtime
      {profile ? ` (profile ${profile})` : ""}.
    </span>
  );
}

/** The global health summary, run-all-tests, and sanitized export. */
function SummaryBar({ state }: { state: McpDiagnosticsState }) {
  const { summary } = state;
  return (
    <div
      className="mcp-diagnostics-summary"
      role="group"
      aria-label="MCP health"
    >
      <div className="mcp-diagnostics-counts">
        <Count label="Enabled" value={summary.enabled} tone="ok" />
        <Count label="Disabled" value={summary.disabled} tone="neutral" />
        <Count label="Failing" value={summary.failing} tone="error" />
        <Count
          label="Auth needed"
          value={summary.authNeeded}
          tone="attention"
        />
        {summary.restartPending ? (
          <Count label="Restart pending" value={1} tone="attention" />
        ) : null}
      </div>
      <div className="mcp-diagnostics-actions">
        <button
          type="button"
          className="mcp-diagnostics-run-all"
          disabled={state.runningAll || summary.total === 0}
          onClick={() => void state.runAllTests()}
        >
          <IconArrowRotateClockwise size={14} ariaHidden />
          {state.runningAll ? "Running tests" : "Run all MCP tests"}
        </button>
        <ExportButton state={state} />
      </div>
    </div>
  );
}

function Count({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "ok" | "neutral" | "error" | "attention";
}) {
  return (
    <span className="mcp-diagnostics-count" data-tone={tone}>
      <span className="mcp-diagnostics-count-value">{value}</span>
      <span className="mcp-diagnostics-count-label">{label}</span>
    </span>
  );
}

/** Builds the sanitized bundle and triggers a download. The bundle is already
 * redacted; this only serializes and saves it. */
function ExportButton({ state }: { state: McpDiagnosticsState }) {
  function handleExport() {
    const now = new Date();
    const bundle = state.buildBundle(now);
    const text = serializeDiagnosticBundle(bundle);
    const filename = diagnosticBundleFilename(state.profile ?? "default", now);
    downloadText(filename, text);
  }
  return (
    <button
      type="button"
      className="mcp-diagnostics-export"
      disabled={state.summary.total === 0}
      onClick={handleExport}
    >
      <IconArrowInbox size={14} ariaHidden />
      Export diagnostics
    </button>
  );
}

/** The missing-tool reason-chain lookup. The user types a tool name (registered
 * `mcp_<server>_<tool>` or native) and June explains its availability. */
function ReasonChain({ state }: { state: McpDiagnosticsState }) {
  const reason = state.toolReason;
  return (
    <div className="mcp-diagnostics-reason">
      <label className="mcp-diagnostics-reason-label" htmlFor="mcp-tool-query">
        Why is a tool missing?
      </label>
      <div className="mcp-diagnostics-reason-search">
        <IconMagnifyingGlass
          size={15}
          ariaHidden
          className="mcp-diagnostics-reason-icon"
        />
        <input
          id="mcp-tool-query"
          type="search"
          value={state.toolQuery}
          placeholder="mcp_linear_delete_workspace"
          aria-label="Tool name to diagnose"
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => state.setToolQuery(event.currentTarget.value)}
        />
      </div>
      {reason ? (
        <p
          className="mcp-diagnostics-reason-result"
          data-available={reason.available}
          role="status"
        >
          {reason.available ? (
            <IconCircleCheck size={14} ariaHidden />
          ) : (
            <IconExclamationCircle size={14} ariaHidden />
          )}
          {reason.available
            ? `${reason.query} is available to your sessions.`
            : reason.reason}
        </p>
      ) : null}
    </div>
  );
}

/** One server's diagnostics card. */
function DiagnosticsRow({
  diagnostics,
  testing,
  onTest,
}: {
  diagnostics: ServerDiagnostics;
  testing: boolean;
  onTest: () => void;
}) {
  const { server, policy } = diagnostics;
  const transport = transportMeta(server.transport);
  const auth = authMeta(server.auth);
  const status = statusMeta(server.status);
  const env = redactedEnv(server);
  const headers = redactedHeaders(server);

  return (
    <li className="mcp-diagnostics-row" data-enabled={server.enabled}>
      <div className="mcp-diagnostics-row-head">
        <span className="mcp-diagnostics-name">{server.name}</span>
        <span className="mcp-diagnostics-transport" data-risk={transport.risk}>
          {transport.label}
        </span>
        <span className="mcp-diagnostics-state" data-enabled={server.enabled}>
          {server.enabled ? "Enabled" : "Disabled"}
        </span>
        {server.auth !== "not-required" ? (
          <span className="mcp-diagnostics-auth" data-tone={auth.tone}>
            {auth.label}
          </span>
        ) : null}
        <span className="mcp-diagnostics-status" data-tone={status.tone}>
          {status.label}
        </span>
        <button
          type="button"
          className="mcp-diagnostics-test"
          disabled={testing}
          onClick={onTest}
        >
          {testing ? "Testing" : "Test"}
        </button>
      </div>

      {diagnostics.issues.length > 0 ? (
        <ul className="mcp-diagnostics-issues">
          {diagnostics.issues.map((issue) => (
            <li
              key={issue.code}
              className="mcp-diagnostics-issue"
              data-tone={issue.tone}
            >
              <IssueIcon tone={issue.tone} />
              <span className="mcp-diagnostics-issue-message">
                {issue.message}
              </span>
              <span className="mcp-diagnostics-issue-fix">{issue.fix}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mcp-diagnostics-healthy" role="status">
          <IconCircleCheck size={13} ariaHidden />
          No problems found. Its tools register after the gateway restarts.
        </p>
      )}

      <dl className="mcp-diagnostics-facts">
        <Fact label="Connection">
          {server.transport === "stdio"
            ? (server.command ?? "No command configured.")
            : (server.url ?? "No URL configured.")}
        </Fact>
        {server.statusMessage ? (
          <Fact label="Last test">{server.statusMessage}</Fact>
        ) : null}
        <Fact label="Discovered tools">
          {diagnostics.discoveredTools.length > 0
            ? `${diagnostics.discoveredTools
                .map((tool) => tool.name)
                .join(", ")} (${
                diagnostics.discoveredFromTest
                  ? "from last test"
                  : "from stored config"
              })`
            : "None reported. Run a test to discover them."}
        </Fact>
        <Fact label="Registered tool names (derived)">
          {diagnostics.derivedRegisteredTools.length > 0
            ? diagnostics.derivedRegisteredTools.join(", ")
            : "None. Nothing registers in the current state."}
        </Fact>
        <Fact label="Tool filtering">
          <FilterSummary diagnostics={diagnostics} />
        </Fact>
        {policy.allowed.length > 0 || policy.tools.length > 0 ? (
          <Fact label="Allowed tools">
            {policy.allowed.length > 0
              ? policy.allowed.join(", ")
              : "None. Filtering hides every tool."}
          </Fact>
        ) : null}
        <Fact label="Resource and prompt utilities">
          {formatUtilities(
            diagnostics.resourcesAvailable,
            diagnostics.promptsAvailable,
          )}
        </Fact>
        {diagnostics.timeoutSeconds !== undefined ||
        diagnostics.connectTimeoutSeconds !== undefined ? (
          <Fact label="Timeouts">
            {formatTimeouts(
              diagnostics.timeoutSeconds,
              diagnostics.connectTimeoutSeconds,
            )}
          </Fact>
        ) : null}
        {diagnostics.missingEnv.length > 0 ||
        diagnostics.missingHeaders.length > 0 ? (
          <Fact label="Missing values">
            {[...diagnostics.missingEnv, ...diagnostics.missingHeaders].join(
              ", ",
            )}
          </Fact>
        ) : null}
        {env.length > 0 || headers.length > 0 ? (
          <Fact label="Configured secrets">
            {[
              env.length > 0 ? `${env.length} environment` : null,
              headers.length > 0 ? `${headers.length} headers` : null,
            ]
              .filter(Boolean)
              .join(", ")}{" "}
            (values hidden)
          </Fact>
        ) : null}
      </dl>
    </li>
  );
}

function FilterSummary({ diagnostics }: { diagnostics: ServerDiagnostics }) {
  const { policy } = diagnostics;
  if (policy.include.length === 0 && policy.exclude.length === 0) {
    return <>No filters. Every discovered tool is allowed.</>;
  }
  const parts: string[] = [];
  if (policy.include.length > 0) {
    parts.push(`Include only: ${policy.include.join(", ")}`);
  }
  if (policy.exclude.length > 0) {
    parts.push(`Exclude: ${policy.exclude.join(", ")}`);
  }
  return <>{parts.join(". ")}.</>;
}

function Fact({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mcp-diagnostics-fact">
      <dt className="mcp-diagnostics-fact-label">{label}</dt>
      <dd className="mcp-diagnostics-fact-value">{children}</dd>
    </div>
  );
}

function IssueIcon({ tone }: { tone: "error" | "attention" | "neutral" }) {
  if (tone === "error") return <IconCircleX size={13} ariaHidden />;
  if (tone === "attention")
    return <IconExclamationCircle size={13} ariaHidden />;
  return <IconCircleInfo size={13} ariaHidden />;
}

/** Sentence-case rendering of resource/prompt availability, with unknown when
 * upstream is silent (June never guesses). */
function formatUtilities(
  resources: boolean | undefined,
  prompts: boolean | undefined,
): string {
  const resourceLabel =
    resources === undefined
      ? "resources unknown"
      : resources
        ? "resources available"
        : "resources not available";
  const promptLabel =
    prompts === undefined
      ? "prompts unknown"
      : prompts
        ? "prompts available"
        : "prompts not available";
  return `${capitalize(resourceLabel)}, ${promptLabel}.`;
}

function formatTimeouts(
  timeout: number | undefined,
  connect: number | undefined,
): string {
  const parts: string[] = [];
  if (timeout !== undefined) parts.push(`request ${timeout}s`);
  if (connect !== undefined) parts.push(`connect ${connect}s`);
  return parts.length > 0 ? capitalize(parts.join(", ")) + "." : "Not set.";
}

function capitalize(value: string): string {
  return value.length > 0 ? value[0].toUpperCase() + value.slice(1) : value;
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

// ---------------------------------------------------------------------------
// Shared empty / error / loading surfaces
// ---------------------------------------------------------------------------

function Loading() {
  return (
    <ul className="mcp-diagnostics-list" aria-hidden>
      {[0, 1].map((index) => (
        <li
          key={index}
          className="mcp-diagnostics-row mcp-diagnostics-skeleton"
        >
          <span className="mcp-diagnostics-skeleton-line mcp-diagnostics-skeleton-title" />
          <span className="mcp-diagnostics-skeleton-line" />
        </li>
      ))}
    </ul>
  );
}

function EmptyState({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div className="mcp-diagnostics-empty" role="status">
      <span className="mcp-diagnostics-empty-icon" aria-hidden>
        <IconServer1 size={22} />
      </span>
      <p className="mcp-diagnostics-empty-title">{title}</p>
      <p className="mcp-diagnostics-empty-description">{description}</p>
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
    <div className="mcp-diagnostics-error" role="alert">
      <span className="mcp-diagnostics-empty-icon" aria-hidden>
        <IconExclamationCircle size={22} />
      </span>
      <p className="mcp-diagnostics-empty-title">Couldn't load MCP servers</p>
      <p className="mcp-diagnostics-empty-description">{message}</p>
      {retryable ? (
        <button
          type="button"
          className="mcp-diagnostics-retry"
          onClick={onRetry}
        >
          Try again
        </button>
      ) : null}
    </div>
  );
}
