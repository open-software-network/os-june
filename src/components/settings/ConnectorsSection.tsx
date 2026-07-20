import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useState } from "react";
import { ConnectorProviderIcon } from "../connectors/ConnectorProviderIcon";
import {
  BUNDLE_META,
  accountStatusMeta,
  bundlesForProvider,
  bundlesFromScopes,
  grantedFeatureLabels,
  isConnectorNotConfiguredError,
} from "../../lib/connectors";
import { errorCode, messageFromError } from "../../lib/errors";
import {
  CONNECTORS_CHANGED_EVENT,
  connectorsApplyRuntime,
  connectorsCancelConnect,
  connectorsConnect,
  connectorsDisconnect,
  connectorsLinearTeams,
  connectorsList,
  notionConnectorConnect,
  notionConnectorDisconnect,
  connectorsSetSelectedTeams,
  type ConnectorAccount,
  type ConnectorProvider,
  type ConnectorScopeBundle,
  type LinearTeam,
} from "../../lib/tauri";
import { Checkbox } from "../ui/Checkbox";
import { Dialog } from "../ui/Dialog";
import { InlineNotice } from "../ui/InlineNotice";
import { toast } from "../ui/Toaster";
import { SettingsPageHeader } from "./AppSettings";

// Read-only by default: Google gets mail read and calendar read, Linear gets
// workspace read. Write scopes are opt-in checkboxes, so a fresh connect
// never grants mutation authority the user did not ask for.
type OAuthConnectorProvider = Extract<ConnectorProvider, "google" | "linear">;

const DEFAULT_CONNECT_BUNDLES = {
  google: ["gmail_read", "calendar_read"],
  linear: ["linear_read"],
} satisfies Record<OAuthConnectorProvider, readonly ConnectorScopeBundle[]>;

const PROVIDER_ORDER = ["google", "linear"] as const;

const PROVIDER_NAMES = {
  google: "Google",
  linear: "Linear",
  notion: "Notion",
} satisfies Record<ConnectorProvider, string>;

/** One-line capability blurb shown while a provider is not connected: what
 * connecting it lets June do, in the provider directory row. */
const PROVIDER_BLURBS = {
  google: "Mail and calendar for briefings, triage, and meeting prep.",
  linear: "Projects, cycles, and issues for planning briefs and status updates.",
} satisfies Record<OAuthConnectorProvider, string>;

const NOTION_CONNECTOR_BLURB =
  "Pages and workspace content for briefs, search, and approved updates.";

const NOTION_CONNECTED_BLURB =
  "Pages, search, and approved updates. Access may extend beyond selected pages.";

const NOTION_RECONNECT_BLURB = "Reconnect Notion to restore pages, search, and approved updates.";

const NOTION_SEARCH_DISCLOSURE = "Search may include Notion-connected sources.";

type NotionConnectorRowProps = {
  account: ConnectorAccount | null;
  connecting: boolean;
  disconnecting: boolean;
  onConnect: () => void;
  onReconnect: () => void;
  onDisconnect: () => void;
};

type NotionConnectorState = "disconnected" | "connected" | "reconnect_required";

type NotionConnectorActionsProps = Pick<
  NotionConnectorRowProps,
  "connecting" | "disconnecting" | "onConnect" | "onReconnect" | "onDisconnect"
> & {
  state: NotionConnectorState;
};

function notionConnectorState(account: ConnectorAccount | null): NotionConnectorState {
  if (account?.status === "reconnect_required") return "reconnect_required";
  if (account?.status === "connected") return "connected";
  return "disconnected";
}

function NotionConnectorActions({
  state,
  connecting,
  disconnecting,
  onConnect,
  onReconnect,
  onDisconnect,
}: NotionConnectorActionsProps) {
  const disconnectButton = (
    <button
      type="button"
      className="btn btn-ghost"
      aria-label="Disconnect Notion"
      disabled={connecting || disconnecting}
      aria-busy={disconnecting || undefined}
      onClick={onDisconnect}
    >
      {disconnecting ? "Disconnecting…" : "Disconnect"}
    </button>
  );

  if (state === "connected") return disconnectButton;
  if (state === "reconnect_required") {
    return (
      <>
        <button
          type="button"
          className="btn btn-secondary"
          aria-label="Reconnect Notion"
          disabled={connecting}
          aria-busy={connecting || undefined}
          onClick={onReconnect}
        >
          {connecting ? "Waiting for browser…" : "Reconnect"}
        </button>
        {disconnectButton}
      </>
    );
  }
  return (
    <button
      type="button"
      className="btn btn-secondary"
      aria-label="Connect Notion"
      disabled={connecting}
      aria-busy={connecting || undefined}
      onClick={onConnect}
    >
      {connecting ? "Waiting for browser…" : "Connect"}
    </button>
  );
}

function NotionConnectorRow({
  account,
  connecting,
  disconnecting,
  onConnect,
  onReconnect,
  onDisconnect,
}: NotionConnectorRowProps) {
  const state = notionConnectorState(account);
  const details = {
    disconnected: {
      subtitle: NOTION_CONNECTOR_BLURB,
      statusLabel: null,
      statusTone: "warning",
    },
    connected: { subtitle: NOTION_CONNECTED_BLURB, statusLabel: "Connected", statusTone: "ok" },
    reconnect_required: {
      subtitle: NOTION_RECONNECT_BLURB,
      statusLabel: "Reconnect needed",
      statusTone: "warning",
    },
  } as const;
  const { subtitle, statusLabel, statusTone } = details[state];

  return (
    <li key="notion" className="connector-row">
      <span className="connector-logo" aria-hidden>
        <ConnectorProviderIcon provider="notion" />
      </span>
      <div className="connector-main">
        <span className="connector-name">Notion</span>
        <p className="connector-subtitle" title={subtitle}>
          {subtitle}
        </p>
        <p className="connector-disclosure">{NOTION_SEARCH_DISCLOSURE}</p>
      </div>
      <div className="connector-actions">
        {statusLabel ? (
          <span className="status-pill" data-tone={statusTone}>
            {statusLabel}
          </span>
        ) : null}
        <NotionConnectorActions
          state={state}
          connecting={connecting}
          disconnecting={disconnecting}
          onConnect={onConnect}
          onReconnect={onReconnect}
          onDisconnect={onDisconnect}
        />
      </div>
    </li>
  );
}

const CONNECT_TITLES = {
  google: { connect: "Connect Google account", add: "Add Google access" },
  linear: { connect: "Connect Linear workspace", add: "Add Linear access" },
} satisfies Record<OAuthConnectorProvider, { connect: string; add: string }>;

const CONNECT_TOASTS = {
  google: {
    connect: "Google account connected",
    add: "Google access updated",
    reconnect: "Google reconnected",
  },
  linear: {
    connect: "Linear workspace connected",
    add: "Linear access updated",
    reconnect: "Linear reconnected",
  },
} satisfies Record<OAuthConnectorProvider, { connect: string; add: string; reconnect: string }>;

/** True once an account holds every feature bundle its provider offers -
 * nothing left to add. */
function allBundlesGranted(account: ConnectorAccount): boolean {
  if (account.provider === "notion") return true;
  return (
    bundlesFromScopes(account.scopes, account.provider).length >=
    bundlesForProvider(account.provider).length
  );
}

/** The name to show for an account outside its row (dialog titles, toasts):
 * the workspace name for Linear, falling back to the signed-in user's email
 * and then a generic label; the email for Google. */
function accountDisplayName(account: ConnectorAccount): string {
  if (account.provider === "linear") {
    return account.workspaceName || account.email || "Linear workspace";
  }
  if (account.provider === "notion") return "Notion";
  return account.email;
}

/** The login hint the connect flow escalates on: a Google email, or the
 * Linear workspace's account id (Linear escalates by workspace, not by
 * user email). */
function loginHintFor(account: ConnectorAccount): string {
  return account.provider === "linear" ? account.accountId : account.email;
}

function featureSummary(account: ConnectorAccount): string {
  const features = grantedFeatureLabels(account.scopes, account.provider);
  return features.length > 0 ? `Can ${features.join(", ").toLowerCase()}.` : "";
}

/** The connected row's one-liner: who is connected, then what June may do,
 * then (Linear only) how many teams are selected. */
function accountSubtitle(account: ConnectorAccount): string {
  const parts = [accountDisplayName(account)];
  const summary = featureSummary(account);
  if (summary) parts.push(summary);
  if (account.provider === "linear" && account.selectedTeams.length > 0) {
    const count = account.selectedTeams.length;
    parts.push(count === 1 ? "1 team selected" : `${count} teams selected`);
  }
  return parts.join(" · ");
}

/** The connect dialog's body copy: what picking bundles here means, phrased
 * for a first connect ("this account"/"this workspace") or for adding scope
 * to an already-connected one. The sign-in surface and the kind of content
 * named swap per provider so the promise reads correctly for either. */
function connectDescription(
  provider: OAuthConnectorProvider,
  target: ConnectorAccount | null,
): string {
  const isGoogle = provider === "google";
  const lead = target
    ? `Add to what June may do with ${accountDisplayName(target)}.`
    : `Pick what June may do with this ${isGoogle ? "account" : "workspace"}.`;
  const contentPhrase = isGoogle
    ? "selected mail or calendar content"
    : "selected project and issue content";
  return `${lead} You approve everything in ${PROVIDER_NAMES[provider]}'s own sign-in, and you can disconnect any time. When a feature uses AI, ${contentPhrase} goes to your chosen model provider. Choose a local model to keep inference on this device.`;
}

/**
 * The Connectors settings page: a provider directory (one row per provider,
 * always listed) with a feature-bundle picker per provider, reconnect for
 * lapsed grants, and disconnect with optional provider-side revoke. A
 * connected Linear workspace also needs a team selection before June can
 * read or write anything in it. Local mode only: tokens live in the Mac's
 * Keychain and provider calls originate on this device.
 */
export function ConnectorsSection() {
  const [accounts, setAccounts] = useState<ConnectorAccount[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notConfigured, setNotConfigured] = useState<ConnectorProvider | null>(null);

  const [connectProvider, setConnectProvider] = useState<OAuthConnectorProvider>("google");
  const [connectOpen, setConnectOpen] = useState(false);
  const [bundles, setBundles] = useState<ConnectorScopeBundle[]>([
    ...DEFAULT_CONNECT_BUNDLES.google,
  ]);
  // The account we are adding scope to (single-account-per-provider
  // incremental auth), or null for a first-time connect. Its login hint
  // preselects that account/workspace so the backend's single-account guard
  // passes.
  const [connectTarget, setConnectTarget] = useState<ConnectorAccount | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [reconnectingId, setReconnectingId] = useState<string | null>(null);
  const [disconnectTarget, setDisconnectTarget] = useState<ConnectorAccount | null>(null);
  // Revoke defaults ON: disconnecting without it leaves the grant alive at
  // the provider AND deletes June's copy of its tokens, so June can never
  // revoke it afterward - the user is left cleaning up orphaned
  // authorizations in the provider's own settings. Opting out stays
  // available for a deliberate reconnect-soon disconnect.
  const [revoke, setRevoke] = useState(true);
  const [disconnecting, setDisconnecting] = useState(false);
  const [notionConnecting, setNotionConnecting] = useState(false);
  const [notionDisconnecting, setNotionDisconnecting] = useState(false);
  // Linear team-selection dialog: the account id it's open for (null =
  // closed). Kept separate from the fetched team list/selection so a fetch
  // failure can be retried without losing the open state.
  const [teamsAccountId, setTeamsAccountId] = useState<string | null>(null);
  const [teamsLoading, setTeamsLoading] = useState(false);
  const [teamsError, setTeamsError] = useState<string | null>(null);
  const [availableTeams, setAvailableTeams] = useState<LinearTeam[]>([]);
  const [teamsTruncated, setTeamsTruncated] = useState(false);
  const [selectedTeamIds, setSelectedTeamIds] = useState<ReadonlySet<string>>(new Set());
  const [savingTeams, setSavingTeams] = useState(false);
  // A first team save persists the grant before applying the runtime. Keep
  // that second step pending by account id until it succeeds: the persistence
  // event refreshes `accounts`, so selectedTeams alone cannot tell a retry
  // that registration still needs to be applied.
  const [runtimeApplyPendingAccountId, setRuntimeApplyPendingAccountId] = useState<string | null>(
    null,
  );

  // Previously selected teams the live listing no longer returns (archived,
  // visibility lost, or beyond the truncation cap). They must stay visible
  // and count toward the save payload, or an unrelated "Manage teams" save
  // would silently narrow the stored selection - the selection is June's
  // authorization boundary once Linear reads land.
  const teamsAccount = teamsAccountId
    ? ((accounts ?? []).find((account) => account.accountId === teamsAccountId) ?? null)
    : null;
  const missingSelectedTeams = (teamsAccount?.selectedTeams ?? []).filter(
    (team) => !availableTeams.some((live) => live.id === team.id),
  );
  // The exact set a save would persist: checked teams, with metadata from
  // the live listing when present and from the persisted selection
  // otherwise. The save button gates on THIS length, not on
  // selectedTeamIds.size, so the two can never disagree.
  const teamsPayload = [...availableTeams, ...missingSelectedTeams].filter((team) =>
    selectedTeamIds.has(team.id),
  );

  const refresh = useCallback(async () => {
    try {
      const list = await connectorsList();
      setAccounts(list);
      setLoadError(null);
    } catch (err) {
      setAccounts((current) => current ?? []);
      setLoadError(messageFromError(err));
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    void refresh();
    void listen(CONNECTORS_CHANGED_EVENT, () => void refresh()).then((cleanup) => {
      // Unmount can race the listen() promise — unsubscribe immediately
      // instead of leaking the listener.
      if (cancelled) cleanup();
      else unlisten = cleanup;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [refresh]);

  const loadTeams = useCallback(async (accountId: string) => {
    setTeamsLoading(true);
    setTeamsError(null);
    try {
      const listing = await connectorsLinearTeams({ accountId });
      setAvailableTeams(listing.teams);
      setTeamsTruncated(listing.truncated);
    } catch (err) {
      setTeamsError(messageFromError(err));
    } finally {
      setTeamsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!teamsAccountId) return;
    void loadTeams(teamsAccountId);
  }, [teamsAccountId, loadTeams]);

  async function runConnect(input: {
    provider: OAuthConnectorProvider;
    scopes: ConnectorScopeBundle[];
    loginHint?: string;
  }) {
    const account = await connectorsConnect({
      provider: input.provider,
      scopes: input.scopes,
      loginHint: input.loginHint,
    });
    // A fresh grant only takes effect once the rendered MCP config picks it
    // up: registering (or dropping) a server name is a config-render change,
    // so it needs a runtime apply for both providers. Linear teams saves
    // follow the same rule, split by whether registration changes (see
    // saveTeams below): the FIRST save registers june_linear and applies the
    // runtime; later edits only change what the already-registered server
    // may read, which Rust enforces per request - no restart. Whether
    // june_linear actually renders here (it needs at least one selected
    // team) is the Rust side's call; the frontend applies runtime on every
    // connect regardless.
    await connectorsApplyRuntime();
    await refresh();
    return account;
  }

  // Open the connect dialog for a brand-new account of the given provider
  // (only offered when none is connected), or to add scope to the one
  // existing account.
  function openConnectNew(provider: OAuthConnectorProvider) {
    setConnectProvider(provider);
    setBundles([...DEFAULT_CONNECT_BUNDLES[provider]]);
    setConnectTarget(null);
    setConnectOpen(true);
  }

  function openAddAccess(account: ConnectorAccount) {
    if (account.provider === "notion") return;
    // Preselect what the account already holds so the dialog reads as "add to
    // these"; the checkboxes the user adds are the new scopes.
    setConnectProvider(account.provider);
    setBundles(bundlesFromScopes(account.scopes, account.provider));
    setConnectTarget(account);
    setConnectOpen(true);
  }

  async function submitConnect() {
    if (bundles.length === 0 || connecting) return;
    setNotConfigured(null);
    setConnecting(true);
    try {
      const account = await runConnect({
        provider: connectProvider,
        scopes: bundles,
        loginHint: connectTarget ? loginHintFor(connectTarget) : undefined,
      });
      setConnectOpen(false);
      const toasts = CONNECT_TOASTS[connectProvider];
      toast.success(connectTarget ? toasts.add : toasts.connect);
      // A Linear connect that comes back with no teams yet — always true on a
      // first connect — needs one more step before June can read or write
      // anything in the workspace, so walk straight into team selection.
      if (connectProvider === "linear" && account.selectedTeams.length === 0) {
        openTeamsDialog(account);
      }
    } catch (err) {
      if (isConnectorNotConfiguredError(err)) {
        setNotConfigured(connectProvider);
        setConnectOpen(false);
      } else if (errorCode(err) !== "connector_connect_canceled") {
        // A user-initiated cancel rejects the in-flight connect with this
        // code; that is the expected outcome of clicking Cancel, not an
        // error to surface.
        toast.error(messageFromError(err));
      }
    } finally {
      setConnecting(false);
    }
  }

  async function connectNotion() {
    if (notionConnecting) return;
    setNotionConnecting(true);
    try {
      await notionConnectorConnect();
      await connectorsApplyRuntime();
      await refresh();
      toast.success("Notion connected");
    } catch (err) {
      toast.error(messageFromError(err));
    } finally {
      setNotionConnecting(false);
    }
  }

  async function reconnectNotion() {
    await connectNotion();
  }

  async function disconnectNotion() {
    if (notionDisconnecting) return;
    setNotionDisconnecting(true);
    try {
      await notionConnectorDisconnect();
      await connectorsApplyRuntime();
      await refresh();
      toast.success("Notion disconnected");
    } catch (err) {
      toast.error(messageFromError(err));
    } finally {
      setNotionDisconnecting(false);
    }
  }

  // Dismiss the connect dialog. While a connect is in flight ("Waiting for
  // browser…") this also aborts the backend's loopback wait, so Cancel and
  // the close button work during that window instead of being stuck until
  // the browser handoff resolves or times out.
  function dismissConnect() {
    if (connecting) void connectorsCancelConnect();
    setConnectOpen(false);
  }

  async function reconnect(account: ConnectorAccount) {
    if (account.provider === "notion") return;
    setNotConfigured(null);
    setReconnectingId(account.accountId);
    try {
      const updated = await runConnect({
        provider: account.provider,
        scopes: bundlesFromScopes(account.scopes, account.provider),
        loginHint: loginHintFor(account),
      });
      toast.success(CONNECT_TOASTS[account.provider].reconnect);
      if (account.provider === "linear" && updated.selectedTeams.length === 0) {
        openTeamsDialog(updated);
      }
    } catch (err) {
      if (isConnectorNotConfiguredError(err)) setNotConfigured(account.provider);
      else toast.error(messageFromError(err));
    } finally {
      setReconnectingId(null);
    }
  }

  async function confirmDisconnect() {
    const account = disconnectTarget;
    if (!account || disconnecting) return;
    setDisconnecting(true);
    try {
      await connectorsDisconnect({ accountId: account.accountId, revoke });
      // Same runtime-surface reasoning as runConnect: disconnecting drops the
      // provider's MCP server registration, so both providers need a runtime
      // apply here too.
      await connectorsApplyRuntime();
      await refresh();
      setDisconnectTarget(null);
      toast.success(`Disconnected ${accountDisplayName(account)}`);
    } catch (err) {
      toast.error(messageFromError(err));
    } finally {
      setDisconnecting(false);
    }
  }

  function toggleBundle(bundle: ConnectorScopeBundle, checked: boolean) {
    setBundles((current) => {
      const next = new Set(current);
      if (checked) next.add(bundle);
      else next.delete(bundle);
      return bundlesForProvider(connectProvider).filter((entry) => next.has(entry));
    });
  }

  function openTeamsDialog(account: ConnectorAccount) {
    // None preselected on a first connect; a "manage teams" open preselects
    // what is already saved.
    setSelectedTeamIds(new Set(account.selectedTeams.map((team) => team.id)));
    setAvailableTeams([]);
    setTeamsError(null);
    setTeamsAccountId(account.accountId);
  }

  function closeTeamsDialog() {
    // Cancelling on a first connect is allowed: the row falls back to its
    // "select teams to finish setup" state until the user opens it again.
    if (savingTeams) return;
    setTeamsAccountId(null);
  }

  function toggleTeam(id: string, checked: boolean) {
    setSelectedTeamIds((current) => {
      const next = new Set(current);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  async function saveTeams() {
    if (!teamsAccountId || teamsPayload.length === 0 || savingTeams) return;
    const accountId = teamsAccountId;
    setSavingTeams(true);
    try {
      // The june_linear server only registers once at least one team is
      // selected, so the FIRST teams save (zero selected before this save)
      // crosses the registration boundary and must apply the runtime - a
      // connect-then-select flow would otherwise leave the server
      // unregistered until an unrelated restart. Later edits never
      // (de)register the server: the grant is enforced per-request in Rust,
      // so they skip the restart.
      const needsRuntimeApply =
        runtimeApplyPendingAccountId === accountId ||
        (teamsAccount?.selectedTeams.length ?? 0) === 0;
      await connectorsSetSelectedTeams({ accountId, teams: teamsPayload });
      if (needsRuntimeApply) {
        setRuntimeApplyPendingAccountId(accountId);
        await connectorsApplyRuntime();
        setRuntimeApplyPendingAccountId((pendingAccountId) =>
          pendingAccountId === accountId ? null : pendingAccountId,
        );
      }
      await refresh();
      setTeamsAccountId(null);
      toast.success("Linear teams updated");
    } catch (err) {
      toast.error(messageFromError(err));
    } finally {
      setSavingTeams(false);
    }
  }

  return (
    <section className="settings-group" aria-labelledby="connectors-heading">
      <SettingsPageHeader
        id="connectors-heading"
        title="Connectors"
        blurb="Connect your accounts in local mode. Tokens stay in your Mac's Keychain, and provider calls go straight from this device. When an AI feature uses connector content, that content goes to your chosen model provider. Choose a local model to keep inference on this device."
      />

      {notConfigured ? (
        <InlineNotice
          tone="info"
          body={`${PROVIDER_NAMES[notConfigured]} connector isn't configured in this build.`}
          aria-label="Connector not configured"
        />
      ) : null}
      {loadError ? (
        <InlineNotice tone="warning" body={loadError} aria-label="Connectors load error" />
      ) : null}

      <div className="settings-card connectors-card">
        <ul className="connectors-list">
          {PROVIDER_ORDER.map((provider) => {
            const account = accounts?.find((entry) => entry.provider === provider) ?? null;
            const name = PROVIDER_NAMES[provider];
            const status = account ? accountStatusMeta(account.status, provider) : null;
            const subtitle = account ? accountSubtitle(account) : PROVIDER_BLURBS[provider];
            const reconnecting = account !== null && reconnectingId === account.accountId;
            // Linear only: a connected workspace with no teams picked yet
            // still needs one more step before June can read or write
            // anything in it.
            const needsTeams =
              account !== null && provider === "linear" && account.selectedTeams.length === 0;
            const showTeamsHint = needsTeams && account !== null && account.status === "connected";
            // Google's "Add access" stays unconditional (preserves existing
            // Google behavior); Linear hides it once both bundles are
            // granted, since there is nothing left to add.
            const showAddAccess =
              account !== null && (provider === "google" || !allBundlesGranted(account));
            return (
              <li key={provider} className="connector-row">
                <span className="connector-logo" aria-hidden>
                  <ConnectorProviderIcon provider={provider} />
                </span>
                <div className="connector-main">
                  <span className="connector-name">{name}</span>
                  <p className="connector-subtitle" title={subtitle}>
                    {subtitle}
                  </p>
                  {showTeamsHint ? (
                    <span className="status-pill" data-tone="warning">
                      Select teams to finish setup
                    </span>
                  ) : null}
                </div>
                <div className="connector-actions">
                  {account && status ? (
                    <span
                      className="status-pill"
                      data-tone={status.tone === "ok" ? "ok" : "warning"}
                      title={status.blurb}
                    >
                      {status.label}
                    </span>
                  ) : null}
                  {!account ? (
                    <button
                      type="button"
                      className="btn btn-secondary"
                      aria-label={`Connect ${name}`}
                      disabled={accounts === null}
                      onClick={() => openConnectNew(provider)}
                    >
                      Connect
                    </button>
                  ) : (
                    <>
                      {account.status === "reconnect_required" ? (
                        <button
                          type="button"
                          className="btn btn-secondary"
                          aria-label={`Reconnect ${name}`}
                          disabled={reconnectingId !== null}
                          aria-busy={reconnecting || undefined}
                          onClick={() => void reconnect(account)}
                        >
                          {reconnecting ? "Waiting for browser…" : "Reconnect"}
                        </button>
                      ) : (
                        <>
                          {provider === "linear" ? (
                            <button
                              type="button"
                              className="btn btn-secondary"
                              onClick={() => openTeamsDialog(account)}
                            >
                              {needsTeams ? "Select teams" : "Manage teams"}
                            </button>
                          ) : null}
                          {showAddAccess ? (
                            <button
                              type="button"
                              className="btn btn-secondary"
                              onClick={() => openAddAccess(account)}
                            >
                              Add access
                            </button>
                          ) : null}
                        </>
                      )}
                      <button
                        type="button"
                        className="btn btn-ghost"
                        aria-label={`Disconnect ${name}`}
                        onClick={() => {
                          setRevoke(true);
                          setDisconnectTarget(account);
                        }}
                      >
                        Disconnect
                      </button>
                    </>
                  )}
                </div>
              </li>
            );
          })}
          <NotionConnectorRow
            account={accounts?.find((entry) => entry.provider === "notion") ?? null}
            connecting={accounts === null || notionConnecting}
            disconnecting={notionDisconnecting}
            onConnect={() => void connectNotion()}
            onReconnect={() => void reconnectNotion()}
            onDisconnect={() => void disconnectNotion()}
          />
        </ul>
      </div>

      <Dialog
        open={connectOpen}
        onClose={dismissConnect}
        title={
          connectTarget
            ? CONNECT_TITLES[connectProvider].add
            : CONNECT_TITLES[connectProvider].connect
        }
        description={connectDescription(connectProvider, connectTarget)}
        footer={
          <>
            <button type="button" className="primary-action" onClick={dismissConnect}>
              Cancel
            </button>
            <button
              type="button"
              className="primary-action primary-solid"
              disabled={bundles.length === 0 || connecting}
              aria-busy={connecting || undefined}
              onClick={() => void submitConnect()}
            >
              {connecting ? "Waiting for browser…" : "Connect"}
            </button>
          </>
        }
      >
        <div className="connectors-bundle-list">
          {bundlesForProvider(connectProvider).map((bundle) => {
            const meta = BUNDLE_META[bundle];
            return (
              <label
                key={bundle}
                className="connectors-bundle-option"
                htmlFor={`connectors-bundle-${bundle}`}
              >
                <Checkbox
                  id={`connectors-bundle-${bundle}`}
                  checked={bundles.includes(bundle)}
                  disabled={connecting}
                  onChange={(event) => toggleBundle(bundle, event.currentTarget.checked)}
                />
                <span className="connectors-bundle-copy">
                  <span className="connectors-bundle-label">{meta.label}</span>
                  <span className="connectors-bundle-description">{meta.description}</span>
                </span>
              </label>
            );
          })}
        </div>
      </Dialog>

      <Dialog
        open={disconnectTarget !== null}
        onClose={() => {
          if (!disconnecting) setDisconnectTarget(null);
        }}
        title={`Disconnect ${disconnectTarget ? accountDisplayName(disconnectTarget) : ""}?`}
        description="June stops using this account and removes its tokens from your Keychain. Routines that rely on it will fail until you reconnect."
        footer={
          <>
            <button
              type="button"
              className="primary-action"
              onClick={() => setDisconnectTarget(null)}
              disabled={disconnecting}
            >
              Cancel
            </button>
            <button
              type="button"
              className="primary-action primary-solid primary-destructive"
              disabled={disconnecting}
              aria-busy={disconnecting || undefined}
              onClick={() => void confirmDisconnect()}
            >
              {disconnecting ? "Disconnecting…" : "Disconnect"}
            </button>
          </>
        }
      >
        <label className="connectors-revoke-option" htmlFor="connectors-revoke">
          <Checkbox
            id="connectors-revoke"
            checked={revoke}
            disabled={disconnecting}
            onChange={(event) => setRevoke(event.currentTarget.checked)}
          />
          Also revoke June's access with{" "}
          {disconnectTarget ? PROVIDER_NAMES[disconnectTarget.provider] : "the provider"}
        </label>
      </Dialog>

      <Dialog
        open={teamsAccountId !== null}
        onClose={closeTeamsDialog}
        title="Select Linear teams"
        description="June only reads and changes Linear data in the teams you select. You can change this any time."
        footer={
          <>
            <button
              type="button"
              className="primary-action"
              onClick={closeTeamsDialog}
              disabled={savingTeams}
            >
              Cancel
            </button>
            <button
              type="button"
              className="primary-action primary-solid"
              disabled={
                teamsPayload.length === 0 || savingTeams || teamsLoading || teamsError !== null
              }
              aria-busy={savingTeams || undefined}
              onClick={() => void saveTeams()}
            >
              {savingTeams ? "Saving…" : "Save teams"}
            </button>
          </>
        }
      >
        {teamsLoading ? (
          <p className="routines-tool-summary">Loading teams…</p>
        ) : teamsError ? (
          <InlineNotice
            tone="warning"
            body={teamsError}
            actions={
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => {
                  if (teamsAccountId) void loadTeams(teamsAccountId);
                }}
              >
                Retry
              </button>
            }
          />
        ) : (
          <>
            {teamsTruncated ? (
              <InlineNotice
                tone="info"
                body="Linear returned only the first 500 teams, so this list is incomplete."
                aria-label="Team list truncated"
              />
            ) : null}
            <div className="connectors-bundle-list">
              {availableTeams.map((team) => (
                <label
                  key={team.id}
                  className="connectors-bundle-option"
                  htmlFor={`connectors-team-${team.id}`}
                >
                  <Checkbox
                    id={`connectors-team-${team.id}`}
                    checked={selectedTeamIds.has(team.id)}
                    disabled={savingTeams}
                    onChange={(event) => toggleTeam(team.id, event.currentTarget.checked)}
                  />
                  <span className="connectors-bundle-copy">
                    <span className="connectors-bundle-label">{team.name}</span>
                    <span className="connectors-bundle-description">{team.key}</span>
                  </span>
                </label>
              ))}
              {missingSelectedTeams.map((team) => (
                <label
                  key={team.id}
                  className="connectors-bundle-option"
                  htmlFor={`connectors-team-${team.id}`}
                >
                  <Checkbox
                    id={`connectors-team-${team.id}`}
                    checked={selectedTeamIds.has(team.id)}
                    disabled={savingTeams}
                    onChange={(event) => toggleTeam(team.id, event.currentTarget.checked)}
                  />
                  <span className="connectors-bundle-copy">
                    <span className="connectors-bundle-label">{team.name}</span>
                    <span className="connectors-bundle-description">
                      {team.key} · not visible in Linear right now
                    </span>
                  </span>
                </label>
              ))}
            </div>
          </>
        )}
      </Dialog>
    </section>
  );
}
