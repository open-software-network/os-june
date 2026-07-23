import { listen } from "@tauri-apps/api/event";
import { useEffect } from "react";
import { messageFromError } from "../lib/errors";
import {
  getNote,
  NOTE_PROCESSING_PROGRESS_EVENT,
  type NoteProcessingProgressDto,
} from "../lib/tauri";
import type { UseNoteProcessingEventsDependencies } from "./use-note-processing-events-types";

function progressIdentity(progress: NoteProcessingProgressDto) {
  return `${progress.recordingSessionId}\0${progress.stage}\0${progress.revision}`;
}

export function useNoteProcessingEvents(dependencies: UseNoteProcessingEventsDependencies) {
  const { dispatch, noteSaveController, setError } = dependencies;

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    const latestByNote = new Map<string, NoteProcessingProgressDto>();

    const refreshCompletedNote = async (progress: NoteProcessingProgressDto) => {
      const identity = progressIdentity(progress);
      try {
        // PR #917 made editor persistence asynchronous. Drain that note's
        // optimistic edits before hydrating the generated result so the done
        // snapshot cannot replace a newer local title or body.
        await noteSaveController.flush(progress.noteId);
        const note = await getNote(progress.noteId);
        const latest = latestByNote.get(progress.noteId);
        if (disposed || !latest || progressIdentity(latest) !== identity) return;
        if (note.updatedAt < progress.revision) return;
        dispatch({ type: "noteUpdated", note });
        if (latestByNote.get(progress.noteId) === latest) {
          latestByNote.delete(progress.noteId);
        }
      } catch (error) {
        if (!disposed) setError(messageFromError(error));
      }
    };

    void listen<NoteProcessingProgressDto>(NOTE_PROCESSING_PROGRESS_EVENT, (event) => {
      const progress = event.payload;
      latestByNote.set(progress.noteId, progress);
      dispatch({
        type: "noteProcessingStageChanged",
        noteId: progress.noteId,
        processingStatus: progress.processingStatus,
      });
      if (progress.stage === "done") {
        void refreshCompletedNote(progress);
      }
    }).then((cleanup) => {
      if (disposed) cleanup();
      else unlisten = cleanup;
    });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [dispatch, noteSaveController, setError]);
}
