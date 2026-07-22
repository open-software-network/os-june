import { useCallback, useEffect, useRef } from "react";
import {
  listVeniceModels,
  providerModelSettings,
  type ProviderModelSettingsDto,
} from "../../lib/tauri";
import {
  PROVIDER_MODEL_SETTINGS_CHANGED_EVENT,
  type ProviderModelSettingsChangedDetail,
} from "../../lib/model-privacy";
import { createModelSelectionActions } from "./model-selection-actions";
import type { UseAgentModelSelectionDependencies } from "./use-agent-model-selection-types";

export function useAgentModelSelection(dependencies: UseAgentModelSelectionDependencies) {
  const {
    MODEL_SWITCH_TOAST_ID,
    activeGenerationCostQuality,
    confirmedCostQualityRef,
    costQualitySaveChainRef,
    defaultGenerationModelId,
    defaultGenerationModelIdRef,
    generationCostQualityRef,
    generationCostQuality,
    generationModelsRef,
    generationSelectionId,
    generationSelectionIntentRevisionRef,
    generationSelectionSaveChainRef,
    hermesSessionItemsRef,
    latestCostQualitySaveRef,
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
    setGenerationCostQuality,
    setGenerationModels,
    setHermesSessionItems,
    setLocalGeneration,
    setError,
    setModelRootSearch,
    setModelSearch,
    setSandboxMenuOpen,
    setSessionModelSelections,
    setVeniceApiKeyConfigured,
    veniceApiKeyConfiguredRef,
  } = dependencies;

  const commitGenerationSettings = useCallback(
    (settings: ProviderModelSettingsDto, fallbackModelId = "") => {
      const local = settings.localGeneration ?? {
        baseUrl: "",
        modelId: "",
        apiKey: "",
      };
      const selectedModelId = generationSelectionId(settings, fallbackModelId);
      localGenerationRef.current = local;
      setLocalGeneration(local);
      defaultGenerationModelIdRef.current = selectedModelId;
      setDefaultGenerationModelId(selectedModelId);
      confirmedCostQualityRef.current = settings.costQuality;
      generationCostQualityRef.current = settings.costQuality;
      setGenerationCostQuality(settings.costQuality);
      veniceApiKeyConfiguredRef.current = settings.veniceApiKeyConfigured;
      setVeniceApiKeyConfigured(settings.veniceApiKeyConfigured);
      return selectedModelId;
    },
    [],
  );

  // Out-of-order responses (a slow mount fetch landing after a settings
  // change refresh) must not clobber the newer result.
  const generationModelRequestSequence = useRef(0);
  const loadGenerationModel = useCallback(async () => {
    const requestId = ++generationModelRequestSequence.current;
    try {
      const settingsPromise = providerModelSettings();
      const modelsPromise = listVeniceModels("generation");
      // Surfaced before the catalog await: the settings read is local IPC, so
      // key-presence state (the Auto billing note) refreshes even when the
      // remote catalog fetch fails.
      modelsPromise.catch(() => {});
      const settingsResponse = await settingsPromise;
      if (requestId === generationModelRequestSequence.current) {
        veniceApiKeyConfiguredRef.current = settingsResponse.settings.veniceApiKeyConfigured;
        setVeniceApiKeyConfigured(settingsResponse.settings.veniceApiKeyConfigured);
      }
      const modelsResponse = await modelsPromise;
      const selectedModelId = generationSelectionId(
        settingsResponse.settings,
        modelsResponse.selectedModel,
      );
      if (requestId === generationModelRequestSequence.current) {
        generationModelsRef.current = modelsResponse.models;
        setGenerationModels(modelsResponse.models);
        commitGenerationSettings(settingsResponse.settings, modelsResponse.selectedModel);
      }
      return { models: modelsResponse.models, selectedModelId };
    } catch {
      if (requestId === generationModelRequestSequence.current) {
        defaultGenerationModelIdRef.current = "";
        generationModelsRef.current = [];
        setDefaultGenerationModelId("");
      }
      return null;
    }
  }, [commitGenerationSettings]);

  useEffect(() => {
    defaultGenerationModelIdRef.current = defaultGenerationModelId;
    const defaultModelId = defaultGenerationModelId.trim();
    if (!defaultModelId) return;
    setHermesSessionItems((current) => {
      let changed = false;
      const next = current.map((session) => {
        if (session.model?.trim()) return session;
        changed = true;
        return { ...session, model: defaultModelId };
      });
      return changed ? next : current;
    });
  }, [defaultGenerationModelId]);

  useEffect(() => {
    function handleProviderModelSettingsChanged(event: Event) {
      const { mode } = (event as CustomEvent<ProviderModelSettingsChangedDetail>).detail;
      if (mode === "generation") {
        void loadGenerationModel();
      }
    }

    void loadGenerationModel();
    window.addEventListener(
      PROVIDER_MODEL_SETTINGS_CHANGED_EVENT,
      handleProviderModelSettingsChanged,
    );
    return () => {
      window.removeEventListener(
        PROVIDER_MODEL_SETTINGS_CHANGED_EVENT,
        handleProviderModelSettingsChanged,
      );
    };
  }, [loadGenerationModel]);

  const {
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
  } = createModelSelectionActions({
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
  });

  return {
    loadGenerationModel,
    commitSessionModelSelections,
    captureSessionModelTarget,
    openComposerModelPicker,
    saveGenerationSelection,
    handleCostQualityChange,
    handleSelectGenerationModel,
  };
}
