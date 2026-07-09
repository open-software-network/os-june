import { listen } from "@tauri-apps/api/event";
import { IconGoogle } from "central-icons/IconGoogle";
import { IconPlusMedium } from "central-icons/IconPlusMedium";
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
  type ConnectorScopeBundle,
} from "../../lib/tauri";
import { Dialog } from "../ui/Dialog";
import { InlineNotice } from "../ui/InlineNotice";
import { toast } from "../ui/Toaster";
import { SettingsPageHeader } from "./AppSettings";

const DEFAULT_CONNECT_BUNDLES: readonly ConnectorScopeBundle[] = ["gmail_read", "calendar_events"];

/**
 * The Connectors settings page: connected Google accounts (email, granted
 * features, health), the connect flow (feature-bundle picker), reconnect for
 * lapsed grants, and disconnect with optional Google-side revoke. Local mode
 * only: tokens live in the Mac's Keychain and every Google call goes straight
 * from this device.
 */
export function ConnectorsSection() {
  const [accounts, setAccounts] = useState<ConnectorAccount[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notConfigured, setNotConfigured] = useState(false);
  const [connectOpen, setConnectOpen] = useState(false);
  const [bundles, setBundles] = useState<ConnectorScopeBundle[]>([...DEFAULT_CONNECT_BUNDLES]);
  const [connecting, setConnecting] = useState(false);
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

  async function runConnect(scopes: ConnectorScopeBundle[], loginHint?: string) {
    await connectorsConnect({ scopes, loginHint });
    // A fresh grant only takes effect once the rendered MCP config picks it
    // up; apply immediately so the user's next routine or chat sees it.
    await connectorsApplyRuntime();
    await refresh();
  }

  async function submitConnect() {
    if (bundles.length === 0 || connecting) return;
    setConnecting(true);
    try {
      await runConnect(bundles);
      setConnectOpen(false);
      toast.success("Google account connected");
    } catch (err) {
      if (isConnectorNotConfiguredError(err)) {
        setNotConfigured(true);
        setConnectOpen(false);
      } else {
        toast.error(messageFromError(err));
      }
    } finally {
      setConnecting(false);
    }
  }

  async function reconnect(account: ConnectorAccount) {
    setReconnectingId(account.accountId);
    try {
      await runConnect(bundlesFromScopes(account.scopes), account.email);
      toast.success("Google account reconnected");
    } catch (err) {
      if (isConnectorNotConfiguredError(err)) setNotConfigured(true);
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
      toast.success(`Disconnected ${account.email}`);
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

  return (
    <section className="settings-group" aria-labelledby="connectors-heading">
      <SettingsPageHeader
        id="connectors-heading"
        title="Connectors"
        blurb="Connect Google to June privately, in local mode: your tokens stay in your Mac's Keychain, every Google call goes straight from this device, and OpenSoftware's servers hold no key to your mail."
      />

      {notConfigured ? (
        <InlineNotice
          tone="info"
          body="Google connector isn't configured in this build."
          aria-label="Connector not configured"
        />
      ) : null}
      {loadError ? (
        <InlineNotice tone="warning" body={loadError} aria-label="Connectors load error" />
      ) : null}

      <div className="settings-card">
        {accounts === null ? (
          <p className="settings-status">Loading accounts…</p>
        ) : accounts.length === 0 ? (
          <div className="connectors-empty">
            <p className="settings-row-description">
              No Google account connected yet. Connect one to let routines read your mail and
              calendar, draft replies for approval, and brief you before meetings.
            </p>
          </div>
        ) : (
          <ul className="settings-rows connectors-account-list" role="list">
            {accounts.map((account) => {
              const status = accountStatusMeta(account.status);
              const features = grantedFeatureLabels(account.scopes);
              return (
                <li key={account.accountId} className="settings-row connectors-account-row">
                  <div className="settings-row-info">
                    <h3 className="settings-row-title connectors-account-email">
                      <IconGoogle size={14} aria-hidden />
                      {account.email}
                      <span className="connectors-account-status" data-tone={status.tone}>
                        {status.label}
                      </span>
                    </h3>
                    <p className="settings-row-description">
                      {features.length > 0 ? `Can ${features.join(", ").toLowerCase()}.` : ""}{" "}
                      {status.blurb}
                    </p>
                  </div>
                  <div className="settings-row-control connectors-account-actions">
                    {account.status === "reconnect_required" ? (
                      <button
                        type="button"
                        className="btn btn-secondary"
                        disabled={reconnectingId !== null}
                        aria-busy={reconnectingId === account.accountId || undefined}
                        onClick={() => void reconnect(account)}
                      >
                        {reconnectingId === account.accountId
                          ? "Waiting for browser…"
                          : "Reconnect"}
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className="btn btn-ghost"
                      onClick={() => {
                        setRevoke(false);
                        setDisconnectTarget(account);
                      }}
                    >
                      Disconnect
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        <div className="connectors-connect-row">
          <button
            type="button"
            className="primary-action primary-solid"
            onClick={() => {
              setBundles([...DEFAULT_CONNECT_BUNDLES]);
              setConnectOpen(true);
            }}
          >
            <IconPlusMedium size={13} aria-hidden />
            Connect Google account
          </button>
        </div>
      </div>

      <Dialog
        open={connectOpen}
        onClose={() => {
          if (!connecting) setConnectOpen(false);
        }}
        title="Connect Google account"
        description="Pick what June may do with this account. You approve everything in Google's own sign-in, and you can disconnect any time."
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
              <label key={bundle} className="connectors-bundle-option">
                <input
                  type="checkbox"
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
        title={`Disconnect ${disconnectTarget?.email ?? ""}?`}
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
        <label className="connectors-revoke-option">
          <input
            type="checkbox"
            checked={revoke}
            disabled={disconnecting}
            onChange={(event) => setRevoke(event.currentTarget.checked)}
          />
          Also revoke June's access with Google
        </label>
      </Dialog>
    </section>
  );
}
