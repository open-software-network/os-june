import { hermesConnectionForMode } from "./hermes-connection";
import { HermesGatewayClient } from "./hermes-gateway";
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
const listenersByMode = new Map<boolean, Set<SnapshotListener>>();
const observersByMode = new Map<boolean, ModeObserver>();
let cycleInFlight = false;
let cycleTimer: ReturnType<typeof setTimeout> | undefined;
let immediateCycleRequested = false;

function activeModes() {
  return [...listenersByMode.entries()]
    .filter(([, listeners]) => listeners.size > 0)
    .map(([fullMode]) => fullMode);
}

function closeObserver(fullMode: boolean) {
  const observer = observersByMode.get(fullMode);
  if (!observer) return;
  observersByMode.delete(fullMode);
  observer.gateway.close();
}

function scheduleCycle(delayMs: number) {
  if (activeModes().length === 0) return;
  if (cycleInFlight) {
    if (delayMs === 0) immediateCycleRequested = true;
    return;
  }
  if (cycleTimer !== undefined) {
    if (delayMs !== 0) return;
    clearTimeout(cycleTimer);
  }
  cycleTimer = setTimeout(() => {
    cycleTimer = undefined;
    void runCycle();
  }, delayMs);
}

function createObserver(fullMode: boolean) {
  const gateway = new HermesGatewayClient();
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
    }>("session.active_list", {});
    publishSnapshot(fullMode, true, Array.isArray(response?.sessions) ? response.sessions : []);
  } catch {
    // Unreachable is an observation, not an empty active-session list. It
    // breaks settlement idle streaks while preserving locally-known activity.
    publishSnapshot(fullMode, false, []);
  }
}

async function runCycle() {
  if (cycleInFlight) {
    immediateCycleRequested = true;
    return;
  }
  const modes = activeModes();
  if (modes.length === 0) return;
  cycleInFlight = true;
  try {
    await Promise.all(modes.map(pollMode));
  } finally {
    cycleInFlight = false;
    const delayMs = immediateCycleRequested ? 0 : SNAPSHOT_INTERVAL_MS;
    immediateCycleRequested = false;
    if (activeModes().length > 0) scheduleCycle(delayMs);
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
  scheduleCycle(0);

  let subscribed = true;
  return () => {
    if (!subscribed) return;
    subscribed = false;
    const current = listenersByMode.get(fullMode);
    current?.delete(listener);
    if (current?.size) return;
    listenersByMode.delete(fullMode);
    if (activeModes().length === 0 && cycleTimer !== undefined) {
      clearTimeout(cycleTimer);
      cycleTimer = undefined;
    }
  };
}

/** Clears singleton scheduler state between tests. Production ownership is
 * process-wide: polling pauses without consumers, while observer sockets are
 * reused across short subscriber gaps. */
export function resetHermesActiveSessionSnapshotsForTests() {
  if (cycleTimer !== undefined) clearTimeout(cycleTimer);
  cycleTimer = undefined;
  cycleInFlight = false;
  immediateCycleRequested = false;
  listenersByMode.clear();
  for (const fullMode of [...observersByMode.keys()]) closeObserver(fullMode);
}
