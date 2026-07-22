import {
  type AgentTaskDto,
  type HermesFilesystemSnapshot,
  type HermesSessionInfo,
  type HermesSessionMessage,
  type LocalGenerationSettingsDto,
  type VeniceModelDto,
} from "../../lib/tauri";
import type { SessionModelSelectionMap } from "../../lib/hermes-session-model-selection";
import { type ThinkingLevel } from "../../lib/thinking-level";
import type { AgentAttachment } from "./agent-workspace-models";
import type { ComposerInputSizeWarning } from "./composer/composer-input-helpers";
import type { ReportCategory } from "./composer/reportCategory";

export type UseAgentSelectionDependencies = {
  attachments: AgentAttachment[];
  category: ReportCategory | null;
  composerSizeWarning: ComposerInputSizeWarning | null;
  creditActionsDisabledReason: string | undefined;
  defaultGenerationModelId: string;
  draft: string;
  filesystemSnapshot: HermesFilesystemSnapshot | null;
  generationCostQuality: number | undefined;
  generationModels: VeniceModelDto[];
  hermesSessionItems: HermesSessionInfo[];
  hermesSessionMessages: Record<string, HermesSessionMessage[]>;
  localGeneration: LocalGenerationSettingsDto;
  newSessionMode: boolean;
  onSessionSelected: ((session: HermesSessionInfo | undefined) => void) | undefined;
  pendingHermesMessages: Record<string, HermesSessionMessage[]>;
  selectedHermesSessionId: string | undefined;
  selectedTaskId: string | undefined;
  sessionModelSelections: SessionModelSelectionMap;
  sessionThinkingEfforts: () => Record<string, ThinkingLevel>;
  tasks: AgentTaskDto[];
  thinkingLevel: ThinkingLevel;
  veniceApiKeyConfigured: boolean;
};
