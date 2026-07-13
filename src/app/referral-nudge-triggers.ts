import { useEffect, useRef } from "react";
import { AGENT_SESSION_STATUS_EVENT, type AgentSessionStatusDetail } from "../lib/agent-events";
import {
  REFERRAL_NUDGE_EVENT,
  type ReferralNudgeMoment,
  markReferralNudgeShown,
  recordAgentTaskCompleted,
  recordMeetingNoteGenerated,
} from "../lib/referral-nudge";
import type { NoteListItemDto, ProcessingStatus } from "../lib/tauri";
import { osAccountsReferralSummary } from "../lib/tauri";

/**
 * Wires the referral delight nudge's trigger moments to the signals the shell
 * already carries (see src/lib/referral-nudge.ts for the caps):
 *
 *   T1  a note's processingStatus transitions into "ready" (5th fires)
 *   T2  an agent session reports "completed" (first fires)
 *   T3  records from App's existing dictation-event listener, not here (a
 *       second "dictation-event" subscription would double-handle the shared
 *       channel)
 *   T4  lives with the report flow (see ReportDialog / the chip-flow
 *       delivery in AgentWorkspace)
 *
 * Signals always record — counting is harmless anywhere — but a nudge only
 * shows when `enabled` (signed in, onboarded, not local dev) and this
 * deployment actually offers referrals (the summary probe; a deployment
 * without /referrals/me quietly consumes the moment instead of showing a
 * card whose dialog would dead-end).
 */
export function useReferralNudgeTriggers({
  notes,
  enabled,
  onShow,
}: {
  notes: NoteListItemDto[];
  enabled: boolean;
  onShow: (moment: ReferralNudgeMoment) => void;
}) {
  // T1: notes crossing into "ready". The first snapshot is a baseline — notes
  // that load already-ready (app start, bootstrap) are history, not moments;
  // only a note observed in a pre-ready state that then flips counts.
  const noteStatusesRef = useRef<Map<string, ProcessingStatus> | null>(null);
  useEffect(() => {
    const previous = noteStatusesRef.current;
    noteStatusesRef.current = new Map(notes.map((note) => [note.id, note.processingStatus]));
    if (!previous) return;
    for (const note of notes) {
      const before = previous.get(note.id);
      if (before !== undefined && before !== "ready" && note.processingStatus === "ready") {
        recordMeetingNoteGenerated();
      }
    }
  }, [notes]);

  // T2: session status events only fire for live transitions (the gateway
  // streams them), so "completed" here is a task finishing now, not history.
  // Failed and cancelled sessions never trigger.
  useEffect(() => {
    const onStatus = (event: Event) => {
      const detail = (event as CustomEvent<AgentSessionStatusDetail>).detail;
      if (detail?.status === "completed") recordAgentTaskCompleted();
    };
    window.addEventListener(AGENT_SESSION_STATUS_EVENT, onStatus);
    return () => window.removeEventListener(AGENT_SESSION_STATUS_EVENT, onStatus);
  }, []);

  // The show path. Refs so the listener never closes over stale props.
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const onShowRef = useRef(onShow);
  onShowRef.current = onShow;
  const probingRef = useRef(false);
  useEffect(() => {
    const onNudge = (event: Event) => {
      const moment = (event as CustomEvent<{ moment: ReferralNudgeMoment }>).detail?.moment;
      if (!moment || probingRef.current || !enabledRef.current) return;
      probingRef.current = true;
      osAccountsReferralSummary()
        .then(() => {
          // The gates can flip while the probe is in flight (a recording
          // starts, the user signs out) — re-check before showing.
          if (!enabledRef.current) return;
          markReferralNudgeShown();
          onShowRef.current(moment);
        })
        .catch(() => {
          // Referrals unavailable here (or offline): skip quietly. The
          // moment stays consumed — no queueing, per the frequency rules.
        })
        .finally(() => {
          probingRef.current = false;
        });
    };
    window.addEventListener(REFERRAL_NUDGE_EVENT, onNudge);
    return () => window.removeEventListener(REFERRAL_NUDGE_EVENT, onNudge);
  }, []);
}
