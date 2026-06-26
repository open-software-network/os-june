/**
 * Bounded, GLOBAL (cross-session) store of pending Hermes actions — the data
 * source behind feature 04's top-level "Needs you" tray.
 *
 * Hermes blocks the agent on four kinds of action until the user responds:
 * clarify, approval, sudo, secret (see `PendingHermesAction`). Each one is
 * surfaced inline in the session it belongs to (feature 03), but the inline
 * cards can't answer "what across ALL my sessions is waiting on me right now?".
 * This store is that aggregation: every `pending_action` event the gateway
 * classifies lands here, keyed by `mode + sessionId + requestId`, so the tray
 * can list one row per outstanding action and route a click to the right
 * session.
 *
 * Lifecycle (the careful part):
 * - An action is `open` when first seen and stays open until *confirmed*
 *   resolution: a matching response/the user responds (`resolveRequest`), the
 *   session completes or is interrupted or hits a terminal error
 *   (`resolveSession`).
 * - On a gateway reconnect we do NOT clear anything — a disconnect is not a
 *   resolution. Instead `reconcileAfterReconnect` marks still-unresolved actions
 *   `stale`: they remain visible (a stale-but-dismissable row beats a hidden
 *   blocker) but the tray renders them visually distinct. A fresh event for the
 *   same request after reconnect re-confirms it back to `open`.
 * - Resolution is sticky: once `resolved`, a straggler duplicate of the same
 *   request can't resurrect the row.
 *
 * Framework-agnostic (no React) so tests drive it directly; AgentWorkspace
 * adapts it with a `useSyncExternalStore` wrapper, mirroring features 02/15.
 * Feature 11's activity drawer reads the same instance for its pending counts.
 */

import type {
  HermesMode,
  JuneHermesEvent,
  PendingHermesAction,
} from "./hermes-control-plane";
import { nonEmpty } from "./hermes-control-plane";

/** The `pending_action` variant of the classifier union — the store's input. */
type PendingActionEvent = Extract<JuneHermesEvent, { kind: "pending_action" }>;

/**
 * Cap on total records (open + resolved history) kept in memory. Open rows are
 * few by nature (the user can only be blocked on so many things at once); the
 * cap mostly bounds resolved history, which eviction sheds first.
 */
export const PENDING_ACTIONS_CAP = 200;

/** A record's lifecycle phase. `stale` = unreconciled after a reconnect. */
export type PendingActionStatus = "open" | "submitting" | "resolved" | "stale";

/** Stable identity across the pack: mode, session, and the request id. */
export type PendingActionKey = `${HermesMode}:${string}:${string}`;

/**
 * One tracked pending action. `action` is the already-sanitized
 * {@link PendingHermesAction} from the classifier (a secret's value is never on
 * it). `firstSeenAt`/`lastSeenAt` are epoch ms; the tray formats the age.
 */
export type PendingActionRecord = {
  key: PendingActionKey;
  mode: HermesMode;
  sessionId: string;
  requestId: string;
  action: PendingHermesAction;
  firstSeenAt: number;
  lastSeenAt: number;
  status: PendingActionStatus;
};

/** Statuses that still demand the user's attention (and so show in the tray). */
const OPEN_STATUSES: ReadonlySet<PendingActionStatus> = new Set([
  "open",
  "submitting",
  "stale",
]);

export type PendingActionStore = {
  /**
   * Ingest one classified `pending_action` event. `mode` is the session's mode
   * (derive it with `hermesModeFor(sessionId)` at the call site). Total: never
   * throws. A second event for an already-`resolved` request is ignored so a
   * straggler can't resurrect a row; any other re-record refreshes `lastSeenAt`
   * and (if `stale`) re-confirms the row back to `open`.
   */
  record(event: PendingActionEvent, mode: HermesMode): void;
  /**
   * Mark the action for `(sessionId, requestId)` resolved — the user responded
   * or a matching response arrived. No-op (and no version bump) if unknown.
   */
  resolveRequest(sessionId: string, requestId: string): void;
  /**
   * Resolve every still-open action for a session. Call when the session
   * completes, is interrupted, or reports a terminal (non-recoverable) error —
   * the agent is no longer waiting, so the blockers are moot.
   */
  resolveSession(sessionId: string): void;
  /**
   * Record that the gateway dropped. Intentionally a no-op on state: a
   * disconnect is NOT a resolution, so pending actions must survive it. Present
   * so the call site reads clearly and a future policy has a hook.
   */
  markDisconnected(): void;
  /**
   * After a reconnect, mark every still-open action `stale`. They stay visible
   * (never silently dropped); a fresh event re-confirms them to `open`.
   */
  reconcileAfterReconnect(): void;
  /** Every record (open + resolved history), newest-first. */
  getRecords(): PendingActionRecord[];
  /** Only the records that still need the user, newest-first (tray feed). */
  openRecords(): PendingActionRecord[];
  /** Count of actions still needing the user (badge count for tray/drawer). */
  openCount(): number;
  /** Subscribe to changes (for `useSyncExternalStore`). Returns an unsubscribe. */
  subscribe(listener: () => void): () => void;
  /** Monotonic version, bumped on every mutation (the snapshot getter). */
  getVersion(): number;
};

/**
 * Creates an isolated store instance. The app holds one (see
 * {@link pendingActionStore}); tests create their own so state never leaks.
 */
export function createPendingActionStore(): PendingActionStore {
  // key -> record. Insertion order is preserved; we re-insert on mutation so
  // the most recently touched record sits last (eviction drops from the front).
  const byKey = new Map<PendingActionKey, PendingActionRecord>();
  const listeners = new Set<() => void>();
  let version = 0;

  function emit(): void {
    version += 1;
    for (const listener of listeners) listener();
  }

  function keyFor(
    mode: HermesMode,
    sessionId: string,
    requestId: string,
  ): PendingActionKey {
    return `${mode}:${sessionId}:${requestId}`;
  }

  function record(event: PendingActionEvent, mode: HermesMode): void {
    const sessionId = nonEmpty(event.sessionId);
    const requestId = nonEmpty(event.action.requestId);
    // A pending action that can't be attributed to a session a user could open
    // (or that lacks a request id to resolve against) is unactionable — drop it
    // rather than show a dead row.
    if (!sessionId || !requestId) return;

    const key = keyFor(mode, sessionId, requestId);
    const now = Date.now();
    const existing = byKey.get(key);

    if (existing) {
      // A duplicate of an already-resolved request must NOT reopen it.
      if (existing.status === "resolved") return;
      existing.lastSeenAt = now;
      // A fresh event proves the action is still pending → clear any staleness.
      existing.status = "open";
      // Refresh the action snapshot to the latest payload.
      existing.action = event.action;
      // Re-key (delete+set) so this becomes the most-recently-touched entry.
      byKey.delete(key);
      byKey.set(key, existing);
      emit();
      return;
    }

    byKey.set(key, {
      key,
      mode,
      sessionId,
      requestId,
      action: event.action,
      firstSeenAt: now,
      lastSeenAt: now,
      status: "open",
    });
    evict();
    emit();
  }

  function resolveRequest(sessionId: string, requestId: string): void {
    const sid = nonEmpty(sessionId);
    const rid = nonEmpty(requestId);
    if (!sid || !rid) return;
    let changed = false;
    for (const record of byKey.values()) {
      if (
        record.sessionId === sid &&
        record.requestId === rid &&
        record.status !== "resolved"
      ) {
        record.status = "resolved";
        record.lastSeenAt = Date.now();
        changed = true;
      }
    }
    if (changed) emit();
  }

  function resolveSession(sessionId: string): void {
    const sid = nonEmpty(sessionId);
    if (!sid) return;
    let changed = false;
    for (const record of byKey.values()) {
      if (record.sessionId === sid && record.status !== "resolved") {
        record.status = "resolved";
        record.lastSeenAt = Date.now();
        changed = true;
      }
    }
    if (changed) emit();
  }

  function markDisconnected(): void {
    // Deliberately no state change: a disconnect is not a resolution. Pending
    // actions must survive a reconnect (see module doc / feature 04 spec).
  }

  function reconcileAfterReconnect(): void {
    let changed = false;
    for (const record of byKey.values()) {
      if (record.status === "open" || record.status === "submitting") {
        record.status = "stale";
        changed = true;
      }
    }
    if (changed) emit();
  }

  function getRecords(): PendingActionRecord[] {
    // Newest-first by last activity.
    return [...byKey.values()]
      .map(cloneRecord)
      .sort((a, b) => b.lastSeenAt - a.lastSeenAt);
  }

  function openRecords(): PendingActionRecord[] {
    return getRecords().filter((record) => OPEN_STATUSES.has(record.status));
  }

  function openCount(): number {
    let count = 0;
    for (const record of byKey.values()) {
      if (OPEN_STATUSES.has(record.status)) count += 1;
    }
    return count;
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

  /**
   * Keep the map within the cap. Evict already-resolved history first (oldest by
   * insertion order), and only touch still-open rows if resolved history alone
   * can't get us under the cap — a blocker the user hasn't answered is the last
   * thing we want to silently drop.
   */
  function evict(): void {
    if (byKey.size <= PENDING_ACTIONS_CAP) return;
    // First pass: drop oldest resolved.
    for (const [key, record] of byKey) {
      if (byKey.size <= PENDING_ACTIONS_CAP) break;
      if (record.status === "resolved") byKey.delete(key);
    }
    // Second pass (rare): still over cap with only open rows — drop oldest.
    for (const key of byKey.keys()) {
      if (byKey.size <= PENDING_ACTIONS_CAP) break;
      byKey.delete(key);
    }
  }

  return {
    record,
    resolveRequest,
    resolveSession,
    markDisconnected,
    reconcileAfterReconnect,
    getRecords,
    openRecords,
    openCount,
    subscribe,
    getVersion,
  };
}

/**
 * The app-wide store. AgentWorkspace feeds it from the live gateway
 * subscription (at the existing `classifyHermesEvent` site) and the tray reads
 * it. A singleton (not React state) so the bounded buffer survives re-renders
 * and feature 11's activity drawer can share one source of pending counts.
 */
export const pendingActionStore = createPendingActionStore();

function cloneRecord(record: PendingActionRecord): PendingActionRecord {
  return { ...record };
}
