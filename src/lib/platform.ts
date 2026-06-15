export function isMacLikePlatform() {
  const platform =
    typeof navigator === "undefined"
      ? ""
      : `${navigator.platform} ${navigator.userAgent}`;
  if (/Windows|Win32|Win64|Linux|Android/i.test(platform)) {
    return false;
  }
  return true;
}

export function primaryShortcutLabel(key: string) {
  return isMacLikePlatform() ? `⌘ ${key}` : `Ctrl ${key}`;
}

export function primaryShiftShortcutLabel(key: string) {
  return isMacLikePlatform() ? `⌘ ⇧ ${key}` : `Ctrl Shift ${key}`;
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
