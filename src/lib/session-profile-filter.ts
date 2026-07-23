import type { SessionProfileDto } from "./tauri";
import type { AgentSessionDto } from "./agent-runtime-contract";

export type SessionProfileMap = Record<string, string>;

export function sessionProfileMap(assignments: readonly SessionProfileDto[]): SessionProfileMap {
  const next: SessionProfileMap = {};
  for (const assignment of assignments) {
    next[assignment.sessionId] = assignment.profile;
  }
  return next;
}

function normalizedAgentProfileName(profile: string | undefined): string {
  const trimmed = profile?.trim();
  return trimmed || "default";
}

/** A session with no mapping row belongs to `default` (pre-profiles data and
 * sessions created outside June's create path — see ADR 0031). */
export function sessionMatchesProfile(
  session: AgentSessionDto,
  profiles: SessionProfileMap,
  activeProfile: string,
): boolean {
  return (
    normalizedAgentProfileName(profiles[session.id]) === normalizedAgentProfileName(activeProfile)
  );
}

export function filterAgentSessionsForProfile(
  sessions: readonly AgentSessionDto[],
  profiles: SessionProfileMap,
  activeProfile: string,
): AgentSessionDto[] {
  return sessions.filter((session) => sessionMatchesProfile(session, profiles, activeProfile));
}
