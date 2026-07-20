/**
 * Launch-at-login state, backed by tauri-plugin-autostart (a LaunchAgent on
 * macOS, registry entry on Windows).
 *
 * June is a background assistant: dictation hotkeys, meeting detection, and
 * scheduled routines only work while the app is running, so a fresh install
 * enables launch at login once during onboarding completion. The OS login
 * item itself stays the single source of truth; the one-shot marker below
 * only records that the default was applied, so a user who later turns the
 * login item off (in Settings or System Settings) is never re-opted-in.
 */

const DEFAULT_APPLIED_KEY = "june.autostart.defaultApplied";

function inTauri() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** Whether an autostart backend exists at all (false in browser previews,
 * where the Settings row should not render). */
export function autostartSupported() {
  return inTauri();
}

export async function autostartEnabled(): Promise<boolean> {
  if (!inTauri()) return false;
  const { isEnabled } = await import("@tauri-apps/plugin-autostart");
  return isEnabled();
}

export async function setAutostartEnabled(enabled: boolean): Promise<void> {
  if (!inTauri()) return;
  const plugin = await import("@tauri-apps/plugin-autostart");
  if (enabled) await plugin.enable();
  else await plugin.disable();
}

/** Applies the launch-at-login default exactly once per machine. Called when
 * onboarding completes; safe to call again (it no-ops after the first run).
 * Failures are swallowed: a login item is a convenience, never worth
 * blocking the end of onboarding over. */
export async function applyAutostartDefaultOnce(): Promise<void> {
  if (!inTauri()) return;
  try {
    if (window.localStorage.getItem(DEFAULT_APPLIED_KEY) !== null) return;
  } catch {
    return;
  }
  try {
    await setAutostartEnabled(true);
  } catch {
    // Leave the marker unset so a transient failure retries on the next
    // completion (onboarding re-runs after version bumps).
    return;
  }
  try {
    window.localStorage.setItem(DEFAULT_APPLIED_KEY, "1");
  } catch {
    // Storage write failed; the worst case is a redundant enable() later.
  }
}
