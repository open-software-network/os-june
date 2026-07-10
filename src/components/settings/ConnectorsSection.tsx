import { listen } from "@tauri-apps/api/event";
import { IconGoogle } from "central-icons/IconGoogle";
import { IconLinear } from "central-icons/IconLinear";
import { IconNotion } from "central-icons/IconNotion";
import { useCallback, useEffect, useState } from "react";
import {
  ALL_SCOPE_BUNDLES,
  BUNDLE_META,
  accountStatusMeta,
  bundlesFromScopes,
  grantedFeatureLabels,
  isConnectorNotConfiguredError,
} from "../../lib/connectors";
import { messageFromError } from "../../lib/errors";
import {
  CONNECTORS_CHANGED_EVENT,
  connectorsApplyRuntime,
  connectorsConnect,
  connectorsDisconnect,
  connectorsList,
  type ConnectorAccount,
  type ConnectorProvider,
  type ConnectorScopeBundle,
} from "../../lib/tauri";
import { Checkbox } from "../ui/Checkbox";
import { Dialog } from "../ui/Dialog";
import { InlineNotice } from "../ui/InlineNotice";
import { toast } from "../ui/Toaster";
import { SettingsPageHeader } from "./AppSettings";

// Read-only by default: mail read and calendar read. Write scopes (draft,
// send, organize, manage calendar) are opt-in checkboxes, so a fresh connect
// never grants mutation authority the user did not ask for.
const DEFAULT_CONNECT_BUNDLES: readonly ConnectorScopeBundle[] = ["gmail_read", "calendar_read"];

const PROVIDER_ORDER: readonly ConnectorProvider[] = ["google", "notion", "linear"];

const PROVIDER_NAMES: Readonly<Record<ConnectorProvider, string>> = {
  google: "Google",
  notion: "Notion",
  linear: "Linear",
};

/** One-line capability blurb shown while a provider is not connected: what
 * connecting it lets June do, in the provider directory row. */
const PROVIDER_BLURBS: Readonly<Record<ConnectorProvider, string>> = {
  google: "Mail and calendar for briefings, triage, and meeting prep.",
  notion: "Search, read, and create pages in your workspace.",
  linear: "Read issues, create issues and comments, and watch assignments.",
};

function ProviderIcon({ provider, size = 18 }: { provider: ConnectorProvider; size?: number }) {
  if (provider === "notion") return <IconNotion size={size} aria-hidden />;
  if (provider === "linear") return <IconLinear size={size} aria-hidden />;
  return <IconGoogle size={size} aria-hidden />;
}

function featureSummary(account: ConnectorAccount): string {
  if (account.provider === "google") {
    const features = grantedFeatureLabels(account.scopes);
    return features.length > 0 ? `Can ${features.join(", ").toLowerCase()}.` : "";
  }
  if (account.provider === "notion") return "Can search, read, and create pages.";
  return "Can read issues, create issues and comments, and watch assignments.";
}

/** The connected row's one-liner: who is connected, then what June may do. */
function accountSubtitle(account: ConnectorAccount): string {
  const summary = featureSummary(account);
  return summary ? `${account.displayName} · ${summary}` : account.displayName;
}

/**
 * The Connectors settings page: a provider directory (one row per provider,
 * always listed) with Google's feature-bundle picker, reconnect for lapsed
 * grants, and disconnect with optional provider-side revoke. Local mode only:
 * tokens live in the Mac's Keychain and provider calls originate on this
 * device.
 */
export function ConnectorsSection() {
  const [accounts, setAccounts] = useState<ConnectorAccount[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notConfigured, setNotConfigured] = useState<ConnectorProvider | null>(null);
  const [connectOpen, setConnectOpen] = useState(false);
  const [bundles, setBundles] = useState<ConnectorScopeBundle[]>([...DEFAULT_CONNECT_BUNDLES]);
  // Email of the account we are adding scope to (single-account incremental
  // auth), or null for a first-time connect. Sent as the login hint so Google
  // preselects that account and the backend's single-account guard passes.
  const [connectHint, setConnectHint] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [connectingProvider, setConnectingProvider] = useState<ConnectorProvider | null>(null);
  const [reconnectingId, setReconnectingId] = useState<string | null>(null);
  const [disconnectTarget, setDisconnectTarget] = useState<ConnectorAccount | null>(null);
  const [revoke, setRevoke] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);

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

  async function runConnect(input: {
    provider: ConnectorProvider;
    scopes?: ConnectorScopeBundle[];
    loginHint?: string;
    accountId?: string;
  }) {
    await connectorsConnect(input);
    // A fresh grant only takes effect once the rendered MCP config picks it
    // up; apply immediately so the user's next routine or chat sees it.
    await connectorsApplyRuntime();
    await refresh();
  }

  async function connectProvider(provider: Exclude<ConnectorProvider, "google">) {
    if (connectingProvider) return;
    setNotConfigured(null);
    setConnectingProvider(provider);
    try {
      await runConnect({ provider });
      toast.success(`${PROVIDER_NAMES[provider]} connected`);
    } catch (err) {
      if (isConnectorNotConfiguredError(err)) setNotConfigured(provider);
      else toast.error(messageFromError(err));
    } finally {
      setConnectingProvider(null);
    }
  }

  // Open the connect dialog for a brand-new account (only offered when none is
  // connected), or to add scope to the one existing account.
  function openConnectNew() {
    setBundles([...DEFAULT_CONNECT_BUNDLES]);
    setConnectHint(null);
    setConnectOpen(true);
  }

  function openAddAccess(account: ConnectorAccount) {
    // Preselect what the account already holds so the dialog reads as "add to
    // these"; the checkboxes the user adds are the new scopes.
    setBundles(bundlesFromScopes(account.scopes));
    setConnectHint(account.email ?? account.displayName);
    setConnectOpen(true);
  }

  async function submitConnect() {
    if (bundles.length === 0 || connecting) return;
    setNotConfigured(null);
    setConnecting(true);
    try {
      await runConnect({
        provider: "google",
        scopes: bundles,
        loginHint: connectHint ?? undefined,
      });
      setConnectOpen(false);
      toast.success(connectHint ? "Google access updated" : "Google account connected");
    } catch (err) {
      if (isConnectorNotConfiguredError(err)) {
        setNotConfigured("google");
        setConnectOpen(false);
      } else {
        toast.error(messageFromError(err));
      }
    } finally {
      setConnecting(false);
    }
  }

  async function reconnect(account: ConnectorAccount) {
    setNotConfigured(null);
    setReconnectingId(account.accountId);
    try {
      if (account.provider === "google") {
        await runConnect({
          provider: "google",
          scopes: bundlesFromScopes(account.scopes),
          loginHint: account.email,
        });
      } else {
        await runConnect({ provider: account.provider, accountId: account.accountId });
      }
      toast.success(`${PROVIDER_NAMES[account.provider]} reconnected`);
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
      await connectorsApplyRuntime();
      await refresh();
      setDisconnectTarget(null);
      toast.success(`Disconnected ${account.displayName}`);
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
      return ALL_SCOPE_BUNDLES.filter((entry) => next.has(entry));
    });
  }

  function connectRow(provider: ConnectorProvider) {
    if (provider === "google") openConnectNew();
    else void connectProvider(provider);
  }

  return (
    <section className="settings-group" aria-labelledby="connectors-heading">
      <SettingsPageHeader
        id="connectors-heading"
        title="Connectors"
        blurb="Connect Google, Notion, and Linear in local mode: one account or workspace per provider. Tokens stay in your Mac's Keychain, and provider calls go straight from this device."
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
            return (
              <li key={provider} className="connector-row">
                <span className="connector-logo" aria-hidden>
                  <ProviderIcon provider={provider} />
                </span>
                <div className="connector-main">
                  <span className="connector-name">{name}</span>
                  <p className="connector-subtitle" title={subtitle}>
                    {subtitle}
                  </p>
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
                      disabled={accounts === null || connectingProvider !== null}
                      aria-busy={connectingProvider === provider || undefined}
                      onClick={() => connectRow(provider)}
                    >
                      {connectingProvider === provider ? "Waiting for browser…" : "Connect"}
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
                      ) : provider === "google" ? (
                        <button
                          type="button"
                          className="btn btn-secondary"
                          onClick={() => openAddAccess(account)}
                        >
                          Add access
                        </button>
                      ) : null}
                      <button
                        type="button"
                        className="btn btn-ghost"
                        aria-label={`Disconnect ${name}`}
                        onClick={() => {
                          setRevoke(false);
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
        </ul>
      </div>

      <Dialog
        open={connectOpen}
        onClose={() => {
          if (!connecting) setConnectOpen(false);
        }}
        title={connectHint ? "Add Google access" : "Connect Google account"}
        description={
          connectHint
            ? `Add to what June may do with ${connectHint}. You approve everything in Google's own sign-in, and you can disconnect any time.`
            : "Pick what June may do with this account. You approve everything in Google's own sign-in, and you can disconnect any time."
        }
        footer={
          <>
            <button
              type="button"
              className="primary-action"
              onClick={() => setConnectOpen(false)}
              disabled={connecting}
            >
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
          {ALL_SCOPE_BUNDLES.map((bundle) => {
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
        title={`Disconnect ${disconnectTarget?.displayName ?? ""}?`}
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
    </section>
  );
}
