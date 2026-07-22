import type * as React from "react";
import type { AgentTaskDto } from "../../lib/tauri";
import type { AgentWorkspaceErrorOptions } from "./agent-workspace-errors";

export type UseTaskHydrationDependencies = {
  hydratedTaskIdsRef: React.MutableRefObject<Set<string>>;
  selectedTaskId: string | undefined;
  setError: (message: string | null, options?: AgentWorkspaceErrorOptions) => void;
  setTasks: React.Dispatch<React.SetStateAction<AgentTaskDto[]>>;
  taskHistoryLoadedIdsRef: React.MutableRefObject<Set<string>>;
  tasks: AgentTaskDto[];
};
