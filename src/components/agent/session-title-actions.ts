import {
  ensureHermesBridgeSession,
  type HermesSessionInfo,
  type HermesSessionMessage,
} from "../../lib/tauri";
import { deleteHermesSession } from "../../lib/hermes-adapter";
import {
  rememberSessionExchangeTitled,
  rememberSessionManuallyTitled,
  rememberSessionTitleRejected,
  sessionSettledTitleKind,
} from "../../lib/agent-session-titles";
import { forgetSessionModelSelection } from "../../lib/hermes-session-model-selection";
import { forgetSessionThinkingLevel } from "../../lib/thinking-level";
import { messageFromError } from "../../lib/errors";
import { forgetSessionMode } from "../../lib/agent-session-modes";
import {
  forgetComposerDraft,
  sessionComposerDraftKey,
  type AgentSessionTitleSource,
} from "./agent-session-continuity";
import {
  agentSessionTitleForPrompt,
  isReplaceableAgentSessionTitle,
  truncateAgentTitleResponseExcerpt,
} from "./session-title";
import { visibleHermesMessageText } from "./session-state-helpers";
import { omitRecordKey } from "./agent-workspace-support";
import type { createSessionTitleActionsDependencies } from "./session-title-actions-types";

type BackgroundSessionTitleGuard = {
  token: symbol;
  deleting?: true;
  title?: string;
};

// Background title requests can outlive an AgentWorkspace mount. Keep their
// cancellation state at module scope so a delete or rename after remount still
// invalidates the old closure before it writes to Hermes.
const backgroundSessionTitleGuards = new Map<string, BackgroundSessionTitleGuard>();

function supersedeBackgroundSessionTitle(sessionId: string, title: string) {
  backgroundSessionTitleGuards.set(sessionId, { token: Symbol("session-title"), title });
}

function markBackgroundSessionTitleDeleting(sessionId: string) {
  const guard = { token: Symbol("session-delete"), deleting: true as const };
  backgroundSessionTitleGuards.set(sessionId, guard);
  return guard;
}

export function createSessionTitleActions(dependencies: createSessionTitleActionsDependencies) {
  const {
    cancelAgentRunSettlement,
    clearSubmittedSteers,
    commitSessionModelSelections,
    discardSessionAttachmentFollowUps,
    hermesSessionItems,
    hermesSessionItemsRef,
    hermesSessionMessagesRef,
    invalidateSessionComposerDispatches,
    pendingIssueReportsRef,
    scrubHermesSessionState,
    selectedHermesSessionIdRef,
    sessionTitleOverridesRef,
    sessionTitleSourceRef,
    setError,
    setHermesSessionItems,
    setReviewableIssueReport,
    setSelectedHermesSessionId,
    titleSuggestionInFlightSessionIdsRef,
    titleSuggestionSessionIdsRef,
  } = dependencies;

  function applyManualHermesSessionTitleLocally(sessionId: string, title: string) {
    const next = title.trim();
    if (!next) return null;
    rememberSessionManuallyTitled(sessionId);
    supersedeBackgroundSessionTitle(sessionId, next);
    titleSuggestionSessionIdsRef.current.add(sessionId);
    sessionTitleOverridesRef.current = {
      ...sessionTitleOverridesRef.current,
      [sessionId]: next,
    };
    sessionTitleSourceRef.current = {
      ...sessionTitleSourceRef.current,
      [sessionId]: "manual",
    };
    const applyTitle = (sessions: HermesSessionInfo[]) =>
      sessions.map((item) => (item.id === sessionId ? { ...item, title: next } : item));
    hermesSessionItemsRef.current = applyTitle(hermesSessionItemsRef.current);
    setHermesSessionItems((current) => applyTitle(current));
    return next;
  }

  function renameHermesSession(sessionId: string, title: string) {
    const next = title.trim();
    const currentTitle =
      sessionTitleOverridesRef.current[sessionId] ??
      hermesSessionItems.find((item) => item.id === sessionId)?.title ??
      "";
    if (!next || next === currentTitle.trim()) return;
    const appliedTitle = applyManualHermesSessionTitleLocally(sessionId, next);
    if (!appliedTitle) return;
    void ensureHermesBridgeSession({ sessionId, title: appliedTitle }).catch(() => {
      setError("Could not save the session name. It may revert after a restart.", { sessionId });
    });
  }

  // Drops a deleted session from local state. Removing it from items fires
  // the sessions-changed effect, which syncs the sidebar; the shared scrub
  // clears messages, pending sends, activity-store state, and live events so a
  // running session doesn't linger as phantom "working" work.
  function removeHermesSessionLocally(sessionId: string, selectNext = true) {
    markBackgroundSessionTitleDeleting(sessionId);
    cancelAgentRunSettlement(sessionId);
    setHermesSessionItems((current) => {
      const next = current.filter((session) => session.id !== sessionId);
      setSelectedHermesSessionId((selected) => {
        const nextSelected =
          selected === sessionId ? (selectNext ? next[0]?.id : undefined) : selected;
        selectedHermesSessionIdRef.current = nextSelected;
        return nextSelected;
      });
      return next;
    });
    invalidateSessionComposerDispatches(sessionId);
    clearSubmittedSteers(sessionId);
    scrubHermesSessionState(sessionId);
    pendingIssueReportsRef.current.delete(sessionId);
    setReviewableIssueReport(sessionId, null);
    discardSessionAttachmentFollowUps(sessionId);
    forgetComposerDraft(sessionComposerDraftKey(sessionId));
    // Every deletion funnels through here (the in-workspace delete and the
    // sidebar/sessions-list AGENT_DELETE_SESSION_EVENT), so this is the one
    // place that drops the session's Unrestricted record — a stale entry
    // would hand full write access to any future session that recycled the
    // id.
    forgetSessionMode(sessionId);
    commitSessionModelSelections(forgetSessionModelSelection(sessionId));
    // Same for the session's thinking-level record.
    forgetSessionThinkingLevel(sessionId);
    sessionTitleOverridesRef.current = omitRecordKey(sessionTitleOverridesRef.current, sessionId);
    sessionTitleSourceRef.current = omitRecordKey(sessionTitleSourceRef.current, sessionId);
    titleSuggestionSessionIdsRef.current.delete(sessionId);
  }

  async function deleteSelectedHermesSession(sessionId: string) {
    const previousTitleGuard = backgroundSessionTitleGuards.get(sessionId);
    const deletionGuard = markBackgroundSessionTitleDeleting(sessionId);
    try {
      await deleteHermesSession(sessionId);
      // Clearing the selection falls the workspace back to empty.
      removeHermesSessionLocally(sessionId, false);
    } catch (err) {
      if (backgroundSessionTitleGuards.get(sessionId)?.token === deletionGuard.token) {
        if (previousTitleGuard) {
          backgroundSessionTitleGuards.set(sessionId, previousTitleGuard);
        } else {
          backgroundSessionTitleGuards.delete(sessionId);
        }
      }
      const latestMessages = hermesSessionMessagesRef.current[sessionId];
      if (latestMessages) {
        void suggestTitleForUntitledSession(sessionId, latestMessages);
      }
      setError(messageFromError(err), { sessionId });
    }
  }

  function applySessionTitleOverrides(sessions: HermesSessionInfo[]) {
    const overrides = sessionTitleOverridesRef.current;
    return sessions.map((session) => {
      const title = overrides[session.id];
      return title ? { ...session, title } : session;
    });
  }

  function clearBackgroundSessionTitleGuard(sessionId: string) {
    backgroundSessionTitleGuards.delete(sessionId);
  }

  async function applyInitialSessionTitleSuggestion(
    sessionId: string,
    suggestionPromise: ReturnType<typeof agentSessionTitleForPrompt>,
  ) {
    const titleGuard = { token: Symbol("initial-session-title") };
    backgroundSessionTitleGuards.set(sessionId, titleGuard);
    titleSuggestionInFlightSessionIdsRef.current.add(sessionId);
    try {
      const suggestion = await suggestionPromise;
      if (
        backgroundSessionTitleGuards.get(sessionId)?.token !== titleGuard.token ||
        !suggestion.fromModel ||
        titleSuggestionSessionIdsRef.current.has(sessionId) ||
        ["manual", "exchange", "rejected-final"].includes(
          sessionTitleSourceRef.current[sessionId] ?? "",
        )
      ) {
        return;
      }
      const title = suggestion.title;
      sessionTitleOverridesRef.current = {
        ...sessionTitleOverridesRef.current,
        [sessionId]: title,
      };
      sessionTitleSourceRef.current = {
        ...sessionTitleSourceRef.current,
        [sessionId]: "prompt",
      };
      const applyTitle = (sessions: HermesSessionInfo[]) =>
        sessions.map((item) => (item.id === sessionId ? { ...item, title } : item));
      hermesSessionItemsRef.current = applyTitle(hermesSessionItemsRef.current);
      setHermesSessionItems((current) => applyTitle(current));
      await ensureHermesBridgeSession({ sessionId, title }).catch(() => undefined);
      const latestGuard = backgroundSessionTitleGuards.get(sessionId);
      if (latestGuard?.token !== titleGuard.token) {
        if (latestGuard?.deleting) {
          // The title PATCH raced a successful delete. Remove the session
          // again in case Hermes handled the late write through its legacy
          // create-or-update endpoint.
          await deleteHermesSession(sessionId).catch((err) => {
            setError(messageFromError(err), { sessionId });
          });
        } else if (latestGuard?.title && latestGuard.title !== title) {
          // A rename or exchange title overtook this request, possibly from a
          // newer AgentWorkspace mount. Re-assert the shared latest title.
          await ensureHermesBridgeSession({
            sessionId,
            title: latestGuard.title,
          }).catch(() => undefined);
        }
      }
    } finally {
      titleSuggestionInFlightSessionIdsRef.current.delete(sessionId);
      if (backgroundSessionTitleGuards.get(sessionId)?.token === titleGuard.token) {
        backgroundSessionTitleGuards.delete(sessionId);
        const latestMessages = hermesSessionMessagesRef.current[sessionId];
        if (latestMessages) {
          void suggestTitleForUntitledSession(sessionId, latestMessages);
        }
      }
    }
  }

  async function suggestTitleForUntitledSession(
    sessionId: string,
    messages: HermesSessionMessage[],
  ) {
    hermesSessionMessagesRef.current = {
      ...hermesSessionMessagesRef.current,
      [sessionId]: messages,
    };
    const source = sessionTitleSourceRef.current[sessionId];
    const settledTitleKind = sessionSettledTitleKind(sessionId);
    if (
      source === "manual" ||
      source === "exchange" ||
      source === "rejected-final" ||
      settledTitleKind === "manual" ||
      settledTitleKind === "exchange" ||
      settledTitleKind === "rejected-final"
    ) {
      return;
    }
    if (
      titleSuggestionSessionIdsRef.current.has(sessionId) ||
      titleSuggestionInFlightSessionIdsRef.current.has(sessionId)
    ) {
      return;
    }
    const firstUserMessageIndex = messages.findIndex((message) => message.role === "user");
    const firstUserMessage =
      firstUserMessageIndex >= 0 ? messages[firstUserMessageIndex] : undefined;
    const prompt = firstUserMessage ? visibleHermesMessageText(firstUserMessage).trim() : "";
    if (!prompt) return;
    let titlePrompt = prompt;
    const wasRejected = source === "rejected" || settledTitleKind === "rejected";
    const firstAssistantReplyIndex = messages.findIndex(
      (message, index) =>
        index > firstUserMessageIndex &&
        message.role === "assistant" &&
        Boolean(visibleHermesMessageText(message).trim()),
    );
    let assistantReply =
      firstAssistantReplyIndex >= 0 ? messages[firstAssistantReplyIndex] : undefined;
    if (wasRejected) {
      const laterUserMessageIndex = messages.findIndex(
        (message, index) =>
          index > firstAssistantReplyIndex &&
          message.role === "user" &&
          Boolean(visibleHermesMessageText(message).trim()),
      );
      const laterAssistantReplyIndex = messages.findIndex(
        (message, index) =>
          index > laterUserMessageIndex &&
          message.role === "assistant" &&
          Boolean(visibleHermesMessageText(message).trim()),
      );
      if (laterUserMessageIndex < 0 || laterAssistantReplyIndex < 0) return;
      titlePrompt = visibleHermesMessageText(messages[laterUserMessageIndex]).trim();
      assistantReply = messages[laterAssistantReplyIndex];
    }
    const reply = truncateAgentTitleResponseExcerpt(
      assistantReply ? visibleHermesMessageText(assistantReply).trim() : "",
    );
    const hasReply = Boolean(reply);
    if (source === "prompt" || wasRejected) {
      if (!hasReply) return;
    } else if (sessionTitleOverridesRef.current[sessionId]) {
      return;
    } else {
      const session = hermesSessionItems.find((item) => item.id === sessionId);
      if (!session || !isReplaceableAgentSessionTitle(session.title)) return;
    }
    const settleRejectedTitle = () => {
      if (sessionTitleSourceRef.current[sessionId] === "manual") return;
      const rejectionIsFinal = wasRejected;
      sessionTitleSourceRef.current = {
        ...sessionTitleSourceRef.current,
        [sessionId]: rejectionIsFinal ? "rejected-final" : "rejected",
      };
      rememberSessionTitleRejected(sessionId, rejectionIsFinal);
    };
    // A rejected title gets exactly one retry, and only after a later user and
    // assistant exchange. Consume that retry before the metered request so a
    // timeout, refresh, or concurrent poll cannot issue it again.
    if (wasRejected) settleRejectedTitle();
    titleSuggestionInFlightSessionIdsRef.current.add(sessionId);
    let shouldRecheckLatestMessages = false;
    try {
      const suggestion = await agentSessionTitleForPrompt(
        titlePrompt,
        hasReply ? reply : undefined,
      );
      if (titleSuggestionSessionIdsRef.current.has(sessionId)) return;
      if (!suggestion.fromModel && sessionTitleOverridesRef.current[sessionId]) {
        if (suggestion.rejected && hasReply) settleRejectedTitle();
        return;
      }
      const title = suggestion.title;
      const rejectedThisAttempt = suggestion.rejected && hasReply;
      if (rejectedThisAttempt) settleRejectedTitle();
      const nextSource: AgentSessionTitleSource =
        suggestion.fromModel && hasReply
          ? "exchange"
          : rejectedThisAttempt
            ? wasRejected
              ? "rejected-final"
              : "rejected"
            : "prompt";
      supersedeBackgroundSessionTitle(sessionId, title);
      sessionTitleOverridesRef.current = {
        ...sessionTitleOverridesRef.current,
        [sessionId]: title,
      };
      sessionTitleSourceRef.current = {
        ...sessionTitleSourceRef.current,
        [sessionId]: nextSource,
      };
      if (suggestion.fromModel && nextSource === "prompt") {
        shouldRecheckLatestMessages = true;
      }
      // The durable exchange marker only lands once the title is known to be
      // stored: marking first and failing the PATCH would freeze a stale
      // stored title as settled on the next launch.
      const settleExchangeAfterPersist = suggestion.fromModel && nextSource === "exchange";
      setHermesSessionItems((current) =>
        current.map((item) => (item.id === sessionId ? { ...item, title } : item)),
      );
      void ensureHermesBridgeSession({ sessionId, title })
        .then(() => {
          // A manual rename can land while this auto-title PATCH is in
          // flight and finish first; the stored title must end at the
          // user's name, so re-assert it instead of settling the auto title.
          if (sessionTitleSourceRef.current[sessionId] === "manual") {
            const manualTitle = sessionTitleOverridesRef.current[sessionId];
            if (manualTitle && manualTitle !== title) {
              void ensureHermesBridgeSession({ sessionId, title: manualTitle }).catch(() => {});
            }
            return;
          }
          if (settleExchangeAfterPersist) rememberSessionExchangeTitled(sessionId);
        })
        .catch(() => {});
    } finally {
      titleSuggestionInFlightSessionIdsRef.current.delete(sessionId);
    }
    if (shouldRecheckLatestMessages) {
      const latestMessages = hermesSessionMessagesRef.current[sessionId];
      if (latestMessages) {
        void suggestTitleForUntitledSession(sessionId, latestMessages);
      }
    }
  }

  return {
    applyManualHermesSessionTitleLocally,
    renameHermesSession,
    removeHermesSessionLocally,
    deleteSelectedHermesSession,
    applySessionTitleOverrides,
    applyInitialSessionTitleSuggestion,
    clearBackgroundSessionTitleGuard,
    suggestTitleForUntitledSession,
  };
}
