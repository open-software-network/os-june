import { type SidebarView } from "../components/sidebar/Sidebar";
import { type Tab, type TabNav } from "./tabs/tabs";
import type { HermesSessionInfo } from "../lib/tauri";
import type { NotesAction, NotesState } from "./state/app-state";
import type * as React from "react";

export type UseAppNavigationDependencies = {
  activeAgentSessionId: string | undefined;
  activeAgentSessionSeed: HermesSessionInfo | undefined;
  activeTabId: string;
  activeTabIdRef: React.MutableRefObject<string>;
  activeView: SidebarView;
  activeViewRef: React.MutableRefObject<SidebarView>;
  agentOrigin: { kind: "project"; folderId: string } | { kind: "routines" } | undefined;
  agentSessions: HermesSessionInfo[];
  dispatch: React.Dispatch<NotesAction>;
  originAllNotes: boolean;
  originFolderId: string | undefined;
  pendingSessionProjectRef: React.MutableRefObject<{
    folderId: string;
    knownSessionIds: Set<string>;
    profile: string;
  } | null>;
  restoreTargetRef: React.MutableRefObject<TabNav | null>;
  selectedNoteId: string | undefined;
  setActiveAgentSession: (session: HermesSessionInfo | undefined) => void;
  setActiveAgentSessionId: React.Dispatch<React.SetStateAction<string | undefined>>;
  setActiveAgentSessionSeed: React.Dispatch<React.SetStateAction<HermesSessionInfo | undefined>>;
  setActiveTabId: React.Dispatch<React.SetStateAction<string>>;
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
  setSettingsReturnView: React.Dispatch<React.SetStateAction<SidebarView>>;
  setTabs: React.Dispatch<React.SetStateAction<Tab[]>>;
  state: NotesState;
  tabs: Tab[];
  tabsRef: React.MutableRefObject<Tab[]>;
};
