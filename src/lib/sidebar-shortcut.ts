import { isMacLikePlatform } from "./platform";

export const SIDEBAR_SHORTCUT_STORAGE_KEY = "june:shortcut:toggle-sidebar";
export const SHORTCUT_CAPTURE_ATTRIBUTE = "data-shortcut-capture";

export type ShortcutModifiers = {
  command: boolean;
  control: boolean;
  option: boolean;
  shift: boolean;
  function: boolean;
};

export type SidebarShortcut = {
  code: string;
  label: string;
  modifiers: ShortcutModifiers;
  pressCount: 1;
  keyCode?: number;
};

// Authoritative once populated: the matcher runs on every keydown app-wide,
// so reads must not touch localStorage after the first call.
let sessionShortcut: SidebarShortcut | null | undefined;

export function defaultSidebarShortcut(): SidebarShortcut {
  const macLike = isMacLikePlatform();
  // Cmd+B belongs to Bold in the note editor, so the default chord must not
  // collide with any TipTap keybinding. The label matches what
  // chordFromKeyEvent produces for this chord; shortcutsMatch compares labels.
  return {
    code: "Backslash",
    label: macLike ? "Cmd+Backslash" : "Ctrl+Backslash",
    modifiers: {
      command: macLike,
      control: !macLike,
      option: false,
      shift: false,
      function: false,
    },
    pressCount: 1,
  };
}

export function getStoredSidebarShortcut(): SidebarShortcut | null {
  if (sessionShortcut !== undefined) return sessionShortcut;
  try {
    const stored = window.localStorage.getItem(SIDEBAR_SHORTCUT_STORAGE_KEY);
    const parsed = stored ? JSON.parse(stored) : undefined;
    sessionShortcut = parsed === null ? null : normalizeSidebarShortcut(parsed);
  } catch {
    sessionShortcut = defaultSidebarShortcut();
  }
  return sessionShortcut;
}

export function setStoredSidebarShortcut(shortcut: SidebarShortcut): SidebarShortcut;
export function setStoredSidebarShortcut(shortcut: null): null;
export function setStoredSidebarShortcut(shortcut: SidebarShortcut | null) {
  const next = shortcut === null ? null : normalizeSidebarShortcut(shortcut);
  sessionShortcut = next;
  try {
    window.localStorage.setItem(SIDEBAR_SHORTCUT_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Keep the in-session choice even when storage is unavailable.
  }
  return next;
}

/** Tests that mutate localStorage directly must drop the module cache. */
export function resetSidebarShortcutCacheForTests() {
  sessionShortcut = undefined;
}

export function matchesSidebarShortcut(
  event: Pick<KeyboardEvent, "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey" | "repeat">,
  shortcut = getStoredSidebarShortcut(),
) {
  if (!shortcut || event.repeat || event.code !== shortcut.code || shortcut.modifiers.function) {
    return false;
  }
  return (
    event.metaKey === shortcut.modifiers.command &&
    event.ctrlKey === shortcut.modifiers.control &&
    event.altKey === shortcut.modifiers.option &&
    event.shiftKey === shortcut.modifiers.shift
  );
}

export function normalizeSidebarShortcut(value: unknown): SidebarShortcut {
  if (!value || typeof value !== "object") return defaultSidebarShortcut();
  const candidate = value as Partial<SidebarShortcut>;
  const modifiers = candidate.modifiers;
  if (
    typeof candidate.code !== "string" ||
    !candidate.code ||
    typeof candidate.label !== "string" ||
    !candidate.label ||
    !modifiers ||
    typeof modifiers.command !== "boolean" ||
    typeof modifiers.control !== "boolean" ||
    typeof modifiers.option !== "boolean" ||
    typeof modifiers.shift !== "boolean" ||
    typeof modifiers.function !== "boolean" ||
    // The chord fires while typing anywhere in the app, so it must carry Cmd
    // or Ctrl; shift- or option-only chords collide with ordinary typing.
    (!modifiers.command && !modifiers.control)
  ) {
    return defaultSidebarShortcut();
  }
  return {
    code: candidate.code,
    label: candidate.label,
    modifiers: {
      command: modifiers.command,
      control: modifiers.control,
      option: modifiers.option,
      shift: modifiers.shift,
      function: modifiers.function,
    },
    pressCount: 1,
  };
}
