/**
 * Per-session record of settled title edits. Keyed by stored session id (not
 * runtime session id) because June's session list and persistence use the
 * durable id, while live Hermes processes may resume under a different
 * runtime id. Absence means auto-titling is allowed, so sessions from before
 * this record existed fall back to the safe default.
 *
 * localStorage (not the backend) because the runtime's session store is
 * machine-local too, and the map must be readable synchronously before the
 * title suggester decides whether a loaded title is replaceable.
 */

const STORAGE_KEY = "june.agent.manuallyTitledSessions";

export type AgentSessionSettledTitleKind = "manual" | "exchange";

function readStore(): Record<string, AgentSessionSettledTitleKind> {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const store: Record<string, AgentSessionSettledTitleKind> = {};
    for (const [sessionId, value] of Object.entries(parsed)) {
      if (value === true || value === "manual") {
        store[sessionId] = "manual";
      } else if (value === "exchange") {
        store[sessionId] = "exchange";
      }
    }
    return store;
  } catch {
    return {};
  }
}

function writeStore(store: Record<string, AgentSessionSettledTitleKind>) {
  try {
    if (Object.keys(store).length === 0) {
      window.localStorage.removeItem(STORAGE_KEY);
      return;
    }
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {
    // Ignore; worst case a settled session can be auto-titled again.
  }
}

/** Why this session's title is settled, or null when auto-titling is allowed. */
export function sessionSettledTitleKind(
  sessionId: string | undefined,
): AgentSessionSettledTitleKind | null {
  if (!sessionId) return null;
  return readStore()[sessionId] ?? null;
}

export function rememberSessionManuallyTitled(sessionId: string) {
  const store = readStore();
  store[sessionId] = "manual";
  writeStore(store);
}

export function rememberSessionExchangeTitled(sessionId: string) {
  const store = readStore();
  if (store[sessionId] === "manual") return;
  store[sessionId] = "exchange";
  writeStore(store);
}
