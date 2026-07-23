import { type SidebarView } from "../components/sidebar/Sidebar";
import { type Tab } from "./tabs/tabs";
import { type SessionProfileMap } from "../lib/session-profile-filter";
import type { HermesSessionInfo } from "../lib/tauri";
import type { NotesAction } from "./state/app-state";
import type * as React from "react";

export type UseActiveProfileDataDependencies = {
  activeHermesProfileName: string;
  activeViewRef: React.MutableRefObject<SidebarView>;
  appBlocked: boolean;
  bootstrapped: boolean;
  commitAgentSessions: (
    sessions: readonly HermesSessionInfo[],
    profiles?: SessionProfileMap,
  ) => void;
  crossProfileRecordingNoteIdRef: React.MutableRefObject<string | undefined>;
  dispatch: React.Dispatch<NotesAction>;
  lastDataProfileRef: React.MutableRefObject<string | undefined>;
  lastProfileDataRefreshRevisionRef: React.MutableRefObject<number>;
  pendingSessionProjectRef: React.MutableRefObject<{
    folderId: string;
    knownSessionIds: Set<string>;
    profile: string;
  } | null>;
  profileDataRefreshRevision: number;
  recordingNoteIdRef: React.MutableRefObject<string | undefined>;
  refreshSessionProfiles: () => Promise<SessionProfileMap>;
  setActiveAgentSession: (session: HermesSessionInfo | undefined) => void;
  setActiveView: React.Dispatch<React.SetStateAction<SidebarView>>;
  setAgentOrigin: React.Dispatch<
    React.SetStateAction<{ kind: "project"; folderId: string } | { kind: "routines" } | undefined>
  >;
  setError: React.Dispatch<React.SetStateAction<string | null>>;
  setFolderReturnTarget: React.Dispatch<
    React.SetStateAction<{ noteId: string; label: string } | undefined>
  >;
  setOriginAllNotes: React.Dispatch<React.SetStateAction<boolean>>;
  setOriginFolderId: React.Dispatch<React.SetStateAction<string | undefined>>;
  setTabs: React.Dispatch<React.SetStateAction<Tab[]>>;
  tabsRef: React.MutableRefObject<Tab[]>;
};
