import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { pendingImageAttachments } from "../../lib/hermes-image-attach";
import { shouldBlockTextOnFunding, type TextFundingModelContext } from "../../lib/account-gate";
import { modelPrivacyBadge, modelSupportsImageInput } from "../../lib/model-privacy";
import { decodeHermesModelSelection } from "../../lib/hermes-session-model-selection";
import {
  localGenerationOptionId,
  unavailableLocalGenerationOption,
  withLocalGenerationOption,
} from "../../lib/local-generation";
import { preferredVisionFallbackModel } from "../../lib/suggested-models";
import { type ThinkingLevel } from "../../lib/thinking-level";
import { AUTO_MODEL_ID, selectedModel as selectedModelOption } from "../settings/ModelPickerDialog";
import { parseBuiltinComposerSlashCommand } from "../../lib/agent-composer-slash-commands";
import { IMAGE_GENERATION_ENABLED } from "../../lib/feature-flags";
import { isProvisionalHermesSessionId } from "./agent-workspace-config";
import { sessionComposerDraftKey, NEW_SESSION_DRAFT_KEY } from "./agent-session-continuity";
import { composerInputSignatureFor } from "./composer/composer-input-helpers";
import type { UseAgentSelectionDependencies } from "./use-agent-selection-types";

export function useAgentSelection(dependencies: UseAgentSelectionDependencies) {
  const {
    attachments,
    artifactIndex,
    category,
    composerSizeWarning,
    creditActionsDisabledReason,
    defaultGenerationModelId,
    draft,
    generationCostQuality,
    generationModels,
    hermesSessionItems,
    hermesSessionMessages,
    localGeneration,
    newSessionMode,
    onSessionSelected,
    pendingHermesMessages,
    selectedHermesSessionId,
    selectedTaskId,
    sessionModelSelections,
    sessionThinkingEfforts,
    tasks,
    thinkingLevel,
    veniceApiKeyConfigured,
  } = dependencies;

  const selectedTask = useMemo(
    () => tasks.find((task) => task.id === selectedTaskId),
    [selectedTaskId, tasks],
  );
  const selectedHermesSession = useMemo(
    () => hermesSessionItems.find((session) => session.id === selectedHermesSessionId),
    [hermesSessionItems, selectedHermesSessionId],
  );
  useEffect(() => {
    if (selectedHermesSessionId && !selectedHermesSession) return;
    onSessionSelected?.(selectedHermesSession);
  }, [onSessionSelected, selectedHermesSession, selectedHermesSessionId]);
  const selectedHermesSessionIsProvisional = isProvisionalHermesSessionId(selectedHermesSessionId);
  const selectedSessionModelEntry =
    selectedHermesSessionId && !newSessionMode
      ? sessionModelSelections[selectedHermesSessionId]
      : undefined;
  const selectedSessionPersistedHermesModelId = selectedHermesSession?.model?.trim();
  const selectedSessionPersistedSelection = selectedSessionPersistedHermesModelId
    ? decodeHermesModelSelection(selectedSessionPersistedHermesModelId)
    : undefined;
  const selectedSessionModelSelection =
    selectedSessionModelEntry?.selection ?? selectedSessionPersistedSelection;
  // New session choices already carry explicit local/remote provenance. Only
  // an untagged legacy session needs the configured-model equality heuristic;
  // applying it to a tagged or durable remote choice would mislabel a remote
  // model as local when both catalogs expose the same raw id.
  const localOptionId =
    localGeneration.modelId.trim().length > 0
      ? localGenerationOptionId(localGeneration.modelId)
      : "";
  const sessionOrDefaultModelId =
    selectedHermesSessionId && !newSessionMode
      ? selectedSessionModelSelection?.modelId || defaultGenerationModelId
      : defaultGenerationModelId;
  const selectedLegacyRawLocalModel = Boolean(
    selectedHermesSessionId &&
      !newSessionMode &&
      !selectedSessionModelEntry &&
      selectedSessionPersistedHermesModelId &&
      !selectedSessionPersistedHermesModelId.startsWith("__june_") &&
      localOptionId &&
      selectedSessionPersistedHermesModelId === localGeneration.modelId.trim(),
  );
  const activeGenerationModelId = selectedLegacyRawLocalModel
    ? localOptionId
    : sessionOrDefaultModelId;
  const activeGenerationCostQuality =
    activeGenerationModelId === AUTO_MODEL_ID
      ? (selectedSessionModelSelection?.costQuality ?? generationCostQuality)
      : generationCostQuality;
  // Catalog surfaced in the composer picker: the remote models plus, when a
  // local endpoint is configured, the synthetic local option (even while
  // remote is active, so the user can switch to local from the composer).
  const generationModelOptions = useMemo(
    () => withLocalGenerationOption(generationModels, localGeneration),
    [generationModels, localGeneration],
  );
  const generationModel = useMemo(() => {
    if (!activeGenerationModelId) return undefined;
    const listed = generationModelOptions.some((model) => model.id === activeGenerationModelId);
    return listed
      ? selectedModelOption(generationModelOptions, activeGenerationModelId)
      : (unavailableLocalGenerationOption(activeGenerationModelId) ??
          selectedModelOption(generationModelOptions, activeGenerationModelId));
  }, [activeGenerationModelId, generationModelOptions]);
  const generationPrivacyBadge = generationModel ? modelPrivacyBadge(generationModel) : undefined;
  // The control shows the open session's OWN level (its creation pin, a pick
  // made while it was open, or what its runtime last reported) — never the
  // draft, which would label every chat with whatever level was picked last
  // anywhere. The draft only shows for a new session, where it applies.
  const composerThinkingLevel: ThinkingLevel =
    selectedHermesSessionId && !newSessionMode
      ? (sessionThinkingEfforts()[selectedHermesSessionId] ?? thinkingLevel)
      : thinkingLevel;
  // The model the image-attach banner offers to switch to: a vision + tool
  // capable model, preferring a known private vision pick (Kimi K2.6) over the
  // alphabetically-first vision model. See preferredVisionFallbackModel.
  const preferredVisionModel = useMemo(
    () => preferredVisionFallbackModel(generationModels),
    [generationModels],
  );
  // Maps a raw model id (as the usage payload reports it) to its catalog DTO for
  // the usage panel, so it can show both the display name and the privacy badge;
  // returns undefined when the id is unknown.
  const resolveModel = useCallback(
    (modelId: string) => generationModels.find((model) => model.id === modelId),
    [generationModels],
  );
  // Mirror the send-time fallback trigger (pendingImageAttachments +
  // !modelSupportsImageInput) so the banner appears exactly when a submit would
  // strip the image and downgrade to the text-only prompt. Resolve strictly via
  // find (not generationModel, which is a zero-capability stub for an unknown
  // id) so an unresolved/stale model stays silent rather than warning and being
  // treated as non-vision.
  const resolvedGenerationModel = activeGenerationModelId
    ? generationModels.find((model) => model.id === activeGenerationModelId)
    : undefined;
  const textFundingContext: TextFundingModelContext = {
    activeModelId: activeGenerationModelId || undefined,
    activeModel: resolvedGenerationModel,
    veniceApiKeyConfigured,
  };
  const textActionsDisabledReason = shouldBlockTextOnFunding(
    Boolean(creditActionsDisabledReason),
    textFundingContext,
  )
    ? creditActionsDisabledReason
    : undefined;
  const composerHasPendingImage =
    pendingImageAttachments(attachments.map((attachment) => attachment.attach)).length > 0;
  const parsedComposerSlashCommand = useMemo(
    () => parseBuiltinComposerSlashCommand(draft),
    [draft],
  );
  const imageSlashDraftActive =
    IMAGE_GENERATION_ENABLED && parsedComposerSlashCommand?.name === "image";
  const imageSlashBlockedByModel =
    imageSlashDraftActive &&
    !!resolvedGenerationModel &&
    !modelSupportsImageInput(resolvedGenerationModel);
  const showImageInputWarning =
    composerHasPendingImage &&
    !!resolvedGenerationModel &&
    !modelSupportsImageInput(resolvedGenerationModel);
  const showImageModelWarning = showImageInputWarning || imageSlashBlockedByModel;
  const imageModelWarningText = imageSlashBlockedByModel
    ? `${resolvedGenerationModel?.name ?? "This model"} can't read images. Switch to a vision model before using /image.`
    : `${resolvedGenerationModel?.name ?? "This model"} can't read images.`;
  const composerInputSignature = useMemo(
    () =>
      composerInputSignatureFor({
        message: draft.trim(),
        category,
        attachments,
        model: generationModel,
      }),
    [attachments, category, draft, generationModel],
  );
  const visibleComposerSizeWarning =
    composerSizeWarning?.inputSignature === composerInputSignature ? composerSizeWarning : null;
  const selectedHermesMessages = useMemo(() => {
    if (!selectedHermesSessionId) return [];
    return [
      ...(hermesSessionMessages[selectedHermesSessionId] ?? []),
      ...(pendingHermesMessages[selectedHermesSessionId] ?? []),
    ];
  }, [hermesSessionMessages, pendingHermesMessages, selectedHermesSessionId]);
  const composerDraftKey = selectedHermesSessionId
    ? sessionComposerDraftKey(selectedHermesSessionId)
    : selectedTask
      ? null
      : NEW_SESSION_DRAFT_KEY;
  const composerDraftKeyRef = useRef<string | null>(composerDraftKey);
  composerDraftKeyRef.current = composerDraftKey;
  const restoredComposerDraftKeyRef = useRef<string | null>();
  const artifactIndexVersion = useSyncExternalStore(
    artifactIndex.subscribe,
    artifactIndex.getVersion,
    artifactIndex.getVersion,
  );
  const chatArtifacts = useMemo(
    () => artifactIndex.getArtifacts(),
    [artifactIndex, artifactIndexVersion],
  );

  return {
    selectedTask,
    selectedHermesSession,
    selectedHermesSessionIsProvisional,
    activeGenerationCostQuality,
    generationModelOptions,
    generationModel,
    generationPrivacyBadge,
    composerThinkingLevel,
    preferredVisionModel,
    resolveModel,
    textFundingContext,
    textActionsDisabledReason,
    imageSlashBlockedByModel,
    showImageModelWarning,
    imageModelWarningText,
    composerInputSignature,
    visibleComposerSizeWarning,
    selectedHermesMessages,
    composerDraftKey,
    composerDraftKeyRef,
    restoredComposerDraftKeyRef,
    chatArtifacts,
  };
}
