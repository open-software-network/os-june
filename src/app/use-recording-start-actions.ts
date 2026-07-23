import { useCallback, useRef } from "react";
import {
  checkRecordingSourceReadiness,
  createNote,
  deleteNote,
  getNote,
  listNotes,
  startMeetingRecording,
  startRecording,
} from "../lib/tauri";
import { playRecordingSound } from "../lib/recording-sounds";
import { mergeSourceReadiness } from "../lib/source-readiness";
import { errorCode, messageFromError } from "../lib/errors";
import { getActiveAgentProfileName } from "../lib/agent-profile";
import type { RecordingSourceMode } from "../lib/tauri";
import {
  recordingToStatus,
  revealMainWindowForMeetingStartError,
  startingRecordingStatus,
} from "./app-helpers";
import {
  MEETING_START_REQUEST_EXPIRED_MESSAGE,
  RECORDING_FUNDING_DISABLED_REASON,
} from "./app-shell";
import type { UseRecordingStartActionsDependencies } from "./use-recording-start-actions-types";

export function useRecordingStartActions(dependencies: UseRecordingStartActionsDependencies) {
  const {
    activeViewRef,
    appBlocked,
    bootstrapped,
    calendarContextNoteProfilesRef,
    calendarContextNoteUpdatesRef,
    dispatch,
    fundingRequired,
    handleEmptyNotesAfterDelete,
    pendingCalendarContextAdoptionsRef,
    recordingNoteIdRef,
    recordingStartInFlightRef,
    recordingStatusRef,
    selectedNoteId,
    selectedNoteIdRef,
    setActiveView,
    setCheckingSourceReadiness,
    setError,
    setFolderReturnTarget,
    setOriginAllNotes,
    setOriginFolderId,
    setRecordingNote,
    setSourceReadiness,
    sourceMode,
  } = dependencies;

  const handleStartRecordingForNote = useCallback(
    async (
      noteId: string,
      options: { startAlreadyClaimed?: boolean; sourceMode?: RecordingSourceMode } = {},
    ): Promise<boolean> => {
      if (fundingRequired) {
        setError(RECORDING_FUNDING_DISABLED_REASON);
        return false;
      }
      const startAlreadyClaimed = options.startAlreadyClaimed ?? false;
      const requestedSourceMode = options.sourceMode ?? sourceMode;
      if (
        recordingStatusRef.current ||
        (!startAlreadyClaimed && recordingStartInFlightRef.current)
      ) {
        if (startAlreadyClaimed) {
          recordingStartInFlightRef.current = false;
        }
        return false;
      }
      if (!startAlreadyClaimed) {
        recordingStartInFlightRef.current = true;
      }
      const recordingProfile = getActiveAgentProfileName();
      setRecordingNote(noteId);
      const startingStatus = startingRecordingStatus(noteId, requestedSourceMode);
      recordingStatusRef.current = startingStatus;
      dispatch({
        type: "recordingStatusChanged",
        status: startingStatus,
      });
      try {
        setCheckingSourceReadiness(true);
        const readiness = await checkRecordingSourceReadiness(requestedSourceMode);
        setSourceReadiness((previous) => mergeSourceReadiness(previous, readiness));

        const micSource = readiness.sources.find((source) => source.source === "microphone");
        if (!micSource?.ready) {
          setRecordingNote(undefined);
          recordingStatusRef.current = undefined;
          dispatch({ type: "recordingStatusCleared" });
          setError(micSource?.message ?? "Microphone is not ready.");
          return false;
        }

        // System audio is optional. If the fresh probe shows it isn't
        // available, fall back to mic-only for this take — the derived
        // sourceMode will follow automatically next render via
        // setSourceReadiness above.
        const systemSource = readiness.sources.find((source) => source.source === "system");
        const effectiveMode: RecordingSourceMode =
          requestedSourceMode === "microphonePlusSystem" && !systemSource?.ready
            ? "microphoneOnly"
            : requestedSourceMode;

        calendarContextNoteProfilesRef.current.set(noteId, recordingProfile);
        const recording = await startRecording(noteId, effectiveMode);
        setRecordingNote(noteId);
        const status = recordingToStatus(recording);
        recordingStatusRef.current = status;
        dispatch({
          type: "recordingStatusChanged",
          status,
        });
        playRecordingSound("start");
        return true;
      } catch (err) {
        calendarContextNoteProfilesRef.current.delete(noteId);
        // The ref was set optimistically above; a failed start must not leave
        // the meeting HUD's reopen path pointing at a note with no recording.
        setRecordingNote(undefined);
        recordingStatusRef.current = undefined;
        dispatch({ type: "recordingStatusCleared" });
        // A TCC denial resolved inside start_recording (the first-run prompt
        // declined, or the grant revoked after the readiness probe): re-probe
        // so the persistent mic-blocked notice appears with its Enable action,
        // not just this transient error (JUN-319).
        if (errorCode(err) === "microphone_permission_missing") {
          void checkRecordingSourceReadiness(requestedSourceMode)
            .then((readiness) =>
              setSourceReadiness((previous) => mergeSourceReadiness(previous, readiness)),
            )
            .catch(() => undefined);
        }
        setError(messageFromError(err));
        return false;
      } finally {
        recordingStartInFlightRef.current = false;
        setCheckingSourceReadiness(false);
      }
    },
    [fundingRequired, setRecordingNote, sourceMode],
  );

  const handleStartRecording = useCallback(async () => {
    if (!selectedNoteId) return;
    await handleStartRecordingForNote(selectedNoteId);
  }, [handleStartRecordingForNote, selectedNoteId]);

  const meetingStartReadyRef = useRef(false);
  const meetingStartListenerRegisteredRef = useRef(false);
  const drainPendingMeetingStartRef = useRef<() => void>(() => {});
  meetingStartReadyRef.current = !appBlocked && bootstrapped;

  const handleStartMeetingDetectedRecording = useCallback(
    async (requestId: string, noteId: string) => {
      if (fundingRequired) {
        revealMainWindowForMeetingStartError();
        setError(RECORDING_FUNDING_DISABLED_REASON);
        return true;
      }
      const competingRecording = recordingStatusRef.current;
      if (recordingStartInFlightRef.current || competingRecording?.state === "starting") {
        return false;
      }
      if (competingRecording) return true;
      calendarContextNoteProfilesRef.current.set(noteId, getActiveAgentProfileName());
      pendingCalendarContextAdoptionsRef.current.add(noteId);
      recordingStartInFlightRef.current = true;
      setCheckingSourceReadiness(true);
      try {
        const outcome = await startMeetingRecording(requestId, sourceMode);
        if (!meetingStartReadyRef.current || !meetingStartListenerRegisteredRef.current) {
          return false;
        }
        if (outcome.status === "failed") {
          calendarContextNoteProfilesRef.current.delete(noteId);
          pendingCalendarContextAdoptionsRef.current.delete(noteId);
          calendarContextNoteUpdatesRef.current.delete(noteId);
          revealMainWindowForMeetingStartError();
          if (outcome.error.code === "meeting_start_expired") {
            setError(MEETING_START_REQUEST_EXPIRED_MESSAGE);
          } else {
            setError(messageFromError(outcome.error));
          }
          if (outcome.error.code === "microphone_permission_missing") {
            void checkRecordingSourceReadiness(sourceMode)
              .then((readiness) =>
                setSourceReadiness((previous) => mergeSourceReadiness(previous, readiness)),
              )
              .catch(() => undefined);
          }
          // A reload can briefly bootstrap the deterministic draft while the
          // native start is still running. Refresh after a terminal failure so
          // native cleanup cannot leave that now-deleted draft visible.
          try {
            const previousNoteId = selectedNoteIdRef.current;
            const response = await listNotes();
            dispatch({ type: "notesLoaded", notes: response.items });
            const restoreNoteId = response.items.some((note) => note.id === previousNoteId)
              ? previousNoteId
              : response.items[0]?.id;
            if (restoreNoteId) {
              const restored = await getNote(restoreNoteId);
              dispatch({ type: "noteLoaded", note: restored });
            } else {
              const currentView = activeViewRef.current;
              if (
                currentView === "meetings" ||
                currentView === "notes" ||
                currentView === "all-notes"
              ) {
                setActiveView("notes");
              }
              setOriginFolderId(undefined);
              setOriginAllNotes(false);
              setFolderReturnTarget(undefined);
            }
          } catch {
            // The terminal error is already visible and native owns cleanup;
            // a later notes refresh will reconcile this best-effort view.
          }
          return true;
        }

        const { note, recording } = outcome;
        const calendarUpdate = calendarContextNoteUpdatesRef.current.get(note.id);
        calendarContextNoteUpdatesRef.current.delete(note.id);
        pendingCalendarContextAdoptionsRef.current.delete(note.id);
        dispatch({ type: "noteLoaded", note: calendarUpdate ?? note });
        setOriginFolderId(undefined);
        setOriginAllNotes(false);
        setActiveView("meetings");
        setRecordingNote(note.id);
        const status = recordingToStatus(recording);
        recordingStatusRef.current = status;
        dispatch({
          type: "recordingStatusChanged",
          status,
        });
        playRecordingSound("start");
        return true;
      } catch {
        return false;
      } finally {
        recordingStartInFlightRef.current = false;
        setCheckingSourceReadiness(false);
      }
    },
    [fundingRequired, setRecordingNote, sourceMode],
  );

  const handleStartAgentRecording = useCallback(
    async (requestedSourceMode: RecordingSourceMode) => {
      if (fundingRequired) {
        throw new Error(RECORDING_FUNDING_DISABLED_REASON);
      }
      if (recordingStartInFlightRef.current || recordingStatusRef.current) {
        throw new Error(
          `A recording is already running for note ${recordingNoteIdRef.current ?? "unknown"}.`,
        );
      }
      recordingStartInFlightRef.current = true;
      const previousNoteId = selectedNoteId;
      let handedStartClaimToRecorder = false;
      let createdNoteId: string | undefined;
      try {
        const note = await createNote(undefined);
        createdNoteId = note.id;
        dispatch({ type: "noteLoaded", note });
        setOriginFolderId(undefined);
        setOriginAllNotes(false);
        setActiveView("meetings");
        handedStartClaimToRecorder = true;
        const started = await handleStartRecordingForNote(note.id, {
          startAlreadyClaimed: true,
          sourceMode: requestedSourceMode,
        });
        if (started) return note;

        try {
          await deleteNote(note.id);
        } catch (deleteErr) {
          console.warn("Failed to delete note after recording start failed", deleteErr);
        }
        const response = await listNotes();
        dispatch({ type: "notesLoaded", notes: response.items });
        const restoreNoteId =
          previousNoteId && previousNoteId !== note.id ? previousNoteId : response.items[0]?.id;
        if (restoreNoteId) {
          const restored = await getNote(restoreNoteId);
          dispatch({ type: "noteLoaded", note: restored });
        } else {
          handleEmptyNotesAfterDelete();
        }
        throw new Error("Recording did not start.");
      } catch (err) {
        if (createdNoteId && !handedStartClaimToRecorder) {
          try {
            await deleteNote(createdNoteId);
          } catch (deleteErr) {
            console.warn("Failed to delete note after recording start failed", deleteErr);
          }
        }
        throw err;
      } finally {
        if (!handedStartClaimToRecorder) {
          recordingStartInFlightRef.current = false;
        }
      }
    },
    [fundingRequired, handleStartRecordingForNote, selectedNoteId],
  );

  // Click the floating global recorder pill to jump back to the note the
  // recording belongs to (it lives wherever you started it, which may not be
  // the note you're currently looking at).
  const handleOpenRecordingNote = useCallback(async () => {
    const noteId = recordingNoteIdRef.current;
    if (!noteId) return;
    try {
      const note = await getNote(noteId);
      dispatch({ type: "noteLoaded", note });
      setOriginFolderId(undefined);
      setOriginAllNotes(false);
      setFolderReturnTarget(undefined);
      setActiveView("meetings");
    } catch (err) {
      setError(messageFromError(err));
    }
  }, []);

  return {
    handleStartRecording,
    meetingStartReadyRef,
    meetingStartListenerRegisteredRef,
    drainPendingMeetingStartRef,
    handleStartMeetingDetectedRecording,
    handleStartAgentRecording,
    handleOpenRecordingNote,
  };
}
