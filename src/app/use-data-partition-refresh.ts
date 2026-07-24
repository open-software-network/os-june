import { useEffect } from "react";
import { invalidateNoteTabs } from "./tabs/tabs";
import { getNote, listAgentSessions, listFolders, listNotes } from "../lib/tauri";
import { messageFromError } from "../lib/errors";
import type { UseDataPartitionRefreshDependencies } from "./use-data-partition-refresh-types";

export function useDataPartitionRefresh(dependencies: UseDataPartitionRefreshDependencies) {
  const {
    currentDataPartitionName,
    activeViewRef,
    appBlocked,
    bootstrapped,
    commitAgentSessions,
    crossPartitionRecordingNoteIdRef,
    dispatch,
    lastDataPartitionRef,
    lastDataPartitionRefreshRevisionRef,
    pendingSessionProjectRef,
    dataPartitionRefreshRevision,
    recordingNoteIdRef,
    refreshSessionPartitions,
    setActiveAgentSession,
    setActiveView,
    setAgentOrigin,
    setError,
    setFolderReturnTarget,
    setOriginAllNotes,
    setOriginFolderId,
    setTabs,
    tabsRef,
  } = dependencies;

  useEffect(() => {
    if (appBlocked || !bootstrapped) return;
    const previous = lastDataPartitionRef.current;
    const partitionChanged = previous !== undefined && previous !== currentDataPartitionName;
    const refreshRequested =
      lastDataPartitionRefreshRevisionRef.current !== dataPartitionRefreshRevision;
    lastDataPartitionRef.current = currentDataPartitionName;
    lastDataPartitionRefreshRevisionRef.current = dataPartitionRefreshRevision;
    if (!refreshRequested && (previous === undefined || previous === currentDataPartitionName)) {
      return;
    }
    // A project-scoped new-session request belongs to the data partition that started
    // it. Clear the handoff before any async reload can race a session-created
    // event from the newly selected data partition.
    if (partitionChanged) pendingSessionProjectRef.current = null;
    let cancelled = false;
    void (async () => {
      try {
        const [notesResponse, folders, sessions, partitions] = await Promise.all([
          listNotes(),
          listFolders(),
          listAgentSessions(),
          refreshSessionPartitions(),
        ]);
        if (cancelled) return;
        commitAgentSessions(sessions, partitions);
        const visibleNoteIds = new Set(notesResponse.items.map((note) => note.id));
        const recordingNoteId = recordingNoteIdRef.current;
        crossPartitionRecordingNoteIdRef.current =
          recordingNoteId && !visibleNoteIds.has(recordingNoteId) ? recordingNoteId : undefined;
        const invalidNoteIds = new Set<string>();
        for (const tab of tabsRef.current) {
          const noteId = tab.nav.view === "meetings" ? tab.nav.noteId : undefined;
          if (noteId && noteId !== recordingNoteId && !visibleNoteIds.has(noteId)) {
            invalidNoteIds.add(noteId);
          }
        }
        const nextTabs = invalidateNoteTabs(tabsRef.current, invalidNoteIds);
        if (nextTabs !== tabsRef.current) {
          tabsRef.current = nextTabs;
          setTabs(nextTabs);
        }
        // The previous partition's folder selection and origins point at rows
        // the new partition cannot see. Clear them before the new lists land.
        dispatch({ type: "folderSelected", folderId: undefined });
        dispatch({ type: "foldersLoaded", folders });
        dispatch({ type: "notesLoaded", notes: notesResponse.items });
        setOriginFolderId(undefined);
        setOriginAllNotes(false);
        setFolderReturnTarget(undefined);
        // The open chat came from the previous partition's list. Keeping it selected
        // would reopen it (workspace re-applies initialSessionId on mount).
        setActiveAgentSession(undefined);
        setAgentOrigin(undefined);
        const nextNoteId = recordingNoteIdRef.current ?? notesResponse.items[0]?.id;
        if (nextNoteId) {
          const note = await getNote(nextNoteId);
          if (!cancelled) dispatch({ type: "noteLoaded", note });
        } else if (!cancelled) {
          const currentView = activeViewRef.current;
          if (currentView === "meetings" || currentView === "all-notes") {
            setActiveView("notes");
          }
        }
      } catch (err) {
        if (!cancelled) setError(messageFromError(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    currentDataPartitionName,
    appBlocked,
    bootstrapped,
    commitAgentSessions,
    dataPartitionRefreshRevision,
    refreshSessionPartitions,
    setActiveAgentSession,
  ]);
}
