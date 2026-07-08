import { useSyncExternalStore } from "react";

import { createHermesAdminClient } from "./hermes-admin/client";
import { createRustAdminFetch } from "./hermes-admin/rust-transport";
import {
  adminTargetForMode,
  DEFAULT_HERMES_PROFILE,
  type HermesAdminMode,
} from "./hermes-admin/target";
import { hermesBridgeStatus, type HermesBridgeStatus } from "./tauri";

type Listener = () => void;

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
let hydrationStarted = false;
const listeners = new Set<Listener>();

function emit(): void {
  for (const listener of listeners) listener();
}

function normalizeProfileName(name: string | null | undefined): string {
  const trimmed = name?.trim();
  return trimmed || DEFAULT_HERMES_PROFILE;
}

export function getActiveHermesProfileName(): string {
  return activeProfileName;
}

export function useActiveHermesProfileName(): string {
  return useSyncExternalStore(subscribe, getActiveHermesProfileName, getActiveHermesProfileName);
}

export function setActiveHermesProfileName(name: string): void {
  const next = normalizeProfileName(name);
  if (activeProfileName === next) return;
  activeProfileName = next;
  emit();
}

/** Test-only: resets the store to default so cases stay isolated. */
export function resetActiveHermesProfileForTests(): void {
  activeProfileName = DEFAULT_HERMES_PROFILE;
  hydrationStarted = false;
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  if (!hydrationStarted) {
    hydrationStarted = true;
    void refreshActiveHermesProfile();
  }
  return () => {
    listeners.delete(listener);
  };
}

export async function refreshActiveHermesProfile(
  options: ActiveHermesProfileRefreshOptions = {},
): Promise<string> {
  try {
    const status = options.status ?? (await hermesBridgeStatus());
    const preferredMode = options.mode ?? "sandboxed";
    const fallbackMode: HermesAdminMode =
      preferredMode === "sandboxed" ? "unrestricted" : "sandboxed";
    const target =
      adminTargetForMode(status, preferredMode) ?? adminTargetForMode(status, fallbackMode);
    if (!target) return activeProfileName;

    const client = createHermesAdminClient(target, {
      fetch: createRustAdminFetch(target.mode),
    });
    const active = await client.profiles.active();
    setActiveHermesProfileName(active.active);
    return activeProfileName;
  } catch {
    // Keep the last-known value: `default` when nothing was ever confirmed,
    // the previously confirmed name otherwise (see activeProfileName's doc).
    return activeProfileName;
  }
}
