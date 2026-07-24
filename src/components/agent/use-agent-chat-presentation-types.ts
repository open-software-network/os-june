import { type AgentTaskDto, type HermesSessionMessage } from "../../lib/tauri";
import { type JuneHermesEvent } from "../../lib/hermes-control-plane";
import { type AgentChatTurn } from "../../lib/agent-chat-runtime";
import { type AgentArtifact, type AgentArtifactPanelState } from "./chat-turns/AgentArtifactPanel";
import type { AgentArtifactIndex } from "./artifact-index";
import type { AgentWorkspaceErrorOptions } from "./agent-workspace-errors";
import type * as React from "react";

export type UseAgentChatPresentationDependencies = {
  DOWNLOAD_TOAST_ID: "agent-download";
  artifactIndex: AgentArtifactIndex;
  chatArtifacts: AgentArtifact[];
  devArtifacts: AgentArtifact[];
  imageTurnsBySession: Record<string, AgentChatTurn[]>;
  liveEvents: Record<string, JuneHermesEvent[]>;
  selectedHermesMessages: HermesSessionMessage[];
  selectedHermesSessionId: string | undefined;
  selectedHermesSessionIdRef: React.MutableRefObject<string | undefined>;
  selectedTask: AgentTaskDto | undefined;
  setArtifactPanel: React.Dispatch<React.SetStateAction<AgentArtifactPanelState | null>>;
  setError: (message: string | null, options?: AgentWorkspaceErrorOptions) => void;
  setThinkingOpenByKey: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
  thinkingOpenByKey: Record<string, boolean>;
  videoTurnsBySession: Record<string, AgentChatTurn[]>;
};
