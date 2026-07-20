export type HermesActiveSessionRow = {
  id?: string;
  session_key?: string;
  status?: string;
};

export type HermesRunSettlementHandle = {
  cancel: () => void;
};

export type WatchHermesRunSettlementOptions = {
  storedSessionId: string;
  runtimeSessionId?: string;
  listActiveSessions: () => Promise<readonly HermesActiveSessionRow[]>;
  onSettled: () => void;
  pollIntervalMs?: number;
  timeoutMs?: number;
};

const DEFAULT_POLL_INTERVAL_MS = 200;
const DEFAULT_TIMEOUT_MS = 120_000;
const REQUIRED_IDLE_OBSERVATIONS = 2;

type SettlementWatch = {
  finished: boolean;
  handle: HermesRunSettlementHandle;
  idleObservations: number;
  identifiers: Set<string>;
  nextPollTimer?: ReturnType<typeof setTimeout>;
  timeoutTimer: ReturnType<typeof setTimeout>;
};

const settlementWatches = new Map<string, SettlementWatch>();

function matchingSessionIsIdle(
  rows: readonly HermesActiveSessionRow[],
  identifiers: ReadonlySet<string>,
) {
  const matchingRows = rows.filter(
    (row) =>
      (row.id !== undefined && identifiers.has(String(row.id))) ||
      (row.session_key !== undefined && identifiers.has(String(row.session_key))),
  );
  return matchingRows.every((row) => row.status === "idle");
}

/**
 * Confirms that a completed Hermes run has reached true runtime idle before
 * notifying downstream consumers. An empty active-session snapshot is a
 * reachable idle observation; an error is not.
 *
 * One watch is shared per stored session. A call made while that session is
 * already being watched returns the shared handle and adds its optional
 * runtime id to the match set. The first call owns the poll function, timings,
 * and callback; later callbacks are intentionally ignored so one run can emit
 * at most one settlement. Cancelling any shared handle cancels that watch.
 */
export function watchHermesRunSettlement(
  options: WatchHermesRunSettlementOptions,
): HermesRunSettlementHandle {
  const existing = settlementWatches.get(options.storedSessionId);
  if (existing) {
    if (options.runtimeSessionId) existing.identifiers.add(options.runtimeSessionId);
    return existing.handle;
  }

  const pollIntervalMs = Math.max(0, options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
  const timeoutMs = Math.max(0, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const identifiers = new Set([options.storedSessionId]);
  if (options.runtimeSessionId) identifiers.add(options.runtimeSessionId);

  let watch: SettlementWatch;
  const finish = () => {
    if (watch.finished) return;
    watch.finished = true;
    clearTimeout(watch.timeoutTimer);
    if (watch.nextPollTimer !== undefined) clearTimeout(watch.nextPollTimer);
    if (settlementWatches.get(options.storedSessionId) === watch) {
      settlementWatches.delete(options.storedSessionId);
    }
  };
  const handle: HermesRunSettlementHandle = { cancel: finish };
  watch = {
    finished: false,
    handle,
    idleObservations: 0,
    identifiers,
    timeoutTimer: setTimeout(finish, timeoutMs),
  };
  settlementWatches.set(options.storedSessionId, watch);

  const scheduleNextPoll = () => {
    if (watch.finished) return;
    watch.nextPollTimer = setTimeout(() => {
      watch.nextPollTimer = undefined;
      void poll();
    }, pollIntervalMs);
  };
  const poll = async () => {
    try {
      const rows = await options.listActiveSessions();
      if (watch.finished) return;
      if (matchingSessionIsIdle(rows, watch.identifiers)) {
        watch.idleObservations += 1;
        if (watch.idleObservations >= REQUIRED_IDLE_OBSERVATIONS) {
          finish();
          options.onSettled();
          return;
        }
      } else {
        watch.idleObservations = 0;
      }
    } catch {
      if (watch.finished) return;
      watch.idleObservations = 0;
    }
    scheduleNextPoll();
  };

  void poll();
  return handle;
}
