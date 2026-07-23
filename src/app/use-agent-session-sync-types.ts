import { type SidebarView } from "../components/sidebar/Sidebar";
import { type AgentSessionStatusDetail } from "../lib/agent-events";
import { type SessionProfileMap } from "../lib/session-profile-filter";
import type { HermesSessionInfo } from "../lib/tauri";
import type * as React from "react";

export type UseAgentSessionSyncDependencies = {
  activeViewRef: React.MutableRefObject<SidebarView>;
  agentMenuBarLastStatusRef: React.MutableRefObject<AgentSessionStatusDetail | undefined>;
  agentMenuBarSessionsRef: React.MutableRefObject<HermesSessionInfo[]>;
  agentMenuBarWaitingSessionIdsRef: React.MutableRefObject<Set<string>>;
  agentMenuBarWorkingSessionIdsRef: React.MutableRefObject<Set<string>>;
  commitAgentSessions: (
    sessions: readonly HermesSessionInfo[],
    profiles?: SessionProfileMap,
  ) => void;
  pendingSessionProjectRef: React.MutableRefObject<{
    folderId: string;
    knownSessionIds: Set<string>;
    profile: string;
  } | null>;
  publishAgentMenuBarState: () => void;
  refreshSessionProfiles: () => Promise<SessionProfileMap>;
  setActiveAgentSession: (session: HermesSessionInfo | undefined) => void;
  setActiveAgentSessionId: React.Dispatch<React.SetStateAction<string | undefined>>;
  setActiveAgentSessionSeed: React.Dispatch<React.SetStateAction<HermesSessionInfo | undefined>>;
  setAgentOrigin: React.Dispatch<
    React.SetStateAction<{ kind: "project"; folderId: string } | { kind: "routines" } | undefined>
  >;
  setAgentSessions: React.Dispatch<React.SetStateAction<HermesSessionInfo[]>>;
  setAgentWaitingSessionIds: React.Dispatch<React.SetStateAction<ReadonlySet<string>>>;
  setAgentWorkingSessionIds: React.Dispatch<React.SetStateAction<ReadonlySet<string>>>;
  setSessionFolders: React.Dispatch<React.SetStateAction<Record<string, string[]>>>;
};
