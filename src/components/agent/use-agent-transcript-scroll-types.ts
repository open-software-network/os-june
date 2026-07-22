import { type AgentTaskDto, type HermesSessionMessage } from "../../lib/tauri";
import type * as React from "react";

export type UseAgentTranscriptScrollDependencies = {
  agentScrollRef: React.MutableRefObject<HTMLDivElement | null>;
  composerClearance: number;
  hermesSessionMessages: Record<string, HermesSessionMessage[]>;
  hermesSessionsHydrated: boolean;
  hermesSessionsLoading: boolean;
  heroMode: boolean;
  listRef: React.MutableRefObject<HTMLDivElement | null>;
  renderedTurnsSignature: number;
  selectedHermesSessionId: string | undefined;
  selectedTask: AgentTaskDto | undefined;
  selectedTaskId: string | undefined;
  taskHistoryLoadedIdsRef: React.MutableRefObject<Set<string>>;
};
