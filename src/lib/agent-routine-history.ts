import { agentRuntimeBindings } from "./tauri";
import type { AgentSessionDto } from "./agent-runtime-contract";

export type RoutineRunSession = AgentSessionDto & {
  preview?: string;
  endedAt?: string | null;
  ended_at?: string | null;
  active?: boolean;
  is_active?: boolean;
};

export function routineIdFromSession(session: Pick<RoutineRunSession, "id" | "source">) {
  if (session.source !== "routine" && session.source !== "legacy_routine") return undefined;
  return /^(?:routine|cron)_(.+)_\d{8}_\d{6}(?:_[a-z0-9-]+)?$/i.exec(session.id)?.[1];
}

export function isRunningRoutineSession(session: RoutineRunSession) {
  return Boolean(session.active || session.is_active || session.status === "running");
}

export function sessionTimestamp(session: RoutineRunSession) {
  return session.completedAt ?? session.updatedAt ?? session.createdAt;
}

export function isReplaceableRoutineRunTitle(title?: string | null) {
  const value = title?.trim() ?? "";
  return (
    !value ||
    /^\[IMPORTANT:/i.test(value) ||
    /^(?:Routine run|Untitled session|Imported session)$/i.test(value)
  );
}

export async function listRoutineRunSessions(options: { includeActive?: boolean } = {}) {
  const sessions = (await agentRuntimeBindings.listSessions()) as RoutineRunSession[];
  return sessions
    .filter(
      (session) =>
        (session.source === "routine" || session.source === "legacy_routine") &&
        (options.includeActive || !isRunningRoutineSession(session)),
    )
    .map((session) => ({
      ...session,
      endedAt: session.status === "running" ? null : (session.completedAt ?? session.updatedAt),
      preview: session.preview ?? session.title,
    }))
    .sort((left, right) => sessionTimestamp(right).localeCompare(sessionTimestamp(left)));
}
