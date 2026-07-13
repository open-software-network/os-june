// Trigger state for the referral delight nudge (see the ReferralNudge
// component for the card itself). The nudge appears at moments June has just
// delivered value; this module owns the per-install counters and the
// frequency caps that make it rare:
//
//   - each moment fires once per install, ever (a suppressed moment is
//     consumed, not queued);
//   - at most one nudge per 14 days, at most 2 lifetime;
//   - a click-through into the referral dialog ends all nudging, forever.
//
// The record* functions are called from wherever the product signal lives
// (note processing, agent session status, the dictation helper, the report
// flow). They persist progress and, when a threshold event occurs AND the
// caps permit showing, dispatch REFERRAL_NUDGE_EVENT. The shell decides
// whether the card actually appears (signed in, onboarded, not local dev,
// referrals available on this deployment) and then confirms with
// markReferralNudgeShown / markReferralNudgeClickedThrough.
//
// Counters start at zero when this ships: an install that already has many
// notes or dictations earns its thresholds from here forward, which keeps
// every fire a genuine "June just did this for you" moment rather than a
// backfill surprise on update.

export type ReferralNudgeMoment = "meetings" | "agent" | "dictation" | "feedback";

/** Dispatched on window when a moment fires and the caps permit showing. */
export const REFERRAL_NUDGE_EVENT = "june:referral-nudge";

export const REFERRAL_NUDGE_STORAGE_KEY = "june.referralNudge";

export const REFERRAL_NUDGE_NOTE_THRESHOLD = 5;
export const REFERRAL_NUDGE_DICTATION_THRESHOLD = 25;
export const REFERRAL_NUDGE_MIN_INTERVAL_MS = 14 * 24 * 60 * 60 * 1000;
export const REFERRAL_NUDGE_LIFETIME_MAX = 2;

type ReferralNudgeState = {
  noteCount: number;
  dictationCount: number;
  consumed: ReferralNudgeMoment[];
  shownCount: number;
  lastShownAt: number | null;
  clickedThrough: boolean;
};

// A function, not a constant: fireMoment mutates state (consumed.push), so
// every load must own a fresh consumed array.
function freshState(): ReferralNudgeState {
  return {
    noteCount: 0,
    dictationCount: 0,
    consumed: [],
    shownCount: 0,
    lastShownAt: null,
    clickedThrough: false,
  };
}

function loadState(): ReferralNudgeState {
  try {
    const raw = window.localStorage.getItem(REFERRAL_NUDGE_STORAGE_KEY);
    if (!raw) return freshState();
    const parsed = JSON.parse(raw) as Partial<ReferralNudgeState>;
    return {
      noteCount: typeof parsed.noteCount === "number" ? parsed.noteCount : 0,
      dictationCount: typeof parsed.dictationCount === "number" ? parsed.dictationCount : 0,
      consumed: Array.isArray(parsed.consumed) ? (parsed.consumed as ReferralNudgeMoment[]) : [],
      shownCount: typeof parsed.shownCount === "number" ? parsed.shownCount : 0,
      lastShownAt: typeof parsed.lastShownAt === "number" ? parsed.lastShownAt : null,
      clickedThrough: parsed.clickedThrough === true,
    };
  } catch {
    return freshState();
  }
}

/** Returns false when storage is full or unavailable. Callers fail CLOSED on
 *  that: a moment we cannot record must never show, or an install with broken
 *  storage would re-nudge on every trigger, ignoring the caps entirely. */
function saveState(state: ReferralNudgeState): boolean {
  try {
    window.localStorage.setItem(REFERRAL_NUDGE_STORAGE_KEY, JSON.stringify(state));
    return true;
  } catch {
    return false;
  }
}

function capsAllow(state: ReferralNudgeState, now: number): boolean {
  if (state.clickedThrough) return false;
  if (state.shownCount >= REFERRAL_NUDGE_LIFETIME_MAX) return false;
  if (state.lastShownAt !== null && now - state.lastShownAt < REFERRAL_NUDGE_MIN_INTERVAL_MS) {
    return false;
  }
  return true;
}

/** Consumes the moment (once per install, ever) and, if the caps permit,
 *  announces it. Returns the moment when it was announced, else null. */
function fireMoment(
  state: ReferralNudgeState,
  moment: ReferralNudgeMoment,
  now: number,
): ReferralNudgeMoment | null {
  if (state.consumed.includes(moment)) return null;
  state.consumed.push(moment);
  const allowed = capsAllow(state, now);
  const persisted = saveState(state);
  if (!allowed || !persisted) return null;
  window.dispatchEvent(new CustomEvent(REFERRAL_NUDGE_EVENT, { detail: { moment } }));
  return moment;
}

/** T1: a meeting note finished generating. Fires on the 5th. */
export function recordMeetingNoteGenerated(now = Date.now()): ReferralNudgeMoment | null {
  const state = loadState();
  if (state.noteCount >= REFERRAL_NUDGE_NOTE_THRESHOLD) return null;
  state.noteCount += 1;
  if (state.noteCount < REFERRAL_NUDGE_NOTE_THRESHOLD) {
    saveState(state);
    return null;
  }
  return fireMoment(state, "meetings", now);
}

/** T2: an agent task completed successfully. Fires on the first. */
export function recordAgentTaskCompleted(now = Date.now()): ReferralNudgeMoment | null {
  return fireMoment(loadState(), "agent", now);
}

/** T3: a dictation landed. Fires on the 25th. */
export function recordDictationFinished(now = Date.now()): ReferralNudgeMoment | null {
  const state = loadState();
  if (state.dictationCount >= REFERRAL_NUDGE_DICTATION_THRESHOLD) return null;
  state.dictationCount += 1;
  if (state.dictationCount < REFERRAL_NUDGE_DICTATION_THRESHOLD) {
    saveState(state);
    return null;
  }
  return fireMoment(state, "dictation", now);
}

/** T4: the user sent positive feedback (report category "feedback"). */
export function recordPositiveFeedbackSent(now = Date.now()): ReferralNudgeMoment | null {
  return fireMoment(loadState(), "feedback", now);
}

/** The card actually appeared: starts the 14-day window, counts the show. */
export function markReferralNudgeShown(now = Date.now()) {
  const state = loadState();
  state.shownCount += 1;
  state.lastShownAt = now;
  saveState(state);
}

/** The user clicked through to the referral dialog: no further nudges, ever. */
export function markReferralNudgeClickedThrough() {
  const state = loadState();
  state.clickedThrough = true;
  saveState(state);
}
