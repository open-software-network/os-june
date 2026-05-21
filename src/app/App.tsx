import { useEffect, useReducer, useState } from "react";
import { NoteEditor } from "../components/note-editor/NoteEditor";
import { NotesList } from "../components/notes-list/NotesList";
import { RecoveryBanner } from "../components/recorder/RecoveryBanner";
import { Sidebar } from "../components/sidebar/Sidebar";
import {
  assignNoteToFolder,
  bootstrapApp,
  checkRecordingSourceReadiness,
  createFolder,
  createNote,
  deleteFolder,
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
import type {
  FolderDto,
  NoteDto,
  NoteListItemDto,
  RecordingStatusDto,
} from "../lib/tauri";
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
  const [sourceMode, setSourceMode] =
    useState<RecordingSourceMode>("microphoneOnly");
  const [sourceReadiness, setSourceReadiness] =
    useState<RecordingSourceReadinessDto>();
  const [checkingSourceReadiness, setCheckingSourceReadiness] = useState(false);
  const selectedNote = state.selectedNote;

  useEffect(() => {
    bootstrapApp()
      .then((payload) => dispatch({ type: "bootstrapLoaded", payload }))
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

  async function handleDeleteNote(note: NoteListItemDto) {
    const title = note.title.trim() || "New note";
    if (!window.confirm(`Delete "${title}"? This cannot be undone.`)) {
      return;
    }
    try {
      await deleteNote(note.id);
      dispatch({ type: "noteDeleted", noteId: note.id });
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

  async function handleCreateFolder(name: string) {
    try {
      const folder = await createFolder(name);
      dispatch({ type: "folderCreated", folder });
      const response = await listNotes(folder.id);
      dispatch({ type: "notesLoaded", notes: response.items });
    } catch (err) {
      setError(messageFromError(err));
      throw err;
    }
  }

  async function handleDeleteFolder(folder: FolderDto) {
    if (
      !window.confirm(
        `Delete folder "${folder.name}"? Notes can be kept in All Notes or deleted in the next step.`,
      )
    ) {
      return;
    }
    const deleteNotes = window.confirm(
      `Delete notes in "${folder.name}" too?\n\nOK deletes the notes. Cancel keeps them in All Notes.`,
    );
    const deletingSelectedFolder = state.selectedFolderId === folder.id;
    try {
      await deleteFolder(folder.id, deleteNotes);
      dispatch({
        type: "folderDeleted",
        folderId: folder.id,
        deleteNotes,
      });
      if (deletingSelectedFolder) {
        const response = await listNotes(undefined);
        dispatch({ type: "notesLoaded", notes: response.items });
      }
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
    try {
      setCheckingSourceReadiness(true);
      const readiness = await checkRecordingSourceReadiness(sourceMode);
      setSourceReadiness(readiness);
      if (!readiness.ready) {
        setError(
          readiness.sources.find((source) => source.required && !source.ready)
            ?.message ?? "The selected recording sources are not ready.",
        );
        return;
      }
      dispatch({
        type: "recordingStatusChanged",
        status: startingRecordingStatus(sourceMode),
      });
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
    if (state.recordingStatus?.sessionId === sessionId) {
      dispatch({
        type: "recordingStatusChanged",
        status: { ...state.recordingStatus, state: "validating" },
      });
    }
    try {
      const result = await finishRecording(sessionId);
      dispatch({ type: "noteUpdated", note: result.note });
      dispatch({ type: "recordingStatusCleared" });
    } catch (err) {
      dispatch({ type: "recordingStatusCleared" });
      setError(messageFromError(err));
    }
  }

  return (
    <main className="app-shell">
      <Sidebar
        folders={state.folders}
        selectedFolderId={state.selectedFolderId}
        onCreateFolder={(name) => handleCreateFolder(name)}
        onDeleteFolder={(folder) => void handleDeleteFolder(folder)}
        onSelectAll={() => void handleSelectFolder(undefined)}
        onSelectFolder={(folderId) => void handleSelectFolder(folderId)}
      />
      <section className="main-panel">
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
        <div className="workspace-shell">
          <NotesList
            notes={state.notes}
            selectedNoteId={state.selectedNoteId}
            emptyTitle={
              state.selectedFolderId ? "No notes in this folder yet" : undefined
            }
            onSelectNote={(noteId) => void handleSelectNote(noteId)}
            onDeleteNote={(note) => void handleDeleteNote(note)}
            onCreateNote={() => void handleCreateNote()}
          />
          {selectedNote ? (
            <NoteEditor
              note={selectedNote}
              folders={state.folders}
              recordingStatus={state.recordingStatus}
              sourceMode={sourceMode}
              sourceReadiness={sourceReadiness}
              checkingSourceReadiness={checkingSourceReadiness}
              onTitleChange={(title) => void handleUpdateNote({ title })}
              onContentChange={(editedContent) =>
                void handleUpdateNote({ editedContent })
              }
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
      </section>
    </main>
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
