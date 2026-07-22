import {
  type HermesSessionInfo,
  type LocalGenerationSettingsDto,
  type VeniceModelDto,
} from "../../lib/tauri";
import { type SessionModelSelectionMap } from "../../lib/hermes-session-model-selection";
import { type ModelPickerFlyout } from "../settings/ModelPickerPopover";
import { type AgentWorkspaceErrorOptions } from "./agent-workspace-errors";
import type * as React from "react";

export type CreateModelSelectionActionsDependencies = {
  MODEL_SWITCH_TOAST_ID: "agent-model-switch";
  activeGenerationCostQuality: number | undefined;
  confirmedCostQualityRef: React.MutableRefObject<number | undefined>;
  costQualitySaveChainRef: React.MutableRefObject<Promise<unknown>>;
  defaultGenerationModelIdRef: React.MutableRefObject<string>;
  generationCostQuality: number | undefined;
  generationCostQualityRef: React.MutableRefObject<number | undefined>;
  generationModelRequestSequence: React.MutableRefObject<number>;
  generationModelsRef: React.MutableRefObject<VeniceModelDto[]>;
  generationSelectionIntentRevisionRef: React.MutableRefObject<number>;
  generationSelectionSaveChainRef: React.MutableRefObject<Promise<void>>;
  hermesSessionItemsRef: React.MutableRefObject<HermesSessionInfo[]>;
  latestCostQualitySaveRef: React.MutableRefObject<number>;
  loadGenerationModel: () => Promise<{
    models: VeniceModelDto[];
    selectedModelId: string;
  } | null>;
  localEnableConfirmArmedForRef: React.MutableRefObject<string | null>;
  localGenerationRef: React.MutableRefObject<LocalGenerationSettingsDto>;
  newSessionModeRef: React.MutableRefObject<boolean>;
  profileOwnedSessionIdsRef: React.MutableRefObject<Set<string>>;
  selectedHermesSessionIdRef: React.MutableRefObject<string | undefined>;
  sessionModelSelectionsRef: React.MutableRefObject<SessionModelSelectionMap>;
  setComposerModelFlyout: React.Dispatch<React.SetStateAction<ModelPickerFlyout>>;
  setComposerModelFromSlash: React.Dispatch<React.SetStateAction<boolean>>;
  setComposerModelOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setDefaultGenerationModelId: React.Dispatch<React.SetStateAction<string>>;
  setError: (message: string | null, options?: AgentWorkspaceErrorOptions) => void;
  setGenerationCostQuality: React.Dispatch<React.SetStateAction<number | undefined>>;
  setModelRootSearch: React.Dispatch<React.SetStateAction<string>>;
  setModelSearch: React.Dispatch<React.SetStateAction<string>>;
  setSandboxMenuOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setSessionModelSelections: React.Dispatch<React.SetStateAction<SessionModelSelectionMap>>;
};
