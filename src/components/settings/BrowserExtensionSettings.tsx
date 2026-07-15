import { listen } from "@tauri-apps/api/event";
import { IconBrowserTabs } from "central-icons/IconBrowserTabs";
import { useEffect, useState } from "react";
import {
  BROWSER_TRANSPORT_POLICY_CHANGED_EVENT,
  EXTENSION_PAIRING_CHANGED_EVENT,
  browserTransportPolicy,
  extensionPairingStatus,
  hermesBrowserAccess,
  registerBrowserExtensionHost,
  setHermesBrowserAccess,
  type ExtensionPairingStatus,
  type BrowserTransportPolicy,
} from "../../lib/tauri";
import { messageFromError } from "../../lib/errors";

/**
 * Browser use is a capability, not a ConnectorAccount: it has one stored grant
 * plus extension readiness. This row owns the settings-side write path for the
 * grant and keeps pairing live without teaching the OAuth account directory
 * about account-less capabilities.
 */
export function BrowserUseCapabilityRow() {
  const [grantEnabled, setGrantEnabled] = useState<boolean | null>(null);
  const [status, setStatus] = useState<ExtensionPairingStatus | null>(null);
  const [saving, setSaving] = useState<"connect" | "disconnect" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [transportEnabled, setTransportEnabled] = useState(true);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    let pairingEventObserved = false;
    void hermesBrowserAccess()
      .then((current) => {
        if (!cancelled) setGrantEnabled(current.enabled);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setGrantEnabled(false);
          setError(messageFromError(err));
        }
      });
    void browserTransportPolicy()
      .then((policy) => {
        if (!cancelled) setTransportEnabled(policy.attendedEnabled);
      })
      .catch(() => {});
    let unlistenPolicy: (() => void) | undefined;
    void listen<BrowserTransportPolicy>(BROWSER_TRANSPORT_POLICY_CHANGED_EVENT, (event) => {
      if (!cancelled) setTransportEnabled(event.payload.attendedEnabled);
    }).then((cleanup) => {
      if (cancelled) cleanup();
      else unlistenPolicy = cleanup;
    });
    void (async () => {
      try {
        const cleanup = await listen<ExtensionPairingStatus>(
          EXTENSION_PAIRING_CHANGED_EVENT,
          (event) => {
            pairingEventObserved = true;
            if (!cancelled) setStatus(event.payload);
          },
        );
        if (cancelled) {
          cleanup();
          return;
        }
        unlisten = cleanup;
      } catch {
        // Fall through to the snapshot. A failed subscription should not
        // prevent Settings from showing the current pairing state.
      }

      try {
        const current = await extensionPairingStatus();
        // An event delivered after subscription is newer than a snapshot that
        // was already in flight. Never overwrite that event with stale state.
        if (!cancelled && !pairingEventObserved) setStatus(current);
      } catch {
        // Status stays unknown; the row falls back to the not-connected
        // subtitle and the Connect action below.
      }
    })();
    return () => {
      cancelled = true;
      unlisten?.();
      unlistenPolicy?.();
    };
  }, []);

  async function handleConnect() {
    setSaving("connect");
    setError(null);
    try {
      const access = await setHermesBrowserAccess(true);
      setGrantEnabled(access.enabled);
      await registerBrowserExtensionHost();
    } catch (err) {
      setError(messageFromError(err));
    } finally {
      setSaving(null);
    }
  }

  // Partial state (grant already on, extension not yet paired): only re-register
  // the host manifest. Writing the grant again would rotate the proxy token and
  // retire both runtime modes, interrupting active agent work for no
  // authorization change, so the grant write stays on Connect/Disconnect only.
  async function handleSetup() {
    setSaving("connect");
    setError(null);
    try {
      await registerBrowserExtensionHost();
    } catch (err) {
      setError(messageFromError(err));
    } finally {
      setSaving(null);
    }
  }

  async function handleDisconnect() {
    setSaving("disconnect");
    setError(null);
    try {
      const access = await setHermesBrowserAccess(false);
      setGrantEnabled(access.enabled);
    } catch (err) {
      setError(messageFromError(err));
    } finally {
      setSaving(null);
    }
  }

  const paired = grantEnabled === true && status?.paired === true;
  const partial = grantEnabled === true && !paired;
  const subtitle = !transportEnabled
    ? "Browser use for attended sessions is temporarily unavailable."
    : paired
      ? `Paired with the June extension${
          status?.extensionVersion ? ` version ${status.extensionVersion}` : ""
        }. Browser access is on.`
      : partial
        ? "Browser access is on. Install or load the June extension in Chrome to finish setup."
        : "Operate task tabs and tabs you share. Page text and screenshots go to your chosen model for inference and may leave your device unless you use a local model.";

  return (
    <li className="connector-row" data-capability="browser-use">
      <span className="connector-logo" aria-hidden>
        <IconBrowserTabs size={20} ariaHidden />
      </span>
      <div className="connector-main">
        <span className="connector-name">Browser use</span>
        <p className="connector-subtitle" title={subtitle}>
          {subtitle}
        </p>
        {error ? (
          <p className="settings-row-error connector-capability-error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
      <div className="connector-actions">
        {!transportEnabled ? (
          <span className="status-pill" data-tone="warning">
            Temporarily unavailable
          </span>
        ) : paired ? (
          <span className="status-pill" data-tone="ok">
            Connected
          </span>
        ) : partial ? (
          <span className="status-pill" data-tone="warning">
            Finish setup
          </span>
        ) : null}
        {grantEnabled === true ? (
          <>
            {!paired ? (
              <button
                type="button"
                className="btn btn-secondary"
                disabled={saving !== null || !transportEnabled}
                aria-busy={saving === "connect" || undefined}
                onClick={() => void handleSetup()}
              >
                {saving === "connect" ? "Setting up..." : "Set up extension"}
              </button>
            ) : null}
            <button
              type="button"
              className="btn btn-ghost"
              disabled={saving !== null}
              aria-busy={saving === "disconnect" || undefined}
              onClick={() => void handleDisconnect()}
            >
              {saving === "disconnect" ? "Disconnecting..." : "Disconnect"}
            </button>
          </>
        ) : (
          <button
            type="button"
            className="btn btn-secondary"
            disabled={grantEnabled === null || saving !== null || !transportEnabled}
            aria-busy={saving === "connect" || undefined}
            onClick={() => void handleConnect()}
          >
            {saving === "connect" ? "Connecting..." : "Connect"}
          </button>
        )}
      </div>
    </li>
  );
}
