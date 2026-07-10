import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { parseDictationHelperEvent } from "../../lib/dictation-events";
import { isWindowsPlatform } from "../../lib/platform";
import { dictationHelperCommand, setDictationShortcut } from "../../lib/tauri";
import type {
  DictationSettingsDto,
  DictationShortcutKind,
  DictationShortcutSetting,
} from "../../lib/tauri";

export type CapturedShortcut = Pick<
  DictationShortcutSetting,
  "code" | "modifiers" | "label" | "pressCount"
>;

/**
 * Record-a-shortcut flow with two capture sources, neither of which needs
 * the Input Monitoring permission:
 *
 * - Key chords are read from DOM keydown right here: the rebind UI only
 *   runs while June's window is focused, so ordinary keystrokes reach the
 *   webview without any global monitoring.
 * - fn and bare-modifier chords never reach the DOM, so `start()` also puts
 *   the dictation helper into capture mode; its flagsChanged-only monitor
 *   (covered by the Accessibility permission June already holds) reports
 *   them back as a `shortcut_captured` event.
 *
 * Both paths persist through `setDictationShortcut`, whose backend rejects
 * unsupported keys with a clear error. Escape cancels.
 */
export function useShortcutCapture({
  kind,
  onSaved,
}: {
  kind: DictationShortcutKind;
  /** Fires after the chord is captured AND persisted. `saved` is the
   * settings snapshot the backend returned (undefined in stubbed envs). */
  onSaved?: (saved: DictationSettingsDto | undefined, captured: CapturedShortcut) => void;
}) {
  const [capturing, setCapturing] = useState(false);
  const [error, setError] = useState<string>();

  // Read through a ref so the capture effect never closes over stale props.
  const callbacksRef = useRef({ kind, onSaved });
  useEffect(() => {
    callbacksRef.current = { kind, onSaved };
  });

  const cancel = useCallback(async () => {
    setCapturing(false);
    try {
      await dictationHelperCommand({ type: "cancel_shortcut_capture" });
    } catch {
      // Helper gone means there is no capture left to cancel.
    }
  }, []);

  const start = useCallback(async () => {
    setError(undefined);
    setCapturing(true);
    try {
      await dictationHelperCommand({
        type: "start_shortcut_capture",
        kind,
        pressCount: 1,
      });
    } catch (caught) {
      setCapturing(false);
      setError(messageFromError(caught));
    }
  }, []);

  useEffect(() => {
    if (!capturing) return;

    let active = true;
    const unlisten = listen<string>("dictation-event", (event) => {
      if (!active) return;
      const helperEvent = parseDictationHelperEvent(event.payload);
      if (!helperEvent) return;
      if (helperEvent.type === "shortcut_capture_error") {
        setError(helperEvent.payload?.message ?? "Shortcut could not be captured.");
        setCapturing(false);
        return;
      }
      if (helperEvent.type !== "shortcut_captured") return;
      const captured = shortcutFromCapturePayload(helperEvent.payload?.shortcut, 1);
      if (!captured) {
        setError("Shortcut capture returned invalid data.");
        setCapturing(false);
        return;
      }
      persistCaptured(captured);
    });

    function persistCaptured(captured: CapturedShortcut) {
      const current = callbacksRef.current;
      setDictationShortcut(current.kind, captured)
        .then((saved) => {
          if (!active) return;
          setCapturing(false);
          current.onSaved?.(saved ?? undefined, captured);
        })
        .catch((caught) => {
          if (!active) return;
          setCapturing(false);
          setError(messageFromError(caught));
        });
    }

    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        void cancel();
        return;
      }
      const result = chordFromKeyEvent(event);
      if (result.kind === "ignore") return;
      event.preventDefault();
      event.stopPropagation();
      if (result.kind === "needsModifier") {
        setError(modifierRequiredMessage());
        return;
      }
      // Stop the helper's capture before persisting: the chord is decided.
      void dictationHelperCommand({ type: "cancel_shortcut_capture" }).catch(() => undefined);
      persistCaptured(result.shortcut);
    }
    window.addEventListener("keydown", onKey, true);

    return () => {
      active = false;
      window.removeEventListener("keydown", onKey, true);
      void unlisten.then((fn) => fn());
    };
  }, [capturing, cancel]);

  // Unmounting mid-capture (user navigates away) must release the helper's
  // event tap, or the next dictation keypress gets eaten as a "capture".
  const capturingRef = useRef(capturing);
  useEffect(() => {
    capturingRef.current = capturing;
  }, [capturing]);
  useEffect(() => {
    return () => {
      if (capturingRef.current) {
        void dictationHelperCommand({ type: "cancel_shortcut_capture" }).catch(() => undefined);
      }
    };
  }, []);

  return { capturing, error, start, cancel };
}

export function shortcutFromCapturePayload(
  shortcut: unknown,
  fallbackPressCount: 1 | 2,
): CapturedShortcut | undefined {
  if (!shortcut || typeof shortcut !== "object") return undefined;

  const value = shortcut as Partial<DictationShortcutSetting>;
  const modifiers = value.modifiers;
  const pressCount =
    value.pressCount === 1 || value.pressCount === 2 ? value.pressCount : fallbackPressCount;
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
    pressCount,
  };
}

/** What a keydown means for an in-progress capture. Bare modifier presses
 * are ignored here (the helper's flagsChanged monitor owns those, since the
 * DOM cannot see fn); a real key either completes a chord or, without any
 * modifier, asks the user for one. */
export type CaptureKeyResult =
  | { kind: "ignore" }
  | { kind: "needsModifier" }
  | { kind: "chord"; shortcut: CapturedShortcut };

export const MODIFIER_REQUIRED_MESSAGE = "Shortcut must include Cmd, Ctrl, Opt, Shift, or Fn.";

export function modifierRequiredMessage() {
  return isWindowsPlatform()
    ? "Shortcut must include Ctrl, Alt, Shift, or Win."
    : MODIFIER_REQUIRED_MESSAGE;
}

export function chordFromKeyEvent(event: KeyboardEvent): CaptureKeyResult {
  if (["Shift", "Control", "Alt", "Meta"].includes(event.key)) {
    return { kind: "ignore" };
  }
  if (!event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) {
    return { kind: "needsModifier" };
  }
  const windows = isWindowsPlatform();
  const modifiers = {
    command: event.metaKey,
    control: event.ctrlKey,
    option: event.altKey,
    shift: event.shiftKey,
    function: false,
  };
  const label = [
    modifiers.command ? (windows ? "Win" : "Cmd") : undefined,
    modifiers.control ? "Ctrl" : undefined,
    modifiers.option ? (windows ? "Alt" : "Opt") : undefined,
    modifiers.shift ? "Shift" : undefined,
    keyLabel(event.code),
  ]
    .filter((part): part is string => Boolean(part))
    .join("+");
  return {
    kind: "chord",
    shortcut: { code: event.code, modifiers, label, pressCount: 1 },
  };
}

/** Friendly key name from a DOM `code`: "KeyD" -> "D", "Digit5" -> "5";
 * anything else (F5, Space, ArrowUp) already reads fine as-is. */
function keyLabel(code: string) {
  if (code.startsWith("Key") && code.length === 4) return code.slice(3);
  if (code.startsWith("Digit") && code.length === 6) return code.slice(5);
  return code;
}

function messageFromError(error: unknown) {
  if (error && typeof error === "object" && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
}
