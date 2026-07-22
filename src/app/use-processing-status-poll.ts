import { useEffect } from "react";
import { getNote } from "../lib/tauri";
import { messageFromError } from "../lib/errors";
import { PROCESSING_DEMO_NOTE_ID, shouldPollProcessingStatus } from "./processing-polling";
import type { UseProcessingStatusPollDependencies } from "./use-processing-status-poll-types";

export function useProcessingStatusPoll(dependencies: UseProcessingStatusPollDependencies) {
  const { dispatch, selectedNote, setError } = dependencies;

  useEffect(() => {
    if (!selectedNote || !shouldPollProcessingStatus(selectedNote.processingStatus)) {
      return;
    }
    // The dev __processingDemo note lives only in the reducer; there is no
    // backend row to poll, and getNote would clobber its synthetic stage with
    // a "note not found". Stripped from production via import.meta.env.DEV.
    if (import.meta.env.DEV && selectedNote.id === PROCESSING_DEMO_NOTE_ID) {
      return;
    }
    const noteId = selectedNote.id;
    // Drops in-flight responses once this effect is torn down (note switched,
    // status moved on, note deleted) so a late resolution can't apply a stale
    // snapshot — or surface a spurious "note not found" error after a delete.
    let cancelled = false;
    const interval = window.setInterval(() => {
      getNote(noteId)
        .then((note) => {
          if (cancelled) return;
          dispatch({ type: "noteUpdated", note });
        })
        .catch((err: unknown) => {
          if (!cancelled) setError(messageFromError(err));
        });
    }, 1000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [selectedNote?.id, selectedNote?.processingStatus]);
}
