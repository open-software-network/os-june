import { useEffect } from "react";
import { bootstrapApp, createNote, getNote } from "../lib/tauri";
import { messageFromError } from "../lib/errors";
import { getCurrentDataPartitionName } from "../lib/data-partition";
import { withFakeRecovery } from "./app-helpers";
import type { UseAppBootstrapDependencies } from "./use-app-bootstrap-types";

export function useAppBootstrap(dependencies: UseAppBootstrapDependencies) {
  const {
    appBlocked,
    calendarContextNoteProfilesRef,
    calendarContextNoteUpdatesRef,
    dispatch,
    pendingCalendarContextAdoptionsRef,
    recordingStatusRef,
    setActiveView,
    setBootstrapped,
    setError,
    setRecordingNote,
  } = dependencies;

  useEffect(() => {
    if (appBlocked) return;
    bootstrapApp()
      .then(async (payload) => {
        const seeded = withFakeRecovery(payload);
        dispatch({ type: "bootstrapLoaded", payload: seeded.payload });
        const activeRecording = seeded.payload.activeRecording;
        const activeRecordingNoteId = activeRecording?.noteId;
        if (activeRecording) {
          recordingStatusRef.current = activeRecording;
          dispatch({ type: "recordingStatusChanged", status: activeRecording });
          if (activeRecordingNoteId) {
            calendarContextNoteProfilesRef.current.set(
              activeRecordingNoteId,
              getCurrentDataPartitionName(),
            );
            pendingCalendarContextAdoptionsRef.current.add(activeRecordingNoteId);
            setRecordingNote(activeRecordingNoteId);
          }
        }
        if (seeded.fakeNote) {
          dispatch({ type: "noteLoaded", note: seeded.fakeNote });
          // The fake-recovery dev flow inspects the notes list, so it skips
          // the agent landing.
          setActiveView("notes");
          setBootstrapped(true);
          return;
        }
        // The app lands on the agent view, but a note is still selected up
        // front. After a webview reload, a live native capture takes priority
        // so its recorder controls and note association are restored.
        if (seeded.payload.notes.length === 0 && !activeRecordingNoteId) {
          const note = await createNote(undefined);
          dispatch({ type: "noteLoaded", note });
          setBootstrapped(true);
          return;
        }
        const firstNoteId = activeRecordingNoteId ?? seeded.payload.notes[0]?.id;
        if (firstNoteId) {
          const note = await getNote(firstNoteId);
          const calendarUpdate = calendarContextNoteUpdatesRef.current.get(firstNoteId);
          calendarContextNoteUpdatesRef.current.delete(firstNoteId);
          pendingCalendarContextAdoptionsRef.current.delete(firstNoteId);
          dispatch({ type: "noteLoaded", note: calendarUpdate ?? note });
        }
        setBootstrapped(true);
      })
      .catch((err: unknown) => setError(messageFromError(err)));
  }, [appBlocked]);
}
