import { IconArrowRotateClockwise } from "central-icons/IconArrowRotateClockwise";
import { IconArrowInbox } from "central-icons/IconArrowInbox";
import { IconCircleCheck } from "central-icons/IconCircleCheck";
import { IconCircleInfo } from "central-icons/IconCircleInfo";
import { IconCircleX } from "central-icons/IconCircleX";
import { IconCloud } from "central-icons/IconCloud";
import { IconExclamationCircle } from "central-icons/IconExclamationCircle";
import { IconArrowUpRight } from "central-icons/IconArrowUpRight";
import { IconFilter2 } from "central-icons/IconFilter2";
import { IconKey1 } from "central-icons/IconKey1";
import { IconMagnifyingGlass } from "central-icons/IconMagnifyingGlass";
import { IconPlusMedium } from "central-icons/IconPlusMedium";
import { IconServer1 } from "central-icons/IconServer1";
import { IconSettingsGear4 } from "central-icons/IconSettingsGear4";
import { IconShield } from "central-icons/IconShield";
import { IconTrashCan } from "central-icons/IconTrashCan";
import { useEffect, useMemo, useState, type ReactNode } from "react";
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
  oauthNeedFromMessage,
  oauthStateFor,
  oauthStatusMeta,
  planServerEdit,
  parseExternalMcpConfig,
  restartHermesRuntime,
  redactedEnv,
  redactedHeaders,
  securityLabelsFor,
  serverArgs,
  statusMeta,
  transportMeta,
  userManagedMcpServers,
  useMcpFilteringController,
  useMcpOauthController,
  useMcpServersEngine,
  usesOauth,
  validateDraft,
  type HermesAdminMode,
  type HermesAddMcpServerPayload,
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
import { hermesBridgeStatus, type HermesBridgeStatus } from "../../lib/tauri";
import { AdminNotifications } from "./AdminNotifications";
import { McpToolsDialog } from "./McpToolsDialog";
import { BreadcrumbBar } from "../ui/BreadcrumbBar";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { Dialog } from "../ui/Dialog";
import { EmptyState as EmptyStateSurface } from "../ui/EmptyState";
import { SegmentedControl } from "../ui/SegmentedControl";
import { SettingsPageHeader } from "./AppSettings";
import { Switch } from "../ui/Switch";
import { useConfirmedSettingsProfile } from "./useConfirmedSettingsProfile";

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
  const activeProfile = useConfirmedSettingsProfile(mode);
  if (activeProfile.pending) {
    return (
      <McpServersView
        state={PENDING_MCP_SERVERS_STATE}
        oauth={PENDING_MCP_OAUTH_STATE}
        mode={mode}
      />
    );
  }
  return <McpServersSectionReady mode={mode} profile={activeProfile.name} />;
}

function McpServersSectionReady({
  mode,
  profile,
}: McpServersSectionProps & { mode: HermesAdminMode; profile: string }) {
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

  const engine = useMcpServersEngine(bridge, mode, profile);
  const serversState = useMcpFilteringController(engine);
  const oauthState = useMcpOauthController(engine);

  async function restartRuntime() {
    if (restart.phase === "running") return;
    setRestart({ phase: "running" });
    try {
      // Scope the stop to THIS page's runtime: stopping everything would
      // silently kill a live session in the other mode and leave it stopped.
      const status = await restartHermesRuntime(mode);
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

const PENDING_MCP_SERVERS_STATE: McpServersState = {
  status: "loading",
  servers: [],
  pending: new Set<string>(),
  tests: new Map<string, McpTestState>(),
  adding: false,
  retryable: false,
  lifecycle: {
    state: "clean",
    label: "Up to date",
    detail: "No pending changes.",
    canRestart: false,
  },
  notifications: [],
  refresh: () => {},
  setEnabled: () => {},
  test: async () => ({ pending: false }),
  add: async () => false,
  remove: async () => false,
  restartGateway: () => {},
  dismissNotification: () => {},
};

const PENDING_MCP_OAUTH_STATE: McpOauthState = {
  logins: new Map(),
  signIn: () => {},
  busy: false,
  clear: () => {},
};

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
  const [refreshSpins, setRefreshSpins] = useState(0);
  const [setupOpen, setSetupOpen] = useState(false);
  const [manualTransport, setManualTransport] = useState<McpServerDraft["transport"]>();
  const [toDelete, setToDelete] = useState<HermesMcpServerInfo | undefined>();
  // The server whose connection-field edit dialog is open, or undefined.
  const [toEdit, setToEdit] = useState<HermesMcpServerInfo | undefined>();
  // A high-risk server enable is gated behind a confirmation. This holds the
  // server awaiting a confirmed enable; a disable or a low-risk enable applies
  // straight away.
  const [toEnable, setToEnable] = useState<HermesMcpServerInfo | undefined>();
  // The server whose tool-filtering panel is open, or undefined.
  const [toolsFor, setToolsFor] = useState<HermesMcpServerInfo | undefined>();

  const userServers = useMemo(() => userManagedMcpServers(state.servers), [state.servers]);
  const visible = useMemo(() => filterServers(userServers, query), [userServers, query]);

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
  const hasServers = userServers.length > 0;

  return (
    <section className="settings-group mcp-servers" aria-labelledby="mcp-servers-heading">
      <SettingsPageHeader
        id="mcp-servers-heading"
        title="MCP servers"
        blurb={
          <>
            Connect external tools and data sources. Changes apply after a restart.{" "}
            <ModeNote mode={state.mode ?? mode} profile={state.profile} show={!isUnavailable} />
          </>
        }
      />

      <LifecycleBanner state={state} />
      <AdminNotifications
        notifications={state.notifications}
        onDismiss={state.dismissNotification}
      />

      {/* The action row sits ABOVE the list card (Codex "Servers" + Add pattern):
       * a compact search, refresh, and the add button, not stuffed into the
       * card's top. */}
      <div className="mcp-servers-actions">
        <div className="settings-search mcp-servers-search">
          <IconMagnifyingGlass
            size={15}
            ariaHidden
            className="settings-search-icon mcp-servers-search-icon"
          />
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
          className="icon-button mcp-servers-refresh"
          aria-label="Refresh MCP servers"
          aria-busy={isLoadingFirst}
          title="Refresh MCP servers"
          disabled={isUnavailable || isLoadingFirst}
          onClick={() => {
            setRefreshSpins((spins) => spins + 1);
            state.refresh();
          }}
        >
          <IconArrowRotateClockwise
            size={14}
            ariaHidden
            className="balance-refresh-icon"
            style={{ transform: `rotate(${refreshSpins * 360}deg)` }}
          />
        </button>
        <button
          type="button"
          className="btn btn-secondary mcp-servers-add"
          disabled={isUnavailable}
          onClick={() => setSetupOpen(true)}
        >
          <IconPlusMedium size={14} ariaHidden />
          Set up MCP
        </button>
      </div>

      <div className="settings-card mcp-servers-card">
        {state.error && hasServers ? (
          <p className="settings-row-error mcp-servers-inline-error">
            <IconExclamationCircle size={14} ariaHidden />
            {state.error}
          </p>
        ) : null}

        <div className="mcp-servers-body">
          {isUnavailable ? (
            <EmptyState
              className="empty-state-compact"
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
              className="empty-state-compact"
              title="Connect your first tool"
              description="Bring in an existing Claude, Cursor, or Codex configuration, or set up a server with a few guided steps."
              action={
                <button
                  type="button"
                  className="btn btn-secondary mcp-servers-add"
                  onClick={() => setSetupOpen(true)}
                >
                  Start setup
                </button>
              }
            />
          ) : visible.length === 0 ? (
            <EmptyState
              className="empty-state-compact"
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
                  onToggle={(enabled) => handleToggle(server, enabled)}
                  onManage={() => {
                    // Never show another server's stale edit failure in a
                    // freshly opened detail form.
                    state.clearEditError?.();
                    setToEdit(server);
                  }}
                />
              ))}
            </ul>
          )}
        </div>
      </div>

      <McpSetupDialog
        open={setupOpen}
        existingNames={state.servers.map((server) => server.name)}
        onClose={() => setSetupOpen(false)}
        onManual={(transport) => {
          setSetupOpen(false);
          setManualTransport(transport);
        }}
        onAdd={state.add}
      />

      <AddServerDialog
        open={manualTransport !== undefined}
        initialTransport={manualTransport ?? "stdio"}
        adding={state.adding}
        existingNames={state.servers.map((server) => server.name)}
        onClose={() => setManualTransport(undefined)}
        onAdd={async (payload) => {
          const ok = await state.add(payload);
          if (ok) setManualTransport(undefined);
          return ok;
        }}
      />

      <EditServerDialog
        server={toEdit}
        test={toEdit ? state.tests.get(toEdit.name) : undefined}
        oauthLogin={toEdit ? oauth?.logins.get(toEdit.name) : undefined}
        saving={Boolean(toEdit) && state.editingServer === toEdit?.name}
        saveError={state.editError}
        canEdit={Boolean(toEdit && state.editServer && canEditServer(toEdit))}
        onClose={() => setToEdit(undefined)}
        onSignIn={toEdit && oauth ? () => oauth.signIn(toEdit.name) : undefined}
        onTest={toEdit ? () => void state.test(toEdit.name) : undefined}
        onTools={
          toEdit
            ? () => {
                state.clearSaveError?.();
                setToolsFor(toEdit);
                setToEdit(undefined);
              }
            : undefined
        }
        onDelete={
          toEdit
            ? () => {
                setToDelete(toEdit);
                setToEdit(undefined);
              }
            : undefined
        }
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
          className="btn btn-secondary mcp-servers-lifecycle-restart"
          onClick={state.restartGateway}
        >
          {snapshot.state === "restart-failed" ? "Try again" : "Restart now"}
        </button>
      ) : null}
    </div>
  );
}

/** One MCP server row: icon + name/subtitle on the left, with status, details,
 * and enable toggle aligned on the right. Detailed metadata lives in the
 * detail/edit surface so the list stays scannable. */
function ServerRow({
  server,
  pending,
  test,
  onToggle,
  onManage,
}: {
  server: HermesMcpServerInfo;
  pending: boolean;
  test?: McpTestState;
  onToggle: (enabled: boolean) => void;
  onManage: () => void;
}) {
  const transport = transportMeta(server.transport);
  const status = statusMeta(server.status);
  const labelId = `mcp-server-${cssId(server.name)}`;
  const rowStatus = test?.pending ? { label: "Testing", tone: "neutral" as const } : status;

  return (
    <li className="mcp-server-row" data-enabled={server.enabled}>
      <span className="mcp-server-icon" aria-hidden>
        <IconServer1 size={16} />
      </span>
      <div className="mcp-server-main">
        <span className="mcp-server-name" id={labelId}>
          {server.name}
        </span>
        <p className="mcp-server-subtitle" title={transport.blurb}>
          {transport.blurb}
        </p>
      </div>
      <div className="mcp-server-actions">
        <span className="mcp-server-status" data-tone={rowStatus.tone}>
          <StatusIcon tone={rowStatus.tone} />
          {rowStatus.label}
        </span>
        <button
          type="button"
          className="mcp-server-manage"
          aria-label={`Manage ${server.name}`}
          title="Manage server"
          disabled={pending}
          onClick={onManage}
        >
          <IconSettingsGear4 size={14} ariaHidden />
        </button>
        <span className="mcp-server-toggle">
          <Switch
            checked={server.enabled}
            disabled={pending}
            aria-labelledby={labelId}
            onCheckedChange={onToggle}
          />
        </span>
      </div>
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
// Guided setup and add-server dialogs
// ---------------------------------------------------------------------------

function McpSetupDialog({
  open,
  existingNames,
  onClose,
  onManual,
  onAdd,
}: {
  open: boolean;
  existingNames: string[];
  onClose: () => void;
  onManual: (transport: McpServerDraft["transport"]) => void;
  onAdd: (payload: HermesAddMcpServerPayload) => Promise<boolean>;
}) {
  const [step, setStep] = useState<"choose" | "import">("choose");
  const [raw, setRaw] = useState("");
  const [preview, setPreview] = useState<ReturnType<typeof parseExternalMcpConfig>>();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string>();

  function reset() {
    setStep("choose");
    setRaw("");
    setPreview(undefined);
    setSelected(new Set());
    setImportError(undefined);
  }

  function handleClose() {
    if (importing) return;
    reset();
    onClose();
  }

  function previewImport() {
    const result = parseExternalMcpConfig(raw);
    setPreview(result);
    setImportError(undefined);
    setSelected(
      new Set(
        result.entries
          .filter((entry) => entry.payload && !existingNames.includes(entry.name))
          .map((entry) => entry.name),
      ),
    );
  }

  async function applyImport() {
    if (!preview || importing) return;
    const entries = preview.entries.filter(
      (entry) => selected.has(entry.name) && entry.payload && !existingNames.includes(entry.name),
    );
    if (entries.length === 0) return;

    setImporting(true);
    const failed = new Set<string>();
    for (const entry of entries) {
      if (entry.payload && !(await onAdd(entry.payload))) failed.add(entry.name);
    }
    setImporting(false);
    if (failed.size > 0) {
      setSelected(failed);
      setImportError(
        failed.size === 1
          ? "One server could not be added. Review it and try again."
          : `${failed.size} servers could not be added. Review them and try again.`,
      );
      return;
    }
    reset();
    onClose();
  }

  const selectedCount = preview?.entries.filter(
    (entry) => selected.has(entry.name) && entry.payload && !existingNames.includes(entry.name),
  ).length;

  return (
    <Dialog
      open={open}
      onClose={handleClose}
      title={step === "choose" ? "Set up MCP" : "Import MCP configuration"}
      description={
        step === "choose"
          ? "Choose the quickest way to connect tools and data to June."
          : "Paste a Claude, Cursor, or Codex MCP configuration. You can review every server before anything is added."
      }
      width={600}
      className="mcp-add-dialog mcp-setup-dialog"
      footer={
        step === "choose" ? (
          <button type="button" className="primary-action" onClick={handleClose}>
            Cancel
          </button>
        ) : (
          <>
            <button
              type="button"
              className="primary-action"
              disabled={importing}
              onClick={() => {
                if (preview) {
                  setPreview(undefined);
                  setSelected(new Set());
                  setImportError(undefined);
                } else {
                  setStep("choose");
                }
              }}
            >
              Back
            </button>
            {preview ? (
              <button
                type="button"
                className="primary-action primary-solid"
                disabled={!selectedCount || importing}
                onClick={() => void applyImport()}
              >
                {importing
                  ? "Importing"
                  : `Import ${selectedCount ?? 0} ${selectedCount === 1 ? "server" : "servers"}`}
              </button>
            ) : (
              <button
                type="button"
                className="primary-action primary-solid"
                disabled={!raw.trim()}
                onClick={previewImport}
              >
                Preview servers
              </button>
            )}
          </>
        )
      }
    >
      {step === "choose" ? (
        <div className="mcp-setup-choices">
          <button type="button" className="mcp-setup-choice" onClick={() => setStep("import")}>
            <span className="mcp-setup-choice-icon">
              <IconArrowInbox size={18} ariaHidden />
            </span>
            <span className="mcp-setup-choice-copy">
              <span className="mcp-setup-choice-title">
                Import from another app
                <span className="mcp-setup-recommended">Recommended</span>
              </span>
              <span className="mcp-setup-choice-description">
                Bring over servers from Claude, Cursor, or Codex in one pass.
              </span>
            </span>
          </button>
          <button type="button" className="mcp-setup-choice" onClick={() => onManual("http")}>
            <span className="mcp-setup-choice-icon">
              <IconCloud size={18} ariaHidden />
            </span>
            <span className="mcp-setup-choice-copy">
              <span className="mcp-setup-choice-title">Connect a remote server</span>
              <span className="mcp-setup-choice-description">
                Add a hosted MCP endpoint and sign in if it uses OAuth.
              </span>
            </span>
          </button>
          <button type="button" className="mcp-setup-choice" onClick={() => onManual("stdio")}>
            <span className="mcp-setup-choice-icon">
              <IconSettingsGear4 size={18} ariaHidden />
            </span>
            <span className="mcp-setup-choice-copy">
              <span className="mcp-setup-choice-title">Run a local server</span>
              <span className="mcp-setup-choice-description">
                Configure a command, its arguments, and environment values.
              </span>
            </span>
          </button>
        </div>
      ) : preview ? (
        <div className="mcp-import-preview">
          {preview.error ? <p className="mcp-import-error">{preview.error}</p> : null}
          {!preview.error ? (
            <p className="mcp-import-summary">
              Found {preview.entries.length} {preview.entries.length === 1 ? "server" : "servers"}{" "}
              in your {preview.source} configuration.
            </p>
          ) : null}
          <div className="mcp-import-list">
            {preview.entries.map((entry) => {
              const duplicate = existingNames.includes(entry.name);
              const unavailable = Boolean(entry.error || duplicate || !entry.payload);
              return (
                <label
                  key={entry.name}
                  className="mcp-import-entry"
                  data-unavailable={unavailable || undefined}
                >
                  <input
                    type="checkbox"
                    checked={selected.has(entry.name)}
                    disabled={unavailable || importing}
                    onChange={(event) => {
                      const checked = event.currentTarget.checked;
                      setSelected((current) => {
                        const next = new Set(current);
                        if (checked) next.add(entry.name);
                        else next.delete(entry.name);
                        return next;
                      });
                    }}
                  />
                  <span className="mcp-import-entry-copy">
                    <span className="mcp-import-entry-name">{entry.name}</span>
                    <span className="mcp-import-entry-detail">
                      {duplicate
                        ? "Already connected"
                        : (entry.error ??
                          (entry.payload?.command
                            ? `Local command: ${entry.payload.command}`
                            : `Remote server: ${entry.payload?.url}`))}
                    </span>
                    {entry.warnings.map((warning) => (
                      <span key={warning} className="mcp-import-entry-warning">
                        {warning}
                      </span>
                    ))}
                  </span>
                </label>
              );
            })}
          </div>
          {importError ? <p className="mcp-import-error">{importError}</p> : null}
        </div>
      ) : (
        <div className="mcp-import-paste">
          <label className="mcp-add-label" htmlFor="mcp-import-config">
            Configuration
          </label>
          <textarea
            id="mcp-import-config"
            className="mcp-import-textarea"
            rows={12}
            value={raw}
            spellCheck={false}
            placeholder={
              '{\n  "mcpServers": {\n    "example": { "command": "npx", "args": ["server"] }\n  }\n}'
            }
            onChange={(event) => {
              setRaw(event.currentTarget.value);
              setImportError(undefined);
            }}
          />
          <p className="mcp-add-note">
            <IconShield size={13} ariaHidden />
            June reads only MCP server entries. Other app settings are ignored, and nothing is added
            until you approve the preview.
          </p>
        </div>
      )}
    </Dialog>
  );
}

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
  initialTransport,
  adding,
  existingNames,
  onClose,
  onAdd,
}: {
  open: boolean;
  initialTransport: McpServerDraft["transport"];
  adding: boolean;
  existingNames: string[];
  onClose: () => void;
  onAdd: (payload: import("../../lib/hermes-admin").HermesAddMcpServerPayload) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState<EditableDraft>(() => emptyEditableDraft(initialTransport));
  const [errors, setErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!open) return;
    setDraft(emptyEditableDraft(initialTransport));
    setErrors({});
  }, [open, initialTransport]);

  function reset() {
    setDraft(emptyEditableDraft(initialTransport));
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
      <div className="mcp-add-form">
        <section className="mcp-add-section-group" aria-labelledby="mcp-add-server-title">
          <div className="mcp-add-section-head">
            <h3 id="mcp-add-server-title" className="mcp-add-section-title">
              Server
            </h3>
            <p className="mcp-add-section-description">
              Name this connection and choose how June reaches it.
            </p>
          </div>

          <div className="mcp-add-section">
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
              <TransportSegmented
                value={draft.transport}
                onChange={(transport) => setDraft((d) => ({ ...d, transport }))}
              />
            </fieldset>
          </div>
        </section>

        {draft.transport === "stdio" ? (
          <section className="mcp-add-section-group" aria-labelledby="mcp-add-connection-title">
            <div className="mcp-add-section-head">
              <h3 id="mcp-add-connection-title" className="mcp-add-section-title">
                Connection
              </h3>
              <p className="mcp-add-section-description">
                Enter the executable, arguments, and secret environment values.
              </p>
            </div>
            <div className="mcp-add-section">
              <p className="mcp-add-note">
                <IconShield size={13} ariaHidden />
                Local servers run as subprocesses and inherit June and Hermes sandbox constraints.
                Enter only the program path here; put arguments in their own rows.
              </p>
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
            </div>
          </section>
        ) : (
          <section className="mcp-add-section-group" aria-labelledby="mcp-add-connection-title">
            <div className="mcp-add-section-head">
              <h3 id="mcp-add-connection-title" className="mcp-add-section-title">
                Connection
              </h3>
              <p className="mcp-add-section-description">
                Enter the endpoint, auth mode, and any secret request headers.
              </p>
            </div>
            <div className="mcp-add-section">
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
            </div>
          </section>
        )}
      </div>
    </Dialog>
  );
}

function TransportSegmented({
  value,
  onChange,
  disabled = false,
}: {
  value: McpServerDraft["transport"];
  onChange: (transport: McpServerDraft["transport"]) => void;
  disabled?: boolean;
}) {
  return (
    <SegmentedControl<McpServerDraft["transport"]>
      aria-label="Transport"
      className={["mcp-add-transport", disabled ? "mcp-add-transport-disabled" : undefined]
        .filter(Boolean)
        .join(" ")}
      value={value}
      onValueChange={(next) => {
        if (!disabled) onChange(next);
      }}
      options={[
        { value: "stdio", label: "Stdio" },
        { value: "http", label: "Streamable HTTP" },
      ]}
    />
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
    <fieldset className="mcp-add-field mcp-add-list-editor">
      <span className="mcp-add-label">{legend}</span>
      {values.length > 0 ? (
        <div className="mcp-add-list-head" aria-hidden>
          <span>Value</span>
          <span />
        </div>
      ) : null}
      <div className="mcp-add-list-rows">
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
              <IconTrashCan size={13} ariaHidden />
            </button>
            {errors[`${errorPrefix}.${index}`] ? (
              <p className="mcp-add-error">{errors[`${errorPrefix}.${index}`]}</p>
            ) : null}
          </div>
        ))}
      </div>
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
    <fieldset className="mcp-add-field mcp-add-list-editor">
      <span className="mcp-add-label">{legend}</span>
      {pairs.length > 0 ? (
        <div className="mcp-add-pair-head" aria-hidden>
          <span>Name</span>
          <span>Value</span>
          <span />
        </div>
      ) : null}
      <div className="mcp-add-list-rows">
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
              <IconTrashCan size={13} ariaHidden />
            </button>
            {errors[`${errorPrefix}.${index}`] ? (
              <p className="mcp-add-error">{errors[`${errorPrefix}.${index}`]}</p>
            ) : null}
          </div>
        ))}
      </div>
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
  test,
  oauthLogin,
  saving,
  saveError,
  canEdit,
  presentation = "dialog",
  onClose,
  onSignIn,
  onTest,
  onTools,
  onDelete,
  onSave,
}: {
  server?: HermesMcpServerInfo;
  test?: McpTestState;
  oauthLogin?: McpOauthLoginState;
  saving: boolean;
  saveError?: string;
  canEdit: boolean;
  /** "dialog" opens the modal (default); "page" renders the drill-in detail. */
  presentation?: "dialog" | "page";
  onClose: () => void;
  onSignIn?: () => void;
  onTest?: () => void;
  onTools?: () => void;
  onDelete?: () => void;
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
  const transport = server ? transportMeta(server.transport) : undefined;
  const auth = server ? authMeta(server.auth) : undefined;
  const status = server ? statusMeta(server.status) : undefined;
  const argsForDisplay = server ? serverArgs(server) : [];
  const env = server ? redactedEnv(server) : [];
  const headers = server ? redactedHeaders(server) : [];
  const tools = server ? (test?.result?.tools ?? server.tools ?? []) : [];
  const securityLabels = server ? inlineSecurityLabels(securityLabelsFor(server)) : [];
  const risk = server ? classifyServerRisk(server) : undefined;
  const testedOk = test?.result?.ok === true || server?.status === "connected";
  const oauth =
    server && (usesOauth(server) || oauthNeedFromMessage(test?.result?.message ?? test?.error));
  const editTransport: McpServerDraft["transport"] =
    server?.transport === "stdio" ? "stdio" : "http";

  async function handleSubmit() {
    if (!server || !canEdit) return;
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

  const footerButtons = (
    <>
      <button
        type="button"
        className="primary-action"
        onClick={() => {
          if (!saving) onClose();
        }}
        disabled={saving}
      >
        {canEdit ? "Cancel" : "Close"}
      </button>
      {canEdit ? (
        <button
          type="button"
          className="primary-action primary-solid"
          onClick={() => void handleSubmit()}
          disabled={saving}
        >
          {saving ? "Saving" : "Save changes"}
        </button>
      ) : null}
    </>
  );

  const detailBody = server ? (
    <div className="mcp-server-detail-form">
      <section className="mcp-server-detail-section" aria-label="Server overview">
        <h3 className="mcp-server-detail-heading">Overview</h3>
        <dl className="mcp-server-detail-grid">
          <DetailItem label="Transport">{transport?.label}</DetailItem>
          <DetailItem label="Status">
            <span className="mcp-server-status" data-tone={status?.tone}>
              {status ? <StatusIcon tone={status.tone} /> : null}
              {status?.label}
            </span>
          </DetailItem>
          <DetailItem label="Auth">{auth?.label}</DetailItem>
          <DetailItem label="Tools">{toolCountText(tools.length)}</DetailItem>
          <DetailItem label="Connection">
            {server.transport === "stdio"
              ? formatCommand(server.command, argsForDisplay)
              : (server.url ?? "No URL configured.")}
          </DetailItem>
          <DetailItem label="Arguments">{listText(argsForDisplay, "None")}</DetailItem>
          <DetailItem label="Environment variables">
            {secretKeysText(env, "No environment variables")}
          </DetailItem>
          <DetailItem label="Headers">{secretKeysText(headers, "No headers")}</DetailItem>
        </dl>
        {server.statusMessage ? (
          <p className="mcp-server-detail-note">{server.statusMessage}</p>
        ) : null}
        <SecurityLabels labels={securityLabels} />
        {risk?.tier === "high" ? (
          <p className="mcp-server-risk-note" data-tier="high" role="note">
            <IconExclamationCircle size={13} ariaHidden />
            {risk.reasons[0]?.detail ?? "This server can take high-impact actions."}
          </p>
        ) : null}
        {risk?.tier === "high" && testedOk ? (
          <p className="mcp-server-allowlist-note" role="note">
            <IconShield size={13} ariaHidden />
            {ALLOWLIST_RECOMMENDATION}
          </p>
        ) : null}
      </section>

      <section className="mcp-server-detail-section" aria-label="Diagnostics">
        <div className="mcp-server-detail-head">
          <h3 className="mcp-server-detail-heading">Diagnostics</h3>
          <div className="mcp-server-detail-actions">
            {onTest ? (
              <button
                type="button"
                className="mcp-detail-action"
                disabled={test?.pending}
                onClick={onTest}
              >
                {test?.pending ? "Testing" : "Test connection"}
              </button>
            ) : null}
            {onTools ? (
              <button type="button" className="mcp-detail-action" onClick={onTools}>
                <IconFilter2 size={14} ariaHidden />
                Tools
              </button>
            ) : null}
            {onDelete ? (
              <button
                type="button"
                className="mcp-detail-action mcp-detail-action-danger"
                onClick={onDelete}
              >
                <IconTrashCan size={14} ariaHidden />
                Delete server
              </button>
            ) : null}
          </div>
        </div>

        <TestResult test={test} tools={tools} />

        {oauth ? (
          <OauthStatus server={server} login={oauthLogin} testedOk={testedOk} onSignIn={onSignIn} />
        ) : null}
      </section>

      <section className="mcp-server-detail-section" aria-label="Connection fields">
        <h3 className="mcp-server-detail-heading">Connection</h3>
        <fieldset className="mcp-add-field">
          <span className="mcp-add-label">Transport</span>
          <TransportSegmented value={editTransport} onChange={() => {}} disabled />
        </fieldset>

        <p className="mcp-add-note">
          <IconShield size={13} ariaHidden />
          To change a secret or the transport, delete this server and add it again.
        </p>

        {canEdit && isStdio ? (
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
        ) : null}

        {canEdit && !isStdio ? (
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
        ) : null}

        {!canEdit ? (
          <p className="mcp-server-detail-note">
            This server's connection target cannot be edited from June.
          </p>
        ) : null}

        {saveError ? (
          <p className="mcp-add-error" role="alert">
            {saveError}
          </p>
        ) : null}
      </section>
    </div>
  ) : null;

  // The manage surface can present either as a modal (the add flow, and any
  // caller that still opens a dialog) or, in "page" mode, as a full drill-in
  // detail that pins its breadcrumb like the skills / messaging detail — same
  // shell classes, Save/Cancel carried into the bar actions.
  if (presentation === "page") {
    return (
      <div className="skill-detail-shell">
        <BreadcrumbBar
          backLabel="Back to MCP servers"
          onBack={() => {
            if (!saving) onClose();
          }}
          items={[
            {
              label: "MCP servers",
              onClick: () => {
                if (!saving) onClose();
              },
            },
            { label: server?.name ?? "" },
          ]}
          actions={footerButtons}
        />
        <div className="skill-detail-scroll" data-has-detail-bar="true">
          <section
            className="settings-page settings-group mcp-server-detail-page"
            aria-label={server?.name ?? "MCP server"}
          >
            {detailBody}
          </section>
        </div>
      </div>
    );
  }

  return (
    <Dialog
      open={Boolean(server)}
      onClose={() => {
        if (!saving) onClose();
      }}
      title={server ? `Manage ${server.name}` : "Manage server"}
      description="Review diagnostics and edit the connection target. Changes apply after the Hermes gateway restarts."
      width={640}
      className="mcp-add-dialog"
      footer={footerButtons}
    >
      {detailBody}
    </Dialog>
  );
}

function DetailItem({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="mcp-server-detail-item">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function toolCountText(count: number): string {
  if (count === 0) return "No tools";
  return `${count} ${count === 1 ? "tool" : "tools"}`;
}

function listText(values: readonly string[], empty: string): string {
  return values.length > 0 ? values.join(", ") : empty;
}

function secretKeysText(fields: readonly { key: string }[], empty: string): string {
  if (fields.length === 0) return empty;
  return fields.map((field) => field.key).join(", ");
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

/** The shared empty-state surface, with this section's glyph, so MCP reads the
 * same as Dictation/Routines/Agents when there is nothing to show. */
function EmptyState({
  title,
  description,
  className,
  action,
}: {
  title: string;
  description: string;
  className?: string;
  action?: ReactNode;
}) {
  return (
    <EmptyStateSurface
      icon={<IconServer1 size={22} />}
      title={title}
      description={description}
      className={className}
      action={action}
    />
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
