import { createContext, type PropsWithChildren, useContext, useSyncExternalStore } from "react";
import type { AudioLevelDto, RecordingStatusDto, SourceStatusDto } from "./tauri";
import { meterLevelForSources } from "./recorder-levels";

type StoreListener = () => void;

type RecordingLevelSnapshot = {
  sessionId: string;
  level: AudioLevelDto;
  sources?: SourceStatusDto[];
};

type RecordingElapsedSnapshot = {
  sessionId: string;
  elapsedMs: number;
};

export type RecordingTelemetryStore = {
  getStatus: () => RecordingStatusDto | undefined;
  getLevelSnapshot: () => RecordingLevelSnapshot | undefined;
  getElapsedSnapshot: () => RecordingElapsedSnapshot | undefined;
  subscribeStatus: (listener: StoreListener) => () => void;
  subscribeLevel: (listener: StoreListener) => () => void;
  subscribeElapsed: (listener: StoreListener) => () => void;
  setStatus: (status: RecordingStatusDto | undefined) => void;
};

function subscribe(listeners: Set<StoreListener>, listener: StoreListener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notify(listeners: Set<StoreListener>) {
  for (const listener of listeners) listener();
}

function elapsedSnapshot(status: RecordingStatusDto | undefined) {
  if (!status) return undefined;
  return {
    sessionId: status.sessionId,
    elapsedMs: Math.floor(Math.max(0, status.elapsedMs) / 1000) * 1000,
  };
}

function sameElapsedSnapshot(
  current: RecordingElapsedSnapshot | undefined,
  next: RecordingElapsedSnapshot | undefined,
) {
  return current?.sessionId === next?.sessionId && current?.elapsedMs === next?.elapsedMs;
}

/** The authoritative renderer-side recording sample stays outside React.
 * Consumers subscribe only to the cadence they render: level at native
 * telemetry cadence, elapsed time on whole-second boundaries, and imperative
 * observers (such as inactivity detection) on every sample. */
export function createRecordingTelemetryStore(
  initialStatus?: RecordingStatusDto,
): RecordingTelemetryStore {
  let status = initialStatus;
  let level = initialStatus
    ? {
        sessionId: initialStatus.sessionId,
        level: initialStatus.level,
        sources: initialStatus.sources,
      }
    : undefined;
  let elapsed = elapsedSnapshot(initialStatus);
  const statusListeners = new Set<StoreListener>();
  const levelListeners = new Set<StoreListener>();
  const elapsedListeners = new Set<StoreListener>();

  return {
    getStatus: () => status,
    getLevelSnapshot: () => level,
    getElapsedSnapshot: () => elapsed,
    subscribeStatus: (listener) => subscribe(statusListeners, listener),
    subscribeLevel: (listener) => subscribe(levelListeners, listener),
    subscribeElapsed: (listener) => subscribe(elapsedListeners, listener),
    setStatus: (nextStatus) => {
      if (Object.is(status, nextStatus)) return;

      const nextElapsed = elapsedSnapshot(nextStatus);
      const elapsedChanged = !sameElapsedSnapshot(elapsed, nextElapsed);
      status = nextStatus;
      level = nextStatus
        ? {
            sessionId: nextStatus.sessionId,
            level: nextStatus.level,
            sources: nextStatus.sources,
          }
        : undefined;
      elapsed = nextElapsed;

      notify(statusListeners);
      notify(levelListeners);
      if (elapsedChanged) notify(elapsedListeners);
    },
  };
}

const RecordingTelemetryStoreContext = createContext<RecordingTelemetryStore | undefined>(
  undefined,
);
const subscribeToNothing = () => () => {};
const getNoLevelSnapshot = () => undefined;
const getNoElapsedSnapshot = () => undefined;

export function RecordingTelemetryProvider({
  children,
  store,
}: PropsWithChildren<{ store: RecordingTelemetryStore }>) {
  return (
    <RecordingTelemetryStoreContext.Provider value={store}>
      {children}
    </RecordingTelemetryStoreContext.Provider>
  );
}

export function useRecordingTelemetryLevel(sessionId: string | undefined, fallback: AudioLevelDto) {
  const store = useContext(RecordingTelemetryStoreContext);
  const snapshot = useSyncExternalStore(
    store?.subscribeLevel ?? subscribeToNothing,
    store?.getLevelSnapshot ?? getNoLevelSnapshot,
    store?.getLevelSnapshot ?? getNoLevelSnapshot,
  );
  if (!snapshot || (sessionId && snapshot.sessionId !== sessionId)) return fallback;
  return meterLevelForSources(snapshot.level, snapshot.sources);
}

export function useRecordingElapsedMs(sessionId: string, fallback: number) {
  const store = useContext(RecordingTelemetryStoreContext);
  const snapshot = useSyncExternalStore(
    store?.subscribeElapsed ?? subscribeToNothing,
    store?.getElapsedSnapshot ?? getNoElapsedSnapshot,
    store?.getElapsedSnapshot ?? getNoElapsedSnapshot,
  );
  return snapshot?.sessionId === sessionId ? snapshot.elapsedMs : fallback;
}
