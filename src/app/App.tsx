import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useCallback, useEffect, useMemo, useReducer, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { AccountGate } from "../components/account/AccountGate";
import { DictationHistoryView } from "../components/dictation/DictationHistoryView";
import { FoldersWorkspace } from "../components/folders/FoldersWorkspace";
import { MoveNoteToFolderDialog } from "../components/folders/MoveNoteToFolderDialog";
import { NoteEditor } from "../components/note-editor/NoteEditor";
import { NotesList } from "../components/notes-list/NotesList";
import { PermissionBanner } from "../components/permissions/PermissionBanner";
import { AppSettings } from "../components/settings/AppSettings";
import { Sidebar, type SidebarView } from "../components/sidebar/Sidebar";
import { BreadcrumbBar } from "../components/ui/BreadcrumbBar";
import {
  assignNoteToFolder,
  bootstrapApp,
  checkRecordingSourceReadiness,
  createFolder,
  createNote,
  deleteFolder,
  deleteNote,
  dictationHelperCommand,
  finishRecording,
  getRecordingStatus,
  getNote,
  listNotes,
  openPrivacySettings,
  osAccountsTopUp,
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
import type {
  BootstrapResponse,
  DictationHelperEvent,
  NoteDto,
  RecordingStatusDto,
} from "../lib/tauri";
import type {
  RecordingSourceMode,
  RecordingSourceReadinessDto,
} from "../lib/tauri";
import { useAccountStatus } from "../lib/account-status";
import { shouldBlockOnSignIn } from "../lib/account-gate";
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
  const [originFolderId, setOriginFolderId] = useState<string | undefined>();
  const [folderReturnTarget, setFolderReturnTarget] = useState<
    { noteId: string; label: string } | undefined
  >();
  const [moveDialogNoteId, setMoveDialogNoteId] = useState<string | null>(null);
  // User's intent for system audio. Defaults true ("record everything").
  // The actual sourceMode is derived below so that granting/revoking
  // permission in System Settings flips the toggle without losing intent.
  const [userWantsSystemAudio, setUserWantsSystemAudio] = useState(true);
  const [sourceReadiness, setSourceReadiness] =
    useState<RecordingSourceReadinessDto>();
  const [checkingSourceReadiness, setCheckingSourceReadiness] = useState(false);
  const [accessibilityStatus, setAccessibilityStatus] = useState<string>();
  const [microphoneStatus, setMicrophoneStatus] = useState<string>();
  const systemGranted = !!sourceReadiness?.sources.find(
    (source) => source.source === "system",
  )?.ready;
  const sourceMode: RecordingSourceMode =
    userWantsSystemAudio && systemGranted
      ? "microphonePlusSystem"
      : "microphoneOnly";
  const {
    account,
    loading: accountLoading,
    refresh: refreshAccount,
    setAccount,
  } = useAccountStatus();
  const signInRequired = shouldBlockOnSignIn(account);
  const appBlocked = accountLoading || signInRequired;
  const selectedNote = state.selectedNote;
  const originFolder = originFolderId
    ? state.folders.find((folder) => folder.id === originFolderId)
    : undefined;
  const recoveriesByNote = useMemo(() => {
    const map = new Map<string, (typeof state.activeRecoveries)[number]>();
    for (const recovery of state.activeRecoveries) {
      // If multiple recoveries land on one note, the first one wins —
      // backend should only surface one per note in practice.
      if (!map.has(recovery.noteId)) map.set(recovery.noteId, recovery);
    }
    return map;
  }, [state.activeRecoveries]);
  const recoverableNoteIds = useMemo(
    () => new Set(recoveriesByNote.keys()),
    [recoveriesByNote],
  );
  const selectedRecovery = selectedNote
    ? recoveriesByNote.get(selectedNote.id)
    : undefined;

  function handleRecovery(sessionId: string, action: "validate" | "discard") {
    void recoverRecording(sessionId, action)
      .then((note) => {
        dispatch({ type: "noteUpdated", note });
        dispatch({ type: "recoveryRemoved", sessionId });
      })
      .catch((err: unknown) => setError(messageFromError(err)));
  }

  useEffect(() => {
    preloadRecordingSounds();
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listen<string>("dictation-event", (event) => {
      const helperEvent = parseDictationEvent(event.payload);
      if (!helperEvent) return;
      if (
        helperEvent.type !== "permission_status" &&
        helperEvent.type !== "dictation_diagnostics"
      ) {
        return;
      }
      const microphone = stringPayloadValue(helperEvent.payload?.microphone);
      const accessibility = stringPayloadValue(
        helperEvent.payload?.accessibility,
      );
      if (microphone) setMicrophoneStatus(microphone);
      if (accessibility) setAccessibilityStatus(accessibility);
    }).then((cleanup) => {
      unlisten = cleanup;
    });
    return () => {
      unlisten?.();
    };
  }, []);

  const accessibilityBlocked = isDeniedPermission(accessibilityStatus);
  // The Rust readiness check probes mic via cpal, which doesn't reflect
  // TCC denial. Trust the dictation helper's AVCaptureDevice status
  // instead — that's the authoritative macOS API for the mic privacy
  // entry.
  const microphoneBlocked = isDeniedPermission(microphoneStatus);

  useEffect(() => {
    if (appBlocked) return;
    bootstrapApp()
      .then(async (payload) => {
        const seeded = withFakeRecovery(payload);
        dispatch({ type: "bootstrapLoaded", payload: seeded.payload });
        if (seeded.fakeNote) {
          dispatch({ type: "noteLoaded", note: seeded.fakeNote });
          return;
        }
        const firstNoteId = seeded.payload.notes[0]?.id;
        if (firstNoteId) {
          const note = await getNote(firstNoteId);
          dispatch({ type: "noteLoaded", note });
        } else {
          setActiveView("settings");
        }
      })
      .catch((err: unknown) => setError(messageFromError(err)));
  }, [appBlocked]);

  // Probe with "microphonePlusSystem" on mount so sourceReadiness always
  // has the system source. The helper's preflight surfaces the native
  // TCC prompt on first install as a side-effect of this call.
  useEffect(() => {
    if (appBlocked) return;
    let cancelled = false;
    setCheckingSourceReadiness(true);
    checkRecordingSourceReadiness("microphonePlusSystem")
      .then((readiness) => {
        if (!cancelled) setSourceReadiness(readiness);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(messageFromError(err));
      })
      .finally(() => {
        if (!cancelled) setCheckingSourceReadiness(false);
      });
    // Eagerly request mic from the helper. This fires the native TCC
    // prompt for fresh installs (matching the system-audio eager prompt),
    // and for already-denied users it immediately emits the current
    // status so the mic-blocked strip renders without further user
    // action. For granted users it's a no-op.
    void dictationHelperCommand({
      type: "request_microphone_permission",
    }).catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [appBlocked]);

  // Refresh permission state whenever the app regains focus — covers the
  // common case where the user flipped a toggle in System Settings and
  // returns to OS Scribe. The helper poll is what surfaces fresh mic /
  // accessibility state via the dictation-event listener above.
  useEffect(() => {
    if (appBlocked) return;
    function refresh() {
      void checkRecordingSourceReadiness("microphonePlusSystem")
        .then(setSourceReadiness)
        .catch(() => undefined);
      void dictationHelperCommand({ type: "get_permission_status" }).catch(
        () => undefined,
      );
    }
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [appBlocked]);

  function handleSourceModeChange(next: RecordingSourceMode) {
    setUserWantsSystemAudio(next === "microphonePlusSystem");
  }

  // Explicit "Enable" action when system audio is denied. Sets intent on
  // (so the toggle auto-flips ON once permission is granted) and routes
  // the user to the System Settings pane.
  function handleEnableSystemAudio() {
    setUserWantsSystemAudio(true);
    void openPrivacySettings("systemAudio");
  }

  function handleEnableMicrophone() {
    void openPrivacySettings("microphone");
  }

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

  const handleCreateNote = useCallback(
    async (folderId?: string | null) => {
      try {
        const targetFolderId =
          folderId === null ? undefined : (folderId ?? state.selectedFolderId);
        const note = await createNote(targetFolderId);
        dispatch({ type: "noteLoaded", note });
        setActiveView("notes");
      } catch (err) {
        setError(messageFromError(err));
      }
    },
    [state.selectedFolderId],
  );

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (!isCreateNoteShortcut(event)) return;
      if (document.querySelector('[role="dialog"]')) return;
      event.preventDefault();
      void handleCreateNote(null);
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [handleCreateNote]);

  function handleSelectFolder(folderId?: string) {
    setFolderReturnTarget(undefined);
    dispatch({ type: "folderSelected", folderId });
  }

  async function handleReturnToNote(noteId: string) {
    if (state.selectedNoteId !== noteId) {
      await handleSelectNote(noteId);
    }
    setActiveView("notes");
    setFolderReturnTarget(undefined);
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
      throw err;
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

  // Single-folder semantics: a note belongs to at most one folder. Strip any
  // existing folder assignments before adding the target. Legacy notes with
  // multiple folders get normalized on the next move.
  async function handleSetNoteFolder(
    noteId: string,
    folderId: string,
    options?: { rethrow?: boolean },
  ) {
    const note = state.notes.find((n) => n.id === noteId);
    if (!note) return;
    if (note.folderIds.length === 1 && note.folderIds[0] === folderId) return;
    try {
      for (const existing of note.folderIds) {
        if (existing === folderId) continue;
        const updated = await removeNoteFromFolder(noteId, existing);
        dispatch({ type: "noteUpdated", note: updated });
      }
      if (!note.folderIds.includes(folderId)) {
        const updated = await assignNoteToFolder(noteId, folderId);
        dispatch({ type: "noteUpdated", note: updated });
      }
    } catch (err) {
      setError(messageFromError(err));
      if (options?.rethrow) throw err;
    }
  }

  async function handleSelectNote(noteId: string) {
    try {
      const note = await getNote(noteId);
      dispatch({ type: "noteLoaded", note });
      setOriginFolderId(undefined);
      setFolderReturnTarget(undefined);
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
        setFolderReturnTarget(undefined);
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
      setFolderReturnTarget(undefined);
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

      const micSource = readiness.sources.find(
        (source) => source.source === "microphone",
      );
      if (!micSource?.ready) {
        dispatch({ type: "recordingStatusCleared" });
        setError(micSource?.message ?? "Microphone is not ready.");
        return;
      }

      // System audio is optional. If the fresh probe shows it isn't
      // available, fall back to mic-only for this take — the derived
      // sourceMode will follow automatically next render via
      // setSourceReadiness above.
      const systemSource = readiness.sources.find(
        (source) => source.source === "system",
      );
      const effectiveMode: RecordingSourceMode =
        sourceMode === "microphonePlusSystem" && !systemSource?.ready
          ? "microphoneOnly"
          : sourceMode;

      const recording = await startRecording(selectedNote.id, effectiveMode);
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

  if (accountLoading) {
    return (
      <main className="account-gate-shell">
        <div
          className="titlebar-drag"
          aria-hidden
          data-tauri-drag-region
          onPointerDown={handleTitlebarPointerDown}
        />
        <div
          className="welcome-screen welcome-screen-loading"
          aria-label="Loading account"
        />
      </main>
    );
  }

  if (signInRequired) {
    return (
      <main className="account-gate-shell">
        <div
          className="titlebar-drag"
          aria-hidden
          data-tauri-drag-region
          onPointerDown={handleTitlebarPointerDown}
        />
        <AccountGate
          account={account}
          loading={accountLoading}
          onAccountChanged={setAccount}
        />
      </main>
    );
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
        onChangeView={(view) => {
          setActiveView(view);
          if (view === "folders") {
            setFolderReturnTarget(undefined);
            dispatch({ type: "folderSelected", folderId: undefined });
          }
          if (view !== "notes") {
            setOriginFolderId(undefined);
            setFolderReturnTarget(undefined);
          }
        }}
        onCreateFolder={() => {
          setActiveView("folders");
          setFolderReturnTarget(undefined);
          dispatch({ type: "folderSelected", folderId: undefined });
        }}
        onCreateNote={() => void handleCreateNote(null)}
        onSelectAll={() => handleSelectFolder(undefined)}
        onSelectFolder={(folderId) => handleSelectFolder(folderId)}
        onSelectNote={(noteId) => void handleSelectNote(noteId)}
        onDeleteNote={(noteId) => void handleDeleteNote(noteId)}
        onOpenMoveDialog={(noteId) => setMoveDialogNoteId(noteId)}
        onRemoveNoteFromFolder={(noteId, folderId) =>
          void handleRemoveNoteFromFolder(noteId, folderId)
        }
        recoverableNoteIds={recoverableNoteIds}
        collapsed={sidebarCollapsed}
        onToggleCollapsed={() => setSidebarCollapsed((value) => !value)}
      />
      <section className="main-panel">
        {accessibilityBlocked ? <PermissionBanner /> : null}
        <div className="main-panel-body">
          {error ? <p className="error-banner">{error}</p> : null}
          <div className="workspace">
            {activeView === "settings" ? (
              <AppSettings
                account={account}
                accountLoading={accountLoading}
                sourceMode={sourceMode}
                sourceReadiness={sourceReadiness}
                checkingSourceReadiness={checkingSourceReadiness}
                onAccountChanged={setAccount}
                onAccountRefresh={refreshAccount}
                onSourceModeChange={handleSourceModeChange}
                onEnableSystemAudio={handleEnableSystemAudio}
              />
            ) : activeView === "dictation" ? (
              <DictationHistoryView />
            ) : activeView === "all-notes" ? (
              <NotesList
                notes={state.notes}
                selectedNoteId={state.selectedNoteId}
                onSelectNote={(noteId) =>
                  void handleSelectNote(noteId).then(() =>
                    setActiveView("notes"),
                  )
                }
                onCreateNote={() => void handleCreateNote(null)}
              />
            ) : activeView === "folders" ? (
              <FoldersWorkspace
                folders={state.folders}
                notes={state.notes}
                selectedFolderId={state.selectedFolderId}
                folderBackTarget={
                  folderReturnTarget
                    ? {
                        label: `Back to ${folderReturnTarget.label}`,
                        onBack: () =>
                          void handleReturnToNote(folderReturnTarget.noteId),
                      }
                    : undefined
                }
                onSelectFolder={(folderId) => handleSelectFolder(folderId)}
                onCreateFolder={(name, description) =>
                  handleCreateFolder(name, description)
                }
                onRenameFolder={(folderId, name, description) =>
                  void handleRenameFolder(folderId, name, description)
                }
                onDeleteFolder={(folderId) => handleDeleteFolder(folderId)}
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
                  handleSetNoteFolder(noteId, folderId, { rethrow: true })
                }
                onRemoveNoteFromFolder={(noteId, folderId) =>
                  void handleRemoveNoteFromFolder(noteId, folderId)
                }
                onOpenMoveDialog={(noteId) => setMoveDialogNoteId(noteId)}
                onDeleteNote={(noteId) => void handleDeleteNote(noteId)}
              />
            ) : selectedNote ? (
              <div className="note-shell">
                {originFolder ? (
                  <BreadcrumbBar
                    backLabel={`Back to ${originFolder.name}`}
                    onBack={() => {
                      setActiveView("folders");
                      dispatch({
                        type: "folderSelected",
                        folderId: originFolder.id,
                      });
                      setOriginFolderId(undefined);
                    }}
                    items={[
                      {
                        label: originFolder.name,
                        onClick: () => {
                          setActiveView("folders");
                          dispatch({
                            type: "folderSelected",
                            folderId: originFolder.id,
                          });
                          setOriginFolderId(undefined);
                        },
                      },
                      { label: selectedNote.title.trim() || "New note" },
                    ]}
                  />
                ) : null}
                <NoteEditor
                  note={selectedNote}
                  folders={state.folders}
                  recordingStatus={state.recordingStatus}
                  sourceMode={sourceMode}
                  sourceReadiness={sourceReadiness}
                  recovery={selectedRecovery}
                  onRecoverRecording={(sessionId) =>
                    handleRecovery(sessionId, "validate")
                  }
                  onDiscardRecording={(sessionId) =>
                    handleRecovery(sessionId, "discard")
                  }
                  onTitleChange={(title) => void handleUpdateNote({ title })}
                  onContentChange={(sourceNoteId, editedContent) => {
                    // Blur fired by an editor that was already torn
                    // down on note-switch — ignore so we don't write
                    // the old note's content into the new selectedNote.
                    if (sourceNoteId !== selectedNote.id) return;
                    void handleUpdateNote({ editedContent });
                  }}
                  onSourceModeChange={handleSourceModeChange}
                  onEnableSystemAudio={handleEnableSystemAudio}
                  onEnableMicrophone={handleEnableMicrophone}
                  microphoneBlocked={microphoneBlocked}
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
                  onRetry={async () => {
                    if (!selectedNote) return;
                    const note = await retryProcessing(selectedNote.id);
                    dispatch({ type: "noteUpdated", note });
                  }}
                  onTopUp={() =>
                    void osAccountsTopUp().catch((err: unknown) =>
                      setError(messageFromError(err)),
                    )
                  }
                  onAssignFolder={(folderId) =>
                    void handleSetNoteFolder(selectedNote.id, folderId)
                  }
                  onRemoveFolder={(folderId) =>
                    void handleRemoveNoteFromFolder(selectedNote.id, folderId)
                  }
                  onNavigateToFolder={(folderId) => {
                    setActiveView("folders");
                    dispatch({ type: "folderSelected", folderId });
                    setFolderReturnTarget({
                      noteId: selectedNote.id,
                      label: selectedNote.title.trim() || "New note",
                    });
                    setOriginFolderId(undefined);
                  }}
                  onCreateAndAssignFolder={(name) => {
                    void (async () => {
                      const folder = await handleCreateFolder(name);
                      if (folder) {
                        await handleSetNoteFolder(selectedNote.id, folder.id);
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
                  onClick={() => void handleCreateNote(null)}
                >
                  New note
                </button>
              </section>
            )}
          </div>
        </div>
      </section>
      <MoveNoteToFolderDialog
        open={moveDialogNoteId !== null}
        onClose={() => setMoveDialogNoteId(null)}
        note={
          moveDialogNoteId
            ? (state.notes.find((n) => n.id === moveDialogNoteId) ?? null)
            : null
        }
        folders={state.folders}
        onSetFolder={(noteId, folderId) =>
          handleSetNoteFolder(noteId, folderId)
        }
      />
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

function isDeniedPermission(state?: string) {
  return state === "denied" || state === "restricted";
}

function isCreateNoteShortcut(event: KeyboardEvent) {
  return (
    event.key.toLowerCase() === "n" &&
    event.metaKey &&
    !event.ctrlKey &&
    !event.altKey &&
    !event.shiftKey
  );
}

function parseDictationEvent(
  payload: unknown,
): DictationHelperEvent | undefined {
  try {
    if (typeof payload === "string") {
      return JSON.parse(payload) as DictationHelperEvent;
    }
    if (payload && typeof payload === "object") {
      return payload as DictationHelperEvent;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function stringPayloadValue(value: unknown) {
  return typeof value === "string" ? value : undefined;
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

// Dev-only helper: pass `?fake-recovery=1` in the URL to inject a fake
// recoverable recording so the inline recovery prompt can be iterated
// on without crashing a real recording. No-op in production builds.
function withFakeRecovery(payload: BootstrapResponse): {
  payload: BootstrapResponse;
  fakeNote?: NoteDto;
} {
  if (!import.meta.env.DEV) return { payload };
  let enabled = false;
  try {
    enabled =
      new URLSearchParams(window.location.search).get("fake-recovery") ===
        "1" ||
      window.location.hash.toLowerCase() === "#fake-recovery" ||
      localStorage.getItem("os-scribe:dev:fake-recovery") === "1";
  } catch {
    return { payload };
  }
  if (!enabled) return { payload };

  const noteId = "fake-recovery-note";
  const sessionId = "fake-recovery-session";
  const now = new Date().toISOString();
  const fakeListItem = {
    id: noteId,
    title: "Team sync",
    preview: "Recovered from an interrupted recording",
    processingStatus: "recoverable" as const,
    folderIds: [],
    createdAt: now,
    updatedAt: now,
  };
  const fakeNote: NoteDto = {
    ...fakeListItem,
    generatedContent: "",
    editedContent: "",
  };
  return {
    payload: {
      ...payload,
      notes: [fakeListItem, ...payload.notes],
      activeRecoveries: [
        {
          sessionId,
          noteId,
          sourceMode: "microphonePlusSystem",
          startedAt: now,
          partialPathPresent: true,
          finalPathPresent: false,
          bytesFound: 2_400_000,
          sources: [
            {
              source: "microphone",
              partialPathPresent: true,
              finalPathPresent: false,
              bytesFound: 1_200_000,
            },
            {
              source: "system",
              partialPathPresent: true,
              finalPathPresent: false,
              bytesFound: 1_200_000,
            },
          ],
        },
        ...payload.activeRecoveries,
      ],
    },
    fakeNote,
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
