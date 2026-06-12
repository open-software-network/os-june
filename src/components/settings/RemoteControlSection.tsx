import { useCallback, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  remoteStartPairing,
  remoteStatus,
  remoteStop,
  type RemoteStatus,
} from "../../lib/tauri";

/**
 * "Control from your phone": pair a phone to drive June remotely. Starting
 * mints a code and opens the relay; the user opens the mobile URL on their
 * phone and types the code. The row reflects live link state (waiting for the
 * phone, then connected) from the `remote-status` event the host emits.
 */
export function RemoteControlSection() {
  const [status, setStatus] = useState<RemoteStatus>({
    active: false,
    controllerOnline: false,
  });
  const [code, setCode] = useState<string>();
  const [mobileUrl, setMobileUrl] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const refresh = useCallback(async () => {
    try {
      const next = await remoteStatus();
      setStatus(next);
      if (next.active) {
        setCode(next.code);
        setMobileUrl(next.mobileUrl);
      }
    } catch {
      // Status is best-effort; leave the last known state.
    }
  }, []);

  useEffect(() => {
    void refresh();
    const unlisten = listen<RemoteStatus & { error?: string }>(
      "remote-status",
      (event) => {
        const payload = event.payload;
        if (payload.error) setError(payload.error);
        // The event carries partial state; merge what it includes.
        setStatus((current) => ({
          active: payload.active,
          code: payload.code ?? current.code,
          mobileUrl: payload.mobileUrl ?? current.mobileUrl,
          controllerOnline:
            payload.controllerOnline ?? current.controllerOnline,
        }));
      },
    );
    return () => {
      void unlisten.then((dispose) => dispose());
    };
  }, [refresh]);

  async function start() {
    setError(undefined);
    setBusy(true);
    try {
      const pairing = await remoteStartPairing();
      setCode(pairing.code);
      setMobileUrl(pairing.mobileUrl);
      setStatus({ active: true, code: pairing.code, controllerOnline: false });
    } catch (caught) {
      setError(messageFromError(caught));
    } finally {
      setBusy(false);
    }
  }

  async function stop() {
    setBusy(true);
    try {
      await remoteStop();
      setStatus({ active: false, controllerOnline: false });
      setCode(undefined);
    } catch (caught) {
      setError(messageFromError(caught));
    } finally {
      setBusy(false);
    }
  }

  const host = mobileUrl ? hostOf(mobileUrl) : undefined;

  return (
    <div className="settings-row">
      <div className="settings-row-info">
        <h3 className="settings-row-title">Control from your phone</h3>
        <p className="settings-row-description">
          Pair your phone to send June tasks while you&apos;re away from your
          Mac. The agent runs here; your phone just talks to it.
        </p>
        {status.active && code ? (
          <div className="remote-pairing">
            <p className="remote-pairing-step">
              On your phone, open{" "}
              {host ? <strong>{host}/m</strong> : <strong>the June phone page</strong>}{" "}
              and enter this code:
            </p>
            <p className="remote-code" aria-label="Pairing code">
              {code}
            </p>
            <p className="remote-pairing-status" role="status">
              {status.controllerOnline
                ? "Your phone is connected."
                : "Waiting for your phone..."}
            </p>
          </div>
        ) : null}
        {error ? <p className="welcome-status">{error}</p> : null}
      </div>
      <div className="settings-row-control">
        {status.active ? (
          <button
            type="button"
            className="btn btn-secondary"
            disabled={busy}
            onClick={() => void stop()}
          >
            {busy ? "Stopping…" : "Stop sharing"}
          </button>
        ) : (
          <button
            type="button"
            className="btn btn-secondary"
            disabled={busy}
            onClick={() => void start()}
          >
            {busy ? "Starting…" : "Pair a phone"}
          </button>
        )}
      </div>
    </div>
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  }
}

function messageFromError(error: unknown) {
  if (error && typeof error === "object" && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
}
