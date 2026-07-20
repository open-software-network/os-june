import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  REFERRAL_NUDGE_DICTATION_THRESHOLD,
  REFERRAL_NUDGE_EVENT,
  REFERRAL_NUDGE_MIN_INTERVAL_MS,
  REFERRAL_NUDGE_NOTE_THRESHOLD,
  REFERRAL_NUDGE_STORAGE_KEY,
  markReferralNudgeClickedThrough,
  markReferralNudgeShown,
  recordAgentTaskCompleted,
  recordDictationFinished,
  recordMeetingNoteGenerated,
  recordPositiveFeedbackSent,
  resetReferralNudgeSessionLatchForTests,
} from "../lib/referral-nudge";

const DAY_MS = 24 * 60 * 60 * 1000;
const T0 = 1_700_000_000_000;

function storageSpyTarget(): Storage {
  return window.localStorage instanceof Storage ? Storage.prototype : window.localStorage;
}

let announced: string[] = [];
const onNudge = (event: Event) => {
  announced.push((event as CustomEvent<{ moment: string }>).detail.moment);
};

beforeEach(() => {
  window.localStorage.clear();
  resetReferralNudgeSessionLatchForTests();
  announced = [];
  window.addEventListener(REFERRAL_NUDGE_EVENT, onNudge);
});

afterEach(() => {
  window.removeEventListener(REFERRAL_NUDGE_EVENT, onNudge);
  vi.restoreAllMocks();
});

describe("referral nudge thresholds", () => {
  it("fires the meetings moment on exactly the 5th generated note", () => {
    for (let i = 1; i < REFERRAL_NUDGE_NOTE_THRESHOLD; i += 1) {
      expect(recordMeetingNoteGenerated(T0)).toBeNull();
    }
    expect(announced).toEqual([]);
    expect(recordMeetingNoteGenerated(T0)).toBe("meetings");
    expect(announced).toEqual(["meetings"]);
    // Further notes never re-fire.
    expect(recordMeetingNoteGenerated(T0)).toBeNull();
    expect(announced).toEqual(["meetings"]);
  });

  it("fires the agent moment on the first successful completion only", () => {
    expect(recordAgentTaskCompleted(T0)).toBe("agent");
    expect(recordAgentTaskCompleted(T0)).toBeNull();
    expect(announced).toEqual(["agent"]);
  });

  it("fires the dictation moment on exactly the 25th dictation", () => {
    for (let i = 1; i < REFERRAL_NUDGE_DICTATION_THRESHOLD; i += 1) {
      expect(recordDictationFinished(T0)).toBeNull();
    }
    expect(recordDictationFinished(T0)).toBe("dictation");
    expect(recordDictationFinished(T0)).toBeNull();
    expect(announced).toEqual(["dictation"]);
  });

  it("fires the feedback moment once", () => {
    expect(recordPositiveFeedbackSent(T0)).toBe("feedback");
    expect(recordPositiveFeedbackSent(T0)).toBeNull();
  });

  it("persists counter progress across module reloads (storage-backed)", () => {
    recordMeetingNoteGenerated(T0);
    const raw = window.localStorage.getItem(REFERRAL_NUDGE_STORAGE_KEY);
    expect(raw).toBeTruthy();
    expect(JSON.parse(raw as string).noteCount).toBe(1);
  });
});

describe("referral nudge frequency caps", () => {
  it("suppresses (and consumes) a moment within 14 days of the last show", () => {
    expect(recordAgentTaskCompleted(T0)).toBe("agent");
    markReferralNudgeShown(T0);
    expect(recordPositiveFeedbackSent(T0 + DAY_MS)).toBeNull();
    // The suppressed moment was consumed, not queued: it never fires again,
    // even outside the window.
    expect(recordPositiveFeedbackSent(T0 + REFERRAL_NUDGE_MIN_INTERVAL_MS + DAY_MS)).toBeNull();
    expect(announced).toEqual(["agent"]);
  });

  it("allows a second moment after the 14-day window", () => {
    expect(recordAgentTaskCompleted(T0)).toBe("agent");
    markReferralNudgeShown(T0);
    const later = T0 + REFERRAL_NUDGE_MIN_INTERVAL_MS + DAY_MS;
    expect(recordPositiveFeedbackSent(later)).toBe("feedback");
  });

  it("caps lifetime shows at two", () => {
    expect(recordAgentTaskCompleted(T0)).toBe("agent");
    markReferralNudgeShown(T0);
    const second = T0 + REFERRAL_NUDGE_MIN_INTERVAL_MS + DAY_MS;
    expect(recordPositiveFeedbackSent(second)).toBe("feedback");
    markReferralNudgeShown(second);
    const third = second + REFERRAL_NUDGE_MIN_INTERVAL_MS + DAY_MS;
    for (let i = 0; i < REFERRAL_NUDGE_NOTE_THRESHOLD; i += 1) {
      recordMeetingNoteGenerated(third);
    }
    expect(announced).toEqual(["agent", "feedback"]);
  });

  it("never fires again after a click-through", () => {
    markReferralNudgeClickedThrough();
    expect(recordAgentTaskCompleted(T0)).toBeNull();
    for (let i = 0; i < REFERRAL_NUDGE_NOTE_THRESHOLD; i += 1) {
      recordMeetingNoteGenerated(T0);
    }
    expect(announced).toEqual([]);
  });

  it("survives corrupt storage by starting fresh", () => {
    window.localStorage.setItem(REFERRAL_NUDGE_STORAGE_KEY, "{not json");
    expect(recordAgentTaskCompleted(T0)).toBe("agent");
  });

  it("fails closed when storage writes fail (never shows what it cannot record)", () => {
    const setItem = vi.spyOn(storageSpyTarget(), "setItem").mockImplementation(() => {
      throw new DOMException("QuotaExceededError");
    });
    try {
      expect(recordAgentTaskCompleted(T0)).toBeNull();
      expect(announced).toEqual([]);
    } finally {
      setItem.mockRestore();
    }
    // A failed write also latches the session closed; clear it to verify the
    // moment itself was never persisted as consumed.
    resetReferralNudgeSessionLatchForTests();
    expect(recordAgentTaskCompleted(T0)).toBe("agent");
    expect(announced).toEqual(["agent"]);
  });

  it("latches the session closed when a post-show write fails", () => {
    expect(recordAgentTaskCompleted(T0)).toBe("agent");
    const setItem = vi.spyOn(storageSpyTarget(), "setItem").mockImplementation(() => {
      throw new DOMException("QuotaExceededError");
    });
    try {
      markReferralNudgeShown(T0);
    } finally {
      setItem.mockRestore();
    }
    // The show was never persisted (no lastShownAt, no shownCount), but the
    // latch still suppresses every later moment this session.
    const later = T0 + REFERRAL_NUDGE_MIN_INTERVAL_MS + DAY_MS;
    expect(recordPositiveFeedbackSent(later)).toBeNull();
    expect(announced).toEqual(["agent"]);
  });

  it("latches the session closed when the click-through opt-out cannot be saved", () => {
    const setItem = vi.spyOn(storageSpyTarget(), "setItem").mockImplementation(() => {
      throw new DOMException("QuotaExceededError");
    });
    try {
      markReferralNudgeClickedThrough();
    } finally {
      setItem.mockRestore();
    }
    expect(recordAgentTaskCompleted(T0)).toBeNull();
    expect(announced).toEqual([]);
  });
});
