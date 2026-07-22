import { type SidebarView } from "../components/sidebar/Sidebar";
import type { HermesSessionInfo } from "../lib/tauri";
import type * as React from "react";

export type UseAppExternalEventsDependencies = {
  agentMenuBarSessionsRef: React.MutableRefObject<HermesSessionInfo[]>;
  setActiveAgentSession: (session: HermesSessionInfo | undefined) => void;
  setActiveView: React.Dispatch<React.SetStateAction<SidebarView>>;
  setAgentOrigin: React.Dispatch<
    React.SetStateAction<{ kind: "project"; folderId: string } | { kind: "routines" } | undefined>
  >;
};
