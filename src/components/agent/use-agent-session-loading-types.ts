import {
  type AgentTaskDto,
  type HermesBridgeStatus,
  type HermesSessionInfo,
  type HermesSessionMessage,
} from "../../lib/tauri";
import type { ActiveHermesProfile } from "../../lib/active-hermes-profile";
import type * as React from "react";
import type { AgentWorkspaceErrorOptions } from "./agent-workspace-errors";

export type UseAgentSessionLoadingDependencies = {
  activeHermesProfile: ActiveHermesProfile;
  applySessionTitleOverrides: (sessions: HermesSessionInfo[]) => HermesSessionInfo[];
  bridge: HermesBridgeStatus;
  defaultGenerationModelIdRef: React.MutableRefObject<string>;
  hermesSessionItemsRef: React.MutableRefObject<HermesSessionInfo[]>;
  hermesSessionsHydratedRef: React.MutableRefObject<boolean>;
  newSessionModeRef: React.MutableRefObject<boolean>;
  pendingHermesMessagesRef: React.MutableRefObject<Record<string, HermesSessionMessage[]>>;
  profileOwnedSessionIdsRef: React.MutableRefObject<Set<string>>;
  restoredHermesSessionIdRef: React.MutableRefObject<string | undefined>;
  selectedHermesSessionIdRef: React.MutableRefObject<string | undefined>;
  selectedTask: AgentTaskDto | undefined;
  setError: (message: string | null, options?: AgentWorkspaceErrorOptions) => void;
  setHermesSessionItems: React.Dispatch<React.SetStateAction<HermesSessionInfo[]>>;
  setHermesSessionsHydrated: React.Dispatch<React.SetStateAction<boolean>>;
  setHermesSessionsLoading: React.Dispatch<React.SetStateAction<boolean>>;
  setLoading: React.Dispatch<React.SetStateAction<boolean>>;
  setSelectedHermesSessionId: React.Dispatch<React.SetStateAction<string | undefined>>;
  setSelectedTaskId: React.Dispatch<React.SetStateAction<string | undefined>>;
  setTasks: React.Dispatch<React.SetStateAction<AgentTaskDto[]>>;
  waitingSessionIdsRef: React.MutableRefObject<Set<string>>;
  workingSessionIdsRef: React.MutableRefObject<Set<string>>;
};
