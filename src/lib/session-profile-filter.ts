import type { HermesSessionInfo, SessionProfileDto } from "./tauri";
import { isScheduledRunSession } from "./hermes-adapter";

export type SessionProfileMap = Record<string, string>;

export function sessionProfileMap(assignments: readonly SessionProfileDto[]): SessionProfileMap {
  const next: SessionProfileMap = {};
  for (const assignment of assignments) {
    next[assignment.sessionId] = assignment.profile;
  }
  return next;
}

function normalizedHermesProfileName(profile: string | undefined): string {
  const trimmed = profile?.trim();
  return trimmed || "default";
}

/** A session with no mapping row belongs to `default` (pre-profiles data and
 * sessions created outside June's create path — see ADR 0031). */
export function sessionMatchesProfile(
  session: HermesSessionInfo,
  profiles: SessionProfileMap,
  activeProfile: string,
): boolean {
  return (
    normalizedHermesProfileName(profiles[session.id]) === normalizedHermesProfileName(activeProfile)
  );
}

export function filterAgentSessionsForProfile(
  sessions: readonly HermesSessionInfo[],
  profiles: SessionProfileMap,
  activeProfile: string,
): HermesSessionInfo[] {
  return sessions
    .filter((session) => !isScheduledRunSession(session))
    .filter((session) => sessionMatchesProfile(session, profiles, activeProfile));
}
