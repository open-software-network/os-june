import type { SidebarView } from "../components/sidebar/Sidebar";
import type { SessionProfileMap } from "../lib/session-profile-filter";
import type { AgentSessionDto } from "../lib/agent-runtime-contract";
import type * as React from "react";

export type UseAgentMenuEventsDependencies = {
  agentMenuBarSessionsRef: React.MutableRefObject<AgentSessionDto[]>;
  handleAgentHudVisibilityRequest: (enabled: boolean) => void;
  pendingSessionProjectRef: React.MutableRefObject<{
    folderId: string;
    knownSessionIds: Set<string>;
    profile: string;
  } | null>;
  profileScopedAgentSessions: (
    sessions: readonly AgentSessionDto[],
    profiles?: SessionProfileMap,
  ) => AgentSessionDto[];
  publishAgentMenuBarState: () => void;
  refreshSessionProfiles: () => Promise<SessionProfileMap>;
  setActiveAgentSession: (session: AgentSessionDto | undefined) => void;
  setActiveAgentSessionId: React.Dispatch<React.SetStateAction<string | undefined>>;
  setActiveAgentSessionSeed: React.Dispatch<React.SetStateAction<AgentSessionDto | undefined>>;
  setActiveView: React.Dispatch<React.SetStateAction<SidebarView>>;
  setAgentOrigin: React.Dispatch<
    React.SetStateAction<{ kind: "project"; folderId: string } | { kind: "routines" } | undefined>
  >;
};
