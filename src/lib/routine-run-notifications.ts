/**
 * Notifications for finished routine runs.
 *
 * Routines fire on Hermes's launchd-managed gateway, so a run can start and
 * finish with no webview involvement at all - nothing in the event stream
 * reaches the app for them. The only trustworthy signal is the session store,
 * which the Routines view already polls. This module watches that same feed
 * app-wide: when a scheduled run transitions to ended, it posts one native
 * notification whose click deep-links into the run's conversation (the
 * session id rides along through the existing send_app_notification path).
 *
 * A silent scheduled routine retains nobody: the whole point of a morning
 * brief is that the user hears about it.
 *
 * Design constraints, in order:
 * - Never renotify: the notified-run set persists in localStorage so app
 *   restarts (and webview reloads) stay quiet about old runs.
 * - Never backfill: the first poll of an install baselines every already
 *   ended run as seen. Notifications only cover transitions observed live.
 * - Never grow unbounded: the persisted set is pruned to the run ids still
 *   inside the session-store fetch window plus a small tail.
 */

import { isScheduledRunSession, scheduledRunJobId, sessionTimestamp } from "./hermes-adapter";
import type { HermesSessionInfo } from "./tauri";

const STORAGE_KEY = "june.routineRuns.notified";
/** Ended runs older than this at first sight are treated as history, not
 * news - covers the app being closed overnight while runs pile up. */
const FRESH_RUN_WINDOW_MS = 30 * 60 * 1000;
/** Cap on the persisted notified-id set after pruning. */
const MAX_TRACKED_RUNS = 300;

export type RoutineRunNotice = {
  sessionId: string;
  jobId?: string;
  title: string;
  body: string;
};

export type RoutineRunWatchState = {
  /** Run session ids already notified (or baselined). */
  seen: ReadonlySet<string>;
  /** False until the first poll baselined existing history. */
  primed: boolean;
};

export function loadRoutineRunWatchState(): RoutineRunWatchState {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { seen: new Set(), primed: false };
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return { seen: new Set(), primed: false };
    const ids = parsed.filter((value): value is string => typeof value === "string");
    // A persisted set means a previous session already baselined.
    return { seen: new Set(ids), primed: true };
  } catch {
    return { seen: new Set(), primed: false };
  }
}

export function saveRoutineRunWatchState(state: RoutineRunWatchState) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify([...state.seen]));
  } catch {
    // Storage unavailable: worst case is a repeat notification after reload.
  }
}

function hasEnded(session: HermesSessionInfo) {
  const ended = session.ended_at ?? session.endedAt ?? session.end_reason ?? undefined;
  if (typeof ended === "string" && ended.trim()) return true;
  // Inactivity alone is not proof of completion: cron sessions are persisted
  // before their first message lands, so a stuck run can sit inactive with
  // zero messages and no end marker. Only an inactive run that produced
  // messages reads as finished.
  return session.active !== true && session.is_active !== true && (session.message_count ?? 0) > 0;
}

/**
 * Freshness for a finished routine run prefers the end timestamp when the
 * session has one. `sessionTimestamp` ranks `last_active` first, which can
 * predate a long-running job's real completion and make a just-ended run look
 * older than the fresh window.
 */
export function routineRunFreshnessTimestamp(session: HermesSessionInfo): number | null {
  const ended = session.ended_at ?? session.endedAt;
  if (typeof ended === "string" && ended.trim()) {
    const endedAt = Date.parse(ended);
    if (Number.isFinite(endedAt) && endedAt > 0) return endedAt;
  }

  const fallback = Date.parse(sessionTimestamp(session));
  if (!Number.isFinite(fallback) || fallback <= 0) return null;
  return fallback;
}

function runIsFresh(session: HermesSessionInfo, now: number) {
  const timestamp = routineRunFreshnessTimestamp(session);
  if (timestamp == null) return false;
  return now - timestamp <= FRESH_RUN_WINDOW_MS;
}

function noticeFor(session: HermesSessionInfo): RoutineRunNotice {
  const title = session.title?.trim() || "Routine finished";
  const body = session.preview?.trim() || "Open June to read the result.";
  return {
    sessionId: session.id,
    jobId: scheduledRunJobId(session.id),
    title,
    body,
  };
}

/**
 * Pure transition step: given the previous watch state and a fresh session
 * snapshot, returns the notices to post and the next state. The first call
 * on an unprimed state baselines silently.
 *
 * Notice ids are NOT folded into the returned state: delivery can fail
 * (bridge hiccup, notification permission revoked), and marking before a
 * successful send would make that failure silent and permanent. Callers
 * confirm delivery with {@link markRunsNotified}; an unconfirmed run is
 * retried on the next step until the freshness window closes over it.
 */
export function routineRunWatchStep(
  state: RoutineRunWatchState,
  sessions: readonly HermesSessionInfo[],
  now: number,
): { next: RoutineRunWatchState; notices: RoutineRunNotice[] } {
  const runs = sessions.filter(isScheduledRunSession);
  const endedRuns = runs.filter(hasEnded);

  if (!state.primed) {
    return {
      next: { seen: new Set(endedRuns.map((run) => run.id)), primed: true },
      notices: [],
    };
  }

  const notices = endedRuns
    .filter((run) => !state.seen.has(run.id) && runIsFresh(run, now))
    .map(noticeFor);

  // Prune: keep only ids still visible in the fetch window, so the set
  // cannot grow without bound. Newly noticed ids join through
  // markRunsNotified once their notification actually went out.
  const visible = new Set(endedRuns.map((run) => run.id));
  const kept = [...state.seen].filter((id) => visible.has(id));
  const next: RoutineRunWatchState = {
    seen: new Set(kept.slice(-MAX_TRACKED_RUNS)),
    primed: true,
  };
  return { next, notices };
}

/** Folds successfully delivered run ids into the watch state. */
export function markRunsNotified(
  state: RoutineRunWatchState,
  runIds: readonly string[],
): RoutineRunWatchState {
  if (runIds.length === 0) return state;
  const seen = new Set(state.seen);
  for (const id of runIds) seen.add(id);
  return {
    seen: new Set([...seen].slice(-MAX_TRACKED_RUNS)),
    primed: state.primed,
  };
}

/**
 * Serializes async work so overlapping polls cannot both deliver the same
 * routine notice. Returns false when a previous call is still running.
 */
export function createSingleFlight() {
  let inFlight = false;
  return async function runSingleFlight(task: () => Promise<void>): Promise<boolean> {
    if (inFlight) return false;
    inFlight = true;
    try {
      await task();
      return true;
    } finally {
      inFlight = false;
    }
  };
}
