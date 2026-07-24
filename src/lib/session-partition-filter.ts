import type { SessionProfileDto as SessionPartitionDto } from "./tauri";
import type { AgentSessionDto } from "./agent-runtime-contract";

export type SessionPartitionMap = Record<string, string>;

export function sessionPartitionMap(
  assignments: readonly SessionPartitionDto[],
): SessionPartitionMap {
  const next: SessionPartitionMap = {};
  for (const assignment of assignments) {
    next[assignment.sessionId] = assignment.profile;
  }
  return next;
}

function normalizedDataPartitionName(partition: string | undefined): string {
  const trimmed = partition?.trim();
  return trimmed || "default";
}

/** A session with no mapping row belongs to `default` (pre-partition data and
 * sessions created outside June's create path. See ADR 0031). */
export function sessionMatchesDataPartition(
  session: AgentSessionDto,
  partitions: SessionPartitionMap,
  currentPartition: string,
): boolean {
  return (
    normalizedDataPartitionName(partitions[session.id]) ===
    normalizedDataPartitionName(currentPartition)
  );
}

export function filterAgentSessionsForDataPartition(
  sessions: readonly AgentSessionDto[],
  partitions: SessionPartitionMap,
  currentPartition: string,
): AgentSessionDto[] {
  return sessions.filter((session) =>
    sessionMatchesDataPartition(session, partitions, currentPartition),
  );
}
