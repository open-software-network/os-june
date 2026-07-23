import { type FormEvent } from "react";
import { toast } from "../../ui/Toaster";
import { isSessionBusyError } from "../../../lib/hermes-gateway";
import { messageFromError } from "../../../lib/errors";
import { categoryPrompt } from "../../../lib/issue-report-prompt";
import { ISSUE_REPORT_ATTACHMENTS_ONLY_DESCRIPTION } from "./reportCategory";
import { prepareProjectPrompt } from "../../../lib/agent-project-context";
import { parseBuiltinComposerSlashCommand } from "../../../lib/agent-composer-slash-commands";
import { IMAGE_GENERATION_ENABLED } from "../../../lib/feature-flags";
import { modelSupportsImageInput } from "../../../lib/model-privacy";
import type { PendingIssueReport } from "../agent-session-continuity";
import { AttachBlockedError } from "./media-slash-persistence";
import { type PendingSteer, type PreparedComposerSubmission } from "./follow-up-queue";
import { composerInputSignatureFor } from "./composer-input-helpers";
import {
  appendIssueReportFollowUp,
  dispatchIssueReportFollowUpSubmitFailed,
  forgetComposerDraft,
  rememberComposerDraft,
  NEW_SESSION_RECOVERY_QUEUE_KEY,
} from "../agent-session-continuity";
import { oversizedComposerInputWarning } from "./composer-input-helpers";
import { sameAgentAttachments } from "../agent-workspace-support";
import type { SubmitComposerDependencies } from "./submit-composer-types";

export function createSubmitComposer(dependencies: SubmitComposerDependencies) {
  const {
    SESSION_BUSY_NOTICE,
    SESSION_BUSY_TOAST_ID,
    attachments,
    attachmentsRef,
    beginAttachmentPreparation,
    cancelComposerDispatch,
    captureSessionModelTarget,
    categoryRef,
    clearComposerDraft,
    composerDispatchOrderRef,
    composerDispatchWasInvalidated,
    composerDraftKeyRef,
    composerEditorRef,
    composerSizeProceedSignatureRef,
    deferredFailedIssueReportDeliverySessionIdsRef,
    draftRef,
    enqueueAttachmentFollowUp,
    enqueueFailedComposerFollowUp,
    finishAttachmentPreparation,
    forgetComposerDispatch,
    generationModel,
    generationModels,
    handleBuiltinComposerSlashCommand,
    heroMode,
    importingFiles,
    newSessionModeRef,
    pendingSteerBySessionIdRef,
    prepareComposerSubmission,
    projectContext,
    projectContextSignaturesBySessionId,
    reserveComposerDispatch,
    reviewableIssueReportsRef,
    selectedHermesSessionId,
    selectedHermesSessionIdRef,
    selectedHermesSessionIsProvisional,
    setCategory,
    setComposerAttachments,
    setComposerSizeWarning,
    setDraft,
    setError,
    setHeroLeaving,
    setReviewableIssueReport,
    setSteerCardsBySessionId,
    setSubmitting,
    setSubmittingHermesSessionId,
    steerActiveSession,
    steerCardSeqRef,
    submitHermesSession,
    submitting,
    submittingIssueReportSessionIdsRef,
    textActionsDisabledReason,
    workingSessionIdsRef,
  } = dependencies;

  async function submit(event?: FormEvent) {
    event?.preventDefault();
    const message = draftRef.current.trim();
    const reportCategory = categoryRef.current;
    const submittedComposerInputSignature = composerInputSignatureFor({
      message,
      category: reportCategory,
      attachments,
      model: generationModel,
    });
    const submittedSlashCommand = parseBuiltinComposerSlashCommand(message);
    const submittedGenerationModel = generationModel
      ? generationModels.find((model) => model.id === generationModel.id)
      : undefined;
    const submittedImageSlashBlockedByModel =
      IMAGE_GENERATION_ENABLED &&
      submittedSlashCommand?.name === "image" &&
      !!submittedGenerationModel &&
      !modelSupportsImageInput(submittedGenerationModel);
    if (
      (!message && !attachments.length) ||
      submitting ||
      importingFiles ||
      textActionsDisabledReason ||
      selectedHermesSessionIsProvisional ||
      submittedImageSlashBlockedByModel
    )
      return;
    // This is the user-visible Send boundary. Skill expansion, file reads, and
    // session resume can all await; a picker change during any of them belongs
    // to the following run. Title generation starts here but stays backgrounded.
    const sentModelTarget = captureSessionModelTarget();
    const sentDispatchOrder = ++composerDispatchOrderRef.current;
    const sentDispatchReservation = sentModelTarget.targetStoredSessionId
      ? reserveComposerDispatch(sentModelTarget.targetStoredSessionId)
      : undefined;
    const sentStartedNewSession = sentModelTarget.targetStoredSessionId === null;
    // prompt.submit prepends the injected `[June project context]` block for a
    // project-filed session (see prepareProjectPrompt at the dispatch site), so
    // the size guard must estimate that same larger text — otherwise a project
    // with long instructions can slip a near-limit prompt past the warning and
    // fail only after submit. Mirror the dispatch: ambient project context plus
    // this send's last delivered signature, so the block counts exactly when it
    // will actually be injected and dedup-skipped turns aren't over-warned.
    // (The steer path never calls prompt.submit, so it estimates the raw text.)
    const sizeEstimateContent = (baseContent: string, targetSessionId?: string): string => {
      const previousSignature =
        !newSessionModeRef.current && targetSessionId
          ? projectContextSignaturesBySessionId.get(targetSessionId)
          : undefined;
      return prepareProjectPrompt(baseContent, projectContext, previousSignature).text;
    };
    if (message) {
      try {
        const handledBuiltinCommand = await handleBuiltinComposerSlashCommand(
          message,
          sentModelTarget,
          sentDispatchReservation,
        );
        if (composerDispatchWasInvalidated(sentDispatchReservation)) return;
        if (handledBuiltinCommand) {
          cancelComposerDispatch(sentDispatchReservation);
          return;
        }
      } catch (err) {
        cancelComposerDispatch(sentDispatchReservation);
        throw err;
      }
    }
    const attachmentQueueSessionId =
      attachments.length > 0 &&
      !reportCategory &&
      !newSessionModeRef.current &&
      selectedHermesSessionId &&
      workingSessionIdsRef.current.has(selectedHermesSessionId)
        ? selectedHermesSessionId
        : undefined;
    if (attachmentQueueSessionId) {
      const attachmentPreparation = beginAttachmentPreparation(
        attachmentQueueSessionId,
        sentDispatchOrder,
        sentDispatchReservation,
      );
      let prepared: PreparedComposerSubmission;
      try {
        prepared = await prepareComposerSubmission(message, attachments);
      } catch (err) {
        if (attachmentPreparation.cancelled) {
          finishAttachmentPreparation(attachmentQueueSessionId, attachmentPreparation);
          return;
        }
        // The draft and attachments are still in the composer - only the
        // banner is needed for recovery, unlike the full submit path below.
        cancelComposerDispatch(sentDispatchReservation);
        finishAttachmentPreparation(attachmentQueueSessionId, attachmentPreparation);
        setError(messageFromError(err));
        return;
      }
      if (attachmentPreparation.cancelled) {
        finishAttachmentPreparation(attachmentQueueSessionId, attachmentPreparation);
        return;
      }
      const sizeWarning = oversizedComposerInputWarning({
        content: sizeEstimateContent(prepared.runtimeContent, attachmentQueueSessionId),
        inputSignature: submittedComposerInputSignature,
        attachments,
        model: generationModel,
        models: generationModels,
      });
      if (sizeWarning && composerSizeProceedSignatureRef.current !== sizeWarning.signature) {
        cancelComposerDispatch(sentDispatchReservation);
        finishAttachmentPreparation(attachmentQueueSessionId, attachmentPreparation);
        setComposerSizeWarning(sizeWarning);
        composerEditorRef.current?.focus();
        return;
      }
      enqueueAttachmentFollowUp(
        attachmentQueueSessionId,
        prepared,
        attachments,
        sentModelTarget,
        sentDispatchReservation,
        sentDispatchOrder,
      );
      forgetComposerDispatch(sentDispatchReservation);
      finishAttachmentPreparation(attachmentQueueSessionId, attachmentPreparation);
      clearComposerDraft();
      composerEditorRef.current?.focus();
      return;
    }
    // June is mid-run: send the message straight into the loop via steer so
    // June picks it up after the current tool call (adds context without
    // interrupting — Escape or Stop interrupts instead). Plain-text follow-ups
    // to an existing session only; attachments, reports, and new-session sends
    // take the full submit path below.
    if (
      message &&
      !attachments.length &&
      !reportCategory &&
      !newSessionModeRef.current &&
      selectedHermesSessionId &&
      workingSessionIdsRef.current.has(selectedHermesSessionId)
    ) {
      const steerSizeWarning = oversizedComposerInputWarning({
        content: message,
        inputSignature: submittedComposerInputSignature,
        attachments: [],
        model: generationModel,
        models: generationModels,
      });
      if (
        steerSizeWarning &&
        composerSizeProceedSignatureRef.current !== steerSizeWarning.signature
      ) {
        cancelComposerDispatch(sentDispatchReservation);
        setComposerSizeWarning(steerSizeWarning);
        composerEditorRef.current?.focus();
        return;
      }
      const steerSessionId = selectedHermesSessionId;
      // Delivery guarantee. Hermes only injects a steer into the next tool
      // result and rejects the RPC during a no-tool phase, so the steer alone
      // is unreliable. Record the text, attempt the steer (best effort — a
      // success a tool later drains is the mid-run path), and on the turn's
      // clean completion resend anything still pending as a follow-up.
      // `registered` tracks whether Hermes accepted the steer, so a
      // tool.complete only clears ones a tool could actually have drained.
      steerCardSeqRef.current += 1;
      const cardId = `steer-${steerCardSeqRef.current}`;
      const steerEntry: PendingSteer = {
        text: message,
        accepted: false,
        toolDrained: false,
        modelTarget: sentModelTarget,
        dispatchReservation: sentDispatchReservation,
        dispatchOrder: sentDispatchOrder,
      };
      forgetComposerDispatch(sentDispatchReservation);
      pendingSteerBySessionIdRef.current = {
        ...pendingSteerBySessionIdRef.current,
        [steerSessionId]: [
          ...(pendingSteerBySessionIdRef.current[steerSessionId] ?? []),
          steerEntry,
        ],
      };
      // Tack the submitted instruction onto the composer as a read-only card.
      // This is the sole in-flight representation (steerActiveSession no longer
      // writes a transcript line); it clears when the turn drains or ends.
      setSteerCardsBySessionId((prev) => ({
        ...prev,
        [steerSessionId]: [...(prev[steerSessionId] ?? []), { id: cardId, text: message }],
      }));
      void steerActiveSession(steerSessionId, message)
        .then(() => {
          steerEntry.accepted = true;
        })
        .catch((err: unknown) => {
          // A rejected steer (common during a no-tool phase) is not fatal — the
          // completion fallback still delivers it. Don't alarm the user.
          if (import.meta.env.DEV) {
            // biome-ignore lint/suspicious/noConsole: dev-only steer-rejection diagnostic
            console.debug("[steer] rejected; will deliver as follow-up", err);
          }
        });
      clearComposerDraft();
      composerEditorRef.current?.focus();
      return;
    }
    // The composer's category chip makes this a report: wrap the prompt to
    // frame it for the team and queue the delivery. Captured before the
    // composer clears so a failed send can restore the chip on retry.
    const reportFollowUpSessionId =
      !reportCategory && !newSessionModeRef.current && selectedHermesSessionId
        ? selectedHermesSessionId
        : null;
    const reportFollowUp = reportFollowUpSessionId
      ? reviewableIssueReportsRef.current[reportFollowUpSessionId]
      : undefined;
    const submittedDraftKey = composerDraftKeyRef.current;
    // A hero submit plays the teardown transition: greeting up, suggestions
    // down during the session-create latency. Without it they sit frozen
    // through the wait and then vanish in a single frame when the
    // conversation takes over.
    if (heroMode) setHeroLeaving(true);
    setSubmittingHermesSessionId(
      newSessionModeRef.current ? null : (selectedHermesSessionId ?? null),
    );
    setSubmitting(true);
    let clearedDraft = false;
    let clearedAttachments = false;
    let submittedAttachments = attachments;
    let preparedForRecovery: PreparedComposerSubmission | undefined;
    let clearedIssueReportReview:
      | {
          sessionId: string;
          report: PendingIssueReport;
          queuedReport?: PendingIssueReport;
          deliveryWasSubmitting: boolean;
        }
      | undefined;
    try {
      // Keep the post-Send typing position at the end while async skill and
      // attachment preparation runs. A user can immediately continue editing
      // the still-visible draft without their text jumping to the front.
      composerEditorRef.current?.focus();
      const prepared = await prepareComposerSubmission(message, attachments);
      if (composerDispatchWasInvalidated(sentDispatchReservation)) return;
      const runtimeContent = reportCategory
        ? categoryPrompt(reportCategory, prepared.runtimeContent)
        : prepared.runtimeContent;
      preparedForRecovery = { ...prepared, runtimeContent };
      const sizeWarning = oversizedComposerInputWarning({
        content: sizeEstimateContent(runtimeContent, selectedHermesSessionId ?? undefined),
        inputSignature: submittedComposerInputSignature,
        attachments,
        model: generationModel,
        models: generationModels,
      });
      if (sizeWarning && composerSizeProceedSignatureRef.current !== sizeWarning.signature) {
        setComposerSizeWarning(sizeWarning);
        composerEditorRef.current?.focus();
        return;
      }
      const nextIssueReport: PendingIssueReport | undefined = reportCategory
        ? {
            category: reportCategory,
            // An attachments-only send has no typed text, but the server
            // requires a description; the report must not bounce there.
            description: prepared.typedMessage || ISSUE_REPORT_ATTACHMENTS_ONLY_DESCRIPTION,
            followUps: [],
            attachmentNames: attachments.map((attachment) => attachment.name),
            attachmentPaths: attachments.map((attachment) => attachment.path),
          }
        : reportFollowUp
          ? appendIssueReportFollowUp(
              reportFollowUp,
              prepared.typedMessage,
              attachments.map((attachment) => attachment.name),
              attachments.map((attachment) => attachment.path),
            )
          : undefined;
      const liveComposerIsFinal =
        composerEditorRef.current?.flushPendingChange({
          changeKey: composerDraftKeyRef.current,
        }) ?? true;
      if (
        liveComposerIsFinal &&
        draftRef.current.trim() === message &&
        categoryRef.current === reportCategory
      ) {
        composerEditorRef.current?.clear();
        setDraft("");
        setCategory(null);
        draftRef.current = "";
        categoryRef.current = null;
        forgetComposerDraft(submittedDraftKey);
        clearedDraft = true;
      }
      if (sameAgentAttachments(attachmentsRef.current, attachments)) {
        setComposerAttachments([]);
        clearedAttachments = true;
      }
      if (reportFollowUpSessionId && reportFollowUp) {
        setReviewableIssueReport(reportFollowUpSessionId, null);
        clearedIssueReportReview = {
          sessionId: reportFollowUpSessionId,
          report: reportFollowUp,
          queuedReport: nextIssueReport,
          deliveryWasSubmitting:
            submittingIssueReportSessionIdsRef.current.has(reportFollowUpSessionId),
        };
      }
      await submitHermesSession(runtimeContent, undefined, {
        displayContent: prepared.displayContent,
        titleContent: prepared.titleContent,
        attachments,
        modelTarget: sentModelTarget,
        dispatchReservation: sentDispatchReservation,
        onAttachmentsUpdated: (nextAttachments) => {
          submittedAttachments = nextAttachments;
        },
        ...(nextIssueReport ? { issueReport: nextIssueReport } : {}),
      });
      if (composerDispatchWasInvalidated(sentDispatchReservation)) return;
      if (reportFollowUpSessionId) {
        deferredFailedIssueReportDeliverySessionIdsRef.current.delete(reportFollowUpSessionId);
      }
      setError(null);
      toast.dismiss(SESSION_BUSY_TOAST_ID);
    } catch (err) {
      if (composerDispatchWasInvalidated(sentDispatchReservation)) return;
      const errorMessage = messageFromError(err);
      // A send can fail inside the trailing publish window while the user is
      // already typing their next message. Publish that live document before
      // deciding whether the failed message belongs back in the composer or
      // in Up next.
      composerEditorRef.current?.flushPendingChange({
        changeKey: composerDraftKeyRef.current,
      });
      const composerHasNewInput = Boolean(
        !(composerEditorRef.current?.isEmpty() ?? true) ||
          draftRef.current.trim() ||
          categoryRef.current ||
          attachmentsRef.current.length,
      );
      let recoveredInFollowUpQueue = false;
      // Restore the composer so a failed send doesn't eat the message, its
      // category chip, or its attachments. A model switch can wait for Hermes
      // to become idle, so the user may already be writing the next draft when
      // it eventually fails. Keep that newer input untouched and retain the
      // failed submission as an explicit, retryable Up next item instead.
      if (clearedDraft) {
        const retainedStoredSessionId = sentModelTarget.targetStoredSessionId;
        const failedQueueKey = sentStartedNewSession
          ? retainedStoredSessionId &&
            !newSessionModeRef.current &&
            selectedHermesSessionIdRef.current === retainedStoredSessionId
            ? retainedStoredSessionId
            : NEW_SESSION_RECOVERY_QUEUE_KEY
          : retainedStoredSessionId;
        if (
          composerHasNewInput &&
          failedQueueKey &&
          preparedForRecovery &&
          !reportCategory &&
          !clearedIssueReportReview
        ) {
          enqueueFailedComposerFollowUp(
            failedQueueKey,
            preparedForRecovery,
            submittedAttachments,
            sentModelTarget,
            errorMessage,
            sentDispatchOrder,
          );
          recoveredInFollowUpQueue = true;
        } else if (!composerHasNewInput && (composerEditorRef.current?.isEmpty() ?? true)) {
          composerEditorRef.current?.setContent(message, reportCategory);
          rememberComposerDraft(
            composerDraftKeyRef.current ?? submittedDraftKey,
            message,
            reportCategory,
            attachments,
          );
        }
      }
      if (clearedAttachments && !recoveredInFollowUpQueue) {
        // A blocked image attach carries the failed-status chips so the user
        // sees which image didn't go through; fall back to the originals
        // otherwise.
        const restore = err instanceof AttachBlockedError ? err.attachments : submittedAttachments;
        setComposerAttachments((current) => (current.length ? current : restore));
      }
      if (clearedIssueReportReview) {
        const shouldRestoreIssueReportReview =
          !clearedIssueReportReview.deliveryWasSubmitting ||
          submittingIssueReportSessionIdsRef.current.has(clearedIssueReportReview.sessionId) ||
          deferredFailedIssueReportDeliverySessionIdsRef.current.has(
            clearedIssueReportReview.sessionId,
          );
        if (clearedIssueReportReview.queuedReport) {
          dispatchIssueReportFollowUpSubmitFailed({
            sessionId: clearedIssueReportReview.sessionId,
            queuedReport: clearedIssueReportReview.queuedReport,
            ...(shouldRestoreIssueReportReview
              ? { restoreReport: clearedIssueReportReview.report }
              : {}),
          });
        }
        if (shouldRestoreIssueReportReview) {
          deferredFailedIssueReportDeliverySessionIdsRef.current.delete(
            clearedIssueReportReview.sessionId,
          );
          setReviewableIssueReport(
            clearedIssueReportReview.sessionId,
            clearedIssueReportReview.report,
          );
        }
      }
      if (isSessionBusyError(err)) {
        // A busy rejection is proof the gateway is healthy — retire any stale
        // connection banner along with showing the nudge.
        setError(null);
        toast(SESSION_BUSY_NOTICE, { id: SESSION_BUSY_TOAST_ID });
      } else {
        setError(errorMessage);
      }
    } finally {
      cancelComposerDispatch(sentDispatchReservation);
      setSubmitting(false);
      setSubmittingHermesSessionId(null);
      // On success the hero is gone; on failure this fades the greeting and
      // suggestions back in behind the restored draft.
      setHeroLeaving(false);
      // Keep the typing flow after a send: a new-session send re-mounts the
      // composer, so defer a frame to focus the live instance — otherwise focus
      // is dropped and can land on the always-on-top agent HUD.
      window.requestAnimationFrame(() => composerEditorRef.current?.focus());
    }
  }

  return submit;
}
