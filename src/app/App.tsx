import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useReducer, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { DictationSettings } from "../components/dictation/DictationSettings";
import { NoteEditor } from "../components/note-editor/NoteEditor";
import { RecoveryBanner } from "../components/recorder/RecoveryBanner";
import { Sidebar, type SidebarView } from "../components/sidebar/Sidebar";
import {
  assignNoteToFolder,
  bootstrapApp,
  checkRecordingSourceReadiness,
  createFolder,
  createNote,
  deleteNote,
  finishRecording,
  getRecordingStatus,
  getNote,
  listNotes,
  pauseRecording,
  removeNoteFromFolder,
  recoverRecording,
  resumeRecording,
  retryProcessing,
  startRecording,
  updateNote,
} from "../lib/tauri";
import type { NoteDto, RecordingStatusDto } from "../lib/tauri";
import type {
  RecordingSourceMode,
  RecordingSourceReadinessDto,
} from "../lib/tauri";
import { shouldPollProcessingStatus } from "./processing-polling";
import { createInitialState, notesReducer } from "./state/app-state";

export function App() {
  const [state, dispatch] = useReducer(
    notesReducer,
    undefined,
    createInitialState,
  );
  const [error, setError] = useState<string | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [activeView, setActiveView] = useState<SidebarView>("notes");
  const [sourceMode, setSourceMode] =
    useState<RecordingSourceMode>("microphonePlusSystem");
  const [sourceReadiness, setSourceReadiness] =
    useState<RecordingSourceReadinessDto>();
  const [checkingSourceReadiness, setCheckingSourceReadiness] = useState(false);
  const selectedNote = state.selectedNote;

  useEffect(() => {
    bootstrapApp()
      .then(async (payload) => {
        dispatch({ type: "bootstrapLoaded", payload });
        const firstNoteId = payload.notes[0]?.id;
        if (firstNoteId) {
          const note = await getNote(firstNoteId);
          dispatch({ type: "noteLoaded", note });
        }
      })
      .catch((err: unknown) => setError(messageFromError(err)));
  }, []);

  useEffect(() => {
    let cancelled = false;
    setCheckingSourceReadiness(true);
    checkRecordingSourceReadiness(sourceMode)
      .then((readiness) => {
        if (!cancelled) setSourceReadiness(readiness);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(messageFromError(err));
      })
      .finally(() => {
        if (!cancelled) setCheckingSourceReadiness(false);
      });
    return () => {
      cancelled = true;
    };
  }, [sourceMode]);

  useEffect(() => {
    if (
      !state.recordingStatus ||
      !["recording", "paused"].includes(state.recordingStatus.state)
    ) {
      return;
    }
    const sessionId = state.recordingStatus.sessionId;
    const interval = window.setInterval(() => {
      getRecordingStatus(sessionId)
        .then((status) => dispatch({ type: "recordingStatusChanged", status }))
        .catch((err: unknown) => {
          if (!isAppErrorCode(err, "recording_not_found")) {
            setError(messageFromError(err));
          }
        });
    }, 250);
    return () => window.clearInterval(interval);
  }, [state.recordingStatus?.sessionId, state.recordingStatus?.state]);

  useEffect(() => {
    if (
      !selectedNote ||
      !shouldPollProcessingStatus(selectedNote.processingStatus)
    ) {
      return;
    }
    const noteId = selectedNote.id;
    const interval = window.setInterval(() => {
      getNote(noteId)
        .then((note) => dispatch({ type: "noteUpdated", note }))
        .catch((err: unknown) => setError(messageFromError(err)));
    }, 1000);
    return () => window.clearInterval(interval);
  }, [selectedNote?.id, selectedNote?.processingStatus]);

  async function handleCreateNote() {
    try {
      const note = await createNote(state.selectedFolderId);
      dispatch({ type: "noteLoaded", note });
    } catch (err) {
      setError(messageFromError(err));
    }
  }

  async function handleSelectFolder(folderId?: string) {
    dispatch({ type: "folderSelected", folderId });
    try {
      const response = await listNotes(folderId);
      dispatch({ type: "notesLoaded", notes: response.items });
    } catch (err) {
      setError(messageFromError(err));
    }
  }

  async function handleCreateFolder() {
    const name = window.prompt("Folder name");
    if (!name?.trim()) return;
    try {
      const folder = await createFolder(name);
      dispatch({ type: "folderCreated", folder });
      const response = await listNotes(folder.id);
      dispatch({ type: "notesLoaded", notes: response.items });
    } catch (err) {
      setError(messageFromError(err));
    }
  }

  async function handleSelectNote(noteId: string) {
    try {
      const note = await getNote(noteId);
      dispatch({ type: "noteLoaded", note });
    } catch (err) {
      setError(messageFromError(err));
    }
  }

  async function handleDeleteNote(noteId: string) {
    if (state.recordingStatus) {
      setError("Stop the current recording before deleting a note.");
      return;
    }
    try {
      await deleteNote(noteId);
      const response = await listNotes(state.selectedFolderId);
      dispatch({ type: "notesLoaded", notes: response.items });
      const nextNoteId = response.items[0]?.id;
      if (nextNoteId) {
        const note = await getNote(nextNoteId);
        dispatch({ type: "noteLoaded", note });
      }
    } catch (err) {
      setError(messageFromError(err));
    }
  }

  async function handleUpdateNote(
    patch: Partial<Pick<NoteDto, "title" | "editedContent">>,
  ) {
    if (!selectedNote) return;
    const optimistic = {
      ...selectedNote,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    dispatch({ type: "noteUpdated", note: optimistic });
    try {
      const note = await updateNote({
        noteId: selectedNote.id,
        title: patch.title,
        editedContent: patch.editedContent,
      });
      dispatch({ type: "noteUpdated", note });
    } catch (err) {
      setError(messageFromError(err));
    }
  }

  async function handleStartRecording() {
    if (!selectedNote) return;
    dispatch({
      type: "recordingStatusChanged",
      status: startingRecordingStatus(sourceMode),
    });
    try {
      setCheckingSourceReadiness(true);
      const readiness = await checkRecordingSourceReadiness(sourceMode);
      setSourceReadiness(readiness);
      if (!readiness.ready) {
        dispatch({ type: "recordingStatusCleared" });
        setError(
          readiness.sources.find((source) => source.required && !source.ready)
            ?.message ?? "The selected recording sources are not ready.",
        );
        return;
      }
      const recording = await startRecording(selectedNote.id, sourceMode);
      dispatch({
        type: "recordingStatusChanged",
        status: recordingToStatus(recording),
      });
    } catch (err) {
      dispatch({ type: "recordingStatusCleared" });
      setError(messageFromError(err));
    } finally {
      setCheckingSourceReadiness(false);
    }
  }

  async function handleFinishRecording(sessionId: string) {
    // Collapse the shell back to idle the instant stop is pressed so it
    // never lingers wide while the (potentially long) transcribe +
    // generate pipeline runs. The record button stays disabled via
    // processingLock until the backend resolves, and the body shimmer
    // ("Transcribing audio…" → "Generating notes…") tells the user
    // work is still in flight.
    dispatch({ type: "recordingStatusCleared" });
    if (selectedNote) {
      dispatch({
        type: "noteUpdated",
        note: { ...selectedNote, processingStatus: "transcribing" },
      });
    }
    try {
      const result = await finishRecording(sessionId);
      dispatch({ type: "noteUpdated", note: result.note });
    } catch (err) {
      setError(messageFromError(err));
    }
  }

  return (
    <main
      className="app-shell"
      data-sidebar={sidebarCollapsed ? "collapsed" : "expanded"}
    >
      <div
        className="titlebar-drag"
        aria-hidden
        data-tauri-drag-region
        onPointerDown={handleTitlebarPointerDown}
      />
      <Sidebar
        folders={state.folders}
        notes={state.notes}
        selectedNoteId={state.selectedNoteId}
        selectedFolderId={state.selectedFolderId}
        activeView={activeView}
        onChangeView={setActiveView}
        onCreateFolder={() => void handleCreateFolder()}
        onCreateNote={() => void handleCreateNote()}
        onSelectAll={() => void handleSelectFolder(undefined)}
        onSelectFolder={(folderId) => void handleSelectFolder(folderId)}
        onSelectNote={(noteId) => void handleSelectNote(noteId)}
        onDeleteNote={(noteId) => void handleDeleteNote(noteId)}
        collapsed={sidebarCollapsed}
        onToggleCollapsed={() => setSidebarCollapsed((value) => !value)}
      />
      <section className="main-panel">
        <div className="main-panel-body">
          {error ? <p className="error-banner">{error}</p> : null}
          <RecoveryBanner
            recoveries={state.activeRecoveries}
            onValidate={(sessionId) =>
              void recoverRecording(sessionId, "validate")
                .then((note) => {
                  dispatch({ type: "noteUpdated", note });
                  dispatch({ type: "recoveriesUpdated", recoveries: [] });
                })
                .catch((err: unknown) => setError(messageFromError(err)))
            }
            onDiscard={(sessionId) =>
              void recoverRecording(sessionId, "discard")
                .then((note) => {
                  dispatch({ type: "noteUpdated", note });
                  dispatch({ type: "recoveriesUpdated", recoveries: [] });
                })
                .catch((err: unknown) => setError(messageFromError(err)))
            }
          />
          <div className="workspace">
            {activeView === "dictation" ? (
              <DictationSettings />
            ) : selectedNote ? (
              <NoteEditor
                note={selectedNote}
                folders={state.folders}
                recordingStatus={state.recordingStatus}
                sourceMode={sourceMode}
                sourceReadiness={sourceReadiness}
                checkingSourceReadiness={checkingSourceReadiness}
                onTitleChange={(title) => void handleUpdateNote({ title })}
                onContentChange={(sourceNoteId, editedContent) => {
                  // Blur fired by an editor that was already torn
                  // down on note-switch — ignore so we don't write
                  // the old note's content into the new selectedNote.
                  if (sourceNoteId !== selectedNote.id) return;
                  void handleUpdateNote({ editedContent });
                }}
                onSourceModeChange={setSourceMode}
                onTabChange={(activeTab) =>
                  void updateNote({ noteId: selectedNote.id, activeTab }).then(
                    (note) => dispatch({ type: "noteUpdated", note }),
                  )
                }
                onStartRecording={() => void handleStartRecording()}
                onPauseRecording={(sessionId) =>
                  void pauseRecording(sessionId).then((status) =>
                    dispatch({ type: "recordingStatusChanged", status }),
                  )
                }
                onResumeRecording={(sessionId) =>
                  void resumeRecording(sessionId).then((status) =>
                    dispatch({ type: "recordingStatusChanged", status }),
                  )
                }
                onFinishRecording={(sessionId) =>
                  void handleFinishRecording(sessionId)
                }
                onRetry={() =>
                  selectedNote
                    ? void retryProcessing(selectedNote.id).then((note) =>
                        dispatch({ type: "noteUpdated", note }),
                      )
                    : undefined
                }
                onAssignFolder={(folderId) =>
                  void assignNoteToFolder(selectedNote.id, folderId).then(
                    (note) => dispatch({ type: "noteUpdated", note }),
                  )
                }
                onRemoveFolder={(folderId) =>
                  void removeNoteFromFolder(selectedNote.id, folderId).then(
                    (note) => dispatch({ type: "noteUpdated", note }),
                  )
                }
              />
            ) : (
              <section className="editor-empty">
                <button
                  type="button"
                  className="primary-action"
                  onClick={() => void handleCreateNote()}
                >
                  New note
                </button>
              </section>
            )}
          </div>
        </div>
      </section>
    </main>
  );
}

function handleTitlebarPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
  if (event.button !== 0 || event.detail > 1) return;
  event.preventDefault();
  void getCurrentWindow()
    .startDragging()
    .catch((error: unknown) =>
      console.warn("Failed to start window drag", error),
    );
}

function recordingToStatus(recording: {
  id: string;
  sourceMode?: RecordingStatusDto["sourceMode"];
  state: RecordingStatusDto["state"];
  elapsedMs: number;
  level: RecordingStatusDto["level"];
  sources?: RecordingStatusDto["sources"];
  warnings?: RecordingStatusDto["warnings"];
}): RecordingStatusDto {
  return {
    sessionId: recording.id,
    sourceMode: recording.sourceMode,
    state: recording.state,
    elapsedMs: recording.elapsedMs,
    level: recording.level,
    silenceWarning: false,
    bytesWritten: 0,
    sources: recording.sources,
    warnings: recording.warnings,
  };
}

function startingRecordingStatus(
  sourceMode: RecordingSourceMode,
): RecordingStatusDto {
  const sources: RecordingStatusDto["sources"] = [
    {
      source: "microphone",
      state: "starting",
      elapsedMs: 0,
      bytesWritten: 0,
      level: { peak: 0, rms: 0, recentPeaks: [] },
      silenceWarning: false,
      pathFinalized: false,
    },
  ];
  if (sourceMode === "microphonePlusSystem") {
    sources.push({
      source: "system",
      state: "starting",
      elapsedMs: 0,
      bytesWritten: 0,
      level: { peak: 0, rms: 0, recentPeaks: [] },
      silenceWarning: false,
      pathFinalized: false,
    });
  }

  return {
    sessionId: "",
    sourceMode,
    state: "starting",
    elapsedMs: 0,
    level: { peak: 0, rms: 0, recentPeaks: [] },
    silenceWarning: false,
    bytesWritten: 0,
    sources,
    warnings: [],
  };
}

function messageFromError(err: unknown) {
  if (err && typeof err === "object" && "message" in err) {
    return String((err as { message: unknown }).message);
  }
  return String(err);
}

function isAppErrorCode(err: unknown, code: string) {
  return (
    !!err &&
    typeof err === "object" &&
    "code" in err &&
    String((err as { code: unknown }).code) === code
  );
}
