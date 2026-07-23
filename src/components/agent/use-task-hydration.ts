import { useEffect } from "react";
import { getAgentTask } from "../../lib/tauri";
import { describeHermesError } from "../../lib/errors";
import { reportableAgentErrorOptions } from "./agent-workspace-errors";
import type { UseTaskHydrationDependencies } from "./use-task-hydration-types";

export function useTaskHydration(dependencies: UseTaskHydrationDependencies) {
  const { hydratedTaskIdsRef, selectedTaskId, setError, setTasks, taskHistoryLoadedIdsRef, tasks } =
    dependencies;

  useEffect(() => {
    if (!selectedTaskId) return;
    const task = tasks.find((item) => item.id === selectedTaskId);
    if (!task || task.messages.length || task.toolEvents.length) return;
    if (hydratedTaskIdsRef.current.has(selectedTaskId)) return;
    hydratedTaskIdsRef.current.add(selectedTaskId);
    let cancelled = false;
    getAgentTask(selectedTaskId)
      .then((fullTask) => {
        if (!cancelled) {
          taskHistoryLoadedIdsRef.current.add(fullTask.id);
          setTasks((current) => current.map((item) => (item.id === fullTask.id ? fullTask : item)));
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(describeHermesError(err), reportableAgentErrorOptions(err));
      });
    return () => {
      cancelled = true;
    };
  }, [selectedTaskId, tasks]);
}
