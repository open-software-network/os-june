import {
  readText as readClipboardText,
  writeText as writeClipboardText,
} from "@tauri-apps/plugin-clipboard-manager";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  companionApprovePairing,
  companionBeginPairing,
  companionListDevices,
  companionPairingStatus,
  companionRenameDevice,
  companionRevokeDevice,
  type CompanionCapability,
  type CompanionPairingQr,
  type CompanionPairingStatus,
  type LinkedCompanionDevice,
} from "../../lib/tauri";

const capabilityLabels: Record<CompanionCapability, string> = {
  notesRead: "Read notes",
  notesEdit: "Edit notes",
  agentRead: "Read agent sessions",
  agentChat: "Chat with June",
  agentCancel: "Cancel agent runs",
  settingsRead: "Read safe settings",
  settingsEditSafe: "Edit safe settings",
  recordingControlExisting: "Control an existing recording",
  appFocus: "Focus June on this Mac",
  devicesReadSelf: "Read this device",
  devicesRevokeSelf: "Unlink this device",
};
const companionCapabilities = Object.keys(capabilityLabels) as CompanionCapability[];

export function LinkedDevicesSection() {
  const [devices, setDevices] = useState<LinkedCompanionDevice[]>([]);
  const [pairing, setPairing] = useState<CompanionPairingQr>();
  const [status, setStatus] = useState<CompanionPairingStatus>();
  const [editingId, setEditingId] = useState<string>();
  const [draftName, setDraftName] = useState("");
  const [busy, setBusy] = useState(false);
  const [pairingCodeCopied, setPairingCodeCopied] = useState(false);
  const [error, setError] = useState<string>();
  const activePairingIdRef = useRef<string>();
  const copiedPairingCodeRef = useRef<string>();
  const mountedRef = useRef(true);

  const clearCopiedPairingCode = useCallback(async (pairingCode: string) => {
    try {
      if ((await readClipboardText()) === pairingCode) {
        await writeClipboardText("");
      }
    } catch {
      // Clipboard cleanup is best-effort and must not replace a pairing result.
    }
  }, []);

  const endPairing = useCallback(
    (nextError?: string) => {
      activePairingIdRef.current = undefined;
      const copiedPairingCode = copiedPairingCodeRef.current;
      copiedPairingCodeRef.current = undefined;
      if (copiedPairingCode) {
        void clearCopiedPairingCode(copiedPairingCode);
      }
      setPairing(undefined);
      setStatus(undefined);
      setPairingCodeCopied(false);
      if (nextError) setError(nextError);
    },
    [clearCopiedPairingCode],
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      activePairingIdRef.current = undefined;
      const copiedPairingCode = copiedPairingCodeRef.current;
      copiedPairingCodeRef.current = undefined;
      if (copiedPairingCode) {
        void clearCopiedPairingCode(copiedPairingCode);
      }
    };
  }, [clearCopiedPairingCode]);

  const refreshDevices = useCallback(async () => {
    setDevices(await companionListDevices());
  }, []);

  useEffect(() => {
    void refreshDevices().catch((next) => setError(errorMessage(next)));
  }, [refreshDevices]);

  useEffect(() => {
    if (!pairing) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const next = await companionPairingStatus(pairing.pairingId);
        if (!cancelled) setStatus(next);
      } catch (next) {
        if (!cancelled) setError(errorMessage(next));
      }
    };
    void poll();
    const interval = window.setInterval(() => void poll(), 1_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [pairing]);

  useEffect(() => {
    if (!pairing) return;
    const timeout = window.setTimeout(
      () => {
        endPairing("The pairing code expired. Show a new code to try again.");
      },
      Math.max(0, pairing.expiresAtMs - Date.now()),
    );
    return () => window.clearTimeout(timeout);
  }, [endPairing, pairing]);

  const qrSource = useMemo(
    () =>
      pairing ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(pairing.qrSvg)}` : undefined,
    [pairing],
  );

  const startPairing = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const next = await companionBeginPairing();
      activePairingIdRef.current = next.pairingId;
      setPairing(next);
      setStatus(undefined);
      setPairingCodeCopied(false);
    } catch (next) {
      setError(errorMessage(next));
    } finally {
      setBusy(false);
    }
  };

  const copyPairingCode = async () => {
    if (!pairing) return;
    if (pairing.expiresAtMs <= Date.now()) {
      setError("The pairing code expired. Show a new code to try again.");
      return;
    }
    setError(undefined);
    try {
      const pairingId = pairing.pairingId;
      const pairingCode = pairing.pairingCode;
      await writeClipboardText(pairingCode);
      if (
        !mountedRef.current ||
        activePairingIdRef.current !== pairingId ||
        pairing.expiresAtMs <= Date.now()
      ) {
        await clearCopiedPairingCode(pairingCode);
        return;
      }
      copiedPairingCodeRef.current = pairingCode;
      setPairingCodeCopied(true);
    } catch {
      setError("Couldn't copy the pairing code. Try again.");
    }
  };

  const approve = async () => {
    if (!pairing || !status?.mobileDeviceId) return;
    setBusy(true);
    setError(undefined);
    try {
      await companionApprovePairing(pairing.pairingId, status.mobileDeviceId);
      await refreshDevices();
      endPairing();
    } catch (next) {
      setError(errorMessage(next));
    } finally {
      setBusy(false);
    }
  };

  const saveName = async (deviceId: string) => {
    setBusy(true);
    setError(undefined);
    try {
      await companionRenameDevice(deviceId, draftName);
      await refreshDevices();
      setEditingId(undefined);
    } catch (next) {
      setError(errorMessage(next));
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (device: LinkedCompanionDevice) => {
    if (!window.confirm(`Unlink ${device.displayName}? It will lose access immediately.`)) return;
    setBusy(true);
    setError(undefined);
    try {
      await companionRevokeDevice(device.id);
      await refreshDevices();
    } catch (next) {
      setError(errorMessage(next));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="settings-group companion-settings" aria-labelledby="linked-devices-heading">
      <header className="settings-page-header">
        <h2 id="linked-devices-heading" className="settings-page-title">
          Linked devices
        </h2>
        <p className="settings-page-blurb">
          Link an iPhone or iPad from this signed-in Mac. Every link needs explicit approval here,
          and the companion never receives your account session.
        </p>
      </header>

      {error ? (
        <div className="inline-notice inline-notice-error" role="alert">
          {error}
        </div>
      ) : null}

      <div className="settings-card companion-pairing-card">
        <div className="settings-row-info">
          <h3 className="settings-row-title">Link a companion</h3>
          <p className="settings-row-description">
            Pairing codes expire after five minutes. The relay cannot read the pairing secret or any
            linked traffic.
          </p>
        </div>
        {!pairing ? (
          <button
            type="button"
            className="primary-action primary-solid"
            disabled={busy}
            onClick={() => void startPairing()}
          >
            Show pairing code
          </button>
        ) : (
          <div className="companion-pairing-flow">
            {qrSource ? (
              <img
                className="companion-pairing-qr"
                src={qrSource}
                alt="June Companion pairing code"
              />
            ) : null}
            <div className="companion-pairing-copy" aria-live="polite">
              <strong>{pairingLabel(status?.state)}</strong>
              <span>Expires {new Date(pairing.expiresAtMs).toLocaleTimeString()}</span>
              <details className="companion-manual-pairing">
                <summary>Enter a code instead</summary>
                <p>In June Companion, choose Enter pairing code, then type or paste this code.</p>
                <code
                  onCopy={() => {
                    copiedPairingCodeRef.current = pairing.pairingCode;
                    setPairingCodeCopied(true);
                  }}
                >
                  {pairing.pairingCode}
                </code>
                <button
                  type="button"
                  className="primary-action"
                  onClick={() => void copyPairingCode()}
                >
                  {pairingCodeCopied ? "Pairing code copied" : "Copy pairing code"}
                </button>
              </details>
              {status?.state === "waitingForApproval" ? (
                <>
                  <span>{status.mobileDisplayName ?? "A companion"} is asking to link.</span>
                  <span>This device will receive these capabilities:</span>
                  <ul className="companion-capabilities" aria-label="Capabilities to approve">
                    {companionCapabilities.map((capability) => (
                      <li className="companion-capability" key={capability}>
                        {capabilityLabels[capability]}
                      </li>
                    ))}
                  </ul>
                  <button
                    type="button"
                    className="primary-action primary-solid"
                    disabled={busy || !status.mobileDeviceId}
                    onClick={() => void approve()}
                  >
                    Approve this device
                  </button>
                </>
              ) : null}
              <button
                type="button"
                className="primary-action"
                onClick={() => {
                  endPairing();
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="companion-device-list">
        {devices.filter((device) => !device.revokedAt).length ? (
          devices
            .filter((device) => !device.revokedAt)
            .map((device) => (
              <article className="settings-card companion-device-card" key={device.id}>
                <div className="companion-device-heading">
                  <div>
                    {editingId === device.id ? (
                      <input
                        aria-label="Device name"
                        className="settings-text-input companion-name-input"
                        maxLength={128}
                        value={draftName}
                        onChange={(event) => setDraftName(event.target.value)}
                      />
                    ) : (
                      <h3 className="settings-row-title">{device.displayName}</h3>
                    )}
                    <p className="settings-row-description">
                      Linked {formatDate(device.linkedAt)}
                      {device.lastSeenAt ? ` · Last seen ${formatDate(device.lastSeenAt)}` : ""}
                    </p>
                  </div>
                  <div className="companion-device-actions">
                    {editingId === device.id ? (
                      <>
                        <button
                          type="button"
                          className="primary-action primary-solid"
                          disabled={busy || !draftName.trim()}
                          onClick={() => void saveName(device.id)}
                        >
                          Save
                        </button>
                        <button
                          type="button"
                          className="primary-action"
                          onClick={() => setEditingId(undefined)}
                        >
                          Cancel
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          type="button"
                          className="primary-action"
                          onClick={() => {
                            setEditingId(device.id);
                            setDraftName(device.displayName);
                          }}
                        >
                          Rename
                        </button>
                        <button
                          type="button"
                          className="primary-action primary-destructive"
                          disabled={busy}
                          onClick={() => void revoke(device)}
                        >
                          Unlink
                        </button>
                      </>
                    )}
                  </div>
                </div>
                <ul className="companion-capabilities" aria-label="Granted capabilities">
                  {device.capabilities.map((capability) => (
                    <li className="companion-capability" key={capability}>
                      {capabilityLabels[capability]}
                    </li>
                  ))}
                </ul>
              </article>
            ))
        ) : (
          <div className="settings-card companion-empty-device">
            <h3 className="settings-row-title">No linked devices</h3>
            <p className="settings-row-description">
              Link a companion above to access June when you are away from this Mac.
            </p>
          </div>
        )}
      </div>
    </section>
  );
}

function pairingLabel(state?: CompanionPairingStatus["state"]) {
  if (state === "waitingForApproval") return "Approve the device on this Mac";
  if (state === "approved") return "Device approved";
  if (state === "expired") return "Pairing code expired";
  return "Scan this code in June Companion";
}

function formatDate(value: string) {
  return new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function errorMessage(error: unknown) {
  if (typeof error === "object" && error && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return "Linked devices are unavailable right now.";
}
