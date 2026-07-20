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
  return session.active !== true && session.is_active !== true;
}

function runIsFresh(session: HermesSessionInfo, now: number) {
  const timestamp = Date.parse(sessionTimestamp(session));
  if (!Number.isFinite(timestamp) || timestamp <= 0) return false;
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

  // Prune: keep only ids still visible in the fetch window (plus the new
  // ones), so the set cannot grow without bound.
  const visible = new Set(endedRuns.map((run) => run.id));
  const kept = [...state.seen].filter((id) => visible.has(id));
  for (const run of endedRuns) {
    if (!state.seen.has(run.id) && (visible.has(run.id) || runIsFresh(run, now))) {
      kept.push(run.id);
    }
  }
  const next: RoutineRunWatchState = {
    seen: new Set(kept.slice(-MAX_TRACKED_RUNS)),
    primed: true,
  };
  return { next, notices };
}
