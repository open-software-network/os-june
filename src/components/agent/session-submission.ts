import { shouldBlockTextOnFunding, type TextFundingModelContext } from "../../lib/account-gate";
import {
  getActiveHermesProfileName,
  refreshActiveHermesProfile,
} from "../../lib/active-hermes-profile";
import { dispatchAgentSessionStatus } from "../../lib/agent-events";
import { prepareProjectPrompt } from "../../lib/agent-project-context";
import { startAgentRunMonitoring } from "../../lib/agent-run-monitor";
import { rememberSessionMode, sessionUnrestricted } from "../../lib/agent-session-modes";
import { withTimeout } from "../../lib/async-timeout";
import { toolsetsForComputerUseAgentRun } from "../../lib/computer-use-agent-run";
import { messageFromError } from "../../lib/errors";
import { titleFromPrompt } from "../../lib/hermes-adapter";
import { hasHermesActiveSessionSnapshotSubscribers } from "../../lib/hermes-active-session-snapshots";
import { isSessionBusyError } from "../../lib/hermes-gateway";
import { pendingImageAttachments } from "../../lib/hermes-image-attach";
import { submitHermesRun } from "../../lib/hermes-run-submission";
import {
  type HermesSessionDispatchReservation,
  reserveHermesSessionDispatch,
} from "../../lib/hermes-session-dispatch-mutex";
import {
  hermesModelIdForSelection,
  markSessionModelSelectionApplied,
  readSessionModelSelections,
  rememberAppliedSessionModelSelection,
  type SessionModelSelection,
  stageSessionModelSelection,
} from "../../lib/hermes-session-model-selection";
import { hermesTraceBuffer } from "../../lib/hermes-trace-buffer";
import { modelSupportsImageInput } from "../../lib/model-privacy";
import {
  assignSessionToProfile,
  computerUseBeginRun,
  ensureHermesBridgeSession,
  type HermesSessionInfo,
  type HermesSessionMessage,
} from "../../lib/tauri";
import { rememberSessionThinkingLevel, thinkingEffortForLevel } from "../../lib/thinking-level";
import { AUTO_MODEL_ID } from "../settings/ModelPickerDialog";
import type { PendingIssueReport } from "./agent-session-continuity";
import type { AgentAttachment } from "./agent-workspace-models";
import { unsupportedImageInputPrompt } from "./composer/composer-input-helpers";
import {
  type CapturedSessionModelTarget,
  sameSessionModelSelection,
} from "./composer/follow-up-queue";
import {
  markStoredVideoSlashContextsSent,
  promptSubmitContentWithFastPathImageContext,
  storedPendingImageSlashAttachments,
  storedPendingVideoSlashContexts,
  uniqueAttachmentsByWorkspacePath,
  withVideoFastPathContext,
} from "./composer/media-slash-persistence";

import type { SubmitHermesSessionDependencies } from "./session-submission-types";

export function createSubmitHermesSession(dependencies: SubmitHermesSessionDependencies) {
  const {
    AGENT_TITLE_MAX_CHARS,
    agentSessionTitleForPrompt,
    applyInitialSessionTitleSuggestion,
    applyThinkingLevelToSession,
    attachHermesSessionEventListener,
    attachPendingImages,
    captureSessionModelTarget,
    clearHeldFastPathImages,
    clearBackgroundSessionTitleGuard,
    commitSessionModelSelections,
    creditActionsDisabledReason,
    defaultGenerationModelIdRef,
    ensureHermesGateway,
    fullModeDraftRef,
    generationCostQualityRef,
    generationModelsRef,
    generationSelectionIntentRevisionRef,
    hermesSessionItemsRef,
    hermesSessionsHydratedRef,
    loadHermesSessions,
    migrateOptimisticHermesSession,
    newSessionModeRef,
    pendingFastPathImagesRef,
    pendingHermesMessagesRef,
    pendingIssueReportsRef,
    profileOwnedSessionIdsRef,
    projectContext,
    projectContextSignaturesBySessionId,
    recordSessionErrorActivity,
    recordSessionRunningActivity,
    releaseComputerUseRun,
    rememberComputerUseRun,
    removeOptimisticHermesSession,
    resolveSessionProjectContext,
    runtimeSessionIdsRef,
    selectedHermesSessionIdRef,
    sessionGatewayUnlistenRef,
    sessionModelSelectionsRef,
    sessionThinkingAppliedRef,
    sessionThinkingEfforts,
    sessionThinkingEffortsRef,
    setHermesSessionItems,
    setNewSessionMode,
    setPendingHermesMessages,
    setRuntimeSessionIds,
    setSelectedHermesSessionId,
    setSelectedTaskId,
    startOptimisticHermesSession,
    thinkingLevelRef,
    veniceApiKeyConfiguredRef,
  } = dependencies;

  async function submitHermesSession(
    content: string,
    explicitSession?: HermesSessionInfo,
    options?: {
      issueReport?: PendingIssueReport;
      displayContent?: string;
      titleContent?: string;
      /** Imported attachments for this turn. Image attachments are sent to the
       * session via the structured image attach flow (feature 19) once the
       * session id is known and before prompt.submit; a failed attach throws to
       * block the send so the user can retry. */
      attachments?: AgentAttachment[];
      /** Background follow-ups must not pull the user into their session. */
      selectSession?: boolean;
      /** Persist structured image attach state before prompt.submit so a retry
       * does not attach the same image twice. */
      onAttachmentsUpdated?: (attachments: AgentAttachment[]) => void;
      /** Model choice captured synchronously when the user pressed Send. */
      modelTarget?: CapturedSessionModelTarget;
      /** FIFO slot captured at the same Send boundary as `modelTarget`. */
      dispatchReservation?: HermesSessionDispatchReservation;
      /** Create + select the session and add the user bubble, then stop BEFORE
       * `prompt.submit` (the `/image` flow): the model is never invoked, and the
       * caller renders the result itself. Returns the stored session id so the
       * caller can attach its own turns. Forces the non-optimistic create path so
       * the selected id is the canonical stored id (optimistic migration doesn't
       * move the selection). */
      skipPrompt?: boolean;
    },
  ): Promise<string | undefined> {
    const modelTarget = options?.modelTarget ?? captureSessionModelTarget(explicitSession);
    const targetCatalogModel = generationModelsRef.current.find(
      (model) => model.id === modelTarget.selection.modelId,
    );
    const targetTextFundingContext: TextFundingModelContext = {
      activeModelId: modelTarget.selection.modelId || undefined,
      activeModel: targetCatalogModel,
      veniceApiKeyConfigured: veniceApiKeyConfiguredRef.current,
    };
    if (
      creditActionsDisabledReason &&
      !options?.skipPrompt &&
      shouldBlockTextOnFunding(true, targetTextFundingContext)
    ) {
      throw new Error(creditActionsDisabledReason);
    }
    const displayContent = options?.displayContent ?? content;
    // Explicit-target submissions (background steer/attachment delivery, CLI
    // notices) must use the TARGET session's project, never the ambient one —
    // the user may have a different project session open by then. The ambient
    // context still covers the new-session flow, where the filing is applied
    // only after Hermes returns the session id.
    const submittedProjectContext = explicitSession ? undefined : projectContext;
    const titleContent = options?.titleContent ?? displayContent;
    let attachmentOnlyTitle: string | undefined;
    if (!titleContent.trim() && options?.attachments?.length) {
      const firstName = options.attachments[0].name.trim();
      const extensionIndex = firstName.lastIndexOf(".");
      const firstDisplayName = (
        extensionIndex > 0 ? firstName.slice(0, extensionIndex) : firstName
      ).trim();
      const title =
        options.attachments.length === 1
          ? firstDisplayName
          : `${firstDisplayName} +${options.attachments.length - 1} more`;
      // Array.from splits on Unicode code points, so the cap cannot cut an
      // emoji or surrogate pair in half the way String.slice would.
      attachmentOnlyTitle = Array.from(title.replace(/\s+/g, " "))
        .slice(0, AGENT_TITLE_MAX_CHARS)
        .join("")
        .replace(/[–—]/g, "-")
        .replace(/^([a-z])/, (match) => match.toUpperCase());
    }
    const targetStoredSessionId = modelTarget.targetStoredSessionId ?? undefined;
    const submitFullMode = targetStoredSessionId
      ? sessionUnrestricted(targetStoredSessionId)
      : fullModeDraftRef.current;
    let dispatchReservation =
      options?.dispatchReservation ??
      (targetStoredSessionId ? reserveHermesSessionDispatch(targetStoredSessionId) : undefined);
    const targetSessionModelSelection = modelTarget.selection;
    const targetSessionModelId = modelTarget.hermesModelId;
    const targetSessionModelRevision = modelTarget.revision;
    const shouldApplySessionModel = modelTarget.shouldApply;
    // JUN-171 (Phase A): fold any held fast-path `/image` outputs for this
    // session into the turn so they ride the same structured-attach path as
    // composer images and enter the model's context. Never on the skipPrompt
    // (`/image`) path itself — that would flush a prior image with no following
    // prompt (the semantics ADR 0003 decision 2 deliberately avoids).
    const heldFastPathImages =
      options?.skipPrompt || !targetStoredSessionId
        ? []
        : uniqueAttachmentsByWorkspacePath([
            ...(pendingFastPathImagesRef.current[targetStoredSessionId] ?? []),
            ...storedPendingImageSlashAttachments(targetStoredSessionId),
          ]);
    // The video counterpart of the fold above, gated the same way (never on
    // the skipPrompt fast path itself, only on a real follow-up prompt).
    const heldVideoContexts =
      options?.skipPrompt || !targetStoredSessionId
        ? []
        : storedPendingVideoSlashContexts(targetStoredSessionId);
    const agentRunAttachments = [...(options?.attachments ?? []), ...heldFastPathImages];
    const pendingImages = pendingImageAttachments(
      agentRunAttachments.map((attachment) => attachment.attach),
    );
    // Resolve strictly from the catalog: selectedModelOption synthesizes a
    // zero-capability stub for an unknown id, which would read as non-vision and
    // wrongly downgrade a vision-capable (but stale/not-yet-loaded) model. find
    // returns undefined when unresolved so the guard below skips the fallback.
    const targetGenerationModel = targetSessionModelSelection.modelId
      ? generationModelsRef.current.find(
          (model) => model.id === targetSessionModelSelection.modelId,
        )
      : undefined;
    const imageInputFallbackContent =
      // Only downgrade to the text-only fallback when the model is KNOWN to lack
      // image input. An unresolved model id (stale or not-yet-loaded catalog)
      // must NOT be assumed non-vision, or a vision-capable session would
      // silently drop the image and never call attachPendingImages. Mirrors the
      // composer banner's `!!generationModel && !modelSupportsImageInput` guard.
      pendingImages.length &&
      targetGenerationModel &&
      !modelSupportsImageInput(targetGenerationModel)
        ? unsupportedImageInputPrompt({
            displayContent,
            imageNames: pendingImages.map((attachment) => attachment.displayName),
            modelName: targetGenerationModel?.name ?? targetSessionModelSelection.modelId,
            runtimeContent: content,
          })
        : undefined;
    const promptSubmitContent = withVideoFastPathContext(
      promptSubmitContentWithFastPathImageContext(
        imageInputFallbackContent ?? content,
        heldFastPathImages,
      ),
      heldVideoContexts,
    );
    const agentRunToolsets =
      options?.issueReport || options?.skipPrompt
        ? null
        : toolsetsForComputerUseAgentRun(displayContent);
    // Start the AI title request early, but never put it on the prompt's
    // critical path. The session starts with the deterministic fallback and
    // the suggestion patches it in the background once a stored id exists.
    // Issue reports and attachment-only sessions already have suitable titles.
    const initialTitleSuggestionPromise =
      targetStoredSessionId || options?.issueReport || attachmentOnlyTitle
        ? undefined
        : agentSessionTitleForPrompt(titleContent);
    const listedTargetSession = targetStoredSessionId
      ? hermesSessionItemsRef.current.find((session) => session.id === targetStoredSessionId)
      : undefined;
    const fallbackSessionTitle = targetStoredSessionId
      ? explicitSession?.title?.trim() ||
        explicitSession?.preview?.trim() ||
        listedTargetSession?.title?.trim() ||
        listedTargetSession?.preview?.trim() ||
        titleFromPrompt(titleContent)
      : options?.issueReport
        ? "Issue report"
        : attachmentOnlyTitle || titleFromPrompt(titleContent);
    const optimisticSession =
      targetStoredSessionId || options?.skipPrompt
        ? undefined
        : startOptimisticHermesSession({
            displayContent,
            title: fallbackSessionTitle,
            ...(targetSessionModelId ? { model: targetSessionModelId } : {}),
          });
    let storedSessionIdForRollback: string | undefined;
    let pendingUserMessage: HermesSessionMessage | undefined;
    let promptStageStarted = false;
    let preparedProjectContextSignature: string | null | undefined;
    let scopedAgentRunToolsets = agentRunToolsets;
    let createdSessionModelId: string | undefined;
    const sessionDisplayTitle = fallbackSessionTitle;
    const queuedIssueReport = options?.issueReport;
    if (queuedIssueReport && targetStoredSessionId) {
      queuedIssueReport.diagnosisStartedAt = new Date().toISOString();
    }
    const clearQueuedIssueReport = () => {
      const storedSessionId = storedSessionIdForRollback;
      if (
        storedSessionId &&
        queuedIssueReport &&
        pendingIssueReportsRef.current.get(storedSessionId) === queuedIssueReport
      ) {
        pendingIssueReportsRef.current.delete(storedSessionId);
      }
    };
    const rollbackOptimisticBeforePrompt = (err: unknown): never => {
      dispatchReservation?.cancel();
      if (optimisticSession) {
        removeOptimisticHermesSession(optimisticSession.id, storedSessionIdForRollback);
      }
      throw err;
    };
    // The Unrestricted opt-in is made per session: a new session applies the
    // picker draft, and a follow-up routes to the runtime process matching
    // the mode its session was created with. Without this, one Unrestricted
    // session would leave the runtime unsandboxed under every other
    // session's follow-ups.
    const [gateway] = await Promise.all([
      ensureHermesGateway(submitFullMode),
      // Re-read the sticky active profile for every brand-new session so an
      // out-of-band switch is honored without a workspace remount. Both
      // runtimes share one Hermes home, so the value is mode-independent.
      targetStoredSessionId
        ? Promise.resolve()
        : refreshActiveHermesProfile({
            mode: submitFullMode ? "unrestricted" : "sandboxed",
          }),
    ]).catch(rollbackOptimisticBeforePrompt);
    const nextUnderProfileName = targetStoredSessionId ? undefined : getActiveHermesProfileName();
    const underProfile = nextUnderProfileName !== undefined && nextUnderProfileName !== "default";

    try {
      const runResult = await submitHermesRun<string>({
        fullMode: submitFullMode,
        gateway,
        reconnectGateway: () => ensureHermesGateway(submitFullMode),
        shouldProbeFirstRequest: () => !hasHermesActiveSessionSnapshotSubscribers(submitFullMode),
        storedSessionId: targetStoredSessionId,
        runtimeSessionId: targetStoredSessionId
          ? runtimeSessionIdsRef.current[targetStoredSessionId]
          : undefined,
        dispatchReservation,
        ...(!targetStoredSessionId
          ? {
              createSession: () => ({
                params: {
                  title: sessionDisplayTitle,
                  cols: 96,
                  // A named profile owns its text model and reasoning effort.
                  ...(targetSessionModelId && !underProfile ? { model: targetSessionModelId } : {}),
                  ...(!underProfile
                    ? { reasoningEffort: thinkingEffortForLevel(thinkingLevelRef.current) }
                    : {}),
                  ...(underProfile && nextUnderProfileName
                    ? { profile: nextUnderProfileName }
                    : {}),
                  ...(agentRunToolsets && !underProfile
                    ? { enabledToolsets: agentRunToolsets }
                    : {}),
                },
                ...(underProfile && nextUnderProfileName
                  ? {
                      profileAssignment: {
                        profile: nextUnderProfileName,
                        assign: assignSessionToProfile,
                      },
                    }
                  : {}),
              }),
            }
          : {}),
        onSessionCreated: ({ dispatchReservation: activeReservation, storedSessionId }) => {
          storedSessionIdForRollback = storedSessionId;
          dispatchReservation = activeReservation;
          clearBackgroundSessionTitleGuard(storedSessionId);
        },
        onSessionResolved: async ({
          created,
          createdUnderProfile,
          dispatchReservation: activeReservation,
          storedSessionId,
        }) => {
          storedSessionIdForRollback = storedSessionId;
          dispatchReservation = activeReservation;
          if (createdUnderProfile) {
            profileOwnedSessionIdsRef.current.add(storedSessionId);
          }
          scopedAgentRunToolsets =
            createdUnderProfile || profileOwnedSessionIdsRef.current.has(storedSessionId)
              ? null
              : agentRunToolsets;
          createdSessionModelId = createdUnderProfile ? undefined : targetSessionModelId;
          // The provisional new-session target becomes durable as soon as
          // session.create resolves, so later recovery stays on this session.
          if (!modelTarget.targetStoredSessionId) {
            modelTarget.targetStoredSessionId = storedSessionId;
          }
          if (created && !createdUnderProfile) {
            const createdLevel = thinkingLevelRef.current;
            sessionThinkingEffortsRef.current = {
              ...sessionThinkingEfforts(),
              [storedSessionId]: createdLevel,
            };
            rememberSessionThinkingLevel(storedSessionId, createdLevel);
            sessionThinkingAppliedRef.current = {
              ...sessionThinkingAppliedRef.current,
              [storedSessionId]: {
                runtimeId: created.session_id ?? "",
                effort: thinkingEffortForLevel(createdLevel),
              },
            };
          }
          if (queuedIssueReport) {
            pendingIssueReportsRef.current.set(storedSessionId, queuedIssueReport);
          }
          if (!targetStoredSessionId) {
            rememberSessionMode(storedSessionId, fullModeDraftRef.current);
          }
          const ensureStoredHermesSession = () =>
            ensureHermesBridgeSession({
              sessionId: storedSessionId,
              ...(!targetStoredSessionId ? { title: sessionDisplayTitle } : {}),
              ...(createdSessionModelId ? { model: createdSessionModelId } : {}),
            });
          if (optimisticSession) {
            await ensureStoredHermesSession().catch(rollbackOptimisticBeforePrompt);
            migrateOptimisticHermesSession({
              clearModel: Boolean(createdUnderProfile),
              createdAt: optimisticSession.createdAt,
              displayContent,
              fromSessionId: optimisticSession.id,
              ...(createdSessionModelId ? { model: createdSessionModelId } : {}),
              title: sessionDisplayTitle,
              toSessionId: storedSessionId,
            });
          }
          if (initialTitleSuggestionPromise) {
            void applyInitialSessionTitleSuggestion(storedSessionId, initialTitleSuggestionPromise);
          }
          if (!targetStoredSessionId && !options?.skipPrompt && !createdUnderProfile) {
            const latestDefaultSelection: SessionModelSelection = {
              modelId: defaultGenerationModelIdRef.current,
              ...(defaultGenerationModelIdRef.current === AUTO_MODEL_ID &&
              generationCostQualityRef.current !== undefined
                ? { costQuality: generationCostQualityRef.current }
                : {}),
            };
            const defaultChangedAfterSend =
              modelTarget.globalIntentRevision !== generationSelectionIntentRevisionRef.current &&
              latestDefaultSelection.modelId &&
              !sameSessionModelSelection(latestDefaultSelection, targetSessionModelSelection);
            if (defaultChangedAfterSend && !sessionModelSelectionsRef.current[storedSessionId]) {
              commitSessionModelSelections(
                stageSessionModelSelection(storedSessionId, latestDefaultSelection),
              );
            }
            commitSessionModelSelections(
              rememberAppliedSessionModelSelection(storedSessionId, targetSessionModelSelection),
            );
          }
          if (!optimisticSession) {
            await withTimeout(ensureStoredHermesSession(), 2500).catch(() => undefined);
          }
        },
        applyThinkingLevel: async ({ runtimeSessionId, storedSessionId, submitGateway }) => {
          // Re-assert a stored level only at this ordered run boundary.
          const thinkingSessionLevel = sessionThinkingEfforts()[storedSessionId];
          if (thinkingSessionLevel) {
            await applyThinkingLevelToSession(
              storedSessionId,
              thinkingSessionLevel,
              runtimeSessionId,
              submitGateway,
            );
          }
        },
        model: {
          mode: submitFullMode ? "unrestricted" : "sandboxed",
          modelId: targetSessionModelId,
          shouldApply: ({ dispatchReservation: activeReservation, storedSessionId }) => {
            // Re-read under the cross-surface FIFO because Note Chat may have
            // changed the live model after this Send captured its target.
            const currentModelEntry = readSessionModelSelections()[storedSessionId];
            const currentStoredModelId = currentModelEntry?.appliedSelection
              ? hermesModelIdForSelection(currentModelEntry.appliedSelection)
              : undefined;
            return (
              !options?.skipPrompt &&
              (shouldApplySessionModel ||
                activeReservation.queuedBehindPrior ||
                (Boolean(targetStoredSessionId) &&
                  currentStoredModelId !== undefined &&
                  currentStoredModelId !== targetSessionModelId))
            );
          },
          onApplied: ({ storedSessionId }) => {
            if (targetSessionModelRevision !== undefined) {
              commitSessionModelSelections(
                markSessionModelSelectionApplied(
                  storedSessionId,
                  targetSessionModelRevision,
                  targetSessionModelSelection,
                ),
              );
            } else {
              commitSessionModelSelections(
                rememberAppliedSessionModelSelection(storedSessionId, targetSessionModelSelection),
              );
            }
            const applyModel = (sessions: HermesSessionInfo[]) =>
              sessions.map((session) =>
                session.id === storedSessionId
                  ? { ...session, model: targetSessionModelId }
                  : session,
              );
            hermesSessionItemsRef.current = applyModel(hermesSessionItemsRef.current);
            setHermesSessionItems((current) => applyModel(current));
          },
        },
        attach: async ({ runtimeSessionId, storedSessionId, submitGateway }) => {
          if (imageInputFallbackContent) return;
          try {
            const updatedAttachments = await attachPendingImages(
              submitGateway,
              runtimeSessionId,
              storedSessionId,
              agentRunAttachments,
            );
            options?.onAttachmentsUpdated?.(updatedAttachments);
          } catch (err) {
            clearQueuedIssueReport();
            rollbackOptimisticBeforePrompt(err);
          }
        },
        preparePrompt: ({ runtimeSessionId, storedSessionId }) => {
          const createdAt = optimisticSession?.createdAt ?? new Date().toISOString();
          setRuntimeSessionIds((current) => ({
            ...current,
            [storedSessionId]: runtimeSessionId,
          }));
          if (!optimisticSession) {
            if (!targetStoredSessionId && options?.skipPrompt) {
              const latestDefaultSelection: SessionModelSelection = {
                modelId: defaultGenerationModelIdRef.current,
                ...(defaultGenerationModelIdRef.current === AUTO_MODEL_ID &&
                generationCostQualityRef.current !== undefined
                  ? { costQuality: generationCostQualityRef.current }
                  : {}),
              };
              const defaultChangedAfterSend =
                modelTarget.globalIntentRevision !== generationSelectionIntentRevisionRef.current &&
                latestDefaultSelection.modelId &&
                !sameSessionModelSelection(latestDefaultSelection, targetSessionModelSelection);
              if (defaultChangedAfterSend) {
                commitSessionModelSelections(
                  stageSessionModelSelection(storedSessionId, latestDefaultSelection),
                );
              }
              commitSessionModelSelections(
                rememberAppliedSessionModelSelection(storedSessionId, targetSessionModelSelection),
              );
            }
            if (options?.selectSession !== false) {
              newSessionModeRef.current = false;
              setNewSessionMode(false);
              selectedHermesSessionIdRef.current = storedSessionId;
              setSelectedHermesSessionId(storedSessionId);
              setSelectedTaskId(undefined);
            }
            const optimisticSessionItem: HermesSessionInfo = {
              id: storedSessionId,
              title: sessionDisplayTitle,
              preview: displayContent,
              started_at: createdAt,
              last_active: createdAt,
              message_count: 1,
              ...(createdSessionModelId ? { model: createdSessionModelId } : {}),
            };
            setHermesSessionItems((current) => {
              const existingSession = current.find((session) => session.id === storedSessionId);
              if (existingSession) {
                const mergedSession: HermesSessionInfo = targetStoredSessionId
                  ? {
                      ...existingSession,
                      title: existingSession.title?.trim()
                        ? existingSession.title
                        : sessionDisplayTitle,
                      preview: displayContent,
                      last_active: createdAt,
                      message_count:
                        typeof existingSession.message_count === "number"
                          ? existingSession.message_count + 1
                          : optimisticSessionItem.message_count,
                      ...(targetSessionModelId && !existingSession.model?.trim()
                        ? { model: targetSessionModelId }
                        : {}),
                    }
                  : { ...existingSession, ...optimisticSessionItem };
                return current.map((session) =>
                  session.id === storedSessionId ? mergedSession : session,
                );
              }
              return [optimisticSessionItem, ...current];
            });
          }
          pendingUserMessage = {
            id: optimisticSession?.userMessage.id ?? `pending:user:${Date.now()}`,
            role: "user",
            content: displayContent,
            timestamp: createdAt,
          };
          if (!optimisticSession && !options?.skipPrompt) {
            setPendingHermesMessages((current) => {
              const next = {
                ...current,
                [storedSessionId]: [
                  ...(current[storedSessionId] ?? []),
                  pendingUserMessage as HermesSessionMessage,
                ],
              };
              pendingHermesMessagesRef.current = next;
              return next;
            });
          }
          // `/image` creates/selects the session and presents the user bubble
          // without starting an agent run.
          if (options?.skipPrompt) return undefined;
          promptStageStarted = true;
          recordSessionRunningActivity(storedSessionId);
          dispatchAgentSessionStatus({
            sessionId: storedSessionId,
            title: sessionDisplayTitle,
            prompt: displayContent,
            status: "running",
            summary: "June is working.",
          });
          const targetProjectContext = explicitSession
            ? resolveSessionProjectContext?.(storedSessionId)
            : submittedProjectContext;
          const preparedProjectPrompt = prepareProjectPrompt(
            promptSubmitContent,
            targetProjectContext,
            projectContextSignaturesBySessionId.get(storedSessionId),
          );
          preparedProjectContextSignature = preparedProjectPrompt.contextSignature;
          return {
            text: preparedProjectPrompt.text,
            ...(scopedAgentRunToolsets ? { enabledToolsets: scopedAgentRunToolsets } : {}),
          };
        },
        runLease: {
          begin: async ({ storedSessionId }) => {
            const runLeaseId = `${storedSessionId}:${crypto.randomUUID()}`;
            await computerUseBeginRun(runLeaseId);
            try {
              rememberComputerUseRun(storedSessionId, runLeaseId);
              return runLeaseId;
            } catch (err) {
              await releaseComputerUseRun(storedSessionId, runLeaseId);
              throw err;
            }
          },
          release: ({ storedSessionId }, runLeaseId) =>
            releaseComputerUseRun(storedSessionId, runLeaseId),
        },
        beforePrompt: (
          { runtimeSessionId, storedSessionId, submitGateway },
          prompt,
          computerUseRunLeaseId,
        ) => {
          attachHermesSessionEventListener({
            gateway: submitGateway.currentGateway(),
            runtimeSessionId,
            sessionDisplayTitle,
            storedSessionId,
            computerUseRunLeaseId,
          });
          hermesTraceBuffer.recordOutbound({
            sessionId: storedSessionId,
            method: "prompt.submit",
            params: { session_id: runtimeSessionId, text: prompt.text },
          });
        },
        afterPromptAcknowledged: async ({ runtimeSessionId, storedSessionId }) => {
          startAgentRunMonitoring({
            storedSessionId,
            runtimeSessionId,
            title: sessionDisplayTitle,
            fullMode: sessionUnrestricted(storedSessionId),
            settlementHeld: true,
          });
          if (preparedProjectContextSignature !== undefined) {
            projectContextSignaturesBySessionId.set(
              storedSessionId,
              preparedProjectContextSignature,
            );
          }
          clearHeldFastPathImages(storedSessionId, heldFastPathImages);
          markStoredVideoSlashContextsSent(
            storedSessionId,
            heldVideoContexts.map((videoContext) => videoContext.id),
          );
          await loadHermesSessions({
            suppressStartupRequestError: !hermesSessionsHydratedRef.current,
          });
        },
      });

      // The shared module returns normally after acknowledgement even if a
      // local monitoring/session refresh hook failed afterwards.
      return options?.skipPrompt ? runResult.storedSessionId : undefined;
    } catch (err) {
      clearQueuedIssueReport();
      const storedSessionId = storedSessionIdForRollback;
      if (!promptStageStarted || !storedSessionId || !pendingUserMessage) {
        if (optimisticSession) {
          removeOptimisticHermesSession(optimisticSession.id, storedSessionId);
        }
        throw err;
      }

      hermesTraceBuffer.recordError({
        sessionId: storedSessionId,
        method: "prompt.submit",
        message: messageFromError(err),
      });
      setPendingHermesMessages((current) => {
        const next = {
          ...current,
          [storedSessionId]: (current[storedSessionId] ?? []).filter(
            (message) => message.id !== pendingUserMessage?.id,
          ),
        };
        pendingHermesMessagesRef.current = next;
        return next;
      });
      if (isSessionBusyError(err)) {
        // The prior agent run still owns the session. Keep its listener and
        // working state; callers translate this into the composer notice.
        throw err;
      }
      sessionGatewayUnlistenRef.current.get(storedSessionId)?.();
      recordSessionErrorActivity(storedSessionId, messageFromError(err));
      dispatchAgentSessionStatus({
        sessionId: storedSessionId,
        title: sessionDisplayTitle,
        status: "failed",
        summary: messageFromError(err),
      });
      throw err;
    }
  }

  return submitHermesSession;
}
