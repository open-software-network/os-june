import { type SidebarView } from "../components/sidebar/Sidebar";
import { type SessionProfileMap } from "../lib/session-profile-filter";
import type { HermesSessionInfo } from "../lib/tauri";
import type * as React from "react";

export type UseAgentMenuEventsDependencies = {
  agentMenuBarSessionsRef: React.MutableRefObject<HermesSessionInfo[]>;
  handleAgentHudVisibilityRequest: (enabled: boolean) => void;
  pendingSessionProjectRef: React.MutableRefObject<{
    folderId: string;
    knownSessionIds: Set<string>;
    profile: string;
  } | null>;
  profileScopedAgentSessions: (
    sessions: readonly HermesSessionInfo[],
    profiles?: SessionProfileMap,
  ) => HermesSessionInfo[];
  publishAgentMenuBarState: () => void;
  refreshSessionProfiles: () => Promise<SessionProfileMap>;
  setActiveAgentSession: (session: HermesSessionInfo | undefined) => void;
  setActiveAgentSessionId: React.Dispatch<React.SetStateAction<string | undefined>>;
  setActiveAgentSessionSeed: React.Dispatch<React.SetStateAction<HermesSessionInfo | undefined>>;
  setActiveView: React.Dispatch<React.SetStateAction<SidebarView>>;
  setAgentOrigin: React.Dispatch<
    React.SetStateAction<{ kind: "project"; folderId: string } | { kind: "routines" } | undefined>
  >;
};
