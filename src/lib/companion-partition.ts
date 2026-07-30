import { getCurrentDataPartitionName } from "./data-partition";
import {
  filterAgentSessionsForDataPartition,
  sessionPartitionMap,
} from "./session-partition-filter";
import { agentRuntimeBindings, listSessionPartitions } from "./tauri";

export async function companionSessionInActivePartition(storedSessionId: string) {
  const partition = getCurrentDataPartitionName();
  const [sessions, assignments] = await Promise.all([
    agentRuntimeBindings.listSessions(),
    listSessionPartitions(),
  ]);
  if (getCurrentDataPartitionName() !== partition) return undefined;
  return filterAgentSessionsForDataPartition(
    sessions,
    sessionPartitionMap(assignments),
    partition,
  ).find((session) => session.id === storedSessionId);
}
