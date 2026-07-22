import {
  type AgentTaskDto,
  type HermesSessionInfo,
  type HermesSessionMessage,
} from "../../lib/tauri";
import { HermesGatewayClient } from "../../lib/hermes-gateway";
import { type AgentWorkspaceErrorOptions } from "./agent-workspace-errors";
import type * as React from "react";

export type createTaskControlActionsDependencies = {
  cancelAgentRunSettlement: (storedSessionId: string) => void;
  clearSessionActivity: (
    sessionId: string,
    status?: string,
  ) => { activeCount: number; needsUserCount: number };
  clearSubmittedSteers: (sessionId: string, options?: { preserveReservations?: boolean }) => void;
  computerUseRunLeasesRef: React.MutableRefObject<Map<string, Set<string>>>;
  ensureHermesGateway: (fullMode?: boolean) => Promise<HermesGatewayClient>;
  hermesSessionItems: HermesSessionInfo[];
  refreshHermesSession: (sessionId: string) => Promise<HermesSessionMessage[] | undefined>;
  runtimeSessionIds: Record<string, string>;
  sessionGatewayUnlistenRef: React.MutableRefObject<Map<string, () => void>>;
  setError: (message: string | null, options?: AgentWorkspaceErrorOptions) => void;
  setStoppingSessionIds: React.Dispatch<React.SetStateAction<ReadonlySet<string>>>;
  stoppingSessionIds: ReadonlySet<string>;
  upsertTask: (task: AgentTaskDto) => void;
};
