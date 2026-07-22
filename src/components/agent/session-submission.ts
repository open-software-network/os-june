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
import { messageFromError } from "../../lib/errors";
import { titleFromPrompt } from "../../lib/hermes-adapter";
import { createHermesMethods, hermesModeFor } from "../../lib/hermes-control-plane";
import { isSessionBusyError } from "../../lib/hermes-gateway";
import { pendingImageAttachments } from "../../lib/hermes-image-attach";
import { applySessionModelWhenIdle } from "../../lib/hermes-next-prompt-model";
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
import { type HermesRuntimeSessionResponse } from "./agent-session-continuity";
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
    applySessionTitleOverrides,
    applyThinkingLevelToSession,
    attachHermesSessionEventListener,
    attachPendingImages,
    captureSessionModelTarget,
    clearHeldFastPathImages,
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
    sessionTitleOverridesRef,
    sessionTitleSourceRef,
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
    // Issue reports skip title suggestion: the content is the wrapped
    // investigation prompt, which would title the session after the wrapper.
    const titlePromise =
      targetStoredSessionId || options?.issueReport
        ? undefined
        : attachmentOnlyTitle
          ? Promise.resolve(attachmentOnlyTitle)
          : agentSessionTitleForPrompt(titleContent).then((suggestion) => suggestion.title);
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
    const { created, createdUnderProfile, gateway, sessionTitle, storedSessionId } =
      await (async () => {
        const [nextGateway, nextSessionTitle] = await Promise.all([
          ensureHermesGateway(
            targetStoredSessionId
              ? sessionUnrestricted(targetStoredSessionId)
              : fullModeDraftRef.current,
          ),
          titlePromise ?? Promise.resolve(undefined),
          // Re-read the sticky active profile for every brand-new session so an
          // out-of-band switch (Hermes CLI, upstream dashboard) is honored
          // without a workspace remount. Runs in parallel with gateway setup
          // (no added wall-clock) and never throws; the store keeps the
          // last-known value on failure. Both runtimes share one Hermes home,
          // so the value is mode-independent.
          targetStoredSessionId
            ? Promise.resolve()
            : refreshActiveHermesProfile({
                mode: fullModeDraftRef.current ? "unrestricted" : "sandboxed",
              }),
        ]);
        const nextUnderProfileName = targetStoredSessionId
          ? undefined
          : getActiveHermesProfileName();
        const underProfile =
          nextUnderProfileName !== undefined && nextUnderProfileName !== "default";
        const nextCreated = targetStoredSessionId
          ? undefined
          : await nextGateway.request<HermesRuntimeSessionResponse>("session.create", {
              title: nextSessionTitle ?? fallbackSessionTitle,
              cols: 96,
              // session.create treats `model` as a per-session override.
              // Under a named profile the override would silently bypass the
              // profile's own configured text model - the point of profiles -
              // so it is omitted and the profile's model applies. The
              // thinking level's reasoning_effort follows the same rule.
              ...(targetSessionModelId && !underProfile ? { model: targetSessionModelId } : {}),
              ...(!underProfile
                ? { reasoning_effort: thinkingEffortForLevel(thinkingLevelRef.current) }
                : {}),
              ...(underProfile ? { profile: nextUnderProfileName } : {}),
            });
        const nextStoredSessionId =
          targetStoredSessionId ?? nextCreated?.stored_session_id ?? nextCreated?.session_id;
        if (!nextStoredSessionId) {
          throw new Error("Hermes did not create a session.");
        }
        return {
          created: nextCreated,
          createdUnderProfile: underProfile ? nextUnderProfileName : undefined,
          gateway: nextGateway,
          sessionTitle: nextSessionTitle,
          storedSessionId: nextStoredSessionId,
        };
      })().catch(rollbackOptimisticBeforePrompt);
    storedSessionIdForRollback = storedSessionId;
    if (createdUnderProfile) {
      await assignSessionToProfile(storedSessionId, createdUnderProfile).catch(
        rollbackOptimisticBeforePrompt,
      );
      profileOwnedSessionIdsRef.current.add(storedSessionId);
    }
    const createdSessionModelId = createdUnderProfile ? undefined : targetSessionModelId;
    const activeDispatchReservation =
      dispatchReservation ?? reserveHermesSessionDispatch(storedSessionId);
    dispatchReservation = activeDispatchReservation;
    // Once session.create returns, this Send's captured target is no longer a
    // provisional "new session". If a later attach or prompt step fails after
    // the user has started another draft, recovery can now retain the original
    // message as an Up next item on the durable session.
    if (!modelTarget.targetStoredSessionId) {
      modelTarget.targetStoredSessionId = storedSessionId;
    }
    if (created && !createdUnderProfile) {
      // Record the new session's level as its own (persisted, so a relaunch
      // still shows this chat at its level), and mark its runtime as already
      // at it: the create pinned this effort, so the re-assert path must not
      // fire a redundant config.set on the session's first turns. Skipped
      // under a named profile, where the profile's own config applies.
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
    const queuedIssueReport = options?.issueReport;
    if (queuedIssueReport && targetStoredSessionId) {
      queuedIssueReport.diagnosisStartedAt = new Date().toISOString();
    }
    const clearQueuedIssueReport = () => {
      if (
        queuedIssueReport &&
        pendingIssueReportsRef.current.get(storedSessionId) === queuedIssueReport
      ) {
        pendingIssueReportsRef.current.delete(storedSessionId);
      }
    };
    if (options?.issueReport) {
      pendingIssueReportsRef.current.set(storedSessionId, options.issueReport);
    }
    if (!targetStoredSessionId) {
      rememberSessionMode(storedSessionId, fullModeDraftRef.current);
    }
    const sessionDisplayTitle = sessionTitle || fallbackSessionTitle;
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
      // session.create already fixed the live route to the Send-time snapshot.
      // Preserve any newer staged picker choice while recording that actual
      // live route separately.
      commitSessionModelSelections(
        rememberAppliedSessionModelSelection(storedSessionId, targetSessionModelSelection),
      );
    }
    if (sessionTitle) {
      sessionTitleOverridesRef.current = {
        ...sessionTitleOverridesRef.current,
        [storedSessionId]: sessionTitle,
      };
      sessionTitleSourceRef.current = {
        ...sessionTitleSourceRef.current,
        [storedSessionId]: "prompt",
      };
      // The mount-time session load races this store: when its merge lands
      // first, the fetched placeholder title is already rendered and nothing
      // re-reads the override (the post-submit reload can no-op on a stale
      // bridge closure). Re-map the current list so the order doesn't matter.
      setHermesSessionItems((current) => applySessionTitleOverrides(current));
    }
    if (!optimisticSession) {
      await withTimeout(ensureStoredHermesSession(), 2500).catch(() => undefined);
    }
    let runtimeSessionId: string | undefined;
    try {
      runtimeSessionId =
        created?.session_id ??
        runtimeSessionIdsRef.current[storedSessionId] ??
        (
          await gateway.request<HermesRuntimeSessionResponse>("session.resume", {
            session_id: storedSessionId,
            cols: 96,
          })
        ).session_id;
    } catch (err) {
      activeDispatchReservation.cancel();
      clearQueuedIssueReport();
      if (optimisticSession) {
        removeOptimisticHermesSession(optimisticSession.id, storedSessionIdForRollback);
      }
      throw err;
    }
    if (!runtimeSessionId) {
      clearQueuedIssueReport();
      rollbackOptimisticBeforePrompt(new Error("Hermes did not resume the session."));
    }
    // A thinking level picked while this session's runtime was down (or a
    // live retune that failed) re-asserts here, before the prompt, so the
    // turn runs at the level the control shows. No-op when the current
    // runtime is already known to be at it (see applyThinkingLevelToSession).
    const thinkingSessionLevel = sessionThinkingEfforts()[storedSessionId];
    if (thinkingSessionLevel) {
      await applyThinkingLevelToSession(storedSessionId, thinkingSessionLevel, runtimeSessionId);
    }
    const dispatchPreparedSession = async (): Promise<string | undefined> => {
      // Re-read after acquiring the cross-surface lock. NoteChat may have sent
      // this same stored session and changed its live model after this Send was
      // captured; if so, restore the captured route before accepting the prompt.
      const currentModelEntry = readSessionModelSelections()[storedSessionId];
      const currentStoredModelId = currentModelEntry?.appliedSelection
        ? hermesModelIdForSelection(currentModelEntry.appliedSelection)
        : undefined;
      const mustApplyCapturedModel =
        !options?.skipPrompt &&
        (shouldApplySessionModel ||
          activeDispatchReservation.queuedBehindPrior ||
          (Boolean(targetStoredSessionId) &&
            currentStoredModelId !== undefined &&
            currentStoredModelId !== targetSessionModelId));
      if (mustApplyCapturedModel) {
        try {
          await applySessionModelWhenIdle(() =>
            createHermesMethods(gateway).switchActiveSessionModel({
              mode: hermesModeFor(storedSessionId),
              sessionId: runtimeSessionId,
              model: targetSessionModelId,
            }),
          );
        } catch (err) {
          clearQueuedIssueReport();
          rollbackOptimisticBeforePrompt(err);
        }
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
            session.id === storedSessionId ? { ...session, model: targetSessionModelId } : session,
          );
        hermesSessionItemsRef.current = applyModel(hermesSessionItemsRef.current);
        setHermesSessionItems((current) => applyModel(current));
      }
      if (!imageInputFallbackContent) {
        // Feature 19: send any imported images to the session through the
        // structured image attach flow before the prompt, so the model/tools see
        // them as first-class inputs (not just a path mentioned in prose) and an
        // image-edit prompt names a concrete source. A failed attach throws here,
        // which the submit() catch turns into a restored composer the user can
        // retry — the prompt is NOT sent with a silently-missing image.
        try {
          const updatedAttachments = await attachPendingImages(
            gateway,
            runtimeSessionId,
            storedSessionId,
            agentRunAttachments,
          );
          options?.onAttachmentsUpdated?.(updatedAttachments);
        } catch (err) {
          clearQueuedIssueReport();
          rollbackOptimisticBeforePrompt(err);
        }
      }
      const createdAt = optimisticSession?.createdAt ?? new Date().toISOString();
      setRuntimeSessionIds((current) => ({
        ...current,
        [storedSessionId]: runtimeSessionId,
      }));
      if (!optimisticSession) {
        if (!targetStoredSessionId && options?.skipPrompt) {
          // Media commands do not have a provisional stored session id to receive a
          // picker change while session.create/ensure/resume is in flight. Keep
          // the Send-time model on the media agent run, then take one final snapshot
          // of the new-session default immediately before the stored session
          // becomes active. From that point onward the picker stages changes
          // directly against the stored id.
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
      const pendingUserMessage: HermesSessionMessage = {
        id: optimisticSession?.userMessage.id ?? `pending:user:${Date.now()}`,
        role: "user",
        content: displayContent,
        timestamp: createdAt,
      };
      if (!optimisticSession && !options?.skipPrompt) {
        setPendingHermesMessages((current) => {
          const next = {
            ...current,
            [storedSessionId]: [...(current[storedSessionId] ?? []), pendingUserMessage],
          };
          pendingHermesMessagesRef.current = next;
          return next;
        });
      }
      // `/image`: the session exists and the user bubble is shown — hand the id
      // back and let the caller render the generated image. No prompt.submit, so
      // the model is never called and no "working" loader competes with the
      // image's own in-thread loader.
      if (options?.skipPrompt) return storedSessionId;
      recordSessionRunningActivity(storedSessionId);
      dispatchAgentSessionStatus({
        sessionId: storedSessionId,
        title: sessionDisplayTitle,
        prompt: displayContent,
        status: "running",
        summary: "June is working.",
      });
      const computerUseRunLeaseId = `${storedSessionId}:${crypto.randomUUID()}`;
      let computerUseRunStarted = false;
      try {
        const targetProjectContext = explicitSession
          ? resolveSessionProjectContext?.(storedSessionId)
          : submittedProjectContext;
        const preparedProjectPrompt = prepareProjectPrompt(
          promptSubmitContent,
          targetProjectContext,
          projectContextSignaturesBySessionId.get(storedSessionId),
        );
        await computerUseBeginRun(computerUseRunLeaseId);
        computerUseRunStarted = true;
        rememberComputerUseRun(storedSessionId, computerUseRunLeaseId);
        attachHermesSessionEventListener({
          gateway,
          runtimeSessionId,
          sessionDisplayTitle,
          storedSessionId,
          computerUseRunLeaseId,
        });
        // Feature 15: record the outbound prompt.submit in the trace buffer. Its
        // params are sanitized before storage (the text is the user's own prompt,
        // kept; any secret-like value would be masked). This is the primary
        // outbound call from this surface; other RPCs go direct via
        // gateway.request and are not yet traced (see feature 15 notes).
        hermesTraceBuffer.recordOutbound({
          sessionId: storedSessionId,
          method: "prompt.submit",
          params: { session_id: runtimeSessionId, text: preparedProjectPrompt.text },
        });
        await gateway.request("prompt.submit", {
          session_id: runtimeSessionId,
          text: preparedProjectPrompt.text,
        });
        startAgentRunMonitoring({
          storedSessionId,
          runtimeSessionId,
          title: sessionDisplayTitle,
          fullMode: sessionUnrestricted(storedSessionId),
          settlementHeld: true,
        });
        projectContextSignaturesBySessionId.set(
          storedSessionId,
          preparedProjectPrompt.contextSignature,
        );
        // JUN-171 (Phase A): the held fast-path images have now ridden along
        // with a successful follow-up prompt, either as structured image bytes or
        // in the non-vision path fallback. Clear only after prompt.submit accepts
        // the message, so a rejected submit can be retried with the same image
        // context.
        clearHeldFastPathImages(storedSessionId, heldFastPathImages);
        // Same contract for the video fold: clear only after prompt.submit
        // accepts, so a rejected submit retries with the same video context.
        markStoredVideoSlashContextsSent(
          storedSessionId,
          heldVideoContexts.map((videoContext) => videoContext.id),
        );
        await loadHermesSessions({
          suppressStartupRequestError: !hermesSessionsHydratedRef.current,
        });
      } catch (err) {
        if (computerUseRunStarted) {
          await releaseComputerUseRun(storedSessionId, computerUseRunLeaseId);
        }
        // Record the rejection so the trace panel shows failed outbound calls
        // alongside the inbound stream. messageFromError yields a user-safe string.
        hermesTraceBuffer.recordError({
          sessionId: storedSessionId,
          method: "prompt.submit",
          message: messageFromError(err),
        });
        // A queued report must not outlive its failed prompt; submit() re-arms
        // issue-report mode so the retry can queue it again.
        clearQueuedIssueReport();
        // The prompt never entered the session, so its optimistic bubble must
        // not linger — a retained pending message renders below every later
        // persisted message and reads as a send June ignored.
        setPendingHermesMessages((current) => {
          const next = {
            ...current,
            [storedSessionId]: (current[storedSessionId] ?? []).filter(
              (message) => message.id !== pendingUserMessage.id,
            ),
          };
          pendingHermesMessagesRef.current = next;
          return next;
        });
        if (isSessionBusyError(err)) {
          // The gateway rejected this prompt because the previous agent run is still
          // running — the session itself is healthy, so keep the listener and
          // working state. Callers translate this into the composer notice.
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
      return undefined;
    };

    return activeDispatchReservation.run(dispatchPreparedSession);
  }

  return submitHermesSession;
}
