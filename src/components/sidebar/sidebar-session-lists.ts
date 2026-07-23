import type { AgentSessionDto } from "../../lib/agent-runtime-contract";

export type SidebarSessionLists = {
  pinned: AgentSessionDto[];
  visible: AgentSessionDto[];
  completed: AgentSessionDto[];
  pinnedTotal: number;
  visibleTotal: number;
  completedTotal: number;
};

export function buildSidebarSessionLists(
  sessions: readonly AgentSessionDto[],
  pinnedSessionIds: ReadonlySet<string>,
  completedSessionIds: Readonly<Record<string, string>>,
  limit: number,
): SidebarSessionLists {
  const pinned: AgentSessionDto[] = [];
  const visible: AgentSessionDto[] = [];
  const completed: AgentSessionDto[] = [];

  for (const session of sessions) {
    if (completedSessionIds[session.id]) {
      completed.push(session);
    } else if (pinnedSessionIds.has(session.id)) {
      pinned.push(session);
    } else {
      visible.push(session);
    }
  }

  const pinnedOrder = new Map<string, number>();
  let pinnedIndex = 0;
  for (const sessionId of pinnedSessionIds) {
    pinnedOrder.set(sessionId, pinnedIndex);
    pinnedIndex += 1;
  }
  pinned.sort(
    (a, b) =>
      (pinnedOrder.get(a.id) ?? Number.MAX_SAFE_INTEGER) -
      (pinnedOrder.get(b.id) ?? Number.MAX_SAFE_INTEGER),
  );
  completed.sort((a, b) =>
    (completedSessionIds[b.id] ?? "").localeCompare(completedSessionIds[a.id] ?? ""),
  );

  const boundedLimit = Math.max(0, Math.floor(limit));
  return {
    pinned: pinned.slice(0, boundedLimit),
    visible: visible.slice(0, boundedLimit),
    completed: completed.slice(0, boundedLimit),
    pinnedTotal: pinned.length,
    visibleTotal: visible.length,
    completedTotal: completed.length,
  };
}
