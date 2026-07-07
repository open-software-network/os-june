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

let activeProfileName = DEFAULT_HERMES_PROFILE;
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

export function setActiveHermesProfileName(name: string): void {
  const next = normalizeProfileName(name);
  if (activeProfileName === next) return;
  activeProfileName = next;
  emit();
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
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
    if (!target) {
      setActiveHermesProfileName(DEFAULT_HERMES_PROFILE);
      return activeProfileName;
    }

    const client = createHermesAdminClient(target, {
      fetch: createRustAdminFetch(target.mode),
    });
    const active = await client.profiles.active();
    setActiveHermesProfileName(active.active);
    return activeProfileName;
  } catch {
    setActiveHermesProfileName(DEFAULT_HERMES_PROFILE);
    return activeProfileName;
  }
}
