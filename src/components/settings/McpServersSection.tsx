import { IconArrowRotateClockwise } from "central-icons/IconArrowRotateClockwise";
import { IconCircleCheck } from "central-icons/IconCircleCheck";
import { IconCircleInfo } from "central-icons/IconCircleInfo";
import { IconCircleX } from "central-icons/IconCircleX";
import { IconCloud } from "central-icons/IconCloud";
import { IconCrossSmall } from "central-icons/IconCrossSmall";
import { IconEditSmall1 } from "central-icons/IconEditSmall1";
import { IconExclamationCircle } from "central-icons/IconExclamationCircle";
import { IconArrowUpRight } from "central-icons/IconArrowUpRight";
import { IconFilter2 } from "central-icons/IconFilter2";
import { IconKey1 } from "central-icons/IconKey1";
import { IconMagnifyingGlass } from "central-icons/IconMagnifyingGlass";
import { IconPlusMedium } from "central-icons/IconPlusMedium";
import { IconServer1 } from "central-icons/IconServer1";
import { IconShield } from "central-icons/IconShield";
import { IconTrashCan } from "central-icons/IconTrashCan";
import { useEffect, useId, useMemo, useState } from "react";
import {
  ALLOWLIST_RECOMMENDATION,
  authMeta,
  canEditServer,
  classifyServerRisk,
  editFromServer,
  enableConfirmationFor,
  filterServers,
  hasAvailableTools,
  inlineSecurityLabels,
  isLocalSubprocess,
  oauthNeedFromMessage,
  oauthStateFor,
  oauthStatusMeta,
  planServerEdit,
  redactedEnv,
  redactedHeaders,
  securityLabelsFor,
  serverArgs,
  statusMeta,
  transportMeta,
  useMcpFilteringController,
  useMcpOauthController,
  useMcpServersEngine,
  usesOauth,
  validateDraft,
  type HermesAdminMode,
  type HermesMcpServerInfo,
  type McpEditWrite,
  type McpFilteringState,
  type McpOauthLoginState,
  type McpOauthState,
  type McpServerDraft,
  type McpServersState,
  type McpTestState,
  type ToolPolicyDraft,
} from "../../lib/hermes-admin";
import {
  hermesBridgeStatus,
  startHermesBridge,
  stopHermesBridge,
  type HermesBridgeStatus,
} from "../../lib/tauri";
import { AdminNotifications } from "./AdminNotifications";
import { McpToolsDialog } from "./McpToolsDialog";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { Dialog } from "../ui/Dialog";
import { Switch } from "../ui/Switch";

type McpServersSectionProps = {
  /** The write-access mode whose runtime this page targets. Defaults to the safe
   * sandboxed runtime; the host can point it at Full mode explicitly. */
  mode?: HermesAdminMode;
};

/**
 * June's native MCP servers page (specs 14 + 17). Lists the MCP servers Hermes
 * has configured for the targeted profile and lets the user add stdio / HTTP
 * servers, test connections, enable/disable, delete, and — for OAuth servers —
 * sign in / re-authenticate through the browser, all through the typed
 * `hermes-admin` client, the shared cache, and the gateway lifecycle (so the
 * apply-timing copy is honest: MCP changes are "restart required").
 *
 * The servers list and the OAuth login flow share ONE engine (one client, one
 * cache, one lifecycle) so a sign-in's inventory refresh and the list's view
 * stay consistent. Secrets (env values, header values, OAuth tokens) are never
 * surfaced; this component is presentation + local filter / dialog state.
 */
export function McpServersSection({ mode = "sandboxed" }: McpServersSectionProps) {
  const [bridge, setBridge] = useState<HermesBridgeStatus>();
  const [bridgeError, setBridgeError] = useState<string>();
  // The native runtime restart. June owns the Hermes process, so applying MCP
  // changes stops and respawns it through the bridge; Hermes' own HTTP restart
  // endpoint would kill the server answering the request and hand the new
  // gateway a port/token June no longer knows. The fresh bridge status rebuilds
  // the engine, so the page reloads clean with the changes applied.
  const [restart, setRestart] = useState<{
    phase: "idle" | "running" | "failed";
    error?: string;
  }>({ phase: "idle" });

  useEffect(() => {
    let cancelled = false;
    hermesBridgeStatus()
      .then((status) => {
        if (!cancelled) setBridge(status);
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setBridgeError(error instanceof Error ? error.message : String(error));
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const engine = useMcpServersEngine(bridge, mode);
  const serversState = useMcpFilteringController(engine);
  const oauthState = useMcpOauthController(engine);

  async function restartRuntime() {
    if (restart.phase === "running") return;
    setRestart({ phase: "running" });
    try {
      // Scope the stop to THIS page's runtime: stopping everything would
      // silently kill a live session in the other mode and leave it stopped.
      await stopHermesBridge(mode);
      const status = await startHermesBridge(undefined, mode === "unrestricted");
      setBridge(status);
      setRestart({ phase: "idle" });
    } catch (error) {
      // Reality may have changed under us (the stop landed, the start
      // failed): re-read the bridge status so the engine is rebuilt against
      // what is ACTUALLY running and never keeps calling a stopped runtime.
      // If even the status read fails, drop to the unavailable state rather
      // than keep a dead connection.
      try {
        setBridge(await hermesBridgeStatus());
      } catch {
        setBridge(undefined);
      }
      setRestart({
        phase: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const state: McpFilteringState =
    engine === null && bridgeError
      ? {
          ...serversState,
          status: "error",
          error: bridgeError,
          retryable: true,
        }
      : serversState;

  // Overlay the native restart onto the engine state: the banner's button
  // drives the bridge restart, and while it runs (or after it fails) the
  // banner shows the restart lifecycle instead of the engine snapshot.
  const withRestart: McpFilteringState = {
    ...state,
    restartGateway: () => void restartRuntime(),
    lifecycle:
      restart.phase === "running"
        ? {
            state: "restart-in-progress",
            label: "Restarting",
            detail: "Applying your changes. This can take a moment.",
            canRestart: false,
          }
        : restart.phase === "failed"
          ? {
              state: "restart-failed",
              label: "Restart failed",
              detail: restart.error ?? "The agent did not restart. You can try again.",
              error: restart.error,
              canRestart: true,
            }
          : state.lifecycle,
  };

  return <McpServersView state={withRestart} oauth={oauthState} mode={mode} />;
}

/**
 * The render-only view, split out so component tests can drive it with a stubbed
 * {@link McpServersState} (no Tauri, no network) and assert search / add / test /
 * toggle / edit / delete wiring. Owns only the local search + dialog state.
 */
export function McpServersView({
  state,
  oauth,
  mode = "sandboxed",
}: {
  /** The servers state, optionally with the spec-16 tool-filtering slice and the
   * connection-field edit slice. Those fields are optional so a component test
   * can drive the list with a bare {@link McpServersState}; the Tools panel save
   * no-ops and the Edit action is hidden without them. */
  state: McpServersState &
    Partial<
      Pick<
        McpFilteringState,
        | "savingServer"
        | "saveError"
        | "saveToolPolicy"
        | "editingServer"
        | "editError"
        | "editServer"
        | "clearEditError"
        | "clearSaveError"
      >
    >;
  /** The OAuth sign-in slice. Optional so a component test can drive the list
   * without it; the empty controller state is used when absent. */
  oauth?: McpOauthState;
  mode?: HermesAdminMode;
}) {
  const [query, setQuery] = useState("");
  const [addOpen, setAddOpen] = useState(false);
  const [toDelete, setToDelete] = useState<HermesMcpServerInfo | undefined>();
  // The server whose connection-field edit dialog is open, or undefined.
  const [toEdit, setToEdit] = useState<HermesMcpServerInfo | undefined>();
  // A high-risk server enable is gated behind a confirmation. This holds the
  // server awaiting a confirmed enable; a disable or a low-risk enable applies
  // straight away.
  const [toEnable, setToEnable] = useState<HermesMcpServerInfo | undefined>();
  // The server whose tool-filtering panel is open, or undefined.
  const [toolsFor, setToolsFor] = useState<HermesMcpServerInfo | undefined>();

  const visible = useMemo(() => filterServers(state.servers, query), [state.servers, query]);

  /** Routes a toggle: disabling is never gated; enabling a high-risk server
   * opens a confirmation, while a standard enable applies immediately. The
   * heuristic is a WARNING only — the user can always confirm. */
  function handleToggle(server: HermesMcpServerInfo, enabled: boolean) {
    if (!enabled) {
      state.setEnabled(server.name, false);
      return;
    }
    if (classifyServerRisk(server).requiresConfirmation) {
      setToEnable(server);
      return;
    }
    state.setEnabled(server.name, true);
  }

  const isUnavailable = state.status === "unavailable";
  const isErrored = state.status === "error";
  const isLoadingFirst = state.status === "loading";
  const hasServers = state.servers.length > 0;

  return (
    <section className="settings-group mcp-servers" aria-labelledby="mcp-servers-heading">
      <h2 id="mcp-servers-heading" className="settings-group-heading">
        MCP servers
      </h2>
      <p className="settings-group-description">
        Connect Model Context Protocol servers so future sessions can use their tools. Changes apply
        after a restart.{" "}
        <ModeNote mode={state.mode ?? mode} profile={state.profile} show={!isUnavailable} />
      </p>

      <LifecycleBanner state={state} />
      <AdminNotifications
        notifications={state.notifications}
        onDismiss={state.dismissNotification}
      />

      <div className="settings-card mcp-servers-card">
        <div className="mcp-servers-toolbar">
          <div className="mcp-servers-search">
            <IconMagnifyingGlass size={15} ariaHidden className="mcp-servers-search-icon" />
            <input
              type="search"
              value={query}
              placeholder="Filter servers"
              aria-label="Filter MCP servers"
              disabled={isUnavailable}
              onChange={(event) => setQuery(event.currentTarget.value)}
            />
          </div>
          <button
            type="button"
            className="mcp-servers-refresh"
            disabled={isUnavailable || isLoadingFirst}
            onClick={state.refresh}
          >
            <IconArrowRotateClockwise size={14} ariaHidden />
            Refresh
          </button>
          <button
            type="button"
            className="btn btn-primary mcp-servers-add"
            disabled={isUnavailable}
            onClick={() => setAddOpen(true)}
          >
            <IconPlusMedium size={14} ariaHidden />
            Add server
          </button>
        </div>

        {state.error && hasServers ? (
          <p className="settings-row-error mcp-servers-inline-error">
            <IconExclamationCircle size={14} ariaHidden />
            {state.error}
          </p>
        ) : null}

        <div className="mcp-servers-body">
          {isUnavailable ? (
            <EmptyState
              title="Hermes is not running"
              description="Start Hermes to see and manage the MCP servers your sessions can use."
            />
          ) : isErrored ? (
            <ErrorState
              message={state.error ?? "Could not load MCP servers from Hermes."}
              retryable={state.retryable}
              onRetry={state.refresh}
            />
          ) : isLoadingFirst ? (
            <ServersLoading />
          ) : !hasServers ? (
            <EmptyState
              title="No MCP servers"
              description="Add a server to connect external tools. Local (stdio) servers run as subprocesses; remote servers connect over HTTP."
            />
          ) : visible.length === 0 ? (
            <EmptyState
              title="No matching servers"
              description="No server matches your search. Try a different term."
            />
          ) : (
            <ul className="mcp-servers-list">
              {visible.map((server) => (
                <ServerRow
                  key={server.name}
                  server={server}
                  pending={state.pending.has(server.name)}
                  test={state.tests.get(server.name)}
                  oauthLogin={oauth?.logins.get(server.name)}
                  onSignIn={oauth ? () => oauth.signIn(server.name) : undefined}
                  onToggle={(enabled) => handleToggle(server, enabled)}
                  onTest={() => void state.test(server.name)}
                  onEdit={
                    state.editServer && canEditServer(server)
                      ? () => {
                          // Never show another server's stale edit failure in
                          // a freshly opened form.
                          state.clearEditError?.();
                          setToEdit(server);
                        }
                      : undefined
                  }
                  onTools={() => {
                    state.clearSaveError?.();
                    setToolsFor(server);
                  }}
                  onDelete={() => setToDelete(server)}
                />
              ))}
            </ul>
          )}
        </div>
      </div>

      <AddServerDialog
        open={addOpen}
        adding={state.adding}
        existingNames={state.servers.map((server) => server.name)}
        onClose={() => setAddOpen(false)}
        onAdd={async (payload) => {
          const ok = await state.add(payload);
          if (ok) setAddOpen(false);
          return ok;
        }}
      />

      <EditServerDialog
        server={toEdit}
        saving={Boolean(toEdit) && state.editingServer === toEdit?.name}
        saveError={state.editError}
        onClose={() => setToEdit(undefined)}
        onSave={async (writes) => {
          if (!toEdit || !state.editServer) return false;
          return state.editServer(toEdit.name, writes);
        }}
      />

      <DeleteServerDialog
        server={toDelete}
        onClose={() => setToDelete(undefined)}
        onConfirm={async () => {
          if (toDelete) await state.remove(toDelete.name);
        }}
      />

      <EnableServerDialog
        server={toEnable}
        onClose={() => setToEnable(undefined)}
        onConfirm={() => {
          if (toEnable) state.setEnabled(toEnable.name, true);
        }}
      />

      <McpToolsDialog
        server={toolsFor}
        testResult={toolsFor ? state.tests.get(toolsFor.name)?.result : undefined}
        saving={Boolean(toolsFor) && state.savingServer === toolsFor?.name}
        saveError={state.saveError}
        onClose={() => setToolsFor(undefined)}
        onSave={async (draft: ToolPolicyDraft) => {
          if (!toolsFor || !state.saveToolPolicy) return false;
          return state.saveToolPolicy(toolsFor.name, draft);
        }}
      />
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
    <span className="mcp-servers-mode-note">
      Targeting the {modeLabel} runtime
      {profile ? ` (profile ${profile})` : ""}.
    </span>
  );
}

/** The shared gateway-lifecycle banner. MCP changes are restart-required, so
 * this surfaces the restart state once a change is pending. */
function LifecycleBanner({ state }: { state: McpServersState }) {
  const snapshot = state.lifecycle;
  // A failed restart must stay visible (with its Try again button) even when
  // the runtime is down: that is exactly the state a failed restart leaves,
  // and hiding the banner would strand the user with no retry affordance.
  if (state.status === "unavailable" && snapshot.state !== "restart-failed") return null;
  if (snapshot.state === "clean") return null;
  // A pending restart is a normal, expected step (info tone with an action),
  // not a warning: the user saved a change and just needs to apply it. Only a
  // failed restart reads as destructive.
  const tone =
    snapshot.state === "restart-failed"
      ? "destructive"
      : snapshot.state === "active-session-should-restart"
        ? "warning"
        : "info";
  return (
    <div className="mcp-servers-lifecycle" data-tone={tone} role="status">
      <div className="mcp-servers-lifecycle-main">
        <span className="mcp-servers-lifecycle-eyebrow">
          <IconCircleInfo size={15} ariaHidden />
          {snapshot.label}
        </span>
        <span className="mcp-servers-lifecycle-body">
          {snapshot.state === "gateway-restart-required"
            ? "Your changes are saved. Restart to start using your MCP tools."
            : snapshot.detail}
        </span>
      </div>
      {snapshot.canRestart ? (
        <button
          type="button"
          className="mcp-servers-lifecycle-restart"
          onClick={state.restartGateway}
        >
          {snapshot.state === "restart-failed" ? "Try again" : "Restart now"}
        </button>
      ) : null}
    </div>
  );
}

/** One MCP server row: name + transport / risk pills, connection target
 * (command + args or URL), auth and last-test status, redacted secret fields,
 * discovered tools, a test button, the enable/disable toggle, and a delete
 * action. */
function ServerRow({
  server,
  pending,
  test,
  oauthLogin,
  onSignIn,
  onToggle,
  onTest,
  onEdit,
  onTools,
  onDelete,
}: {
  server: HermesMcpServerInfo;
  pending: boolean;
  test?: McpTestState;
  oauthLogin?: McpOauthLoginState;
  onSignIn?: () => void;
  onToggle: (enabled: boolean) => void;
  onTest: () => void;
  /** Opens the connection-field edit dialog. Absent when the surface has no
   * edit slice wired or the transport has nothing safe to edit. */
  onEdit?: () => void;
  onTools: () => void;
  onDelete: () => void;
}) {
  const transport = transportMeta(server.transport);
  const auth = authMeta(server.auth);
  const status = statusMeta(server.status);
  const env = redactedEnv(server);
  const headers = redactedHeaders(server);
  const args = serverArgs(server);
  const local = isLocalSubprocess(server);
  const labelId = `mcp-server-${cssId(server.name)}`;
  const tools = test?.result?.tools ?? server.tools ?? [];
  // OAuth applies when the server is oauth-shaped, or when the last connection
  // probe said so (Hermes' "run `hermes mcp login <name>` interactively" error)
  // — the sign-in panel below IS that interactive login, run via the browser.
  const oauth = usesOauth(server) || oauthNeedFromMessage(test?.result?.message ?? test?.error);
  const securityLabels = inlineSecurityLabels(securityLabelsFor(server));
  const risk = classifyServerRisk(server);
  // Recommend an allowlist only after the server has tested successfully, so the
  // advice lands when the user can act on a real tool list (filtering is owned
  // by the tool selection surface, spec 16).
  const testedOk = test?.result?.ok === true || server.status === "connected";

  return (
    <li className="mcp-server-row" data-enabled={server.enabled}>
      <div className="mcp-server-top">
        <div className="mcp-server-main">
          <div className="mcp-server-headline">
            <span className="mcp-server-name" id={labelId}>
              {server.name}
            </span>
            <span className="mcp-server-transport" data-risk={transport.risk}>
              {transport.label}
            </span>
            <span className="mcp-server-risk" data-risk={transport.risk}>
              <IconShield size={12} ariaHidden />
              {transport.riskLabel}
            </span>
            {/* An "Auth unknown" pill is noise once a probe has proven the
             * connection; the sign-in panel below carries the real status. */}
            {server.auth !== "not-required" && !(server.auth === "unknown" && testedOk) ? (
              <span className="mcp-server-auth" data-tone={auth.tone}>
                {auth.label}
              </span>
            ) : null}
          </div>

          <p className="mcp-server-target" title={server.command ?? server.url}>
            {server.transport === "stdio"
              ? formatCommand(server.command, args)
              : (server.url ?? "No URL configured.")}
          </p>

          <p className="mcp-server-blurb">{transport.blurb}</p>

          <SecurityLabels labels={securityLabels} />

          {risk.tier === "high" ? (
            <p className="mcp-server-risk-note" data-tier="high" role="note">
              <IconExclamationCircle size={13} ariaHidden />
              {risk.reasons[0]?.detail ?? "This server can take high-impact actions."}
            </p>
          ) : null}

          {risk.tier === "high" && testedOk ? (
            <p className="mcp-server-allowlist-note" role="note">
              <IconShield size={13} ariaHidden />
              {ALLOWLIST_RECOMMENDATION}
            </p>
          ) : null}

          <div className="mcp-server-meta">
            <span className="mcp-server-status" data-tone={status.tone}>
              <StatusIcon tone={status.tone} />
              {status.label}
            </span>
            {server.statusMessage ? (
              <span className="mcp-server-status-detail">{server.statusMessage}</span>
            ) : null}
          </div>

          {env.length > 0 || headers.length > 0 ? (
            <div className="mcp-server-secrets">
              {env.length > 0 ? <SecretSummary label="Environment" count={env.length} /> : null}
              {headers.length > 0 ? <SecretSummary label="Headers" count={headers.length} /> : null}
            </div>
          ) : null}

          <TestResult test={test} tools={tools} />
        </div>

        <div className="mcp-server-actions">
          <button
            type="button"
            className="mcp-server-test"
            disabled={test?.pending}
            onClick={onTest}
          >
            {test?.pending ? "Testing" : "Test"}
          </button>
          {onEdit ? (
            <button
              type="button"
              className="mcp-server-edit"
              aria-label={`Edit ${server.name}`}
              title="Edit connection"
              disabled={pending}
              onClick={onEdit}
            >
              <IconEditSmall1 size={14} ariaHidden />
              Edit
            </button>
          ) : null}
          <button
            type="button"
            className="mcp-server-tools"
            aria-label={`Configure tools for ${server.name}`}
            title="Configure tools"
            onClick={onTools}
          >
            <IconFilter2 size={14} ariaHidden />
            Tools
          </button>
          <button
            type="button"
            className="mcp-server-delete"
            aria-label={`Delete ${server.name}`}
            title="Delete server"
            disabled={pending}
            onClick={onDelete}
          >
            <IconTrashCan size={14} ariaHidden />
          </button>
          <span className="mcp-server-toggle">
            <Switch
              checked={server.enabled}
              disabled={pending}
              aria-labelledby={labelId}
              onCheckedChange={onToggle}
            />
            <span className="mcp-server-timing" aria-hidden>
              {pending ? "Saving" : "Restart to apply"}
            </span>
          </span>
        </div>
      </div>

      {/* Below the main/actions columns so the sign-in panel spans the row. */}
      {oauth ? (
        <OauthStatus server={server} login={oauthLogin} testedOk={testedOk} onSignIn={onSignIn} />
      ) : null}
    </li>
  );
}

/** The security/sandbox-boundary labels a server earns (local subprocess /
 * remote server / OAuth / secret-backed / sandbox constrained / unrestricted
 * capable), each with a tooltip blurb. Pure presentation of the derived labels;
 * the derivation and copy live in `mcp-security-view`. */
function SecurityLabels({ labels }: { labels: ReturnType<typeof securityLabelsFor> }) {
  if (labels.length === 0) return null;
  return (
    <ul className="mcp-server-security-labels" aria-label="Security labels">
      {labels.map((entry) => (
        <li
          key={entry.code}
          className="mcp-server-security-label"
          data-code={entry.code}
          data-tone={entry.tone}
          title={entry.blurb}
        >
          <IconShield size={11} ariaHidden />
          {entry.label}
        </li>
      ))}
    </ul>
  );
}

/** A redacted summary of secret-bearing config: a count and a placeholder, never
 * the values. */
function SecretSummary({ label, count }: { label: string; count: number }) {
  return (
    <span className="mcp-server-secret" title={`${count} hidden ${label.toLowerCase()}`}>
      {label}: {count} hidden
    </span>
  );
}

/** The discovered tools / error from the last test probe. */
function TestResult({
  test,
  tools,
}: {
  test?: McpTestState;
  tools: { name: string; description?: string }[];
}) {
  if (!test || test.pending) return null;
  if (test.error) {
    return (
      <p className="mcp-server-test-error" role="alert">
        <IconExclamationCircle size={13} ariaHidden />
        {test.error}
      </p>
    );
  }
  const result = test.result;
  if (!result) return null;
  if (!result.ok) {
    return (
      <p className="mcp-server-test-error" role="alert">
        <IconCircleX size={13} ariaHidden />
        {result.message ?? "Could not connect to the server."}
      </p>
    );
  }
  return (
    <div className="mcp-server-test-ok" role="status">
      <p className="mcp-server-test-ok-line">
        <IconCircleCheck size={13} ariaHidden />
        Connected.{" "}
        {tools.length > 0
          ? `Discovered ${tools.length} ${tools.length === 1 ? "tool" : "tools"}.`
          : "No tools reported."}
      </p>
      {tools.length > 0 ? (
        <ul className="mcp-server-test-tools">
          {tools.map((tool) => (
            <li key={tool.name} title={tool.description}>
              {tool.name}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function StatusIcon({ tone }: { tone: "ok" | "error" | "neutral" }) {
  if (tone === "ok") return <IconCircleCheck size={13} ariaHidden />;
  if (tone === "error") return <IconCircleX size={13} ariaHidden />;
  return <IconCircleInfo size={13} ariaHidden />;
}

/**
 * The OAuth sign-in panel for an OAuth-authenticated HTTP MCP server (spec 17).
 * Shows the token status (connected / needs sign-in / expired / waiting / needs
 * client setup / unknown) and offers the matching action: sign in, sign in
 * again, or add client details. While a sign-in is in flight it shows the
 * waiting state; when it finishes it shows the safe (redacted) result. A
 * `waiting` (timed-out) login keeps the row in the waiting state with a manual
 * "open sign-in page" fallback, because the browser step is the user's to
 * finish and June never blocks on it. Token values are never shown.
 */
function OauthStatus({
  server,
  login,
  testedOk,
  onSignIn,
}: {
  server: HermesMcpServerInfo;
  login?: McpOauthLoginState;
  /** True when the server's last test probe connected (or the listing says
   * connected) — with cached tokens on disk that outranks an "unknown" status. */
  testedOk?: boolean;
  onSignIn?: () => void;
}) {
  const inFlight = login?.phase === "signing-in" || login?.phase === "waiting";
  const baseState = oauthStateFor(server, inFlight);
  // Fresher signals outrank a listing that reports no auth status (Hermes'
  // GET does not carry token state for every transport): a sign-in that just
  // completed, or a successful test probe (which needed the cached token to
  // connect). A REPORTED needs-sign-in only yields to a completed login, not
  // to a test - some servers list tools without auth.
  const meta = oauthStatusMeta(
    login?.phase === "done" && (baseState === "unknown" || baseState === "needs-sign-in")
      ? "connected"
      : testedOk && baseState === "unknown"
        ? "connected"
        : baseState,
  );
  // The configure action is a setup step (client id/secret); a sign-in action
  // runs the browser flow. We only wire the sign-in here. Client-detail setup is
  // surfaced as guidance: this Hermes version configures client credentials in
  // the server's config / env, which the add/edit and secret-setup surfaces own.
  const canSignIn =
    Boolean(onSignIn) && (meta.action === "sign-in" || meta.action === "re-auth") && !inFlight;

  return (
    <div className="mcp-server-oauth" data-state={meta.state} role="group">
      <div className="mcp-server-oauth-head">
        <span className="mcp-server-oauth-status" data-tone={meta.tone}>
          <IconKey1 size={13} ariaHidden />
          {meta.label}
        </span>
        {canSignIn ? (
          <button type="button" className="mcp-server-oauth-action" onClick={onSignIn}>
            {meta.actionLabel}
          </button>
        ) : null}
      </div>

      <p className="mcp-server-oauth-blurb">{meta.blurb}</p>

      {login?.phase === "signing-in" ? (
        <p className="mcp-server-oauth-progress" role="status">
          <IconCloud size={13} ariaHidden />A browser window should have opened. Approve the sign-in
          there to finish.
        </p>
      ) : null}

      {login?.phase === "waiting" ? (
        <p className="mcp-server-oauth-progress" role="status">
          <IconCloud size={13} ariaHidden />
          Still waiting for the browser sign-in. Finish it, then test the server to confirm.
        </p>
      ) : null}

      {login?.phase === "failed" && login.error ? (
        <p className="mcp-server-oauth-error" role="alert">
          <IconExclamationCircle size={13} ariaHidden />
          {login.error}
        </p>
      ) : null}

      {login?.phase === "done" && login.message ? (
        <p className="mcp-server-oauth-done" role="status">
          <IconCircleCheck size={13} ariaHidden />
          {login.message}
        </p>
      ) : null}

      {login?.authUrl ? (
        <a
          className="mcp-server-oauth-link"
          href={login.authUrl}
          target="_blank"
          rel="noreferrer noopener"
        >
          <IconArrowUpRight size={12} ariaHidden />
          Open the sign-in page
        </a>
      ) : null}
    </div>
  );
}

/** Renders the connection target for a stdio server: command plus its args. */
function formatCommand(command: string | undefined, args: string[]): string {
  if (!command) return "No command configured.";
  return args.length > 0 ? `${command} ${args.join(" ")}` : command;
}

// ---------------------------------------------------------------------------
// Add-server dialog
// ---------------------------------------------------------------------------

/** A stable, monotonic id for an editor row. Rows are added and removed in the
 * middle of a list, so a positional React key would let React reuse a row's
 * (masked) input DOM node across logical rows on deletion; a minted id keeps
 * each input bound to its own data. Module-level so ids stay unique across all
 * lists in a form. */
let nextEditorRowId = 0;
function newEditorRowId(): string {
  nextEditorRowId += 1;
  return `mcp-row-${nextEditorRowId}`;
}

/** One stdio argument row, with a stable id for its React key. */
type ArgRow = { id: string; value: string };
/** One env / header pair row, with a stable id for its React key. */
type PairRow = { id: string; key: string; value: string };

/** The add-server form state. Mirrors {@link McpServerDraft} but carries a
 * stable id on each list/pair row so the editors key on identity, not index.
 * The ids are a UI concern only: {@link toValidationDraft} strips them so the
 * pure validation / serialization contract never sees them. */
type EditableDraft = {
  name: string;
  transport: McpServerDraft["transport"];
  command: string;
  args: ArgRow[];
  env: PairRow[];
  url: string;
  headers: PairRow[];
  auth: McpServerDraft["auth"];
};

/** A blank editable draft for a fresh add-server form. */
function emptyEditableDraft(transport: McpServerDraft["transport"] = "stdio"): EditableDraft {
  return {
    name: "",
    transport,
    command: "",
    args: [],
    env: [],
    url: "",
    headers: [],
    auth: "none",
  };
}

/** Strips the UI row ids, producing the plain {@link McpServerDraft} that
 * {@link validateDraft} and the payload builder consume. */
function toValidationDraft(draft: EditableDraft): McpServerDraft {
  return {
    name: draft.name,
    transport: draft.transport,
    command: draft.command,
    args: draft.args.map((row) => row.value),
    env: draft.env.map((row) => ({ key: row.key, value: row.value })),
    url: draft.url,
    headers: draft.headers.map((row) => ({ key: row.key, value: row.value })),
    auth: draft.auth,
  };
}

function AddServerDialog({
  open,
  adding,
  existingNames,
  onClose,
  onAdd,
}: {
  open: boolean;
  adding: boolean;
  existingNames: string[];
  onClose: () => void;
  onAdd: (payload: import("../../lib/hermes-admin").HermesAddMcpServerPayload) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState<EditableDraft>(() => emptyEditableDraft());
  const [errors, setErrors] = useState<Record<string, string>>({});
  const headingId = useId();

  function reset() {
    setDraft(emptyEditableDraft());
    setErrors({});
  }

  function handleClose() {
    if (adding) return;
    reset();
    onClose();
  }

  async function handleSubmit() {
    const validationDraft = toValidationDraft(draft);
    const trimmedName = validationDraft.name.trim();
    if (existingNames.includes(trimmedName)) {
      setErrors({ name: "A server with this name already exists." });
      return;
    }
    const result = validateDraft(validationDraft);
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }
    setErrors({});
    const ok = await onAdd(result.payload);
    if (ok) reset();
  }

  return (
    <Dialog
      open={open}
      onClose={handleClose}
      title="Add MCP server"
      description="Connect a stdio or HTTP server. It becomes available to new sessions after the Hermes gateway restarts."
      width={560}
      className="mcp-add-dialog"
      footer={
        <>
          <button type="button" className="primary-action" onClick={handleClose} disabled={adding}>
            Cancel
          </button>
          <button
            type="button"
            className="primary-action primary-solid"
            onClick={() => void handleSubmit()}
            disabled={adding}
          >
            {adding ? "Adding" : "Add server"}
          </button>
        </>
      }
    >
      <div className="mcp-add-form" aria-labelledby={headingId}>
        <fieldset className="mcp-add-field">
          <label className="mcp-add-label" htmlFor="mcp-add-name">
            Name
          </label>
          <input
            id="mcp-add-name"
            type="text"
            className="mcp-add-input"
            value={draft.name}
            autoComplete="off"
            spellCheck={false}
            aria-invalid={Boolean(errors.name)}
            onChange={(event) => {
              // Read the value synchronously: React nulls event.currentTarget
              // once the handler returns, and the setDraft updater runs later.
              const value = event.currentTarget.value;
              setDraft((d) => ({ ...d, name: value }));
            }}
          />
          {errors.name ? <p className="mcp-add-error">{errors.name}</p> : null}
        </fieldset>

        <fieldset className="mcp-add-field">
          <span className="mcp-add-label">Transport</span>
          <div className="mcp-add-transport" role="radiogroup" aria-label="Transport">
            <TransportOption
              label="Local (stdio)"
              hint="Runs a local subprocess"
              active={draft.transport === "stdio"}
              onSelect={() => setDraft((d) => ({ ...d, transport: "stdio" }))}
            />
            <TransportOption
              label="Remote (HTTP)"
              hint="Connects over HTTP"
              active={draft.transport === "http"}
              onSelect={() => setDraft((d) => ({ ...d, transport: "http" }))}
            />
          </div>
        </fieldset>

        {draft.transport === "stdio" ? (
          <p className="mcp-add-note">
            <IconShield size={13} ariaHidden />
            Local servers run as subprocesses and inherit June and Hermes sandbox constraints. Enter
            only the program path here; put arguments in their own rows.
          </p>
        ) : null}

        {draft.transport === "stdio" ? (
          <>
            <fieldset className="mcp-add-field">
              <label className="mcp-add-label" htmlFor="mcp-add-command">
                Command
              </label>
              <input
                id="mcp-add-command"
                type="text"
                className="mcp-add-input"
                value={draft.command}
                placeholder="mcp-server-filesystem"
                autoComplete="off"
                spellCheck={false}
                aria-invalid={Boolean(errors.command)}
                onChange={(event) => {
                  const value = event.currentTarget.value;
                  setDraft((d) => ({ ...d, command: value }));
                }}
              />
              {errors.command ? <p className="mcp-add-error">{errors.command}</p> : null}
            </fieldset>

            <ListEditor
              legend="Arguments"
              addLabel="Add argument"
              values={draft.args}
              errorPrefix="args"
              errors={errors}
              onChange={(args) => setDraft((d) => ({ ...d, args }))}
            />

            <PairEditor
              legend="Environment variables"
              addLabel="Add variable"
              keyPlaceholder="VAR_NAME"
              valuePlaceholder="Value (hidden)"
              pairs={draft.env}
              errorPrefix="env"
              errors={errors}
              onChange={(env) => setDraft((d) => ({ ...d, env }))}
            />
          </>
        ) : (
          <>
            <fieldset className="mcp-add-field">
              <label className="mcp-add-label" htmlFor="mcp-add-url">
                URL
              </label>
              <input
                id="mcp-add-url"
                type="url"
                className="mcp-add-input"
                value={draft.url}
                placeholder="https://example.com/mcp"
                autoComplete="off"
                spellCheck={false}
                aria-invalid={Boolean(errors.url)}
                onChange={(event) => {
                  const value = event.currentTarget.value;
                  setDraft((d) => ({ ...d, url: value }));
                }}
              />
              {errors.url ? <p className="mcp-add-error">{errors.url}</p> : null}
            </fieldset>

            <fieldset className="mcp-add-field">
              <label className="mcp-add-label" htmlFor="mcp-add-auth">
                Auth
              </label>
              <select
                id="mcp-add-auth"
                className="mcp-add-input"
                value={draft.auth}
                onChange={(event) => {
                  const value = event.currentTarget.value as McpServerDraft["auth"];
                  setDraft((d) => ({ ...d, auth: value }));
                }}
              >
                <option value="none">None</option>
                <option value="bearer">Bearer token</option>
                <option value="oauth">OAuth</option>
              </select>
            </fieldset>

            {draft.auth === "oauth" ? (
              <p className="mcp-add-note">
                <IconCloud size={13} ariaHidden />
                You will sign in to this server after it is added. The sign-in flow opens in your
                browser.
              </p>
            ) : null}

            <PairEditor
              legend="Headers"
              addLabel="Add header"
              keyPlaceholder="Authorization"
              valuePlaceholder="Value (hidden)"
              pairs={draft.headers}
              errorPrefix="headers"
              errors={errors}
              onChange={(headers) => setDraft((d) => ({ ...d, headers }))}
            />
          </>
        )}
      </div>
    </Dialog>
  );
}

function TransportOption({
  label,
  hint,
  active,
  onSelect,
}: {
  label: string;
  hint: string;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      className="mcp-add-transport-option"
      data-active={active}
      onClick={onSelect}
    >
      <span className="mcp-add-transport-label">{label}</span>
      <span className="mcp-add-transport-hint">{hint}</span>
    </button>
  );
}

/** A simple add/remove list-of-strings editor (for stdio args). */
function ListEditor({
  legend,
  addLabel,
  values,
  errorPrefix,
  errors,
  onChange,
}: {
  legend: string;
  addLabel: string;
  values: ArgRow[];
  errorPrefix: string;
  errors: Record<string, string>;
  onChange: (values: ArgRow[]) => void;
}) {
  return (
    <fieldset className="mcp-add-field">
      <span className="mcp-add-label">{legend}</span>
      {values.map((row, index) => (
        <div key={row.id} className="mcp-add-row">
          <input
            type="text"
            className="mcp-add-input"
            value={row.value}
            aria-label={`${legend} ${index + 1}`}
            autoComplete="off"
            spellCheck={false}
            aria-invalid={Boolean(errors[`${errorPrefix}.${index}`])}
            onChange={(event) => {
              const value = event.currentTarget.value;
              onChange(
                values.map((existing) =>
                  existing.id === row.id ? { ...existing, value } : existing,
                ),
              );
            }}
          />
          <button
            type="button"
            className="mcp-add-row-remove"
            aria-label={`Remove ${legend} ${index + 1}`}
            onClick={() => onChange(values.filter((existing) => existing.id !== row.id))}
          >
            <IconCrossSmall size={13} ariaHidden />
          </button>
          {errors[`${errorPrefix}.${index}`] ? (
            <p className="mcp-add-error">{errors[`${errorPrefix}.${index}`]}</p>
          ) : null}
        </div>
      ))}
      <button
        type="button"
        className="mcp-add-row-add"
        onClick={() => onChange([...values, { id: newEditorRowId(), value: "" }])}
      >
        <IconPlusMedium size={13} ariaHidden />
        {addLabel}
      </button>
    </fieldset>
  );
}

/** A key/value pair editor (for stdio env and HTTP headers). Values are
 * secret-class: the value inputs are masked. */
function PairEditor({
  legend,
  addLabel,
  keyPlaceholder,
  valuePlaceholder,
  pairs,
  errorPrefix,
  errors,
  onChange,
}: {
  legend: string;
  addLabel: string;
  keyPlaceholder: string;
  valuePlaceholder: string;
  pairs: PairRow[];
  errorPrefix: string;
  errors: Record<string, string>;
  onChange: (pairs: PairRow[]) => void;
}) {
  return (
    <fieldset className="mcp-add-field">
      <span className="mcp-add-label">{legend}</span>
      {pairs.map((pair, index) => (
        <div key={pair.id} className="mcp-add-pair">
          <input
            type="text"
            className="mcp-add-input mcp-add-pair-key"
            value={pair.key}
            placeholder={keyPlaceholder}
            aria-label={`${legend} ${index + 1} name`}
            autoComplete="off"
            spellCheck={false}
            aria-invalid={Boolean(errors[`${errorPrefix}.${index}`])}
            onChange={(event) => {
              const key = event.currentTarget.value;
              onChange(
                pairs.map((existing) =>
                  existing.id === pair.id ? { ...existing, key } : existing,
                ),
              );
            }}
          />
          <input
            type="password"
            className="mcp-add-input mcp-add-pair-value"
            value={pair.value}
            placeholder={valuePlaceholder}
            aria-label={`${legend} ${index + 1} value`}
            autoComplete="off"
            onChange={(event) => {
              const value = event.currentTarget.value;
              onChange(
                pairs.map((existing) =>
                  existing.id === pair.id ? { ...existing, value } : existing,
                ),
              );
            }}
          />
          <button
            type="button"
            className="mcp-add-row-remove"
            aria-label={`Remove ${legend} ${index + 1}`}
            onClick={() => onChange(pairs.filter((existing) => existing.id !== pair.id))}
          >
            <IconCrossSmall size={13} ariaHidden />
          </button>
          {errors[`${errorPrefix}.${index}`] ? (
            <p className="mcp-add-error">{errors[`${errorPrefix}.${index}`]}</p>
          ) : null}
        </div>
      ))}
      <button
        type="button"
        className="mcp-add-row-add"
        onClick={() => onChange([...pairs, { id: newEditorRowId(), key: "", value: "" }])}
      >
        <IconPlusMedium size={13} ariaHidden />
        {addLabel}
      </button>
    </fieldset>
  );
}

// ---------------------------------------------------------------------------
// Edit-server dialog (connection target only, non-destructive)
// ---------------------------------------------------------------------------

/**
 * Edits an existing server's connection target: a stdio server's command + args,
 * or an http(-oauth) server's URL. The write is scoped and non-destructive — the
 * save applies only the leaves that changed under `mcp_servers.<name>` (via
 * `planServerEdit`), so the server's secret env / headers, OAuth token, and tool
 * filters are all preserved. Secrets are never shown or edited here (June cannot
 * read them back), and the name / transport are fixed — changing either is a
 * delete-and-re-add. Changes apply after the gateway restarts, like every other
 * MCP mutation.
 */
function EditServerDialog({
  server,
  saving,
  saveError,
  onClose,
  onSave,
}: {
  server?: HermesMcpServerInfo;
  saving: boolean;
  saveError?: string;
  onClose: () => void;
  onSave: (writes: McpEditWrite[]) => Promise<boolean>;
}) {
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState<ArgRow[]>([]);
  const [url, setUrl] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});

  // Re-seed the form from the server each time a different one opens.
  useEffect(() => {
    if (!server) return;
    const edit = editFromServer(server);
    setCommand(edit.command);
    setArgs(edit.args.map((value) => ({ id: newEditorRowId(), value })));
    setUrl(edit.url);
    setErrors({});
  }, [server]);

  const isStdio = server?.transport === "stdio";

  async function handleSubmit() {
    if (!server) return;
    const plan = planServerEdit(server, {
      command,
      args: args.map((row) => row.value),
      url,
    });
    if (!plan.ok) {
      setErrors(plan.errors);
      return;
    }
    setErrors({});
    const ok = await onSave(plan.writes);
    if (ok) onClose();
  }

  return (
    <Dialog
      open={Boolean(server)}
      onClose={() => {
        if (!saving) onClose();
      }}
      title={server ? `Edit ${server.name}` : "Edit server"}
      description="Change the connection target. The server's secrets (environment variables, headers, and tokens) and tool filters are preserved. Changes apply after the Hermes gateway restarts."
      width={560}
      className="mcp-add-dialog"
      footer={
        <>
          <button
            type="button"
            className="primary-action"
            onClick={() => {
              if (!saving) onClose();
            }}
            disabled={saving}
          >
            Cancel
          </button>
          <button
            type="button"
            className="primary-action primary-solid"
            onClick={() => void handleSubmit()}
            disabled={saving}
          >
            {saving ? "Saving" : "Save changes"}
          </button>
        </>
      }
    >
      {server ? (
        <div className="mcp-add-form">
          <p className="mcp-add-note">
            <IconShield size={13} ariaHidden />
            To change a secret or the transport, delete this server and add it again.
          </p>

          {isStdio ? (
            <>
              <fieldset className="mcp-add-field">
                <label className="mcp-add-label" htmlFor="mcp-edit-command">
                  Command
                </label>
                <input
                  id="mcp-edit-command"
                  type="text"
                  className="mcp-add-input"
                  value={command}
                  placeholder="mcp-server-filesystem"
                  autoComplete="off"
                  spellCheck={false}
                  aria-invalid={Boolean(errors.command)}
                  onChange={(event) => setCommand(event.currentTarget.value)}
                />
                {errors.command ? <p className="mcp-add-error">{errors.command}</p> : null}
              </fieldset>

              <ListEditor
                legend="Arguments"
                addLabel="Add argument"
                values={args}
                errorPrefix="args"
                errors={errors}
                onChange={setArgs}
              />
            </>
          ) : (
            <fieldset className="mcp-add-field">
              <label className="mcp-add-label" htmlFor="mcp-edit-url">
                URL
              </label>
              <input
                id="mcp-edit-url"
                type="url"
                className="mcp-add-input"
                value={url}
                placeholder="https://example.com/mcp"
                autoComplete="off"
                spellCheck={false}
                aria-invalid={Boolean(errors.url)}
                onChange={(event) => setUrl(event.currentTarget.value)}
              />
              {errors.url ? <p className="mcp-add-error">{errors.url}</p> : null}
            </fieldset>
          )}

          {saveError ? (
            <p className="mcp-add-error" role="alert">
              {saveError}
            </p>
          ) : null}
        </div>
      ) : null}
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Delete confirmation
// ---------------------------------------------------------------------------

function DeleteServerDialog({
  server,
  onClose,
  onConfirm,
}: {
  server?: HermesMcpServerInfo;
  onClose: () => void;
  onConfirm: () => Promise<void>;
}) {
  const hasTools = server ? hasAvailableTools(server) : false;
  const description = server
    ? hasTools
      ? `${server.name} currently exposes tools to your sessions. Removing it drops those tools after the gateway restarts. This cannot be undone.`
      : `Remove ${server.name}? New sessions will no longer load it after the gateway restarts.`
    : "";
  return (
    <ConfirmDialog
      open={Boolean(server)}
      onClose={onClose}
      onConfirm={onConfirm}
      title={server ? `Delete "${server.name}"?` : "Delete server?"}
      description={description}
      confirmLabel="Delete server"
      destructive
    />
  );
}

/** The confirmation gate before enabling a high-risk server. Leads with the
 * file-tools warning (the spec's exact copy for local servers), then lists the
 * matched reasons. This NEVER blocks: the user can always confirm. */
function EnableServerDialog({
  server,
  onClose,
  onConfirm,
}: {
  server?: HermesMcpServerInfo;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const confirmation = server ? enableConfirmationFor(server) : undefined;
  return (
    <ConfirmDialog
      open={Boolean(server)}
      onClose={onClose}
      onConfirm={onConfirm}
      title={confirmation?.title ?? "Enable server?"}
      description={
        confirmation ? (
          <span className="mcp-confirm-body">
            <span className="mcp-confirm-lead">{confirmation.lead}</span>
            {confirmation.reasons.map((reason, index) => (
              <span key={index} className="mcp-confirm-reason">
                {reason}
              </span>
            ))}
          </span>
        ) : undefined
      }
      confirmLabel="Enable server"
    />
  );
}

// ---------------------------------------------------------------------------
// Shared empty / error / loading surfaces
// ---------------------------------------------------------------------------

function ServersLoading() {
  return (
    <ul className="mcp-servers-list" aria-hidden>
      {[0, 1].map((index) => (
        <li key={index} className="mcp-server-row mcp-server-skeleton">
          <div className="mcp-server-main">
            <span className="mcp-server-skeleton-line mcp-server-skeleton-title" />
            <span className="mcp-server-skeleton-line" />
          </div>
        </li>
      ))}
    </ul>
  );
}

function EmptyState({ title, description }: { title: string; description: string }) {
  return (
    <div className="mcp-servers-empty" role="status">
      <span className="mcp-servers-empty-icon" aria-hidden>
        <IconServer1 size={22} />
      </span>
      <p className="mcp-servers-empty-title">{title}</p>
      <p className="mcp-servers-empty-description">{description}</p>
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
    <div className="mcp-servers-error" role="alert">
      <span className="mcp-servers-empty-icon" aria-hidden>
        <IconExclamationCircle size={22} />
      </span>
      <p className="mcp-servers-empty-title">Couldn't load MCP servers</p>
      <p className="mcp-servers-empty-description">{message}</p>
      {retryable ? (
        <button type="button" className="mcp-servers-retry" onClick={onRetry}>
          Try again
        </button>
      ) : null}
    </div>
  );
}

/** A DOM-id-safe slug of a server name for `aria-labelledby` wiring. */
function cssId(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "-");
}
