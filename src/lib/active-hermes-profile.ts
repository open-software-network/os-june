import { useSyncExternalStore } from "react";

import { createHermesAdminClient } from "./hermes-admin/client";
import { createRustAdminFetch } from "./hermes-admin/rust-transport";
import {
  adminTargetForMode,
  DEFAULT_HERMES_PROFILE,
  type HermesAdminMode,
} from "./hermes-admin/target";
import { hermesBridgeStatus, stickyActiveProfile, type HermesBridgeStatus } from "./tauri";

type Listener = () => void;
export type ActiveHermesProfile = {
  name: string;
  confirmed: boolean;
};

export type ActiveHermesProfileRefreshOptions = {
  status?: HermesBridgeStatus;
  mode?: HermesAdminMode;
};

/** Last-known active profile. Starts at `default` and is only ever moved by a
 * confirmed source (a successful active read or an in-app switch) — a failed
 * refresh keeps the current value, because a transient read failure must not
 * silently rebind new sessions to `default` when the sticky active profile is
 * known to be something else. */
let activeProfileName = DEFAULT_HERMES_PROFILE;
let activeProfileConfirmed = false;
let activeProfileSnapshot: ActiveHermesProfile = {
  name: activeProfileName,
  confirmed: activeProfileConfirmed,
};
let refreshInFlight: Promise<string> | null = null;
const listeners = new Set<Listener>();

function emit(): void {
  for (const listener of listeners) listener();
}

function updateActiveProfileSnapshot(): void {
  activeProfileSnapshot = {
    name: activeProfileName,
    confirmed: activeProfileConfirmed,
  };
}

function normalizeProfileName(name: string | null | undefined): string {
  const trimmed = name?.trim();
  return trimmed || DEFAULT_HERMES_PROFILE;
}

export function getActiveHermesProfileName(): string {
  return activeProfileName;
}

export function isActiveHermesProfileConfirmed(): boolean {
  return activeProfileConfirmed;
}

export function getActiveHermesProfile(): ActiveHermesProfile {
  return activeProfileSnapshot;
}

export function useActiveHermesProfile(): ActiveHermesProfile {
  return useSyncExternalStore(subscribe, getActiveHermesProfile, getActiveHermesProfile);
}

export function useActiveHermesProfileName(): string {
  return useActiveHermesProfile().name;
}

export function setActiveHermesProfileName(name: string): void {
  const next = normalizeProfileName(name);
  const changed = activeProfileName !== next;
  const confirmedChanged = !activeProfileConfirmed;
  if (!changed && !confirmedChanged) return;
  activeProfileName = next;
  activeProfileConfirmed = true;
  updateActiveProfileSnapshot();
  emit();
}

/** Test-only: resets the store to default so cases stay isolated. */
export function resetActiveHermesProfileForTests(): void {
  activeProfileName = DEFAULT_HERMES_PROFILE;
  activeProfileConfirmed = false;
  refreshInFlight = null;
  updateActiveProfileSnapshot();
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  if (!activeProfileConfirmed && refreshInFlight === null) {
    void refreshActiveHermesProfile();
  }
  return () => {
    listeners.delete(listener);
  };
}

export async function refreshActiveHermesProfile(
  options: ActiveHermesProfileRefreshOptions = {},
): Promise<string> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = refreshActiveHermesProfileOnce(options);
  try {
    return await refreshInFlight;
  } finally {
    refreshInFlight = null;
  }
}

async function refreshActiveHermesProfileOnce(
  options: ActiveHermesProfileRefreshOptions,
): Promise<string> {
  try {
    const status = options.status ?? (await hermesBridgeStatus());
    const preferredMode = options.mode ?? "sandboxed";
    const fallbackMode: HermesAdminMode =
      preferredMode === "sandboxed" ? "unrestricted" : "sandboxed";
    const target =
      adminTargetForMode(status, preferredMode) ?? adminTargetForMode(status, fallbackMode);
    if (!target) return refreshFromStickyFile();

    const client = createHermesAdminClient(target, {
      fetch: createRustAdminFetch(target.mode),
    });
    const active = await client.profiles.active();
    setActiveHermesProfileName(active.active);
    return activeProfileName;
  } catch {
    return refreshFromStickyFile();
  }
}

/** Cold-start / bridge-down path: the sticky pointer is a file in the Hermes
 * home, and the gateway's GET /api/profiles/active reads that same file — so
 * a direct Rust read is equally authoritative and needs no web server.
 * Without it the store sat unconfirmed at `default` after an app restart
 * under a named profile (subscribe only refreshes once), so every
 * session-list surface filtered against the wrong profile until the first
 * new session forced a re-read. Failure keeps the last-known value, same as
 * the REST path. */
async function refreshFromStickyFile(): Promise<string> {
  try {
    setActiveHermesProfileName(await stickyActiveProfile());
  } catch {
    // Keep the last-known value: `default` when nothing was ever confirmed,
    // the previously confirmed name otherwise (see activeProfileName's doc).
  }
  return activeProfileName;
}
