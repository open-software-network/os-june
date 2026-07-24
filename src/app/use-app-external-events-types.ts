import type { SidebarView } from "../components/sidebar/Sidebar";
import type { AgentSessionDto } from "../lib/agent-runtime-contract";
import type * as React from "react";

export type UseAppExternalEventsDependencies = {
  agentMenuBarSessionsRef: React.MutableRefObject<AgentSessionDto[]>;
  setActiveAgentSession: (session: AgentSessionDto | undefined) => void;
  setActiveView: React.Dispatch<React.SetStateAction<SidebarView>>;
  setAgentOrigin: React.Dispatch<
    React.SetStateAction<{ kind: "project"; folderId: string } | { kind: "routines" } | undefined>
  >;
};
