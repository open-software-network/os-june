import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useReducer, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { DictionaryWorkspace } from "../components/dictionary/DictionaryWorkspace";
import { FoldersWorkspace } from "../components/folders/FoldersWorkspace";
import { NoteFromFolderCrumb } from "../components/folders/NoteFromFolderCrumb";
import { NoteEditor } from "../components/note-editor/NoteEditor";
import { PermissionsOnboarding } from "../components/onboarding/PermissionsOnboarding";
import { RecoveryBanner } from "../components/recorder/RecoveryBanner";
import { AppSettings } from "../components/settings/AppSettings";
import { Sidebar, type SidebarView } from "../components/sidebar/Sidebar";
import { StylesWorkspace } from "../components/styles/StylesWorkspace";
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
  renameFolder,
  resumeRecording,
  retryProcessing,
  startRecording,
  updateNote,
} from "../lib/tauri";
import {
  playRecordingSound,
  preloadRecordingSounds,
} from "../lib/recording-sounds";
import type { NoteDto, RecordingStatusDto } from "../lib/tauri";
import type {
  RecordingSourceMode,
  RecordingSourceReadinessDto,
} from "../lib/tauri";
import { shouldPollProcessingStatus } from "./processing-polling";
import { createInitialState, notesReducer } from "./state/app-state";

const ONBOARDING_COMPLETE_KEY = "os-scribe:onboarding:permissions:v1";
const ONBOARDING_ROUTE_PARAM = "onboarding";
const ONBOARDING_ROUTE_HASH = "#onboarding";

export function App() {
  const [state, dispatch] = useReducer(
    notesReducer,
    undefined,
    createInitialState,
  );
  const [error, setError] = useState<string | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [activeView, setActiveView] = useState<SidebarView>("notes");
  const [originFolderId, setOriginFolderId] = useState<string | undefined>();
  const [sourceMode, setSourceMode] = useState<RecordingSourceMode>(
    "microphonePlusSystem",
  );
  const [sourceReadiness, setSourceReadiness] =
    useState<RecordingSourceReadinessDto>();
  const [checkingSourceReadiness, setCheckingSourceReadiness] = useState(false);
  const [showOnboarding, setShowOnboarding] = useState(
    () => !onboardingComplete() || onboardingRouteRequested(),
  );
  const selectedNote = state.selectedNote;

  useEffect(() => {
    preloadRecordingSounds();
  }, []);

  useEffect(() => {
    function showOnboardingFromRoute() {
      if (onboardingRouteRequested()) setShowOnboarding(true);
    }
    window.addEventListener("hashchange", showOnboardingFromRoute);
    window.addEventListener("popstate", showOnboardingFromRoute);
    return () => {
      window.removeEventListener("hashchange", showOnboardingFromRoute);
      window.removeEventListener("popstate", showOnboardingFromRoute);
    };
  }, []);

  useEffect(() => {
    bootstrapApp()
      .then(async (payload) => {
        dispatch({ type: "bootstrapLoaded", payload });
        const firstNoteId = payload.notes[0]?.id;
        if (firstNoteId) {
          const note = await getNote(firstNoteId);
          dispatch({ type: "noteLoaded", note });
        } else {
          setActiveView("settings");
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

  async function handleCreateNote(folderId?: string) {
    try {
      const note = await createNote(folderId ?? state.selectedFolderId);
      dispatch({ type: "noteLoaded", note });
      setActiveView("notes");
    } catch (err) {
      setError(messageFromError(err));
    }
  }

  function handleSelectFolder(folderId?: string) {
    dispatch({ type: "folderSelected", folderId });
  }

  async function handleCreateFolder(name: string, description?: string) {
    try {
      const folder = await createFolder(name, description);
      dispatch({ type: "folderCreated", folder });
      return folder;
    } catch (err) {
      setError(messageFromError(err));
      return undefined;
    }
  }

  async function handleRenameFolder(
    folderId: string,
    name: string,
    description?: string,
  ) {
    try {
      const folder = await renameFolder(folderId, name, description);
      dispatch({ type: "folderRenamed", folder });
    } catch (err) {
      setError(messageFromError(err));
    }
  }

  async function handleDeleteFolder(folderId: string) {
    try {
      // Deleting a folder strips its association from any notes but
      // never deletes the notes themselves — they stay in your library.
      await deleteFolder(folderId, false);
      dispatch({ type: "folderDeleted", folderId });
    } catch (err) {
      setError(messageFromError(err));
    }
  }

  async function handleAssignNoteToFolder(
    noteId: string,
    folderId: string,
    options?: { rethrow?: boolean },
  ) {
    try {
      const note = await assignNoteToFolder(noteId, folderId);
      dispatch({ type: "noteUpdated", note });
      return note;
    } catch (err) {
      setError(messageFromError(err));
      if (options?.rethrow) {
        throw err;
      }
      return undefined;
    }
  }

  async function handleRemoveNoteFromFolder(noteId: string, folderId: string) {
    try {
      const note = await removeNoteFromFolder(noteId, folderId);
      dispatch({ type: "noteUpdated", note });
    } catch (err) {
      setError(messageFromError(err));
    }
  }

  async function handleSelectNote(noteId: string) {
    try {
      const note = await getNote(noteId);
      dispatch({ type: "noteLoaded", note });
      setOriginFolderId(undefined);
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
      const response = await listNotes();
      dispatch({ type: "notesLoaded", notes: response.items });
      const nextNoteId = response.items[0]?.id;
      if (nextNoteId) {
        const note = await getNote(nextNoteId);
        dispatch({ type: "noteLoaded", note });
      } else {
        setActiveView("settings");
        setOriginFolderId(undefined);
      }
    } catch (err) {
      setError(messageFromError(err));
    }
  }

  async function handleSelectNoteFromFolder(noteId: string, folderId: string) {
    try {
      const note = await getNote(noteId);
      dispatch({ type: "noteLoaded", note });
      setOriginFolderId(folderId);
      setActiveView("notes");
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
      playRecordingSound("start");
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
    playRecordingSound("stop");
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

  async function handlePauseRecording(sessionId: string) {
    try {
      const status = await pauseRecording(sessionId);
      dispatch({ type: "recordingStatusChanged", status });
      playRecordingSound("pause");
    } catch (err) {
      setError(messageFromError(err));
    }
  }

  async function handleResumeRecording(sessionId: string) {
    playRecordingSound("start");
    try {
      const status = await resumeRecording(sessionId);
      dispatch({ type: "recordingStatusChanged", status });
    } catch (err) {
      setError(messageFromError(err));
    }
  }

  function handleOnboardingComplete() {
    markOnboardingComplete();
    setShowOnboarding(false);
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
      <PermissionsOnboarding
        open={showOnboarding}
        onComplete={handleOnboardingComplete}
      />
      <Sidebar
        folders={state.folders}
        notes={state.notes}
        selectedNoteId={state.selectedNoteId}
        selectedFolderId={state.selectedFolderId}
        activeView={activeView}
        onChangeView={(view) => {
          setActiveView(view);
          if (view === "folders") {
            dispatch({ type: "folderSelected", folderId: undefined });
          }
          if (view !== "notes") {
            setOriginFolderId(undefined);
          }
        }}
        onCreateFolder={() => {
          setActiveView("folders");
          dispatch({ type: "folderSelected", folderId: undefined });
        }}
        onCreateNote={() => void handleCreateNote()}
        onSelectAll={() => handleSelectFolder(undefined)}
        onSelectFolder={(folderId) => handleSelectFolder(folderId)}
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
            {activeView === "settings" ? (
              <AppSettings
                sourceMode={sourceMode}
                sourceReadiness={sourceReadiness}
                checkingSourceReadiness={checkingSourceReadiness}
                onSourceModeChange={setSourceMode}
                onOpenOnboarding={() => setShowOnboarding(true)}
              />
            ) : activeView === "styles" ? (
              <StylesWorkspace />
            ) : activeView === "dictionary" ? (
              <DictionaryWorkspace />
            ) : activeView === "folders" ? (
              <FoldersWorkspace
                folders={state.folders}
                notes={state.notes}
                selectedFolderId={state.selectedFolderId}
                onSelectFolder={(folderId) =>
                  dispatch({ type: "folderSelected", folderId })
                }
                onCreateFolder={(name, description) =>
                  handleCreateFolder(name, description)
                }
                onRenameFolder={(folderId, name, description) =>
                  void handleRenameFolder(folderId, name, description)
                }
                onDeleteFolder={(folderId) => void handleDeleteFolder(folderId)}
                onCreateNote={(folderId) => void handleCreateNote(folderId)}
                onSelectNote={(noteId) => {
                  const folderId = state.selectedFolderId;
                  if (folderId) {
                    void handleSelectNoteFromFolder(noteId, folderId);
                  } else {
                    void handleSelectNote(noteId).then(() =>
                      setActiveView("notes"),
                    );
                  }
                }}
                onAssignNoteToFolder={(noteId, folderId) =>
                  handleAssignNoteToFolder(noteId, folderId, {
                    rethrow: true,
                  })
                }
                onRemoveNoteFromFolder={(noteId, folderId) =>
                  void handleRemoveNoteFromFolder(noteId, folderId)
                }
                onDeleteNote={(noteId) => void handleDeleteNote(noteId)}
              />
            ) : selectedNote ? (
              <div
                className="note-shell"
                data-with-crumb={originFolderId ? "true" : undefined}
              >
                {originFolderId ? (
                  <NoteFromFolderCrumb
                    folder={state.folders.find(
                      (folder) => folder.id === originFolderId,
                    )}
                    noteTitle={selectedNote.title.trim() || "New note"}
                    onBackToFolders={() => {
                      setActiveView("folders");
                      dispatch({
                        type: "folderSelected",
                        folderId: undefined,
                      });
                      setOriginFolderId(undefined);
                    }}
                    onBackToFolder={(folderId) => {
                      setActiveView("folders");
                      dispatch({ type: "folderSelected", folderId });
                      setOriginFolderId(undefined);
                    }}
                  />
                ) : null}
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
                    void updateNote({
                      noteId: selectedNote.id,
                      activeTab,
                    }).then((note) => dispatch({ type: "noteUpdated", note }))
                  }
                  onStartRecording={() => void handleStartRecording()}
                  onPauseRecording={(sessionId) =>
                    void handlePauseRecording(sessionId)
                  }
                  onResumeRecording={(sessionId) =>
                    void handleResumeRecording(sessionId)
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
                    void handleAssignNoteToFolder(selectedNote.id, folderId)
                  }
                  onRemoveFolder={(folderId) =>
                    void removeNoteFromFolder(selectedNote.id, folderId).then(
                      (note) => dispatch({ type: "noteUpdated", note }),
                    )
                  }
                  onCreateAndAssignFolder={(name) => {
                    void (async () => {
                      const folder = await handleCreateFolder(name);
                      if (folder) {
                        await handleAssignNoteToFolder(
                          selectedNote.id,
                          folder.id,
                        );
                      }
                    })();
                  }}
                />
              </div>
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

function onboardingComplete() {
  try {
    return localStorage.getItem(ONBOARDING_COMPLETE_KEY) === "complete";
  } catch {
    return false;
  }
}

function markOnboardingComplete() {
  try {
    localStorage.setItem(ONBOARDING_COMPLETE_KEY, "complete");
  } catch {
    // If storage is unavailable, keep the app usable for this session.
  }
}

function onboardingRouteRequested() {
  try {
    const params = new URLSearchParams(window.location.search);
    const value = params.get(ONBOARDING_ROUTE_PARAM)?.toLowerCase();
    return (
      value === "1" ||
      value === "true" ||
      value === "permissions" ||
      window.location.hash.toLowerCase() === ONBOARDING_ROUTE_HASH
    );
  } catch {
    return false;
  }
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
