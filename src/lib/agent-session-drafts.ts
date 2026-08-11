/**
 * Unsent composer text follows its stored agent session while Clovy stays open.
 * Keep this process-local: drafts can contain sensitive material and should
 * not survive an app restart.
 */
type AgentSessionDraft = {
  revision: number;
  text: string;
};

const draftsByStoredSessionId = new Map<string, AgentSessionDraft>();
const draftsByCreationRequestId = new Map<string, AgentSessionDraft>();
const invalidatedStoredSessionIds = new Set<string>();
let nextRevision = 0;

function snapshot(text: string): AgentSessionDraft {
  return { revision: ++nextRevision, text };
}

export function readAgentSessionDraft(storedSessionId: string): string | undefined {
  return draftsByStoredSessionId.get(storedSessionId)?.text;
}

export function readAgentSessionDraftRevision(storedSessionId: string): number | undefined {
  return draftsByStoredSessionId.get(storedSessionId)?.revision;
}

export function writeAgentSessionDraft(storedSessionId: string, draft: string) {
  if (!storedSessionId || invalidatedStoredSessionIds.has(storedSessionId)) return;
  if (draft.length === 0) {
    draftsByStoredSessionId.delete(storedSessionId);
    return;
  }
  draftsByStoredSessionId.set(storedSessionId, snapshot(draft));
}

export function writePendingAgentSessionDraft(creationRequestId: string, draft: string) {
  if (!creationRequestId) return;
  if (draft.length === 0) {
    draftsByCreationRequestId.delete(creationRequestId);
    return;
  }
  draftsByCreationRequestId.set(creationRequestId, snapshot(draft));
}

export function transferPendingAgentSessionDraft(
  creationRequestId: string,
  storedSessionId: string,
): boolean {
  const pending = draftsByCreationRequestId.get(creationRequestId);
  draftsByCreationRequestId.delete(creationRequestId);
  if (!pending || invalidatedStoredSessionIds.has(storedSessionId)) return false;
  draftsByStoredSessionId.set(storedSessionId, pending);
  return true;
}

export function clearPendingAgentSessionDraft(creationRequestId: string) {
  draftsByCreationRequestId.delete(creationRequestId);
}

export function invalidateAgentSessionDraft(storedSessionId: string) {
  invalidatedStoredSessionIds.add(storedSessionId);
  draftsByStoredSessionId.delete(storedSessionId);
}

export function clearAgentSessionDraftRevision(storedSessionId: string, revision?: number) {
  if (revision === undefined) return;
  if (draftsByStoredSessionId.get(storedSessionId)?.revision !== revision) return;
  draftsByStoredSessionId.delete(storedSessionId);
}

/** Test-only reset because workspace tests intentionally reuse stored session ids. */
export function resetAgentSessionDraftsForTests() {
  draftsByStoredSessionId.clear();
  draftsByCreationRequestId.clear();
  invalidatedStoredSessionIds.clear();
  nextRevision = 0;
}
