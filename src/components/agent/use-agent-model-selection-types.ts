import {
  type HermesSessionInfo,
  type LocalGenerationSettingsDto,
  type ProviderModelSettingsDto,
  type VeniceModelDto,
} from "../../lib/tauri";
import type * as React from "react";
import type { CreateModelSelectionActionsDependencies } from "./model-selection-actions-types";

export type UseAgentModelSelectionDependencies = Omit<
  CreateModelSelectionActionsDependencies,
  "generationModelRequestSequence" | "loadGenerationModel"
> & {
  confirmedCostQualityRef: React.MutableRefObject<number | undefined>;
  defaultGenerationModelId: string;
  defaultGenerationModelIdRef: React.MutableRefObject<string>;
  generationCostQualityRef: React.MutableRefObject<number | undefined>;
  generationModelsRef: React.MutableRefObject<VeniceModelDto[]>;
  generationSelectionId: (settings: ProviderModelSettingsDto, fallbackModelId?: string) => string;
  localGenerationRef: React.MutableRefObject<LocalGenerationSettingsDto>;
  setDefaultGenerationModelId: React.Dispatch<React.SetStateAction<string>>;
  setGenerationCostQuality: React.Dispatch<React.SetStateAction<number | undefined>>;
  setGenerationModels: React.Dispatch<React.SetStateAction<VeniceModelDto[]>>;
  setHermesSessionItems: React.Dispatch<React.SetStateAction<HermesSessionInfo[]>>;
  setLocalGeneration: React.Dispatch<React.SetStateAction<LocalGenerationSettingsDto>>;
  setVeniceApiKeyConfigured: React.Dispatch<React.SetStateAction<boolean>>;
  veniceApiKeyConfiguredRef: React.MutableRefObject<boolean>;
};
