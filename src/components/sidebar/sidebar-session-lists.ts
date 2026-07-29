import type { AgentSessionDto } from "../../lib/agent-runtime-contract";

export type SidebarSessionLists = {
  pinned: AgentSessionDto[];
  visible: AgentSessionDto[];
  pinnedTotal: number;
  visibleTotal: number;
  /** Completed sessions never render as sidebar rows; the count feeds the
   * single Completed row that links to the sessions page. */
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
  let completedTotal = 0;

  for (const session of sessions) {
    if (completedSessionIds[session.id]) {
      completedTotal += 1;
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

  const boundedLimit = Math.max(0, Math.floor(limit));
  return {
    pinned: pinned.slice(0, boundedLimit),
    visible: visible.slice(0, boundedLimit),
    pinnedTotal: pinned.length,
    visibleTotal: visible.length,
    completedTotal,
  };
}
