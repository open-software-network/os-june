import { useEffect, useReducer, useState } from "react";
import { NoteEditor } from "../components/note-editor/NoteEditor";
import { NotesList } from "../components/notes-list/NotesList";
import { RecoveryBanner } from "../components/recorder/RecoveryBanner";
import { Sidebar } from "../components/sidebar/Sidebar";
import {
  assignNoteToFolder,
  bootstrapApp,
  createFolder,
  createNote,
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
import { createInitialState, notesReducer } from "./state/app-state";

export function App() {
  const [state, dispatch] = useReducer(
    notesReducer,
    undefined,
    createInitialState,
  );
  const [error, setError] = useState<string | null>(null);
  const selectedNote = state.selectedNote;

  useEffect(() => {
    bootstrapApp()
      .then((payload) => dispatch({ type: "bootstrapLoaded", payload }))
      .catch((err: unknown) => setError(messageFromError(err)));
  }, []);

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
      const recording = await startRecording(selectedNote.id);
      dispatch({
        type: "recordingStatusChanged",
        status: recordingToStatus(recording),
      });
    } catch (err) {
      setError(messageFromError(err));
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
        onCreateFolder={() => void handleCreateFolder()}
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
        <div className="app-shell">
          <NotesList
            notes={state.notes}
            selectedNoteId={state.selectedNoteId}
            onSelectNote={(noteId) => void handleSelectNote(noteId)}
            onCreateNote={() => void handleCreateNote()}
          />
          {selectedNote ? (
            <NoteEditor
              note={selectedNote}
              folders={state.folders}
              recordingStatus={state.recordingStatus}
              onTitleChange={(title) => void handleUpdateNote({ title })}
              onContentChange={(editedContent) =>
                void handleUpdateNote({ editedContent })
              }
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
  state: RecordingStatusDto["state"];
  elapsedMs: number;
  level: RecordingStatusDto["level"];
}): RecordingStatusDto {
  return {
    sessionId: recording.id,
    state: recording.state,
    elapsedMs: recording.elapsedMs,
    level: recording.level,
    silenceWarning: false,
    bytesWritten: 0,
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
