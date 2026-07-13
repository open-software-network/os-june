/**
 * Pure, render-free view logic for the Access grants settings page (JUN-206).
 * The page lists ONLY the persistent grants: app-wide, ongoing approvals that
 * stay in effect until revoked. This module reshapes two already-fetched
 * inputs into the rows the UI renders, and owns the revoke list math, so the
 * allowlist-to-log correlation is unit-testable without rendering and without
 * a network:
 *
 * 1. the raw `command_allowlist` list read from `GET /api/config`
 *    ({@link readCommandAllowlist} in `./schemas`) — the runtime's persisted
 *    "Always approve" answers, i.e. the grants themselves;
 * 2. June's local {@link AccessGrantRecord} log of "Always approve" answers,
 *    which enriches allowlist rows with when/what granted them.
 *
 * Nothing here talks to Hermes or Tauri; it only reshapes already-fetched data.
 * Copy is sentence case, no em/en-dashes, per June conventions.
 */

import type { AccessGrantRecord } from "../access-grant-log";

/** One row in the "Always allowed commands" list: a persisted allowlist pattern
 * (app-wide and ongoing by definition), enriched with the grant-log entry that
 * created it when June saw that approval happen. */
export type AllowedCommandRow = {
  /** The allowlist pattern exactly as configured (the identity used to revoke).
   * Human readable: the runtime stores the danger description as the key. */
  pattern: string;
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
      (entry) => entry.patternKeys.includes(pattern) || entry.description === pattern,
    );
    return {
      pattern,
      grantedAt: match?.grantedAt,
      command: match?.command,
    };
  });
}

/** Removes a pattern from the allowlist by its raw configured value, preserving
 * the order of the rest. Returns a NEW array. A pattern not present is a no-op
 * (the same array contents), so a double-revoke can't throw. */
export function removeAllowedCommand(existing: readonly string[], pattern: string): string[] {
  return existing.filter((entry) => entry !== pattern);
}
