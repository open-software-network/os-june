import {
  type HermesMessagingPlatformInfo,
  type HermesSkillInfo,
  type HermesToolsetInfo,
} from "../../lib/tauri";
import { HermesGatewayClient } from "../../lib/hermes-gateway";
import { type AgentWorkspaceErrorOptions } from "./agent-workspace-errors";
import type { AgentArtifactIndex } from "./artifact-index";
import type * as React from "react";

export type createManagementLoadersDependencies = {
  artifactIndex: AgentArtifactIndex;
  ensureHermesGateway: (fullMode?: boolean) => Promise<HermesGatewayClient>;
  selectedHermesSessionIdRef: React.MutableRefObject<string | undefined>;
  setCapabilityLoading: React.Dispatch<React.SetStateAction<boolean>>;
  setError: (message: string | null, options?: AgentWorkspaceErrorOptions) => void;
  setMessagingPlatforms: React.Dispatch<React.SetStateAction<HermesMessagingPlatformInfo[] | null>>;
  setSelectedMessagingPlatformId: React.Dispatch<React.SetStateAction<string | undefined>>;
  setSkillCommandLoading: React.Dispatch<React.SetStateAction<boolean>>;
  setSkills: React.Dispatch<React.SetStateAction<HermesSkillInfo[] | null>>;
  setToolsets: React.Dispatch<React.SetStateAction<HermesToolsetInfo[] | null>>;
  skillCommandsLoadRef: React.MutableRefObject<Promise<HermesSkillInfo[]> | null>;
  skills: HermesSkillInfo[] | null;
};
