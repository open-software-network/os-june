import { listen } from "@tauri-apps/api/event";
import { IconBrowserTabs } from "central-icons/IconBrowserTabs";
import { useEffect, useState } from "react";
import {
  EXTENSION_PAIRING_CHANGED_EVENT,
  extensionPairingStatus,
  hermesBrowserAccess,
  registerBrowserExtensionHost,
  setHermesBrowserAccess,
  type ExtensionPairingStatus,
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

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
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
    void extensionPairingStatus()
      .then((current) => {
        if (!cancelled) setStatus(current);
      })
      .catch(() => {
        // Status stays unknown; the row shows "Not paired" copy below.
      });
    void listen<ExtensionPairingStatus>(EXTENSION_PAIRING_CHANGED_EVENT, (event) => {
      if (!cancelled) setStatus(event.payload);
    }).then((cleanup) => {
      if (cancelled) cleanup();
      else unlisten = cleanup;
    });
    return () => {
      cancelled = true;
      unlisten?.();
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
  const subtitle = paired
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
        {paired ? (
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
                disabled={saving !== null}
                aria-busy={saving === "connect" || undefined}
                onClick={() => void handleConnect()}
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
            disabled={grantEnabled === null || saving !== null}
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
