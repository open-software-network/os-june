/**
 * June's local record of the "Always approve" answers the user has given — the
 * enrichment source behind the "Access grants" settings page (JUN-206).
 *
 * When the user answers a dangerous-command approval with "Always approve",
 * the runtime persists the pattern into its config `command_allowlist`, but
 * that list carries no history: nothing says when the grant was made or which
 * command triggered it. This log is that record. Only "always" answers are
 * logged: they are the persistent, app-wide, ongoing grants the settings page
 * manages. One-time and session approvals expire on their own (consumed by the
 * request, or with the session) and are deliberately not tracked.
 *
 * Boundaries (what this log is NOT):
 * - It is NOT the source of truth for the grants. That is the runtime's
 *   `command_allowlist`; the settings page reads and revokes it there. Entries
 *   here only enrich those rows (when the grant was made, the command that
 *   triggered it).
 *
 * localStorage (not the backend) because the runtime's own config store is
 * machine-local too, and the log must be readable synchronously on render —
 * the same reasoning as `agent-session-modes.ts`. Framework-agnostic with a
 * `subscribe`/`getSnapshot` surface so React binds via `useSyncExternalStore`
 * and tests drive it directly.
 */

const STORAGE_KEY = "june.agent.accessGrants";

/** Cap on stored entries. Ongoing grants are few by nature, but the cap keeps
 * a pathological history bounded. Eviction drops the oldest entries first. */
export const ACCESS_GRANT_LOG_CAP = 200;

/** One logged grant: an "Always approve" answer. Field contents come from the
 * runtime's approval request (already sanitized by the event classifier — no
 * secrets cross into here) and are redacted again before persisting. */
export type AccessGrantRecord = {
  /** Stable identity: the session + request that granted it. */
  id: string;
  sessionId: string;
  requestId: string;
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

const REDACTED = "[redacted]";

/** Authorization schemes whose following token is a credential, so the scheme
 * AND the credential are consumed together (`Authorization: Basic dXNl...`).
 * An unknown single-token value is redacted whole. */
const AUTH_SCHEMES = "basic|bearer|digest|token|dpop|oauth|negotiate|ntlm|apikey|aws4-hmac-sha256";

/** `Authorization` header (or key) with any scheme: the ENTIRE value —
 * scheme and credential — is replaced, not just the first token. Quoted
 * values are consumed whole. */
const AUTH_HEADER = new RegExp(
  `\\bauthorization["']?(\\s*[:=]\\s*)("[^"]*"|'[^']*'|(?:${AUTH_SCHEMES})\\s+\\S+|\\S+)`,
  "gi",
);

/**
 * Masks credential-shaped content in a grant's free text (the command or
 * description) BEFORE it is persisted: an approval prompt can be for a shell
 * command that embeds a secret (an `Authorization: ...` header, an inline
 * `API_KEY=...`), and this log writes to localStorage, so storing the raw
 * text would create a durable copy of that secret. Mirrors the admin
 * transport's redaction heuristics for free text: whole Authorization header
 * values (any scheme, not just Bearer), bare bearer tokens, `key=value` pairs
 * under credential-ish key names, and long separator-free alphanumeric runs
 * (paths/URLs exempt). Total: junk in, string out; never throws.
 */
export function redactGrantText(text: string): string;
export function redactGrantText(text: string | undefined): string | undefined;
export function redactGrantText(text: string | undefined): string | undefined {
  if (!text) return text;
  const keyish =
    /\b([A-Za-z0-9_-]*(?:token|api[_-]?key|secret|password|passphrase|credential|authorization)[A-Za-z0-9_-]*)(=|:\s*)("[^"]*"|'[^']*'|\S+)/gi;
  return text
    .replace(AUTH_HEADER, (_match, sep: string) => `Authorization${sep}${REDACTED}`)
    .replace(/\bbearer\s+\S+/gi, `Bearer ${REDACTED}`)
    .replace(keyish, (_match, key: string, sep: string) => `${key}${sep}${REDACTED}`)
    .split(/(\s+)/)
    .map((part) => (isCredentialShaped(part) ? REDACTED : part))
    .join("");
}

/** Value-shape secret heuristic, mirroring the admin redactor: a long
 * (>= 32 chars), separator-free, alphanumeric run is almost never meaningful
 * copy. A path or URL is a location, not a credential, so it is exempt. */
function isCredentialShaped(value: string): boolean {
  const stripped = value.replace(/^["']+|["']+$/g, "");
  if (stripped.includes("/") || stripped.includes("\\")) return false;
  return stripped.length >= 32 && /[A-Za-z0-9]/.test(stripped);
}

export type AccessGrantLog = {
  /** Logs an "Always approve" grant. Total: never throws. A re-record of the
   * same session + request (e.g. a retried respond) replaces the earlier
   * entry. */
  record(entry: Omit<AccessGrantRecord, "id" | "grantedAt"> & { grantedAt?: number }): void;
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
    // Entries written before the page narrowed to persistent grants carried a
    // choice; only "always" ones are grants this log still describes.
    (record.choice === undefined || record.choice === "always") &&
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
        toolName: entry.toolName,
        // Free text can embed a secret (a bearer header, an inline API key);
        // scrub it before it lands in durable storage.
        command: redactGrantText(entry.command),
        description: redactGrantText(entry.description),
        patternKeys: entry.patternKeys.filter((key) => typeof key === "string" && key.length > 0),
        grantedAt: entry.grantedAt ?? Date.now(),
      };
      replace([record, ...current().filter((existing) => existing.id !== id)]);
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

/** The app-wide log. AgentWorkspace records into it when the user answers an
 * approval with "Always approve"; the Access grants settings page reads it. A
 * singleton (not React state) so the record survives navigation between the
 * chat and settings. */
export const accessGrantLog = createAccessGrantLog();
