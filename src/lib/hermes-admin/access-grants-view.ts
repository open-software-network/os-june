/**
 * Pure, render-free view logic for the Access grants settings page (JUN-206).
 * It reshapes two already-fetched inputs into the rows the UI renders, and owns
 * the revoke list math, so the scope/duration labels and the allowlist-to-log
 * correlation are unit-testable without rendering and without a network:
 *
 * 1. the raw `command_allowlist` list read from `GET /api/config`
 *    ({@link readCommandAllowlist} in `./schemas`) — the runtime's persisted
 *    "Always approve" answers, i.e. the app-wide ongoing grants;
 * 2. June's local {@link AccessGrantRecord} log of answered approvals, which
 *    carries the session-scoped and one-time grants and enriches allowlist
 *    rows with when/what granted them.
 *
 * Nothing here talks to Hermes or Tauri; it only reshapes already-fetched data.
 * Copy is sentence case, no em/en-dashes, per June conventions.
 */

import type { AccessGrantDuration, AccessGrantRecord, AccessGrantScope } from "../access-grant-log";

/** One row in the "Always allowed commands" list: a persisted allowlist pattern
 * (app-wide, ongoing by definition), enriched with the grant-log entry that
 * created it when June saw that approval happen. */
export type AllowedCommandRow = {
  /** The allowlist pattern exactly as configured (the identity used to revoke).
   * Human readable: the runtime stores the danger description as the key. */
  pattern: string;
  scope: Extract<AccessGrantScope, "app-wide">;
  duration: Extract<AccessGrantDuration, "ongoing">;
  /** Epoch ms when June recorded the grant, when it was granted through June. */
  grantedAt?: number;
  /** The command that triggered the grant, when known from the log. */
  command?: string;
};

/** Builds the "Always allowed commands" rows by joining the configured
 * allowlist with June's grant log. Order follows the configured list. A pattern
 * granted outside June (or before this log existed) still renders — it simply
 * has no grantedAt/command. The newest matching log entry wins. */
export function buildAllowedCommandRows(
  patterns: readonly string[],
  log: readonly AccessGrantRecord[],
): AllowedCommandRow[] {
  return patterns.map((pattern) => {
    // The log is newest first, so `find` returns the most recent grant.
    const match = log.find(
      (entry) =>
        entry.choice === "always" &&
        (entry.patternKeys.includes(pattern) || entry.description === pattern),
    );
    return {
      pattern,
      scope: "app-wide",
      duration: "ongoing",
      grantedAt: match?.grantedAt,
      command: match?.command,
    };
  });
}

/** One row in the "Session approvals" list: an approval the user answered with
 * "once" (one-time, consumed) or "session" (ongoing until the session ends). */
export type SessionGrantRow = {
  /** The log record id (the identity used to clear the record). */
  id: string;
  /** Primary label: the danger description, falling back to the command. */
  title: string;
  command?: string;
  toolName?: string;
  sessionId: string;
  scope: Extract<AccessGrantScope, "session">;
  duration: AccessGrantDuration;
  grantedAt: number;
};

/** Builds the session-scoped rows from the grant log, newest first (the log's
 * own order). "always" entries are excluded: their live representation is the
 * allowlist row, so listing them here would double-count a single grant. */
export function buildSessionGrantRows(log: readonly AccessGrantRecord[]): SessionGrantRow[] {
  const rows: SessionGrantRow[] = [];
  for (const entry of log) {
    if (entry.choice === "always") continue;
    rows.push({
      id: entry.id,
      title: entry.description ?? entry.command ?? entry.toolName ?? "Approved request",
      command: entry.command,
      toolName: entry.toolName,
      sessionId: entry.sessionId,
      scope: "session",
      duration: entry.choice === "once" ? "one-time" : "ongoing",
      grantedAt: entry.grantedAt,
    });
  }
  return rows;
}

/** Removes a pattern from the allowlist by its raw configured value, preserving
 * the order of the rest. Returns a NEW array. A pattern not present is a no-op
 * (the same array contents), so a double-revoke can't throw. */
export function removeAllowedCommand(existing: readonly string[], pattern: string): string[] {
  return existing.filter((entry) => entry !== pattern);
}

/** The user-facing label for a grant's scope. */
export function grantScopeLabel(scope: AccessGrantScope): string {
  return scope === "app-wide" ? "App-wide" : "This session";
}

/** The user-facing label for a grant's duration. */
export function grantDurationLabel(duration: AccessGrantDuration): string {
  return duration === "one-time" ? "One time" : "Ongoing";
}

/** A short session handle for display: session ids are runtime-internal, so the
 * page shows a stable truncated form rather than the full opaque string. */
export function shortSessionId(sessionId: string): string {
  const trimmed = sessionId.trim();
  return trimmed.length > 12 ? `${trimmed.slice(0, 12)}...` : trimmed;
}
