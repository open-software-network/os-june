import { titleFromPrompt } from "../../lib/hermes-adapter";
import { dispatchAgentSessionStatus } from "../../lib/agent-events";
import { messageFromError } from "../../lib/errors";
import { rememberComposerDraft, NEW_SESSION_DRAFT_KEY } from "./agent-session-continuity";
import {
  AUTO_SUBMIT_ECHO_WINDOW_MS,
  clearPendingNewSessionRequest,
  type AgentNewSessionDetail,
} from "./session-persistence";
import type { createTaskSubmissionActionDependencies } from "./task-submission-action-types";

export function createTaskSubmissionAction(dependencies: createTaskSubmissionActionDependencies) {
  const {
    clearComposerDraft,
    composerDraftKeyRef,
    composerEditorRef,
    lastAutoSubmittedRef,
    newSessionModeRef,
    openReportDialog,
    pendingSeedNoteRefRef,
    restoreComposerDraft,
    seedComposerNoteRef,
    selectedHermesSessionIdRef,
    setActivePanel,
    setError,
    setNewSessionMode,
    setSelectedHermesSessionId,
    setSelectedTaskId,
    setSubmitting,
    setSubmittingHermesSessionId,
    submitHermesSession,
  } = dependencies;

  async function startNewTask(
    request?: AgentNewSessionDetail,
    options: { deferSeed?: boolean } = {},
  ) {
    clearPendingNewSessionRequest();
    const seedCategory = request?.category ?? null;
    const seedNoteRef = seedCategory ? null : (request?.noteRef ?? null);
    const seedPrompt = request?.prompt?.trim() ?? "";
    // A seeded report never auto-submits: the direct report dialog opens for
    // the user to describe the issue and submit it without a model turn.
    // A seeded note reference follows the same rule: the chip lands in the
    // composer and the user decides what to send.
    const initialPrompt = seedCategory || seedNoteRef ? "" : seedPrompt;
    // The pending-marker mount path and the AGENT_NEW_SESSION_EVENT dispatch
    // can deliver the same request twice (App marks the marker, then fires
    // the event in a setTimeout for already-mounted workspaces). Submitting
    // both would put two copies of the prompt in the transcript — drop the
    // echo instead.
    if (initialPrompt) {
      const last = lastAutoSubmittedRef.current;
      if (
        last &&
        last.prompt === initialPrompt &&
        Date.now() - last.at < AUTO_SUBMIT_ECHO_WINDOW_MS
      ) {
        return;
      }
      lastAutoSubmittedRef.current = { prompt: initialPrompt, at: Date.now() };
    }
    newSessionModeRef.current = true;
    setNewSessionMode(true);
    setActivePanel("chat");
    setSelectedTaskId(undefined);
    selectedHermesSessionIdRef.current = undefined;
    composerDraftKeyRef.current = NEW_SESSION_DRAFT_KEY;
    setSelectedHermesSessionId(undefined);
    // Seed the report dialog, a note chip, or the prompt. The editor may not
    // be mounted yet on a cold open, so stash note chips for ComposerEditor's
    // onReady to pick up and also try to apply now.
    pendingSeedNoteRefRef.current = seedNoteRef
      ? {
          noteRef: seedNoteRef,
          prompt: seedPrompt,
        }
      : null;
    if (seedCategory) {
      pendingSeedNoteRefRef.current = null;
      clearComposerDraft(NEW_SESSION_DRAFT_KEY);
      openReportDialog(seedCategory);
    } else if (seedNoteRef) {
      clearComposerDraft(NEW_SESSION_DRAFT_KEY);
      seedComposerNoteRef({ defer: options.deferSeed });
    } else if (initialPrompt) {
      rememberComposerDraft(NEW_SESSION_DRAFT_KEY, initialPrompt, null);
      composerEditorRef.current?.setContent(initialPrompt);
    } else {
      restoreComposerDraft(NEW_SESSION_DRAFT_KEY);
    }
    if (!initialPrompt) return;
    dispatchAgentSessionStatus({
      prompt: initialPrompt,
      title: titleFromPrompt(initialPrompt),
      status: "starting",
      summary: "Starting June.",
    });
    setSubmittingHermesSessionId(null);
    setSubmitting(true);
    // The seeded text is now the submitted message, not a composer draft. Clear
    // it before the optimistic session migrates draft storage to its durable id;
    // otherwise the same text reappears in the composer below its user bubble.
    clearComposerDraft(NEW_SESSION_DRAFT_KEY);
    try {
      await submitHermesSession(initialPrompt);
      setError(null);
    } catch (err) {
      composerEditorRef.current?.setContent(initialPrompt);
      rememberComposerDraft(NEW_SESSION_DRAFT_KEY, initialPrompt, null);
      setError(messageFromError(err));
      dispatchAgentSessionStatus({
        prompt: initialPrompt,
        title: titleFromPrompt(initialPrompt),
        status: "failed",
        summary: messageFromError(err),
      });
    } finally {
      setSubmitting(false);
      setSubmittingHermesSessionId(null);
    }
  }

  return {
    startNewTask,
  };
}
