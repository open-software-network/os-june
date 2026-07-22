import { useEffect } from "react";
import { invalidateNoteTabs } from "./tabs/tabs";
import { getNote, listFolders, listNotes } from "../lib/tauri";
import { messageFromError } from "../lib/errors";
import { listHermesSessions } from "../lib/hermes-adapter";
import type { UseActiveProfileDataDependencies } from "./use-active-profile-data-types";

export function useActiveProfileData(dependencies: UseActiveProfileDataDependencies) {
  const {
    activeHermesProfileName,
    activeViewRef,
    appBlocked,
    bootstrapped,
    commitAgentSessions,
    crossProfileRecordingNoteIdRef,
    dispatch,
    lastDataProfileRef,
    lastProfileDataRefreshRevisionRef,
    pendingSessionProjectRef,
    profileDataRefreshRevision,
    recordingNoteIdRef,
    refreshSessionProfiles,
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
    const previous = lastDataProfileRef.current;
    const profileChanged = previous !== undefined && previous !== activeHermesProfileName;
    const refreshRequested =
      lastProfileDataRefreshRevisionRef.current !== profileDataRefreshRevision;
    lastDataProfileRef.current = activeHermesProfileName;
    lastProfileDataRefreshRevisionRef.current = profileDataRefreshRevision;
    if (!refreshRequested && (previous === undefined || previous === activeHermesProfileName)) {
      return;
    }
    // A project-scoped new-session request belongs to the profile that started
    // it. Clear the handoff before any async reload can race a session-created
    // event from the newly active profile.
    if (profileChanged) pendingSessionProjectRef.current = null;
    let cancelled = false;
    void (async () => {
      try {
        const [notesResponse, folders, sessions, profiles] = await Promise.all([
          listNotes(),
          listFolders(),
          listHermesSessions({ limit: 100 }),
          refreshSessionProfiles(),
        ]);
        if (cancelled) return;
        commitAgentSessions(sessions, profiles);
        const visibleNoteIds = new Set(notesResponse.items.map((note) => note.id));
        const recordingNoteId = recordingNoteIdRef.current;
        crossProfileRecordingNoteIdRef.current =
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
        // The old profile's folder selection and origins point at rows the
        // new profile can't see — clear them before the new lists land.
        dispatch({ type: "folderSelected", folderId: undefined });
        dispatch({ type: "foldersLoaded", folders });
        dispatch({ type: "notesLoaded", notes: notesResponse.items });
        setOriginFolderId(undefined);
        setOriginAllNotes(false);
        setFolderReturnTarget(undefined);
        // The open chat came from the old profile's list; keeping it selected
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
    activeHermesProfileName,
    appBlocked,
    bootstrapped,
    commitAgentSessions,
    profileDataRefreshRevision,
    refreshSessionProfiles,
    setActiveAgentSession,
  ]);
}
