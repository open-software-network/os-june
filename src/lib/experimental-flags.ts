import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useSyncExternalStore } from "react";
import { BROWSER_USE_ENABLED } from "./feature-flags";

export const EXPERIMENTAL_FLAGS_CHANGED_EVENT = "experimental-flags-changed";

export type ExperimentalFlags = {
  unlocked: boolean;
  browser_use: boolean;
  companion_pairing: boolean;
  google_multi_account: boolean;
};

type ExperimentalFlagsResponse = ExperimentalFlags & {
  companion_pairing_effective?: boolean;
};

type ExperimentalFlagsCache = ExperimentalFlags & {
  companion_pairing_effective: boolean;
  loaded: boolean;
};

export type ExperimentalFlagsSnapshot = ExperimentalFlagsCache & {
  browserUseEnabled: boolean;
  companionPairingEnabled: boolean;
};

const DEFAULT_FLAGS: ExperimentalFlagsCache = {
  unlocked: false,
  browser_use: false,
  companion_pairing: false,
  google_multi_account: false,
  companion_pairing_effective: false,
  loaded: false,
};

let cache: ExperimentalFlagsCache = { ...DEFAULT_FLAGS };
let cacheRevision = 0;
let initialization: Promise<void> | undefined;
let unlistenExperimentalFlags: (() => void) | undefined;
const subscribers = new Set<() => void>();

function normalizeStoredFlags(flags: ExperimentalFlags): ExperimentalFlags {
  return {
    unlocked: flags?.unlocked === true,
    browser_use: flags?.browser_use === true,
    companion_pairing: flags?.companion_pairing === true,
    google_multi_account: flags?.google_multi_account === true,
  };
}

function normalizeFlags(flags: ExperimentalFlagsResponse): Omit<ExperimentalFlagsCache, "loaded"> {
  return {
    ...normalizeStoredFlags(flags),
    companion_pairing_effective:
      flags?.companion_pairing_effective ?? flags?.companion_pairing === true,
  };
}

function publish(flags: ExperimentalFlagsResponse, loaded = true) {
  const normalized = normalizeFlags(flags);
  if (
    cache.unlocked === normalized.unlocked &&
    cache.browser_use === normalized.browser_use &&
    cache.companion_pairing === normalized.companion_pairing &&
    cache.google_multi_account === normalized.google_multi_account &&
    cache.companion_pairing_effective === normalized.companion_pairing_effective &&
    cache.loaded === loaded
  ) {
    return;
  }
  cache = { ...normalized, loaded };
  cacheRevision += 1;
  for (const subscriber of subscribers) subscriber();
}

export async function initializeExperimentalFlags() {
  if (initialization) return initialization;
  initialization = (async () => {
    try {
      const nextUnlisten = await listen<ExperimentalFlagsResponse>(
        EXPERIMENTAL_FLAGS_CHANGED_EVENT,
        (event) => {
          publish(event.payload);
        },
      );
      unlistenExperimentalFlags?.();
      unlistenExperimentalFlags = nextUnlisten;
    } catch {
      // Browser previews have no Tauri event bridge. The command snapshot
      // below still gets a chance to load, then defaults fail closed.
    }

    const revision = cacheRevision;
    try {
      const flags = await invoke<ExperimentalFlagsResponse>("experimental_flags_get");
      if (cacheRevision === revision) publish(flags);
    } catch {
      // Keep fail-closed defaults unloaded so the next subscriber can retry.
      // A newer event or write still wins through cacheRevision and publish.
    }
  })().finally(() => {
    initialization = undefined;
  });
  return initialization;
}

function subscribe(subscriber: () => void) {
  subscribers.add(subscriber);
  if (!cache.loaded) void initializeExperimentalFlags();
  return () => {
    subscribers.delete(subscriber);
  };
}

function getSnapshot() {
  return cache;
}

/** Live React view of the persisted overrides plus the effective Browser use
 * value after ORing the public compile-time kill switch. */
export function useExperimentalFlags(): ExperimentalFlagsSnapshot {
  const stored = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return {
    ...stored,
    browserUseEnabled: BROWSER_USE_ENABLED || stored.browser_use,
    companionPairingEnabled: stored.companion_pairing_effective,
  };
}

/** Synchronous effective value for render helpers that cannot use React. */
export function experimentalBrowserUseEnabled() {
  return BROWSER_USE_ENABLED || cache.browser_use;
}

export function getCachedExperimentalFlags(): ExperimentalFlags {
  return {
    unlocked: cache.unlocked,
    browser_use: cache.browser_use,
    companion_pairing: cache.companion_pairing,
    google_multi_account: cache.google_multi_account,
  };
}

export async function setExperimentalFlags(flags: ExperimentalFlags) {
  const normalized = normalizeStoredFlags(flags);
  const saved = await invoke<ExperimentalFlagsResponse>("experimental_flags_set", {
    request: normalized,
  });
  publish(saved ?? normalized);
  return getCachedExperimentalFlags();
}

export const EXPERIMENTAL_UNLOCK_CLICKS = 7;
export const EXPERIMENTAL_UNLOCK_WINDOW_MS = 4_000;

export type ExperimentalUnlockClickState = {
  count: number;
  startedAt: number | null;
};

export const INITIAL_EXPERIMENTAL_UNLOCK_CLICK_STATE: ExperimentalUnlockClickState = {
  count: 0,
  startedAt: null,
};

export function registerExperimentalUnlockClick(
  state: ExperimentalUnlockClickState,
  now: number,
): { state: ExperimentalUnlockClickState; unlocked: boolean } {
  const outsideWindow =
    state.startedAt === null ||
    now < state.startedAt ||
    now - state.startedAt > EXPERIMENTAL_UNLOCK_WINDOW_MS;
  const startedAt = outsideWindow ? now : state.startedAt;
  const count = outsideWindow ? 1 : state.count + 1;
  if (count >= EXPERIMENTAL_UNLOCK_CLICKS) {
    return {
      state: INITIAL_EXPERIMENTAL_UNLOCK_CLICK_STATE,
      unlocked: true,
    };
  }
  return {
    state: { count, startedAt },
    unlocked: false,
  };
}
