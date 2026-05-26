import { listen } from "@tauri-apps/api/event";
import { IconChevronDownSmall } from "central-icons/IconChevronDownSmall";
import { IconCheckmark1Small } from "central-icons/IconCheckmark1Small";
import { useEffect, useRef, useState } from "react";
import {
  dictationHelperCommand,
  dictationHotkeyStatus,
  dictationSettings,
  setDictationActivationMode,
  setDictationMicrophone,
  setDictationShortcut,
} from "../../lib/tauri";
import type {
  DictationActivationMode,
  DictationHelperEvent,
  DictationMicrophoneDeviceDto,
  DictationSettingsDto,
  DictationShortcutModifiers,
  DictationShortcutSetting,
} from "../../lib/tauri";
import { SegmentedControl } from "../ui/SegmentedControl";

const EMPTY_MODIFIERS: DictationShortcutModifiers = {
  command: false,
  control: false,
  option: false,
  shift: false,
  function: false,
};

const BARE_FN_SHORTCUT: Pick<
  DictationShortcutSetting,
  "code" | "modifiers" | "label"
> = {
  code: "Fn",
  label: "Fn",
  modifiers: {
    ...EMPTY_MODIFIERS,
    function: true,
  },
};

const DEFAULT_SETTINGS: DictationSettingsDto = {
  shortcut: BARE_FN_SHORTCUT,
  activationMode: "push_to_talk",
  microphone: {},
};

const ACTIVATION_MODE_OPTIONS = [
  { value: "push_to_talk", label: "Push-to-talk" },
  { value: "toggle", label: "Toggle" },
] as const;

export function DictationSettings() {
  const [settings, setSettings] =
    useState<DictationSettingsDto>(DEFAULT_SETTINGS);
  const [microphones, setMicrophones] = useState<
    DictationMicrophoneDeviceDto[]
  >([]);
  const [capturing, setCapturing] = useState(false);
  const [shortcutError, setShortcutError] = useState<string>();
  const [status, setStatus] = useState<string>();
  const [micOpen, setMicOpen] = useState(false);
  const micWrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;

    async function boot() {
      try {
        const response = await dictationSettings();
        if (cancelled) return;
        setSettings(response.settings);
        const hotkey = await dictationHotkeyStatus();
        if (!cancelled) handleHelperEvent(hotkey);
        await requestMicrophones();
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

  useEffect(() => {
    if (!capturing) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        void cancelShortcutCapture();
        return;
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [capturing]);

  async function requestMicrophones() {
    try {
      await dictationHelperCommand({ type: "list_microphones" });
    } catch (error) {
      setStatus(messageFromError(error));
    }
  }

  function handleHelperEvent(helperEvent: DictationHelperEvent) {
    if (helperEvent.type === "microphone_devices") {
      setMicrophones(helperEvent.payload?.devices ?? []);
      return;
    }
    if (helperEvent.type === "error") {
      setStatus(helperEvent.payload?.message ?? "Dictation helper failed.");
      return;
    }
    if (helperEvent.type === "fn_monitor_unavailable") {
      setStatus(
        helperEvent.payload?.message ?? "Fn/Globe shortcut is unavailable.",
      );
      return;
    }
    if (helperEvent.type === "shortcut_capture_started") {
      setStatus("Press the shortcut to record it.");
      return;
    }
    if (helperEvent.type === "shortcut_capture_error") {
      const message =
        helperEvent.payload?.message ?? "Shortcut could not be captured.";
      setShortcutError(message);
      setStatus(message);
      return;
    }
    if (helperEvent.type === "shortcut_captured") {
      const shortcut = shortcutFromCapturePayload(
        helperEvent.payload?.shortcut,
      );
      if (!shortcut) {
        setShortcutError("Shortcut capture returned invalid data.");
        setStatus("Shortcut capture returned invalid data.");
        return;
      }
      setShortcutError(undefined);
      void saveShortcut(shortcut);
    }
  }

  async function saveShortcut(
    shortcut: Pick<DictationShortcutSetting, "code" | "modifiers" | "label">,
  ) {
    try {
      const next = await setDictationShortcut(shortcut);
      setSettings(next);
      setCapturing(false);
      setStatus(`Shortcut set to ${next.shortcut.label}.`);
    } catch (error) {
      setShortcutError(messageFromError(error));
      setStatus(messageFromError(error));
    }
  }

  async function startShortcutCapture() {
    setShortcutError(undefined);
    setCapturing(true);
    try {
      await dictationHelperCommand({ type: "start_shortcut_capture" });
    } catch (error) {
      setCapturing(false);
      setShortcutError(messageFromError(error));
      setStatus(messageFromError(error));
    }
  }

  async function cancelShortcutCapture() {
    setCapturing(false);
    setShortcutError(undefined);
    try {
      await dictationHelperCommand({ type: "cancel_shortcut_capture" });
    } catch (error) {
      setStatus(messageFromError(error));
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

  async function selectActivationMode(activationMode: DictationActivationMode) {
    try {
      const next = await setDictationActivationMode(activationMode);
      setSettings(next);
      setStatus(
        `Activation mode set to ${activationModeLabel(next.activationMode)}.`,
      );
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
        <h1 className="settings-title">Dictation</h1>
        <p className="settings-description">
          Dictate from anywhere on your Mac. Scribe drops the transcript
          wherever your cursor is.
        </p>
        {status ? <p className="settings-status">{status}</p> : null}
      </header>

      <section className="settings-group" aria-labelledby="shortcuts-heading">
        <h2 id="shortcuts-heading" className="settings-group-heading">
          Shortcuts
        </h2>
        <div className="settings-card">
          <div className="settings-rows">
            <div className="settings-row">
              <div className="settings-row-info">
                <h3 className="settings-row-title">Dictate anywhere</h3>
                <p className="settings-row-description">
                  Press Change, then press Fn/Globe or any supported modifier
                  shortcut.
                </p>
                {shortcutError ? (
                  <p className="settings-row-error">{shortcutError}</p>
                ) : null}
              </div>
              <div className="settings-row-control">
                <KeycapShortcut
                  label={settings.shortcut.label}
                  capturing={capturing}
                />
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => {
                    if (capturing) {
                      void cancelShortcutCapture();
                    } else {
                      void startShortcutCapture();
                    }
                  }}
                >
                  {capturing ? "Cancel" : "Change"}
                </button>
              </div>
            </div>
            <div className="settings-row">
              <div className="settings-row-info">
                <h3 className="settings-row-title">Activation mode</h3>
                <p className="settings-row-description">
                  Choose whether the shortcut records while held or toggles on
                  each press.
                </p>
              </div>
              <div className="settings-row-control">
                <SegmentedControl
                  value={settings.activationMode}
                  options={ACTIVATION_MODE_OPTIONS}
                  onValueChange={selectActivationMode}
                  aria-label="Dictation activation mode"
                />
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="settings-group" aria-labelledby="audio-heading">
        <h2 id="audio-heading" className="settings-group-heading">
          Audio
        </h2>
        <div className="settings-card">
          <div className="settings-rows">
            <div className="settings-row">
              <div className="settings-row-info">
                <h3 className="settings-row-title">Microphone</h3>
                <p className="settings-row-description">
                  Input device used when dictating and recording notes.
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
          </div>
        </div>
      </section>
    </div>
  );
}

function KeycapShortcut({
  label,
  capturing,
}: {
  label: string;
  capturing: boolean;
}) {
  if (capturing) {
    return (
      <span className="keycap-frame keycap-frame-capturing">
        Press shortcut…
      </span>
    );
  }
  const keys = label.split("+").filter(Boolean);
  return (
    <span className="keycap-frame" aria-label={`Shortcut ${label}`}>
      {keys.map((key, idx) => (
        <kbd key={`${key}-${idx}`} className="keycap">
          {key}
        </kbd>
      ))}
    </span>
  );
}

function activationModeLabel(mode: DictationActivationMode) {
  return mode === "toggle" ? "Toggle" : "Push-to-talk";
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

function shortcutFromCapturePayload(
  shortcut: unknown,
): Pick<DictationShortcutSetting, "code" | "modifiers" | "label"> | undefined {
  if (!shortcut || typeof shortcut !== "object") return undefined;

  const value = shortcut as Partial<DictationShortcutSetting>;
  const modifiers = value.modifiers;
  if (
    typeof value.code !== "string" ||
    typeof value.label !== "string" ||
    !modifiers ||
    typeof modifiers.command !== "boolean" ||
    typeof modifiers.control !== "boolean" ||
    typeof modifiers.option !== "boolean" ||
    typeof modifiers.shift !== "boolean" ||
    typeof modifiers.function !== "boolean"
  ) {
    return undefined;
  }

  return {
    code: value.code,
    label: value.label,
    modifiers,
  };
}

function messageFromError(error: unknown) {
  if (error && typeof error === "object" && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
}
