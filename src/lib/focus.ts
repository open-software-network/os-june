import type { FocusIntervalInput, FocusSessionDto } from "./tauri";

export type FocusProjectAllocation = {
  key: string;
  projectId?: string;
  projectName: string;
  plannedMs: number;
  actualMs: number;
};

export function buildFocusIntervalPlan({
  intervalCount,
  focusMinutes,
  shortBreakMinutes,
  longBreakMinutes,
  projectIds,
}: {
  intervalCount: number;
  focusMinutes: number;
  shortBreakMinutes: number;
  longBreakMinutes: number;
  projectIds: Array<string | undefined>;
}): FocusIntervalInput[] {
  const plan: FocusIntervalInput[] = [];
  for (let index = 0; index < intervalCount; index += 1) {
    plan.push({ kind: "focus", durationMinutes: focusMinutes, projectId: projectIds[index] });
    if (index + 1 < intervalCount) {
      plan.push({
        kind: "break",
        durationMinutes: (index + 1) % 4 === 0 ? longBreakMinutes : shortBreakMinutes,
      });
    }
  }
  return plan;
}

export function focusPlanMinutes(plan: FocusIntervalInput[]): number {
  return plan.reduce((total, interval) => total + interval.durationMinutes, 0);
}

export function focusProjectAllocations(session: FocusSessionDto): FocusProjectAllocation[] {
  const allocations = new Map<string, FocusProjectAllocation>();
  const allocation = (projectId?: string, projectName?: string) => {
    const key = projectId || "__none__";
    const current = allocations.get(key);
    if (current) return current;
    const created = {
      key,
      projectId,
      projectName: projectName || "No Project",
      plannedMs: 0,
      actualMs: 0,
    };
    allocations.set(key, created);
    return created;
  };
  for (const interval of session.intervals) {
    if (interval.kind === "focus") {
      allocation(interval.projectId, interval.projectName).plannedMs += interval.plannedDurationMs;
    }
  }
  for (const segment of session.segments) {
    if (segment.kind === "focus" || segment.kind === "overtime") {
      allocation(segment.projectId, segment.projectName).actualMs += segment.durationMs;
    }
  }
  return [...allocations.values()];
}

export function formatFocusDuration(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

export function focusClock(
  session: FocusSessionDto,
  snapshotAt: number,
  now: number,
): { valueMs: number; direction: "down" | "up" } {
  const advances = ["focusing", "overtime", "onBreak"].includes(session.status);
  const delta = advances ? Math.max(0, now - snapshotAt) : 0;
  if (session.status === "overtime" || session.pausedFrom === "overtime") {
    const plannedCurrentMs =
      session.intervals.find((item) => item.position === session.currentIntervalPosition)
        ?.plannedDurationMs ?? 0;
    const currentOvertimeMs = Math.max(0, session.currentElapsedMs - plannedCurrentMs);
    return { valueMs: currentOvertimeMs + delta, direction: "up" };
  }
  return { valueMs: Math.max(0, session.remainingMs - delta), direction: "down" };
}

export function midpointTimestamp(startedAt: string, endedAt?: string): string | undefined {
  if (!endedAt) return undefined;
  const start = Date.parse(startedAt);
  const end = Date.parse(endedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end - start < 2) return undefined;
  return new Date(start + Math.floor((end - start) / 2)).toISOString();
}
