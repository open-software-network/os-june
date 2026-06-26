/**
 * Bounded, per-session store of Hermes events June can't model yet.
 *
 * `classifyHermesEvent` (the control plane) is total: an unrecognized raw frame
 * becomes `{ kind: "unsupported", ... }` instead of being dropped. This store is
 * where those land so the app can (a) show the user a generic recoverable
 * notice when the live session is affected and (b) hand developers a sanitized,
 * issue-report-safe export. It is framework-agnostic (no React) so tests and any
 * future surface can drive it directly; AgentWorkspace adapts it with a small
 * `useSyncExternalStore` wrapper.
 *
 * Safety: every payload reaching this module is already sanitized by the
 * classifier, and the export shape derives its preview from {@link sanitizePayload}
 * again — a raw payload is never `JSON.stringify`-ed into a record. Secret-like
 * values are masked at any depth (see `hermes-control-plane/sanitize.ts`).
 */

import type { JuneHermesEvent } from "./hermes-control-plane";
import { nonEmpty, sanitizePayload } from "./hermes-control-plane";

/** The unsupported variant of the classifier's union — the only input here. */
type UnsupportedHermesEvent = Extract<JuneHermesEvent, { kind: "unsupported" }>;

/**
 * Per-session cap on distinct unsupported entries kept in memory. Repeated
 * identical types aggregate into one entry (see {@link UnsupportedEventEntry}),
 * so this bounds the count of *distinct* unsupported types per session; the
 * oldest distinct entry is evicted once exceeded.
 */
export const UNSUPPORTED_EVENTS_PER_SESSION_CAP = 100;

/** Stable bucket key for events that arrive without a session id. */
const NO_SESSION_KEY = "__no_session__";

/** Cap on the sanitized preview string so a record stays small in an export. */
const PREVIEW_MAX_LENGTH = 2000;

/**
 * The issue-report-safe export shape. No raw payloads, no secret values:
 * `payloadKeys` lists the top-level keys (useful triage signal), and
 * `payloadPreview` is a sanitized, depth/length-capped JSON string produced via
 * {@link sanitizePayload}. Mirrors the shape feature 15's trace export reads.
 */
export type UnsupportedHermesEventRecord = {
  observedAt: string;
  sessionId?: string;
  type?: string;
  payloadKeys: string[];
  payloadPreview?: string;
};

/**
 * An aggregated, live in-memory entry: one per distinct `type` within a session.
 * Repeats bump `count` and `lastSeen` rather than appending, so a flood of the
 * same unknown event doesn't spam the buffer or the user.
 */
export type UnsupportedEventEntry = {
  /** Stable identity within a session: the raw type (or a sentinel when absent). */
  type?: string;
  sessionId?: string;
  /** ISO timestamp of the first time this type was seen this session. */
  firstSeen: string;
  /** ISO timestamp of the most recent occurrence. */
  lastSeen: string;
  /** How many times this type has been observed (>= 1). */
  count: number;
  payloadKeys: string[];
  payloadPreview?: string;
};

/**
 * What the active-session notice needs to render. Produced by
 * {@link UnsupportedEventStore.activeNotice}; the UI never reads entries
 * directly. Dev-only fields (`type`, sanitized `payloadPreview`) are present but
 * the component gates whether they render on `import.meta.env.DEV`.
 */
export type UnsupportedEventNoticeData = {
  sessionId: string;
  type?: string;
  count: number;
  lastSeen: string;
  payloadKeys: string[];
  payloadPreview?: string;
};

export type UnsupportedEventStore = {
  /** Ingest one classified `unsupported` event. Total: never throws. */
  record(event: UnsupportedHermesEvent): void;
  /** Aggregated entries for one session, oldest-first. */
  entriesFor(sessionId: string | undefined): UnsupportedEventEntry[];
  /** Safe export records for one session, oldest-first. */
  recordsFor(sessionId: string | undefined): UnsupportedHermesEventRecord[];
  /** Every session flattened into one safe export array. */
  toRecords(): UnsupportedHermesEventRecord[];
  /**
   * The most recent unsupported entry affecting `sessionId`, or `undefined`
   * when that session has none. A `undefined`/empty session never has a notice
   * (a session-less event can't be attributed to the active session).
   */
  activeNotice(
    sessionId: string | undefined,
  ): UnsupportedEventNoticeData | undefined;
  /** Subscribe to changes (for `useSyncExternalStore`). Returns an unsubscribe. */
  subscribe(listener: () => void): () => void;
  /**
   * Monotonic version, bumped on every mutation. The snapshot getter for
   * `useSyncExternalStore`: a primitive that changes when state changes (the
   * underlying Map is mutated in place, so its identity can't be the snapshot).
   * Read the actual data through {@link activeNotice}/{@link toRecords}.
   */
  getVersion(): number;
};

/**
 * Creates an isolated store instance. The app holds one (see
 * `unsupportedEventStore`); tests create their own so state never leaks between
 * cases.
 */
export function createUnsupportedEventStore(): UnsupportedEventStore {
  // sessionKey -> entries (insertion-ordered: Map preserves insertion order, and
  // we re-key on update so "most recently touched" sits last for eviction).
  const bySession = new Map<string, UnsupportedEventEntry[]>();
  const listeners = new Set<() => void>();
  let version = 0;

  function emit(): void {
    version += 1;
    for (const listener of listeners) listener();
  }

  function record(event: UnsupportedHermesEvent): void {
    const sessionId = nonEmpty(event.sessionId);
    const key = sessionId ?? NO_SESSION_KEY;
    const type = nonEmpty(event.rawType);
    const observedAt = new Date().toISOString();
    const { payloadKeys, payloadPreview } = describePayload(
      event.sanitizedPayload,
    );

    const entries = bySession.get(key) ?? [];
    // Aggregate by type within the session. A missing type aggregates under one
    // bucket so a stream of untyped frames also can't spam.
    const existing = entries.find((entry) => entry.type === type);
    if (existing) {
      existing.count += 1;
      existing.lastSeen = observedAt;
      // Refresh the preview/keys to the latest occurrence — the newest payload
      // is the most useful for debugging the current state.
      existing.payloadKeys = payloadKeys;
      existing.payloadPreview = payloadPreview;
    } else {
      entries.push({
        type,
        sessionId,
        firstSeen: observedAt,
        lastSeen: observedAt,
        count: 1,
        payloadKeys,
        payloadPreview,
      });
      // Enforce the per-session cap by dropping the oldest distinct entry.
      while (entries.length > UNSUPPORTED_EVENTS_PER_SESSION_CAP) {
        entries.shift();
      }
    }
    bySession.set(key, entries);
    emit();
  }

  function entriesFor(sessionId: string | undefined): UnsupportedEventEntry[] {
    const key = sessionId ?? NO_SESSION_KEY;
    return (bySession.get(key) ?? []).map(cloneEntry);
  }

  function recordsFor(
    sessionId: string | undefined,
  ): UnsupportedHermesEventRecord[] {
    return entriesFor(sessionId).map(entryToRecord);
  }

  function toRecords(): UnsupportedHermesEventRecord[] {
    const out: UnsupportedHermesEventRecord[] = [];
    for (const entries of bySession.values()) {
      for (const entry of entries) out.push(entryToRecord(entry));
    }
    return out;
  }

  function activeNotice(
    sessionId: string | undefined,
  ): UnsupportedEventNoticeData | undefined {
    const key = nonEmpty(sessionId);
    if (!key) return undefined;
    const entries = bySession.get(key);
    if (!entries || entries.length === 0) return undefined;
    // The most recently seen entry is the one to surface.
    const latest = entries.reduce((a, b) => (b.lastSeen >= a.lastSeen ? b : a));
    return {
      sessionId: key,
      type: latest.type,
      count: latest.count,
      lastSeen: latest.lastSeen,
      payloadKeys: latest.payloadKeys,
      payloadPreview: latest.payloadPreview,
    };
  }

  function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  function getVersion(): number {
    return version;
  }

  return {
    record,
    entriesFor,
    recordsFor,
    toRecords,
    activeNotice,
    subscribe,
    getVersion,
  };
}

/**
 * The app-wide store. AgentWorkspace feeds it from the live gateway
 * subscription and reads `activeNotice` for the selected session. A singleton
 * (not React state) so the bounded buffer survives re-renders and any future
 * non-React reader (debug export, feature 15 trace panel) shares one source.
 */
export const unsupportedEventStore = createUnsupportedEventStore();

/**
 * Turns an already-sanitized payload into the export-safe shape: top-level keys
 * plus a capped JSON preview. The payload has already been through
 * {@link sanitizePayload} in the classifier; we sanitize again here as a
 * defense-in-depth belt-and-braces so this function is safe even if a caller
 * passes a not-yet-sanitized value, and we never `JSON.stringify` a raw payload.
 */
function describePayload(sanitized: unknown): {
  payloadKeys: string[];
  payloadPreview?: string;
} {
  if (sanitized === null || sanitized === undefined) {
    return { payloadKeys: [] };
  }
  const safe = sanitizePayload(sanitized);
  const payloadKeys =
    typeof safe === "object" && safe !== null && !Array.isArray(safe)
      ? Object.keys(safe as Record<string, unknown>)
      : [];
  let payloadPreview: string | undefined;
  try {
    const json = JSON.stringify(safe, null, 2);
    if (typeof json === "string") {
      payloadPreview =
        json.length > PREVIEW_MAX_LENGTH
          ? `${json.slice(0, PREVIEW_MAX_LENGTH)}…`
          : json;
    }
  } catch {
    // A value that can't be stringified (shouldn't happen post-sanitize) just
    // yields no preview rather than throwing.
    payloadPreview = undefined;
  }
  return { payloadKeys, payloadPreview };
}

function entryToRecord(
  entry: UnsupportedEventEntry,
): UnsupportedHermesEventRecord {
  return {
    observedAt: entry.lastSeen,
    sessionId: entry.sessionId,
    type: entry.type,
    payloadKeys: entry.payloadKeys,
    payloadPreview: entry.payloadPreview,
  };
}

function cloneEntry(entry: UnsupportedEventEntry): UnsupportedEventEntry {
  return { ...entry, payloadKeys: [...entry.payloadKeys] };
}
