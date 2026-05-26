import { listen } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";
import {
  dictationHotkeyStatus,
  dictationSettings,
  setDictationShortcut,
} from "../../lib/tauri";
import type {
  DictationHelperEvent,
  DictationSettingsDto,
  DictationShortcutModifiers,
  DictationShortcutSetting,
} from "../../lib/tauri";

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

const MODIFIER_CODES = new Set([
  "AltLeft",
  "AltRight",
  "ControlLeft",
  "ControlRight",
  "MetaLeft",
  "MetaRight",
  "ShiftLeft",
  "ShiftRight",
]);

const KEY_LABELS: Record<string, string> = {
  Backquote: "`",
  Backslash: "\\",
  Backspace: "Delete",
  BracketLeft: "[",
  BracketRight: "]",
  Comma: ",",
  Digit0: "0",
  Digit1: "1",
  Digit2: "2",
  Digit3: "3",
  Digit4: "4",
  Digit5: "5",
  Digit6: "6",
  Digit7: "7",
  Digit8: "8",
  Digit9: "9",
  Enter: "Return",
  Equal: "=",
  Escape: "Esc",
  Minus: "-",
  Period: ".",
  Quote: "'",
  Semicolon: ";",
  Slash: "/",
  Space: "Space",
  Tab: "Tab",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  ArrowUp: "Up",
};

type ShortcutCaptureResult =
  | {
      shortcut: Pick<DictationShortcutSetting, "code" | "modifiers" | "label">;
      error?: never;
    }
  | { shortcut?: never; error: string };

export function DictationSettings() {
  const [settings, setSettings] =
    useState<DictationSettingsDto>(DEFAULT_SETTINGS);
  const [capturing, setCapturing] = useState(false);
  const [shortcutError, setShortcutError] = useState<string>();
  const [status, setStatus] = useState<string>();

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
    if (!capturing) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setCapturing(false);
        setShortcutError(undefined);
        return;
      }
      event.preventDefault();
      if (event.repeat) return;

      const result = shortcutFromKeyboardEvent(event);
      if ("error" in result) {
        setShortcutError(result.error);
        setStatus(result.error);
        return;
      }

      setShortcutError(undefined);
      void saveShortcut(result.shortcut);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [capturing]);

  function handleHelperEvent(helperEvent: DictationHelperEvent) {
    if (helperEvent.type === "error") {
      setStatus(helperEvent.payload?.message ?? "Dictation helper failed.");
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
                  Press this combination from anywhere on your Mac to start
                  dictating.
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
                    setShortcutError(undefined);
                    setCapturing((value) => !value);
                  }}
                >
                  {capturing ? "Cancel" : "Change"}
                </button>
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

export function shortcutFromKeyboardEvent(
  event: Pick<
    KeyboardEvent,
    "code" | "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey"
  >,
): ShortcutCaptureResult {
  if (MODIFIER_CODES.has(event.code)) {
    return { error: "Press one non-modifier key with your shortcut." };
  }
  if (!event.code) {
    return { error: "That key is not supported for global shortcuts." };
  }

  const modifiers: DictationShortcutModifiers = {
    command: event.metaKey,
    control: event.ctrlKey,
    option: event.altKey,
    shift: event.shiftKey,
    function: false,
  };
  const modifierLabels = [
    modifiers.command && "Cmd",
    modifiers.control && "Ctrl",
    modifiers.option && "Opt",
    modifiers.shift && "Shift",
  ].filter(Boolean) as string[];

  if (modifierLabels.length === 0) {
    return { error: "Shortcut must include Cmd, Ctrl, Opt, or Shift." };
  }

  return {
    shortcut: {
      code: event.code,
      modifiers,
      label: [...modifierLabels, keyLabel(event.code, event.key)].join("+"),
    },
  };
}

function keyLabel(code: string, key: string) {
  if (KEY_LABELS[code]) return KEY_LABELS[code];
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  return key.length === 1 ? key.toUpperCase() : code;
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

function messageFromError(error: unknown) {
  if (error && typeof error === "object" && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
}
