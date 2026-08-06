/**
 * Session-local model choices that have not reached an agent run boundary yet.
 *
 * The runtime persists a session's model when the next run starts. Until then,
 * keep the user's staged choice locally so navigation, hydration, and app
 * restart cannot snap the picker back to the model used by the previous run.
 */

const STORAGE_KEY = "clovy.agent.sessionModels";
export const AGENT_SESSION_MODEL_CHANGED_EVENT = "clovy:agent:session-model-changed";

export type AgentSessionModelChangedDetail = {
  sessionId: string;
  storedModel: string;
};

function readStore(): Record<string, string> {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const store: Record<string, string> = {};
    for (const [sessionId, model] of Object.entries(parsed)) {
      if (typeof model === "string" && model.trim()) store[sessionId] = model;
    }
    return store;
  } catch {
    return {};
  }
}

function writeStore(store: Record<string, string>) {
  try {
    if (Object.keys(store).length === 0) {
      window.localStorage.removeItem(STORAGE_KEY);
      return;
    }
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {
    // The persisted session model remains the safe fallback.
  }
}

export function loadSessionModels(): Record<string, string> {
  return readStore();
}

export function rememberSessionModel(sessionId: string, model: string) {
  const normalized = model.trim();
  if (!sessionId || !normalized) return;
  const store = readStore();
  if (store[sessionId] === normalized) return;
  store[sessionId] = normalized;
  writeStore(store);
  window.dispatchEvent(
    new CustomEvent<AgentSessionModelChangedDetail>(AGENT_SESSION_MODEL_CHANGED_EVENT, {
      detail: { sessionId, storedModel: normalized },
    }),
  );
}

export function forgetSessionModel(sessionId: string) {
  const store = readStore();
  if (!(sessionId in store)) return;
  delete store[sessionId];
  writeStore(store);
}

/** Clear the staged choice acknowledged by a completed run start without
 * deleting a newer choice made while that start was still awaiting native
 * work. */
export function clearSessionModelIfApplied(sessionId: string, appliedModel: string) {
  const store = readStore();
  if (store[sessionId] !== appliedModel) return;
  delete store[sessionId];
  writeStore(store);
}
