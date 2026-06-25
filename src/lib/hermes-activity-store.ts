/**
 * Bounded, GLOBAL (cross-session) store of live agent activity — the data source
 * behind feature 11's Agent activity drawer.
 *
 * Where feature 04's `pendingActionStore` answers "what is blocked on me?", this
 * store answers the broader "what are my agents doing right now?": for each
 * session it keeps one rolled-up {@link AgentActivityRecord} — the phase
 * (running / waiting / background / error / complete), the tool in flight, how
 * many subagents are working, and when it last did anything. The drawer renders
 * these rows; it does not re-derive them from raw frames.
 *
 * Fed ONLY from the normalized {@link JuneHermesEvent} stream (the classifier's
 * output), never from raw gateway frames — raw JSON belongs to feature 15's
 * trace panel, not here. AgentWorkspace owns the single write path: it calls
 * `record(event, mode)` at the existing `classifyHermesEvent` site, exactly
 * where it already feeds the pending-action and unsupported stores.
 *
 * Pending-action counts are NOT counted here — they are the authority of feature
 * 04's store. The factory takes a `pendingCountFor(sessionId)` resolver (wired to
 * `pendingActionStore` in the singleton) so the two never drift and tests can
 * drive it directly.
 *
 * Framework-agnostic (no React) so tests drive it directly; AgentWorkspace adapts
 * it with a `useSyncExternalStore` wrapper, mirroring features 02/04/15.
 *
 * EXTENDING (downstream features): keep the per-session rollup shape.
 * - Feature 12 (subagent watch) SHIPPED: `subagentCount` is now backed by a
 *   `subagents: BackgroundHermesActivity[]` field, UPSERTED by `subagentId`/
 *   `handle` in {@link applyBackgroundActivity} and rendered as a "Background
 *   work" sub-list under the parent row in the drawer.
 * - Feature 14 (files touched / artifacts) adds an artifact timeline: add e.g.
 *   `artifacts: ...[]` here, fed from `tool` completions that write files, and
 *   render a drawer section. Keep the per-session rollup shape; do not add a
 *   second store.
 */

import type {
  BackgroundHermesActivity,
  BackgroundHermesPhase,
  HermesMode,
  JuneHermesEvent,
} from "./hermes-control-plane";
import { nonEmpty } from "./hermes-control-plane";
import { pendingActionStore } from "./hermes-pending-actions";

/**
 * Cap on the number of sessions tracked at once. Live activity is inherently
 * few (a user runs a handful of agents), so this mostly bounds completed/errored
 * rows the user hasn't dismissed; eviction drops the oldest by last activity.
 */
export const ACTIVITY_SESSIONS_CAP = 50;

/** The phase a session's agent is in, derived from the latest event kind. */
export type AgentActivityPhase =
  | "running"
  | "waiting"
  | "background"
  | "error"
  | "complete";

/**
 * One session's rolled-up activity. `pendingActionCount` is read live from
 * feature 04's store (not counted here). `lastEventAt` is epoch ms; the drawer
 * formats the age. `title`/`mode`/`currentTool` degrade gracefully when an event
 * doesn't carry them.
 */
export type AgentActivityRecord = {
  id: string;
  mode: HermesMode;
  sessionId: string;
  title?: string;
  phase: AgentActivityPhase;
  currentTool?: string;
  pendingActionCount: number;
  /**
   * How many subagents are still WORKING (non-terminal phase) — the count the
   * drawer's "in progress" badge reads, so it doesn't keep claiming background
   * work after every subagent finished. May be less than `subagents.length`
   * (which keeps every subagent, terminal or not, for display).
   */
  subagentCount: number;
  /**
   * Feature 12: the parent session's delegated subagents, one record each,
   * UPSERTED by `subagentId`/`handle` (progress updates the same entry, never a
   * duplicate). Ordered by first-seen so the drawer's "Background work" sub-list
   * is stable as updates stream in. Empty for sessions with no background work.
   * The full list is preserved (terminal subagents included); the active subset
   * is summarized by `subagentCount`. The normalized
   * {@link BackgroundHermesActivity} carries everything the drawer renders
   * (goal/task, phase, parent session, current tool, last-event time, result
   * preview) and preserves the Hermes `subagentId`/`handle` so feature 13 can
   * target an interrupt at a trustworthy id.
   */
  subagents: BackgroundHermesActivity[];
  lastEventAt: number;
};

/** Phases that mean the session is still doing work (drives `activeCount`). */
const ACTIVE_PHASES: ReadonlySet<AgentActivityPhase> = new Set([
  "running",
  "waiting",
  "background",
]);

export type HermesActivityStore = {
  /**
   * Ingest one classified event for a session, updating that session's rolled-up
   * row. `mode` is the session's mode (derive it with `hermesModeFor(sessionId)`
   * at the call site). Total: never throws. Events that can't be attributed to a
   * session (no/empty session id) are ignored — there is nothing to roll up.
   */
  record(event: JuneHermesEvent, mode: HermesMode): void;
  /** Drop a session's row entirely (e.g. the user deleted the session). */
  clearSession(sessionId: string): void;
  /** Every tracked session's row, newest-first by last activity. */
  getRecords(): AgentActivityRecord[];
  /** One session's row, or `undefined` if untracked. */
  getRecord(sessionId: string): AgentActivityRecord | undefined;
  /** Count of sessions still doing work (running/waiting/background). */
  activeCount(): number;
  /** Subscribe to changes (for `useSyncExternalStore`). Returns an unsubscribe. */
  subscribe(listener: () => void): () => void;
  /** Monotonic version, bumped on every mutation (the snapshot getter). */
  getVersion(): number;
};

/** Options for {@link createHermesActivityStore}. */
export type HermesActivityStoreOptions = {
  /**
   * Live count of open pending actions for a session. Defaults to feature 04's
   * `pendingActionStore`; tests inject their own so the two stores stay
   * decoupled. Reading it on every snapshot keeps the count honest without this
   * store having to subscribe to (or duplicate) the pending-action store.
   */
  pendingCountFor?: (sessionId: string) => number;
};

/**
 * Default pending-count resolver: ask feature 04's global store how many open
 * actions a session has. Open records already exclude resolved ones.
 */
function defaultPendingCountFor(sessionId: string): number {
  let count = 0;
  for (const record of pendingActionStore.openRecords()) {
    if (record.sessionId === sessionId) count += 1;
  }
  return count;
}

/**
 * Creates an isolated store instance. The app holds one (see
 * {@link hermesActivityStore}); tests create their own so state never leaks.
 */
export function createHermesActivityStore(
  options: HermesActivityStoreOptions = {},
): HermesActivityStore {
  const pendingCountFor = options.pendingCountFor ?? defaultPendingCountFor;

  // sessionId -> mutable internal row. Insertion order is preserved; we re-key
  // on mutation so the most-recently-touched row sits last (eviction drops from
  // the front, i.e. the least recently active).
  const bySession = new Map<string, InternalRecord>();
  const listeners = new Set<() => void>();
  let version = 0;

  function emit(): void {
    version += 1;
    for (const listener of listeners) listener();
  }

  function record(event: JuneHermesEvent, mode: HermesMode): void {
    const sessionId = sessionIdOf(event);
    if (!sessionId) return;

    const existing = bySession.get(sessionId);
    const row: InternalRecord = existing ?? {
      sessionId,
      mode,
      phase: "running",
      currentTool: undefined,
      subagents: new Map<string, BackgroundHermesActivity>(),
      lastEventAt: Date.now(),
    };

    // The mode can sharpen over a session's life (a sandboxed session opting
    // into unrestricted) but never downgrade: `mode` defaults to `sandboxed`
    // for an unresolved session, so re-asserting it on a late event would mask
    // an established `unrestricted` row behind a green "Sandboxed" shield — the
    // wrong, unsafe direction. Only ever upgrade.
    if (mode === "unrestricted") row.mode = mode;
    row.lastEventAt = eventTimestamp(event);
    applyEvent(row, event);

    // Re-key so this becomes the most-recently-touched entry for eviction.
    bySession.delete(sessionId);
    bySession.set(sessionId, row);
    evict();
    emit();
  }

  function clearSession(sessionId: string): void {
    if (bySession.delete(sessionId)) emit();
  }

  function getRecords(): AgentActivityRecord[] {
    return [...bySession.values()]
      .map(toRecord)
      .sort((a, b) => b.lastEventAt - a.lastEventAt);
  }

  function getRecord(sessionId: string): AgentActivityRecord | undefined {
    const row = bySession.get(sessionId);
    return row ? toRecord(row) : undefined;
  }

  function activeCount(): number {
    let count = 0;
    for (const row of bySession.values()) {
      if (ACTIVE_PHASES.has(row.phase)) count += 1;
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

  /** Keep the map within the cap by dropping the oldest (least recently active). */
  function evict(): void {
    while (bySession.size > ACTIVITY_SESSIONS_CAP) {
      const oldest = bySession.keys().next().value;
      if (oldest === undefined) break;
      bySession.delete(oldest);
    }
  }

  // Project an internal row into the public, count-resolved record. The pending
  // count is read live here so it always reflects feature 04's current state.
  function toRecord(row: InternalRecord): AgentActivityRecord {
    return {
      id: row.sessionId,
      mode: row.mode,
      sessionId: row.sessionId,
      title: row.title,
      phase: row.phase,
      currentTool: row.currentTool,
      pendingActionCount: pendingCountFor(row.sessionId),
      // Count only ACTIVE (non-terminal) subagents: the badge implies work in
      // progress, so finished/errored ones must not keep it lit. The full list
      // below still carries every subagent for display.
      subagentCount: countActiveSubagents(row.subagents),
      // Snapshot the upserted subagent records in first-seen order (Map
      // preserves insertion order). Copies so callers can't mutate store state.
      subagents: [...row.subagents.values()],
      lastEventAt: row.lastEventAt,
    };
  }

  return {
    record,
    clearSession,
    getRecords,
    getRecord,
    activeCount,
    subscribe,
    getVersion,
  };
}

/**
 * The app-wide store. AgentWorkspace feeds it from the live gateway
 * subscription (at the existing `classifyHermesEvent` site) and the drawer reads
 * it. A singleton (not React state) so the bounded buffer survives re-renders and
 * the pending-count resolver shares feature 04's one source of truth.
 */
export const hermesActivityStore = createHermesActivityStore();

/** The mutable internal shape. Subagents are an insertion-ordered Map keyed by
 * the subagent's stable id (feature 12): the public `subagentCount` is its size
 * and the public `subagents` array is its values, in first-seen order. The
 * public record never exposes the Map itself. */
type InternalRecord = {
  sessionId: string;
  mode: HermesMode;
  title?: string;
  phase: AgentActivityPhase;
  currentTool?: string;
  subagents: Map<string, BackgroundHermesActivity>;
  lastEventAt: number;
};

/**
 * Fold one event into a session's row. This is the SINGLE place phase is
 * derived from event kind:
 * - `tool` (any phase)        -> running, and remember the tool name.
 * - `pending_action`          -> waiting (the agent is blocked on the user).
 * - `background_activity`     -> background, and track the subagent's id/count.
 * - `error`                   -> error.
 * - `lifecycle`               -> complete when the status is terminal, else
 *                                running (the session is alive and progressing).
 * - `transcript` / `reasoning`-> running (the agent is producing output).
 * - `unsupported`             -> no phase change (don't let an unknown frame
 *                                misreport the session's state).
 */
function applyEvent(row: InternalRecord, event: JuneHermesEvent): void {
  switch (event.kind) {
    case "tool":
      row.phase = "running";
      if (nonEmpty(event.name)) row.currentTool = event.name;
      // A finished tool call leaves no tool in flight.
      if (event.phase === "complete") row.currentTool = undefined;
      return;
    case "pending_action":
      row.phase = "waiting";
      return;
    case "background_activity":
      applyBackgroundActivity(row, event);
      return;
    case "error":
      row.phase = "error";
      return;
    case "lifecycle":
      row.phase = isTerminalLifecycleStatus(event.status)
        ? "complete"
        : "running";
      return;
    case "transcript":
    case "reasoning":
      // The agent is actively producing output — running, unless it has already
      // reached a terminal state this turn (a late delta shouldn't un-complete).
      if (row.phase !== "complete" && row.phase !== "error")
        row.phase = "running";
      return;
    case "unsupported":
      // An event June can't model must not silently change the reported phase.
      return;
  }
}

/**
 * Fold one subagent event into the parent session's row (feature 12).
 *
 * The subagent is keyed by its stable Hermes id (`subagentId`, falling back to
 * `handle`) and UPSERTED: a `start` seeds the record; later `progress`/`tool`/
 * `thinking`/`complete`/`error`/`blocked` events update the SAME record in place
 * (no duplicate row), advancing the phase, current tool, result preview and
 * last-event time while PRESERVING earlier-known fields a later, terser event
 * omits (e.g. the `goal` set at `start`). This is also how a background
 * subagent that re-enters the conversation on completion links back to its
 * original row — same id, same entry.
 *
 * While any subagent is still working the parent session sits in `background`.
 * But a subagent finishing or erroring CAN end the parent's background phase:
 * once the incoming event is terminal and no non-terminal subagent remains, the
 * parent leaves `background` (otherwise a fire-and-forget subagent whose last
 * frame is `subagent.complete`, with no trailing `session.complete`, would
 * strand the parent in `background` — and `background ∈ ACTIVE_PHASES`, so
 * `activeCount()` would overcount forever). The derived phase mirrors the
 * survivors: `error` if any subagent errored, else `complete`.
 */
function applyBackgroundActivity(
  row: InternalRecord,
  event: Extract<JuneHermesEvent, { kind: "background_activity" }>,
): void {
  const { activity } = event;
  // The classifier guarantees a non-empty `subagentId` (it falls back to
  // "subagent" for payloads with no id/handle), so unknown payloads still get a
  // safe, stable key rather than being dropped.
  const key = nonEmpty(activity.subagentId) ?? nonEmpty(activity.handle);
  if (key) {
    const previous = row.subagents.get(key);
    // Merge so a terse progress event never blanks a field an earlier event
    // established (goal/handle/parentSessionId/currentTool/resultPreview).
    row.subagents.set(key, {
      ...previous,
      ...activity,
      handle: nonEmpty(activity.handle) ?? previous?.handle,
      parentSessionId:
        nonEmpty(activity.parentSessionId) ?? previous?.parentSessionId,
      goal: nonEmpty(activity.goal) ?? previous?.goal,
      currentTool: nonEmpty(activity.currentTool) ?? previous?.currentTool,
      resultPreview:
        nonEmpty(activity.resultPreview) ?? previous?.resultPreview,
    });
  }
  if (nonEmpty(activity.currentTool)) row.currentTool = activity.currentTool;

  // If this subagent is still working, the parent is unambiguously background.
  // If it's terminal, only stay background while some OTHER subagent is still
  // live; otherwise derive the parent's resting phase from the survivors so the
  // active-agent pill stops counting a session whose background work is done.
  if (!isTerminalSubagentPhase(activity.phase)) {
    row.phase = "background";
    return;
  }
  const subagents = [...row.subagents.values()];
  const anyActive = subagents.some((s) => !isTerminalSubagentPhase(s.phase));
  if (anyActive) {
    row.phase = "background";
    return;
  }
  row.phase = subagents.some((s) => s.phase === "error") ? "error" : "complete";
}

/** Terminal subagent phases: no live work remains for that subagent. Mirrors
 * the drawer's `isTerminalSubagentPhase`. `blocked` is NOT terminal — a blocked
 * subagent can still resume, so the parent stays in background for it. */
function isTerminalSubagentPhase(phase: BackgroundHermesPhase): boolean {
  return phase === "complete" || phase === "error";
}

/** How many of a session's subagents are still working (drives the drawer's
 * "in progress" badge). Excludes terminal ones so the badge doesn't claim "3
 * background subagents" after all three finished. */
function countActiveSubagents(
  subagents: Map<string, BackgroundHermesActivity>,
): number {
  let count = 0;
  for (const subagent of subagents.values()) {
    if (!isTerminalSubagentPhase(subagent.phase)) count += 1;
  }
  return count;
}

/**
 * Whether a lifecycle status string means the session is done. The classifier
 * sets `status` to the payload's status field or the raw type (e.g.
 * `session.complete`), so match terminal-flavored strings defensively. Mirrors
 * the spirit of AgentWorkspace's `isTerminalHermesEvent`.
 */
function isTerminalLifecycleStatus(status: string | undefined): boolean {
  if (typeof status !== "string") return false;
  const normalized = status.toLowerCase();
  return (
    normalized === "complete" ||
    normalized === "completed" ||
    normalized === "done" ||
    normalized === "finished" ||
    normalized === "cancelled" ||
    normalized === "canceled" ||
    normalized.endsWith(".complete") ||
    normalized.endsWith(".completed")
  );
}

/**
 * The session id an event rolls up under. Most kinds carry a non-optional
 * `sessionId`, but the classifier uses `""` when a frame had none, and a couple
 * of kinds make it optional — treat empty/missing as unattributable.
 */
function sessionIdOf(event: JuneHermesEvent): string | undefined {
  return nonEmpty(event.sessionId);
}

/**
 * Resolve an event's timestamp to epoch ms. Background activity carries an ISO
 * `lastEventAt` from the classifier; everything else is "now" (the moment we
 * processed it). A bad ISO string falls back to now rather than NaN.
 */
function eventTimestamp(event: JuneHermesEvent): number {
  if (event.kind === "background_activity") {
    const parsed = Date.parse(event.activity.lastEventAt);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return Date.now();
}
