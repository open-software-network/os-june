import { toast } from "../ui/Toaster";
import {
  setLocalGenerationEnabled,
  setCostQuality,
  setVeniceModel,
  type HermesSessionInfo,
} from "../../lib/tauri";
import { dispatchProviderModelSettingsChanged, modelSupportsTools } from "../../lib/model-privacy";
import {
  MODEL_SWITCH_NEXT_MESSAGE_NOTICE,
  MODEL_SWITCH_DEFAULT_ONLY_NOTICE,
} from "../../lib/hermes-model-switch";
import {
  decodeHermesModelSelection,
  hasPendingSessionModelSelection,
  hermesModelIdForSelection,
  stageSessionModelSelection,
  type SessionModelSelection,
  type SessionModelSelectionMap,
} from "../../lib/hermes-session-model-selection";
import {
  LOCAL_GENERATION_OPTION_ID_PREFIX,
  isLoopbackUrl,
  localGenerationOptionId,
} from "../../lib/local-generation";
import { AUTO_MODEL_ID } from "../settings/ModelPickerDialog";
import { messageFromError } from "../../lib/errors";
import { type CapturedSessionModelTarget } from "./composer/follow-up-queue";
import type { CreateModelSelectionActionsDependencies } from "./model-selection-actions-types";

export function createModelSelectionActions(dependencies: CreateModelSelectionActionsDependencies) {
  const {
    MODEL_SWITCH_TOAST_ID,
    activeGenerationCostQuality,
    confirmedCostQualityRef,
    costQualitySaveChainRef,
    defaultGenerationModelIdRef,
    generationCostQuality,
    generationCostQualityRef,
    generationModelRequestSequence,
    generationModelsRef,
    generationSelectionIntentRevisionRef,
    generationSelectionSaveChainRef,
    hermesSessionItemsRef,
    latestCostQualitySaveRef,
    loadGenerationModel,
    localEnableConfirmArmedForRef,
    localGenerationRef,
    newSessionModeRef,
    profileOwnedSessionIdsRef,
    selectedHermesSessionIdRef,
    sessionModelSelectionsRef,
    setComposerModelFlyout,
    setComposerModelFromSlash,
    setComposerModelOpen,
    setDefaultGenerationModelId,
    setError,
    setGenerationCostQuality,
    setModelRootSearch,
    setModelSearch,
    setSandboxMenuOpen,
    setSessionModelSelections,
  } = dependencies;

  function commitSessionModelSelections(next: SessionModelSelectionMap) {
    sessionModelSelectionsRef.current = next;
    setSessionModelSelections(next);
  }

  function storedSessionIdForComposerModelSelection() {
    const storedSessionId = selectedHermesSessionIdRef.current;
    return storedSessionId && !newSessionModeRef.current ? storedSessionId : undefined;
  }

  function queueComposerSessionModelSelection(
    storedSessionId: string,
    selection: SessionModelSelection,
  ) {
    commitSessionModelSelections(stageSessionModelSelection(storedSessionId, selection));
    setError(null);
    toast(MODEL_SWITCH_NEXT_MESSAGE_NOTICE, { id: MODEL_SWITCH_TOAST_ID });
  }

  function captureSessionModelTarget(
    explicitSession?: HermesSessionInfo,
  ): CapturedSessionModelTarget {
    const selectedStoredSessionId = selectedHermesSessionIdRef.current;
    const targetStoredSessionId = explicitSession?.id
      ? explicitSession.id
      : newSessionModeRef.current
        ? undefined
        : selectedStoredSessionId;
    const listedSession = targetStoredSessionId
      ? hermesSessionItemsRef.current.find((session) => session.id === targetStoredSessionId)
      : undefined;
    const existingHermesModelId =
      explicitSession?.model?.trim() || listedSession?.model?.trim() || undefined;
    const entry = targetStoredSessionId
      ? sessionModelSelectionsRef.current[targetStoredSessionId]
      : undefined;
    const inheritsProfileModel = Boolean(
      targetStoredSessionId &&
        profileOwnedSessionIdsRef.current.has(targetStoredSessionId) &&
        !entry,
    );
    let persistedSelection = existingHermesModelId
      ? decodeHermesModelSelection(existingHermesModelId)
      : undefined;
    const configuredLocalModelId = localGenerationRef.current.modelId.trim();
    if (
      existingHermesModelId &&
      !existingHermesModelId.startsWith("__june_") &&
      configuredLocalModelId &&
      existingHermesModelId === configuredLocalModelId
    ) {
      // Older June builds stored local sessions as an untagged raw id. Keep
      // treating an exact configured match as local while upgrading the
      // session to the collision-proof tagged form on its next Send.
      persistedSelection = { modelId: localGenerationOptionId(configuredLocalModelId) };
    }
    const fallbackModelId = targetStoredSessionId
      ? existingHermesModelId || (inheritsProfileModel ? "" : defaultGenerationModelIdRef.current)
      : defaultGenerationModelIdRef.current;
    const baseSelection: SessionModelSelection = entry?.selection ??
      persistedSelection ?? { modelId: fallbackModelId };
    const selection: SessionModelSelection =
      baseSelection.modelId === AUTO_MODEL_ID &&
      baseSelection.costQuality === undefined &&
      generationCostQualityRef.current !== undefined
        ? { ...baseSelection, costQuality: generationCostQualityRef.current }
        : baseSelection;
    const hermesModelId = selection.modelId ? hermesModelIdForSelection(selection) : "";
    return {
      targetStoredSessionId: targetStoredSessionId ?? null,
      existingHermesModelId,
      selection,
      hermesModelId,
      revision: entry?.revision,
      shouldApply: Boolean(
        targetStoredSessionId &&
          hermesModelId &&
          (hasPendingSessionModelSelection(entry) || existingHermesModelId !== hermesModelId),
      ),
      globalIntentRevision: generationSelectionIntentRevisionRef.current,
    };
  }

  // Stale catalog (the mount fetch can fail while the bridge is starting) is
  // refreshed in the background on every open, like Settings does.
  function openComposerModelPicker(fromSlash = false) {
    setModelSearch("");
    setModelRootSearch("");
    setComposerModelFlyout(null);
    setComposerModelFromSlash(fromSlash);
    setComposerModelOpen(true);
    setSandboxMenuOpen(false);
    void loadGenerationModel();
  }

  // Reflects the global generation selection into composer state directly (not
  // via the backend return value, which tests stub out): the remote flip and
  // the mount fetch already round-trip through commitGenerationSettings.
  function markRemoteGenerationSelected(modelId: string) {
    defaultGenerationModelIdRef.current = modelId;
    setDefaultGenerationModelId(modelId);
  }

  function saveGenerationSelection(write: () => Promise<unknown>): Promise<void> {
    const save = generationSelectionSaveChainRef.current.then(async () => {
      await write();
    });
    generationSelectionSaveChainRef.current = save.catch(() => undefined);
    return save;
  }

  async function selectLocalGeneration(options?: {
    keepOpen?: boolean;
    targetStoredSessionId?: string | null;
  }) {
    const localModelId = localGenerationRef.current.modelId.trim();
    const selectedModelId = localModelId ? localGenerationOptionId(localModelId) : "";
    // An off-device endpoint takes a deliberate second step, same invariant as
    // the Settings toggle: the first selection warns instead of enabling.
    // Loopback endpoints enable in one step.
    const baseUrl = localGenerationRef.current.baseUrl.trim();
    if (!isLoopbackUrl(baseUrl)) {
      if (localEnableConfirmArmedForRef.current !== baseUrl) {
        localEnableConfirmArmedForRef.current = baseUrl;
        toast.warning(
          "This endpoint is not on this machine. Requests will leave your device. Select the local model again to confirm.",
          { id: MODEL_SWITCH_TOAST_ID },
        );
        return false;
      }
      localEnableConfirmArmedForRef.current = null;
    }
    const storedSessionId =
      options && "targetStoredSessionId" in options
        ? (options.targetStoredSessionId ?? undefined)
        : storedSessionIdForComposerModelSelection();
    if (storedSessionId) {
      queueComposerSessionModelSelection(storedSessionId, { modelId: selectedModelId });
      return true;
    }
    const intentRevision = ++generationSelectionIntentRevisionRef.current;
    const previousModelId = defaultGenerationModelIdRef.current;
    generationModelRequestSequence.current += 1;
    defaultGenerationModelIdRef.current = selectedModelId;
    setDefaultGenerationModelId(selectedModelId);
    try {
      await saveGenerationSelection(() => setLocalGenerationEnabled(true));
      if (generationSelectionIntentRevisionRef.current === intentRevision) {
        dispatchProviderModelSettingsChanged({
          mode: "generation",
          modelId: selectedModelId,
        });
        setError(null);
      }
    } catch (err) {
      if (generationSelectionIntentRevisionRef.current === intentRevision) {
        defaultGenerationModelIdRef.current = previousModelId;
        setDefaultGenerationModelId(previousModelId);
        setError(messageFromError(err));
      }
      return false;
    }
    if (generationSelectionIntentRevisionRef.current === intentRevision) {
      toast(MODEL_SWITCH_DEFAULT_ONLY_NOTICE, { id: MODEL_SWITCH_TOAST_ID });
    }
    return true;
  }

  // The Auto section's Preference drill-in follows the same scope as model
  // selection: an existing session stages its next agent run, while the hero
  // updates the app-wide default for future sessions.
  function handleCostQualityChange(value: number) {
    const storedSessionId = storedSessionIdForComposerModelSelection();
    if (storedSessionId) {
      queueComposerSessionModelSelection(storedSessionId, {
        modelId: AUTO_MODEL_ID,
        costQuality: value,
      });
      return;
    }
    // Rapid preset clicks overlap: the chain keeps the writes ordered so the
    // last click is what persists, and the version gate makes sure only the
    // newest call's outcome (success or rollback) touches the UI — the same
    // discipline as Settings' saveCostQuality.
    const version = ++latestCostQualitySaveRef.current;
    generationCostQualityRef.current = value;
    setGenerationCostQuality(value);
    const save = costQualitySaveChainRef.current.then(() => setCostQuality(value));
    costQualitySaveChainRef.current = save.then(
      () => undefined,
      () => undefined,
    );
    void save.then(
      (next) => {
        confirmedCostQualityRef.current = next.costQuality;
        if (version !== latestCostQualitySaveRef.current) return;
        generationCostQualityRef.current = next.costQuality;
        setGenerationCostQuality(next.costQuality);
        dispatchProviderModelSettingsChanged({
          mode: "generation",
          modelId: defaultGenerationModelIdRef.current,
        });
        setError(null);
      },
      (err) => {
        if (version !== latestCostQualitySaveRef.current) return;
        generationCostQualityRef.current = confirmedCostQualityRef.current;
        setGenerationCostQuality(confirmedCostQualityRef.current);
        setError(messageFromError(err));
      },
    );
  }

  // A new-session choice updates the app-wide default. Once a session exists,
  // the same picker writes only that session's desired next-run selection;
  // Hermes is deliberately untouched until submit snapshots and applies it.
  async function handleSelectGenerationModel(
    modelId: string,
    costQuality?: number,
    options?: { keepOpen?: boolean; targetStoredSessionId?: string | null },
  ) {
    // The Auto toggle switches models mid-flow, so it asks to keep the picker
    // open; a row pick is a final choice and closes it.
    if (!options?.keepOpen) setComposerModelOpen(false);

    // Local is a synthetic catalog option (prefixed id), so it routes through
    // the provider switch rather than a remote model set.
    if (modelId.startsWith(LOCAL_GENERATION_OPTION_ID_PREFIX)) {
      return selectLocalGeneration(options);
    }
    // Picking anything else stands down a pending off-device confirm: the
    // next local selection warns afresh instead of enabling in one step.
    localEnableConfirmArmedForRef.current = null;

    const chosen = generationModelsRef.current.find((model) => model.id === modelId);
    // Defense in depth: the picker already hides tool-less models, but the
    // agent bricks without function calling, so refuse one rather than switch.
    if (chosen && !modelSupportsTools(chosen)) {
      setError(`${chosen.name} can't run June's tools, so it can't be used for the agent.`);
      return false;
    }
    const storedSessionId =
      options && "targetStoredSessionId" in options
        ? (options.targetStoredSessionId ?? undefined)
        : storedSessionIdForComposerModelSelection();
    if (storedSessionId) {
      const selectedCostQuality =
        modelId === AUTO_MODEL_ID
          ? (costQuality ?? activeGenerationCostQuality ?? generationCostQuality)
          : undefined;
      queueComposerSessionModelSelection(storedSessionId, {
        modelId,
        ...(selectedCostQuality !== undefined ? { costQuality: selectedCostQuality } : {}),
      });
      return true;
    }
    const selectedCostQuality =
      modelId === AUTO_MODEL_ID ? (costQuality ?? generationCostQualityRef.current) : undefined;
    const intentRevision = ++generationSelectionIntentRevisionRef.current;
    const previousModelId = defaultGenerationModelIdRef.current;
    const previousCostQuality = generationCostQualityRef.current;
    generationModelRequestSequence.current += 1;
    markRemoteGenerationSelected(modelId);
    if (selectedCostQuality !== undefined) {
      generationCostQualityRef.current = selectedCostQuality;
      setGenerationCostQuality(selectedCostQuality);
    }
    try {
      await saveGenerationSelection(async () => {
        if (selectedCostQuality !== undefined) {
          await setCostQuality(selectedCostQuality);
        }
        await setVeniceModel("generation", modelId);
      });
      if (generationSelectionIntentRevisionRef.current === intentRevision) {
        dispatchProviderModelSettingsChanged({ mode: "generation", modelId });
        setError(null);
      }
    } catch (err) {
      if (generationSelectionIntentRevisionRef.current === intentRevision) {
        defaultGenerationModelIdRef.current = previousModelId;
        setDefaultGenerationModelId(previousModelId);
        generationCostQualityRef.current = previousCostQuality;
        setGenerationCostQuality(previousCostQuality);
        setError(messageFromError(err));
      }
      return false;
    }
    if (generationSelectionIntentRevisionRef.current === intentRevision) {
      toast(MODEL_SWITCH_DEFAULT_ONLY_NOTICE, { id: MODEL_SWITCH_TOAST_ID });
    }
    return true;
  }

  return {
    commitSessionModelSelections,
    storedSessionIdForComposerModelSelection,
    queueComposerSessionModelSelection,
    captureSessionModelTarget,
    openComposerModelPicker,
    markRemoteGenerationSelected,
    saveGenerationSelection,
    selectLocalGeneration,
    handleCostQualityChange,
    handleSelectGenerationModel,
  };
}
