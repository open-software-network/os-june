import { listen } from "@tauri-apps/api/event";
import { IconArrowRotateClockwise } from "central-icons/IconArrowRotateClockwise";
import { IconSettingsGear1 } from "central-icons/IconSettingsGear1";
import { useEffect, useState } from "react";
import {
  checkRecordingSourceReadiness,
  dictationHelperCommand,
  openPrivacySettings,
} from "../../lib/tauri";
import type { DictationHelperEvent, SourceReadinessDto } from "../../lib/tauri";
import { Dialog } from "../ui/Dialog";

type PermissionsOnboardingProps = {
  open: boolean;
  onComplete: () => void;
};

type PermissionStatus = {
  microphone?: string;
  accessibility?: string;
  systemAudio?: string;
};

export function PermissionsOnboarding({
  open,
  onComplete,
}: PermissionsOnboardingProps) {
  const [permissions, setPermissions] = useState<PermissionStatus>({});
  const [status, setStatus] = useState<string>();

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    let unlisten: (() => void) | undefined;

    void listen<string>("dictation-event", (event) => {
      const helperEvent = parseDictationEvent(event.payload);
      if (helperEvent) {
        setPermissions((current) => ({
          ...current,
          ...permissionsFromHelperEvent(helperEvent),
        }));
        if (helperEvent.type === "error") {
          setStatus(helperEvent.payload?.message ?? "Permission check failed.");
        }
      }
    }).then((cleanup) => {
      unlisten = cleanup;
    });

    void refreshPermissions(() => cancelled);

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [open]);

  async function refreshPermissions(isCancelled: () => boolean = () => false) {
    try {
      setStatus(undefined);
      await dictationHelperCommand({ type: "get_permission_status" });
      const readiness = await checkRecordingSourceReadiness(
        "microphonePlusSystem",
      );
      if (isCancelled()) return;
      const system = readiness.sources.find(
        (source) => source.source === "system",
      );
      const microphone = readiness.sources.find(
        (source) => source.source === "microphone",
      );
      setPermissions((current) => ({
        ...current,
        microphone: current.microphone ?? sourcePermissionStatus(microphone),
        systemAudio: sourcePermissionStatus(system),
      }));
    } catch (error) {
      if (!isCancelled()) setStatus(messageFromError(error));
    }
  }

  async function openPermissionPane(
    pane: "microphone" | "accessibility" | "systemAudio",
    label: string,
  ) {
    try {
      await openPrivacySettings(pane);
      setStatus(`Opened ${label} settings.`);
    } catch (error) {
      setStatus(messageFromError(error));
    }
  }

  const allRequiredAllowed =
    permissionDisplay(permissions.microphone).state === "allowed" &&
    permissionDisplay(permissions.accessibility).state === "allowed";

  return (
    <Dialog
      open={open}
      onClose={onComplete}
      title="Set up permissions"
      description="Grant the access OS Scribe needs for recording and dictation."
      width={640}
      className="onboarding-dialog"
      disableBackdropClose
      footer={
        <>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => void refreshPermissions()}
          >
            <IconArrowRotateClockwise size={14} />
            Check again
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={onComplete}
          >
            {allRequiredAllowed ? "Continue" : "Skip for now"}
          </button>
        </>
      }
    >
      <div className="onboarding-permissions">
        <PermissionStep
          title="Microphone"
          description="Required for dictation and note recording."
          status={permissions.microphone}
          onOpenSettings={() =>
            void openPermissionPane("microphone", "Microphone")
          }
        />
        <PermissionStep
          title="Accessibility"
          description="Required for pasting dictated text into other apps."
          status={permissions.accessibility}
          onOpenSettings={() =>
            void openPermissionPane("accessibility", "Accessibility")
          }
        />
        <PermissionStep
          title="System audio"
          description="Optional for notes that include audio from other apps."
          status={permissions.systemAudio}
          onOpenSettings={() =>
            void openPermissionPane("systemAudio", "System Audio")
          }
        />
      </div>
      {status ? <p className="onboarding-status">{status}</p> : null}
    </Dialog>
  );
}

function PermissionStep({
  title,
  description,
  status,
  onOpenSettings,
}: {
  title: string;
  description: string;
  status?: string;
  onOpenSettings: () => void;
}) {
  const display = permissionDisplay(status);
  return (
    <div className="onboarding-permission-row">
      <div className="onboarding-permission-copy">
        <h3>{title}</h3>
        <p>{description}</p>
      </div>
      <div className="onboarding-permission-control">
        <span className="permission-pill" data-state={display.state}>
          {display.label}
        </span>
        <button
          type="button"
          className="btn btn-secondary"
          onClick={onOpenSettings}
        >
          <IconSettingsGear1 size={14} />
          Open
        </button>
      </div>
    </div>
  );
}

function permissionsFromHelperEvent(event: DictationHelperEvent) {
  if (
    event.type !== "permission_status" &&
    event.type !== "dictation_diagnostics"
  ) {
    return {};
  }
  const permissions: PermissionStatus = {};
  const microphone = stringPayloadValue(event.payload?.microphone);
  const accessibility = stringPayloadValue(event.payload?.accessibility);
  if (microphone) permissions.microphone = microphone;
  if (accessibility) permissions.accessibility = accessibility;
  return permissions;
}

function sourcePermissionStatus(source?: SourceReadinessDto) {
  if (!source) return undefined;
  if (source.ready) return "granted";
  return source.permissionState;
}

function parseDictationEvent(
  payload: unknown,
): DictationHelperEvent | undefined {
  try {
    if (typeof payload === "string") {
      return JSON.parse(payload) as DictationHelperEvent;
    }
    if (payload && typeof payload === "object") {
      return payload as DictationHelperEvent;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function stringPayloadValue(value: unknown) {
  return typeof value === "string" ? value : undefined;
}

function permissionDisplay(status?: string) {
  switch (status) {
    case "authorized":
    case "granted":
      return { label: "Allowed", state: "allowed" };
    case "denied":
      return { label: "Needs permission", state: "blocked" };
    case "restricted":
      return { label: "Restricted", state: "blocked" };
    case "unsupported":
      return { label: "Unsupported", state: "blocked" };
    case "not_determined":
      return { label: "Not requested", state: "waiting" };
    default:
      return { label: "Checking", state: "waiting" };
  }
}

function messageFromError(error: unknown) {
  if (error && typeof error === "object" && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
}
