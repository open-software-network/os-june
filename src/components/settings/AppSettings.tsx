import { listen } from "@tauri-apps/api/event";
import { IconArrowRotateClockwise } from "central-icons/IconArrowRotateClockwise";
import { IconChevronDownSmall } from "central-icons/IconChevronDownSmall";
import { IconSettingsGear1 } from "central-icons/IconSettingsGear1";
import { IconCheckmark1Small } from "central-icons/IconCheckmark1Small";
import { useEffect, useRef, useState } from "react";
import {
  dictationHelperCommand,
  dictationSettings,
  openPrivacySettings,
  setDictationMicrophone,
} from "../../lib/tauri";
import type {
  DictationHelperEvent,
  DictationMicrophoneDeviceDto,
  DictationSettingsDto,
  RecordingSourceMode,
  RecordingSourceReadinessDto,
} from "../../lib/tauri";
import { Switch } from "../ui/Switch";

const DEFAULT_SETTINGS: DictationSettingsDto = {
  shortcut: {
    code: "Space",
    label: "Fn+Space",
    modifiers: {
      command: false,
      control: false,
      option: false,
      shift: false,
      function: true,
    },
  },
  microphone: {},
};

type AppSettingsProps = {
  sourceMode: RecordingSourceMode;
  sourceReadiness?: RecordingSourceReadinessDto;
  checkingSourceReadiness: boolean;
  onSourceModeChange: (mode: RecordingSourceMode) => void;
};

type DictationPermissionStatus = {
  microphone?: string;
  accessibility?: string;
};

export function AppSettings({
  sourceMode,
  sourceReadiness,
  checkingSourceReadiness,
  onSourceModeChange,
}: AppSettingsProps) {
  const [settings, setSettings] =
    useState<DictationSettingsDto>(DEFAULT_SETTINGS);
  const [microphones, setMicrophones] = useState<
    DictationMicrophoneDeviceDto[]
  >([]);
  const [permissions, setPermissions] = useState<DictationPermissionStatus>({});
  const [status, setStatus] = useState<string>();
  const [micOpen, setMicOpen] = useState(false);
  const micWrapRef = useRef<HTMLDivElement>(null);
  const systemOn = sourceMode === "microphonePlusSystem";
  const systemReadiness = sourceReadiness?.sources.find(
    (source) => source.source === "system",
  );
  const systemBlocked = !!(systemReadiness && !systemReadiness.ready);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;

    async function boot() {
      try {
        const response = await dictationSettings();
        if (cancelled) return;
        setSettings(response.settings);
        await requestMicrophones();
        await requestPermissionStatus();
      } catch (error) {
        if (!cancelled) setStatus(messageFromError(error));
      }
    }

    void listen<string>("dictation-event", (event) => {
      const helperEvent = parseDictationEvent(event.payload);
      if (helperEvent) handleHelperEvent(helperEvent);
    }).then((cleanup) => {
      unlisten = cleanup;
    });
    void boot();

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    if (!micOpen) return;
    function onPointer(event: MouseEvent) {
      if (!micWrapRef.current?.contains(event.target as Node)) {
        setMicOpen(false);
      }
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setMicOpen(false);
    }
    window.addEventListener("mousedown", onPointer);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onPointer);
      window.removeEventListener("keydown", onKey);
    };
  }, [micOpen]);

  async function requestMicrophones() {
    try {
      await dictationHelperCommand({ type: "list_microphones" });
    } catch (error) {
      setStatus(messageFromError(error));
    }
  }

  async function requestPermissionStatus() {
    try {
      await dictationHelperCommand({ type: "get_permission_status" });
    } catch (error) {
      setStatus(messageFromError(error));
    }
  }

  function handleHelperEvent(helperEvent: DictationHelperEvent) {
    if (helperEvent.type === "microphone_devices") {
      setMicrophones(helperEvent.payload?.devices ?? []);
      return;
    }
    if (
      helperEvent.type === "permission_status" ||
      helperEvent.type === "dictation_diagnostics"
    ) {
      setPermissions({
        microphone: stringPayloadValue(helperEvent.payload?.microphone),
        accessibility: stringPayloadValue(helperEvent.payload?.accessibility),
      });
      return;
    }
    if (helperEvent.type === "error") {
      setStatus(helperEvent.payload?.message ?? "Settings helper failed.");
    }
  }

  async function selectMicrophone(id?: string, name?: string) {
    try {
      const next = await setDictationMicrophone(id, name);
      setSettings(next);
      setMicOpen(false);
      setStatus(
        name ? `Microphone set to ${name}.` : "Microphone set to auto-detect.",
      );
    } catch (error) {
      setStatus(messageFromError(error));
    }
  }

  async function openPermissionPane(
    pane: "microphone" | "accessibility",
    label: string,
  ) {
    try {
      await openPrivacySettings(pane);
      setStatus(`Opened ${label} settings.`);
    } catch (error) {
      setStatus(messageFromError(error));
    }
  }

  const microphoneName = settings.microphone.name ?? "Auto-detect";
  const microphoneOptions = [
    { id: undefined, name: "Auto-detect" },
    ...microphones,
  ];
  const selectedMicrophoneIndex = Math.max(
    0,
    microphoneOptions.findIndex(
      (option) => (option.id ?? "") === (settings.microphone.id ?? ""),
    ),
  );

  return (
    <div className="settings-page">
      <header className="settings-header">
        <h1 className="settings-title">Settings</h1>
        <p className="settings-description">
          Manage audio and permissions used by notes and dictation.
        </p>
        {status ? <p className="settings-status">{status}</p> : null}
      </header>

      <section className="settings-group" aria-labelledby="audio-heading">
        <h2 id="audio-heading" className="settings-group-heading">
          Audio
        </h2>
        <div className="settings-card">
          <div className="settings-rows">
            <div className="settings-row">
              <div className="settings-row-info">
                <h3 className="settings-row-title">Dictation microphone</h3>
                <p className="settings-row-description">
                  Input device used for dictated text.
                </p>
              </div>
              <div className="settings-row-control" ref={micWrapRef}>
                <button
                  type="button"
                  className="select-trigger"
                  aria-haspopup="listbox"
                  aria-expanded={micOpen}
                  onClick={() => {
                    setMicOpen((value) => !value);
                    void requestMicrophones();
                  }}
                >
                  <span>{microphoneName}</span>
                  <IconChevronDownSmall size={14} />
                </button>
                {micOpen ? (
                  <ul
                    className="select-popover"
                    role="listbox"
                    style={{ top: -(4 + selectedMicrophoneIndex * 28) }}
                  >
                    {microphoneOptions.map((option) => {
                      const selected =
                        (option.id ?? "") === (settings.microphone.id ?? "");
                      return (
                        <li key={option.id ?? "auto"}>
                          <button
                            type="button"
                            role="option"
                            aria-selected={selected}
                            data-selected={selected}
                            onClick={() =>
                              void selectMicrophone(
                                option.id,
                                option.id ? option.name : undefined,
                              )
                            }
                          >
                            <span>{option.name}</span>
                            <span className="select-check" aria-hidden>
                              {selected ? (
                                <IconCheckmark1Small size={14} />
                              ) : null}
                            </span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                ) : null}
              </div>
            </div>

            <div className="settings-row">
              <div className="settings-row-info">
                <h3 className="settings-row-title">Note recording audio</h3>
                <p className="settings-row-description">
                  Include system audio when creating notes.
                  {systemBlocked ? (
                    <span className="settings-row-inline-error">
                      {systemReadiness?.message ??
                        "System audio is unavailable."}
                    </span>
                  ) : null}
                </p>
              </div>
              <div className="settings-row-control">
                <Switch
                  checked={systemOn}
                  disabled={
                    checkingSourceReadiness || (systemBlocked && !systemOn)
                  }
                  aria-label="Capture system audio for notes"
                  onCheckedChange={(next) =>
                    onSourceModeChange(
                      next ? "microphonePlusSystem" : "microphoneOnly",
                    )
                  }
                />
              </div>
            </div>
          </div>
        </div>
      </section>

      <section
        className="settings-group"
        aria-labelledby="app-permissions-heading"
      >
        <div className="settings-group-header">
          <h2 id="app-permissions-heading" className="settings-group-heading">
            Permissions
          </h2>
          <button
            type="button"
            className="btn btn-ghost settings-group-action"
            onClick={() => void requestPermissionStatus()}
          >
            <IconArrowRotateClockwise size={14} />
            Check again
          </button>
        </div>
        <div className="settings-card">
          <div className="settings-rows">
            <PermissionRow
              title="Microphone"
              description="Required to capture dictation and note audio."
              status={permissions.microphone}
              onOpenSettings={() =>
                void openPermissionPane("microphone", "Microphone")
              }
            />
            <PermissionRow
              title="Accessibility"
              description="Required to paste dictated text into the active app."
              status={permissions.accessibility}
              onOpenSettings={() =>
                void openPermissionPane("accessibility", "Accessibility")
              }
            />
          </div>
        </div>
      </section>
    </div>
  );
}

function PermissionRow({
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
    <div className="settings-row">
      <div className="settings-row-info">
        <h3 className="settings-row-title">{title}</h3>
        <p className="settings-row-description">{description}</p>
      </div>
      <div className="settings-row-control settings-permission-control">
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
