/**
 * Unsent composer text follows its stored agent session while June stays open.
 * Keep this process-local: drafts can contain sensitive material and should
 * not survive an app restart.
 */
const draftsBySessionId = new Map<string, string>();

export function readAgentSessionDraft(sessionId: string): string | undefined {
  return draftsBySessionId.get(sessionId);
}

export function writeAgentSessionDraft(sessionId: string, draft: string) {
  if (!sessionId) return;
  if (draft.length === 0) {
    draftsBySessionId.delete(sessionId);
    return;
  }
  draftsBySessionId.set(sessionId, draft);
}

export function clearAgentSessionDraft(sessionId: string, expectedDraft?: string) {
  if (expectedDraft !== undefined && draftsBySessionId.get(sessionId) !== expectedDraft) return;
  draftsBySessionId.delete(sessionId);
}

/** Test-only reset because workspace tests intentionally reuse session ids. */
export function resetAgentSessionDraftsForTests() {
  draftsBySessionId.clear();
}
