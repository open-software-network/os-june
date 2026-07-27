import type { SidebarView } from "../components/sidebar/Sidebar";
import type { Tab } from "./tabs/tabs";
import type { SessionPartitionMap } from "../lib/session-partition-filter";
import type { AgentSessionDto } from "../lib/agent-runtime-contract";
import type { NotesAction } from "./state/app-state";
import type * as React from "react";

export type UseDataPartitionRefreshDependencies = {
  currentDataPartitionName: string;
  activeViewRef: React.MutableRefObject<SidebarView>;
  appBlocked: boolean;
  bootstrapped: boolean;
  commitAgentSessions: (
    sessions: readonly AgentSessionDto[],
    partitions?: SessionPartitionMap,
  ) => void;
  crossPartitionRecordingNoteIdRef: React.MutableRefObject<string | undefined>;
  dispatch: React.Dispatch<NotesAction>;
  lastDataPartitionRef: React.MutableRefObject<string | undefined>;
  lastDataPartitionRefreshRevisionRef: React.MutableRefObject<number>;
  pendingSessionProjectRef: React.MutableRefObject<{
    folderId: string;
    knownSessionIds: Set<string>;
    partition: string;
  } | null>;
  dataPartitionRefreshRevision: number;
  recordingNoteIdRef: React.MutableRefObject<string | undefined>;
  refreshSessionPartitions: () => Promise<SessionPartitionMap>;
  setActiveAgentSession: (session: AgentSessionDto | undefined) => void;
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
