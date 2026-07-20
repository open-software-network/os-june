import { IconCircleCheck } from "central-icons/IconCircleCheck";
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

/**
 * Canonical front for the single native Computer use grant. Keeping management
 * in Plugins avoids a second preference surface and never implies that macOS
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
            ? "Computer use is enabled. Continue when you are ready for the macOS prompts."
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

  const requestPermissions = useCallback(async () => {
    setBusy(true);
    setMessage(undefined);
    try {
      publish(await computerUseRequestPermissions());
    } catch (error) {
      setMessage(messageFromError(error));
      await refresh();
    } finally {
      setBusy(false);
    }
  }, [publish, refresh]);

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

  const openPermissionSettings = useCallback(async (pane: "accessibility" | "screenRecording") => {
    try {
      await openPrivacySettings(pane);
    } catch (error) {
      setMessage(messageFromError(error));
    }
  }, []);

  const enabled = status?.grantEnabled === true;
  const supported = status?.platformSupported !== false;
  const planEligible = status?.planEligible !== false;
  const driverReady = status?.driverAvailable !== false;
  const rolloutDisabled = status?.state === "rollout_disabled";
  const statusErrorShownInline =
    rolloutDisabled || (supported && planEligible && !driverReady && status !== undefined);
  const permissionsMissing =
    enabled && status !== undefined && (!status.accessibility || !status.screenRecording);

  useEffect(() => {
    const element = permissionDragRef.current;
    if (!permissionsMissing || !element) {
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
  }, [permissionsMissing]);

  return (
    <div className="computer-use-control" data-state={status?.state}>
      <div className="computer-use-control-header">
        <span className="computer-use-mark" aria-hidden>
          <IconTelevision size={20} />
        </span>
        <div className="computer-use-control-heading">
          <span className="computer-use-title-line">
            <h3 className="computer-use-title">Computer use</h3>
            <span className="status-pill">Pro</span>
          </span>
          <p className="computer-use-description">
            Let June operate supported Mac apps during an attended task. Every click, keystroke,
            scroll, and edit waits for your approval.
          </p>
        </div>
        <div className="computer-use-switch-wrap">
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
      </div>

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

      {supported && status ? (
        <div className="computer-use-education">
          <IconLock size={16} aria-hidden />
          <p>
            macOS will ask for Accessibility so June can inspect and operate the target app, and
            Screen Recording so June can understand what is visible. June sends only captures needed
            for the current task to your selected model. Captures are never analytics.
          </p>
        </div>
      ) : null}

      {enabled ? (
        <div className="computer-use-setup">
          {permissionsMissing ? (
            <section className="computer-use-permission-assistant" aria-labelledby="add-june-macos">
              <div className="computer-use-permission-assistant-copy">
                <h4 id="add-june-macos">Add June to macOS</h4>
                <p>
                  Open each missing permission, then drag the helper into the open list. No Finder
                  browsing needed.
                </p>
              </div>
              <button
                ref={permissionDragRef}
                type="button"
                className="computer-use-permission-drag-card"
                aria-label="Drag June Computer Use Driver to the open System Settings list"
                onClick={() =>
                  void openPermissionSettings(
                    status?.accessibility ? "screenRecording" : "accessibility",
                  )
                }
              >
                <span className="computer-use-permission-drag-icon" aria-hidden>
                  <IconTelevision size={20} />
                </span>
                <span className="computer-use-permission-drag-copy">
                  <strong>June Computer Use Driver</strong>
                  <span>Drag to the open list</span>
                </span>
              </button>
            </section>
          ) : null}

          <section
            className="computer-use-requirements"
            aria-labelledby="computer-use-requirements"
          >
            <h4 id="computer-use-requirements" className="computer-use-requirements-heading">
              Requirements
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
              {!status?.accessibility ? (
                <button
                  type="button"
                  className="btn btn-ghost computer-use-inline-action"
                  aria-label="Open Accessibility settings"
                  onClick={() => void openPermissionSettings("accessibility")}
                >
                  Open settings
                </button>
              ) : null}
            </div>
            <div className="computer-use-requirement">
              <span className="computer-use-requirement-icon" data-ready={status?.screenRecording}>
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
              {!status?.screenRecording ? (
                <button
                  type="button"
                  className="btn btn-ghost computer-use-inline-action"
                  aria-label="Open Screen Recording settings"
                  onClick={() => void openPermissionSettings("screenRecording")}
                >
                  Open settings
                </button>
              ) : null}
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
            {permissionsMissing ? (
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy}
                onClick={() => void requestPermissions()}
              >
                Continue to macOS access
              </button>
            ) : null}
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

      {message || (!statusErrorShownInline && status?.error) ? (
        <p className="computer-use-message" role="status">
          {message || status?.error}
        </p>
      ) : null}
    </div>
  );
}
