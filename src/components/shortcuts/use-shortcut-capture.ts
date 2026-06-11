import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { parseDictationHelperEvent } from "../../lib/dictation-events";
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
 * Native record-a-shortcut flow: `start()` puts the dictation helper into
 * capture mode (it owns the event tap, so fn and bare modifiers work — DOM
 * keydown can't see those), the captured chord comes back as a
 * `shortcut_captured` helper event, and the hook persists it through
 * `setDictationShortcut` before reporting back. Escape cancels.
 *
 * Settings grew this flow first (inline in AppSettings); the onboarding
 * practice step uses this hook. Both speak the same helper protocol, so a
 * capture started here is indistinguishable from one started in Settings.
 */
export function useShortcutCapture({
  kind,
  onSaved,
}: {
  kind: DictationShortcutKind;
  /** Fires after the chord is captured AND persisted. `saved` is the
   * settings snapshot the backend returned (undefined in stubbed envs). */
  onSaved?: (
    saved: DictationSettingsDto | undefined,
    captured: CapturedShortcut,
  ) => void;
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
        setError(
          helperEvent.payload?.message ?? "Shortcut could not be captured.",
        );
        setCapturing(false);
        return;
      }
      if (helperEvent.type !== "shortcut_captured") return;
      const captured = shortcutFromCapturePayload(
        helperEvent.payload?.shortcut,
        1,
      );
      if (!captured) {
        setError("Shortcut capture returned invalid data.");
        setCapturing(false);
        return;
      }
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
    });

    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        void cancel();
      }
    }
    window.addEventListener("keydown", onKey);

    return () => {
      active = false;
      window.removeEventListener("keydown", onKey);
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
        void dictationHelperCommand({ type: "cancel_shortcut_capture" }).catch(
          () => undefined,
        );
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
    value.pressCount === 1 || value.pressCount === 2
      ? value.pressCount
      : fallbackPressCount;
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

function messageFromError(error: unknown) {
  if (error && typeof error === "object" && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
}
