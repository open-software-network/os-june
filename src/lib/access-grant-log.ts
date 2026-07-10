/**
 * June's local record of the approval grants the user has answered — the data
 * source behind the "Access grants" settings page (JUN-206).
 *
 * When the user approves a dangerous-command request, the choice ("once" /
 * "session" / "always") goes to the Hermes runtime over `approval.respond`.
 * The runtime keeps "always" answers durably (its config `command_allowlist`)
 * and "session" answers in the session's memory, but June itself kept no
 * record — so there was nothing to show a user asking "what have I granted?".
 * This module is that record: every approved request is logged here with the
 * scope (this session vs app-wide) and duration (one time vs ongoing) implied
 * by the choice.
 *
 * Boundaries (what this log is NOT):
 * - It is NOT the source of truth for app-wide grants. That is the runtime's
 *   `command_allowlist`; the settings page reads and revokes it there. Log
 *   entries with choice "always" exist only to enrich those rows (when the
 *   grant was made, the command that triggered it).
 * - It cannot retract a session-scoped approval from a running session; the
 *   runtime holds that in memory with no revoke API. Session entries track
 *   what was granted; they expire with the session.
 *
 * localStorage (not the backend) because the runtime's own session store is
 * machine-local too, and the log must be readable synchronously on render —
 * the same reasoning as `agent-session-modes.ts`. Framework-agnostic with a
 * `subscribe`/`getSnapshot` surface so React binds via `useSyncExternalStore`
 * and tests drive it directly.
 */

import type { AgentApprovalChoice } from "./agent-chat-runtime";

const STORAGE_KEY = "june.agent.accessGrants";

/** Cap on stored entries. One-time history is the unbounded part; ongoing
 * grants are few by nature. Eviction drops the oldest entries first. */
export const ACCESS_GRANT_LOG_CAP = 200;

/** Where a grant applies. Derived from the approval choice: "always" is
 * app-wide; "once" and "session" never outlive the session that asked. */
export type AccessGrantScope = "session" | "app-wide";

/** How long a grant lasts. "once" is consumed by the single command that asked;
 * "session" and "always" keep allowing matching requests. */
export type AccessGrantDuration = "one-time" | "ongoing";

/** An approval choice that granted something (i.e. not "deny"). */
export type AccessGrantChoice = Exclude<AgentApprovalChoice, "deny">;

/** One logged grant. Field contents come from the runtime's approval request
 * (already sanitized by the event classifier — no secrets cross into here). */
export type AccessGrantRecord = {
  /** Stable identity: the session + request that granted it. */
  id: string;
  sessionId: string;
  requestId: string;
  choice: AccessGrantChoice;
  /** The tool that asked, when the runtime named one (e.g. "shell"). */
  toolName?: string;
  /** The command that triggered the approval prompt. */
  command?: string;
  /** The human-readable danger description (also the runtime's pattern key). */
  description?: string;
  /** The runtime's pattern keys for the matched danger patterns. These are the
   * strings an "always" answer persists into `command_allowlist`, so they are
   * how a log entry is correlated with an allowlist row. */
  patternKeys: string[];
  /** Epoch ms when the user granted it. */
  grantedAt: number;
};

/** Scope implied by an approval choice. */
export function grantScope(choice: AccessGrantChoice): AccessGrantScope {
  return choice === "always" ? "app-wide" : "session";
}

/** Duration implied by an approval choice. */
export function grantDuration(choice: AccessGrantChoice): AccessGrantDuration {
  return choice === "once" ? "one-time" : "ongoing";
}

/** Extracts the runtime's pattern keys from a sanitized approval payload
 * (`pattern_keys` list, falling back to the single `pattern_key`). Total:
 * junk in, empty list out. */
export function approvalPatternKeys(payload: unknown): string[] {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return [];
  const record = payload as Record<string, unknown>;
  const keys = record.pattern_keys;
  if (Array.isArray(keys)) {
    const out = keys.filter((key): key is string => typeof key === "string" && key.length > 0);
    if (out.length > 0) return out;
  }
  const single = record.pattern_key;
  if (typeof single === "string" && single.length > 0) return [single];
  return [];
}

export type AccessGrantLog = {
  /** Logs a grant. Total: never throws. A re-record of the same session +
   * request (e.g. a retried respond) replaces the earlier entry. */
  record(entry: Omit<AccessGrantRecord, "id" | "grantedAt"> & { grantedAt?: number }): void;
  /** Removes one entry by id. No-op when unknown. */
  remove(id: string): void;
  /** Removes every logged entry. */
  clear(): void;
  /** All entries, newest first. The array identity is stable between
   * mutations (a `useSyncExternalStore` snapshot). */
  list(): readonly AccessGrantRecord[];
  /** Subscribe to changes; returns an unsubscribe. */
  subscribe(listener: () => void): () => void;
};

function isRecordShape(value: unknown): value is AccessGrantRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === "string" &&
    typeof record.sessionId === "string" &&
    typeof record.requestId === "string" &&
    (record.choice === "once" || record.choice === "session" || record.choice === "always") &&
    typeof record.grantedAt === "number" &&
    Array.isArray(record.patternKeys)
  );
}

function readStore(): AccessGrantRecord[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isRecordShape);
  } catch {
    return [];
  }
}

function writeStore(entries: readonly AccessGrantRecord[]) {
  try {
    if (entries.length === 0) {
      window.localStorage.removeItem(STORAGE_KEY);
      return;
    }
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // Ignore; worst case the grant history has a gap. The actual permission
    // lives with the runtime, so nothing becomes more permissive.
  }
}

/** Creates an isolated log instance. The app holds one ({@link accessGrantLog});
 * tests create their own so state never leaks between suites. */
export function createAccessGrantLog(): AccessGrantLog {
  const listeners = new Set<() => void>();
  // The cached snapshot: newest first, identity stable between mutations.
  let snapshot: readonly AccessGrantRecord[] | undefined;

  function emit(): void {
    for (const listener of [...listeners]) listener();
  }

  function current(): readonly AccessGrantRecord[] {
    if (!snapshot) {
      snapshot = readStore().sort((a, b) => b.grantedAt - a.grantedAt);
    }
    return snapshot;
  }

  function replace(next: AccessGrantRecord[]): void {
    next.sort((a, b) => b.grantedAt - a.grantedAt);
    if (next.length > ACCESS_GRANT_LOG_CAP) next.length = ACCESS_GRANT_LOG_CAP;
    snapshot = next;
    writeStore(next);
    emit();
  }

  return {
    record(entry) {
      const sessionId = entry.sessionId.trim();
      const requestId = entry.requestId.trim();
      // A grant that can't be attributed to a request is untrackable; drop it
      // rather than store a row nothing can correlate or de-duplicate.
      if (!sessionId || !requestId) return;
      const id = `${sessionId}:${requestId}`;
      const record: AccessGrantRecord = {
        id,
        sessionId,
        requestId,
        choice: entry.choice,
        toolName: entry.toolName,
        command: entry.command,
        description: entry.description,
        patternKeys: entry.patternKeys.filter((key) => typeof key === "string" && key.length > 0),
        grantedAt: entry.grantedAt ?? Date.now(),
      };
      replace([record, ...current().filter((existing) => existing.id !== id)]);
    },
    remove(id) {
      const next = current().filter((entry) => entry.id !== id);
      if (next.length === current().length) return;
      replace([...next]);
    },
    clear() {
      if (current().length === 0) return;
      replace([]);
    },
    list() {
      return current();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** The app-wide log. AgentWorkspace records into it when the user approves a
 * request; the Access grants settings page reads it. A singleton (not React
 * state) so the record survives navigation between the chat and settings. */
export const accessGrantLog = createAccessGrantLog();
