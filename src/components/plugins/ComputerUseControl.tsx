import { IconCircleCheck } from "central-icons/IconCircleCheck";
import { IconCircleInfo } from "central-icons/IconCircleInfo";
import { IconExclamationCircle } from "central-icons/IconExclamationCircle";
import { IconLock } from "central-icons/IconLock";
import { IconStop } from "central-icons/IconStop";
import { IconTelevision } from "central-icons/IconTelevision";
import { useCallback, useEffect, useRef, useState } from "react";
import { messageFromError } from "../../lib/errors";
import {
  COMPUTER_USE_STATUS_CHANGED_EVENT,
  type ComputerUseStatusDto,
  computerUseRequestPermissions,
  computerUseStatus,
  computerUseStop,
  openPrivacySettings,
  setComputerUseGrant,
  setComputerUsePermissionDragBounds,
} from "../../lib/tauri";
import { InlineNotice } from "../ui/InlineNotice";
import { HoverTip } from "../ui/HoverTip";
import { Switch } from "../ui/Switch";

type ComputerUseControlProps = {
  onOpenModels: () => void;
  onOpenBilling: () => void;
};

function statusLabel(status?: ComputerUseStatusDto) {
  if (!status) return "Checking";
  if (!status.platformSupported) return "Unavailable";
  if (status.state === "rollout_disabled") return "Temporarily unavailable";
  if (!status.planEligible) return "Pro plan required";
  if (!status.driverAvailable) return "Driver unavailable";
  if (!status.grantEnabled) return "Off";
  if (status.ready) return "Ready";
  if (!status.accessibility || !status.screenRecording) return "Needs macOS access";
  if (!status.modelSupportsVision) return "Needs a vision model";
  return "Unavailable";
}

function requirementState(ready: boolean, enabled: boolean) {
  if (!enabled) return "Required when enabled";
  return ready ? "Allowed" : "Not allowed";
}

type MacOSPermission = "accessibility" | "screenRecording";

function permissionLabel(permission: MacOSPermission) {
  return permission === "accessibility" ? "Accessibility" : "Screen recording";
}

/**
 * Canonical front for the single native Computer use grant. Keeping management
 * in the Plugins provider list avoids a second preference surface and never implies that macOS
 * TCC access was granted by June's switch.
 */
export function ComputerUseControl({ onOpenModels, onOpenBilling }: ComputerUseControlProps) {
  const [status, setStatus] = useState<ComputerUseStatusDto>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>();
  const permissionDragRef = useRef<HTMLButtonElement>(null);

  const refresh = useCallback(async () => {
    try {
      setStatus(await computerUseStatus());
    } catch (error) {
      setMessage(messageFromError(error));
    }
  }, []);

  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const next = await computerUseStatus();
        if (active) setStatus(next);
      } catch (error) {
        if (active) setMessage(messageFromError(error));
      }
    };
    void load();
    const onFocus = () => void load();
    const onChanged = () => void load();
    window.addEventListener("focus", onFocus);
    window.addEventListener(COMPUTER_USE_STATUS_CHANGED_EVENT, onChanged);
    return () => {
      active = false;
      window.removeEventListener("focus", onFocus);
      window.removeEventListener(COMPUTER_USE_STATUS_CHANGED_EVENT, onChanged);
    };
  }, []);

  useEffect(() => {
    if (!status?.grantEnabled || status.ready) return;
    const timer = window.setInterval(() => void refresh(), 2000);
    return () => window.clearInterval(timer);
  }, [refresh, status?.grantEnabled, status?.ready]);

  const publish = useCallback((next: ComputerUseStatusDto) => {
    setStatus(next);
    window.dispatchEvent(new Event(COMPUTER_USE_STATUS_CHANGED_EVENT));
  }, []);

  const toggleGrant = useCallback(
    async (enabled: boolean) => {
      setBusy(true);
      setMessage(undefined);
      try {
        const next = await setComputerUseGrant(enabled);
        publish(next);
        setMessage(
          enabled
            ? undefined
            : "Computer use is off. Active work and pending actions were stopped.",
        );
      } catch (error) {
        setMessage(messageFromError(error));
        await refresh();
      } finally {
        setBusy(false);
      }
    },
    [publish, refresh],
  );

  const stop = useCallback(async () => {
    setBusy(true);
    setMessage(undefined);
    try {
      await computerUseStop();
      setMessage("Computer use stopped. The grant stays on for your next attended task.");
      await refresh();
    } catch (error) {
      setMessage(messageFromError(error));
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  const openPermissionSettings = useCallback(
    async (pane: "accessibility" | "screenRecording") => {
      try {
        const next = await computerUseRequestPermissions();
        publish(next);
        await openPrivacySettings(pane);
      } catch (error) {
        setMessage(messageFromError(error));
      }
    },
    [publish],
  );

  const enabled = status?.grantEnabled === true;
  const supported = status?.platformSupported !== false;
  const planEligible = status?.planEligible !== false;
  const driverReady = status?.driverAvailable !== false;
  const rolloutDisabled = status?.state === "rollout_disabled";
  const statusErrorShownInline =
    rolloutDisabled || (supported && planEligible && !driverReady && status !== undefined);
  const permissionsMissing =
    enabled && status !== undefined && (!status.accessibility || !status.screenRecording);
  const nextPermission: MacOSPermission = status?.accessibility
    ? "screenRecording"
    : "accessibility";
  const permissionStep = nextPermission === "accessibility" ? 1 : 2;

  useEffect(() => {
    const element = permissionDragRef.current;
    if (!permissionsMissing || nextPermission !== "accessibility" || !element) {
      void setComputerUsePermissionDragBounds(null);
      return;
    }

    const publishBounds = () => {
      const bounds = element.getBoundingClientRect();
      void setComputerUsePermissionDragBounds({
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
      }).catch((error) => setMessage(messageFromError(error)));
    };
    publishBounds();

    const observer =
      typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(publishBounds);
    observer?.observe(element);
    window.addEventListener("resize", publishBounds);
    window.addEventListener("scroll", publishBounds, true);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", publishBounds);
      window.removeEventListener("scroll", publishBounds, true);
      void setComputerUsePermissionDragBounds(null);
    };
  }, [nextPermission, permissionsMissing]);

  return (
    <li className="connector-row computer-use-control" data-state={status?.state}>
      <span className="connector-logo" aria-hidden>
        <IconTelevision size={20} />
      </span>
      <div className="connector-main">
        <span className="computer-use-title-line">
          <span className="connector-name">Computer use</span>
          <HoverTip
            tip={
              <>
                macOS will ask for Accessibility so June can inspect and operate the target app, and
                Screen Recording so June can understand what is visible. June sends only captures
                needed for the current task to your selected model. Captures are never analytics.
              </>
            }
            width={360}
          >
            <button
              type="button"
              className="settings-row-info-affordance"
              aria-label="Computer use privacy and permissions"
            >
              <IconCircleInfo size={13} ariaHidden />
            </button>
          </HoverTip>
        </span>
        <p className="connector-subtitle">
          Operate supported Mac apps during attended tasks. Every action waits for your approval.
        </p>
      </div>
      <div className="connector-actions">
        <span className="computer-use-state-label">{statusLabel(status)}</span>
        <Switch
          checked={enabled}
          disabled={
            busy ||
            !supported ||
            status === undefined ||
            (!enabled && (!planEligible || !driverReady || rolloutDisabled))
          }
          aria-label="Enable Computer use"
          onCheckedChange={(next) => void toggleGrant(next)}
        />
      </div>

      <div className="computer-use-details">
        {!supported ? (
          <InlineNotice
            tone="info"
            icon={<IconExclamationCircle size={16} />}
            body="Computer use is available on macOS only. Windows support is not part of this release."
          />
        ) : null}

        {supported && status && !planEligible && !rolloutDisabled ? (
          <InlineNotice
            tone="info"
            icon={<IconLock size={16} />}
            eyebrow="Pro feature"
            body="Computer use requires an active Pro or Max plan. Permission education and revocation remain available without a plan."
            actions={
              <button type="button" className="btn btn-ghost" onClick={onOpenBilling}>
                View plans
              </button>
            }
          />
        ) : null}

        {supported && status && rolloutDisabled ? (
          <InlineNotice
            tone="info"
            icon={<IconExclamationCircle size={16} />}
            eyebrow="Temporarily unavailable"
            body={status.error || "Computer use is paused for this June or macOS version."}
          />
        ) : null}

        {supported && planEligible && !driverReady && !rolloutDisabled && status ? (
          <InlineNotice
            tone="destructive"
            icon={<IconExclamationCircle size={16} />}
            eyebrow="Bundled driver unavailable"
            body={
              status.error ||
              "This build does not contain the pinned Computer use driver. Reinstall or update June."
            }
          />
        ) : null}

        {enabled ? (
          <div className="computer-use-setup">
            {permissionsMissing ? (
              <section
                className="computer-use-permission-assistant"
                aria-labelledby="add-june-macos"
              >
                <div className="computer-use-permission-assistant-header">
                  <div className="computer-use-permission-assistant-copy">
                    <span className="computer-use-permission-step">Step {permissionStep} of 2</span>
                    <h4 id="add-june-macos">Allow {permissionLabel(nextPermission)}</h4>
                    {nextPermission === "accessibility" ? (
                      <p>
                        Open System Settings, find <strong>June Computer Use Driver</strong>, and
                        turn it on. Then return to June. This page updates automatically.
                      </p>
                    ) : (
                      <p>
                        Open System Settings, find <strong>June</strong>, and turn it on. macOS
                        assigns Screen recording to June itself. Then return here. This page updates
                        automatically.
                      </p>
                    )}
                  </div>
                  <button
                    type="button"
                    className="btn btn-primary computer-use-permission-primary-action"
                    onClick={() => void openPermissionSettings(nextPermission)}
                  >
                    Open {permissionLabel(nextPermission)} settings
                  </button>
                </div>

                {nextPermission === "accessibility" ? (
                  <div className="computer-use-permission-helper">
                    <div className="computer-use-permission-helper-copy">
                      <strong>June is not in the list?</strong>
                      <p>
                        Drag the helper below into the open System Settings list, then turn it on.
                      </p>
                    </div>
                    <button
                      ref={permissionDragRef}
                      type="button"
                      className="computer-use-permission-drag-card"
                      aria-label="Drag June Computer Use Driver to the open System Settings list"
                      onClick={() => void openPermissionSettings(nextPermission)}
                    >
                      <span className="computer-use-permission-drag-icon" aria-hidden>
                        <IconTelevision size={20} />
                      </span>
                      <span className="computer-use-permission-drag-copy">
                        <strong>June Computer Use Driver</strong>
                        <span>Drag into System Settings</span>
                      </span>
                    </button>
                  </div>
                ) : null}
              </section>
            ) : null}

            <section
              className="computer-use-requirements"
              aria-labelledby="computer-use-requirements"
            >
              <h4 id="computer-use-requirements" className="computer-use-requirements-heading">
                Setup progress
              </h4>
              <div className="computer-use-requirement">
                <span className="computer-use-requirement-icon" data-ready={status?.accessibility}>
                  {status?.accessibility ? (
                    <IconCircleCheck size={15} aria-hidden />
                  ) : (
                    <IconExclamationCircle size={15} aria-hidden />
                  )}
                </span>
                <span className="computer-use-requirement-copy">
                  <strong>Accessibility</strong>
                  <span>{requirementState(status?.accessibility === true, enabled)}</span>
                </span>
              </div>
              <div className="computer-use-requirement">
                <span
                  className="computer-use-requirement-icon"
                  data-ready={status?.screenRecording}
                >
                  {status?.screenRecording ? (
                    <IconCircleCheck size={15} aria-hidden />
                  ) : (
                    <IconExclamationCircle size={15} aria-hidden />
                  )}
                </span>
                <span className="computer-use-requirement-copy">
                  <strong>Screen recording</strong>
                  <span>{requirementState(status?.screenRecording === true, enabled)}</span>
                </span>
              </div>
              <div className="computer-use-requirement">
                <span
                  className="computer-use-requirement-icon"
                  data-ready={status?.modelSupportsVision}
                >
                  {status?.modelSupportsVision ? (
                    <IconCircleCheck size={15} aria-hidden />
                  ) : (
                    <IconExclamationCircle size={15} aria-hidden />
                  )}
                </span>
                <span className="computer-use-requirement-copy">
                  <strong>Vision-capable model</strong>
                  <span>{status?.generationModel || "No model selected"}</span>
                </span>
                {!status?.modelSupportsVision ? (
                  <button
                    type="button"
                    className="btn btn-ghost computer-use-inline-action"
                    onClick={onOpenModels}
                  >
                    Choose model
                  </button>
                ) : null}
              </div>
            </section>

            <div className="computer-use-actions">
              <button
                type="button"
                className="btn btn-ghost"
                disabled={busy}
                onClick={() => void stop()}
              >
                <IconStop size={14} aria-hidden />
                Stop current task
              </button>
            </div>
          </div>
        ) : null}

        {message ||
        (status?.state !== "permission_missing" && !statusErrorShownInline && status?.error) ? (
          <p className="computer-use-message" role="status">
            {message || status?.error}
          </p>
        ) : null}
      </div>
    </li>
  );
}
