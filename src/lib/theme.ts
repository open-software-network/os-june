export type ThemePreference = "system" | "light" | "dark";

const STORAGE_KEY = "os-scribe:theme";
const VALID: ThemePreference[] = ["system", "light", "dark"];

export function getStoredTheme(): ThemePreference {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw && (VALID as string[]).includes(raw)) {
      return raw as ThemePreference;
    }
  } catch {
    // localStorage can throw in sandboxed contexts.
  }
  return "system";
}

export function setStoredTheme(theme: ThemePreference) {
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // Apply still works for this session.
  }
  applyTheme(theme);
}

export function applyTheme(theme: ThemePreference) {
  const root = document.documentElement;
  if (theme === "system") {
    root.removeAttribute("data-theme");
  } else {
    root.setAttribute("data-theme", theme);
  }
}

export function initTheme() {
  applyTheme(getStoredTheme());
}
