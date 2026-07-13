import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  EXTENSION_PAIRING_CHANGED_EVENT,
  extensionPairingStatus,
  registerBrowserExtensionHost,
  type ExtensionPairingStatus,
} from "../../lib/tauri";
import { SettingsPageHeader } from "./AppSettings";

/**
 * Browser use pairing skeleton (JUN-287): shows whether the June extension is
 * paired and registers the Chrome native messaging host manifest. Kept
 * self-contained; final placement in the Plugins area follows the plugins
 * design work.
 */
export function BrowserExtensionGroup() {
  const [status, setStatus] = useState<ExtensionPairingStatus | null>(null);
  const [registering, setRegistering] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
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

  async function handleSetUp() {
    setRegistering(true);
    setError(null);
    setNotice(null);
    try {
      await registerBrowserExtensionHost();
      setNotice(
        "Chrome is set up. Load the June extension in chrome://extensions (Developer mode, Load unpacked), and it will connect to June.",
      );
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : ((err as { message?: string })?.message ?? "Could not set up the browser extension."),
      );
    } finally {
      setRegistering(false);
    }
  }

  const paired = status?.paired === true;

  return (
    <section className="settings-group" aria-labelledby="browser-extension-heading">
      <SettingsPageHeader
        id="browser-extension-heading"
        title="Browser extension"
        blurb="Pair the June extension so the agent can work in your browser."
      />
      <div className="settings-card">
        <div className="settings-rows">
          <div className="settings-row">
            <div className="settings-row-info">
              <h3 className="settings-row-title">{paired ? "Paired" : "Not paired"}</h3>
              <p className="settings-row-description">
                {paired
                  ? `The June extension is connected${
                      status?.extensionVersion ? ` (version ${status.extensionVersion})` : ""
                    }.`
                  : "Set up Chrome, then load the June extension to connect it to this app."}
              </p>
            </div>
            <div className="settings-row-control">
              <button
                type="button"
                className="btn btn-secondary"
                disabled={registering}
                onClick={() => void handleSetUp()}
              >
                {registering ? "Setting up..." : "Set up browser extension"}
              </button>
            </div>
          </div>
        </div>
      </div>
      {notice ? <p className="settings-row-description">{notice}</p> : null}
      {error ? <p className="settings-row-error">{error}</p> : null}
    </section>
  );
}
