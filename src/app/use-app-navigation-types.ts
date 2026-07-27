import type { SidebarView } from "../components/sidebar/Sidebar";
import type { Tab, TabNav } from "./tabs/tabs";
import type { AgentSessionDto } from "../lib/agent-runtime-contract";
import type { NotesAction, NotesState } from "./state/app-state";
import type * as React from "react";

export type UseAppNavigationDependencies = {
  activeAgentSessionId: string | undefined;
  activeAgentSessionSeed: AgentSessionDto | undefined;
  activeTabId: string;
  activeTabIdRef: React.MutableRefObject<string>;
  activeView: SidebarView;
  activeViewRef: React.MutableRefObject<SidebarView>;
  agentOrigin: { kind: "project"; folderId: string } | { kind: "routines" } | undefined;
  agentSessions: AgentSessionDto[];
  dispatch: React.Dispatch<NotesAction>;
  originAllNotes: boolean;
  originFolderId: string | undefined;
  pendingSessionProjectRef: React.MutableRefObject<{
    folderId: string;
    knownSessionIds: Set<string>;
    partition: string;
  } | null>;
  restoreTargetRef: React.MutableRefObject<TabNav | null>;
  selectedNoteId: string | undefined;
  setActiveAgentSession: (session: AgentSessionDto | undefined) => void;
  setActiveAgentSessionId: React.Dispatch<React.SetStateAction<string | undefined>>;
  setActiveAgentSessionSeed: React.Dispatch<React.SetStateAction<AgentSessionDto | undefined>>;
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
