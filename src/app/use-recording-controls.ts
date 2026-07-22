import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useRef } from "react";
import { invalidateNoteTabs } from "./tabs/tabs";
import {
  finishRecording,
  getNote,
  listNotes,
  pauseRecording,
  resolveAgentRecorderRequest,
  resumeRecording,
} from "../lib/tauri";
import { playRecordingSound } from "../lib/recording-sounds";
import { AGENT_RECORDER_REQUEST_EVENT } from "../lib/events";
import { errorCode, messageFromError } from "../lib/errors";
import { getActiveHermesProfileName } from "../lib/active-hermes-profile";
import type { RecordingSourceMode } from "../lib/tauri";
import { RECORD_NOTICES_DEMO_SESSION_ID } from "./processing-polling";
import { type AgentRecorderRequestPayload } from "./app-shell";
import type { UseRecordingControlsDependencies } from "./use-recording-controls-types";

export function useRecordingControls(dependencies: UseRecordingControlsDependencies) {
  const {
    activeViewRef,
    appBlocked,
    bootstrapped,
    crossProfileRecordingNoteIdRef,
    dispatch,
    finishingSessionsRef,
    handleStartAgentRecording,
    recordNoticesDemoRef,
    recordingNoteIdRef,
    recordingStatusRef,
    selectedNote,
    setActiveView,
    setError,
    setFolderReturnTarget,
    setOriginAllNotes,
    setOriginFolderId,
    setRecordingNote,
    setTabs,
    state,
    tabsRef,
  } = dependencies;

  const agentRecorderHandlerRef = useRef<(payload: AgentRecorderRequestPayload) => Promise<void>>(
    async () => {},
  );
  agentRecorderHandlerRef.current = async (payload: AgentRecorderRequestPayload) => {
    const requestId = typeof payload.requestId === "string" ? payload.requestId : "";
    if (!requestId) return;

    const resolve = (result: {
      ok: boolean;
      noteId?: string;
      noteTitle?: string;
      errorCode?: string;
      errorMessage?: string;
    }) => {
      void resolveAgentRecorderRequest({ requestId, ...result }).catch(async (err) => {
        console.warn("Failed to resolve agent recorder request", err);
        // A transient resolve failure (IPC hiccup, poisoned lock) happens
        // while the proxy is still waiting inside its lease: retry once
        // instead of treating it as an expired request.
        if (errorCode(err) !== "agent_recorder_request_not_found") {
          try {
            await resolveAgentRecorderRequest({ requestId, ...result });
            return;
          } catch (retryErr) {
            if (errorCode(retryErr) !== "agent_recorder_request_not_found") {
              console.warn("Agent recorder resolve retry failed", retryErr);
              return;
            }
          }
        }
        // Lease expired: the proxy already told the agent this request
        // failed. Leaving a recording running that the agent believes never
        // started diverges tool state from app state, so stop a successful
        // late start. The note (and any audio it captured) is kept: it is
        // real user data and the recorder was visibly running.
        if (result.ok && payload.action === "start") {
          const active = recordingStatusRef.current;
          if (active && recordingNoteIdRef.current === result.noteId) {
            try {
              await handleFinishRecording(active.sessionId, { rethrow: true });
            } catch (rollbackErr) {
              console.warn("Failed to stop expired agent recording", rollbackErr);
            }
          }
        }
      });
    };

    if (appBlocked || !bootstrapped) {
      resolve({
        ok: false,
        errorCode: "app_not_ready",
        errorMessage: "June is not ready to start or stop recording yet.",
      });
      return;
    }

    try {
      if (payload.action === "start") {
        const requestedSourceMode: RecordingSourceMode =
          payload.sourceMode === "microphonePlusSystem" ? "microphonePlusSystem" : "microphoneOnly";
        const note = await handleStartAgentRecording(requestedSourceMode);
        resolve({ ok: true, noteId: note.id, noteTitle: note.title });
        return;
      }
      if (payload.action === "stop") {
        const activeRecording = recordingStatusRef.current;
        const noteId = recordingNoteIdRef.current ?? activeRecording?.noteId;
        const noteTitle = noteId
          ? (state.notes.find((note) => note.id === noteId)?.title ?? selectedNote?.title)
          : undefined;
        if (!activeRecording) {
          resolve({
            ok: false,
            errorCode: "recording_not_found",
            errorMessage: "No recording is currently running.",
          });
          return;
        }
        await handleFinishRecording(activeRecording.sessionId, { rethrow: true });
        resolve({ ok: true, noteId, noteTitle });
        return;
      }
      resolve({
        ok: false,
        errorCode: "invalid_action",
        errorMessage: "Recorder action must be start or stop.",
      });
    } catch (err) {
      resolve({
        ok: false,
        errorCode: "agent_recorder_failed",
        errorMessage: messageFromError(err),
      });
    }
  };

  useEffect(() => {
    let aborted = false;
    let unlisten: (() => void) | undefined;
    void listen(AGENT_RECORDER_REQUEST_EVENT, (event) => {
      void agentRecorderHandlerRef.current((event.payload ?? {}) as AgentRecorderRequestPayload);
    }).then((cleanup) => {
      if (aborted) cleanup();
      else unlisten = cleanup;
    });
    return () => {
      aborted = true;
      unlisten?.();
    };
  }, []);

  async function handleFinishRecording(sessionId: string, options: { rethrow?: boolean } = {}) {
    // The dev __recordNoticesDemo session has no backend recording — stopping it
    // just tears the demo down (clears the synthetic status and pins) instead of
    // calling finishRecording, which would fail with "recording not found".
    if (import.meta.env.DEV && sessionId === RECORD_NOTICES_DEMO_SESSION_ID) {
      recordNoticesDemoRef.current?.clear();
      return;
    }
    // The recorder bar stays mounted (and clickable) for the duration of its
    // exit animation after the first stop click, so a fast double-click would
    // fire finishRecording twice — the second call fails with a scary
    // "recording not found" error. Gate per session until the call settles.
    if (finishingSessionsRef.current.has(sessionId)) return;
    finishingSessionsRef.current.add(sessionId);
    // Collapse the shell back to idle the instant stop is pressed so it
    // never lingers wide while the (potentially long) transcribe +
    // generate pipeline runs. Processing is queued per note, so the record
    // button stays available — you can stack another take while this one
    // finishes — and the body shimmer ("Transcribing audio…" → "Generating
    // notes…") plus a queued count tell the user work is still in flight.
    const owningNoteId = recordingNoteIdRef.current;
    const wasCrossProfileRecording =
      !!owningNoteId && crossProfileRecordingNoteIdRef.current === owningNoteId;
    dispatch({ type: "recordingStatusCleared" });
    setRecordingNote(undefined);
    if (wasCrossProfileRecording && owningNoteId) {
      crossProfileRecordingNoteIdRef.current = undefined;
      const nextTabs = invalidateNoteTabs(tabsRef.current, new Set([owningNoteId]));
      if (nextTabs !== tabsRef.current) {
        tabsRef.current = nextTabs;
        setTabs(nextTabs);
      }
      // The old-profile note was temporarily present only to control the
      // recording. Once the take stops, remove it from the active profile's
      // visible list before any tab or sidebar action can reopen it.
      dispatch({
        type: "notesLoaded",
        notes: state.notes.filter((note) => note.id !== owningNoteId),
      });
      setOriginFolderId(undefined);
      setOriginAllNotes(false);
      setFolderReturnTarget(undefined);
      if (activeViewRef.current === "meetings") setActiveView("notes");
    }
    playRecordingSound("stop");
    // Optimistically flip the note that owns this recording to transcribing.
    // The selected note isn't necessarily that note — the user may have
    // browsed elsewhere while recording — and stamping the wrong note as
    // transcribing would lock its record button and shimmer forever.
    if (selectedNote && selectedNote.id === owningNoteId) {
      dispatch({
        type: "noteProcessingUpdated",
        note: {
          ...selectedNote,
          processingStatus: "transcribing",
          lastError:
            selectedNote.processingStatus === "failed" ||
            selectedNote.processingStatus === "recoverable"
              ? undefined
              : selectedNote.lastError,
        },
      });
    }
    try {
      const result = await finishRecording(sessionId);
      // The result belongs to the profile where recording started. Once that
      // profile's temporary recording view has been retired, do not let the
      // finish response upsert the old note into the newly active profile.
      if (!wasCrossProfileRecording) {
        dispatch({ type: "noteProcessingUpdated", note: result.note });
      }
    } catch (err) {
      if (
        wasCrossProfileRecording ||
        !owningNoteId ||
        !(await applyNoteScopedProcessingFailure(owningNoteId, err))
      ) {
        setError(messageFromError(err));
      }
      if (options.rethrow) throw err;
    } finally {
      if (wasCrossProfileRecording) {
        const finishingProfile = getActiveHermesProfileName();
        try {
          const response = await listNotes();
          if (getActiveHermesProfileName() === finishingProfile) {
            dispatch({ type: "notesLoaded", notes: response.items });
          }
        } catch (refreshErr) {
          if (getActiveHermesProfileName() === finishingProfile) {
            setError(messageFromError(refreshErr));
          }
        }
      }
      finishingSessionsRef.current.delete(sessionId);
    }
  }

  async function applyNoteScopedProcessingFailure(noteId: string, err: unknown) {
    try {
      const note = await getNote(noteId);
      if (note.processingStatus !== "failed") return false;
      dispatch({ type: "noteProcessingUpdated", note });
      setError(null);
      return true;
    } catch {
      return false;
    }
  }

  const handlePauseRecording = useCallback(async (sessionId: string) => {
    // The dev __recordNoticesDemo session has no backend recording; report
    // success without a pauseRecording IPC round-trip. Its own ticker keeps the
    // bar live, so pause is a visual no-op here.
    if (import.meta.env.DEV && sessionId === RECORD_NOTICES_DEMO_SESSION_ID) {
      return true;
    }
    try {
      const status = await pauseRecording(sessionId);
      dispatch({ type: "recordingStatusChanged", status });
      playRecordingSound("pause");
      return true;
    } catch (err) {
      setError(messageFromError(err));
      return false;
    }
  }, []);

  async function handleResumeRecording(sessionId: string) {
    // The dev __recordNoticesDemo session has no backend recording; its ticker
    // already keeps the bar in the recording state, so resume is a no-op.
    if (import.meta.env.DEV && sessionId === RECORD_NOTICES_DEMO_SESSION_ID) {
      return;
    }
    playRecordingSound("start");
    try {
      const status = await resumeRecording(sessionId);
      dispatch({ type: "recordingStatusChanged", status });
    } catch (err) {
      setError(messageFromError(err));
    }
  }

  return {
    applyNoteScopedProcessingFailure,
    handleFinishRecording,
    handlePauseRecording,
    handleResumeRecording,
  };
}
