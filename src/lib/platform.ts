import { useEffect, useState } from "react";
import { dictationCapabilities, type DictationCapabilitiesDto } from "./tauri";

const UNSUPPORTED_CAPABILITIES: DictationCapabilitiesDto = {
  available: false,
  platform: "unsupported",
  shortcuts: false,
  paste: false,
  microphoneSelection: false,
  accessibilityPermission: false,
  systemAudio: false,
};

export function fallbackDictationCapabilities(): DictationCapabilitiesDto {
  return {
    ...UNSUPPORTED_CAPABILITIES,
    ...(isMacLikePlatform()
      ? {
          available: true,
          platform: "macos" as const,
          shortcuts: true,
          paste: true,
          microphoneSelection: true,
          accessibilityPermission: true,
          systemAudio: true,
        }
      : isWindowsPlatform()
        ? {
            available: true,
            platform: "windows" as const,
            shortcuts: true,
            paste: true,
            microphoneSelection: true,
            systemAudio: true,
          }
        : {}),
  };
}

export function useDictationCapabilities() {
  const [capabilities, setCapabilities] = useState<DictationCapabilitiesDto>(() =>
    fallbackDictationCapabilities(),
  );

  useEffect(() => {
    let active = true;
    dictationCapabilities()
      .then((response) => {
        if (active) setCapabilities(response.capabilities);
      })
      .catch(() => {
        if (active) setCapabilities(fallbackDictationCapabilities());
      });
    return () => {
      active = false;
    };
  }, []);

  return capabilities;
}

export function isMacLikePlatform() {
  const platform = platformString();
  if (/Windows|Win32|Win64|Linux|Android/i.test(platform)) {
    return false;
  }
  return true;
}

export function isWindowsPlatform() {
  return /Windows|Win32|Win64/i.test(platformString());
}

export function isSystemAudioSupportedPlatform() {
  return isMacLikePlatform() || isWindowsPlatform();
}

function platformString() {
  return typeof navigator === "undefined" ? "" : `${navigator.platform} ${navigator.userAgent}`;
}

export function primaryShortcutLabel(key: string) {
  // No space after the ⌘ glyph (it reads tight), but keep one after the
  // "Ctrl" word so Windows labels don't run together as "CtrlN".
  return isMacLikePlatform() ? `⌘${key}` : `Ctrl ${key}`;
}

export function primaryShiftShortcutLabel(key: string) {
  return isMacLikePlatform() ? `⌘⇧${key}` : `Ctrl Shift ${key}`;
}

export function isPrimaryShortcut(
  event: Pick<KeyboardEvent, "metaKey" | "ctrlKey" | "altKey" | "shiftKey">,
) {
  if (event.altKey || event.shiftKey) return false;
  if (isMacLikePlatform()) {
    return event.metaKey && !event.ctrlKey;
  }
  return event.ctrlKey && !event.metaKey;
}
