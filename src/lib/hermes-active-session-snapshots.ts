import { hermesConnectionForMode } from "./hermes-connection";
import {
  forceDisconnectHermesGatewayClients,
  HermesGatewayClient,
  HermesGatewayRequestTimeoutError,
} from "./hermes-gateway";
import { hermesBridgeStatus } from "./tauri";

export type HermesActiveSessionRow = {
  id?: string;
  session_key?: string;
  status?: string;
};

export type HermesActiveSessionSnapshot = {
  fullMode: boolean;
  liveSessionIds: ReadonlySet<string>;
  reachable: boolean;
  rows: readonly HermesActiveSessionRow[];
};

type SnapshotListener = (snapshot: HermesActiveSessionSnapshot) => void;

type ModeObserver = {
  connected: boolean;
  connecting?: Promise<void>;
  gateway: HermesGatewayClient;
};

const SNAPSHOT_INTERVAL_MS = 500;
const SNAPSHOT_REQUEST_TIMEOUT_MS = SNAPSHOT_INTERVAL_MS;
export const HERMES_GATEWAY_HEARTBEAT_MISS_THRESHOLD = 3;
const listenersByMode = new Map<boolean, Set<SnapshotListener>>();
const observersByMode = new Map<boolean, ModeObserver>();
const cycleInFlightByMode = new Set<boolean>();
const cycleTimersByMode = new Map<boolean, ReturnType<typeof setTimeout>>();
const immediateCyclesByMode = new Set<boolean>();
const heartbeatMissesByMode = new Map<boolean, number>();

function modeHasListeners(fullMode: boolean) {
  return Boolean(listenersByMode.get(fullMode)?.size);
}

/** Whether working-session consumers currently keep this mode's shared
 * lifecycle and heartbeat polling active. */
export function hasHermesActiveSessionSnapshotSubscribers(fullMode: boolean) {
  return modeHasListeners(fullMode);
}

function closeObserver(fullMode: boolean) {
  const observer = observersByMode.get(fullMode);
  if (!observer) return;
  observersByMode.delete(fullMode);
  heartbeatMissesByMode.delete(fullMode);
  observer.gateway.close();
}

function scheduleCycle(fullMode: boolean, delayMs: number) {
  if (!modeHasListeners(fullMode)) return;
  if (cycleInFlightByMode.has(fullMode)) {
    if (delayMs === 0) immediateCyclesByMode.add(fullMode);
    return;
  }
  const currentTimer = cycleTimersByMode.get(fullMode);
  if (currentTimer !== undefined) {
    if (delayMs !== 0) return;
    clearTimeout(currentTimer);
  }
  cycleTimersByMode.set(
    fullMode,
    setTimeout(() => {
      cycleTimersByMode.delete(fullMode);
      void runCycle(fullMode);
    }, delayMs),
  );
}

function createObserver(fullMode: boolean) {
  const gateway = new HermesGatewayClient(fullMode);
  const observer: ModeObserver = { connected: false, gateway };
  gateway.onClose(() => {
    if (observersByMode.get(fullMode) === observer) {
      observer.connected = false;
    }
  });
  observersByMode.set(fullMode, observer);
  return observer;
}

async function ensureObserver(fullMode: boolean) {
  const observer = observersByMode.get(fullMode) ?? createObserver(fullMode);
  if (observer.connected) return observer;
  if (!observer.connecting) {
    const connectionAttempt = (async () => {
      const status = await hermesBridgeStatus();
      const connection = hermesConnectionForMode(status, fullMode);
      if (!connection?.wsUrl) throw new Error("Hermes gateway is not available.");
      if (observersByMode.get(fullMode) !== observer) {
        throw new Error("Hermes lifecycle observer was replaced.");
      }
      await observer.gateway.connect(connection.wsUrl);
      if (observersByMode.get(fullMode) !== observer) {
        observer.gateway.close();
        throw new Error("Hermes lifecycle observer was replaced.");
      }
      observer.connected = true;
    })().finally(() => {
      if (observer.connecting === connectionAttempt) observer.connecting = undefined;
    });
    observer.connecting = connectionAttempt;
  }
  await observer.connecting;
  return observer;
}

function publishSnapshot(
  fullMode: boolean,
  reachable: boolean,
  rows: readonly HermesActiveSessionRow[],
) {
  const liveSessionIds = new Set<string>();
  if (reachable) {
    for (const row of rows) {
      if (!row || row.status === "idle") continue;
      if (row.id !== undefined) liveSessionIds.add(String(row.id));
      if (row.session_key !== undefined) liveSessionIds.add(String(row.session_key));
    }
  }
  const snapshot: HermesActiveSessionSnapshot = {
    fullMode,
    liveSessionIds,
    reachable,
    rows,
  };
  for (const listener of [...(listenersByMode.get(fullMode) ?? [])]) {
    try {
      listener(snapshot);
    } catch {
      // One lifecycle consumer must not prevent the shared snapshot from
      // reaching the rest. Async work is owned and reported by each consumer.
    }
  }
}

async function pollMode(fullMode: boolean) {
  try {
    const observer = await ensureObserver(fullMode);
    const response = await observer.gateway.request<{
      sessions?: HermesActiveSessionRow[];
    }>("session.active_list", {}, SNAPSHOT_REQUEST_TIMEOUT_MS);
    heartbeatMissesByMode.delete(fullMode);
    publishSnapshot(fullMode, true, Array.isArray(response?.sessions) ? response.sessions : []);
  } catch (error) {
    if (error instanceof HermesGatewayRequestTimeoutError) {
      const misses = (heartbeatMissesByMode.get(fullMode) ?? 0) + 1;
      if (misses >= HERMES_GATEWAY_HEARTBEAT_MISS_THRESHOLD) {
        heartbeatMissesByMode.delete(fullMode);
        forceDisconnectHermesGatewayClients(fullMode);
      } else {
        heartbeatMissesByMode.set(fullMode, misses);
      }
    } else {
      heartbeatMissesByMode.delete(fullMode);
    }
    // Unreachable is an observation, not an empty active-session list. It
    // engages bounded native-persistence fallbacks while preserving
    // locally-known activity.
    publishSnapshot(fullMode, false, []);
  }
}

async function runCycle(fullMode: boolean) {
  if (cycleInFlightByMode.has(fullMode)) {
    immediateCyclesByMode.add(fullMode);
    return;
  }
  if (!modeHasListeners(fullMode)) return;
  cycleInFlightByMode.add(fullMode);
  try {
    await pollMode(fullMode);
  } finally {
    cycleInFlightByMode.delete(fullMode);
    const delayMs = immediateCyclesByMode.delete(fullMode) ? 0 : SNAPSHOT_INTERVAL_MS;
    if (modeHasListeners(fullMode)) scheduleCycle(fullMode, delayMs);
  }
}

/**
 * Subscribes to the one process-wide active-session snapshot cycle for a
 * Hermes runtime mode. Every consumer in that mode receives the same result;
 * adding consumers never adds another `session.active_list` request.
 */
export function subscribeHermesActiveSessionSnapshots(
  fullMode: boolean,
  listener: SnapshotListener,
) {
  const listeners = listenersByMode.get(fullMode) ?? new Set<SnapshotListener>();
  listeners.add(listener);
  listenersByMode.set(fullMode, listeners);
  scheduleCycle(fullMode, 0);

  let subscribed = true;
  return () => {
    if (!subscribed) return;
    subscribed = false;
    const current = listenersByMode.get(fullMode);
    current?.delete(listener);
    if (current?.size) return;
    listenersByMode.delete(fullMode);
    heartbeatMissesByMode.delete(fullMode);
    const timer = cycleTimersByMode.get(fullMode);
    if (timer !== undefined) clearTimeout(timer);
    cycleTimersByMode.delete(fullMode);
    immediateCyclesByMode.delete(fullMode);
  };
}

/** Clears singleton scheduler state between tests. Production ownership is
 * process-wide: polling pauses without consumers, while observer sockets are
 * reused across short subscriber gaps. */
export function resetHermesActiveSessionSnapshotsForTests() {
  for (const timer of cycleTimersByMode.values()) clearTimeout(timer);
  cycleTimersByMode.clear();
  cycleInFlightByMode.clear();
  immediateCyclesByMode.clear();
  heartbeatMissesByMode.clear();
  listenersByMode.clear();
  for (const fullMode of [...observersByMode.keys()]) closeObserver(fullMode);
}
