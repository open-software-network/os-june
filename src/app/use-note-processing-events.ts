import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useRef } from "react";
import { messageFromError } from "../lib/errors";
import {
  getNote,
  NOTE_PROCESSING_PROGRESS_EVENT,
  type NoteListItemDto,
  type NoteProcessingProgressDto,
  type ProcessingStatus,
} from "../lib/tauri";
import { PROCESSING_DEMO_NOTE_ID } from "./processing-demo-ids";
import type { UseNoteProcessingEventsDependencies } from "./use-note-processing-events-types";

export const NOTE_PROCESSING_RECONCILE_INTERVAL_MS = 12_000;

function progressIdentity(progress: NoteProcessingProgressDto) {
  return `${progress.recordingSessionId}\0${progress.stage}\0${progress.revision}`;
}

function isActiveProcessingStatus(status: ProcessingStatus) {
  return status === "transcribing" || status === "generating";
}

function activeProcessingNotes(notes: NoteListItemDto[]) {
  return notes.filter(
    (note) =>
      isActiveProcessingStatus(note.processingStatus) &&
      !(import.meta.env.DEV && note.id === PROCESSING_DEMO_NOTE_ID),
  );
}

export function useNoteProcessingEvents(dependencies: UseNoteProcessingEventsDependencies) {
  const { dispatch, noteSaveController, notes, setError } = dependencies;
  const activeNotesRef = useRef(new Map<string, NoteListItemDto>());
  const reconcileInFlightRef = useRef(new Map<string, Promise<void>>());
  const pendingTerminalHydrationsRef = useRef(new Map<string, NoteProcessingProgressDto>());
  const terminalHydrationInFlightRef = useRef(new Map<string, Promise<void>>());
  const terminalHydrationRetryRef = useRef(new Map<string, number>());
  const refreshCompletedNoteRef = useRef<(progress: NoteProcessingProgressDto) => Promise<void>>(
    async () => undefined,
  );
  const disposedRef = useRef(false);
  const activeNotes = activeProcessingNotes(notes);
  const activeProcessingKey = activeNotes
    .map((note) => note.id)
    .sort()
    .join("\0");

  useEffect(() => {
    activeNotesRef.current = new Map(activeProcessingNotes(notes).map((note) => [note.id, note]));
  }, [notes]);

  useEffect(() => {
    disposedRef.current = false;
    return () => {
      disposedRef.current = true;
      for (const timeout of terminalHydrationRetryRef.current.values()) {
        window.clearTimeout(timeout);
      }
      terminalHydrationRetryRef.current.clear();
    };
  }, []);

  const clearTerminalHydration = useCallback((progress: NoteProcessingProgressDto) => {
    const pending = pendingTerminalHydrationsRef.current.get(progress.noteId);
    if (!pending || progressIdentity(pending) !== progressIdentity(progress)) return;
    pendingTerminalHydrationsRef.current.delete(progress.noteId);
    const timeout = terminalHydrationRetryRef.current.get(progress.noteId);
    if (timeout !== undefined) {
      window.clearTimeout(timeout);
      terminalHydrationRetryRef.current.delete(progress.noteId);
    }
  }, []);

  const scheduleTerminalHydrationRetry = useCallback((progress: NoteProcessingProgressDto) => {
    if (terminalHydrationRetryRef.current.has(progress.noteId)) return;
    const timeout = window.setTimeout(() => {
      terminalHydrationRetryRef.current.delete(progress.noteId);
      const pending = pendingTerminalHydrationsRef.current.get(progress.noteId);
      if (
        disposedRef.current ||
        !pending ||
        progressIdentity(pending) !== progressIdentity(progress)
      ) {
        return;
      }
      void refreshCompletedNoteRef.current(pending);
    }, NOTE_PROCESSING_RECONCILE_INTERVAL_MS);
    terminalHydrationRetryRef.current.set(progress.noteId, timeout);
  }, []);

  const refreshCompletedNote = useCallback(
    (progress: NoteProcessingProgressDto) => {
      const pending = terminalHydrationInFlightRef.current.get(progress.noteId);
      if (pending) return pending;

      let shouldRetry = false;
      const hydration = (async () => {
        try {
          // PR #917 made editor persistence asynchronous. Drain that note's
          // optimistic edits before hydrating the generated result so the done
          // snapshot cannot replace a newer local title or body.
          await noteSaveController.flush(progress.noteId);
          const note = await getNote(progress.noteId);
          const latest = pendingTerminalHydrationsRef.current.get(progress.noteId);
          if (
            disposedRef.current ||
            !latest ||
            progressIdentity(latest) !== progressIdentity(progress)
          ) {
            return;
          }
          if (note.updatedAt < progress.revision) {
            shouldRetry = true;
            return;
          }
          dispatch({ type: "noteUpdated", note });
          clearTerminalHydration(progress);
        } catch (error) {
          shouldRetry = true;
          if (!disposedRef.current) setError(messageFromError(error));
        }
      })();

      terminalHydrationInFlightRef.current.set(progress.noteId, hydration);
      void hydration.finally(() => {
        if (terminalHydrationInFlightRef.current.get(progress.noteId) === hydration) {
          terminalHydrationInFlightRef.current.delete(progress.noteId);
        }
        const latest = pendingTerminalHydrationsRef.current.get(progress.noteId);
        if (
          disposedRef.current ||
          !latest ||
          progressIdentity(latest) !== progressIdentity(progress)
        ) {
          if (latest && !disposedRef.current) void refreshCompletedNoteRef.current(latest);
          return;
        }
        if (shouldRetry) scheduleTerminalHydrationRetry(progress);
      });
      return hydration;
    },
    [
      clearTerminalHydration,
      dispatch,
      noteSaveController,
      scheduleTerminalHydrationRetry,
      setError,
    ],
  );
  refreshCompletedNoteRef.current = refreshCompletedNote;

  const reconcileNote = useCallback(
    (noteId: string) => {
      const pending = reconcileInFlightRef.current.get(noteId);
      if (pending) return pending;

      const reconciliation = (async () => {
        try {
          // The safety path can race an editor save just like the done event.
          // Flush first so recovery never replaces a newer optimistic edit.
          await noteSaveController.flush(noteId);
          const note = await getNote(noteId);
          const activeSnapshot = activeNotesRef.current.get(noteId);
          if (disposedRef.current || !activeSnapshot) return;
          // The backstop detects a missed terminal event; it deliberately does
          // not restore progressive full-note hydration while processing.
          if (isActiveProcessingStatus(note.processingStatus)) return;
          if (note.updatedAt < activeSnapshot.updatedAt) return;
          dispatch({ type: "noteUpdated", note });
        } catch (error) {
          if (!disposedRef.current) setError(messageFromError(error));
        }
      })();

      reconcileInFlightRef.current.set(noteId, reconciliation);
      void reconciliation.finally(() => {
        if (reconcileInFlightRef.current.get(noteId) === reconciliation) {
          reconcileInFlightRef.current.delete(noteId);
        }
      });
      return reconciliation;
    },
    [dispatch, noteSaveController, setError],
  );

  const reconcileActiveNotes = useCallback(() => {
    for (const noteId of activeNotesRef.current.keys()) {
      void reconcileNote(noteId);
    }
  }, [reconcileNote]);

  const reconcilePendingTerminalHydrations = useCallback(() => {
    for (const progress of pendingTerminalHydrationsRef.current.values()) {
      void refreshCompletedNote(progress);
    }
  }, [refreshCompletedNote]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;

    void listen<NoteProcessingProgressDto>(NOTE_PROCESSING_PROGRESS_EVENT, (event) => {
      const progress = event.payload;
      dispatch({
        type: "noteProcessingStageChanged",
        noteId: progress.noteId,
        processingStatus: progress.processingStatus,
      });
      if (progress.stage === "done") {
        pendingTerminalHydrationsRef.current.set(progress.noteId, progress);
        void refreshCompletedNote(progress);
      } else {
        const pending = pendingTerminalHydrationsRef.current.get(progress.noteId);
        if (pending) clearTerminalHydration(pending);
      }
    }).then((cleanup) => {
      if (disposed) cleanup();
      else unlisten = cleanup;
    });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [clearTerminalHydration, dispatch, refreshCompletedNote]);

  useEffect(() => {
    const reconcileProcessing = () => {
      reconcileActiveNotes();
      reconcilePendingTerminalHydrations();
    };
    const onFocus = () => reconcileProcessing();
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") reconcileProcessing();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [reconcileActiveNotes, reconcilePendingTerminalHydrations]);

  useEffect(() => {
    if (!activeProcessingKey) return;
    const interval = window.setInterval(
      reconcileActiveNotes,
      NOTE_PROCESSING_RECONCILE_INTERVAL_MS,
    );
    return () => window.clearInterval(interval);
  }, [activeProcessingKey, reconcileActiveNotes]);
}
