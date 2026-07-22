import {
  type HermesMessagingPlatformInfo,
  type HermesSkillInfo,
  type HermesToolsetInfo,
} from "../../lib/tauri";
import { type AgentWorkspaceErrorOptions } from "./agent-workspace-errors";
import type * as React from "react";

export type createCapabilityActionsDependencies = {
  loadMessagingPlatforms: () => Promise<void>;
  messagingEnvEdits: Record<string, string>;
  setCapabilitySaving: React.Dispatch<React.SetStateAction<string | null>>;
  setError: (message: string | null, options?: AgentWorkspaceErrorOptions) => void;
  setMessagingEnvEdits: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  setMessagingPlatforms: React.Dispatch<React.SetStateAction<HermesMessagingPlatformInfo[] | null>>;
  setSkills: React.Dispatch<React.SetStateAction<HermesSkillInfo[] | null>>;
  setToolsets: React.Dispatch<React.SetStateAction<HermesToolsetInfo[] | null>>;
};
