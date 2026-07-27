import type { SidebarView } from "../components/sidebar/Sidebar";
import type { AgentSessionStatusDetail } from "../lib/agent-events";
import type { SessionPartitionMap } from "../lib/session-partition-filter";
import type { AgentSessionDto } from "../lib/agent-runtime-contract";
import type * as React from "react";

export type UseAgentSessionSyncDependencies = {
  activeViewRef: React.MutableRefObject<SidebarView>;
  agentMenuBarLastStatusRef: React.MutableRefObject<AgentSessionStatusDetail | undefined>;
  agentMenuBarSessionsRef: React.MutableRefObject<AgentSessionDto[]>;
  agentMenuBarWaitingSessionIdsRef: React.MutableRefObject<Set<string>>;
  agentMenuBarWorkingSessionIdsRef: React.MutableRefObject<Set<string>>;
  commitAgentSessions: (
    sessions: readonly AgentSessionDto[],
    partitions?: SessionPartitionMap,
  ) => void;
  pendingSessionProjectRef: React.MutableRefObject<{
    folderId: string;
    knownSessionIds: Set<string>;
    partition: string;
  } | null>;
  publishAgentMenuBarState: () => void;
  refreshSessionPartitions: () => Promise<SessionPartitionMap>;
  setActiveAgentSession: (session: AgentSessionDto | undefined) => void;
  setActiveAgentSessionId: React.Dispatch<React.SetStateAction<string | undefined>>;
  setActiveAgentSessionSeed: React.Dispatch<React.SetStateAction<AgentSessionDto | undefined>>;
  setAgentOrigin: React.Dispatch<
    React.SetStateAction<{ kind: "project"; folderId: string } | { kind: "routines" } | undefined>
  >;
  setAgentSessions: React.Dispatch<React.SetStateAction<AgentSessionDto[]>>;
  setAgentWaitingSessionIds: React.Dispatch<React.SetStateAction<ReadonlySet<string>>>;
  setAgentWorkingSessionIds: React.Dispatch<React.SetStateAction<ReadonlySet<string>>>;
  setSessionFolders: React.Dispatch<React.SetStateAction<Record<string, string[]>>>;
};
