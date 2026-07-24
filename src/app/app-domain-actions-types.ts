import type { SidebarView } from "../components/sidebar/Sidebar";
import type { HermesSessionInfo } from "../lib/tauri";
import type { NoteSaveController } from "./note-save-controller";
import type { NotesAction, NotesState } from "./state/app-state";
import type * as React from "react";

export type CreateAppDomainActionsDependencies = {
  agentSessions: HermesSessionInfo[];
  completedSessions: Record<string, string>;
  dispatch: React.Dispatch<NotesAction>;
  noteSaveController: NoteSaveController;
  pendingSessionProjectRef: React.MutableRefObject<{
    folderId: string;
    knownSessionIds: Set<string>;
    profile: string;
  } | null>;
  sessionCompletionTouchedRef: React.MutableRefObject<Set<string>>;
  sessionCompletionWritesRef: React.MutableRefObject<Map<string, Promise<unknown>>>;
  sessionFolders: Record<string, string[]>;
  setActiveAgentSession: (session: HermesSessionInfo | undefined) => void;
  setActiveView: React.Dispatch<React.SetStateAction<SidebarView>>;
  setAgentOrigin: React.Dispatch<
    React.SetStateAction<{ kind: "project"; folderId: string } | { kind: "routines" } | undefined>
  >;
  setCompletedSessions: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  setError: React.Dispatch<React.SetStateAction<string | null>>;
  setSessionFolders: React.Dispatch<React.SetStateAction<Record<string, string[]>>>;
  state: NotesState;
};
