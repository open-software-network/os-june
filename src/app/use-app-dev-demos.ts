import { useEffect, useRef, useState } from "react";
import type { GlobalRecorderDemoApi } from "../lib/global-recorder-demo";
import type { RecordNoticesDemoApi } from "../lib/record-notices-demo";
import type { UpdateCardDemoApi } from "../lib/update-card-demo";
import { type ReferralNudgeMoment } from "../components/referral/ReferralNudge";
import type { RecordingStatusDto } from "../lib/tauri";
import { RECORD_NOTICES_DEMO_SESSION_ID } from "./processing-polling";
import type { UseAppDevDemosDependencies } from "./use-app-dev-demos-types";

export function useAppDevDemos(dependencies: UseAppDevDemosDependencies) {
  const {
    dispatch,
    getSelectedNoteId,
    recordingStatusRef,
    setActiveView,
    setCheckingUpdate,
    setLiveTranscriptEvents,
    setPreparingUpdate,
    setRecordingNote,
    setRelaunchingUpdate,
    setReadyUpdate,
    setUpdateProgress,
    setUpdateStatus,
  } = dependencies;

  const [demoRecorderStatus, setDemoRecorderStatus] = useState<RecordingStatusDto | null>(null);
  const demoRecorderRef = useRef<GlobalRecorderDemoApi | null>(null);
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    let cancelled = false;
    void import("../lib/global-recorder-demo").then(({ registerGlobalRecorderDemo }) => {
      if (cancelled) return;
      demoRecorderRef.current = registerGlobalRecorderDemo({
        setStatus: setDemoRecorderStatus,
      });
    });
    return () => {
      cancelled = true;
      demoRecorderRef.current?.dispose();
      demoRecorderRef.current = null;
    };
  }, []);
  // Dev-only console driver (window.__processingDemo) that seeds a synthetic
  // meeting note parked in a transcription-processing stage so the
  // ProcessingProgressIndicator can be inspected without a real recording.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    let cancelled = false;
    let dispose: (() => void) | undefined;
    void import("../lib/processing-progress-demo").then(({ registerProcessingProgressDemo }) => {
      if (cancelled) return;
      ({ dispose } = registerProcessingProgressDemo({
        seedNote: (note) => {
          dispatch({ type: "noteLoaded", note });
          setActiveView("meetings");
        },
      }));
    });
    return () => {
      cancelled = true;
      dispose?.();
    };
  }, []);
  // Dev-only console driver (window.__recordNoticesDemo) that parks the
  // recorder-area notices (consent reminder, source warning, mic-blocked) on the
  // selected note without a real recording, so their styling can be inspected.
  // The synthetic status runs under RECORD_NOTICES_DEMO_SESSION_ID, which the
  // status poll and the pause/resume/finish handlers skip so no backend call
  // fires; consent pinning bypasses the recorder bar's reveal/auto-hide timers.
  const [recordNoticesConsentPinned, setRecordNoticesConsentPinned] = useState(false);
  const [recordNoticesMicOverride, setRecordNoticesMicOverride] = useState<boolean | null>(null);
  const recordNoticesDemoRef = useRef<RecordNoticesDemoApi | null>(null);
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    let cancelled = false;
    void import("../lib/record-notices-demo").then(({ registerRecordNoticesDemo }) => {
      if (cancelled) return;
      recordNoticesDemoRef.current = registerRecordNoticesDemo({
        seedNote: (note) => {
          dispatch({ type: "noteLoaded", note });
          setActiveView("meetings");
        },
        setStatus: (status) => {
          // Defense in depth: never let the demo's synthetic status stomp a real
          // recording, even if the driver's hasRealRecording check somehow raced.
          const active = recordingStatusRef.current;
          if (active && active.sessionId !== RECORD_NOTICES_DEMO_SESSION_ID) return;
          if (status) {
            dispatch({ type: "recordingStatusChanged", status });
            setRecordingNote(status.noteId);
          } else {
            dispatch({ type: "recordingStatusCleared" });
            setRecordingNote(undefined);
            setLiveTranscriptEvents([]);
          }
        },
        setConsentPinned: setRecordNoticesConsentPinned,
        setMicOverride: setRecordNoticesMicOverride,
        getSelectedNoteId,
        hasRealRecording: () => {
          const active = recordingStatusRef.current;
          return !!active && active.sessionId !== RECORD_NOTICES_DEMO_SESSION_ID;
        },
      });
    });
    return () => {
      cancelled = true;
      recordNoticesDemoRef.current?.dispose();
      recordNoticesDemoRef.current = null;
    };
  }, [setRecordingNote]);
  // The referral delight nudge (bottom-left card). Real shows come from the
  // trigger layer (useReferralNudgeTriggers below); the dev console driver
  // (window.__referralNudge) parks the card without touching the persisted
  // caps, which is why the source is tracked — only trigger-shown cards may
  // record a click-through.
  const [referralNudgeMoment, setReferralNudgeMoment] = useState<ReferralNudgeMoment | null>(null);
  const referralNudgeSourceRef = useRef<"trigger" | "demo">("trigger");
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    let cancelled = false;
    let dispose: (() => void) | undefined;
    void import("../lib/referral-nudge-demo").then(({ registerReferralNudgeDemo }) => {
      if (cancelled) return;
      ({ dispose } = registerReferralNudgeDemo({
        setMoment: (moment) => {
          referralNudgeSourceRef.current = "demo";
          setReferralNudgeMoment(moment);
        },
      }));
    });
    return () => {
      cancelled = true;
      dispose?.();
    };
  }, []);
  // Dev console driver for the sidebar update cards (window.__updateCard).
  // Pushes synthetic values into the real update state so each card's styling
  // can be parked and inspected without a live update.
  const updateCardDemoRef = useRef<UpdateCardDemoApi | null>(null);
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    let cancelled = false;
    void import("../lib/update-card-demo").then(({ registerUpdateCardDemo }) => {
      if (cancelled) return;
      updateCardDemoRef.current = registerUpdateCardDemo({
        setReadyUpdate,
        setStatus: setUpdateStatus,
        setRelaunching: setRelaunchingUpdate,
        setPreparing: setPreparingUpdate,
        setChecking: setCheckingUpdate,
        setProgress: setUpdateProgress,
      });
    });
    return () => {
      cancelled = true;
      updateCardDemoRef.current?.dispose();
      updateCardDemoRef.current = null;
    };
  }, [setUpdateStatus]);
  // Dev console driver (window.__toastDemo) that fires each toast variant so
  // the toast styling can be inspected without walking a real flow.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    let cancelled = false;
    let dispose: (() => void) | undefined;
    void import("../lib/toast-demo").then(({ registerToastDemo }) => {
      if (cancelled) return;
      ({ dispose } = registerToastDemo());
    });
    return () => {
      cancelled = true;
      dispose?.();
    };
  }, []);
  // Dev console driver (window.__juneSounds) for hearing the full recording
  // and agent sound family without walking each production lifecycle.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    let cancelled = false;
    let dispose: (() => void) | undefined;
    void import("../lib/june-sounds-demo").then(({ registerJuneSoundsDemo }) => {
      if (cancelled) return;
      ({ dispose } = registerJuneSoundsDemo());
    });
    return () => {
      cancelled = true;
      dispose?.();
    };
  }, []);
  // Sessions with a finishRecording call in flight; guards stop double-clicks.
  const finishingSessionsRef = useRef<Set<string>>(new Set());

  return {
    demoRecorderStatus,
    recordNoticesConsentPinned,
    recordNoticesMicOverride,
    recordNoticesDemoRef,
    referralNudgeMoment,
    setReferralNudgeMoment,
    referralNudgeSourceRef,
    finishingSessionsRef,
  };
}
