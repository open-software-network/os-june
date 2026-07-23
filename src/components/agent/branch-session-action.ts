import { toast } from "../ui/Toaster";
import {
  assignSessionToProfile,
  listSessionProfiles,
  finalizeHermesBridgeBranch,
} from "../../lib/tauri";
import { createHermesMethods } from "../../lib/hermes-control-plane";
import {
  isBranchableMessageId,
  parseBranchSessionResult,
  type BranchSessionResult,
} from "../../lib/hermes-session-branch";
import { messageFromError } from "../../lib/errors";
import { rememberSessionMode, sessionUnrestricted } from "../../lib/agent-session-modes";
import { isSessionGoneError } from "./agent-workspace-errors";
import {
  rememberComposerDraft,
  sessionComposerDraftKey,
  type HermesRuntimeSessionResponse,
} from "./agent-session-continuity";
import {
  isLiveAssistantTurnId,
  liveAssistantBranchPointIndex,
  previousBranchableMessageIndex,
} from "./chat-turns/BranchAndSensitiveActions";
import { visibleHermesMessageText } from "./session-state-helpers";
import type { createBranchSessionActionDependencies } from "./branch-session-action-types";

export function createBranchSessionAction(dependencies: createBranchSessionActionDependencies) {
  const {
    BRANCH_TOAST_ID,
    attachmentsRef,
    branchingMessageIdRef,
    categoryRef,
    composerDraftKeyRef,
    composerEditorRef,
    draftRef,
    ensureHermesGateway,
    hermesSessionItems,
    hermesSessionMessages,
    hermesSessionMessagesRef,
    liveEventsRef,
    loadHermesSessions,
    newSessionModeRef,
    pendingHermesMessagesRef,
    profileOwnedSessionIdsRef,
    restoredComposerDraftKeyRef,
    runtimeSessionIdsRef,
    selectedHermesSessionIdRef,
    setActivePanel,
    setAttachments,
    setBranchingMessageId,
    setCategory,
    setDraft,
    setError,
    setHermesSessionMessages,
    setLiveEvents,
    setNewSessionMode,
    setPendingHermesMessages,
    setRuntimeSessionIds,
    setSelectedHermesSessionId,
    setSelectedTaskId,
  } = dependencies;

  async function branchFromMessage(
    sessionId: string | undefined,
    fromMessageId: string,
    modeSessionId = sessionId,
  ) {
    if (branchingMessageIdRef.current) return;
    if (!sessionId) {
      setError("Cannot branch from this message because its session is unavailable.", {
        sessionId: modeSessionId ?? null,
      });
      return;
    }
    branchingMessageIdRef.current = fromMessageId;
    setBranchingMessageId(fromMessageId);
    const sourceTitle =
      hermesSessionItems.find((session) => session.id === sessionId || session.id === modeSessionId)
        ?.title ?? "this session";
    // The fork lifecycle rides one self-replacing toast: a loading toast while
    // the branch is created, upgraded in place to the "Branched from …"
    // confirmation on success, or dismissed if the branch fails (the failure
    // surfaces on the error banner instead).
    const branchToastId = toast.loading(`Creating branch from ${sourceTitle}`, {
      id: BRANCH_TOAST_ID,
    });
    let branched = false;
    const unrestricted = sessionUnrestricted(modeSessionId);
    try {
      const gateway = await ensureHermesGateway(unrestricted);
      const methods = createHermesMethods(gateway);
      const sourceMessages = hermesSessionMessages[sessionId] ?? [];
      const sourcePendingMessages = pendingHermesMessagesRef.current[sessionId] ?? [];
      const clickedMessageIndex = sourceMessages.findIndex(
        (message) => message.id === fromMessageId,
      );
      const clickedPersistedMessage =
        clickedMessageIndex >= 0 ? sourceMessages[clickedMessageIndex] : undefined;
      const clickedPendingMessage = sourcePendingMessages.find(
        (message) => message.id === fromMessageId,
      );
      const clickedMessage = clickedPersistedMessage ?? clickedPendingMessage;
      let branchAfterMessageIndex = -1;
      let branchRequestMessageId: string | undefined;
      let branchComposerText = "";

      if (clickedMessage?.role === "user") {
        const beforeIndex = clickedPersistedMessage ? clickedMessageIndex : sourceMessages.length;
        branchAfterMessageIndex = previousBranchableMessageIndex(sourceMessages, beforeIndex);
        branchRequestMessageId =
          branchAfterMessageIndex >= 0 ? sourceMessages[branchAfterMessageIndex]?.id : undefined;
        branchComposerText = visibleHermesMessageText(clickedMessage).trim();
      } else if (clickedPersistedMessage) {
        branchAfterMessageIndex = clickedMessageIndex;
        branchRequestMessageId = sourceMessages[branchAfterMessageIndex]?.id;
      } else if (isLiveAssistantTurnId(fromMessageId)) {
        branchAfterMessageIndex = liveAssistantBranchPointIndex(
          sourceMessages,
          sourcePendingMessages,
        );
        if (branchAfterMessageIndex < 0) {
          setError("Branching is available once the response is saved.", {
            sessionId: modeSessionId ?? null,
          });
          return;
        }
        branchRequestMessageId =
          branchAfterMessageIndex >= 0 ? sourceMessages[branchAfterMessageIndex]?.id : undefined;
      } else if (isBranchableMessageId(fromMessageId)) {
        branchRequestMessageId = fromMessageId;
      } else {
        setError("Branching is available once the message is saved.", {
          sessionId: modeSessionId ?? null,
        });
        return;
      }

      const branchSeedMessages =
        branchAfterMessageIndex >= 0 ? sourceMessages.slice(0, branchAfterMessageIndex + 1) : [];
      const branchVia = (runtimeId: string) =>
        methods.branchSession({ sessionId: runtimeId, fromMessageId: branchRequestMessageId });
      // Historical branches must start from the STORED source id first. Using a
      // cached live runtime id can branch from the current in-memory tip and
      // persist later messages past from_message_id. If the stored id is not
      // accepted by this Hermes pin, fall back to the live runtime path.
      let raw: unknown;
      try {
        raw = await branchVia(sessionId);
      } catch (err) {
        if (!isSessionGoneError(messageFromError(err))) throw err;
        let runtimeSessionId: string | undefined = runtimeSessionIdsRef.current[sessionId];
        if (runtimeSessionId) {
          try {
            raw = await branchVia(runtimeSessionId);
          } catch (runtimeErr) {
            if (!isSessionGoneError(messageFromError(runtimeErr))) throw runtimeErr;
            runtimeSessionId = undefined;
          }
        }
        if (!runtimeSessionId) {
          const resumed = await gateway.request<HermesRuntimeSessionResponse>("session.resume", {
            session_id: sessionId,
            cols: 96,
          });
          runtimeSessionId = resumed.session_id;
          if (!runtimeSessionId) {
            throw new Error("Hermes did not resume the session.");
          }
          const resumedRuntimeSessionId = runtimeSessionId;
          setRuntimeSessionIds((current) => ({
            ...current,
            [sessionId]: resumedRuntimeSessionId,
          }));
          raw = await branchVia(resumedRuntimeSessionId);
        }
      }
      const result: BranchSessionResult | undefined = parseBranchSessionResult(raw, {
        sourceSessionId: sessionId,
        sourceMessageId: branchRequestMessageId,
      });
      if (!result) {
        throw new Error("Hermes did not return a branched session.");
      }
      let branchRuntimeSessionId = result.runtimeSessionId ?? result.sessionId;
      await finalizeHermesBridgeBranch({
        branchSessionId: result.sessionId,
        sourceSessionId: sessionId,
        keepMessageCount: branchSeedMessages.length,
        ...(branchRequestMessageId ? { throughMessageId: branchRequestMessageId } : {}),
      });
      // A branch belongs with its source conversation: copy the source's
      // profile mapping so the fork doesn't fall to default in the
      // profile-scoped chat list (ADR 0031). Best-effort — a missed stamp
      // surfaces the branch under default, it never loses the conversation.
      try {
        const assignments = await listSessionProfiles();
        const sourceProfile = assignments.find(
          (assignment) => assignment.sessionId === sessionId,
        )?.profile;
        if (sourceProfile && sourceProfile !== "default") {
          await assignSessionToProfile(result.sessionId, sourceProfile);
          profileOwnedSessionIdsRef.current.add(result.sessionId);
        }
      } catch {
        // Unmapped branches still appear under default; nothing is lost.
      }
      try {
        const resumedBranch = await gateway.request<HermesRuntimeSessionResponse>(
          "session.resume",
          {
            session_id: result.sessionId,
            cols: 96,
          },
        );
        if (resumedBranch.session_id) {
          branchRuntimeSessionId = resumedBranch.session_id;
        }
      } catch (err) {
        if (!isSessionGoneError(messageFromError(err))) throw err;
      }
      setRuntimeSessionIds((current) => {
        const next = {
          ...current,
          [result.sessionId]: branchRuntimeSessionId,
        };
        runtimeSessionIdsRef.current = next;
        return next;
      });
      // Carry the source session's write-access mode onto the fork so its
      // follow-ups route to the matching runtime (mirrors session.create).
      rememberSessionMode(result.sessionId, unrestricted);
      const branchDraftKey = sessionComposerDraftKey(result.sessionId);
      composerDraftKeyRef.current = branchDraftKey;
      restoredComposerDraftKeyRef.current = branchDraftKey;
      rememberComposerDraft(branchDraftKey, branchComposerText, null);
      draftRef.current = branchComposerText;
      categoryRef.current = null;
      attachmentsRef.current = [];
      setDraft(branchComposerText);
      setCategory(null);
      setAttachments([]);
      setHermesSessionMessages((current) => {
        const next = {
          ...current,
          [result.sessionId]: branchSeedMessages,
        };
        hermesSessionMessagesRef.current = next;
        return next;
      });
      setPendingHermesMessages((current) => {
        const next = {
          ...current,
          [result.sessionId]: [],
        };
        pendingHermesMessagesRef.current = next;
        return next;
      });
      liveEventsRef.current = {
        ...liveEventsRef.current,
        [result.sessionId]: [],
      };
      setLiveEvents(liveEventsRef.current);
      // Open the fork. Selecting it triggers the message-fetch effect, which
      // fills the forked transcript. The source session is left untouched.
      newSessionModeRef.current = false;
      setNewSessionMode(false);
      setSelectedTaskId(undefined);
      selectedHermesSessionIdRef.current = result.sessionId;
      setSelectedHermesSessionId(result.sessionId);
      setActivePanel("chat");
      branched = true;
      toast.success(`Branched from ${sourceTitle}`, { id: branchToastId });
      composerEditorRef.current?.setContent(branchComposerText, null);
      setError(null);
      await loadHermesSessions({ suppressSessionGoneError: true });
      window.requestAnimationFrame(() => composerEditorRef.current?.focus());
    } catch (err) {
      // Leave the UI in the source session; surface the failure there.
      const message = messageFromError(err);
      if (isSessionGoneError(message)) {
        void loadHermesSessions({ suppressSessionGoneError: true });
        setError(
          "Cannot branch from this message because the live session ended. Try again from the saved transcript.",
          { sessionId },
        );
      } else {
        setError(message, { sessionId });
      }
    } finally {
      branchingMessageIdRef.current = null;
      setBranchingMessageId(null);
      // A failed or aborted branch never resolves the loading toast; drop it so
      // the error banner is the only surface. Success already upgraded it.
      if (!branched) toast.dismiss(branchToastId);
    }
  }

  return {
    branchFromMessage,
  };
}
